/**
 * List squad uploads that no compile has absorbed.
 *
 * Usage:
 *   node scripts/list-unmerged.js
 *   node scripts/list-unmerged.js --remote
 *   node scripts/list-unmerged.js --remote --older-than 90
 *   node scripts/list-unmerged.js --remote x3222665
 *
 * This is the "what should I look at before deleting anything" view. Every
 * field it prints is metadata — squad labels, device names, counts, times.
 * It never opens a payload, which is what keeps client-side encryption on the
 * table for later: reading scores is the thing that would close that door, and
 * deciding whether a stale match matters does not require it.
 *
 * Read-only. Nothing here deletes.
 */

import { runSql, sqlQuote } from "./lib/d1.js";

/** Device id reserved for a match's compiled results. */
const COMPILED_DEVICE = "compiled";

/**
 * Render epoch milliseconds as a local date and time.
 *
 * Local rather than UTC: this runs on the club's own machine, and an RO
 * checking whether an upload happened during Thursday's match wants Thursday
 * evening, not the following morning in UTC.
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
 * Whole days between a timestamp and now.
 *
 * @param {number} ms
 * @returns {number}
 */
function ageInDays(ms) {
  return Math.floor((Date.now() - Number(ms)) / 86400000);
}

/**
 * Pad a value to a fixed column width, truncating if it does not fit.
 *
 * Without the truncation a long label runs into the next column and the table
 * stops being scannable — which matters here, because scanning the table is
 * the entire point of the tool.
 *
 * @param {string} value
 * @param {number} width
 * @returns {string}
 */
function column(value, width) {
  const text = String(value ?? "");
  return text.length > width
    ? text.slice(0, width - 1) + "…"
    : text.padEnd(width);
}

/**
 * Read the positional club id, ignoring values that belong to flags.
 *
 * A flag's value does not start with "--", so a naive search for the first
 * non-flag argument picks up the 30 in "--older-than 30" and treats it as a
 * club id. The failure is quiet: the listing simply comes back empty, as it
 * would for a club with nothing outstanding.
 *
 * @param {string[]} args
 * @returns {string|null}
 */
function positionalClubId(args) {
  /** Flags that consume the argument after them. */
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

/**
 * Fetch unmerged uploads, newest revision per device.
 *
 * Two exclusions matter:
 *
 *  - The reserved 'compiled' device holds a match's results, not a squad
 *    awaiting compilation. It is never named in merged_squads, so it is never
 *    marked, so it would otherwise appear here forever — noise on exactly the
 *    view meant to surface real problems.
 *
 *  - Only the newest revision per device. An earlier revision being unmarked
 *    says nothing: the compile absorbed whichever revision was current at the
 *    time, and the ones before it were never candidates.
 *
 * No time window, unlike the /squads/unmerged endpoint. That endpoint answers
 * "did anything arrive after I compiled?", which is inherently recent. This
 * answers "what is still outstanding?", and an abandoned match from two
 * seasons ago is exactly what someone running a cleanup wants to see.
 *
 * @param {string|null} clubId Limit to one club, or null for all.
 * @param {boolean}     remote
 * @returns {object[]}
 */
function fetchUnmerged(clubId, remote) {
  const clubFilter = clubId ? ` AND s.club_id = ${sqlQuote(clubId)}` : "";
  const latestFilter = clubId ? ` WHERE club_id = ${sqlQuote(clubId)}` : "";

  return runSql(
    `SELECT s.club_id, s.match_key, s.match_label, s.match_type,
            s.device_id, s.device_label, s.squad_key, s.squad_label,
            s.revision, s.entry_count, s.uploaded_at,

            -- Does a compiled archive exist for this match? Together with the
            -- count below this separates "nobody ever compiled this" from "a
            -- squad turned up after the compile", which call for very
            -- different decisions.
            EXISTS (
              SELECT 1 FROM squad_uploads c
               WHERE c.club_id = s.club_id
                 AND c.match_key = s.match_key
                 AND c.device_id = ${sqlQuote(COMPILED_DEVICE)}
            ) AS has_compiled,

            -- How many uploads at this match a roster push did absorb.
            (SELECT COUNT(*) FROM squad_uploads m
              WHERE m.club_id = s.club_id
                AND m.match_key = s.match_key
                AND m.merged_into_roster_revision IS NOT NULL) AS merged_count

       FROM squad_uploads s
       JOIN (
             SELECT club_id, match_key, device_id, MAX(revision) AS max_revision
               FROM squad_uploads${latestFilter}
              GROUP BY club_id, match_key, device_id
            ) latest
         ON latest.club_id = s.club_id
        AND latest.match_key = s.match_key
        AND latest.device_id = s.device_id
        AND latest.max_revision = s.revision

      WHERE s.merged_into_roster_revision IS NULL
        AND s.device_id <> ${sqlQuote(COMPILED_DEVICE)}${clubFilter}
      ORDER BY s.uploaded_at DESC;`,
    remote
  );
}

/**
 * Group rows into one entry per match, preserving newest-first order.
 *
 * @param {object[]} rows
 * @returns {Map<string, object>}
 */
function groupByMatch(rows) {
  const matches = new Map();

  for (const row of rows) {
    // Club id is part of the grouping key: two clubs on one backend can
    // legitimately hold the same match key, and merging them in the display
    // would be wrong in a way that is hard to notice.
    const key = `${row.club_id}\u0000${row.match_key}`;

    if (!matches.has(key)) {
      matches.set(key, {
        club_id: row.club_id,
        match_key: row.match_key,
        match_label: row.match_label,
        match_type: row.match_type,
        has_compiled: row.has_compiled,
        merged_count: row.merged_count,
        newest_upload: Number(row.uploaded_at),
        oldest_upload: Number(row.uploaded_at),
        squads: [],
      });
    }

    const match = matches.get(key);
    match.squads.push(row);
    match.oldest_upload = Math.min(match.oldest_upload, Number(row.uploaded_at));
  }

  return matches;
}

/**
 * Describe why a match has unmerged uploads.
 *
 * The distinction drives the decision: a match nothing ever absorbed may be
 * holding the only copy of a shooter added at check-in, while a late arrival
 * at an otherwise-compiled match usually is not.
 *
 * @param {object} match
 * @returns {string}
 */
function describeState(match) {
  if (match.merged_count === 0 && match.has_compiled === 0) {
    return "NEVER COMPILED — no roster absorbed any of these, and no results were published";
  }

  if (match.merged_count === 0) {
    return "Results published, but no roster push absorbed these squads";
  }

  return `Compiled — ${match.merged_count} upload(s) absorbed, these arrived after or were not selected`;
}

function main() {
  const args = process.argv.slice(2);
  const remote = args.includes("--remote");

  const clubId = positionalClubId(args);

  const olderIndex = args.indexOf("--older-than");
  let olderThan = null;
  if (olderIndex !== -1) {
    olderThan = Number(args[olderIndex + 1]);
    if (!Number.isInteger(olderThan) || olderThan < 0) {
      console.error("--older-than needs a whole number of days.");
      process.exit(1);
    }
  }

  const rows = fetchUnmerged(clubId, remote);
  const where = remote ? "remote (deployed)" : "local (development)";

  let matches = [...groupByMatch(rows).values()];

  if (olderThan !== null) {
    matches = matches.filter((m) => ageInDays(m.newest_upload) >= olderThan);
  }

  if (matches.length === 0) {
    console.log(
      "\n  Nothing outstanding on the " + where + " database" +
        (olderThan !== null ? ` older than ${olderThan} days` : "") + ".\n"
    );
    return;
  }

  const squadTotal = matches.reduce((sum, m) => sum + m.squads.length, 0);

  console.log("\n  Uploads no compile absorbed — " + where + " database");
  console.log("  " + matches.length + " match(es), " + squadTotal + " squad(s)");
  if (olderThan !== null) {
    console.log("  Filtered to uploads at least " + olderThan + " days old");
  }
  console.log("");

  for (const match of matches) {
    const shooters = match.squads.reduce((sum, s) => sum + Number(s.entry_count || 0), 0);
    const days = ageInDays(match.newest_upload);

    // The match key is printed because it is what a forced delete has to be
    // given verbatim. It should never reach a club officer's screen in the
    // app, but this is an operator tool and the key is the handle.
    console.log("  " + match.match_key);
    console.log(
      '    "' + (match.match_label || "(no match name)") + '"  ' +
        match.match_type +
        (clubId ? "" : "  club " + match.club_id)
    );
    console.log("    " + describeState(match));
    console.log(
      "    " + match.squads.length + " squad(s), " + shooters +
        " shooter(s), last upload " + days + " day(s) ago"
    );
    console.log("");

    for (const squad of match.squads) {
      const label = squad.squad_label || squad.squad_key || "(no squad name)";
      const device = squad.device_label || squad.device_id;

      console.log(
        "      " + column(label, 16) +
          column(device, 22) +
          String(squad.entry_count).padStart(3) + " shooter(s)   " +
          column("rev " + squad.revision, 8) +
          formatTime(squad.uploaded_at)
      );
    }

    console.log("");
  }

  console.log("  A match marked NEVER COMPILED may hold the only copy of a shooter");
  console.log("  added at check-in. Look at one in the app before deciding it is junk.\n");
}

main();
