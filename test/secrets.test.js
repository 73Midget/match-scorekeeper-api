/**
 * Tests for scripts/lib/secrets.js.
 *
 * Run with:
 *   npm test
 *
 * No server and no database — these are pure functions, so this file runs in
 * milliseconds and needs no environment variables. It is in the default test
 * run for that reason.
 *
 * Two things here are worth more than the rest of the suite put together:
 *
 *   - hashSecret must agree with the Worker byte for byte. If it ever does not,
 *     every club's credentials stop working and the failure looks exactly like
 *     a mistyped secret. The Worker uses Web Crypto and this uses node:crypto,
 *     so the test computes both and compares rather than trusting either.
 *
 *   - buildConfigBlob produces the setup code the app has to decode. The app's
 *     parsing (spec §2.1) and this function are in different repositories and
 *     nothing else checks that they agree.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateClubId,
  generateSecret,
  hashSecret,
  buildConfigBlob,
} from "../scripts/lib/secrets.js";

/** The alphabet generateClubId is documented to draw from. */
const ID_ALPHABET = "23456789bcdfghjkmnpqrstvwxz";

/**
 * How many ids to draw for the statistical checks below.
 *
 * 2000 ids is 16,000 characters against 27 possibilities, so each is expected
 * about 590 times. A character the generator can never emit will be absent with
 * certainty rather than by luck, which is what makes the coverage assertion
 * meaningful rather than flaky.
 */
const SAMPLE_SIZE = 2000;

// ---------------------------------------------------------------------------
// Club ids
// ---------------------------------------------------------------------------

test("club ids are eight characters from the documented alphabet", () => {
  for (let i = 0; i < 100; i++) {
    const id = generateClubId();

    assert.equal(id.length, 8);
    for (const char of id) {
      assert.ok(
        ID_ALPHABET.includes(char),
        `"${char}" in "${id}" is not in the club id alphabet`
      );
    }
  }
});

test("club ids contain no vowels and no lookalike characters", () => {
  // The alphabet excludes vowels so a generated id can never spell something
  // unfortunate on a club's setup card, and excludes 0/O/1/l/I because those
  // are what people misread when checking a configuration by eye. Asserted
  // against generated output rather than against the constant, so a change to
  // the alphabet fails here rather than shipping quietly.
  const forbidden = /[aeiou0O1lI]/;

  for (let i = 0; i < SAMPLE_SIZE; i++) {
    const id = generateClubId();
    assert.doesNotMatch(id, forbidden, `"${id}" contains a forbidden character`);
  }
});

test("club ids can use every character in the alphabet", () => {
  // The rejection sampling discards bytes at or above 243. A mistake in that
  // boundary would make some characters unreachable, which is invisible in any
  // single id.
  const seen = new Set();

  for (let i = 0; i < SAMPLE_SIZE; i++) {
    for (const char of generateClubId()) seen.add(char);
  }

  const missing = [...ID_ALPHABET].filter((c) => !seen.has(c));

  assert.deepEqual(
    missing,
    [],
    `these characters never appeared in ${SAMPLE_SIZE} ids: ${missing.join("")}`
  );
});

test("club ids are not repeated", () => {
  // 27^8 is about 2.8e11, so a thousand draws colliding would mean the
  // generator is not random rather than that we were unlucky.
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(generateClubId());

  assert.equal(ids.size, 1000);
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test("secrets are 32 random bytes, base64 encoded", () => {
  const secret = generateSecret();

  // 32 bytes is what makes storing a plain SHA-256 safe: there is no dictionary
  // to attack. If this ever shrinks, or becomes human-chosen, the storage side
  // has to become PBKDF2 or scrypt — so the length is a security property, not
  // a formatting detail.
  assert.equal(Buffer.from(secret, "base64").length, 32);
  assert.match(secret, /^[A-Za-z0-9+/]+={0,2}$/);
});

test("secrets are not repeated", () => {
  const secrets = new Set();
  for (let i = 0; i < 1000; i++) secrets.add(generateSecret());

  assert.equal(secrets.size, 1000);
});

// ---------------------------------------------------------------------------
// Hashing — the part that must match the Worker
// ---------------------------------------------------------------------------

test("hashSecret matches the Worker's Web Crypto implementation", () => {
  // This is the assertion that matters. src/index.js hashes with
  // crypto.subtle.digest over TextEncoder bytes; this module uses node:crypto.
  // They must produce identical output or nothing authenticates, and the
  // failure would present as a wrong secret with no hint as to the cause.
  //
  // Recomputed here the Worker's way rather than compared against a stored
  // constant, so this keeps testing the real agreement between the two.
  const workerHash = async (text) => {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);

    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

  const cases = [
    generateSecret(),
    generateSecret(),
    "",
    "a",
    // Real secrets are base64 and routinely contain + / and =.
    "GDAKdFijI/vSBhgyIOxNQyr8sq4l6p1195jls2IgvXI=",
    // Non-ASCII, to prove both sides agree on UTF-8 rather than on a byte-wise
    // encoding that happens to match for ASCII.
    "pässwörd–with–ünicode",
  ];

  return Promise.all(
    cases.map(async (secret) => {
      assert.equal(
        hashSecret(secret),
        await workerHash(secret),
        `node:crypto and Web Crypto disagree for ${JSON.stringify(secret)}`
      );
    })
  );
});

test("hashSecret produces 64 lowercase hex characters", () => {
  // The Worker compares hashes with a constant-time comparison that rejects
  // unequal lengths outright, so a differently formatted hash fails to
  // authenticate rather than raising anything.
  assert.match(hashSecret(generateSecret()), /^[0-9a-f]{64}$/);
});

test("hashSecret is stable across calls", () => {
  const secret = generateSecret();

  assert.equal(hashSecret(secret), hashSecret(secret));
});

test("hashSecret matches a known value", () => {
  // A stored constant as well as the cross-implementation check above. That
  // check would still pass if both sides changed together — to SHA-512, say,
  // or to a different text encoding. This one would not.
  assert.equal(
    hashSecret("correct horse battery staple"),
    "c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a"
  );
});

test("hashSecret does not trim or normalize its input", () => {
  // The secret is hashed exactly as received, with no trailing newline. A
  // helpful trim here would make a secret copied with a stray space
  // authenticate, which sounds convenient and means the stored hash no longer
  // corresponds to the string the club was given.
  const secret = generateSecret();

  assert.notEqual(hashSecret(secret), hashSecret(secret + "\n"));
  assert.notEqual(hashSecret(secret), hashSecret(secret + " "));
  assert.notEqual(hashSecret(secret), hashSecret(" " + secret));
});

// ---------------------------------------------------------------------------
// The setup code
// ---------------------------------------------------------------------------

test("the setup code decodes to the three fields the app expects", () => {
  const url = "https://match-scorekeeper-api.example.workers.dev";
  const clubId = generateClubId();
  const secret = generateSecret();

  const blob = buildConfigBlob(url, clubId, secret);

  // Exactly what spec §2.1 tells the app to do:
  //   const config = JSON.parse(atob(code.trim()));
  const config = JSON.parse(Buffer.from(blob, "base64").toString("utf8"));

  assert.deepEqual(Object.keys(config).sort(), ["club", "secret", "url"]);
  assert.equal(config.url, url);
  assert.equal(config.club, clubId);
  assert.equal(config.secret, secret);
});

test("the setup code survives being pasted with surrounding whitespace", () => {
  // The app calls .trim() before decoding because a code arrives by way of a
  // copy and paste, and a paste routinely carries a newline.
  const blob = buildConfigBlob("https://example.workers.dev", "x3222665", generateSecret());
  const pasted = `\n  ${blob}  \n`;

  const config = JSON.parse(Buffer.from(pasted.trim(), "base64").toString("utf8"));

  assert.equal(config.club, "x3222665");
});

test("the setup code is plain base64, decodable by atob", () => {
  // atob rejects the URL-safe alphabet, so a switch to base64url here would
  // break every tablet's setup screen while still looking like base64.
  const blob = buildConfigBlob("https://example.workers.dev", generateClubId(), generateSecret());

  assert.match(blob, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.doesNotMatch(blob, /[-_]/);

  const decoded = JSON.parse(atob(blob));
  assert.equal(typeof decoded.secret, "string");
});

test("the setup code round-trips a secret containing base64 punctuation", () => {
  // A generated secret is itself base64, so + / and = are ordinary content. The
  // JSON layer has to carry them through untouched.
  const secret = "GDAKdFijI/vSBhgyIOxNQyr8sq4l6p1195jls2IgvXI=";

  const blob = buildConfigBlob("https://example.workers.dev", "x3222665", secret);
  const config = JSON.parse(Buffer.from(blob, "base64").toString("utf8"));

  assert.equal(config.secret, secret);
});

test("the setup code carries the secret in the clear", () => {
  // Asserted, not lamented. The blob is a credential — spec §2.1 — and a test
  // claiming otherwise would be the start of someone treating it as safe to
  // email. If this ever stops being true, this test should fail and the
  // handling guidance in SETUP.md should be revisited at the same time.
  const secret = generateSecret();
  const blob = buildConfigBlob("https://example.workers.dev", "x3222665", secret);

  assert.ok(
    Buffer.from(blob, "base64").toString("utf8").includes(secret),
    "the setup code is expected to contain the secret verbatim"
  );
});
