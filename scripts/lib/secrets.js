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

/**
 * Print the setup code, optionally as a scannable QR.
 *
 * Shared so create-club and rotate-secret cannot drift in how they present a
 * credential — the wording around it is doing real work.
 *
 * The QR is rendered in the terminal rather than saved as an image, and that is
 * deliberate. An image file exists to be sent somewhere, which is exactly what
 * a setup code must not be. Terminal output is gone when the window closes.
 *
 * qrcode is imported only when asked for, so a failed or skipped install of it
 * cannot stop a club being created.
 *
 * @param {string}  setupCode Base64 configuration for a tablet.
 * @param {boolean} withQr    Also render a scannable code.
 */
export async function printSetupCode(setupCode, withQr) {
  console.log("  Setup code (paste into the app's Connection screen):\n");
  console.log("  " + setupCode + "\n");
  console.log("  This contains the secret. Anyone who has it can upload for this club.\n");

  if (!withQr) {
    console.log("  Pass --qr to also show a scannable code.\n");
    return;
  }

  let QRCode;
  try {
    QRCode = (await import("qrcode")).default;
  } catch {
    console.log("  Could not load the QR library. Run: npm install qrcode\n");
    return;
  }

  console.log("  Scan with the tablet's camera, then paste into the app:\n");
  console.log(await QRCode.toString(setupCode, { type: "terminal", small: true }));
  console.log("  Anyone who can see this screen can photograph it. Close the window");
  console.log("  when the tablets are set up.\n");
}