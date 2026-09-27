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
 *    as an import: it uploads the file, takes the database briefly offline and
 *    asks for confirmation before running. That is the wrong shape for a script
 *    issuing one small statement at a time. It also needs permissions a plain
 *    query does not, and has failed here with an authentication error — though
 *    it does work when the credentials allow it, which is how the 2026-09-26
 *    restore was done by hand.
 *
 *  - Failures are re-thrown with wrangler's own output attached. Swallowing
 *    them makes a hard error look like an empty result set, which is a
 *    genuinely confusing thing to debug.
 *
 * There is deliberately no helper for "how many rows did that change". The
 * local emulator returns meta without a `changes` field while the remote
 * database includes one, so a row count cannot be relied on across both.
 * Callers that need to confirm a write should re-read the row and check the
 * value they expected.
 *
 * SQL is passed as an argument, which is safe only because every statement in
 * these scripts is built here or hardcoded by the caller. Values that come
 * from a person must be escaped with sqlQuote below.
 *
 * It matters that it is passed as one element of an argv array and never
 * through a shell. spawnSync with shell: false hands each argument to wrangler
 * exactly as written, newlines included, so the multi-line statements in the
 * cleanup scripts arrive whole.
 *
 * That is the only thing separating those scripts from the same SQL typed at a
 * prompt. On 2026-09-26 a multi-line DELETE pasted into PowerShell reached
 * wrangler truncated at its first newline, and that first line —
 * `DELETE FROM squad_uploads` — is a complete, valid statement. It emptied the
 * table for every club on the backend. The SQL was correct; the delivery was
 * not.
 *
 * So the multi-line SQL in prune-squads.js and its siblings is safe as long as
 * it travels this path. Changing runSql to shell: true, to a single command
 * string, or to an exec-style call would end that, and every DELETE in
 * scripts/ would become a statement whose first line is its own worst case.
 * Do not make that change without first rewriting those queries onto one line.
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