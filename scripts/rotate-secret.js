/**
 * Rotate a club's shared secret.
 *
 * Usage:
 *   node scripts/rotate-secret.js <club-id>
 *   node scripts/rotate-secret.js <club-id> --remote
 *   node scripts/rotate-secret.js <club-id> --remote --url https://api.example.com
 *
 * Use this when a secret has been exposed — pasted somewhere it should not
 * have been, sent by email, or lost with a tablet. The club keeps its id and
 * all of its data; only the credential changes.
 *
 * Every tablet stops working the moment this runs. There is no grace period
 * and the old secret is not accepted afterwards, which is the point when a
 * secret has leaked — but it means rotation is something to do before a match,
 * not during one.
 */

import { createInterface } from "node:readline/promises";
import { runSql, sqlQuote } from "./lib/d1.js";
import { generateSecret, hashSecret, buildConfigBlob } from "./lib/secrets.js";

/**
 * Ask the operator to confirm by typing the club id back.
 *
 * A plain y/n is too easy to answer reflexively, and rotating the wrong club
 * silently locks out a set of tablets that were working fine. Typing the id
 * requires actually reading which club is about to change.
 *
 * @param {string} clubId
 * @returns {Promise<boolean>}
 */
async function confirm(clubId) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question("  Type the club id to confirm: ");
    return answer.trim() === clubId;
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);

  const clubId = args.find((a) => !a.startsWith("--"));
  if (!clubId) {
    console.error("Usage: node scripts/rotate-secret.js <club-id> [--remote] [--url <api-url>]");
    console.error("Run scripts/list-clubs.js to see club ids.");
    process.exit(1);
  }

  const remote = args.includes("--remote");
  const urlIndex = args.indexOf("--url");
  const apiUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;

  // Look the club up first, so the confirmation prompt can name it and so a
  // mistyped id fails before anything is generated.
  const rows = runSql(
    "SELECT club_id, display_name, secret_version FROM clubs WHERE club_id = " +
      sqlQuote(clubId) + ";",
    remote
  );

  if (rows.length === 0) {
    console.error(
      "\n  No club with id " + clubId + " on the " +
        (remote ? "remote" : "local") + " database.\n"
    );
    process.exit(1);
  }

  const club = rows[0];

  console.log("\n  About to rotate the secret for:");
  console.log("    " + club.club_id + "  " + club.display_name);
  console.log("    Database: " + (remote ? "remote (deployed)" : "local (development)"));
  console.log("\n  Every tablet configured for this club will stop working until it");
  console.log("  is given the new configuration.\n");

  if (!(await confirm(club.club_id))) {
    console.log("\n  Club id did not match. Nothing was changed.\n");
    process.exit(1);
  }

  const secret = generateSecret();
  const secretHash = hashSecret(secret);
  const nextVersion = club.secret_version + 1;

  runSql(
    "UPDATE clubs SET secret_hash = " + sqlQuote(secretHash) +
      ", secret_version = " + nextVersion +
      " WHERE club_id = " + sqlQuote(club.club_id) + ";",
    remote
  );

  // Print the secret before anything else can fail.
  //
  // Once the UPDATE has run, the only copy of the new secret is in this
  // process — the database holds only its hash. So no check, no formatting
  // step, and no later error may stand between the write and showing it. An
  // earlier version of this script verified first and exited on a bad check,
  // which rotated the secret and then withheld it: the club was locked out of
  // its own backend with no way back. A warning about a secret you can see
  // beats a clean failure about a secret you have lost.
  console.log("\n  Rotated: " + club.display_name);
  console.log("\n  Club id:        " + club.club_id + "  (unchanged)");
  console.log("  Secret:         " + secret);
  console.log("  Secret version: " + nextVersion);
  console.log("\n  Save the secret now. It is not stored anywhere and cannot be recovered.\n");

  if (apiUrl) {
    console.log("  Tablet configuration (paste into the app setup screen):\n");
    console.log("  " + buildConfigBlob(apiUrl, club.club_id, secret) + "\n");
    console.log("  This contains the secret. Anyone who has it can upload for this club.\n");
  } else {
    console.log("  Pass --url <api-url> to also print a pasteable tablet configuration.\n");
  }

  // Confirm by re-reading the row rather than trusting a reported row count.
  // The local emulator returns meta without a `changes` field while the remote
  // database includes one, so a count is not something to depend on across
  // both. The stored version number is the actual outcome, and checking it
  // here — after the secret is on screen — cannot cost anyone their access.
  const after = runSql(
    "SELECT secret_version FROM clubs WHERE club_id = " + sqlQuote(club.club_id) + ";",
    remote
  );

  if (after[0]?.secret_version !== nextVersion) {
    console.error("  WARNING: could not confirm the update landed. Check the club with");
    console.error("  scripts/list-clubs.js before configuring any tablets.\n");
  }
}

main();