/**
 * Create a club and print its tablet configuration.
 *
 * Usage:
 *   node scripts/create-club.js "Riverside Gun Club"
 *   node scripts/create-club.js "Riverside Gun Club" --remote
 *   node scripts/create-club.js "Riverside Gun Club" --url https://api.example.com
 *
 * This exists so nobody has to hand-generate a secret, hash it correctly, and
 * write an INSERT by hand. Every one of those steps has a quiet failure mode,
 * and a script does it the same way every time.
 *
 * The secret is printed once and stored nowhere but as a hash in the database.
 */

import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

/**
 * Alphabet for generated club ids.
 *
 * No vowels, so an id can never accidentally spell something. No 0/O/1/l/I,
 * which are the characters people misread when checking a config by eye.
 */
const ID_ALPHABET = "23456789bcdfghjkmnpqrstvwxz";
const ID_LENGTH = 8;

/** Temporary file used to pass SQL to wrangler. Relative and space-free. */
const SQL_TEMP_FILE = ".tmp-create-club.sql";

/**
 * Generate a random club id.
 *
 * Ids are generated rather than chosen deliberately. A meaningful id wants to
 * change when a club renames or when two clubs want the same slug, and a club
 * id lives in every tablet's configuration, which must never change.
 *
 * Rejection sampling: bytes at or above the largest whole multiple of the
 * alphabet length are discarded rather than folded with %, which would make
 * the first few characters slightly more likely.
 *
 * @returns {string}
 */
function generateClubId() {
  const limit = Math.floor(256 / ID_ALPHABET.length) * ID_ALPHABET.length;
  let id = "";

  while (id.length < ID_LENGTH) {
    for (const byte of randomBytes(ID_LENGTH)) {
      if (byte >= limit) continue;
      id += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (id.length === ID_LENGTH) break;
    }
  }

  return id;
}

/**
 * Generate a shared secret.
 *
 * 32 random bytes, base64 encoded. High entropy is what makes storing a plain
 * SHA-256 of it safe: there is no dictionary to attack. If this ever becomes a
 * human-chosen passphrase, the storage side must become PBKDF2 or scrypt.
 *
 * @returns {string}
 */
function generateSecret() {
  return randomBytes(32).toString("base64");
}

/**
 * Hash a secret the same way the Worker does.
 *
 * The Worker hashes the exact bytes it receives, with no trailing newline.
 * This must match byte for byte or nothing authenticates, and the failure
 * looks like a wrong secret with no hint as to why.
 *
 * @param {string} secret
 * @returns {string} 64 lowercase hex characters.
 */
function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Escape a string for inclusion in a SQL literal.
 *
 * The Worker binds parameters rather than building SQL strings. This script
 * cannot: wrangler executes a complete statement with no way to pass
 * parameters separately. So the display name is escaped by doubling single
 * quotes, and the caller validates it before it reaches this point.
 *
 * @param {string} value
 * @returns {string}
 */
function sqlQuote(value) {
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * Execute a SQL statement against the D1 database.
 *
 * The statement goes to a temporary file rather than the command line.
 * Windows needs shell: true to launch npx, and a shell splits every argument
 * on whitespace, so a SQL statement passed as an argument arrives as thirty
 * separate arguments. A file sidesteps the quoting problem entirely.
 *
 * @param {string}  sql
 * @param {boolean} remote Target the deployed database rather than the local one.
 */
function runSql(sql, remote) {
  writeFileSync(SQL_TEMP_FILE, sql, "utf8");

  try {
    execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        "match-scorekeeper",
        remote ? "--remote" : "--local",
        "--file",
        SQL_TEMP_FILE,
        "--yes",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        shell: process.platform === "win32",
      }
    );
  } finally {
    // Removed whether or not the statement succeeded: the file contains the
    // secret's hash and has no reason to outlive the command.
    if (existsSync(SQL_TEMP_FILE)) unlinkSync(SQL_TEMP_FILE);
  }
}

function main() {
  const args = process.argv.slice(2);

  const displayName = args.find((a) => !a.startsWith("--"));
  if (!displayName) {
    console.error("Usage: node scripts/create-club.js \"Club Name\" [--remote] [--url <api-url>]");
    process.exit(1);
  }

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
    "INSERT INTO clubs (club_id, display_name, secret_hash, created_at)\n" +
    "VALUES ('" + clubId + "', " + sqlQuote(displayName) +
    ", '" + secretHash + "', " + createdAt + ");\n";

  try {
    runSql(sql, remote);
  } catch {
    console.error("\nFailed to create the club. The database was not modified.");
    process.exit(1);
  }

  console.log("\n  Created club: " + displayName);
  console.log("  Database:     " + (remote ? "remote (deployed)" : "local (development)"));
  console.log("\n  Club id:      " + clubId);
  console.log("  Secret:       " + secret);
  console.log("\n  Save the secret now. It is not stored anywhere and cannot be recovered.");
  console.log("  If it is lost, rotate this club's secret or create a new club.\n");

  if (apiUrl) {
    const config = Buffer.from(
      JSON.stringify({ url: apiUrl, club: clubId, secret }),
      "utf8"
    ).toString("base64");

    console.log("  Tablet configuration (paste into the app setup screen):\n");
    console.log("  " + config + "\n");
    console.log("  This contains the secret. Anyone who has it can upload for this club.\n");
  } else {
    console.log("  Pass --url <api-url> to also print a pasteable tablet configuration.\n");
  }
}

main();
