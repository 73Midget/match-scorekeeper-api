/**
 * Create a club and print its tablet configuration.
 *
 * Usage:
 *   node scripts/create-club.js "Riverside Gun Club"
 *   node scripts/create-club.js "Riverside Gun Club" --remote
 *   node scripts/create-club.js "Riverside Gun Club" --url https://api.example.com
 *
 * This exists so nobody has to hand-generate a secret, hash it correctly, and
 * write an INSERT by hand. Every one of those steps has a quiet failure mode —
 * hashing with a trailing newline being the classic — and a script does it the
 * same way every time.
 *
 * The secret is printed once and stored nowhere but as a hash in the database.
 * Losing it means rotating the club's secret; it cannot be recovered.
 */

import { runSql, sqlQuote } from "./lib/d1.js";
import {
  generateClubId,
  generateSecret,
  hashSecret,
  buildConfigBlob,
} from "./lib/secrets.js";

function main() {
  const args = process.argv.slice(2);

  const displayName = args.find((a) => !a.startsWith("--"));
  if (!displayName) {
    console.error('Usage: node scripts/create-club.js "Club Name" [--remote] [--url <api-url>]');
    process.exit(1);
  }

  // Control characters would corrupt the statement and serve no purpose in a
  // display name. Length is capped so the value cannot pad the statement into
  // something unwieldy.
  if (displayName.length > 100 || /[\u0000-\u001f]/.test(displayName)) {
    console.error("Club name must be under 100 characters and contain no control characters.");
    process.exit(1);
  }

  const remote = args.includes("--remote");
  const urlIndex = args.indexOf("--url");
  const apiUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;

  const clubId = generateClubId();
  const secret = generateSecret();
  const secretHash = hashSecret(secret);
  const createdAt = Date.now();

  const sql =
    "INSERT INTO clubs (club_id, display_name, secret_hash, created_at) VALUES (" +
    sqlQuote(clubId) + ", " +
    sqlQuote(displayName) + ", " +
    sqlQuote(secretHash) + ", " +
    createdAt + ");";

  try {
    runSql(sql, remote);
  } catch (err) {
    console.error("\nFailed to create the club. The database was not modified.\n");
    console.error(err.message);
    process.exit(1);
  }

  // The secret exists only here and as a hash in the database. Printing it
  // once, clearly marked, is deliberate: there is no way to retrieve it later.
  console.log("\n  Created club: " + displayName);
  console.log("  Database:     " + (remote ? "remote (deployed)" : "local (development)"));
  console.log("\n  Club id:      " + clubId);
  console.log("  Secret:       " + secret);
  console.log("\n  Save the secret now. It is not stored anywhere and cannot be recovered.");
  console.log("  If it is lost, rotate this club's secret.\n");

  if (apiUrl) {
    console.log("  Tablet configuration (paste into the app setup screen):\n");
    console.log("  " + buildConfigBlob(apiUrl, clubId, secret) + "\n");
    console.log("  This contains the secret. Anyone who has it can upload for this club.\n");
  } else {
    console.log("  Pass --url <api-url> to also print a pasteable tablet configuration.\n");
  }
}

main();