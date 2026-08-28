/**
 * Endpoint tests for the Match Scorekeeper backend.
 *
 * Run against a local dev server:
 *   npm run dev          (in one terminal)
 *   node test/api.test.js (in another)
 *
 * Uses Node's built-in fetch and test runner — no dependencies. Each test
 * asserts on the status code and the parts of the body that matter, so a
 * failure says which expectation broke rather than just "something changed".
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.API_BASE ?? "http://127.0.0.1:8787";
const CLUB = process.env.API_CLUB ?? "testclub";
const SECRET = process.env.API_SECRET;

if (!SECRET) {
  console.error("Set API_SECRET to the club's shared secret before running.");
  process.exit(1);
}

/**
 * POST a squad upload envelope.
 *
 * @param {object} envelope Body to send.
 * @param {string} secret   Bearer token; overridable to test auth failures.
 * @param {string} club     Club id in the path; overridable likewise.
 * @returns {Promise<{ status: number, body: any }>}
 */
async function uploadSquad(envelope, secret = SECRET, club = CLUB) {
  const response = await fetch(`${BASE}/v1/clubs/${encodeURIComponent(club)}/squads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(envelope),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * Build a valid upload envelope with a payload unique to this run.
 *
 * Uploads are append-only and deduplicated by payload hash, so tests that
 * reuse a payload would hit the duplicate path on a second run and fail for
 * the wrong reason. A timestamp in the payload keeps each run independent.
 *
 * @param {object} overrides Fields to replace.
 * @returns {object}
 */
function envelope(overrides = {}) {
  return {
    match_key: `test-${Date.now()}`,
    squad_key: "1",
    match_type: "outdoor",
    match_label: "Test match",
    squad_label: "1",
    schema_version: 1,
    app_version: "2.0.0",
    app_build: "test",
    entry_count: 2,
    payload: JSON.stringify({ test: true, stamp: Date.now() }),
    ...overrides,
  };
}

test("health check responds without auth", async () => {
  const response = await fetch(`${BASE}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("unknown route returns 404", async () => {
  const response = await fetch(`${BASE}/v1/nope`);
  assert.equal(response.status, 404);
});

test("upload rejects a missing Authorization header", async () => {
  const response = await fetch(`${BASE}/v1/clubs/${CLUB}/squads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope()),
  });
  assert.equal(response.status, 401);
});

test("upload rejects a wrong secret", async () => {
  const { status } = await uploadSquad(envelope(), "not-the-secret");
  assert.equal(status, 401);
});

test("a valid secret does not work for another club", async () => {
  const { status } = await uploadSquad(envelope(), SECRET, "someotherclub");
  assert.equal(status, 401);
});

test("upload rejects an invalid match_type", async () => {
  const { status, body } = await uploadSquad(envelope({ match_type: "shotgun" }));
  assert.equal(status, 400);
  assert.match(body.error.message, /match_type/);
});

test("upload rejects a missing squad_key", async () => {
  const { status, body } = await uploadSquad(envelope({ squad_key: "" }));
  assert.equal(status, 400);
  assert.match(body.error.message, /squad_key/);
});

test("first upload of a squad is revision 1", async () => {
  const { status, body } = await uploadSquad(envelope());
  assert.equal(status, 201);
  assert.equal(body.revision, 1);
  assert.equal(body.duplicate, false);
});

test("re-sending an identical payload is reported as a duplicate", async () => {
  const same = envelope();

  const first = await uploadSquad(same);
  assert.equal(first.status, 201);

  const second = await uploadSquad(same);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.revision, first.body.revision);
});

test("a changed payload creates the next revision", async () => {
  const base = envelope();

  const first = await uploadSquad(base);
  assert.equal(first.body.revision, 1);

  const second = await uploadSquad({
    ...base,
    payload: JSON.stringify({ test: true, changed: true }),
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.revision, 2);
});