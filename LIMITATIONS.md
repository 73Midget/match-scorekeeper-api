# Limitations and known gaps

What this backend does not do, and why. Some of it is deliberate and may stay
that way; some of it should exist and does not yet.

`INTEGRATION.md` §1 covers what the *API* deliberately does not do — no
compilation, no payload parsing, no conflict resolution. This file is about the
project: things a person deciding whether to run this should know before they
depend on it.

---

## Not implemented, by design for now

### Payloads are not encrypted

Squad uploads and roster revisions are stored as plain JSON. Every one holds
shooters' names, email addresses and phone numbers in the clear — in the
database, and in every backup file the export script produces.

Anyone running this should treat the database and its dumps as containing their
members' contact details, because they do. `OPERATIONS.md` covers handling
backups accordingly.

**What adding it would take.** The app encrypts with AES-GCM before uploading;
`payload` carries base64 ciphertext and a new `iv` field travels beside it. The
server never looks inside a payload, so this needs no server-side logic — only a
schema addition. The note at the top of `migrations/0001_init_schema.sql` records
the same thing.

**What keeps it possible.** Nothing on the server reads a payload, and no tool
does either: the unmerged listing reports metadata only, and the squad revision
list excludes payloads deliberately. Any feature that reads inside a payload
closes this door permanently.

**What it would cost.** Key management. A key lost is data lost, and the key has
to reach every tablet — the same distribution problem as the shared secret, but
where mistakes are unrecoverable rather than inconvenient.

### There is no web management console

Managing clubs, matches and rosters happens through the scripts in `scripts/`,
which require the project folder and a Cloudflare login. `scripts/console.js`
gives those a menu.

A browser console behind Cloudflare Access was considered. The reason it has not
been built is the encryption question above: a console that lists clubs and
metadata would not read payloads, but one that displays scores would, and that
choice is difficult to reverse once people rely on it.

It would also move destructive capability from "needs the project folder and a
Cloudflare login" to "needs a login," which is a different security posture than
this project currently has.

### There is no preregistration or public sign-up

Shooters are registered and checked in at the match, on a tablet. There is no
way for someone to sign up for a match in advance.

That would be a different product with a different trust model: public sign-up
means unauthenticated writes, spam, and personal data collected from people who
are not club members. None of it fits a backend whose entire security model is
one shared secret per club.

---

## Smaller gaps

Each of these is contained.

### A suspended club is indistinguishable from a bad secret

`scripts/suspend-club.js` sets `clubs.active` to 0 and the Worker then rejects
every request for that club with `401 unauthorized` — the same response as a
wrong secret. Spec §6 tells clients that means "prompt to re-enter
configuration," which is misleading: the tablet's configuration is correct and
the club is paused.

In practice someone has to tell whoever is holding the tablet, because the app
cannot.

**What fixing it would take.** Verify the presented secret first, then check
`active`, and return a distinct `club_suspended` code when the secret is right
but the club is off. The order matters: checking `active` before the hash would
tell an unauthenticated caller which club ids exist, which the authentication
path deliberately avoids. Needs a spec revision and app work.

### `parseDate` in `prune-matches.js` is not exported

It rejects rollover typos like `2024-13-01`, which `new Date()` would otherwise
accept as 2025. It cannot be tested without being exported.

### The test suites treat only `127.0.0.1` and `localhost` as local

`test/api.test.js` and `test/prune.test.js` refuse to run against a non-local
server, since the first pushes rosters and the second deletes rows. The check
does not recognise `http://[::1]:8787` or `http://0.0.0.0:8787`, so a dev server
on either is refused.

This fails closed — it blocks a valid setup rather than allowing a remote one —
so it is a papercut rather than a hazard.

---

## Missing tooling

### Two destructive scripts have no tests

`scripts/delete-match.js` and `scripts/prune-matches.js` have no test coverage,
while `scripts/prune-squads.js` — the least dangerous of the three — has ten.

The pattern in `test/prune.test.js` transfers directly: seed over HTTP, backdate
with SQL, pipe the confirmation on stdin. The case most worth pinning is
`prune-matches.js`'s `HAVING MAX(uploaded_at) < cutoff` rule, which must leave a
match entirely alone when anything in it is newer than the cutoff. That is the
class of condition that reads correctly and can quietly do something else.

### There is no way to delete a club

`DELETE FROM clubs` cascades to that club's uploads, rosters and admin rows. It
is the most destructive statement available against this schema and the only
operation with no script and no guard, which means doing it by hand — and
hand-written destructive SQL is worth avoiding wherever a script can replace it.
`CHEATSHEET.md` has the rule that exists for the same reason.

### Restoring from a backup is manual

A backup is a SQL dump. Putting specific rows back means locating the right
`INSERT` statements inside it, writing them to a file, and replaying them with
`wrangler d1 execute --file`. That works, and it is slow and error-prone at
exactly the moment it is needed.

A script taking a dump plus a club — and optionally a match — and replaying just
those rows would make this mechanical. The extraction is; doing it by hand under
pressure is not.

### Rolling a roster back is manual

The rollback flow is specified (`INTEGRATION.md` §4.12) and has no tooling.
Performing it means listing revisions, fetching one revision's payload,
rebuilding a push body, and sending it with the current `base_revision`.

A roster push replaces the whole shooter list, so a bad one pushed before a match
is a plausible emergency — and the recovery currently has to be reconstructed
from the spec each time. It can be done entirely in SQL, by inserting a new
revision carrying an older one's payload, so it needs no club secret.

### The app cannot preview an uploaded squad

`scripts/list-unmerged.js` will report that a match has uploads nothing ever
compiled. It shows metadata only, deliberately.

But deciding whether one of those is junk or is somebody's scores means reading
it, and the only way to read it today is to restore it over live match state on a
tablet. This is what makes deleting a match feel riskier than it should. It is
app-side work rather than backend.
