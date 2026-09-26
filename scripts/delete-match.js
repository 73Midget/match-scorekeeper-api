/**
 * Delete one match entirely — every squad upload and the compiled archive.
 *
 * Usage:
 *   node scripts/delete-match.js --remote "outdoor|8/14/2026"
 *   node scripts/delete-match.js --remote "outdoor|8/14/2026" --club x3222665
 *
 * QUOTE THE MATCH KEY. It contains a pipe, and an unquoted pipe is a shell
 * pipeline in PowerShell, bash and cmd alike — the command would be silently
 * split in half.
 *
 * This is the escape hatch prune-squads.js refuses to be. It ignores the age
 * threshold and ignores whether a roster ever absorbed the squads, which makes
 * it the one command here that can destroy the only copy of a shooter's
 * contact details.
 *
 * Use it for a match you have looked at and concluded is junk: an abandoned
 * test, a tablet someone started and shut down, a squad uploaded against a
 * mistyped match name. Look first — list-unmerged.js for the metadata, the app
 * for the contents.
 *
 * There is no dry-run flag because there is no non-dry mode to opt into: the
 * script always shows what it would delete and then asks for the match key
 * back. A second flag would be a third gate for a single match, which is the
 * kind of friction that teaches people to type flags without reading them.
 */

import { createInterface } from "node:readline/promises";
import { runSql, sqlQuote } from "./lib/d1.js";

/** Device id reserved for a match's compiled results. */
const COMPILED_DEVICE = "compiled";

/**
 * Render epoch milliseconds as a local date and time.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "unknown";

  return new Date(n).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Every upload belonging to a match key, across clubs.
 *
 * Deliberately not scoped to one club unless asked: two clubs on one backend
 * can hold the same match key, and a delete that silently picked one of them
 * would be wrong in a way nobody would notice until the wrong match was gone.
 *
 * @param {string}      matchKey
 * @param {string|null} clubId
 * @param {boolean}     remote
 * @returns {object[]}
 */
function fetchMatch(matchKey, clubId, remote) {
  const clubFilter = clubId ? ` AND club_id = ${sqlQuote(clubId)}` : "";

  return runSql(
    `SELECT club_id, match_key, match_label, match_type,
            device_id, device_label, squad_key, squad_label,
            revision, entry_count, uploaded_at,
            merged_into_roster_revision
       FROM squad_uploads
      WHERE match_key = ${sqlQuote(matchKey)}${clubFilter}
      ORDER BY device_id, revision;`,
    remote
  );
}

/**
 * Ask the operator to type the match key back.
 *
 * Typing a long key containing a pipe is awkward, and that is the point. This
 * is the only command that can destroy data nothing else holds a copy of, so
 * the confirmation should cost more than a reflexive y.
 *
 * @param {string} matchKey
 * @returns {Promise<boolean>}
 */
async function confirm(matchKey) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question("  Type the match key to confirm: ");
    return answer.trim() === matchKey;
  } finally {
    rl.close();
  }
}

/**
 * Read the positional match key, skipping values that belong to flags.
 *
 * @param {string[]} args
 * @returns {string|null}
 */
function positionalMatchKey(args) {
  const takesValue = new Set(["--club"]);

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
  const matchKey = positionalMatchKey(args);

  const clubIndex = args.indexOf("--club");
  const clubId = clubIndex !== -1 ? args[clubIndex + 1] : null;

  if (!matchKey) {
    console.error('Usage: node scripts/delete-match.js [--remote] "<match-key>" [--club <id>]');
    console.error("Quote the match key — it contains a pipe.");
    console.error("Run scripts/list-unmerged.js to see match keys.");
    process.exit(1);
  }

  // A key with no pipe is almost certainly a shell that split the argument, or
  // a label pasted instead of a key. Either way the match will not be found,
  // and saying why beats "no match with that key".
  if (!matchKey.includes("|")) {
    console.error('\n  "' + matchKey + '" does not look like a match key.');
    console.error("  Keys look like outdoor|8/14/2026 — did the quotes get lost?\n");
    process.exit(1);
  }

  const rows = fetchMatch(matchKey, clubId, remote);
  const where = remote ? "remote (deployed)" : "local (development)";

  if (rows.length === 0) {
    console.error(
      "\n  No match with key " + matchKey + " on the " + where + " database" +
        (clubId ? " for club " + clubId : "") + ".\n"
    );
    process.exit(1);
  }

  const clubs = [...new Set(rows.map((r) => r.club_id))];
  if (clubs.length > 1) {
    console.error("\n  That match key exists in more than one club:\n");
    for (const c of clubs) console.error("    " + c);
    console.error("\n  Name one with --club so the right one is deleted.\n");
    process.exit(1);
  }

  const squads = rows.filter((r) => r.device_id !== COMPILED_DEVICE);
  const archives = rows.filter((r) => r.device_id === COMPILED_DEVICE);
  const merged = squads.filter((r) => r.merged_into_roster_revision !== null);

  const devices = [...new Set(squads.map((r) => r.device_id))];
  const label = rows[0].match_label || "(no match name)";

  console.log("\n  About to delete an entire match — " + where + " database\n");
  console.log("    " + matchKey);
  console.log('    "' + label + '"  ' + rows[0].match_type + "  club " + clubs[0]);
  console.log("");
  console.log(
    "    " + rows.length + " row(s): " + squads.length + " squad upload(s) from " +
      devices.length + " device(s)" +
      (archives.length ? ", " + archives.length + " compiled archive(s)" : "")
  );
  console.log("");

  // One line per device rather than per revision — a 30-shooter squad has
  // roughly 30 rows, and listing them all would bury the thing that matters,
  // which is which squads existed.
  for (const device of devices) {
    const forDevice = squads.filter((r) => r.device_id === device);
    const newest = forDevice[forDevice.length - 1];
    const squadLabel = newest.squad_label || newest.squad_key || "(no squad name)";

    console.log(
      "      " + squadLabel.padEnd(16) +
        (newest.device_label || device).padEnd(22) +
        forDevice.length + " revision(s), newest " + newest.entry_count +
        " shooter(s), " + formatTime(newest.uploaded_at)
    );
  }

  console.log("");

  if (merged.length > 0) {
    console.log("  This match WAS compiled — " + merged.length + " upload(s) were absorbed");
    console.log("  by a roster push. Deleting it removes the record of a match that");
    console.log("  counted. prune-squads.js would keep the compiled archive; this");
    console.log("  will not.");
    console.log("");
  } else {
    console.log("  No roster push ever absorbed these uploads, so any shooter added");
    console.log("  at check-in on these tablets may exist here and nowhere else.");
    console.log("");
  }

  console.log("  This cannot be undone, and there is no point-in-time recovery.");
  console.log("");

  if (!(await confirm(matchKey))) {
    console.log("\n  Key did not match. Nothing was deleted.\n");
    process.exit(1);
  }

  const clubFilter = ` AND club_id = ${sqlQuote(clubs[0])}`;

  runSql(
    `DELETE FROM squad_uploads
      WHERE match_key = ${sqlQuote(matchKey)}${clubFilter};`,
    remote
  );

  // Verify by re-reading. The local emulator returns statement metadata
  // without a `changes` field while the deployed database includes one, so a
  // count taken from the delete itself reads zero locally even on success.
  const remaining = fetchMatch(matchKey, clubs[0], remote);

  if (remaining.length === 0) {
    console.log("\n  Deleted " + rows.length + " row(s). The match is gone.\n");
  } else {
    console.error(
      "\n  WARNING: " + remaining.length + " row(s) remain. Run again to check.\n"
    );
    process.exit(1);
  }
}

await main();
