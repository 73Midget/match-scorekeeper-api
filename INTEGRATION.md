# Match Scorekeeper Backend — Client Integration Specification

Spec version 1.3, describing backend release v1.1.0.

Two version numbers, tracking different things: the spec is versioned by its own
revisions, the backend by its releases, and they are not expected to match. This
line says which spec revision describes which release.

Implemented by app 2.1.1, build 2026-09-06-e.

The backend is built, deployed, and tested. This specifies what the PWA must do
to talk to it, and the client-side behaviour the backend assumes.

Sections 1–6 are the API. Sections 7–11 are the workflow decisions that were
made deliberately and are not visible from the API alone — read those before
designing any screen.

### Changes since 1.2

Section numbers 4.1 through 4.10 are unchanged; new endpoints append rather than
renumber, because several documents and code comments cite these numbers.

- **§4.2** — `/ping` now returns `club_name`.
- **§4.6** — `GET /roster` now accepts `?revision=` for reading history.
- **§4.7** — the roster push now returns `unmatched`, and `merged_squads` is
  capped at 25. **The `marked_squads` count it previously returned was wrong
  against a local development server** — see the note in that section.
- **§4.7** gains the skip rule: when the shooter list has not changed, the client
  marks squads via §4.13 instead of publishing an identical roster.
- **§4.11** — `GET /matches`, listing a club's matches.
- **§4.12** — `GET /roster/revisions`, for rollback.
- **§4.13** — `POST /squads/merged`, marking squads without publishing.

---

## 1. What this backend is

An optional sync layer. It stores squad score payloads and a club shooter roster
so tablets can exchange them without a manual Google Drive round trip.

It is a key-value store with revision history and access control. Nothing more.

### What it deliberately does not do

Do not design client behaviour that depends on any of these:

- **No compilation.** The server never merges squads or computes results. All
  merge and ranking logic stays in the app, where it already lives.
- **No payload parsing.** The server stores the app's JSON as opaque text and
  never looks inside it. Adding a field to the payload requires no backend
  change.
- **No results rendering.** There is no web view of scores.
- **No conflict resolution.** When two clients disagree, the server rejects the
  later write and tells the client to re-read. It never merges.
- **No knowledge of match lifecycle.** There is no "match started" or "match
  finished" state. The server cannot tell an in-progress upload from a final
  one.
- **No judgement about ambiguous data.** Two squads sharing a label, a
  replacement tablet, a missing squad — the server reports what exists and the
  RO decides what it means. See §10.

The server's job is transport and durability. Every decision about what the
data *means* belongs to the app, and every ambiguous decision belongs to the
person running the match.

---

## 2. Configuration

### 2.1 The setup code

The provisioning scripts emit a single base64 string containing all three
settings. Accept this rather than asking for three separate fields — one paste
instead of three chances to mistype.

Decoded:

```json
{
  "url": "https://match-scorekeeper-api.example.workers.dev",
  "club": "x3222665",
  "secret": "GDAKdFijI/vSBhgyIOxNQyr8sq4l6p1195jls2IgvXI="
}
```

```js
const config = JSON.parse(atob(code.trim()));
```

Validate all three fields are present, non-empty strings, then confirm them
against the server with `GET /ping` (§4.2) before saving. A truncated paste
should fail at setup, not with a 401 at the range.

**The setup code is a credential.** It contains the shared secret in plaintext.
Treat a screenshot or an emailed copy the way you would treat the secret itself.

**Store it under its own key, never inside match metadata.** The app exports
match metadata wholesale inside every backup, every shared squad file, and every
uploaded payload. A secret stored there would be transmitted to the server,
copied to every other tablet, and written into every database backup.

### 2.2 Stored settings

| Setting | Source | Notes |
|---|---|---|
| `serverUrl` | setup code | Blank by default. Blank means fully offline; make no network calls at all. |
| `clubId` | setup code | Opaque. Never parsed or displayed as meaningful. |
| `secret` | setup code | Bearer token on every request. Own storage key (§2.1). |
| `deviceId` | generated once | See §2.3. |
| `deviceLabel` | typed by the user | e.g. "Club Tablet 2". Display only. |
| `dataClubId` | tracked | Which club the local data belongs to. See §2.4. |

### 2.3 Device id — generation and lifetime

**Generate once, when sync is first configured:**

```js
const deviceId = crypto.randomUUID();
```

Store it with the other sync settings. Never regenerate while a configuration
exists, never derive it from anything, never let a user type or see it.

**Why it exists.** Squad labels are free text. Two tablets at one match can both
be labelled "Squad 1" — this happens. If uploads were keyed by squad label, the
second tablet's upload would be recorded as a new revision of the first, the
list endpoint would return only the newest, and one squad's scores would
silently disappear. Keying by device makes that impossible regardless of what
anyone types.

**Known limitation, accepted deliberately.** If site data is cleared or the app
is reinstalled, the device id is lost and a new one is generated. A re-upload
afterwards lands as a *new row* rather than a new revision. The old upload is
not lost, but the compile screen shows the same squad twice under two device
ids — which the RO resolves the same way as any other duplicate (§10.2).

Do not work around this. The workaround would be worse than the problem.

### 2.4 Detecting a club change

Store the club id that local data belongs to. When sync is reconfigured with a
*different* club id and local data exists, warn before doing anything:

> This tablet's data was created under a different club. Its matches and roster
> have not been uploaded to the new one. Upload before downloading, or the local
> data may be replaced.

Any queued pending uploads must be **tagged with the club they were queued for
and never sent to a different one**. Two correct features that combine badly:
the pending queue is right on its own, and so is reconfiguring to a new club.
Tagging is preferred over dropping the queue, because dropping silently
discards a squad's scores.

This matters during disaster recovery (§9.2), where the natural instinct — sync
immediately after reconfiguring — pulls an empty roster and can overwrite local
state that is the only surviving copy of a shooter's details.

---

## 3. Keys and normalization

The server treats `match_key` as an **opaque identifier**. It never parses it,
and it is not composed with any other field. The app is entirely responsible for
producing a key that is the same across tablets at one match and different
across distinct matches.

### 3.1 Required key format

```js
function matchKey(rawMatch, matchType) {
  const normalized = String(rawMatch || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  return matchType + "|" + normalized;
}
```

Producing `outdoor|8/15/2026`.

Two parts, both required:

**The normalization** — trim, lowercase, collapse internal whitespace runs to a
single space, nothing else. This mirrors the app's existing `normMatch()` used
in the merge guard. Keeping them identical is the point: if the upload key and
the merge comparison disagree, data the app considers one match is split into
two on the server.

**The match type prefix** — this is load-bearing, not decoration.

The server's uniqueness constraint is `(club_id, match_key, device_id,
revision)`. `match_type` is stored but is **not** part of any key or query.
Without the prefix, an indoor morning match and an outdoor evening match on the
same date share a key. A tablet used for both would have its evening upload
recorded as *revision 2* of the morning's series — and since the list endpoint
returns only the newest revision per device, the indoor squad disappears with no
error anywhere.

This is exactly the failure `device_id` exists to prevent, arriving by a
different route. The prefix closes it.

Send `match_type` as its own field as well; it is stored for display and
validated by the server. Send the raw typed value as `match_label`.

### 3.2 Remaining collision — two matches, one day, same type

Two matches on the same date, same club, **and the same match type** still
collide into one key.

Mitigation is procedural: use a distinguishing match name ("8/15/2026 PM"). A
gentle nudge in the UI when a match key already has uploads is reasonable;
enforcement is not.

**Do not attempt to make the key unique automatically.** A key that varies per
tablet is far worse than a collision, because tablets stop agreeing about what
match they are at.

### 3.3 Forward hazard

The server accepts a key in any format. So changing the key format later
**silently strands everything uploaded under the old one** — it shows as a match
with squads missing, not as an error.

This applies to any future move to a real match id. Any such change needs a
deliberate migration or a dual-read period, not just a new function.

### 3.4 Squad labels

`squad_key` and `squad_label` are display only and **may be empty**. Nothing keys
off them. Show an empty squad label as `(no squad name)` rather than a blank
column, so a missing name reads as intentional rather than broken.

---

## 4. API reference

Base URL is the configured `serverUrl`. All requests except `/health` require:

```
Authorization: Bearer <secret>
```

All responses are JSON. Errors have this shape:

```json
{ "error": { "code": "stable_identifier", "message": "human explanation" } }
```

**Branch on `code`, never on `message`.** Message wording will change.

Path segments must be URL-encoded. Match keys contain both a pipe and slashes.

### 4.1 Health

```
GET /health
```

No auth. Returns `200 {"ok":true,"service":"match-scorekeeper-api"}`.

Proves the server is reachable and nothing else. **It does not validate
credentials** — use `/ping` for that.

### 4.2 Ping — validate a configuration

```
GET /v1/clubs/{clubId}/ping
```

```json
{ "ok": true, "club": "x3222665", "club_name": "Riverside Gun Club" }
```

| Status | Body |
|---|---|
| 200 | as above |
| 401 | `unauthorized` |

Touches no data. This is the endpoint for a setup screen's "test connection"
button and for validating a pasted setup code before saving it.

**`club_name` may be an empty string** — the column defaults to blank and a club
created without a name is legal. Fall back to showing the club id rather than
rendering an empty label.

Showing the name is what makes this a useful confirmation. A club id is opaque
by design, so echoing it back proves nothing: it never left the tablet. The name
came from the server and confirms the *right* club's code was pasted, not merely
a valid one.

Returned only after authentication, so it cannot be used to discover which club
ids exist.

Use this rather than inferring validity from a data endpoint. Treating a
`404 roster_not_found` as "credentials are good" works, but it overloads a data
endpoint for an auth check and reads like a bug to whoever maintains it next.

### 4.3 Upload a squad

```
POST /v1/clubs/{clubId}/squads
```

```json
{
  "match_key": "outdoor|8/15/2026",
  "device_id": "550e8400-e29b-41d4-a716-446655440000",
  "match_type": "outdoor",
  "payload": "{\"appName\":\"Match Scorekeeper\",...}",
  "schema_version": 1,

  "squad_key": "1",
  "squad_label": "1",
  "match_label": "8/15/2026",
  "device_label": "Club Tablet 2",
  "app_version": "2.1.1",
  "app_build": "2026-09-06-e",
  "entry_count": 8
}
```

Required: `match_key`, `device_id`, `match_type`, `payload`, `schema_version`.
Everything else is optional, defaulting to empty or zero.

**`payload` is a string**, not a nested object — the app's JSON, stringified,
sent verbatim. The server stores exactly those bytes and returns exactly those
bytes. Do not pretty-print, re-key, or re-serialize between generating the
payload and sending it; the content hash is computed over this exact text.

`match_type` must be `"indoor"` or `"outdoor"`.

| Status | Body | Meaning |
|---|---|---|
| 201 | `{"ok":true,"duplicate":false,"revision":1,…}` | Stored as a new revision. |
| 200 | `{"ok":true,"duplicate":true,"revision":1,…}` | Byte-identical payload already stored. No new row. |
| 400 | `invalid_body` / `bad_request` | Message names the offending field. |
| 401 | `unauthorized` | Bad secret, or wrong club. |
| 409 | `revision_conflict` | Simultaneous upload from this device. Retry. |

**On 200 with `duplicate: true`, treat the upload as successful.** This is what
a retry after a dropped connection returns. It is not an error and must not be
surfaced as one.

Uploads are append-only: each changed payload from a device becomes the next
revision. Nothing is ever overwritten. Uploading repeatedly is free.

### 4.4 List squads for a match

```
GET /v1/clubs/{clubId}/matches/{matchKey}/squads
```

Returns the **newest revision of each device** at that match. Metadata only.

Because `match_key` includes the match type (§3.1), this cannot return squads
from a different match type. No filtering is needed client-side.

```json
{
  "ok": true,
  "club": "x3222665",
  "match_key": "outdoor|8/15/2026",
  "squads": [
    {
      "device_id": "550e8400-…",
      "device_label": "Club Tablet 2",
      "squad_key": "1",
      "squad_label": "1",
      "match_type": "outdoor",
      "revision": 2,
      "entry_count": 8,
      "app_version": "2.1.1",
      "app_build": "2026-09-06-e",
      "uploaded_at": 1787848232608,
      "merged_into_roster_revision": null,
      "first_upload_for_device": 0
    }
  ]
}
```

An unknown match returns `200` with `"squads": []`. A valid answer — "nothing
uploaded yet" — not an error.

- **`first_upload_for_device`** is `1` when this club has never seen this device
  at any other match. Usually a borrowed tablet, occasionally a
  misconfiguration.
- **`merged_into_roster_revision`** is `null` until a roster push or a §4.13 call
  claims this upload.

### 4.5 Download a squad

```
GET /v1/clubs/{clubId}/matches/{matchKey}/squads/{deviceId}
GET /v1/clubs/{clubId}/matches/{matchKey}/squads/{deviceId}?revision=1
```

The last segment is a **device id**, not a squad label.

Without `?revision`, returns the newest. With it, returns that specific
revision — the append-only history is reachable, which is how a bad upload can
be compared against the good one that preceded it.

Response contains the full row including `payload`, byte-identical to what was
uploaded. `404 squad_not_found` if nothing matches.

### 4.6 Get the roster

```
GET /v1/clubs/{clubId}/roster
GET /v1/clubs/{clubId}/roster?revision=6
```

```json
{
  "ok": true,
  "roster": {
    "revision": 7,
    "content_hash": "6fd977db…",
    "payload": "{\"entries\":[…]}",
    "entry_count": 42,
    "schema_version": 1,
    "app_version": "2.1.1",
    "app_build": "2026-09-06-e",
    "base_revision": 6,
    "author": "Club Tablet 2",
    "updated_at": 1787934083643
  }
}
```

Without `?revision`, returns the current one. With it, returns that specific
revision — see §4.12 for the rollback flow.

| Status | Meaning |
|---|---|
| 200 | The roster |
| 400 | `invalid_revision` — malformed `?revision` |
| 404 | `roster_not_found` — no roster at all, or no such revision |

**A 404 with no `?revision` is a normal state for a new club, not an error.** A
tablet setting up against a fresh backend should treat it as "start from empty"
and offer to push.

The roster payload has the same shape as a squad payload — the app produces it
by exporting with scores cleared.

**Generate roster payloads with an empty match label.** A roster is the club's
shooter list, not a match artifact. The app's merge guard, which refuses payloads
whose match label differs from the current match, must also be skipped for
roster merges — a roster has no scores, so the guard protects nothing there. Do
both: clearing the label is honest data, skipping the guard is the actual fix,
and relying on the label alone couples two things that should not be coupled.

**Retain `revision`.** It is required for the next push.

### 4.7 Push a roster

```
PUT /v1/clubs/{clubId}/roster
```

```json
{
  "payload": "{\"entries\":[…]}",
  "schema_version": 1,
  "base_revision": 7,
  "entry_count": 43,
  "app_version": "2.1.1",
  "app_build": "2026-09-06-e",
  "author": "Club Tablet 2",
  "merged_squads": [
    { "match_key": "outdoor|8/15/2026", "device_id": "550e8400-…", "revision": 2 }
  ]
}
```

`base_revision` is **the revision you compiled from**. Use `null` only when the
GET returned 404.

`merged_squads` lists the squad uploads this compile absorbed. **Maximum 25
entries** — split into sequential batches beyond that; see §4.13.

```json
{
  "ok": true,
  "revision": 8,
  "updated_at": 1787934083643,
  "marked_squads": 2,
  "unmatched": [
    { "match_key": "outdoor|8/15/2026", "device_id": "tablet-c", "revision": 3 }
  ]
}
```

| Status | Meaning |
|---|---|
| 201 | Stored. |
| 400 | `invalid_body` — message names the field. |
| 409 | `roster_conflict` — someone else pushed since you compiled. |

**`unmatched`** lists triples that are not now marked — either the upload does
not exist, or that revision was superseded. Not an error; a real outcome. The
same shape §4.13 returns, so one client code path covers both.

> **Note on `marked_squads`.** Before app 2.1.1 this count was derived from
> database batch metadata, and the local development emulator omits the field the
> deployed database includes. A successful publish against a local server
> therefore reported zero squads marked. That was not merely a testing
> annoyance: the obvious remedy for whoever saw it — re-selecting squads on the
> compile screen — is the one action that produces duplicate shooters. Both
> paths now read the outcome back with a query. The query looks redundant and is
> not.

#### The skip rule

**Do not publish a roster when the shooter list has not changed.**

Clubs shoot the same people week to week, so most compiles change nothing about
the list. Publishing an identical roster every week buries the revisions that
matter — and finding the good list after a bad one goes out is the entire point
of keeping roster history.

Skipping is also *safer* than pushing. If this tablet's list is unchanged but
another has since added someone, or rolled back, pushing would replace the club
list with this tablet's lesser copy. Skipping cannot.

**The decision:**

1. `GET /roster` — always fresh, never a stored local copy or fingerprint
2. Compare its payload's fingerprint against the merged local list
3. Unchanged → `POST /squads/merged` (§4.13), report the revision it returns
4. Changed → `PUT /roster` as above

These are two independent calls and neither knows about the other. If the mark
fails, retry the mark — not the whole compile.

**Why a fresh GET, not a stored fingerprint.** Consider a rollback: tablet B
rolls the roster back to an earlier revision that lacks some of tablet A's
shooters. The server is now at revision 10 whose content is revision 6's. Tablet
A compiles; its local list has not changed since it last published, so a stored
fingerprint correctly says "unchanged" while answering the wrong question. Those
shooters are never republished and nothing reports it.

Comparing against a fresh GET catches this. It also removes local state
entirely — nothing to go stale, nothing to invalidate on a club change.

**If the GET returns 404, push.** "Unchanged" is meaningless with nothing to
compare against. The server rejects §4.13 in that state as a backstop, but the
client must not reach it.

#### The fingerprint

The set of people, **sorted by `personId`**, each contributing:

| Included | Excluded |
|---|---|
| `name` | `division` |
| `email` | `gun` |
| `phone` | `squad` |
| `category` | `type` |
| RO flag | `checkinSeq` |
| | `idAt` |

Rules, all of which matter:

- **Sort by `personId` before comparing.** Otherwise check-in order changes the
  payload order and every compile looks different.
- **Trim whitespace, preserve case.** A capitalisation fix — "bob smith" → "Bob
  Smith" — is a real correction worth publishing. Normalising case would swallow
  it. Trailing spaces are not.
- **Compare the set, not per-person hashes.** Removals are only detected because
  the set changes; comparing each person's details individually would miss them.
- **Not a byte comparison.** A roster payload also carries `matchType`,
  `appVersion` and other fields that move week to week without any shooter
  changing.
- **`idAt` is deliberately excluded.** It is load-bearing for merge
  reconciliation, so it looks like it should count — but it moves whenever
  `updatePerson` runs, including with identical values. Including it would break
  the skip on exactly the no-op edit this feature exists for.

**This list is a contract, not an implementation detail.** If a future version
adds an identity field — a membership number, say — and the fingerprint is not
updated, changes to that field would never publish. Silent, and invisible until
someone notices a stale value nobody can explain. Writing the list down makes
adding a field a decision rather than an omission.

### 4.8 The conflict path — required client behaviour

**This is the most important interaction in the API.**

A roster push replaces the whole list. Without the `base_revision` check, two
tablets compiling from the same starting point would each push their own
version, and the second would silently erase every shooter the first added.
Because a newly checked-in shooter's contact details exist only on the tablet
that took them until a compile picks them up, that shooter becomes unreachable —
with no error anywhere.

On `409 roster_conflict`, the app **must**:

1. `GET /roster` for the current revision
2. Merge it into local state using the app's existing merge logic
3. Push again with the new `base_revision`

Do not retry with the same `base_revision`. Do not present the conflict as a
failure — it is a normal outcome of two people working at once, and the right
message is "someone else updated the roster, pulling their changes."

```json
{
  "error": { "code": "roster_conflict", "message": "Roster has moved to revision 8 since this was compiled" },
  "current_revision": 8,
  "current_author": "Club Tablet 3",
  "current_updated_at": 1787934083643
}
```

Cap automatic retries at three, then hand it to the user.

### 4.9 Unmerged squads

```
GET /v1/clubs/{clubId}/squads/unmerged
GET /v1/clubs/{clubId}/squads/unmerged?days=180
```

Returns squad uploads (newest revision per device) that no roster push or §4.13
call has claimed, newest first.

**Scoped to the last 60 days by default**, capped at 200 rows. `?days=` accepts
1 to 3650; a malformed value returns `400 invalid_days`. The response echoes the
window as `days`.

The window exists because a match that is never published leaves its uploads
unclaimed permanently, and an unbounded list buries the recent arrivals this
endpoint exists to surface.

**The window is also the dismissal mechanism.** There is no way to mark an
upload as deliberately ignored, and none is planned: an abandoned match ages off
on its own, and a wider `days` brings it back.

Same field shape as §4.4, plus `match_key` and `match_label`.

### 4.10 Compiled match results

A compiled match is uploaded through the same squad endpoint, using the reserved
device id **`"compiled"`** and a `device_label` of `"Compiled results"`.

The server does not treat it specially — it is another payload. But the reserved
id means:

- It is retrievable at `GET /matches/{key}/squads/compiled`
- The compile screen can filter it out of the squad list
- Re-publishing a corrected compile creates revision 2, and history is preserved

Do not include `"compiled"` in `merged_squads`.

### 4.11 List a club's matches

```
GET /v1/clubs/{clubId}/matches
GET /v1/clubs/{clubId}/matches?days=365
```

```json
{
  "ok": true,
  "club": "x3222665",
  "days": 90,
  "matches": [
    {
      "match_key": "outdoor|8/15/2026",
      "match_label": "8/15/2026",
      "match_type": "outdoor",
      "last_upload_at": 1787848232608,
      "squad_count": 3,
      "has_compiled": 1
    }
  ]
}
```

Newest first by `last_upload_at`. Default 90 days — a season is the natural unit
for browsing, unlike §4.9 where recency is the whole point. `?days=` accepts 1 to
3650, capped at 200 rows, malformed returns `400 invalid_days`.

**`squad_count` excludes the `compiled` device.** It counts squads that ran, not
rows stored.

**`has_compiled`** is `1` when a compiled archive exists, so a list can
distinguish matches with final results from ones with only raw squads. Fetch the
results with §4.5 using device id `compiled`.

**No `unmerged_count`.** Matching §4.9's newest-revision-per-device semantics
inside this grouping would mean a second implementation of the same rule, and
two implementations drift. Call §4.9 once and count per `match_key`
client-side — every row already carries it.

Display rule applies: show `match_label` and `match_type`, never `match_key`.

### 4.12 Roster revisions

```
GET /v1/clubs/{clubId}/roster/revisions
```

```json
{
  "ok": true,
  "club": "x3222665",
  "revisions": [
    {
      "revision": 8,
      "base_revision": 7,
      "author": "Club Tablet 2",
      "entry_count": 44,
      "content_hash": "6fd977db…",
      "schema_version": 1,
      "app_version": "2.1.1",
      "app_build": "2026-09-06-e",
      "updated_at": 1787934083643
    }
  ]
}
```

Newest first, capped at 200, no payloads. **No time window** — a rollback target
can be months old, and this list is bounded by how often a club publishes rather
than by how much it uploads.

**Every revision is retained.** The rosters table is append-only and nothing
prunes it. `base_revision` is not a pointer to something gone; it records what
the pusher compiled from.

#### The rollback flow

A roster push replaces the whole list, so a bad one — pushed from a stale tablet,
or with a shooter wrongly removed — needs a way back:

1. `GET /roster/revisions` and let the director pick one
2. `GET /roster?revision=N` for that revision's payload
3. `PUT /roster` with that payload and the **current** `base_revision`

Nothing is deleted. The rollback is a new revision on top, so the history records
that it happened rather than pretending it did not.

**Set `author` to say what it is** — `"Rolled back to r6 (Club Tablet 2)"` rather
than just the tablet name. Six months later, an unexplained revision duplicating
an earlier one is a puzzle.

`content_hash` is included so a client can spot an identical re-push without
downloading. A diff — "revision 7 removed Smith, Jones" — would be more useful
still, but it requires reading payloads, so it belongs client-side after fetching
two revisions.

### 4.13 Mark squads merged without publishing

```
POST /v1/clubs/{clubId}/squads/merged
```

```json
{
  "merged_squads": [
    { "match_key": "outdoor|8/15/2026", "device_id": "550e8400-…", "revision": 2 }
  ]
}
```

The same triples §4.7 carries, without a payload. All three fields required;
`revision` must be an integer. **Maximum 25 entries** — split into sequential
batches beyond that.

```json
{
  "ok": true,
  "roster_revision": 9,
  "marked_squads": 2,
  "unmatched": [
    { "match_key": "outdoor|8/15/2026", "device_id": "tablet-c", "revision": 3 }
  ]
}
```

| Status | Meaning |
|---|---|
| 200 | Processed. `marked_squads` may be lower than sent; see `unmatched`. |
| 400 | `invalid_body` — empty array, over 25 entries, or a malformed triple |
| 401 | `unauthorized` |
| 404 | No roster to mark against, **or an older server without this route** |

This exists because §4.7's skip rule would otherwise leave squads unclaimed
forever, flagged by §4.9. Kept separate from the roster push so that push keeps
meaning exactly one thing, and so a failed mark is retried on its own rather than
by repeating a whole compile.

**`roster_revision`** is the current revision — take it verbatim for a "still
#8" message. Never fall back to a locally stored value; that is the one that can
be stale. If it is absent, report "unchanged" without a number rather than
guessing.

**Squads are recorded against the current revision**, because that revision
already contains their shooters — which is why the push was skipped. Expect to
see squads marked with a revision whose timestamp predates their own upload. It
means "these people were already on the list", and it is correct.

**Idempotent.** A repeated call with identical triples changes nothing, returns
200, and counts already-marked squads as marked. Original attribution is
preserved. A resumed publish can safely re-send everything rather than tracking
which batches landed.

#### The 404 also signals an older server, and clients must treat it that way

Two different conditions return 404 here: no roster to mark against, and no such
route on a backend predating this endpoint. In the call sequence that matters,
only the second can occur — the mark is only ever reached after a successful
`GET /roster` (§4.7), so a roster exists by construction.

So a client seeing 404 from this endpoint should **fall back to `PUT /roster`**
with `merged_squads`, publishing as it did before this endpoint existed. No error
is shown. The squads are still marked, and the roster history simply stays noisy
until that club's backend is updated.

The alternative is a club whose backend is a version behind seeing an error on
every compile, about something they did not do and cannot act on.

**Do not remove that fallback as defensive clutter.** The roster-not-found case
is a genuine client bug, and the sentence saying so is why someone would read the
fallback as papering over an error — but the two states are indistinguishable by
status code, only one of them is reachable, and a test suite running against a
current server will never catch the regression.

---

## 5. Network behaviour

**All network activity is triggered by the RO.** There is no background sync, no
polling, and no automatic activity while a match is in progress.

### 5.1 When the app reaches the server

| Moment | Action | Triggered by |
|---|---|---|
| Configuring sync | `GET /ping` | Saving a setup code |
| Setup, before a match | `GET /roster` | "Get latest shooter list" |
| During and after a match | `POST /squads` | The save/upload button (§5.2) |
| Compiling | `GET` list, `GET` each squad | Opening the compile screen |
| Publishing | `GET /roster`, then `PUT /roster` or `POST /squads/merged`, then `POST` compiled, then `GET /squads/unmerged` | "Compile match results" |

Nothing else. Signal comes and goes during a match and it does not matter,
because nothing is trying to use it.

### 5.2 The save/upload button

One button on the Results screen does both. It reads **Upload this squad's
results** when sync is configured and **Save this squad's results** when it is
not. Either way it writes the local file first, then uploads if it can.

This is the single most valuable network moment in the system, because it uses a
habit that already exists rather than teaching a new step.

- The local save always happens and always succeeds first
- The upload is attempted after
- On failure: a brief, non-blocking notice, shown **only** when sync is
  configured. The local save succeeded and must not look like it failed
- The squad is marked pending (§5.3)

An RO who notices a tablet acting oddly or running low on battery can walk to a
spot with signal and tap it. That converts "one tablet holds the only copy" into
"the server has it" — which is the whole point.

### 5.3 Retry and the pending badge

When an upload fails, retry a small number of times (three is reasonable) with a
short delay. If it still fails:

- Mark the squad as pending upload
- Show a **persistent badge that survives app restarts**

The badge stays until the upload succeeds. This is what stops a tablet going
home with an unuploaded squad and nobody noticing until the RO is compiling.

Retrying when the app is next opened with a pending upload and a configured
server is acceptable — the app is open and the person is looking at it. **Do not
retry on a timer.** "Retry every five minutes" is the obvious-seeming next step
and it is background sync by another name.

**The local file is written on every tap regardless**, so a pending upload is
never a reason to export anything separately. It is already on the tablet.

### 5.4 Offline is not an error state

The app is offline-first and must remain fully functional with no server. A
failed sync is a deferred sync. Never block scoring on a network call, never let
a sync failure interrupt a match, and never treat "no server configured" as a
condition worth mentioning.

---

## 6. Error handling

| Code | Status | Meaning | Client action |
|---|---|---|---|
| `unauthorized` | 401 | Bad secret or wrong club | Prompt to re-enter configuration |
| `not_found` | 404 | No such route | Bug, or an older server — see §4.13 |
| `squad_not_found` | 404 | No such upload | Normal for a squad not yet uploaded |
| `roster_not_found` | 404 | No roster, or no such revision | Normal for a new club — offer to push |
| `invalid_body` | 400 | Validation failed | Bug — log the message |
| `bad_request` | 400 | Malformed JSON | Bug |
| `invalid_revision` | 400 | Bad `?revision` | Bug |
| `invalid_days` | 400 | Bad `?days` | Bug |
| `revision_conflict` | 409 | Simultaneous upload | Retry once |
| `roster_conflict` | 409 | Stale roster compile | Re-read and merge (§4.8) |

---

## 7. The sunny-day workflow

Three squads, three club tablets, one RO.

**Before the match.** On each tablet the RO taps "Get latest shooter list". Three
taps. Then match name and squad label are set as usual — no network involved.

**During the match.** No network activity. The RO taps the save/upload button
periodically as they already did for backups; each tap also uploads the squad.

**End of match.** The same button on each tablet. There is no separate
end-of-match action.

**Compiling.** The RO opens the compile screen on one tablet. It lists the three
uploads with squad label, device label, shooter count, and time. The RO reads
that list and knows it is right. Tap **Compile match results** — one tap merges,
publishes, and checks for late arrivals.

**Publishing, inside that one tap.** The roster is fetched, fingerprinted, and
either pushed or skipped per the rules in §4.7. The compiled archive goes up
under device id `"compiled"` (§4.10). The unmerged list is checked (§4.9). Each
step is reported separately.

**Next match.** Three taps of "Get latest shooter list".

**Note what did not change: the compile step itself.** Same merge, same ranking,
same output. The network only changed how squad files get from three tablets to
one.

---

## 8. Failure scenarios

### 8.1 Upload fails, tablet is fine

The compile screen shows two squads where the RO knows there were three. **That
is the detection mechanism** — a person who ran the match reading a list, not a
count the system checks.

The local file is already on the tablet, written by the same tap that failed to
upload. Copy it to the compiling tablet and import it. See §8.2.

The roster push then names only squads 1 and 2 in `merged_squads` — squad 3 has
no row to mark. The server's record of that match is incomplete. **Accept this.**
The compiled file and squad 3's tablet both still hold the data, and the server
was never the system of record for a match.

### 8.2 Mixed sources on the compile screen

**Do not build a fallback mode.** The compile screen shows one list; some rows
came from the server, some from a file. One Compile button. No branching, no mode
to enter.

The app already knows how to compile from files — that is the pre-sync workflow.
The network path is an *optimization* on it, not a replacement with a fallback,
which is what keeps the emergency path one people have already used.

### 8.3 Tablet dies mid-match

The backend cannot help with scores that existed only on that tablet. If local
storage survives, the app restores as it always has.

What sync *does* protect is the shooters. If the RO had tapped upload at any
point with signal, the check-ins — including new shooters' contact details — are
on the server. That is the entire argument for §5.2.

### 8.4 Replacement tablet

**The replacement keeps its own device id.** It does not adopt the dead tablet's.
The history then says what actually happened. Adoption would put a lie in the
data that is invisible until someone tries to reconstruct the evening months
later.

**Resume flow:** the replacement lists what is uploaded for the current match,
the RO picks the squad, and the tablet restores that payload as live match state,
then continues under its own device id.

**The two uploads overlap, they do not complement.** The replacement uploads the
*complete* squad. The RO picks one row, never both — compiling both
double-counts.

---

## 9. Recovery

### 9.1 Normal backup

The club exports the database monthly and stores the dump outside Cloudflare.
Backend-side task. The export contains every shooter's name, email, and phone in
plaintext.

### 9.2 Rebuilding from tablets

**Order matters:**

1. **Every tablet exports its shooter list** to shared storage. All of them,
   before anything else.
2. **One tablet compiles** every export into a merged list, still holding its old
   configuration.
3. **Check the result** — shooter count, recent additions.
4. Create a new club on the new backend; reconfigure that one tablet.
5. It pushes the roster with `base_revision: null`.
6. It **pulls the roster back** and confirms it matches.
7. Only now do the other tablets reconfigure and restore.

Step 1 before step 7 is the constraint that matters. A tablet that reconfigures
and syncs first pulls an empty roster and may overwrite local data that is the
only surviving copy.

The club-change warning in §2.4 is what makes this safe against the natural
instinct to sync immediately after reconfiguring.

---

## 10. The compile screen

Where the RO's knowledge of the evening meets the server's record of it.

### 10.1 What it shows

For each upload: squad label, device label, shooter count, upload time, and
source (server or file). Shooter names available on expand.

Filter out the `"compiled"` device id; that is a result, not a squad.

**Timestamps state facts, never conclusions.** Show absolute plus relative —
"7:40 PM (2h ago)" — so an outlier is obvious at a glance. No "possibly stale",
no staleness inference. A stale time usually means a tablet stopped, but can
equally mean a squad finished early. The RO knows which; the app does not.

### 10.2 Same squad label, two devices

Two rows can share a squad label, from two causes the app **cannot**
distinguish: two genuinely different squads both labelled "Squad 1" (compile
both), or a replacement tablet taking over (compile one).

**Required behaviour:**

- Flag the pattern neutrally — "two tablets used this squad name"
- **Default both to selected.** Compiling both when it was a replacement gives
  double-counted entries the RO notices immediately. Compiling one when they were
  different squads gives a silently missing squad, which is far easier to miss.
- Show shooter names on expand. Overlapping names means replacement; entirely
  different names means two squads. **This resolves it unambiguously.**

### 10.3 Already-compiled squads

A squad already in the compiled results, appearing at a *different revision*, is
the one case that defaults **unticked** — flagged "re-uploaded since you
compiled".

Including it does not merge the change; it replays that squad's entire payload
over what the compiling tablet has. Anything corrected on the compiling tablet
since would be overwritten, and a shooter can end up listed twice. The right
remedy is making the change on the compiling tablet.

This is keyed on **device id and revision**, not squad name — which is why it
cannot fire on a replacement tablet, whose device id has never been compiled.
§10.2's default-to-selected is unchanged for everything not already in the
results.

### 10.4 What it must never do

**Never ask for a squad count in advance.** A typed count that disagrees with
reality is worse than no count, because a green light gets trusted.

**Never auto-resolve an ambiguity.** Show what is true, flag what is ambiguous,
let the compiling RO decide. That principle runs through this entire
specification.

**Never reason about device health.** The screen asks "do two rows claim the same
squad", never "is this device alive". Blocking that premise is what prevents a
dead-tablet recovery mode ever being built as a second, never-exercised code
path.

---

## 11. Implementation notes

**Payload integrity.** The server hashes the payload text for duplicate
detection. Generate the payload string once and send that exact string; do not
regenerate or re-serialize between hashing and sending.

**Timestamps** are epoch milliseconds, server-assigned. Do not rely on client
clocks for ordering — tablets at a range are not reliably in sync.

**`schema_version`** is currently `1` and comes from the payload. Bump it when
the payload shape changes.

**Retention.** No purge exists. If one is added, a squad upload must never be
deleted while its `merged_into_roster_revision` is null — it may hold the only
copy of a shooter added at check-in and never compiled. Roster revisions are
never pruned.

**Encryption is not implemented.** Payloads are stored as plain JSON. A later
stage may add client-side AES-GCM encryption, at which point `payload` carries
base64 ciphertext and an `iv` field is added. The server never reads inside a
payload, so this needs no server-side change beyond a schema addition.

**Free tier headroom.** 100,000 Worker requests/day, 5M D1 rows read/day, 100,000
written/day, 5 GB storage. A five-tablet match uses a few hundred requests. Do
not design around these limits; do not poll aggressively either.
