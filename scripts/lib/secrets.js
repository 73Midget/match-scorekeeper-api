/**
 * Generating and hashing club credentials.
 *
 * Shared between create-club and rotate-secret. The hashing in particular must
 * exist in exactly one place: if two copies ever drift apart, the hash stored
 * in the database stops matching what the Worker computes, and the failure
 * looks like a wrong secret with no hint as to why.
 */

import { randomBytes, createHash } from "node:crypto";

/**
 * Alphabet for generated club ids.
 *
 * No vowels, so an id can never accidentally spell something. No 0/O/1/l/I,
 * which are the characters people misread when checking a config by eye. 27
 * characters at length 8 gives about 2.8e11 possibilities — collisions are not
 * a practical concern even across many self-hosted deployments.
 */
const ID_ALPHABET = "23456789bcdfghjkmnpqrstvwxz";
const ID_LENGTH = 8;

/**
 * Generate a random club id.
 *
 * Ids are generated rather than chosen deliberately. A meaningful id ("njgc")
 * wants to change when a club renames or when two clubs want the same slug —
 * and a club id lives in every tablet's configuration, which is exactly the
 * thing that must never change. A meaningless id never has that pressure.
 *
 * Uses rejection sampling: bytes at or above the largest whole multiple of the
 * alphabet length are discarded rather than folded with %, which would make
 * the first few characters of the alphabet slightly more likely.
 *
 * @returns {string}
 */
export function generateClubId() {
  const limit = Math.floor(256 / ID_ALPHABET.length) * ID_ALPHABET.length;
  let id = "";

  while (id.length < ID_LENGTH) {
    for (const byte of randomBytes(ID_LENGTH)) {
      if (byte >= limit) continue;
      id += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (id.length === ID_LENGTH) break;
    }
  }

  return id;
}

/**
 * Generate a shared secret.
 *
 * 32 random bytes, base64 encoded. High entropy is what makes storing a plain
 * SHA-256 of it safe: there is no dictionary to attack. If this ever becomes a
 * human-chosen passphrase, the storage side must become PBKDF2 or scrypt.
 *
 * @returns {string}
 */
export function generateSecret() {
  return randomBytes(32).toString("base64");
}

/**
 * Hash a secret the same way the Worker does.
 *
 * The Worker hashes the exact bytes of the string it receives, with no
 * trailing newline. This must match byte for byte or nothing authenticates.
 *
 * @param {string} secret
 * @returns {string} 64 lowercase hex characters.
 */
export function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Build the configuration blob a tablet receives.
 *
 * One value to paste instead of three fields to type, which removes three
 * chances to fat-finger something and is what makes generated club ids
 * costless — nobody ever types one.
 *
 * The blob contains the secret in plaintext, so it is itself a credential:
 * a screenshot or an emailed copy is as good as the secret.
 *
 * @param {string} url    Base URL of the deployed Worker.
 * @param {string} clubId
 * @param {string} secret
 * @returns {string} Base64 of the JSON configuration.
 */
export function buildConfigBlob(url, clubId, secret) {
  return Buffer.from(
    JSON.stringify({ url, club: clubId, secret }),
    "utf8"
  ).toString("base64");
}