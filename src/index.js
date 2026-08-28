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

/**
 * Read and parse a JSON request body.
 *
 * Returns a discriminated result rather than throwing, so callers handle a bad
 * body the same way they handle any other validation failure. A malformed body
 * is a client mistake, not an exceptional condition.
 *
 * @param {Request} request
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, response: Response }>}
 */
async function readJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: error(400, "bad_request", "Could not read request body") };
  }

  if (text.length === 0) {
    return { ok: false, response: error(400, "bad_request", "Request body is empty") };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: error(400, "bad_request", "Request body is not valid JSON") };
  }
}

/**
 * Validate the upload envelope a tablet sends.
 *
 * Checked here rather than relying on database constraints alone, for two
 * reasons: the caller gets a message naming the offending field instead of a
 * raw SQL error, and the checks that are not expressible as constraints
 * (payload must be a string, entry_count must be a non-negative integer) live
 * alongside the ones that are.
 *
 * @param {unknown} body
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateSquadUpload(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Body must be a JSON object" };
  }

  /** Fields that must be present, non-empty strings. */
  const requiredStrings = ["match_key", "squad_key", "match_type", "payload"];
  for (const field of requiredStrings) {
    if (typeof body[field] !== "string" || body[field].length === 0) {
      return { ok: false, message: `Field "${field}" must be a non-empty string` };
    }
  }

  if (body.match_type !== "indoor" && body.match_type !== "outdoor") {
    return { ok: false, message: 'Field "match_type" must be "indoor" or "outdoor"' };
  }

  if (!Number.isInteger(body.schema_version) || body.schema_version < 1) {
    return { ok: false, message: 'Field "schema_version" must be a positive integer' };
  }

  // entry_count is advisory — it lets the list endpoint report squad sizes
  // without reading payloads. Absent is fine; nonsense is not.
  const entryCount = body.entry_count ?? 0;
  if (!Number.isInteger(entryCount) || entryCount < 0) {
    return { ok: false, message: 'Field "entry_count" must be a non-negative integer' };
  }

  return {
    ok: true,
    value: {
      match_key: body.match_key,
      squad_key: body.squad_key,
      match_type: body.match_type,
      payload: body.payload,
      schema_version: body.schema_version,
      entry_count: entryCount,
      // Optional provenance. Defaulted rather than required so an older tablet
      // build can still upload.
      match_label: typeof body.match_label === "string" ? body.match_label : "",
      squad_label: typeof body.squad_label === "string" ? body.squad_label : "",
      app_version: typeof body.app_version === "string" ? body.app_version : "",
      app_build: typeof body.app_build === "string" ? body.app_build : "",
    },
  };
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
    
    // Upload one squad's scores. The tablet owns its squad, so this is the
    // only writer for a given (club, match, squad).
    const uploadRoute = /^\/v1\/clubs\/([^/]+)\/squads$/.exec(path);
    if (uploadRoute && request.method === "POST") {
      const clubId = decodeURIComponent(uploadRoute[1]);

      const auth = await authenticateClub(request, env, clubId);
      if (!auth.ok) return auth.response;

      const parsed = await readJsonBody(request);
      if (!parsed.ok) return parsed.response;

      const validated = validateSquadUpload(parsed.value);
      if (!validated.ok) return error(400, "invalid_body", validated.message);

      const upload = validated.value;
      const contentHash = await sha256Hex(upload.payload);

      // If this exact payload is already stored, return the revision it landed
      // as instead of writing a duplicate. A tablet that retries after a
      // dropped connection gets the same answer as the first attempt.
      const existing = await env.DB.prepare(
        `SELECT revision, uploaded_at FROM squad_uploads
          WHERE club_id = ?1 AND match_key = ?2 AND squad_key = ?3
            AND content_hash = ?4
          ORDER BY revision DESC
          LIMIT 1`
      )
        .bind(clubId, upload.match_key, upload.squad_key, contentHash)
        .first();

      if (existing) {
        return json({
          ok: true,
          duplicate: true,
          revision: existing.revision,
          uploaded_at: existing.uploaded_at,
        });
      }

      // Next revision for this squad. Read then write, so a simultaneous
      // upload of the same squad can lose the race — the UNIQUE constraint
      // catches that below and the caller is asked to retry.
      const latest = await env.DB.prepare(
        `SELECT MAX(revision) AS max_revision FROM squad_uploads
          WHERE club_id = ?1 AND match_key = ?2 AND squad_key = ?3`
      )
        .bind(clubId, upload.match_key, upload.squad_key)
        .first();

      const revision = (latest?.max_revision ?? 0) + 1;
      const uploadedAt = Date.now();

      try {
        await env.DB.prepare(
          `INSERT INTO squad_uploads
             (club_id, match_key, squad_key, match_type, revision,
              match_label, squad_label, schema_version, app_version, app_build,
              entry_count, content_hash, payload, uploaded_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
        )
          .bind(
            clubId,
            upload.match_key,
            upload.squad_key,
            upload.match_type,
            revision,
            upload.match_label,
            upload.squad_label,
            upload.schema_version,
            upload.app_version,
            upload.app_build,
            upload.entry_count,
            contentHash,
            upload.payload,
            uploadedAt
          )
          .run();
      } catch (err) {
        // Another upload of this squad claimed the same revision first.
        if (String(err).includes("UNIQUE")) {
          return error(409, "revision_conflict", "Another upload is in progress; retry");
        }
        throw err;
      }

      return json({ ok: true, duplicate: false, revision, uploaded_at: uploadedAt }, 201);
    }


    // List the squads uploaded for one match. Returns metadata only — a
    // tablet deciding what to download should not have to pull every payload
    // to find out what exists.
    const listRoute = /^\/v1\/clubs\/([^/]+)\/matches\/([^/]+)\/squads$/.exec(path);
    if (listRoute && request.method === "GET") {
      const clubId = decodeURIComponent(listRoute[1]);
      const matchKey = decodeURIComponent(listRoute[2]);

      const auth = await authenticateClub(request, env, clubId);
      if (!auth.ok) return auth.response;

      // Only the newest revision of each squad. Older revisions stay in the
      // table as history but are not what a compile should pick up.
      const result = await env.DB.prepare(
        `SELECT s.squad_key, s.squad_label, s.match_type, s.revision,
                s.entry_count, s.app_version, s.app_build, s.uploaded_at,
                s.merged_into_roster_revision
           FROM squad_uploads s
           JOIN (
                 SELECT squad_key, MAX(revision) AS max_revision
                   FROM squad_uploads
                  WHERE club_id = ?1 AND match_key = ?2
                  GROUP BY squad_key
                ) latest
             ON latest.squad_key = s.squad_key
            AND latest.max_revision = s.revision
          WHERE s.club_id = ?1 AND s.match_key = ?2
          ORDER BY s.squad_key`
      )
        .bind(clubId, matchKey)
        .all();

      return json({
        ok: true,
        club: clubId,
        match_key: matchKey,
        squads: result.results,
      });
    }
    // Download one squad's payload. Defaults to the newest revision; an
    // explicit ?revision=N reaches back into the history that append-only
    // uploads preserve.
    const downloadRoute =
      /^\/v1\/clubs\/([^/]+)\/matches\/([^/]+)\/squads\/([^/]+)$/.exec(path);
    if (downloadRoute && request.method === "GET") {
      const clubId = decodeURIComponent(downloadRoute[1]);
      const matchKey = decodeURIComponent(downloadRoute[2]);
      const squadKey = decodeURIComponent(downloadRoute[3]);

      const auth = await authenticateClub(request, env, clubId);
      if (!auth.ok) return auth.response;

      // Absent means "newest". A malformed value is rejected rather than
      // quietly falling back, so a client bug surfaces instead of returning
      // data the caller did not ask for.
      const revisionParam = url.searchParams.get("revision");
      let revision = null;
      if (revisionParam !== null) {
        revision = Number(revisionParam);
        if (!Number.isInteger(revision) || revision < 1) {
          return error(400, "invalid_revision", "Query parameter revision must be a positive integer");
        }
      }

      const statement =
        revision === null
          ? env.DB.prepare(
              `SELECT squad_key, squad_label, match_key, match_label, match_type,
                      revision, schema_version, app_version, app_build,
                      entry_count, content_hash, payload, uploaded_at
                 FROM squad_uploads
                WHERE club_id = ?1 AND match_key = ?2 AND squad_key = ?3
                ORDER BY revision DESC
                LIMIT 1`
            ).bind(clubId, matchKey, squadKey)
          : env.DB.prepare(
              `SELECT squad_key, squad_label, match_key, match_label, match_type,
                      revision, schema_version, app_version, app_build,
                      entry_count, content_hash, payload, uploaded_at
                 FROM squad_uploads
                WHERE club_id = ?1 AND match_key = ?2 AND squad_key = ?3
                  AND revision = ?4`
            ).bind(clubId, matchKey, squadKey, revision);

      const row = await statement.first();

      if (!row) {
        return error(404, "squad_not_found", "No upload found for that club, match, squad, and revision");
      }

      return json({ ok: true, squad: row });
    }


    // Anything unrecognized. Returning 404 rather than a friendly default
    // means a typo in a client URL fails loudly instead of looking like it
    // worked.
    return error(404, "not_found", `No route for ${request.method} ${path}`);
  },
};