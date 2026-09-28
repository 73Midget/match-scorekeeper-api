/**
 * A menu for running the maintenance scripts.
 *
 * Usage:
 *   npm run console
 *   node scripts/console.js
 *   node scripts/console.js --remote      (start pointed at the deployed database)
 *
 * This is a launcher, not a second implementation. Every action spawns the
 * script that already does the job, with the terminal attached, so each script's
 * own dry runs, warnings and typed confirmations still happen exactly as they
 * would if you had typed the command. The menu chooses the command; the script
 * still guards the action.
 *
 * WHY THIS IS SAFER THAN TYPING THE COMMANDS
 *
 * Arguments are passed as elements of an argv array, never through a shell. A
 * match key contains a pipe, and a pipe typed at a prompt is a shell pipeline
 * unless it is quoted correctly — so "delete this match" becomes an exercise in
 * quoting at the moment you least want one. Picking a match from a list removes
 * that entirely: the key travels as one argument and cannot be split.
 *
 * The same reasoning applies to club ids. Choosing "Riverside Gun Club" from a
 * numbered list is harder to get wrong than typing x3222665, and rotating the
 * wrong club's secret silently locks out a set of tablets that were working.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *  - It never performs a write itself. Reads, for the status screen and the
 *    pickers, happen here; every write goes through a script.
 *  - It never answers a confirmation prompt for you.
 *  - It holds no credentials. Authentication is whatever `wrangler login`
 *    already established, which is also why there is nothing to log in to here.
 *
 * The target database is in the header at all times. A menu that hides whether
 * it is pointed at local or deployed data would be worse than no menu, because
 * the whole value of it is acting quickly.
 */

import { createInterface } from "node:readline/promises";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runSql, sqlQuote } from "./lib/d1.js";

/** Wrangler's entry script, run directly rather than through npx. */
const WRANGLER = resolve("node_modules", "wrangler", "bin", "wrangler.js");

/** Where export-backup.js writes by default. */
const BACKUP_DIR = "backups";

/** Device id reserved for a match's compiled results. */
const COMPILED_DEVICE = "compiled";

/**
 * Which database actions apply to. Mutable: the operator toggles it.
 *
 * Starts local. Someone who opens this by accident should not already be
 * pointed at production.
 */
let remote = process.argv.includes("--remote");

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Ask one question and return the answer.
 *
 * A fresh readline interface per question, closed immediately, rather than one
 * held open for the session. That matters: an open interface keeps stdin in a
 * mode that interferes with a spawned script's own prompts, and those prompts
 * are the confirmations this menu must not swallow.
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Wait for the operator to read what just happened.
 *
 * @returns {Promise<void>}
 */
async function pause() {
  await ask("\n  Press Enter to return to the menu. ");
}

// ---------------------------------------------------------------------------
// Running the scripts
// ---------------------------------------------------------------------------

/**
 * Run one of the maintenance scripts with the terminal attached.
 *
 * stdio: "inherit" is the important part. The child writes straight to this
 * terminal and reads straight from it, so its confirmation prompts are real
 * prompts answered by the operator rather than something this menu could
 * satisfy on their behalf.
 *
 * The positional argument goes first, always. Two of the scripts find their
 * positional with a search for the first argument not starting with "--", which
 * would pick up a flag's value if a flag came first.
 *
 * @param {string}   script Filename within scripts/.
 * @param {string[]} args   Positional arguments first, then flags.
 * @returns {number|null} Exit status.
 */
function run(script, args = []) {
  const full = [resolve("scripts", script), ...args];

  if (remote) full.push("--remote");

  // Echo the equivalent command, quoted so that copying the line and running it
  // by hand actually works. An unquoted match key would be split at its pipe by
  // any shell — which is the failure this menu exists to avoid, so printing it
  // that way would be teaching the mistake.
  const shown = args
    .concat(remote ? ["--remote"] : [])
    .map((arg) => (/[\s|<>&^"'`(){}[\]$]/.test(arg) ? '"' + arg.replace(/"/g, '\\"') + '"' : arg))
    .join(" ");

  console.log("\n  > node scripts/" + script + " " + shown + "\n");

  const result = spawnSync(process.execPath, full, { stdio: "inherit" });
  return result.status;
}

// ---------------------------------------------------------------------------
// Reads used by the status screen and the pickers
// ---------------------------------------------------------------------------

/**
 * The Cloudflare account wrangler is signed in as.
 *
 * Shown in the header for the same reason the target is: knowing which account
 * you are about to delete something from matters, and nobody checks it by hand.
 *
 * @returns {string}
 */
function cloudflareAccount() {
  try {
    const out = execFileSync(process.execPath, [WRANGLER, "whoami"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Each dot must be followed by word characters, so the pattern stops at the
    // end of the address rather than swallowing the full stop of the sentence
    // wrangler prints it in.
    const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(out);
    return email ? email[0] : "signed in, email not reported";
  } catch {
    return "NOT SIGNED IN — run: npx wrangler login";
  }
}

/**
 * Clubs on the current target, for the pickers and the status screen.
 *
 * @returns {object[]}
 */
function fetchClubs() {
  return runSql(
    "SELECT club_id, display_name, active FROM clubs ORDER BY display_name;",
    remote
  );
}

/**
 * Matches for one club, newest first.
 *
 * @param {string} clubId
 * @returns {object[]}
 */
function fetchMatches(clubId) {
  return runSql(
    `SELECT match_key,
            MAX(match_label) AS match_label,
            MAX(match_type) AS match_type,
            MAX(uploaded_at) AS newest,
            COUNT(*) AS row_count,
            COUNT(DISTINCT CASE WHEN device_id <> ${sqlQuote(COMPILED_DEVICE)}
                                THEN device_id END) AS squad_count,
            MAX(CASE WHEN device_id = ${sqlQuote(COMPILED_DEVICE)}
                     THEN 1 ELSE 0 END) AS has_compiled
       FROM squad_uploads
      WHERE club_id = ${sqlQuote(clubId)}
      GROUP BY match_key
      ORDER BY newest DESC;`,
    remote
  );
}

/**
 * Row counts and outstanding work, for the status screen.
 *
 * The unmerged count uses the same newest-revision-per-device rule the
 * /squads/unmerged endpoint does, and excludes the compiled archive for the
 * same reason: an archive is never named in merged_squads, so it is never
 * marked, and counting it would make every compiled match look outstanding.
 *
 * @returns {object}
 */
function fetchTotals() {
  const rows = runSql(
    `SELECT
        (SELECT COUNT(*) FROM clubs) AS clubs,
        (SELECT COUNT(*) FROM squad_uploads) AS uploads,
        (SELECT COUNT(*) FROM rosters) AS rosters,
        (SELECT COUNT(*) FROM squad_uploads s
           JOIN (SELECT club_id, match_key, device_id, MAX(revision) AS mr
                   FROM squad_uploads GROUP BY club_id, match_key, device_id) l
             ON l.club_id = s.club_id AND l.match_key = s.match_key
            AND l.device_id = s.device_id AND l.mr = s.revision
          WHERE s.merged_into_roster_revision IS NULL
            AND s.device_id <> ${sqlQuote(COMPILED_DEVICE)}) AS unmerged_squads,
        (SELECT COUNT(DISTINCT s.club_id || char(0) || s.match_key)
           FROM squad_uploads s
           JOIN (SELECT club_id, match_key, device_id, MAX(revision) AS mr
                   FROM squad_uploads GROUP BY club_id, match_key, device_id) l
             ON l.club_id = s.club_id AND l.match_key = s.match_key
            AND l.device_id = s.device_id AND l.mr = s.revision
          WHERE s.merged_into_roster_revision IS NULL
            AND s.device_id <> ${sqlQuote(COMPILED_DEVICE)}) AS unmerged_matches;`,
    remote
  );

  return rows[0] ?? {};
}

/**
 * The newest backup file and its age.
 *
 * @returns {{name: string, days: number}|null}
 */
function newestBackup() {
  if (!existsSync(BACKUP_DIR)) return null;

  const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".sql"));
  if (files.length === 0) return null;

  let newest = null;
  for (const file of files) {
    const mtime = statSync(BACKUP_DIR + "/" + file).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { name: file, mtime };
  }

  return {
    name: newest.name,
    days: Math.floor((Date.now() - newest.mtime) / 86400000),
  };
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/**
 * Let the operator choose a club from a numbered list.
 *
 * @param {string}  purpose  Shown above the list, e.g. "Rotate the secret for".
 * @param {boolean} optional Offer "all clubs" as a choice.
 * @returns {Promise<string|null|undefined>} Club id, null for all, undefined to cancel.
 */
async function pickClub(purpose, optional = false) {
  let clubs;
  try {
    clubs = fetchClubs();
  } catch (err) {
    console.error("\n  Could not read the clubs: " + err.message + "\n");
    return undefined;
  }

  if (clubs.length === 0) {
    console.log("\n  No clubs on the " + where() + " database.\n");
    return undefined;
  }

  console.log("\n  " + purpose + ":\n");

  clubs.forEach((club, i) => {
    const status = club.active === 1 ? "" : "   [INACTIVE]";
    console.log("   " + String(i + 1).padStart(2) + "  " + club.club_id + "  " + club.display_name + status);
  });

  if (optional) console.log("    a  All clubs");
  console.log("    c  Cancel");

  const answer = await ask("\n  Choose: ");

  if (answer === "c" || answer === "") return undefined;
  if (optional && answer === "a") return null;

  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > clubs.length) {
    console.log("\n  Not a choice on the list.\n");
    return undefined;
  }

  return clubs[index - 1].club_id;
}

/**
 * Let the operator choose a match from a numbered list.
 *
 * This is the reason the menu is worth having. A match key contains a pipe and
 * slashes, so typing one at a prompt means getting the quoting right; chosen
 * from a list it travels as one argv element and cannot be mangled.
 *
 * @param {string} clubId
 * @returns {Promise<string|undefined>} Match key, or undefined to cancel.
 */
async function pickMatch(clubId) {
  let matches;
  try {
    matches = fetchMatches(clubId);
  } catch (err) {
    console.error("\n  Could not read the matches: " + err.message + "\n");
    return undefined;
  }

  if (matches.length === 0) {
    console.log("\n  No uploads for that club.\n");
    return undefined;
  }

  console.log("\n  Matches, newest first:\n");

  matches.forEach((match, i) => {
    const when = Number.isFinite(Number(match.newest))
      ? new Date(Number(match.newest)).toLocaleDateString()
      : "unknown";

    console.log(
      "   " + String(i + 1).padStart(2) + "  " +
        when.padEnd(12) +
        '"' + (match.match_label || "(no match name)") + '"'
    );
    console.log(
      "       " + match.match_key + "  —  " + match.squad_count + " squad(s), " +
        match.row_count + " row(s)" +
        (match.has_compiled ? ", results archived" : ", NO results archived")
    );
  });

  console.log("    c  Cancel");

  const answer = await ask("\n  Choose: ");
  if (answer === "c" || answer === "") return undefined;

  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > matches.length) {
    console.log("\n  Not a choice on the list.\n");
    return undefined;
  }

  return matches[index - 1].match_key;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/** @returns {string} */
function where() {
  return remote ? "remote (deployed)" : "local (development)";
}

/**
 * One screen answering "is anything wrong?".
 *
 * Every figure here is something nobody checks by hand. An emptied table, a
 * backup that silently stopped happening, a pile of uploads no compile ever
 * absorbed — all invisible until the moment they matter.
 *
 * @returns {Promise<void>}
 */
async function showStatus() {
  console.log("\n  Status — " + where() + " database\n");

  let totals;
  try {
    totals = fetchTotals();
  } catch (err) {
    console.error("  Could not read the database:\n  " + err.message + "\n");
    await pause();
    return;
  }

  console.log("    Clubs               " + totals.clubs);
  console.log("    Squad uploads       " + totals.uploads);
  console.log("    Roster revisions    " + totals.rosters);
  console.log(
    "    Outstanding         " + totals.unmerged_squads + " squad(s) across " +
      totals.unmerged_matches + " match(es)"
  );

  // Zero uploads against a non-zero club count is worth saying out loud rather
  // than leaving as a number to notice. It is either a brand-new backend or
  // something went very wrong.
  if (Number(totals.clubs) > 0 && Number(totals.uploads) === 0) {
    console.log("\n    No squad uploads at all. Expected for a new backend; alarming otherwise.");
  }

  const backup = newestBackup();
  if (!backup) {
    console.log("\n    Backups             none found in " + BACKUP_DIR + "/");
  } else {
    const age = backup.days === 0 ? "today" : backup.days + " day(s) ago";
    console.log("\n    Newest backup       " + backup.name + ", " + age);
    if (backup.days > 35) {
      console.log("                        older than a month — worth running one");
    }
  }

  console.log("");
  await pause();
}

/**
 * Switch between the local and deployed databases.
 *
 * Switching to the deployed database says so plainly. Switching back does not
 * need to: the risk is asymmetric.
 *
 * @returns {Promise<void>}
 */
async function toggleTarget() {
  if (!remote) {
    console.log("\n  Switching to the REMOTE (deployed) database.");
    console.log("  Actions from here affect real club data.\n");

    const answer = await ask("  Type remote to confirm: ");
    if (answer !== "remote") {
      console.log("\n  Staying on local.\n");
      await pause();
      return;
    }
  }

  remote = !remote;
  console.log("\n  Now pointed at the " + where() + " database.\n");
  await pause();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Create a club, prompting for its name and optionally a setup-code URL.
 *
 * @returns {Promise<void>}
 */
async function createClub() {
  const name = await ask("\n  Club name (blank to cancel): ");
  if (name === "") return;

  console.log("\n  A setup code bundles the URL, club id and secret into one");
  console.log("  string for a tablet to paste. It contains the secret, so it is");
  console.log("  itself a credential — leave the URL blank to skip it.");

  const url = await ask("\n  API URL (blank to skip the setup code): ");

  const args = [name];
  if (url !== "") args.push("--url", url);

  if (url !== "") {
    const qr = await ask("  Also show a scannable QR code? [y/N]: ");
    if (qr.toLowerCase() === "y") args.push("--qr");
  }

  console.log("\n  The secret prints once and cannot be recovered. Do not run this");
  console.log("  while screen-sharing.");

  run("create-club.js", args);
  await pause();
}

/**
 * Rotate a club's secret.
 *
 * @returns {Promise<void>}
 */
async function rotateSecret() {
  const clubId = await pickClub("Rotate the secret for");
  if (clubId === undefined) return;

  console.log("\n  Every tablet configured for this club stops working until it is");
  console.log("  given the new code. Do this before a match, never during one.");

  const url = await ask("\n  API URL (blank to skip the setup code): ");

  const args = [clubId];
  if (url !== "") args.push("--url", url);

  if (url !== "") {
    const qr = await ask("  Also show a scannable QR code? [y/N]: ");
    if (qr.toLowerCase() === "y") args.push("--qr");
  }

  run("rotate-secret.js", args);
  await pause();
}

/**
 * Suspend a club, or bring a suspended one back.
 *
 * Both directions go through the same script, which reports the club's current
 * state — so choosing "resume" for a club that is already active says so rather
 * than pretending to do something.
 *
 * @param {boolean} resume
 * @returns {Promise<void>}
 */
async function suspendClub(resume) {
  const clubId = await pickClub(
    resume ? "Resume which club" : "Suspend which club"
  );
  if (clubId === undefined) return;

  if (!resume) {
    console.log("\n  Every tablet for this club stops working immediately, and");
    console.log("  nothing is deleted. The credential is untouched, so resuming");
    console.log("  needs no new setup codes.");
  }

  const args = [clubId];
  if (resume) args.push("--resume");

  run("suspend-club.js", args);
  await pause();
}

/**
 * List uploads no compile absorbed.
 *
 * @returns {Promise<void>}
 */
async function listUnmerged() {
  const clubId = await pickClub("Show outstanding uploads for", true);
  if (clubId === undefined) return;

  const days = await ask("\n  Only uploads at least N days old (blank for all): ");

  const args = [];
  if (clubId !== null) args.push(clubId);
  if (days !== "") args.push("--older-than", days);

  run("list-unmerged.js", args);
  await pause();
}

/**
 * Prune superseded squad revisions.
 *
 * @param {boolean} confirm Actually delete rather than report.
 * @returns {Promise<void>}
 */
async function pruneSquads(confirm) {
  const clubId = await pickClub(
    confirm ? "Prune superseded revisions for" : "Show what would be pruned for",
    true
  );
  if (clubId === undefined) return;

  const days = await ask("\n  Older than how many days? [90]: ");

  const args = [];
  if (clubId !== null) args.push(clubId);
  if (days !== "") args.push("--older-than", days);
  if (confirm) args.push("--confirm");

  run("prune-squads.js", args);
  await pause();
}

/**
 * Delete one match entirely.
 *
 * @returns {Promise<void>}
 */
async function deleteMatch() {
  const clubId = await pickClub("Delete a match from");
  if (clubId === undefined) return;

  const matchKey = await pickMatch(clubId);
  if (matchKey === undefined) return;

  console.log("\n  This removes the match entirely, compiled results included.");
  console.log("  The script will show what it found and ask for the match key back.");

  run("delete-match.js", [matchKey, "--club", clubId]);
  await pause();
}

/**
 * Delete every match before a date.
 *
 * @returns {Promise<void>}
 */
async function pruneMatches() {
  const clubId = await pickClub("Prune old matches from", true);
  if (clubId === undefined) return;

  console.log("\n  There is no default date. How far back to keep results is a");
  console.log("  judgement only the club can make.");

  const date = await ask("\n  Delete matches before (YYYY-MM-DD, blank to cancel): ");
  if (date === "") return;

  const confirm = await ask("  Actually delete, rather than show a dry run? [y/N]: ");

  const args = [];
  if (clubId !== null) args.push(clubId);
  args.push("--before", date);
  if (confirm.toLowerCase() === "y") args.push("--confirm");

  run("prune-matches.js", args);
  await pause();
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/**
 * Menu entries, in display order.
 *
 * A table rather than a switch, so the numbering cannot drift out of step with
 * what each number does. `destructive` marks the entries the header warns about
 * when pointed at the deployed database.
 */
const MENU = [
  { key: "1", group: "STATUS", label: "Status overview", action: showStatus },

  { key: "2", group: "READ", label: "List clubs", action: async () => { run("list-clubs.js"); await pause(); } },
  { key: "3", group: "READ", label: "Uploads no compile absorbed", action: listUnmerged },

  { key: "4", group: "CLUBS", label: "Create a club", action: createClub },
  { key: "5", group: "CLUBS", label: "Suspend a club", action: () => suspendClub(false), destructive: true },
  { key: "6", group: "CLUBS", label: "Resume a suspended club", action: () => suspendClub(true), destructive: true },
  { key: "7", group: "CLUBS", label: "Rotate a club's secret", action: rotateSecret, destructive: true },

  { key: "8", group: "BACKUP", label: "Export a backup", action: async () => { run("export-backup.js", ["--out", BACKUP_DIR]); await pause(); } },

  { key: "9", group: "CLEANUP", label: "Prune superseded revisions — dry run", action: () => pruneSquads(false) },
  { key: "10", group: "CLEANUP", label: "Prune superseded revisions — delete", action: () => pruneSquads(true), destructive: true },
  { key: "11", group: "CLEANUP", label: "Delete one match", action: deleteMatch, destructive: true },
  { key: "12", group: "CLEANUP", label: "Prune matches before a date", action: pruneMatches, destructive: true },
];

/**
 * Draw the menu.
 *
 * @param {string} account
 * @returns {void}
 */
function drawMenu(account) {
  console.log("\n" + "=".repeat(64));
  console.log("  Match Scorekeeper — backend console");
  console.log("  Account:  " + account);
  console.log(
    "  Target:   " + (remote ? "REMOTE (deployed) — real club data" : "local (development)")
  );
  console.log("=".repeat(64));

  let group = null;
  for (const entry of MENU) {
    if (entry.group !== group) {
      group = entry.group;
      console.log("\n  " + group);
    }

    console.log(
      "   " + entry.key.padStart(2) + "  " + entry.label +
        (entry.destructive && remote ? "   *" : "")
    );
  }

  if (remote && MENU.some((e) => e.destructive)) {
    console.log("\n   * changes real data");
  }

  console.log("\n    t  Switch to " + (remote ? "local" : "REMOTE"));
  console.log("    q  Quit\n");
}

async function main() {
  const account = cloudflareAccount();

  if (account.startsWith("NOT SIGNED IN")) {
    console.error("\n  " + account);
    console.error("\n  Every action here talks to Cloudflare, so there is nothing this");
    console.error("  menu can do until wrangler is signed in.\n");
    process.exit(1);
  }

  for (;;) {
    drawMenu(account);

    const choice = (await ask("  Choose: ")).toLowerCase();

    if (choice === "q" || choice === "") {
      console.log("");
      return;
    }

    if (choice === "t") {
      await toggleTarget();
      continue;
    }

    const entry = MENU.find((e) => e.key === choice);
    if (!entry) {
      console.log("\n  Not a choice on the menu.\n");
      continue;
    }

    try {
      await entry.action();
    } catch (err) {
      // A failed action returns to the menu rather than ending the session.
      // Half a maintenance job done and the tool gone is worse than an error
      // you can read and retry.
      console.error("\n  That did not work:\n  " + err.message + "\n");
      await pause();
    }
  }
}

await main();
