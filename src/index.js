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

    // Anything unrecognized. Returning 404 rather than a friendly default
    // means a typo in a client URL fails loudly instead of looking like it
    // worked.
    return error(404, "not_found", `No route for ${request.method} ${path}`);
  },
};