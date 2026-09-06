# Match Scorekeeper Backend — Running Your Club

The day-to-day guide. Everyone who runs matches should read the first two
sections. The rest matters when something goes wrong.

If your backend has not been set up yet, start with **SETUP.md**.

---

## The one-minute version

- The app works offline. It always works offline. The backend is a convenience.
- **Tap backup during a match.** When online is turned on, that also sends the
  squad to the server. It is what saves your data if a tablet dies.
- **Back up the database monthly.** One command, five minutes, and it is the
  difference between an inconvenience and a disaster.
- **Never let the setup code out.** It is a key to your club's data.

---

## Running a match

Nothing about scoring changes. What changes is how files get between tablets.

### Before the match

On each tablet, open **TOOLS** and tap **Get latest shooter list**.

Each tablet pulls the current list, including anyone added at the last match on a
different tablet. This is the step that replaces exporting a file and copying it
around.

If a tablet has no signal, it uses the list it already has. That works — it may
just be missing recent additions, and they will be re-added at check-in and
merged automatically later.

### During the match

**No signal needed.** Scoring is entirely local. The tablet is not talking to
anything.

**Tap Backup as often as you normally would.** When online is on, this saves
locally *and* sends the squad to the server.

This matters more than it looks. When a shooter checks in and gives their contact
details, that information exists on **that tablet and nowhere else** until it is
either uploaded or compiled. If the tablet is dropped, drowned, or dies, those
details are gone with it.

A backup with signal makes it safe. If a tablet is behaving oddly or the battery
is low, walk to where there is signal and tap backup.

If there is no signal the local backup still happens. The tablet will show that
the upload is pending and remind you.

### End of the match

On each tablet, tap **Upload squad**.

If a tablet cannot upload, it keeps showing a pending reminder. Do not ignore it
— that squad is not yet safe. You can retry later from anywhere with signal, or
fall back to exporting a file as you would have before.

### Compiling

On one tablet, open the compile screen. It lists every squad uploaded for the
match — squad name, which tablet, how many shooters, and when.

**Look at that list.** You know how many squads ran. If one is missing, the
system cannot know that but you can. Get its file from the tablet directly and
add it — the compile screen takes files as well as uploads, in the same list.

Then compile, and publish. Publishing does three things, each reported
separately:

1. Sends the updated shooter list
2. Sends the compiled results as an archive
3. Checks whether anything arrived late

### About that last check

**A squad can show up here even though you compiled it.** If a tablet uploaded
again after you started compiling, that newer upload genuinely was not part of
what you compiled. The system is reporting a real difference, not raising a false
alarm.

Look at the shooter count and the time. If nothing meaningful changed, ignore it.
If someone was added or a score corrected after you started, you have caught
something worth compiling again — and you have caught it while everyone is still
in the room.

### Next match

Everyone taps **Get latest shooter list** and has the new shooters.

---

## Two situations worth knowing about

### Two tablets used the same squad name

Nothing breaks. Both squads are stored separately, and both appear on the compile
screen with the same name.

The app cannot tell whether these are two different squads that were both called
"Squad 1", or one squad that moved to a replacement tablet. **You can** — look at
the shooter names. Different people means two squads, compile both. The same
people means a replacement, compile only the later one.

This is why each tablet has a device name. On the compile screen you will see
which tablet each one came from, which usually settles it at a glance.

### A tablet died mid-match

If it had uploaded at any point, that upload is on the server and appears on the
compile screen like any other squad. Pick up from there.

You get whatever was in its **last backup**, not the moment it died. Anything
scored after that tap is gone. This is the entire reason to tap backup during a
match rather than only at the end.

If a spare tablet took over, both the dead tablet's partial squad and the
replacement's complete squad appear. **Compile only one** — the replacement's,
which includes everything. Compiling both counts the early shooters twice.

---

## The shooter list number

The CONNECTION screen shows a line like **Shooter list #8**. That is the version
of the shooter list this tablet has. The number goes up each time someone
publishes an updated list.

You do not normally need to think about it. It is useful for one thing: **if two
tablets show different numbers, one of them has not pulled the latest.** Tap Get
latest shooter list on the one that is behind.

---

## Backups

**Do this monthly.** Put it on the same calendar as whatever else the club does
monthly.

On the computer used for setup, open a terminal in the project folder and run:

```
npm run backup
```

It creates a dated file in a `backups` folder inside the project.

**Then copy that file somewhere that is not Cloudflare.** A club Google Drive
folder, an officer's computer, a USB stick in the safe. Anywhere that survives
losing access to the Cloudflare account — because that is the situation it exists
for.

### This file contains personal information

Every shooter's name, email address, and phone number, in plain readable text. It
is the most sensitive thing this system produces.

Think about where it goes. A Drive folder shared with the whole membership is
probably not the right place. Somewhere two or three officers can reach is about
right.

### Why nobody can do this for you

There is no automatic version, and that is on purpose. An automatic backup would
have to store the file on Cloudflare — which does not help at all if the problem
is that you have lost your Cloudflare account. Getting the file *off* Cloudflare
is the whole point, and that needs a person.

---

## Rotating your secret

Change your club's secret if:

- The setup code was posted, emailed, or photographed somewhere it should not
  have been
- A tablet was lost or stolen
- Someone who had it is no longer someone you want having it

Your club keeps its id and all of its data. Only the key changes.

In the project folder:

```
node scripts/rotate-secret.js YOUR-CLUB-ID --remote --url YOUR-BACKEND-ADDRESS
```

Add `--qr` if you want a scannable code for the tablets.

You will be asked to type the club id to confirm. That is deliberate — this locks
out every tablet until each one is given the new code.

**Every tablet stops working immediately.** There is no grace period. So:

- Do it **before** a match, never during one
- Have every tablet in front of you, or be able to reach whoever holds them
- Save the new setup code the same way you saved the old one

If you have forgotten your club id, run:

```
node scripts/list-clubs.js --remote
```

---

## When a tablet leaves your control

A tablet configured for your club holds the club secret and a copy of the shooter
list with everyone's contact details.

**If you borrowed someone's personal tablet for a match**, clear the app's
configuration afterwards, or rotate the secret.

**If a tablet is lost or stolen**, rotate the secret. Whoever has it can
otherwise upload and download your club's data indefinitely.

---

## If you lose access to your Cloudflare account

### If you have a backup

You are fine. Create a new Cloudflare account, follow the setup guide again, and
restore the backup file. Everything comes back — clubs, matches, shooter list
history.

### If you do not have a backup

The shooter list can be rebuilt from the tablets, because each holds its own
copy. Past match results cannot — anything that only existed on the server is
gone.

**The order matters. Do not skip ahead.**

1. **Every tablet exports its data** to a shared folder or USB stick. All of
   them. Before anything else happens.
2. **One tablet combines** all those exports into a single shooter list, still
   using its old configuration.
3. **Check the result** — right number of shooters, recent additions present.
4. Set up a new backend using the setup guide. Configure that one tablet with the
   new setup code.
5. It uploads the shooter list.
6. It downloads it back and confirms it matches.
7. **Only now** do the other tablets get the new setup code and download.

The danger is a tablet being reconfigured and downloading *before* step 1. It
would pull an empty list from the brand-new backend and could overwrite the only
surviving copy of a shooter's details.

Collect everything first. Then rebuild.

---

## Common questions

**Do we have to use this?**
No. The app works completely offline and always will. Untick Enable online
services and everything works as it did before. Your credentials are kept, so you
can turn it back on later without setting up again.

**What does it cost?**
Nothing. It runs on Cloudflare's free plan, which does not ask for a credit card.
A club running weekly matches uses a fraction of a percent of what is allowed.

**Can another club use our backend?**
Yes, technically — one backend can hold several clubs and they cannot see each
other's data. But then you are responsible for their shooter list, their backups,
and their access. Unless you have agreed to that, they should run their own. It
is free.

**Can we see results on the web?**
Not currently. The backend stores results but there is no page that displays
them. Compiling and viewing happens in the app.

**What if two people compile at the same time?**
The second one is stopped and told to pull the first one's changes and try again.
This is deliberate — without it, one person's shooter additions would silently
erase the other's.

**Do the tablets need internet during a match?**
No. Only at the start, to get the shooter list, and at the end, to upload. In
between, nothing is trying to connect.

**A tablet shows a pending upload from last week. What do I do?**
Tap it to retry. It means that squad never reached the server. If the match has
already been compiled it may not matter, but check the compile screen for that
match before dismissing it.

**The QR code will not scan.**
Some older cameras only act on web links and do nothing useful with a text code.
Paste the setup code instead — the QR is a shortcut, not the only way.

---

## Where things live

- **Your backend address** — `https://match-scorekeeper-api.something.workers.dev`
- **Your club id** — eight characters, shown by `node scripts/list-clubs.js --remote`
- **Your secret** — wherever you saved it at setup; not recoverable from the system
- **The project folder** — on the computer used for setup; needed for backups and
  rotating the secret
- **Your backups** — wherever you copied them, which should not be Cloudflare

Make sure more than one person at your club knows all five.
