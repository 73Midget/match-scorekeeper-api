/**
 * List the clubs on a database.
 *
 * Usage:
 *   node scripts/list-clubs.js
 *   node scripts/list-clubs.js --remote
 *
 * Exists so finding a club id does not mean remembering a wrangler d1 execute
 * incantation. Secrets are never shown: the database holds only their hashes,
 * and even those are not printed.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Wrangler's entry script, run directly rather than through npx. */
const WRANGLER = resolve("node_modules", "wrangler", "bin", "wrangler.js");

/**
 * Run a SQL query and return its rows as objects.
 *
 * Three things here are deliberate, each fixing a problem that is not obvious
 * until it bites:
 *
 *  - Wrangler is invoked as a script under the current Node binary, not via
 *    npx. On Windows npx is a .cmd file, and Node refuses to execute batch
 *    files without a shell; a shell in turn would split the SQL statement on
 *    its spaces. Running the .js directly avoids both.
 *
 *  - --command rather than --file. On a remote database wrangler treats --file
 *    as an import operation, which needs permissions a plain query does not
 *    and fails with an authentication error.
 *
 *  - Failures are re-thrown with wrangler's own output attached. Swallowing
 *    them makes a hard error look like an empty result set.
 *
 * Passing SQL as an argument is safe only because every statement in this
 * script is hardcoded — no caller-supplied value is ever interpolated.
 *
 * @param {string}  sql
 * @param {boolean} remote Query the deployed database rather than the local one.
 * @returns {object[]}
 */
function query(sql, remote) {
  const args = [WRANGLER, "d1", "execute", "match-scorekeeper"];
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

function main() {
  const remote = process.argv.includes("--remote");

  const clubs = query(
    "SELECT club_id, display_name, secret_version, active, created_at FROM clubs ORDER BY display_name;",
    remote
  );

  const where = remote ? "remote (deployed)" : "local (development)";

  if (clubs.length === 0) {
    console.log("\n  No clubs on the " + where + " database.\n");
    return;
  }

  console.log("\n  Clubs on the " + where + " database:\n");

  for (const club of clubs) {
    // created_at is epoch milliseconds, but be defensive: a hand-seeded row
    // should not crash the whole listing.
    const timestamp = Number(club.created_at);
    const created = Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString().slice(0, 10)
      : "unknown";

    const status = club.active === 1 ? "" : "  [INACTIVE]";

    console.log("  " + club.club_id + "  " + club.display_name + status);
    console.log(
      "            secret v" + club.secret_version + ", created " + created + "\n"
    );
  }
}

main();