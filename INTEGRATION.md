# Match Scorekeeper Backend — Client Integration Specification

Version 1.2 — for the app-side implementation.

The backend is built, deployed, and tested. This specifies what the PWA must do
to talk to it, and the client-side behaviour the backend assumes.

Sections 1–6 are the API. Sections 7–11 are the workflow decisions that were
made deliberately and are not visible from the API alone — read those before
designing any screen.

### Changes since 1.1

- **§3.1 — the match key format changed.** v1.1 claimed `match_type` was part
  of the server-side key. It was not; the claim was written from design intent
  and did not match the schema. An indoor and an outdoor match on the same date
  collided, and a tablet used for both would have had its second upload
  recorded as a revision of the first — silently hiding the earlier squad. The
  match type is now folded into the key client-side. **Any client written
  against v1.1 must be updated.**
- **§4.2 — `GET /v1/clubs/{clubId}/ping` added.** An authenticated,
  data-free endpoint for validating a pasted configuration at setup.
- **§4.9 — the unmerged list is now time-scoped**, defaulting to 60 days with
  an optional `?days=`. Previously unbounded.

---

## 1. What this backend is

An optional sync layer. It stores squad score payloads and a club shooter
roster so tablets can exchange them without a manual Google Drive round trip.

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
  RO decides what it means. See §11.

The server's job is transport and durability. Every decision about what the
data *means* belongs to the app, and every ambiguous decision belongs to the
person running the match.

---

## 2. Configuration

### 2.1 The config blob

The provisioning scripts emit a single base64 string containing all three
settings. Accept this blob rather than asking for three separate fields — one
paste instead of three chances to mistype.

Decoded:

```json
{
  "url": "https://match-scorekeeper-api.example.workers.dev",
  "club": "x3222665",
  "secret": "GDAKdFijI/vSBhgyIOxNQyr8sq4l6p1195jls2IgvXI="
}
```

```js
const config = JSON.parse(atob(blob.trim()));
```

Validate all three fields are present, non-empty strings, then confirm them
against the server with `GET /ping` (§4.2) before saving. A truncated paste
should fail at setup, not with a 401 at the range.

**The blob is a credential.** It contains the shared secret in plaintext. Treat
a screenshot or an emailed copy the way you would treat the secret itself. The
setup screen should say so.

**Store it under its own key, never inside match metadata.** The app exports
match metadata wholesale inside every backup, every shared squad file, and
every uploaded payload. A secret stored there would be transmitted to the
server, copied to every other tablet, and written into every database backup.

### 2.2 Stored settings

| Setting | Source | Notes |
|---|---|---|
| `serverUrl` | config blob | Blank by default. Blank means fully offline; make no network calls at all. |
| `clubId` | config blob | Opaque. Never parsed or displayed as meaningful. |
| `secret` | config blob | Bearer token on every request. Own storage key (§2.1). |
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
ids — which the RO resolves the same way as any other duplicate (§11.2).

Do not work around this. The workaround would be worse than the problem.

### 2.4 Detecting a club change

Store the club id that local data belongs to. When sync is reconfigured with a
*different* club id and local data exists, warn before doing anything:

> This tablet's data was created under a different club. Its matches and roster
> have not been uploaded to the new one. Upload before downloading, or the local
> data may be replaced.

This matters during disaster recovery (§10.2), where the natural instinct — sync
immediately after reconfiguring — pulls an empty roster and can overwrite local
state that is the only surviving copy of a shooter's details.

---

## 3. Keys and normalization

The server treats `match_key` as an **opaque identifier**. It never parses it,
and it is not composed with any other field. The app is entirely responsible
for producing a key that is the same across tablets at one match and different
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
returns only the newest revision per device, the indoor squad disappears with
no error anywhere.

This is exactly the failure `device_id` exists to prevent, arriving by a
different route. The prefix closes it.

Send `match_type` as its own field as well; it is stored for display and
validated by the server. Send the raw typed value as `match_label`.

### 3.2 Remaining collision — two matches, one day, same type

Two matches on the same date, same club, **and the same match type** still
collide into one key, and the compile screen would show six squads where the RO
expects three.

Mitigation is procedural: use a distinguishing match name ("8/15/2026 PM"). A
gentle nudge in the UI when a match key already has uploads is reasonable;
enforcement is not.

**Do not attempt to make the key unique automatically.** A key that varies per
tablet is far worse than a collision, because tablets stop agreeing about what
match they are at.

If the app later gains a real match id distributed at match creation, send that
as `match_key` instead. No backend change is required.

### 3.3 Squad labels

`squad_key` and `squad_label` are display only and **may be empty**. Nothing
keys off them. Show an empty squad label as `(no squad name)` rather than a
blank column, so a missing name reads as intentional rather than broken.

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

Does not touch the database, so a 200 here with failures elsewhere points at
the database rather than the network.

### 4.2 Ping — validate a configuration

```
GET /v1/clubs/{clubId}/ping
```

| Status | Body |
|---|---|
| 200 | `{"ok":true,"club":"x3222665"}` |
| 401 | `unauthorized` |

Touches no data and returns none. This is the endpoint for a setup screen's
"test connection" button and for validating a pasted config blob before saving
it.

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
  "app_version": "2.0.0",
  "app_build": "2026-08-15",
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
      "app_version": "2.0.0",
      "app_build": "2026-08-15",
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
  misconfiguration. Show it as an informational flag.
- **`merged_into_roster_revision`** is `null` until a roster push claims this
  upload. See §4.9.

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
```

```json
{
  "ok": true,
  "roster": {
    "revision": 7,
    "payload": "{\"entries\":[…]}",
    "entry_count": 42,
    "schema_version": 1,
    "base_revision": 6,
    "author": "Club Tablet 2",
    "updated_at": 1787934083643
  }
}
```

`404 roster_not_found` when the club has never pushed one. **This is a normal
state for a new club, not an error.** A tablet setting up against a fresh
backend should treat it as "start from empty" and offer to push.

The roster payload has the same shape as a squad payload — the app produces it
by exporting with scores cleared.

**Generate roster payloads with an empty match label.** A roster is the club's
shooter list, not a match artifact; a label claiming otherwise is misleading in
storage and awkward on restore. The app's merge guard, which refuses payloads
whose match label differs from the current match, must also be skipped for
roster merges — a roster has no scores, so the guard is protecting against
nothing there. Do both: clearing the label is honest data, skipping the guard
is the actual fix, and relying on the label alone couples two things that
should not be coupled.

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
  "app_version": "2.0.0",
  "app_build": "2026-08-15",
  "author": "Club Tablet 2",
  "merged_squads": [
    { "match_key": "outdoor|8/15/2026", "device_id": "550e8400-…", "revision": 2 }
  ]
}
```

`base_revision` is **the revision you compiled from**. Use `null` only when the
GET returned 404.

`merged_squads` lists the squad uploads this compile absorbed. Optional but
strongly recommended — it is what lets §4.9 work.

| Status | Meaning |
|---|---|
| 201 | Stored. Response has the new `revision` and a `marked_squads` count. |
| 409 | `roster_conflict` — someone else pushed since you compiled. |
| 400 | `invalid_body` — message names the field. |

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

The 409 body names who got there first:

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

Returns squad uploads (newest revision per device) that no roster push has
claimed, newest first.

**Scoped to the last 60 days by default**, capped at 200 rows. `?days=` accepts
1 to 3650; a malformed value returns `400 invalid_days`. The response echoes the
window as `days`.

The window exists because a match that is never published leaves its uploads
unclaimed permanently, and an unbounded list buries the recent arrivals this
endpoint exists to surface.

**The window is also the dismissal mechanism.** There is no way to mark an
upload as deliberately ignored, and none is planned: an abandoned match ages off
the list on its own, and a wider `days` brings it back if someone needs to look.
A `dismissed` flag would need its own storage and its own UI to solve a problem
the window already solves.

Same field shape as §4.4, plus `match_key` and `match_label`.

This catches the case that actually happens: a squad uploads twenty minutes
after the RO compiled, and nothing else would say so.

### 4.10 Compiled match results

A compiled match is uploaded through the same squad endpoint, using the reserved
device id **`"compiled"`** and a `device_label` of `"Compiled results"`.

The server does not treat it specially — it is another payload. But the reserved
id means:

- It is retrievable at `GET /matches/{key}/squads/compiled`
- The compile screen can filter it out of the squad list, since it is not a
  squad awaiting compilation
- Re-publishing a corrected compile creates revision 2, and the history is
  preserved

Do not include `"compiled"` in `merged_squads`.

---

## 5. Network behaviour

**All network activity is triggered by the RO.** There is no background sync,
no polling, and no automatic activity while a match is in progress.

### 5.1 When the app reaches the server

| Moment | Action | Triggered by |
|---|---|---|
| Configuring sync | `GET /ping` | Saving a config blob |
| Setup, before a match | `GET /roster` | "Get latest shooter list" |
| Mid-match | `POST /squads` | The existing backup button (§5.2) |
| End of match | `POST /squads` | "Upload squad" |
| Compiling | `GET` list, `GET` each squad | Opening the compile screen |
| Publishing | `PUT /roster`, `POST` compiled | "Publish" |
| After publishing | `GET /squads/unmerged` | "Check for late uploads" |

Nothing else. Signal comes and goes during a match and it does not matter,
because nothing is trying to use it.

### 5.2 The backup button

The app has an existing backup button ROs use mid-match to save locally. **When
sync is configured, that same button also uploads the squad.**

This is the single most valuable network moment in the system, because it uses a
habit that already exists rather than teaching a new step.

- The local backup always happens and always succeeds first
- The upload is attempted after
- On failure: a brief, non-blocking on-screen notice, shown **only** when sync
  is configured. The local backup succeeded and must not look like it failed
- The squad is marked pending (§5.3)

An RO who notices a tablet acting oddly or running low on battery can walk to a
spot with signal and tap backup. That converts "one tablet holds the only copy"
into "the server has it" — which is the whole point.

### 5.3 Retry and the pending badge

When an upload fails, retry a small number of times (three is reasonable) with a
short delay. If it still fails:

- Mark the squad as pending upload
- Show a **persistent badge that survives app restarts**:

  > ⚠ Squad 3 from 8/15/2026 has not been uploaded. Tap to retry.

The badge stays until the upload succeeds. This is what stops a tablet going
home with an unuploaded squad and nobody noticing until the RO is compiling.

Retrying when the app is next opened with a pending upload and a configured
server is acceptable — the app is open and the person is looking at it. Do not
retry in the background.

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
| `not_found` | 404 | No such route | Bug — wrong URL or old server |
| `squad_not_found` | 404 | No such upload | Normal for a squad not yet uploaded |
| `roster_not_found` | 404 | Club has no roster | Normal for a new club — offer to push |
| `invalid_body` | 400 | Validation failed | Bug — log the message |
| `bad_request` | 400 | Malformed JSON | Bug |
| `invalid_revision` | 400 | Bad `?revision` | Bug |
| `invalid_days` | 400 | Bad `?days` | Bug |
| `revision_conflict` | 409 | Simultaneous upload | Retry once |
| `roster_conflict` | 409 | Stale roster compile | Re-read and merge (§4.8) |

---

## 7. The sunny-day workflow

Three squads, three club tablets, one RO. This is what the design targets.

**Before the match.** On each tablet the RO taps "Get latest shooter list". The
tablet pulls roster revision 7 and restores it. Three taps. Then match name and
squad label are set as usual — no network involved.

**During the match.** No network activity. The RO taps backup periodically as
they already do; when sync is configured, each tap also uploads the squad.

**End of match.** On each tablet the RO taps "Upload squad." Three 201s.

**Compiling.** The RO opens the compile screen on one tablet. It lists the three
uploads with squad label, device label, shooter count, and time. The RO reads
that list and knows it is right — three squads ran, three are there. Tap
"Compile": the tablet downloads each payload and runs the existing merge.

**Publishing.** Tap "Publish". The roster goes up with `base_revision: 7` and
`merged_squads` naming all three. The compiled match goes up under device id
`"compiled"`. Optionally the RO taps "Check for late uploads" and gets an empty
list.

**Next match.** Three taps of "Get latest shooter list" and every tablet has the
new shooters, contact details included.

Nine deliberate network actions across an evening, every one a tap.

**Note what did not change: the compile step itself.** Same merge, same ranking,
same output. The network only changed how squad files get from three tablets to
one.

---

## 8. Failure scenarios

### 8.1 Upload fails, tablet is fine

The compile screen shows two squads where the RO knows there were three. **That
is the detection mechanism** — a person who ran the match reading a list, not a
count the system checks.

The RO exports squad 3 from its tablet by USB or Drive and imports it on the
compiling tablet. See §8.2.

The roster push then names only squads 1 and 2 in `merged_squads` — squad 3 has
no row to mark. The server's record of that match is incomplete. **Accept this.**
The compiled file and squad 3's tablet both still hold the data, and the server
was never the system of record for a match.

Do not offer to upload squad 3 on its behalf. It adds a step and a concept for a
completeness nobody will look at.

### 8.2 Mixed sources on the compile screen

**Do not build a fallback mode.** The compile screen shows one list; some rows
came from the server, some from a file:

```
Squad 1 — Club Tablet 1 — 8 shooters — 7:42 PM   (server)
Squad 2 — Club Tablet 2 — 7 shooters — 7:51 PM   (server)
Squad 3 — from file      — 6 shooters            (file)
```

One "Compile" button. No branching, no mode to enter, no decision about which
method to use. The source marker exists so the RO can see squad 3 is accounted
for, not so they have to think about it.

The app already knows how to compile from files — that is the current workflow.
The network path is an *optimization* on it, not a replacement with a fallback.

### 8.3 Tablet dies mid-match

The backend cannot help with scores that existed only on that tablet. If local
storage survives, the app restores as it always has. If not, the squad is
re-shot or reconstructed from paper.

What sync *does* protect is the shooters. If the RO had tapped backup at any
point with signal, the check-ins — including new shooters' contact details — are
on the server. That is the entire argument for §5.2.

### 8.4 Replacement tablet

A spare tablet takes over a dead tablet's squad mid-match.

**The replacement keeps its own device id.** It does not adopt the dead tablet's
id. The history then says what actually happened: one tablet uploaded a partial
squad and stopped, another took over. Adoption would put a lie in the data that
is invisible until someone tries to reconstruct the evening months later.

**Resume flow:** "Resume a squad from the server" lists what is uploaded for the
current match. The RO picks squad 3. The tablet downloads that payload and
restores it as live match state, then continues scoring under its own device id.

**The two uploads overlap, they do not complement.** The replacement uploads the
*complete* squad, including the shooters the original had already scored. The RO
picks one row, never both — compiling both double-counts.

This is stated explicitly because it is not inferable from the data.

---

## 9. Recovery

### 9.1 Normal backup

The club exports the database monthly (`npm run backup`) and stores the dump
outside Cloudflare. Backend-side task, documented in the README. The export
contains every shooter's name, email, and phone in plaintext.

### 9.2 Rebuilding from tablets

If a club loses access to its Cloudflare account with no usable backup, the
roster can be rebuilt from the tablets. Match history cannot — anything that
existed only on the server is gone.

**Order matters:**

1. **Every tablet exports** to shared storage. All of them, before anything else.
2. **One tablet compiles** every export into a merged roster, still holding its
   old configuration.
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

The most important screen in the integration, because it is where the RO's
knowledge of the evening meets the server's record of it.

### 10.1 What it shows

For each upload: squad label, device label, shooter count, upload time, and
source (server or file). Shooter names available on expand — see §10.2.

Filter out the `"compiled"` device id; that is a result, not a squad.

### 10.2 Same squad label, two devices

Two rows can share a squad label. There are two causes and **the app cannot
distinguish them**:

```
Squad 1 — Club Tablet 1 — 8 shooters — 7:42 PM
Squad 1 — Club Tablet 2 — 7 shooters — 7:51 PM
```
Two genuinely different squads that both got labelled "Squad 1". **Compile both.**

```
Squad 3 — Club Tablet 3 — 4 shooters — 7:38 PM
Squad 3 — Club Tablet 4 — 6 shooters — 8:15 PM
```
A replacement tablet took over. **Compile one.**

Identical shape, opposite action.

**Required behaviour:**

- Flag the pattern neutrally: *"Two tablets used this squad name — check whether
  these are different squads or a replacement."*
- **Default both to selected.** Compiling both when it was a replacement gives
  double-counted entries the RO notices immediately. Compiling one when they
  were different squads gives a silently missing squad, which is far easier to
  miss.
- Show shooter names on expand. Overlapping names means replacement; entirely
  different names means two squads. **This resolves it unambiguously.**

**Do not conclude anything from the timestamps.** A replacement usually shows a
gap of half an hour or more while two real squads finish minutes apart, and an
RO will read the times that way naturally — but the heuristic fails exactly when
it matters (a tablet dying near the end of a match, a squad delayed by a
re-shoot), and a confident wrong label is worse than no label. Show the times.
Let the RO conclude.

### 10.3 What it must never do

**Never ask for a squad count in advance.** A typed count that disagrees with
reality is worse than no count, because a green light gets trusted. The RO knows
how many squads ran; a gap in the list is visible to them in a way it is not
visible to the server.

**Never auto-resolve an ambiguity.** Show what is true, flag what is ambiguous,
and let the compiling RO make the final decision. That principle runs through
this entire specification.

---

## 11. Implementation notes

**Payload integrity.** The server hashes the payload text for duplicate
detection. Generate the payload string once and send that exact string; do not
regenerate or re-serialize between hashing and sending.

**Timestamps** are epoch milliseconds, server-assigned. Do not rely on client
clocks for ordering — tablets at a range are not reliably in sync.

**`schema_version`** is currently `1` and comes from the payload. Bump it when
the payload shape changes; the server stores it so a future reader can tell
which format it is looking at.

**Retention.** No purge exists. If one is added, a squad upload must never be
deleted while its `merged_into_roster_revision` is null — it may hold the only
copy of a shooter added at check-in and never compiled.

**Encryption is not implemented.** Payloads are stored as plain JSON. A later
stage may add client-side AES-GCM encryption, at which point `payload` carries
base64 ciphertext and an `iv` field is added. The server never reads inside a
payload, so this needs no server-side change beyond a schema addition. Nothing
in the client should assume the payload is readable by anything but the app.

**Free tier headroom.** 100,000 Worker requests/day, 5M D1 rows read/day,
100,000 written/day, 5 GB storage. A five-tablet match uses a few hundred
requests. Do not design around these limits; do not poll aggressively either.
