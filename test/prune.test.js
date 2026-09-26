/**
 * Tests for scripts/prune-squads.js.
 *
 * Run against a local dev server:
 *   npm run dev              (in one terminal)
 *   $env:API_SECRET = "…"    (in another)
 *   npm run test:prune
 *
 * SEPARATE FROM api.test.js ON PURPOSE.
 *
 * api.test.js only ever creates data through the API, so it is safe to point at
 * the deployed backend. This file deletes rows, and it deletes them from the
 * LOCAL database regardless of where API_BASE points — the cleanup scripts take
 * --remote as a flag rather than reading API_BASE. Mixing the two would make
 * `npm test` a command that quietly removes data, which is not a property a
 * test suite should have.
 *
 * Because of that split the guard below is not paranoia: seeding against a
 * remote server while pruning locally would assert against two different
 * databases and leave test rows in production.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runSql, sqlQuote } from "../scripts/lib/d1.js";

const BASE = process.env.API_BASE ?? "http://127.0.0.1:8787";
const CLUB = process.env.API_CLUB ?? "testclub";
const SECRET = process.env.API_SECRET;

if (!SECRET) {
  console.error("Set API_SECRET to the club's shared secret before running.");
  process.exit(1);
}

// The script always operates on the local database. If the seeding half of
// this test is talking to a deployed server, the two halves are looking at
// different data and every assertion below is meaningless.
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE)) {
  console.error(`API_BASE is ${BASE}, which is not a local server.`);
  console.error("");
  console.error("These tests delete rows from the LOCAL database while seeding");
  console.error("through API_BASE. Pointed at a deployed server they would leave");
  console.error("test data in production and assert against the wrong database.");
  console.error("");
  console.error("Unset API_BASE, or set it to http://127.0.0.1:8787.");
  process.exit(1);
}

/** Device id reserved for a match's compiled results. */
const COMPILED_DEVICE = "compiled";

/** Unique per run, so repeated runs never collide. */
const MATCH_KEY = `outdoor|prune-${Date.now()}`;
const DEVICE_ABSORBED = `dev-absorbed-${Date.now()}`;
const DEVICE_UNTOUCHED = `dev-untouched-${Date.now()}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * POST one squad upload.
 *
 * @param {string} deviceId
 * @param {number} nonce    Varies the payload so it is not deduplicated.
 * @param {object} extra    Envelope overrides.
 * @returns {Promise<{ status: number, body: any }>}
 */
async function upload(deviceId, nonce, extra = {}) {
  const response = await fetch(
    `${BASE}/v1/clubs/${encodeURIComponent(CLUB)}/squads`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        match_key: MATCH_KEY,
        device_id: deviceId,
        match_type: "outdoor",
        match_label: "Prune test",
        squad_key: "1",
        squad_label: "1",
        device_label: "Prune test tablet",
        schema_version: 1,
        entry_count: 2,
        payload: JSON.stringify({ test: true, device: deviceId, nonce }),
        ...extra,
      }),
    }
  );
  return { status: response.status, body: await response.json() };
}

/**
 * GET one device's newest payload, so the test can assert what the app sees.
 *
 * @param {string} deviceId
 * @returns {Promise<number>} HTTP status.
 */
async function getSquadStatus(deviceId) {
  const response = await fetch(
    `${BASE}/v1/clubs/${encodeURIComponent(CLUB)}` +
      `/matches/${encodeURIComponent(MATCH_KEY)}` +
      `/squads/${encodeURIComponent(deviceId)}`,
    { headers: { authorization: `Bearer ${SECRET}` } }
  );
  return response.status;
}

/**
 * Mark one upload as absorbed by the current roster.
 *
 * Requires a roster to exist, so this pushes one first if the club has none.
 *
 * @param {string} deviceId
 * @param {number} revision
 * @returns {Promise<void>}
 */
async function markAbsorbed(deviceId, revision) {
  const rosterUrl = `${BASE}/v1/clubs/${encodeURIComponent(CLUB)}/roster`;
  const auth = { authorization: `Bearer ${SECRET}` };

  const current = await fetch(rosterUrl, { headers: auth });

  if (current.status === 404) {
    const push = await fetch(rosterUrl, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        payload: JSON.stringify({ entries: [] }),
        schema_version: 1,
        base_revision: null,
        entry_count: 0,
        author: "prune test",
      }),
    });
    assert.equal(push.status, 201, "could not create a roster to mark against");
  }

  const marked = await fetch(
    `${BASE}/v1/clubs/${encodeURIComponent(CLUB)}/squads/merged`,
    {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        merged_squads: [
          { match_key: MATCH_KEY, device_id: deviceId, revision },
        ],
      }),
    }
  );

  const body = await marked.json();
  assert.equal(marked.status, 200, `mark failed: ${JSON.stringify(body)}`);
  assert.equal(
    body.marked_squads,
    1,
    `expected 1 squad marked, got ${body.marked_squads}: ${JSON.stringify(body.unmatched)}`
  );
}

/**
 * Backdate every upload at this match so the age filter reaches them.
 *
 * Uploads are stamped server-side with Date.now(), so without this there is
 * nothing old enough to prune and the test would pass by doing nothing.
 *
 * @param {number} days
 * @returns {void}
 */
function backdate(days) {
  const when = Date.now() - days * 86400000;

  runSql(
    `UPDATE squad_uploads
        SET uploaded_at = ${when}
      WHERE club_id = ${sqlQuote(CLUB)}
        AND match_key = ${sqlQuote(MATCH_KEY)};`,
    false
  );
}

/**
 * Which revisions of a device still exist, ascending.
 *
 * @param {string} deviceId
 * @returns {number[]}
 */
function revisionsOf(deviceId) {
  const rows = runSql(
    `SELECT revision FROM squad_uploads
      WHERE club_id = ${sqlQuote(CLUB)}
        AND match_key = ${sqlQuote(MATCH_KEY)}
        AND device_id = ${sqlQuote(deviceId)}
      ORDER BY revision;`,
    false
  );

  return rows.map((r) => Number(r.revision));
}

/**
 * Run the prune script non-interactively.
 *
 * Confirmation is typed on stdin rather than bypassed with a test-only flag. A
 * flag that skips the prompt would exist in the shipped script and eventually
 * be used by hand, which is the opposite of what the prompt is for.
 *
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runPrune(args) {
  const result = spawnSync(
    process.execPath,
    ["scripts/prune-squads.js", ...args],
    { input: "DELETE\n", encoding: "utf8" }
  );

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Tests
//
// One sequential arrangement shared by the assertions below, because setting it
// up means six HTTP calls and a wrangler invocation. Ordering is explicit:
// node:test runs top-level tests in declaration order.
// ---------------------------------------------------------------------------

test("arrange: three revisions absorbed, two revisions not, one archive", async () => {
  for (const nonce of [1, 2, 3]) {
    const { status } = await upload(DEVICE_ABSORBED, nonce);
    assert.equal(status, 201);
  }

  for (const nonce of [1, 2]) {
    const { status } = await upload(DEVICE_UNTOUCHED, nonce);
    assert.equal(status, 201);
  }

  const archive = await upload(COMPILED_DEVICE, 1, {
    device_label: "Compiled results",
  });
  assert.equal(archive.status, 201);

  // Only revision 3 of the absorbed device is marked — which is exactly what a
  // real compile does, and the case the first version of this script got wrong.
  await markAbsorbed(DEVICE_ABSORBED, 3);

  assert.deepEqual(revisionsOf(DEVICE_ABSORBED), [1, 2, 3]);
  assert.deepEqual(revisionsOf(DEVICE_UNTOUCHED), [1, 2]);
});

test("dry run reports rows without deleting them", async () => {
  backdate(200);

  const { stdout } = runPrune([CLUB]);

  assert.match(stdout, /Dry run — nothing was deleted/);
  assert.deepEqual(revisionsOf(DEVICE_ABSORBED), [1, 2, 3]);
  assert.deepEqual(revisionsOf(DEVICE_UNTOUCHED), [1, 2]);
});

test("a squad no roster absorbed is reported as left alone", async () => {
  const { stdout } = runPrune([CLUB]);

  assert.match(stdout, /LEFT ALONE/);
  assert.ok(
    stdout.includes(MATCH_KEY),
    "the match should appear in the left-alone list because one squad is unabsorbed"
  );
});

test("pruning keeps the newest revision and drops the ones below it", async () => {
  const { stdout } = runPrune([CLUB, "--confirm"]);

  assert.doesNotMatch(stdout, /Dry run/);

  // The whole point of the guarantee: the newest revision survives, so the app
  // can still open this squad.
  assert.deepEqual(
    revisionsOf(DEVICE_ABSORBED),
    [3],
    "revisions 1 and 2 should be gone and revision 3 kept"
  );
});

test("a squad no roster absorbed is left completely alone", async () => {
  assert.deepEqual(
    revisionsOf(DEVICE_UNTOUCHED),
    [1, 2],
    "nothing absorbed this squad, so none of its revisions may be deleted"
  );
});

test("the compiled archive survives", async () => {
  assert.deepEqual(revisionsOf(COMPILED_DEVICE), [1]);
});

test("the app can still read every squad the match lists", async () => {
  // This is the assertion the front end cares about, and the one that would
  // have caught the original defect: row counts looked plausible while the only
  // readable revision had been deleted.
  assert.equal(await getSquadStatus(DEVICE_ABSORBED), 200);
  assert.equal(await getSquadStatus(DEVICE_UNTOUCHED), 200);
  assert.equal(await getSquadStatus(COMPILED_DEVICE), 200);
});

test("running again deletes nothing further", async () => {
  const { stdout } = runPrune([CLUB, "--confirm"]);

  assert.deepEqual(revisionsOf(DEVICE_ABSORBED), [3]);
  assert.deepEqual(revisionsOf(DEVICE_UNTOUCHED), [1, 2]);
  assert.doesNotMatch(stdout, /WARNING/);
});

test("--older-than rejects a non-numeric value", async () => {
  const { status, stderr } = runPrune([CLUB, "--older-than", "ninety"]);

  assert.equal(status, 1);
  assert.match(stderr, /whole number of days/);
});

test("a flag value is not mistaken for a club id", async () => {
  // "--older-than 200" must not make 200 the club id. If it did, the run would
  // scope to a club that does not exist and report nothing to do — which looks
  // identical to a clean database.
  const { stdout } = runPrune(["--older-than", "200"]);

  assert.ok(
    !/Club: 200/.test(stdout),
    "200 belongs to --older-than and must not be read as a club id"
  );
});
