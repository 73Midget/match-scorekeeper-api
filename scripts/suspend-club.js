/**
 * Suspend a club, or bring a suspended one back.
 *
 * Usage:
 *   node scripts/suspend-club.js <club-id> --remote
 *   node scripts/suspend-club.js <club-id> --remote --resume
 *
 * Suspending sets clubs.active to 0. The Worker checks that column on every
 * request, so every tablet configured for the club stops working immediately and
 * nothing is deleted. Resuming sets it back and they all work again with the
 * credential they already have.
 *
 * WHY NOT JUST ROTATE THE SECRET
 *
 * Rotating locks tablets out too, and it is the wrong tool for pausing a club:
 *
 *   - Rotating cannot be undone. The old secret is gone the moment it runs, so
 *     changing your mind means visiting every tablet with a new setup code.
 *     Suspending is one command in each direction and the tablets never change.
 *
 *   - They mean different things. Rotating says "this credential leaked" and
 *     bumps secret_version to record it. Suspending says "this club is paused".
 *     Rotating in order to suspend leaves a history implying a compromise that
 *     never happened, which nobody will be able to resolve a year later.
 *
 * Rotate when a secret is exposed. Suspend when a club should stop using the
 * backend.
 *
 * WHAT A SUSPENDED CLUB LOOKS LIKE FROM A TABLET
 *
 * A 401 with code `unauthorized` — the same response as a wrong secret, because
 * the Worker checks `active` alongside the credential. Per spec §6 a client
 * reads that as "prompt to re-enter configuration", which is misleading here:
 * the configuration is correct and the club is paused. Tell whoever is holding
 * the tablet, because the app cannot.
 *
 * A distinct `club_suspended` code is on the list in ENHANCEMENTS.md.
 */

import { createInterface } from "node:readline/promises";
import { runSql, sqlQuote } from "./lib/d1.js";
import { positional } from "./lib/args.js";

/**
 * Ask the operator to type the club id back.
 *
 * Used for suspending, not for resuming. Suspending stops a set of tablets that
 * were working, and doing it to the wrong club is the kind of mistake that is
 * only discovered at a range. Resuming cannot break anything that is currently
 * working, so it gets a lighter gate.
 *
 * @param {string} clubId
 * @returns {Promise<boolean>}
 */
async function confirmClubId(clubId) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question("  Type the club id to confirm: ");
    return answer.trim() === clubId;
  } finally {
    rl.close();
  }
}

/**
 * Ask a yes/no question, defaulting to no.
 *
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function confirmYes(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

/**
 * What a club currently holds, so the operator sees the scale of what stops.
 *
 * @param {string}  clubId
 * @param {boolean} remote
 * @returns {object}
 */
function fetchClub(clubId, remote) {
  const rows = runSql(
    `SELECT club_id, display_name, active, secret_version,
            (SELECT COUNT(DISTINCT match_key) FROM squad_uploads
              WHERE club_id = ${sqlQuote(clubId)}) AS matches,
            (SELECT COUNT(*) FROM squad_uploads
              WHERE club_id = ${sqlQuote(clubId)}) AS uploads,
            (SELECT MAX(revision) FROM rosters
              WHERE club_id = ${sqlQuote(clubId)}) AS roster_revision,
            (SELECT entry_count FROM rosters
              WHERE club_id = ${sqlQuote(clubId)}
              ORDER BY revision DESC LIMIT 1) AS shooters
       FROM clubs
      WHERE club_id = ${sqlQuote(clubId)};`,
    remote
  );

  return rows[0] ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const remote = args.includes("--remote");
  const resuming = args.includes("--resume");

  // No flag here consumes the argument after it, but the list is passed
  // explicitly so adding one later cannot silently break the positional.
  const clubId = positional(args, []);

  if (!clubId) {
    console.error("Usage: node scripts/suspend-club.js <club-id> [--remote] [--resume]");
    console.error("");
    console.error("Suspending stops every tablet for that club immediately and");
    console.error("deletes nothing. --resume puts it back.");
    console.error("");
    console.error("Run scripts/list-clubs.js to see club ids.");
    process.exit(1);
  }

  const club = fetchClub(clubId, remote);
  const where = remote ? "remote (deployed)" : "local (development)";

  if (!club) {
    console.error("\n  No club with id " + clubId + " on the " + where + " database.\n");
    process.exit(1);
  }

  const suspended = club.active !== 1;
  const wanted = resuming ? 1 : 0;

  // Already in the requested state. Not an error — someone checking whether a
  // club is suspended should not have to read a failure to find out.
  if (club.active === wanted) {
    console.log(
      "\n  " + club.club_id + "  " + club.display_name + " is already " +
        (suspended ? "suspended" : "active") + " on the " + where + " database.\n"
    );
    return;
  }

  console.log("\n  " + (resuming ? "Resuming" : "Suspending") + " a club — " + where + " database\n");
  console.log("    " + club.club_id + "  " + club.display_name);
  console.log(
    "    Currently " + (suspended ? "suspended" : "active") +
      ", secret v" + club.secret_version
  );
  console.log(
    "    " + club.matches + " match(es), " + club.uploads + " upload(s), roster r" +
      (club.roster_revision ?? 0) + " with " + (club.shooters ?? 0) + " shooter(s)"
  );
  console.log("");

  if (resuming) {
    console.log("  Every tablet configured for this club starts working again,");
    console.log("  using the setup code it already has. Nothing needs reconfiguring.\n");

    if (!(await confirmYes("  Resume this club? [y/N]: "))) {
      console.log("\n  Nothing was changed.\n");
      process.exit(1);
    }
  } else {
    console.log("  Every tablet configured for this club stops working immediately.");
    console.log("  Uploads fail with a 401, which the app reports as a configuration");
    console.log("  problem — so tell whoever is holding a tablet, because the app");
    console.log("  cannot tell them the club is merely paused.");
    console.log("");
    console.log("  Nothing is deleted. --resume puts it all back.\n");

    if (!(await confirmClubId(club.club_id))) {
      console.log("\n  Club id did not match. Nothing was changed.\n");
      process.exit(1);
    }
  }

  runSql(
    `UPDATE clubs SET active = ${wanted} WHERE club_id = ${sqlQuote(club.club_id)};`,
    remote
  );

  // Verify by re-reading rather than trusting a reported row count. The local
  // emulator returns statement metadata without a `changes` field while the
  // deployed database includes one, so a count read from the update is zero
  // locally even on success — and here a false "nothing happened" would send
  // someone to run it again, or worse, to reach for rotate-secret instead.
  const after = fetchClub(club.club_id, remote);

  if (after?.active !== wanted) {
    console.error("\n  WARNING: could not confirm the change landed.");
    console.error("  Check with scripts/list-clubs.js before relying on it.\n");
    process.exit(1);
  }

  console.log(
    "\n  " + club.display_name + " is now " +
      (wanted === 1 ? "active" : "suspended") + ".\n"
  );

  if (wanted === 0) {
    console.log("  To bring it back:");
    console.log(
      "    node scripts/suspend-club.js " + club.club_id +
        (remote ? " --remote" : "") + " --resume\n"
    );
  }
}

await main();
