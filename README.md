# Match Scorekeeper Backend

An optional sync backend for the Match Scorekeeper PWA. It lets tablets at a
match upload their squad's scores and share one club shooter roster, replacing
the manual export-to-Drive-and-back workflow.

It is self-hosted: each club runs its own copy on its own free Cloudflare
account. Nobody hosts anybody else's data.

**The app works fully offline without this.** Sync is off by default — the
server URL is blank until someone deliberately configures it. If the backend is
unreachable, or was never set up, matches run exactly as they always have.

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

There is no purge and none is needed yet. Squad payloads are 10–50 KB, so a
club running weekly matches uses a few megabytes a year against a 5 GB
allowance. Storage is not a reason to delete anything.

If a purge is ever added, one rule is not negotiable:

**Never delete a squad upload whose `merged_into_roster_revision` is null.**

A null there means no roster compile has ever absorbed that squad — and until
one has, any shooter added at check-in on that tablet exists in that upload and
nowhere else. Deleting it would silently destroy the only copy of that person's
contact details.

Reducing exposure is a better argument for deletion than storage is, but it
points at encrypting payloads rather than deleting them: purging last year's
matches does nothing for this year's.

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
