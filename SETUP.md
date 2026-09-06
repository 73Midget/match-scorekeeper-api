# Setting Up Your Club's Match Scorekeeper Backend

A step-by-step guide to standing up your own sync backend for the Match
Scorekeeper app.

---

## Before you start — read this part

**This takes 30 to 45 minutes.** Most of that is waiting on downloads and
creating accounts, not typing.

**One person does this, once, ever.** After it is done, nobody else at your club
needs to repeat it. They just get a setup code pasted into their tablet.

**Find the right person to do it.** You do not need to be a programmer, but you
will be typing commands into a black window and editing one line of a text file.
If that sounds fine, you are the right person. If it sounds unpleasant, find the
member of your club who sets up the wifi and ask them.

### What you need

- **A computer** — Windows, Mac, or Linux. Not a tablet or a phone.
- **Permission to install software on it.** If it is a work computer that blocks
  installs, use a different one. Find this out now rather than twenty minutes in.
- **An email address** for the Cloudflare account. See the note below.
- **A way to save passwords.** A password manager, or a notebook. You will be
  given a code you cannot recover if you lose it.

### About the email address

The Cloudflare account owns your club's data. If it is registered to a personal
address and that person leaves the club, recovering access can be difficult.

**Use a club email address if you have one**, and make sure more than one officer
can get into it. If you only have personal addresses, that is workable — but make
sure at least one other officer knows which account it is and can reach that
inbox.

### What this costs

Nothing. Everything here runs on Cloudflare's free plan, which does not ask for a
credit card. A club running weekly matches uses a fraction of a percent of what
the free plan allows.

### Support

This is a personal project shared as-is. If someone gave you this guide directly,
ask them — they will have set one up already. Otherwise, you are on your own for
now: the code is public, the setup is documented, and there is no support channel.

---

## What you are actually building

The Match Scorekeeper app works completely offline and always will. This backend
is optional. It does one job: it moves files between your tablets so nobody has
to pass a USB stick around or email exports.

With it set up:

- Each tablet uploads its squad's scores at the end of a match
- One tablet pulls them all down and compiles the results
- The updated shooter list goes back up, and every tablet gets it before the next
  match

Without it, all of that still works — it just happens by hand.

Three pieces get created:

1. **A Cloudflare account** — free, and yours
2. **A database** — where the files are stored
3. **A "worker"** — a small program that receives and hands out those files

You will not need to understand how any of them work.

---

## Step 1 — Create a Cloudflare account

Go to **[dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)**.

Enter an email address and a password. **Save that password properly** — this
account holds your club's data.

Cloudflare will email you a verification link. Click it.

You may be asked to add a website or choose a plan. **Skip both.** You do not
need a domain and you do not need a paid plan. If there is no obvious skip
option, look for a link like "I'll do this later" or go to
[dash.cloudflare.com](https://dash.cloudflare.com) directly.

**Check it worked:** you can see a Cloudflare dashboard with a menu down the left
side.

---

## Step 2 — Install Node.js

Node.js is a program that runs other programs. The setup tools need it.

Go to **[nodejs.org](https://nodejs.org)** and download the version marked
**LTS**. That stands for Long Term Support and it is the stable one.

Run the installer and accept all the defaults.

**Check it worked** — open a terminal. This is the black window mentioned
earlier:

- **Windows:** press the Windows key, type `powershell`, open Windows PowerShell
- **Mac:** press Cmd+Space, type `terminal`, press Enter
- **Linux:** Ctrl+Alt+T

Type this and press Enter:

```
node --version
```

You should see something like `v22.11.0`. Any version 18 or higher is fine.

If it says the command is not recognised, close the terminal, open a new one, and
try again — a terminal only learns about newly installed programs when it starts.
If it still fails, the install did not complete.

### Windows only — one extra step

Windows blocks certain scripts by default, which stops the tools working. In
PowerShell, run:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Answer `Y` if asked.

This allows programs installed on your own machine to run, while still blocking
unsigned scripts downloaded from the internet. It is the standard setting for a
computer used for development, and it applies only to your user account.

---

## Step 3 — Download the backend

Go to
**[github.com/73Midget/match-scorekeeper-api/releases](https://github.com/73Midget/match-scorekeeper-api/releases)**.

Under the most recent release, find **Source code (zip)** and download it.

Unzip it somewhere you will find again — your Documents folder is fine. You will
get a folder named something like `match-scorekeeper-api-1.0.1`.

**Rename that folder to `match-scorekeeper-api`.** It saves typing later.

---

## Step 4 — Open a terminal in that folder

The terminal is always "in" a folder, and commands act on wherever it is. You
need it to be in the folder you just unzipped.

**Windows:** open the folder in File Explorer, click the address bar at the top,
type `powershell`, and press Enter.

**Mac:** right-click the folder, choose Services → New Terminal at Folder. If
that is not there, open Terminal, type `cd ` (with a space), then drag the folder
onto the window and press Enter.

**Linux:** right-click in the folder and choose Open Terminal Here.

**Check it worked:**

```
dir
```

(On Mac or Linux, use `ls`.)

You should see `package.json`, `wrangler.jsonc`, `README.md`, and some folders.
If you see something else, the terminal is in the wrong place.

---

## Step 5 — Install the tools

In that terminal:

```
npm install
```

This downloads the tools the setup needs. It takes a minute or two and prints a
lot of text. Warnings are normal. What matters is that it ends without saying
"error".

**If it asks about install scripts** for `esbuild` and `workerd`, run these:

```
npm approve-scripts esbuild
npm approve-scripts workerd
npm install
```

Both are legitimate — they download the pieces that let the software run on your
particular computer. Node asks because install scripts are a way malicious
packages attack developers, so it makes you confirm.

**Check it worked:**

```
npx wrangler --version
```

You should see a version number.

---

## Step 6 — Connect to your Cloudflare account

```
npx wrangler login
```

Your browser opens with a Cloudflare page asking to authorise the tool. Click
**Allow**. The page will say you can close it.

The permissions list looks long. That is normal for an official tool — it asks
for everything it might ever need.

**Check it worked:**

```
npx wrangler whoami
```

It should show the email address you signed up with.

---

## Step 7 — Create the database

```
npx wrangler d1 create match-scorekeeper
```

This creates an empty database. It prints several lines including one that looks
like:

```
"database_id": "23d001ff-c042-4ed5-b645-ea6429649b15"
```

**Copy that long code from between the quotes.** You need it in the next step.
Yours will be different.

It is not a secret — it names your database but does not grant access to it.

---

## Step 8 — Put your database code into the settings file

In the project folder, open **`wrangler.jsonc`** with a plain text editor —
Notepad on Windows, TextEdit on Mac.

Find this line:

```
      "database_id": "PASTE_YOURS_HERE",
```

Replace `PASTE_YOURS_HERE` with the code you copied in step 7. **Keep the quote
marks and the comma.** Only the text between the quotes changes.

**Before:**

```
      "database_id": "PASTE_YOURS_HERE",
```

**After** (yours will have a different code):

```
      "database_id": "23d001ff-c042-4ed5-b645-ea6429649b15",
```

Save the file.

**On Mac,** if TextEdit will not save it as plain text, use Format → Make Plain
Text first.

**Common mistakes:** deleting a quote mark, deleting the comma, or pasting the
whole line from step 7 instead of just the code. If step 9 fails with a message
about the file, check those three.

---

## Step 9 — Create the tables

```
npx wrangler d1 migrations apply match-scorekeeper --remote
```

It lists what it is about to do and asks you to confirm. Say yes.

This builds the structure that holds your scores and shooter list.

**Check it worked:**

```
npx wrangler d1 execute match-scorekeeper --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

You should see a table listing that includes `clubs`, `rosters`, and
`squad_uploads`. Other names alongside them are Cloudflare's own bookkeeping.

---

## Step 10 — Put it online

```
npx wrangler deploy
```

This uploads the program to Cloudflare. It prints a web address like:

```
https://match-scorekeeper-api.yourname.workers.dev
```

**Write that address down.** It is your club's backend, and you need it in the
next step and whenever a tablet is set up.

**Check it worked** — open that address in a browser and add `/health` to the
end:

```
https://match-scorekeeper-api.yourname.workers.dev/health
```

You should see:

```
{"ok":true,"service":"match-scorekeeper-api"}
```

If you see that, your backend is running.

---

## Step 11 — Create your club

This command has two parts you must replace with your own details:

```
node scripts/create-club.js "YOUR CLUB NAME" --remote --url YOUR-BACKEND-ADDRESS
```

| Replace this | With this |
|---|---|
| `YOUR CLUB NAME` | Your club's name. **Keep the quote marks around it.** |
| `YOUR-BACKEND-ADDRESS` | The web address from step 10. No quote marks needed. |

**A finished command looks like this:**

```
node scripts/create-club.js "Riverside Gun Club" --remote --url https://match-scorekeeper-api.jsmith.workers.dev
```

Add `--qr` on the end if you would also like a scannable code:

```
node scripts/create-club.js "Riverside Gun Club" --remote --url https://match-scorekeeper-api.jsmith.workers.dev --qr
```

It prints something like:

```
  Created club: Riverside Gun Club

  Club id:      x3222665
  Secret:       GDAKdFijI/vSBhgyIOxNQyr8sq4l6p1195jls2IgvXI=

  Setup code (paste into the app's Connection screen):

  eyJ1cmwiOiJodHRwczovL2V4YW1wbGUud29ya2Vycy5kZXYiLCJjbHViIjoi...
```

### Save these now, before anything else

**The secret cannot be recovered.** The system stores only a scrambled version of
it, which is deliberate — it means a stolen copy of the database does not hand
anyone access to your data. But it also means nobody, including whoever wrote
this, can tell you what your secret was.

Save, in a password manager or somewhere safe more than one officer can reach:

- The web address from step 10
- The club id
- The secret
- The setup code

**Treat the setup code like a key to your building.** It contains the secret.
Anyone who has it can upload and download your club's data. Do not post it in a
group chat, do not photograph it, do not email it to a list.

If it does get out, that is recoverable — see "Rotating your secret" in the
operations guide.

---

## Step 12 — Set up a tablet

On a tablet with Match Scorekeeper installed:

**1.** Tap **TOOLS** — the gear button in the top right corner.

**2.** Scroll to the **CONNECTION** section and tick **Enable online services**.

**3.** A **SETUP CODE** box appears. Paste your setup code from step 11 into it,
and save.

The app checks the code and shows your club's details. **If it shows your club
name, it worked.** If it shows an error, the code was pasted incompletely — they
are long and easy to cut short.

**4.** Scroll back up to **THIS TABLET** — the first section in Tools — and fill
in **DEVICE NAME**: "Club Tablet 1", "Range Tablet", something you would
recognise. Tap **SAVE NAMES**.

This is how you tell tablets apart later when compiling results, especially if
two of them end up using the same squad name. The squad name field above it is
for the squad this tablet is scoring, and it changes match to match. The device
name stays put.

**5.** Repeat for every tablet. The same setup code goes on all of them — the app
gives each one its own internal identity automatically. Give each a different
device name.

### About the QR code

If you used `--qr`, you can scan the code with the tablet's camera instead of
typing. Some cameras will offer to copy the text, and you paste it into the SETUP
CODE box.

**Older phones and tablets handle text QR codes differently.** Some camera apps
only act on web links and will do nothing useful with a text code. That is not a
fault — just paste the setup code instead. The QR is a shortcut, not the only
way.

---

## You are done

Your club now has a working backend. From here:

- Read **OPERATIONS.md** — the day-to-day guide. Everyone who runs matches should
  read it.
- **Do the first backup now.** In the project folder: `npm run backup`. Then copy
  the file it creates somewhere off this computer.
- Keep the project folder. You need it for backups and for changing the secret.

---

## If something went wrong

**"Command not found" or "not recognised"** — the program did not install, or the
terminal was opened before it was installed. Close the terminal, open a new one,
try again.

**"Authentication error"** — run `npx wrangler login` again. The connection to
Cloudflare expires.

**Step 9 or 10 fails with a permissions error** — sign in at
[dash.cloudflare.com](https://dash.cloudflare.com) and click "Workers & Pages" in
the menu. Some accounts need that visited once before the tools can use it. Then
try again.

**Step 9 complains about the settings file** — go back to step 8. A missing quote
mark or comma is the usual cause.

**The health check in step 10 shows nothing** — wait a minute and reload.
Deploying takes a moment to reach everywhere.

**The tablet says the setup code is invalid** — the code was cut short when
copied. Run step 11 again to get a fresh one; creating a second club is harmless
and you can ignore the first.

**Something else** — see the support note at the top of this guide.
