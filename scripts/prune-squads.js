/**
 * Delete raw squad uploads from matches that were compiled long enough ago.
 *
 * Usage:
 *   node scripts/prune-squads.js --remote                    (dry run, 90 days)
 *   node scripts/prune-squads.js --remote --older-than 180   (dry run)
 *   node scripts/prune-squads.js --remote --confirm          (actually delete)
 *   node scripts/prune-squads.js --remote x3222665 --confirm (one club)
 *
 * Why this exists: an RO uploads after every shooter, so a 30-shooter squad
 * generates roughly 30 revisions in one match and a five-squad match generates
 * 150. Storage is not the problem — that is a rounding error against D1's
 * allowance. The problem is that every one of those payloads holds every
 * shooter's name, email and phone, and they accumulate in the monthly backup
 * file forever.
 *
 * A squad's newest revision holds the whole squad; the 29 before it are
 * prefixes of it. So dropping the intermediates loses nothing a club needs
 * while removing almost all of the stored personal data.
 *
 * WHAT IT WILL NOT TOUCH
 *
 *   - The compiled archive of any match. That is the record of what happened.
 *
 *   - The newest revision any device uploaded. The app reads a squad back by
 *     device, so deleting a device's last revision would leave a match that
 *     still appears in the match list but cannot be opened. Keeping it costs
 *     one row per squad and no privacy: that squad's shooters are already in
 *     the roster and the compiled archive, both kept indefinitely.
 *
 *   - Every revision of a squad no roster push ever absorbed. Until a compile
 *     folds a squad in, a shooter added at check-in on that tablet may exist
 *     in those payloads and nowhere else. Use delete-match.js if you have
 *     looked at one and decided it is junk.
 *
 * READ THIS BEFORE CHANGING THE QUERIES
 *
 * merged_into_roster_revision is set on ONE revision per device: the revision
 * the compile actually absorbed. It does not mean "this match was compiled" —
 * it means "this exact row is the one the roster took".
 *
 * The first version of this script tested that column per row, which selected
 * precisely the newest revision of each device and nothing else. It therefore
 * deleted the only revision the app can still read and kept all 29 redundant
 * ones — the exact inverse of the intent, and it reported success doing it.
 *
 * So the absorbed check is per DEVICE (does any revision of this device's
 * squad carry the mark?) and the age and newest-revision checks are per row.
 * Getting that distinction wrong is silent in both directions.
 *
 * Dry run unless --confirm. Deleting is not reversible and D1's free plan has
 * no point-in-time recovery, so the default is to show and stop.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { runSql, sqlQuote } from "./lib/d1.js";
import { positional, flagValue } from "./lib/args.js";

/** Device id reserved for a match's compiled results. */
const COMPILED_DEVICE = "compiled";

/** Default age threshold, in days. */
const DEFAULT_DAYS = 90;

/** Where export-backup.js writes by default. */
const BACKUP_DIR = "backups";

/**
 * SQL: has any revision of this row's squad been absorbed by a roster push?
 *
 * Correlated on club, match and device — deliberately NOT on revision. See the
 * note at the top of this file: the mark lands on one revision per device, so
 * testing it per row inverts the intent of the whole script.
 *
 * Defined once and used by both the eligibility query and the delete, because
 * the two disagreeing is a bug that shows up as "the dry run lied".
 */
const SQUAD_WAS_ABSORBED = `EXISTS (
        SELECT 1 FROM squad_uploads m
         WHERE m.club_id = squad_uploads.club_id
           AND m.match_key = squad_uploads.match_key
           AND m.device_id = squad_uploads.device_id
           AND m.merged_into_roster_revision IS NOT NULL
      )`;

/**
 * SQL: is this row below its device's newest revision at this match?
 *
 * Safe to self-reference the table a DELETE is removing from, because the MAX
 * row is never itself a delete candidate — so the maximum cannot shift while
 * the statement runs.
 */
const NOT_NEWEST_REVISION = `revision < (
        SELECT MAX(revision) FROM squad_uploads n
         WHERE n.club_id = squad_uploads.club_id
           AND n.match_key = squad_uploads.match_key
           AND n.device_id = squad_uploads.device_id
      )`;

/**
 * Warn if no backup has been taken recently.
 *
 * Not a gate — a club may store backups elsewhere entirely, and refusing to
 * run because this script cannot find a file would be wrong. But the moment
 * before a delete is exactly when "when did we last back up?" is worth asking,
 * and nobody asks it unprompted.
 *
 * @returns {string|null} A warning, or null if a recent backup exists.
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
 * Rows eligible for deletion, with enough context to report them per match.
 *
 * The three safety rules are expressed in SQL rather than in code that could
 * take a different branch: never the compiled archive, never a device's newest
 * revision, and nothing belonging to a squad no roster push ever absorbed.
 *
 * @param {string|null} clubId
 * @param {number}      cutoff Epoch ms; revisions older than this are eligible.
 * @param {boolean}     remote
 * @returns {object[]}
 */
function fetchEligible(clubId, cutoff, remote) {
  const clubFilter = clubId ? ` AND club_id = ${sqlQuote(clubId)}` : "";

  return runSql(
    `SELECT club_id, match_key, match_label, match_type,
            COUNT(*) AS row_count,
            MIN(uploaded_at) AS oldest,
            MAX(uploaded_at) AS newest,
            COUNT(DISTINCT device_id) AS device_count,

            -- Reported so a match losing its intermediate revisions while
            -- having no compiled archive is visible. That is legal — a roster
            -- push absorbed the squads, the archive upload failed or was never
            -- made — but it means all that will remain is the newest upload
            -- per squad, with no compiled results beside it.
            EXISTS (
              SELECT 1 FROM squad_uploads c
               WHERE c.club_id = squad_uploads.club_id
                 AND c.match_key = squad_uploads.match_key
                 AND c.device_id = ${sqlQuote(COMPILED_DEVICE)}
            ) AS has_compiled

       FROM squad_uploads
      WHERE device_id <> ${sqlQuote(COMPILED_DEVICE)}
        AND uploaded_at < ${cutoff}${clubFilter}
        AND ${NOT_NEWEST_REVISION}
        AND ${SQUAD_WAS_ABSORBED}
      GROUP BY club_id, match_key
      ORDER BY newest DESC;`,
    remote
  );
}

/**
 * Uploads old enough to prune but belonging to squads nothing ever absorbed.
 *
 * Reported rather than silently skipped: "3 matches were left alone because
 * nothing ever compiled them" is a prompt to go and look, and the whole reason
 * list-unmerged.js exists.
 *
 * Note the NOT: this is the exact complement of the absorbed check used above,
 * so a squad appears in one list or the other and never in both. Written as the
 * negation of the same fragment rather than as its own condition, because two
 * hand-written opposites drift and a squad could end up in neither.
 *
 * @param {string|null} clubId
 * @param {number}      cutoff
 * @param {boolean}     remote
 * @returns {object[]}
 */
function fetchSpared(clubId, cutoff, remote) {
  const clubFilter = clubId ? ` AND club_id = ${sqlQuote(clubId)}` : "";

  return runSql(
    `SELECT club_id, match_key, match_label, COUNT(*) AS row_count,
            COUNT(DISTINCT device_id) AS device_count
       FROM squad_uploads
      WHERE device_id <> ${sqlQuote(COMPILED_DEVICE)}
        AND uploaded_at < ${cutoff}${clubFilter}
        AND NOT ${SQUAD_WAS_ABSORBED}
      GROUP BY club_id, match_key
      ORDER BY MAX(uploaded_at) DESC;`,
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

async function main() {
  const args = process.argv.slice(2);
  const remote = args.includes("--remote");
  const doIt = args.includes("--confirm");
  const clubId = positional(args, ["--older-than"]);

  let days = DEFAULT_DAYS;
  if (args.includes("--older-than")) {
    days = Number(flagValue(args, "--older-than"));
    if (!Number.isInteger(days) || days < 1) {
      console.error("--older-than needs a whole number of days, at least 1.");
      process.exit(1);
    }
  }

  const cutoff = Date.now() - days * 86400000;
  const where = remote ? "remote (deployed)" : "local (development)";

  const eligible = fetchEligible(clubId, cutoff, remote);
  const spared = fetchSpared(clubId, cutoff, remote);

  const totalRows = eligible.reduce((sum, m) => sum + Number(m.row_count), 0);

  console.log("\n  Pruning superseded squad revisions — " + where + " database");
  console.log("  Uploaded before " + formatDate(cutoff) + " (" + days + " days ago)");
  if (clubId) console.log("  Club: " + clubId);
  console.log("");

  if (eligible.length === 0) {
    console.log("  Nothing to prune.\n");
  } else {
    console.log(
      "  " + eligible.length + " match(es), " + totalRows + " superseded revision(s) would be deleted:\n"
    );

    for (const match of eligible) {
      const archive = match.has_compiled
        ? "compiled archive kept, newest upload per squad kept"
        : "NO COMPILED ARCHIVE — only the newest upload per squad will remain";

      console.log("    " + match.match_key);
      console.log(
        '      "' + (match.match_label || "(no match name)") + '"' +
          (clubId ? "" : "  club " + match.club_id)
      );
      console.log(
        "      " + match.row_count + " revision(s) from " + match.device_count +
          " squad(s), " + formatDate(match.oldest) + " to " + formatDate(match.newest)
      );
      console.log("      " + archive);
      console.log("");
    }
  }

  if (spared.length > 0) {
    const sparedRows = spared.reduce((sum, m) => sum + Number(m.row_count), 0);

    console.log(
      "  LEFT ALONE: " + spared.length + " match(es), " + sparedRows +
        " upload(s) old enough but belonging to squads no roster push absorbed:\n"
    );

    for (const match of spared) {
      console.log(
        "    " + match.match_key + '  "' + (match.match_label || "(no match name)") +
          '"  ' + match.row_count + " upload(s) across " + match.device_count + " squad(s)"
      );
    }

    console.log("");
    console.log("  These may hold the only copy of a shooter added at check-in.");
    console.log("  Look at one with list-unmerged.js and the app before deciding.\n");
  }

  if (eligible.length === 0) return;

  if (!doIt) {
    console.log("  Dry run — nothing was deleted. Add --confirm to delete.\n");
    return;
  }

  const warning = backupWarning();
  if (warning) {
    console.log("  BACKUP: " + warning);
    console.log("  Run npm run backup first if this database is not backed up elsewhere.\n");
  }

  console.log("  This cannot be undone, and there is no point-in-time recovery.\n");

  if (!(await confirm("DELETE"))) {
    console.log("\n  Not confirmed. Nothing was deleted.\n");
    process.exit(1);
  }

  const clubFilter = clubId ? ` AND club_id = ${sqlQuote(clubId)}` : "";

  // Word for word the same conditions fetchEligible used, via the same two
  // constants. If these two ever diverge the dry run describes one set of rows
  // and the delete removes another, which is the worst failure this script
  // could have: it would be reported as a success.
  runSql(
    `DELETE FROM squad_uploads
      WHERE device_id <> ${sqlQuote(COMPILED_DEVICE)}
        AND uploaded_at < ${cutoff}${clubFilter}
        AND ${NOT_NEWEST_REVISION}
        AND ${SQUAD_WAS_ABSORBED};`,
    remote
  );

  // Verify by re-reading rather than trusting a reported row count. The local
  // emulator returns meta without a `changes` field while the deployed
  // database includes one, so a count taken from the statement's metadata
  // reads zero locally even on success — and "0 deleted" after a successful
  // delete is exactly the kind of false alarm that prompts someone to run it
  // again.
  const remaining = fetchEligible(clubId, cutoff, remote);
  const remainingRows = remaining.reduce((sum, m) => sum + Number(m.row_count), 0);

  console.log("\n  Deleted " + (totalRows - remainingRows) + " of " + totalRows + " revision(s).");

  if (remainingRows > 0) {
    console.error("  WARNING: " + remainingRows + " still match the criteria. Run again to check.");
  }

  console.log("");
}

await main();
