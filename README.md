# Match Scorekeeper Backend

An optional sync backend for the Match Scorekeeper PWA. It lets tablets at a
match upload their squad's scores and share one club shooter roster, replacing
the manual export-to-Drive-and-back workflow.

It is self-hosted: each club runs its own copy on its own free Cloudflare
account. Nobody hosts anybody else's data.

**The app works fully offline without this.** Sync is off by default — the
server URL is blank until someone deliberately configures it. If the backend is
unreachable, or was never set up, matches run exactly as they always have.

## Documentation

- **[SETUP.md](SETUP.md)** — standing up your own backend, step by step. Start here.
- **[OPERATIONS.md](OPERATIONS.md)** — running your club day to day.
- **[INTEGRATION.md](INTEGRATION.md)** — the API specification, for app development.
- **[CHEATSHEET.md](CHEATSHEET.md)** — command reference.

---

## What it does

- **Squad upload.** Each tablet uploads its squad — mid-match when the RO taps
  backup, and again at the end.
- **Squad list and download.** The RO's tablet sees what has arrived and pulls
  each one to compile.
- **Roster sync.** The compiled shooter list is pushed once and every other
  tablet restores from it at the next match.
- **Match archive.** Compiled results are stored as a backup.

## What it does not do

- No compilation or merging — that stays in the app, where the ranking logic
  already lives.
- No web view of results.
- No reading of score data. The server stores the app's JSON as opaque text.
- No decisions. When something is ambiguous, the server reports what exists and
  the RO decides.

---

## Requirements

- A free Cloudflare account. No credit card.
- [Node.js](https://nodejs.org) 18 or newer.
- A terminal.

A custom domain is **not** required. It is only needed for browser-based
management via Cloudflare Access, which is optional — the scripts here cover
everything from the command line.

### Free tier

Everything fits the Cloudflare free plan with room to spare. As of writing:
100,000 Worker requests per day, 5 million database rows read per day, 100,000
written, and 5 GB of storage.

A five-tablet match uses a few hundred requests and writes a few dozen rows. A
busy club running weekly matches uses a fraction of a percent of the daily
allowance on match day.

Limits change — check
[Cloudflare's pricing](https://developers.cloudflare.com/workers/platform/pricing/)
for current figures.

---

## Setup

### 1. Install

```bash
git clone <this-repo>
cd match-scorekeeper-api
npm install
```

If npm asks about install scripts for `esbuild` and `workerd`, approve them.
Both need platform-specific binaries; `workerd` is the Cloudflare runtime that
makes local testing work.

```bash
npm approve-scripts esbuild
npm approve-scripts workerd
npm install
```

### 2. Sign in to Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

The second command confirms which account you are acting as. If you have more
than one, make sure it is the right one before continuing.

### 3. Create the database

```bash
npx wrangler d1 create match-scorekeeper
```

This prints a `database_id`. Copy it into `wrangler.jsonc`, replacing the
existing value:

```jsonc
"database_id": "paste-yours-here",
```

### 4. Create the tables

```bash
npx wrangler d1 migrations apply match-scorekeeper --remote
```

Verify:

```bash
npx wrangler d1 execute match-scorekeeper --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

You should see `club_admins`, `clubs`, `rosters`, and `squad_uploads`,
alongside Cloudflare's own bookkeeping tables.

### 5. Deploy

```bash
npx wrangler deploy
```

This prints your API URL, something like
`https://match-scorekeeper-api.yourname.workers.dev`. Note it.

Check it is alive:

```bash
curl https://your-url.workers.dev/health
```

Expect `{"ok":true,"service":"match-scorekeeper-api"}`.

### 6. Create your club

```bash
node scripts/create-club.js "Your Club Name" --remote --url https://your-url.workers.dev
```

This prints a club id, a secret, and a configuration blob.

**Save the secret immediately.** The database stores only a hash of it. It
cannot be recovered — if it is lost, the only remedy is rotating to a new one.

### 7. Configure the tablets

Paste the configuration blob into each tablet's sync setup screen. One paste
per tablet.

Give each tablet a name — "Club Tablet 1", "Dave's iPad". It is display only,
but it is how you tell two tablets apart on the compile screen when both squads
happen to be labelled "Squad 1".

---

## Running a match

The backend does not change how matches are scored. What it changes is how
squad files get from several tablets to one, and how the shooter list gets back
out to all of them.

**Before:** on each tablet, tap "Get latest shooter list."

**During:** tap backup as usual. When sync is configured, each backup also
uploads the squad — so a tablet that dies later has already put its data
somewhere safe. If there is no signal the local backup still succeeds and the
tablet says so quietly.

**After:** on each tablet, tap "Upload squad."

**Compiling:** on one tablet, open the compile screen. It lists what has been
uploaded. Compile, then publish — the roster and the compiled results both go
up.

**Next match:** every tablet taps "Get latest shooter list" and has the new
shooters, contact details included.

If a tablet cannot upload, its squad is exported to a file and imported on the
compiling tablet, exactly as before. The compile screen handles a mix of
sources.

---

## Management

All scripts take `--remote` to act on the deployed database, and default to a
local development copy without it.

### List clubs

```bash
node scripts/list-clubs.js --remote
```

Shows club ids, names, secret versions, and creation dates. Secrets are never
displayed — the database does not have them.

### Add a club

```bash
node scripts/create-club.js "Another Club" --remote --url https://your-url.workers.dev
```

Multiple clubs on one backend are fully isolated: a club's secret grants access
to that club's data and nothing else.

### Rotate a secret

```bash
node scripts/rotate-secret.js <club-id> --remote --url https://your-url.workers.dev
```

Use this when a secret has been exposed — pasted somewhere it should not have
been, emailed, or lost with a tablet. The club keeps its id and all of its data;
only the credential changes.

You will be asked to type the club id to confirm.

**Every tablet stops working the moment this runs.** There is no grace period.
Rotate before a match, not during one, and have the new configuration ready to
distribute.

### See what is outstanding

```bash
node scripts/list-unmerged.js --remote
```

Read-only. Squad uploads no compile has absorbed — the first thing to check if
a shooter seems missing from the club list, and the first thing to run before
any cleanup. See Retention below.

---

## Backups

**Do this monthly.** It is the difference between a lost account being an
inconvenience and being a catastrophe.

```bash
npx wrangler d1 export match-scorekeeper --remote --output backup-2026-08.sql
```

Store the file somewhere **outside Cloudflare** — a club Google Drive folder, a
club officer's computer, anywhere that survives losing access to the account.
Keeping it on Cloudflare defeats the purpose.

There is no free automated path for this. A scheduled job could copy data within
Cloudflare, but getting the file *off* Cloudflare is the entire point, so a
person running a command monthly is genuinely the right design.

### The backup contains personal data

The export includes every shooter's name, email address, and phone number in
plaintext. It is the most sensitive artifact this system produces.

Decide deliberately where it lives and who can open it. A club Drive folder
shared with everyone is probably not the right place.

---

## If you lose access to your Cloudflare account

### With a backup

Create a new account and database, then import the dump:

```bash
npx wrangler d1 execute match-scorekeeper --remote --file backup-2026-08.sql
```

Everything returns — clubs, matches, roster history.

### Without a backup

The roster can be rebuilt from the tablets, because each holds its own local
copy. Match history cannot — anything that existed only on the server is gone.

**Order matters. Follow it exactly.**

1. **Every tablet exports** its local data to shared storage — a Drive folder,
   a USB stick, anything all of them can reach. All tablets, before anything
   else happens.
2. **One tablet compiles** every export into a merged roster, still using its
   old configuration.
3. **Check the result.** Shooter count, recent additions, anyone you know
   joined lately.
4. Set up the new backend and create a new club. Reconfigure that one tablet
   with the new blob.
5. It pushes the roster.
6. It **pulls the roster back** and confirms it matches what was sent.
7. Only now do the other tablets reconfigure and restore.

The risk is a tablet reconfiguring and syncing *before* step 1. It would pull an
empty roster from the new club and could overwrite local data that is the only
surviving copy of a shooter's details. Collect every export first.

---

## Retention

Three scripts delete data. All three are dry-run by default and none of them
ever touch the club shooter list — `rosters` is append-only and nothing prunes
it, so no cleanup can lose a member.

### Why prune at all

Not storage. An RO uploads after every shooter, so a 30-shooter squad generates
around 30 revisions in one match and a five-squad match generates 150 — roughly
4.5 MB. A 40-match season is about 180 MB against a 5 GB allowance, so a club
would need decades to fill it.

The reason is that every one of those payloads holds every shooter's name,
email and phone, and they all land in the monthly backup file. Pruning is about
how much personal data is sitting around, not how many bytes.

### Routine: drop raw squads, keep the results

```bash
node scripts/prune-squads.js --remote                  # dry run, 90 days
node scripts/prune-squads.js --remote --confirm        # delete
```

Deletes raw squad uploads from matches compiled more than 90 days ago, and
keeps each match's compiled archive. The archive holds the same people and the
same scores in one payload rather than 150, so the club keeps a record of every
match while almost all the personal data goes.

It refuses to touch anything a roster push never absorbed, and reports what it
left alone. A null `merged_into_roster_revision` means nobody has compiled that
squad — and until they have, a shooter added at check-in on that tablet exists
in that payload and nowhere else.

### Looking before deleting

```bash
node scripts/list-unmerged.js --remote
node scripts/list-unmerged.js --remote --older-than 90
```

Read-only. Shows every upload no compile absorbed, grouped by match, and
separates two cases that call for different decisions: a match nothing ever
compiled — where the roster may be missing shooters — from a squad that turned
up after an otherwise-normal compile.

It prints metadata only. To see what is actually in a squad, restore or preview
it in the app; the server never reads payloads, which is what keeps client-side
encryption available later.

### Deleting one junk match

```bash
node scripts/delete-match.js --remote "outdoor|8/14/2026"
```

Everything for that match, archive included, with no age or merge check. This
is the only command that can destroy the only copy of a shooter's details, so
it asks for the match key typed back.

**Quote the match key** — it contains a pipe, and an unquoted pipe is a shell
pipeline.

Use it for something you have looked at and concluded is junk: an abandoned
test, a tablet someone started and shut down, a squad uploaded against a
mistyped match name.

### Deleting old matches entirely

```bash
node scripts/prune-matches.js --remote --before 2024-01-01
node scripts/prune-matches.js --remote --before 2024-01-01 --confirm
```

Drops matches whose every upload predates a date you choose — archives
included. After this there is no record on the server that those matches
happened.

There is no default date on purpose. How far back a club keeps its results is a
judgement only the club can make, and a default would become the answer by
accident.

**Back up first.** This is the one cleanup whose result cannot be rebuilt from
anything else on the server.

---

## Security

**The shared secret is the only thing protecting a club's data.** Anyone
holding it can upload and download for that club. It is stored on every
configured tablet, so a lost tablet means rotating the secret.

**Secrets are stored hashed.** A database dump does not hand anyone upload
access. This is safe because the secrets are long random values, not chosen
passwords.

**Clubs are isolated.** Every query is scoped by club id. One club's secret is
useless against another's data, even on the same backend.

**Score payloads are stored as plain text.** The server does not read them, but
it *could* — and so could anyone with database access. Client-side encryption is
a possible future addition; it is not in place today. Anyone running this should
understand they are storing competitor contact details in a readable form.

**Configuration blobs are credentials.** The blob contains the secret. Do not
email it, post it in a group chat, or leave it on a screen.

**Borrowed tablets.** A personal device used to fill in for a club tablet ends
up holding the club secret and a roster with everyone's contact details. Rotate
or wipe after the match; do not leave a club configuration on a device that goes
home with someone.

---

## Development

```bash
npm run dev              # local server on port 8787
npm test                 # 27 endpoint tests, needs the dev server running
npm run check            # syntax check
npm run migrate:local    # apply migrations to the local database
```

Tests read their target from the environment:

```bash
export API_BASE=http://127.0.0.1:8787
export API_CLUB=<club-id>
export API_SECRET=<secret>
```

They can be pointed at a deployed backend, but **they write test data**. Do not
run them against a database holding real matches.

### Project layout

```
src/index.js          the Worker — all endpoints
migrations/           schema, applied in order, never edited once applied
scripts/              management commands
scripts/lib/          shared helpers used by the scripts
test/api.test.js      endpoint tests
INTEGRATION.md        the client-side specification
```

### Schema changes

Never edit an applied migration. Create a new one:

```bash
npx wrangler d1 migrations create match-scorekeeper describe_the_change
```

Apply locally, run the tests, then apply to remote.

---

## License

GNU Affero General Public License v3.0. See `LICENSE`.

The AGPL's network clause is the relevant one here: if you modify this and run
it as a service others use, they are entitled to your modified source. Running
it unmodified for your own club — which is what this is designed for — carries
no obligation beyond keeping the license notice.
