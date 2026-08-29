/**
 * Export the database to a SQL file.
 *
 * Usage:
 *   node scripts/export-backup.js --remote
 *   node scripts/export-backup.js --remote --out C:\Users\me\Drive\club-backups
 *
 * Run this monthly. It is the difference between losing a Cloudflare account
 * being an inconvenience and being a catastrophe: with a dump, recovery is an
 * import; without one, the roster has to be rebuilt from whatever the tablets
 * happen to still hold, and match history is simply gone.
 *
 * The file this produces contains every shooter's name, email address, and
 * phone number in plain text. It is the most sensitive artifact this system
 * produces. Store it somewhere deliberate.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { runSql } from "./lib/d1.js";

/** The database name from wrangler.jsonc. */
const DATABASE = "match-scorekeeper";

/** Wrangler's entry script, run directly rather than through npx. */
const WRANGLER = resolve("node_modules", "wrangler", "bin", "wrangler.js");

/**
 * Build a dated filename.
 *
 * Sorts chronologically as plain text, which means a folder of these is in
 * order without anyone having to think about it.
 *
 * @param {boolean} remote
 * @returns {string} e.g. "match-scorekeeper-2026-08-28.sql"
 */
function backupFilename(remote) {
  const date = new Date().toISOString().slice(0, 10);
  const which = remote ? "" : "-local";
  return DATABASE + which + "-" + date + ".sql";
}

/**
 * Summarize what is about to be backed up.
 *
 * Printed before and checked after, so an empty or truncated dump is visible
 * rather than something discovered months later at the moment of recovery.
 *
 * @param {boolean} remote
 * @returns {{clubs: number, squads: number, rosters: number}}
 */
function summarize(remote) {
  const rows = runSql(
    "SELECT (SELECT COUNT(*) FROM clubs) AS clubs," +
      " (SELECT COUNT(*) FROM squad_uploads) AS squads," +
      " (SELECT COUNT(*) FROM rosters) AS rosters;",
    remote
  );

  return rows[0] ?? { clubs: 0, squads: 0, rosters: 0 };
}

function main() {
  const args = process.argv.slice(2);
  const remote = args.includes("--remote");

  const outIndex = args.indexOf("--out");
  const outDir = outIndex !== -1 ? args[outIndex + 1] : ".";

  if (!outDir) {
    console.error("--out needs a directory path.");
    process.exit(1);
  }

  // Create the directory rather than failing, so pointing this at a new
  // backups folder works on the first run.
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
    console.log("\n  Created directory: " + outDir);
  }

  const outPath = join(outDir, backupFilename(remote));

  // Refuse to overwrite. Two backups on one day is unusual enough that it is
  // more likely a mistake than an intention, and a backup silently replacing
  // an earlier one is the wrong default for a file whose whole purpose is
  // being there later.
  if (existsSync(outPath)) {
    console.error("\n  A backup for today already exists:\n    " + outPath);
    console.error("\n  Move or rename it first if you want another.\n");
    process.exit(1);
  }

  const before = summarize(remote);
  console.log("\n  Backing up the " + (remote ? "remote (deployed)" : "local") + " database:");
  console.log("    " + before.clubs + " clubs");
  console.log("    " + before.squads + " squad uploads");
  console.log("    " + before.rosters + " roster revisions");
  console.log("\n  This may take a moment.\n");

  try {
    execFileSync(
      process.execPath,
      [
        WRANGLER,
        "d1",
        "export",
        DATABASE,
        remote ? "--remote" : "--local",
        "--output",
        outPath,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    console.error("\n  Export failed. No backup was written.\n");
    console.error((err.stdout ?? "") + (err.stderr ?? ""));
    process.exit(1);
  }

  // Confirm the file exists and is not trivially small. Wrangler exiting
  // cleanly is not by itself proof that a usable dump landed on disk.
  if (!existsSync(outPath)) {
    console.error("\n  Wrangler reported success but no file was written.\n");
    process.exit(1);
  }

  const bytes = statSync(outPath).size;
  if (bytes < 100) {
    console.error("\n  The backup file is only " + bytes + " bytes. Something went wrong.\n");
    process.exit(1);
  }

  console.log("  Backup written:");
  console.log("    " + resolve(outPath));
  console.log("    " + (bytes / 1024).toFixed(1) + " KB\n");

  console.log("  Now copy it somewhere that is NOT Cloudflare — a club Drive");
  console.log("  folder, an officer's computer, anywhere that survives losing");
  console.log("  access to the Cloudflare account. That is the entire point.\n");

  console.log("  This file contains every shooter's name, email, and phone in");
  console.log("  plain text. Store it somewhere deliberate.\n");
}

main();