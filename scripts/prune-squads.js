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
 * The compiled archive holds the same people and the same scores in one
 * payload rather than 150, so pruning the raw squads loses nothing a club
 * needs while removing almost all of the personal data.
 *
 * WHAT IT WILL NOT TOUCH
 *
 *   - The compiled archive of any match. That is the record of what happened.
 *   - Any upload no roster push absorbed. Until a compile folds a squad in,
 *     a shooter added at check-in on that tablet exists in that payload and
 *     nowhere else. Deleting it would destroy the only copy of their details.
 *     Use delete-match.js if you have looked at one and decided it is junk.
 *
 * Dry run unless --confirm. Deleting is not reversible and D1's free plan has
 * no point-in-time recovery, so the default is to show and stop.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { runSql, sqlQuote } from "./lib/d1.js";

/** Device id reserved for a match's compiled results. */
const COMPILED_DEVICE = "compiled";

/** Default age threshold, in days. */
const DEFAULT_DAYS = 90;

/** Where export-backup.js writes by default. */
const BACKUP_DIR = "backups";

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
 * The two exclusions are the safety rules, expressed in SQL rather than in
 * code that could take a different branch: nothing that a roster never
 * absorbed, and never the compiled archive.
 *
 * @param {string|null} clubId
 * @param {number}      cutoff Epoch ms; uploads older than this are eligible.
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

            -- Reported so a match about to lose its raw squads while having no
            -- compiled archive is visible. That is legal — a roster push
            -- absorbed the squads, the archive upload failed or was never
            -- made — but it means pruning leaves no record of the match at
            -- all, which someone should see before confirming.
            EXISTS (
              SELECT 1 FROM squad_uploads c
               WHERE c.club_id = squad_uploads.club_id
                 AND c.match_key = squad_uploads.match_key
                 AND c.device_id = ${sqlQuote(COMPILED_DEVICE)}
            ) AS has_compiled

       FROM squad_uploads
      WHERE device_id <> ${sqlQuote(COMPILED_DEVICE)}
        AND merged_into_roster_revision IS NOT NULL
        AND uploaded_at < ${cutoff}${clubFilter}
      GROUP BY club_id, match_key
      ORDER BY newest DESC;`,
    remote
  );
}

/**
 * Count uploads the age filter would have caught but the safety rules spared.
 *
 * Reported rather than silently skipped: "3 matches were left alone because
 * nothing ever compiled them" is a prompt to go and look, and the whole reason
 * list-unmerged.js exists.
 *
 * @param {string|null} clubId
 * @param {number}      cutoff
 * @param {boolean}     remote
 * @returns {object[]}
 */
function fetchSpared(clubId, cutoff, remote) {
  const clubFilter = clubId ? ` AND club_id = ${sqlQuote(clubId)}` : "";

  return runSql(
    `SELECT club_id, match_key, match_label, COUNT(*) AS row_count
       FROM squad_uploads
      WHERE device_id <> ${sqlQuote(COMPILED_DEVICE)}
        AND merged_into_roster_revision IS NULL
        AND uploaded_at < ${cutoff}${clubFilter}
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

/**
 * Read the positional club id, skipping values that belong to flags.
 *
 * A flag's value does not start with "--", so a naive search picks up the 180
 * in "--older-than 180" and treats it as a club id. Here that would quietly
 * scope a delete to a club that does not exist and report nothing to do.
 *
 * @param {string[]} args
 * @returns {string|null}
 */
function positionalClubId(args) {
  const takesValue = new Set(["--older-than"]);

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

  let days = DEFAULT_DAYS;
  const olderIndex = args.indexOf("--older-than");
  if (olderIndex !== -1) {
    days = Number(args[olderIndex + 1]);
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

  console.log("\n  Pruning raw squad uploads — " + where + " database");
  console.log("  Compiled before " + formatDate(cutoff) + " (" + days + " days ago)");
  if (clubId) console.log("  Club: " + clubId);
  console.log("");

  if (eligible.length === 0) {
    console.log("  Nothing to prune.\n");
  } else {
    console.log(
      "  " + eligible.length + " match(es), " + totalRows + " upload(s) would be deleted:\n"
    );

    for (const match of eligible) {
      const archive = match.has_compiled
        ? "compiled archive kept"
        : "NO COMPILED ARCHIVE — nothing will remain of this match";

      console.log("    " + match.match_key);
      console.log(
        '      "' + (match.match_label || "(no match name)") + '"' +
          (clubId ? "" : "  club " + match.club_id)
      );
      console.log(
        "      " + match.row_count + " upload(s) from " + match.device_count +
          " device(s), " + formatDate(match.oldest) + " to " + formatDate(match.newest)
      );
      console.log("      " + archive);
      console.log("");
    }
  }

  if (spared.length > 0) {
    const sparedRows = spared.reduce((sum, m) => sum + Number(m.row_count), 0);

    console.log(
      "  LEFT ALONE: " + spared.length + " match(es), " + sparedRows +
        " upload(s) old enough but never absorbed by a roster push:\n"
    );

    for (const match of spared) {
      console.log(
        "    " + match.match_key + '  "' + (match.match_label || "(no match name)") +
          '"  ' + match.row_count + " upload(s)"
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

  runSql(
    `DELETE FROM squad_uploads
      WHERE device_id <> ${sqlQuote(COMPILED_DEVICE)}
        AND merged_into_roster_revision IS NOT NULL
        AND uploaded_at < ${cutoff}${clubFilter};`,
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

  console.log("\n  Deleted " + (totalRows - remainingRows) + " of " + totalRows + " upload(s).");

  if (remainingRows > 0) {
    console.error("  WARNING: " + remainingRows + " still match the criteria. Run again to check.");
  }

  console.log("");
}

await main();
