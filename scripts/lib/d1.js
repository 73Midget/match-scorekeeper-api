/**
 * Running SQL against the project's D1 database from a script.
 *
 * Three things here are deliberate, each fixing a problem that is not obvious
 * until it bites:
 *
 *  - Wrangler is invoked as a script under the current Node binary, not via
 *    npx. On Windows npx is a .cmd file, and Node refuses to execute batch
 *    files without a shell; a shell in turn would split a SQL statement on its
 *    spaces and hand wrangler thirty arguments. Running the .js directly
 *    avoids both problems.
 *
 *  - --command rather than --file. On a remote database wrangler treats --file
 *    as an import operation, which needs permissions a plain query does not
 *    and fails with an authentication error.
 *
 *  - Failures are re-thrown with wrangler's own output attached. Swallowing
 *    them makes a hard error look like an empty result set, which is a
 *    genuinely confusing thing to debug.
 *
 * SQL is passed as an argument, which is safe only because every statement in
 * these scripts is built here or hardcoded by the caller. Values that come
 * from a person must be escaped with sqlQuote below.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** The database name from wrangler.jsonc. */
const DATABASE = "match-scorekeeper";

/** Wrangler's entry script, run directly rather than through npx. */
const WRANGLER = resolve("node_modules", "wrangler", "bin", "wrangler.js");

/**
 * Escape a string for inclusion in a SQL literal.
 *
 * The Worker binds parameters rather than building SQL strings, because that
 * is the only reliable defence against injection. These scripts cannot:
 * wrangler executes a complete statement and offers no way to pass parameters
 * separately. Doubling single quotes is the SQL standard, and callers validate
 * their input before it reaches this point.
 *
 * @param {string} value
 * @returns {string} The value wrapped in quotes, safe to embed.
 */
export function sqlQuote(value) {
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * Execute SQL and return the resulting rows.
 *
 * @param {string}  sql    A complete statement, ending in a semicolon.
 * @param {boolean} remote Target the deployed database rather than the local one.
 * @returns {object[]} Rows as plain objects; empty for statements returning none.
 */
export function runSql(sql, remote) {
  const args = [WRANGLER, "d1", "execute", DATABASE];
  args.push(remote ? "--remote" : "--local");
  args.push("--command", sql, "--json");

  let output;
  try {
    output = execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      "wrangler failed (" + err.code + "): " + err.message + "\n" +
        (err.stdout ?? "") + (err.stderr ?? "")
    );
  }

  // On --remote, wrangler prints progress lines before the JSON. It also
  // pretty-prints, so the opening bracket of the array sits alone on its own
  // line — which no progress line will.
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[");
  if (start === -1) {
    throw new Error("No JSON found in wrangler output:\n" + output);
  }

  return JSON.parse(lines.slice(start).join("\n"))[0]?.results ?? [];
}

/**
 * Execute SQL and report how many rows it changed.
 *
 * Used by writes, where the row count is the confirmation that the statement
 * matched anything. An UPDATE that changes nothing is not an error to
 * wrangler, so the caller has to check.
 *
 * @param {string}  sql
 * @param {boolean} remote
 * @returns {number} Rows inserted, updated, or deleted.
 */
export function runSqlChanges(sql, remote) {
  const args = [WRANGLER, "d1", "execute", DATABASE];
  args.push(remote ? "--remote" : "--local");
  args.push("--command", sql, "--json");

  let output;
  try {
    output = execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      "wrangler failed (" + err.code + "): " + err.message + "\n" +
        (err.stdout ?? "") + (err.stderr ?? "")
    );
  }

  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[");
  if (start === -1) {
    throw new Error("No JSON found in wrangler output:\n" + output);
  }

  return JSON.parse(lines.slice(start).join("\n"))[0]?.meta?.changes ?? 0;
}