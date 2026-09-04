# Cheat Sheet — Match Scorekeeper Backend

Commands for this project, with what they actually do. Kept in the repo so it is
where the work is.

---

## Daily rhythm

```bash
git status                    # what changed — read this before every commit
git add .                     # stage everything (respects .gitignore)
git commit -m "message"       # save a snapshot
git push                      # send to GitHub
```

**Read `git status` before every `git add .`.** It is the ten seconds that stops
a backup file or a stray secret entering history, and history is permanent.

```bash
git pull                      # get changes made on GitHub
```

Needed whenever you edit a file in GitHub's web editor. Pushing without pulling
first gets rejected.

---

## Looking around

```bash
git log --oneline             # commit history, one line each
git log --oneline -10         # last ten
git diff                      # what changed but is not staged yet
git diff --staged             # what is staged and about to be committed
git show <hash>               # everything in one commit
```

Hashes come from `git log --oneline` — the short code at the start of each line.

---

## Undoing things

Ordered by how much they throw away. Read before running.

```bash
git restore <file>            # discard changes to one file — UNRECOVERABLE
git restore .                 # discard ALL uncommitted changes — UNRECOVERABLE
git restore --staged <file>   # unstage, but keep the changes
```

```bash
git commit --amend -m "new message"    # fix the last commit message
```

Only safe if that commit has not been pushed. Amending a pushed commit rewrites
history that others may have.

```bash
git revert <hash>             # undo a commit by making a new one that reverses it
```

The safe way to undo something already pushed. It adds to history rather than
rewriting it.

---

## Files you meant to ignore

The two-step problem: `.gitignore` only affects files git is **not already
tracking**. Once a file is tracked, adding it to `.gitignore` does nothing.

```bash
# 1. add the pattern to .gitignore, then:
git rm --cached <file>        # stop tracking it, but keep it on disk
git commit -m "Stop tracking <file>"
```

**`--cached` is essential.** Without it, `git rm` deletes the actual file.

The file stays in past commits forever. Fine for scratch data; a real problem for
a secret, which is why reading `git status` matters more than fixing it after.

---

## Keeping a local-only value in a tracked file

This project's `wrangler.jsonc` holds a placeholder in the repo and your real
database id on your machine.

```bash
git update-index --skip-worktree wrangler.jsonc     # ignore local changes to it
git update-index --no-skip-worktree wrangler.jsonc  # start tracking changes again
```

```bash
git ls-files -v | grep ^S     # list every file currently skipped
```

**This is invisible in `git status`.** In six months you will wonder why a change
to that file will not commit. That last command is how you find out.

---

## Releases

```bash
git tag                                    # list tags
git tag -a v1.0.1 -m "What changed"        # create a tag
git push origin v1.0.1                     # send it to GitHub
git ls-remote --tags origin                # what tags GitHub has
```

Then on GitHub: **Releases → Draft a new release**, choose the tag, publish. That
generates the Download ZIP link the setup guide points at.

Tag after pushing the commits it should include — a tag points at a specific
commit, not at "latest".

---

## Project commands

```bash
npm install                   # install tools (after cloning or pulling)
npm run dev                   # local server on port 8787 — leave running
npm test                      # 41 endpoint tests, needs dev server running
npm run check                 # syntax check src/index.js
npm run backup                # export the production database
```

Tests read their target from the environment:

```powershell
$env:API_BASE = "http://127.0.0.1:8787"
$env:API_CLUB = "your-local-club-id"
$env:API_SECRET = "your-local-secret"
```

**`$env:` not `$`.** A plain `$SECRET` exists only inside PowerShell; `$env:`
makes it visible to programs PowerShell launches. These vanish when the terminal
closes.

---

## Wrangler

Every command takes `--local` or `--remote`. **`--local` is your machine.
`--remote` is production.** Check which one you typed before pressing Enter.

```bash
npx wrangler login                                    # authenticate
npx wrangler whoami                                   # which account am I?
npx wrangler deploy                                   # put src/index.js live
npx wrangler d1 list                                  # list databases
npx wrangler d1 migrations apply match-scorekeeper --remote
```

Deploy when **behaviour** changes. Comments, README edits, and anything in
`scripts/` need no deploy — scripts run on your machine, never on Cloudflare.

### Queries

```bash
npx wrangler d1 execute match-scorekeeper --remote --command "SELECT ..."
```

```sql
-- What clubs exist
SELECT club_id, display_name, secret_version FROM clubs;

-- What has been uploaded
SELECT match_key, squad_key, device_id, revision, entry_count
  FROM squad_uploads ORDER BY uploaded_at DESC LIMIT 20;

-- Roster history
SELECT revision, author, entry_count, updated_at FROM rosters
 ORDER BY revision DESC;
```

**Rows read counts rows scanned, not returned.** A `SELECT *` on a large table
counts every row against the daily allowance. Irrelevant at club scale; worth
knowing the shape.

---

## Destructive commands

There is no undo and no point-in-time recovery on the free plan.

```bash
# Delete one club and everything belonging to it (cascades)
npx wrangler d1 execute match-scorekeeper --remote \
  --command "DELETE FROM clubs WHERE club_id = 'the-id';"

# Clear all match data, keep clubs — LOCAL ONLY unless you mean it
npx wrangler d1 execute match-scorekeeper --local \
  --command "DELETE FROM squad_uploads; DELETE FROM rosters;"
```

**Every destructive command against production needs a `WHERE` clause naming
exactly what it touches.** `DELETE FROM clubs` with no `WHERE` empties the table.

`npm run backup` first. Every time. It takes seconds.

---

## Management scripts

```bash
node scripts/list-clubs.js --remote
node scripts/create-club.js "Club Name" --remote --url https://your-url.workers.dev
node scripts/rotate-secret.js <club-id> --remote --url https://your-url.workers.dev
node scripts/export-backup.js --remote --out backups
```

`create-club` and `rotate-secret` print a secret **once**. It is not stored
anywhere recoverable. Save it before closing the window.

---

## Recovering the terminal

```powershell
dir                           # what is in this folder (ls on Mac/Linux)
cd path\to\folder             # move to a folder
cd ..                         # up one level
type filename                 # print a file (cat on Mac/Linux)
```

**Ctrl+C** stops a running command. In `npm run dev`, press **x**.

---

## When something is not working

Check what is actually on disk before debugging code that may not be there:

```powershell
dir                                          # timestamps — did the save land?
Select-String -Path src/index.js -Pattern "something you just added"
node --check src/index.js                    # syntax only
```

Three separate failures on this project were a file that had not saved. The
symptom looks like a code bug; the cause is that the code is not there.

### Reading an error

The first two lines are the error. Everything after is the stack trace — how
execution got there.

- Every line says `node:internal/` → none of it is your code, read the top
- One line names **your** file → that line is where to look

`SyntaxError` at the end of a file usually means an imbalance earlier — a brace
that closed too soon leaves a spare one stranded at the bottom.

### Wrangler build errors

```powershell
Remove-Item -Recurse -Force .wrangler\tmp
npm run dev
```

`.wrangler/tmp` is scratch and gets rebuilt. Deleting the whole `.wrangler`
folder also wipes your **local** database — recreate with `npm run migrate:local`
and a fresh `create-club`. Production is untouched.

---

## Things that have bitten this project

- **A file that did not save.** Check the timestamp before debugging.
- **`$SECRET` vs `$env:API_SECRET`.** Different things. Tests need the second.
- **`curl` vs `curl.exe`.** In PowerShell, bare `curl` is a different tool with
  different flags. Always `curl.exe`.
- **Environment variables vanish** when a terminal closes. Reset them.
- **`git add .` before reading `git status`.** How `body.json` got committed.
- **Committing before pulling** after editing on GitHub. Pull first.
- **Forgetting `--remote`.** Half the confusion on this project was a command run
  against the wrong database.
