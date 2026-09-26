/**
 * Delete every trace of matches before a date — archives included.
 *
 * Usage:
 *   node scripts/prune-matches.js --remote --before 2024-01-01
 *   node scripts/prune-matches.js --remote --before 2024-01-01 --confirm
 *   node scripts/prune-matches.js --remote --before 2024-01-01 x3222665 --confirm
 *
 * This is the deepest cleanup here. prune-squads.js drops the raw uploads and
 * keeps each match's compiled archive, so a club keeps a record of every match
 * it ever ran. This drops the archives too.
 *
 * After it runs there is no record on the server that those matches happened.
 * The club shooter list is untouched — it lives in the rosters table and is
 * never pruned — so nobody is lost, but the results are gone.
 *
 * That is the point: a club that keeps results for five years is keeping five
 * years of members' names, emails and phone numbers in every backup file, and
 * at some point the oldest of those stop being worth the exposure. Where that
 * line sits is a judgement only the club can make, which is why there is no
 * default date and the flag is required.
 *
 * Dry run unless --confirm. Take a backup first; this is the one cleanup whose
 * result cannot be reconstructed from anything else on the server.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { runSql, sqlQuote } from "./lib/d1.js";

/** Device id reserved for a match's compiled results. */
const COMPILED_DEVICE = "compiled";

/** Where export-backup.js writes by default. */
const BACKUP_DIR = "backups";

/**
 * Parse a YYYY-MM-DD date into epoch milliseconds at local midnight.
 *
 * Local rather than UTC: a club asking to drop everything before 2024 means
 * their new year, not one that starts at 7pm on New Year's Eve.
 *
 * @param {string} text
 * @returns {number|null} Epoch ms, or null if unparseable.
 */
function parseDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ""));
  if (!match) return null;

  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day);

  // Round-trip check: new Date(2024, 12, 40) silently rolls over rather than
  // failing, so a typo like 2024-13-01 would otherwise be accepted as 2025.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date.getTime();
}

/**
 * Render epoch milliseconds as a local date.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "unknown";

  return new Date(n).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Warn if no backup has been taken recently.
 *
 * @returns {string|null}
 */
function backupWarning() {
  if (!existsSync(BACKUP_DIR)) {
    return "No " + BACKUP_DIR + "/ directory found — has this database ever been backed up?";
  }

  const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".sql"));
  if (files.length === 0) {
    return "No backup files in " + BACKUP_DIR + "/.";
  }

  const newest = Math.max(
    ...files.map((f) => statSync(BACKUP_DIR + "/" + f).mtimeMs)
  );
  const days = Math.floor((Date.now() - newest) / 86400000);

  return days > 35
    ? "Newest backup in " + BACKUP_DIR + "/ is " + days + " days old."
    : null;
}

/**
 * Matches whose every upload predates the cutoff.
 *
 * The HAVING clause is the important part. Filtering rows by date would delete
 * the old uploads of a match that also has recent ones — a match re-compiled
 * last week after a correction, say — leaving it half present. A match is
 * pruned only when nothing in it is newer than the cutoff.
 *
 * @param {string|null} clubId
 * @param {number}      cutoff
 * @param {boolean}     remote
 * @returns {object[]}
 */
function fetchMatches(clubId, cutoff, remote) {
  const clubFilter = clubId ? ` WHERE club_id = ${sqlQuote(clubId)}` : "";

  return runSql(
    `SELECT club_id, match_key,
            MAX(match_label) AS match_label,
            MAX(match_type) AS match_type,
            COUNT(*) AS row_count,
            MAX(uploaded_at) AS newest,
            COUNT(DISTINCT CASE WHEN device_id <> ${sqlQuote(COMPILED_DEVICE)}
                                THEN device_id END) AS device_count,
            MAX(CASE WHEN device_id = ${sqlQuote(COMPILED_DEVICE)}
                     THEN 1 ELSE 0 END) AS has_compiled
       FROM squad_uploads${clubFilter}
      GROUP BY club_id, match_key
     HAVING MAX(uploaded_at) < ${cutoff}
      ORDER BY newest DESC;`,
    remote
  );
}

/**
 * Ask the operator to type a word back.
 *
 * @param {string} expected
 * @returns {Promise<boolean>}
 */
async function confirm(expected) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question(`  Type ${expected} to proceed: `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

/**
 * Read the positional club id, skipping values that belong to flags.
 *
 * @param {string[]} args
 * @returns {string|null}
 */
function positionalClubId(args) {
  const takesValue = new Set(["--before"]);

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (takesValue.has(args[i])) i++;
      continue;
    }
    return args[i];
  }

  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const remote = args.includes("--remote");
  const doIt = args.includes("--confirm");
  const clubId = positionalClubId(args);

  const beforeIndex = args.indexOf("--before");
  if (beforeIndex === -1) {
    console.error("Usage: node scripts/prune-matches.js [--remote] --before YYYY-MM-DD [club-id] [--confirm]");
    console.error("");
    console.error("There is no default date. How far back a club keeps its results");
    console.error("is a judgement only the club can make.");
    process.exit(1);
  }

  const cutoff = parseDate(args[beforeIndex + 1]);
  if (cutoff === null) {
    console.error("--before needs a real date as YYYY-MM-DD, for example 2024-01-01.");
    process.exit(1);
  }

  if (cutoff > Date.now()) {
    console.error("\n  That date is in the future — it would delete every match.");
    console.error("  Pass a past date.\n");
    process.exit(1);
  }

  const matches = fetchMatches(clubId, cutoff, remote);
  const where = remote ? "remote (deployed)" : "local (development)";

  console.log("\n  Deleting matches entirely — " + where + " database");
  console.log("  Everything before " + formatDate(cutoff));
  if (clubId) console.log("  Club: " + clubId);
  console.log("");

  if (matches.length === 0) {
    console.log("  No matches that old.\n");
    return;
  }

  const totalRows = matches.reduce((sum, m) => sum + Number(m.row_count), 0);
  const withArchive = matches.filter((m) => m.has_compiled).length;

  console.log(
    "  " + matches.length + " match(es), " + totalRows + " row(s), " +
      withArchive + " compiled archive(s):\n"
  );

  for (const match of matches) {
    console.log(
      "    " + formatDate(match.newest).padEnd(14) +
        '"' + (match.match_label || "(no match name)") + '"' +
        (clubId ? "" : "  club " + match.club_id)
    );
    console.log(
      "      " + match.match_key + "  —  " + match.row_count + " row(s), " +
        match.device_count + " squad(s)" +
        (match.has_compiled ? ", results archived" : ", NO results archived")
    );
  }

  console.log("");
  console.log("  The club shooter list is not touched — it lives separately and is");
  console.log("  never pruned. Nobody is lost. The results of these matches are.");
  console.log("");

  if (!doIt) {
    console.log("  Dry run — nothing was deleted. Add --confirm to delete.\n");
    return;
  }

  const warning = backupWarning();
  if (warning) {
    console.log("  BACKUP: " + warning);
    console.log("  This is the one cleanup whose result cannot be rebuilt from");
    console.log("  anything else on the server. Run npm run backup first.\n");
  }

  console.log("  This cannot be undone, and there is no point-in-time recovery.\n");

  if (!(await confirm("DELETE"))) {
    console.log("\n  Not confirmed. Nothing was deleted.\n");
    process.exit(1);
  }

  const clubFilter = clubId ? ` AND club_id = ${sqlQuote(clubId)}` : "";

  // Deleted by match key rather than by row date, so the HAVING clause above
  // stays the only definition of what is old enough. A date filter here could
  // disagree with it and strip the recent rows out of a match the listing said
  // it would leave alone.
  const keys = matches.map((m) => sqlQuote(m.match_key)).join(", ");

  runSql(
    `DELETE FROM squad_uploads
      WHERE match_key IN (${keys})${clubFilter};`,
    remote
  );

  // Verify by re-reading. The local emulator returns statement metadata
  // without a `changes` field while the deployed database includes one, so a
  // count taken from the delete reads zero locally even on success.
  const remaining = fetchMatches(clubId, cutoff, remote);
  const remainingRows = remaining.reduce((sum, m) => sum + Number(m.row_count), 0);

  console.log(
    "\n  Deleted " + (totalRows - remainingRows) + " of " + totalRows + " row(s) across " +
      (matches.length - remaining.length) + " match(es)."
  );

  if (remainingRows > 0) {
    console.error("  WARNING: " + remaining.length + " match(es) remain. Run again to check.");
  }

  console.log("");
}

await main();
