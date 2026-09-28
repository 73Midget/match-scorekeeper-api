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
 *
 * A club marked [SUSPENDED] has clubs.active set to 0, so the Worker rejects
 * every request for it and its tablets have all stopped working. Nothing is
 * deleted — see scripts/suspend-club.js.
 */

import { runSql } from "./lib/d1.js";

function main() {
  const remote = process.argv.includes("--remote");

  const clubs = runSql(
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

    // "SUSPENDED" rather than "INACTIVE", because it says what was done rather
    // than describing a state — and because it points at the script that
    // reverses it.
    const status = club.active === 1 ? "" : "  [SUSPENDED]";

    console.log("  " + club.club_id + "  " + club.display_name + status);
    console.log(
      "            secret v" + club.secret_version + ", created " + created + "\n"
    );
  }

  const suspended = clubs.filter((c) => c.active !== 1).length;
  if (suspended > 0) {
    console.log(
      "  " + suspended + " suspended club(s). Tablets for those get a 401 and" +
        "\n  cannot upload. Resume with: node scripts/suspend-club.js <id>" +
        (remote ? " --remote" : "") + " --resume\n"
    );
  }
}

main();
