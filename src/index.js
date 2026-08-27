/**
 * Match Scorekeeper backend.
 *
 * Cloudflare Worker exposing a small JSON API for uploading squad scores and
 * syncing club rosters. See migrations/ for the database schema.
 */

/**
 * Build a JSON response.
 *
 * Every endpoint returns JSON, so this keeps the content-type in one place
 * rather than repeating it — and repeated boilerplate is where a wrong header
 * eventually slips in.
 *
 * @param {unknown} body   Anything JSON-serializable.
 * @param {number}  status HTTP status code.
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Build a JSON error response.
 *
 * `code` is a stable, machine-readable string the app can branch on;
 * `message` is for a human reading logs. Keeping them separate means the
 * wording can change without breaking client code that checks the code.
 *
 * @param {number} status HTTP status code.
 * @param {string} code   Stable identifier, e.g. "not_found".
 * @param {string} message Human-readable explanation.
 * @returns {Response}
 */
function error(status, code, message) {
  return json({ error: { code, message } }, status);
}

/**
 * Compute the hex SHA-256 of a string.
 *
 * Used for two unrelated things: hashing the shared secret to compare against
 * clubs.secret_hash, and hashing payloads so a repeated upload can be
 * recognized as a duplicate rather than stored twice.
 *
 * @param {string} text
 * @returns {Promise<string>} 64 lowercase hex characters.
 */
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  // digest is an ArrayBuffer; convert each byte to two hex characters.
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compare two strings in constant time.
 *
 * A plain === returns as soon as it finds a difference, so the time it takes
 * leaks how many leading characters were correct. Given enough attempts that
 * is enough to recover a secret one character at a time. This always inspects
 * every character, so the timing carries no information.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  // Lengths are compared normally: the length of a hash is not a secret, and
  // both sides here are always 64-character hex strings anyway.
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Authenticate a tablet request against a club's shared secret.
 *
 * The tablet sends the raw secret as a bearer token. We hash what arrives and
 * compare it to the stored hash, so the secret itself is never in the
 * database. Failures return a generic message on purpose: telling a caller
 * whether the club exists or only the secret was wrong hands them information
 * they have not earned.
 *
 * @param {Request} request
 * @param {object}  env
 * @param {string}  clubId Club from the URL path.
 * @returns {Promise<{ ok: true } | { ok: false, response: Response }>}
 */
async function authenticateClub(request, env, clubId) {
  const header = request.headers.get("authorization") ?? "";

  // Expect exactly "Bearer <secret>". Anything else is malformed.
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) {
    return {
      ok: false,
      response: error(401, "unauthorized", "Missing or malformed Authorization header"),
    };
  }
  const presented = match[1];

  // Bind clubId as a parameter rather than building the SQL string. A club id
  // is caller-supplied, and concatenating it into SQL is how injection
  // happens. D1 sends parameters separately from the statement, so the value
  // can never be read as SQL.
  const club = await env.DB.prepare(
    "SELECT club_id, secret_hash, active FROM clubs WHERE club_id = ?1"
  )
    .bind(clubId)
    .first();

  if (!club || club.active !== 1) {
    // Hash anyway before returning, so a request for a nonexistent club takes
    // about as long as one with a wrong secret. Otherwise response time alone
    // reveals which club ids are real.
    await sha256Hex(presented);
    return { ok: false, response: error(401, "unauthorized", "Invalid club or secret") };
  }

  const presentedHash = await sha256Hex(presented);
  if (!timingSafeEqual(presentedHash, club.secret_hash)) {
    return { ok: false, response: error(401, "unauthorized", "Invalid club or secret") };
  }

  return { ok: true };
}

export default {
  /**
   * Entry point: runs once per incoming HTTP request.
   *
   * @param {Request} request
   * @param {object}  env  Bindings from wrangler.jsonc; env.DB is the database.
   * @param {object}  ctx  Execution context (unused for now).
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Liveness check. Deliberately requires no auth and touches no data, so it
    // can answer even when the database is unreachable.
    if (path === "/health" && request.method === "GET") {
      return json({ ok: true, service: "match-scorekeeper-api" });
    }

        // Auth smoke test. Real routes come next; this exists to confirm the
    // secret check works end to end before anything depends on it.
    const authTest = /^\/v1\/clubs\/([^/]+)\/ping$/.exec(path);
    if (authTest && request.method === "GET") {
      const clubId = decodeURIComponent(authTest[1]);
      const auth = await authenticateClub(request, env, clubId);
      if (!auth.ok) return auth.response;
      return json({ ok: true, club: clubId });
    }

    // Anything unrecognized. Returning 404 rather than a friendly default
    // means a typo in a client URL fails loudly instead of looking like it
    // worked.
    return error(404, "not_found", `No route for ${request.method} ${path}`);
  },
};