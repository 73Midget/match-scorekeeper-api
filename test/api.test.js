/**
 * Endpoint tests for the Match Scorekeeper backend.
 *
 * Run against a local dev server:
 *   npm run dev            (in one terminal)
 *   $env:API_SECRET = "…"  (in another)
 *   npm test
 *
 * Uses Node's built-in fetch and test runner — no dependencies. Each test
 * builds its own data under a timestamped key, so tests do not interfere with
 * each other and the suite can be re-run without resetting the database.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * GET the squad list for a match.
 *
 * @param {string} matchKey Raw match key; encoded here since real keys contain
 *                          slashes (they are date strings).
 * @param {string} secret
 * @param {string} club
 * @returns {Promise<{ status: number, body: any }>}
 */
async function listSquads(matchKey, secret = SECRET, club = CLUB) {
  const url =
    `${BASE}/v1/clubs/${encodeURIComponent(club)}` +
    `/matches/${encodeURIComponent(matchKey)}/squads`;

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${secret}` },
  });
  return { status: response.status, body: await response.json() };
}

/**
 * GET one device's payload for a match.
 *
 * @param {string}      matchKey
 * @param {string}      deviceId
 * @param {number|null} revision Pin a specific revision, or null for newest.
 * @param {string}      secret
 * @param {string}      club
 * @returns {Promise<{ status: number, body: any }>}
 */
async function getSquad(matchKey, deviceId, revision = null, secret = SECRET, club = CLUB) {
  let url =
    `${BASE}/v1/clubs/${encodeURIComponent(club)}` +
    `/matches/${encodeURIComponent(matchKey)}` +
    `/squads/${encodeURIComponent(deviceId)}`;

  if (revision !== null) {
    url += `?revision=${encodeURIComponent(revision)}`;
  }

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${secret}` },
  });
  return { status: response.status, body: await response.json() };
}

/**
 * GET the club's current roster.
 *
 * @param {string} secret
 * @param {string} club
 * @returns {Promise<{ status: number, body: any }>}
 */
async function getRoster(secret = SECRET, club = CLUB) {
  const response = await fetch(`${BASE}/v1/clubs/${encodeURIComponent(club)}/roster`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  return { status: response.status, body: await response.json() };
}

/**
 * PUT a compiled roster.
 *
 * @param {object} push   Body to send, including base_revision.
 * @param {string} secret
 * @param {string} club
 * @returns {Promise<{ status: number, body: any }>}
 */
async function putRoster(push, secret = SECRET, club = CLUB) {
  const response = await fetch(`${BASE}/v1/clubs/${encodeURIComponent(club)}/roster`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(push),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * Build a valid upload envelope with a payload unique to this run.
 *
 * Uploads are deduplicated by payload hash, so a reused payload would hit the
 * duplicate path on a second run and fail for the wrong reason. A timestamp in
 * the payload keeps each run independent.
 *
 * @param {object} overrides Fields to replace.
 * @returns {object}
 */
function envelope(overrides = {}) {
  return {
    match_key: `test-${Date.now()}`,
    device_id: `device-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    device_label: "Test Tablet",
    squad_key: "1",
    squad_label: "1",
    match_type: "outdoor",
    match_label: "Test match",
    schema_version: 1,
    app_version: "2.0.0",
    app_build: "test",
    entry_count: 2,
    payload: JSON.stringify({ test: true, stamp: Date.now() }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic routing and auth
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Upload validation
// ---------------------------------------------------------------------------

test("upload rejects an invalid match_type", async () => {
  const { status, body } = await uploadSquad(envelope({ match_type: "shotgun" }));
  assert.equal(status, 400);
  assert.match(body.error.message, /match_type/);
});

test("upload rejects a missing device_id", async () => {
  const { status, body } = await uploadSquad(envelope({ device_id: "" }));
  assert.equal(status, 400);
  assert.match(body.error.message, /device_id/);
});

test("upload accepts a blank squad label", async () => {
  const { status, body } = await uploadSquad(envelope({ squad_key: "", squad_label: "" }));
  assert.equal(status, 201, "a squad label is optional; only the device id identifies an upload");
  assert.equal(body.revision, 1);
});

// ---------------------------------------------------------------------------
// Upload revisions and deduplication
// ---------------------------------------------------------------------------

test("first upload from a device is revision 1", async () => {
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

test("two devices sharing a squad label do not collide", async () => {
  const matchKey = `test-samelabel-${Date.now()}`;

  // The exact failure device ids exist to prevent: two tablets at one match,
  // both labelled "Squad 1". Under label-based keying the second upload became
  // revision 2 of the first and one squad's scores vanished silently.
  const first = await uploadSquad(
    envelope({
      match_key: matchKey,
      device_id: "tablet-a",
      squad_key: "1",
      payload: JSON.stringify({ from: "a" }),
    })
  );
  const second = await uploadSquad(
    envelope({
      match_key: matchKey,
      device_id: "tablet-b",
      squad_key: "1",
      payload: JSON.stringify({ from: "b" }),
    })
  );

  assert.equal(first.body.revision, 1);
  assert.equal(second.body.revision, 1, "second tablet must start its own revision series");

  const { body } = await listSquads(matchKey);
  assert.equal(body.squads.length, 2, "both squads must appear despite the shared label");
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

test("listing squads requires a valid secret", async () => {
  const { status } = await listSquads("any-match", "not-the-secret");
  assert.equal(status, 401);
});

test("listing an unknown match returns an empty array", async () => {
  const { status, body } = await listSquads(`no-such-match-${Date.now()}`);
  assert.equal(status, 200);
  assert.deepEqual(body.squads, []);
});

test("listing returns only the newest revision of each device", async () => {
  const matchKey = `test-list-${Date.now()}`;
  const deviceA = `device-a-${Date.now()}`;
  const deviceB = `device-b-${Date.now()}`;

  await uploadSquad(envelope({ match_key: matchKey, device_id: deviceA, squad_key: "1" }));
  await uploadSquad(envelope({ match_key: matchKey, device_id: deviceB, squad_key: "2" }));

  const second = await uploadSquad(
    envelope({
      match_key: matchKey,
      device_id: deviceA,
      squad_key: "1",
      payload: JSON.stringify({ revised: true }),
    })
  );
  assert.equal(second.body.revision, 2);

  const { status, body } = await listSquads(matchKey);
  assert.equal(status, 200);
  assert.equal(body.squads.length, 2);

  const fromA = body.squads.find((s) => s.device_id === deviceA);
  assert.equal(fromA.revision, 2, "should report the newest revision");
});

test("listing flags a device this club has not seen before", async () => {
  const matchKey = `test-newdevice-${Date.now()}`;
  const deviceId = `borrowed-${Date.now()}`;

  await uploadSquad(envelope({ match_key: matchKey, device_id: deviceId }));

  const { body } = await listSquads(matchKey);
  const entry = body.squads.find((s) => s.device_id === deviceId);
  assert.equal(entry.first_upload_for_device, 1, "a brand new device should be flagged");

  // The same device at a later match is no longer new.
  const laterMatch = `test-newdevice-later-${Date.now()}`;
  await uploadSquad(envelope({ match_key: laterMatch, device_id: deviceId }));

  const later = await listSquads(laterMatch);
  const laterEntry = later.body.squads.find((s) => s.device_id === deviceId);
  assert.equal(laterEntry.first_upload_for_device, 0, "a returning device should not be flagged");
});

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

test("downloading a squad requires a valid secret", async () => {
  const { status } = await getSquad("any-match", "any-device", null, "not-the-secret");
  assert.equal(status, 401);
});

test("downloading a squad that does not exist returns 404", async () => {
  const { status, body } = await getSquad(`no-such-match-${Date.now()}`, "any-device");
  assert.equal(status, 404);
  assert.equal(body.error.code, "squad_not_found");
});

test("downloading returns the payload byte-for-byte", async () => {
  const matchKey = `test-download-${Date.now()}`;
  const deviceId = `device-${Date.now()}`;
  const payload = JSON.stringify({ entries: [{ name: "A" }, { name: "B" }], stamp: Date.now() });

  await uploadSquad(envelope({ match_key: matchKey, device_id: deviceId, payload }));

  const { status, body } = await getSquad(matchKey, deviceId);
  assert.equal(status, 200);
  assert.equal(body.squad.payload, payload, "stored payload must match what was uploaded");
});

test("downloading defaults to the newest revision", async () => {
  const matchKey = `test-newest-${Date.now()}`;
  const deviceId = `device-${Date.now()}`;
  const older = JSON.stringify({ version: "older" });
  const newer = JSON.stringify({ version: "newer" });

  await uploadSquad(envelope({ match_key: matchKey, device_id: deviceId, payload: older }));
  await uploadSquad(envelope({ match_key: matchKey, device_id: deviceId, payload: newer }));

  const { body } = await getSquad(matchKey, deviceId);
  assert.equal(body.squad.revision, 2);
  assert.equal(body.squad.payload, newer);
});

test("an older revision is still reachable by number", async () => {
  const matchKey = `test-history-${Date.now()}`;
  const deviceId = `device-${Date.now()}`;
  const older = JSON.stringify({ version: "older" });
  const newer = JSON.stringify({ version: "newer" });

  await uploadSquad(envelope({ match_key: matchKey, device_id: deviceId, payload: older }));
  await uploadSquad(envelope({ match_key: matchKey, device_id: deviceId, payload: newer }));

  const { status, body } = await getSquad(matchKey, deviceId, 1);
  assert.equal(status, 200);
  assert.equal(body.squad.payload, older, "revision 1 must still hold the original payload");
});

test("a non-numeric revision is rejected", async () => {
  const { status, body } = await getSquad("any-match", "any-device", "abc");
  assert.equal(status, 400);
  assert.equal(body.error.code, "invalid_revision");
});

// ---------------------------------------------------------------------------
// Roster
//
// These run against the shared club roster rather than isolated per-test data,
// because a club has exactly one roster. They read the current revision first
// and build on it, so the suite can be re-run without resetting anything.
// ---------------------------------------------------------------------------

test("roster access requires a valid secret", async () => {
  const { status } = await getRoster("not-the-secret");
  assert.equal(status, 401);
});

test("a roster push with a stale base_revision is refused", async () => {
  // Establish a known current revision.
  const before = await getRoster();
  const currentRevision = before.status === 200 ? before.body.roster.revision : null;

  const good = await putRoster({
    payload: JSON.stringify({ entries: [{ name: "Smith" }], stamp: Date.now() }),
    schema_version: 1,
    base_revision: currentRevision,
    entry_count: 1,
    author: "tablet-a",
  });
  assert.equal(good.status, 201);

  // Tablet B compiled from the revision that was current a moment ago and is
  // now stale. Without this check its push would silently drop Smith.
  const stale = await putRoster({
    payload: JSON.stringify({ entries: [{ name: "Jones" }], stamp: Date.now() }),
    schema_version: 1,
    base_revision: currentRevision,
    entry_count: 1,
    author: "tablet-b",
  });

  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "roster_conflict");
  assert.equal(stale.body.current_revision, good.body.revision);
  assert.equal(stale.body.current_author, "tablet-a", "conflict should name who got there first");
});

test("a roster push with the current base_revision succeeds", async () => {
  const before = await getRoster();
  const currentRevision = before.status === 200 ? before.body.roster.revision : null;

  const { status, body } = await putRoster({
    payload: JSON.stringify({ entries: [{ name: "Smith" }, { name: "Jones" }], stamp: Date.now() }),
    schema_version: 1,
    base_revision: currentRevision,
    entry_count: 2,
    author: "tablet-c",
  });

  assert.equal(status, 201);
  assert.equal(body.revision, (currentRevision ?? 0) + 1);
});

test("the roster GET returns what was last pushed", async () => {
  const before = await getRoster();
  const currentRevision = before.status === 200 ? before.body.roster.revision : null;
  const payload = JSON.stringify({ entries: [{ name: "Unique" }], stamp: Date.now() });

  const push = await putRoster({
    payload,
    schema_version: 1,
    base_revision: currentRevision,
    entry_count: 1,
    author: "tablet-d",
  });
  assert.equal(push.status, 201);

  const { status, body } = await getRoster();
  assert.equal(status, 200);
  assert.equal(body.roster.revision, push.body.revision);
  assert.equal(body.roster.payload, payload);
});

test("a roster push rejects a malformed base_revision", async () => {
  const { status, body } = await putRoster({
    payload: JSON.stringify({ entries: [] }),
    schema_version: 1,
    base_revision: "not-a-number",
    entry_count: 0,
  });

  assert.equal(status, 400);
  assert.match(body.error.message, /base_revision/);
});

test("ping rejects a wrong secret", async () => {
  const response = await fetch(`${BASE}/v1/clubs/${CLUB}/ping`, {
    headers: { authorization: "Bearer not-the-secret" },
  });
  assert.equal(response.status, 401);
});

test("ping confirms a good configuration", async () => {
  const response = await fetch(`${BASE}/v1/clubs/${CLUB}/ping`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.club, CLUB);
  assert.equal(
    typeof body.club_name,
    "string",
    "the display name is what makes ping a useful setup confirmation"
  );
});

test("unmerged rejects a malformed days parameter", async () => {
  const response = await fetch(
    `${BASE}/v1/clubs/${encodeURIComponent(CLUB)}/squads/unmerged?days=abc`,
    { headers: { authorization: `Bearer ${SECRET}` } }
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_days");
});

test("unmerged reports the window it applied", async () => {
  const response = await fetch(
    `${BASE}/v1/clubs/${encodeURIComponent(CLUB)}/squads/unmerged?days=7`,
    { headers: { authorization: `Bearer ${SECRET}` } }
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).days, 7);
});

test("a fresh upload appears in the unmerged list", async () => {
  const matchKey = `test-unmerged-${Date.now()}`;
  const deviceId = `device-${Date.now()}`;

  await uploadSquad(envelope({ match_key: matchKey, device_id: deviceId }));

  const response = await fetch(
    `${BASE}/v1/clubs/${encodeURIComponent(CLUB)}/squads/unmerged`,
    { headers: { authorization: `Bearer ${SECRET}` } }
  );
  const body = await response.json();

  assert.ok(
    body.unmerged.some((s) => s.device_id === deviceId),
    "an upload no roster has claimed should be listed"
  );
});

test("listing matches requires a valid secret", async () => {
  const response = await fetch(`${BASE}/v1/clubs/${CLUB}/matches`, {
    headers: { authorization: "Bearer not-the-secret" },
  });
  assert.equal(response.status, 401);
});

test("listing matches rejects a malformed days parameter", async () => {
  const response = await fetch(`${BASE}/v1/clubs/${CLUB}/matches?days=abc`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_days");
});

test("a match appears once however many squads uploaded", async () => {
  const matchKey = `outdoor|test-matches-${Date.now()}`;

  await uploadSquad(envelope({ match_key: matchKey, device_id: "tablet-a", squad_key: "1" }));
  await uploadSquad(envelope({ match_key: matchKey, device_id: "tablet-b", squad_key: "2" }));
  await uploadSquad(
    envelope({
      match_key: matchKey,
      device_id: "tablet-a",
      squad_key: "1",
      payload: JSON.stringify({ revised: true }),
    })
  );

  const response = await fetch(`${BASE}/v1/clubs/${CLUB}/matches`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  const body = await response.json();

  const rows = body.matches.filter((m) => m.match_key === matchKey);
  assert.equal(rows.length, 1, "one row per match, not per upload");
  assert.equal(rows[0].squad_count, 2, "two devices uploaded, one of them twice");
  assert.equal(rows[0].has_compiled, 0);
});

test("has_compiled flips once a compiled archive is uploaded", async () => {
  const matchKey = `outdoor|test-compiled-${Date.now()}`;

  await uploadSquad(envelope({ match_key: matchKey, device_id: "tablet-a", squad_key: "1" }));
  await uploadSquad(
    envelope({
      match_key: matchKey,
      device_id: "compiled",
      device_label: "Compiled results",
      squad_key: "",
      payload: JSON.stringify({ compiled: true, stamp: Date.now() }),
    })
  );

  const response = await fetch(`${BASE}/v1/clubs/${CLUB}/matches`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  const row = (await response.json()).matches.find((m) => m.match_key === matchKey);

  assert.equal(row.has_compiled, 1);
  assert.equal(row.squad_count, 1, "the compiled archive is a result, not a squad");
});

test("roster revisions require a valid secret", async () => {
  const response = await fetch(`${BASE}/v1/clubs/${CLUB}/roster/revisions`, {
    headers: { authorization: "Bearer not-the-secret" },
  });
  assert.equal(response.status, 401);
});

test("a superseded roster revision is still retrievable", async () => {
  // The rollback case: publish a roster, publish a worse one, and confirm the
  // good one is still there to publish again.
  const before = await getRoster();
  const startRevision = before.status === 200 ? before.body.roster.revision : null;

  const good = JSON.stringify({ entries: [{ name: "A" }, { name: "B" }], stamp: Date.now() });
  const first = await putRoster({
    payload: good,
    schema_version: 1,
    base_revision: startRevision,
    entry_count: 2,
    author: "tablet-good",
  });
  assert.equal(first.status, 201);

  const bad = JSON.stringify({ entries: [{ name: "A" }], stamp: Date.now() });
  const second = await putRoster({
    payload: bad,
    schema_version: 1,
    base_revision: first.body.revision,
    entry_count: 1,
    author: "tablet-oops",
  });
  assert.equal(second.status, 201);

  // The current roster is the bad one.
  const current = await getRoster();
  assert.equal(current.body.roster.payload, bad);

  // The good one is still reachable by number.
  const response = await fetch(
    `${BASE}/v1/clubs/${encodeURIComponent(CLUB)}/roster?revision=${first.body.revision}`,
    { headers: { authorization: `Bearer ${SECRET}` } }
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).roster.payload,
    good,
    "an append-only roster must keep every published revision"
  );
});

test("the revision list reports author and entry count", async () => {
  const response = await fetch(`${BASE}/v1/clubs/${CLUB}/roster/revisions`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(response.status, 200);

  const { revisions } = await response.json();
  assert.ok(revisions.length > 0);

  // Newest first, so a picker shows recent revisions without scrolling.
  assert.ok(
    revisions[0].revision > revisions[revisions.length - 1].revision,
    "revisions should be newest first"
  );

  const entry = revisions[0];
  assert.equal(typeof entry.author, "string");
  assert.equal(typeof entry.entry_count, "number");
  assert.equal(typeof entry.updated_at, "number");
  assert.ok(!("payload" in entry), "the list must not carry payloads");
});

test("requesting a roster revision that does not exist returns 404", async () => {
  const response = await fetch(
    `${BASE}/v1/clubs/${encodeURIComponent(CLUB)}/roster?revision=999999`,
    { headers: { authorization: `Bearer ${SECRET}` } }
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "roster_not_found");
});

test("a malformed roster revision parameter is rejected", async () => {
  const response = await fetch(
    `${BASE}/v1/clubs/${encodeURIComponent(CLUB)}/roster?revision=abc`,
    { headers: { authorization: `Bearer ${SECRET}` } }
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_revision");
});