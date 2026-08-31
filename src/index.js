/**
 * Match Scorekeeper backend.
 *
 * Cloudflare Worker exposing a small JSON API for uploading squad scores and
 * syncing club rosters. See migrations/ for the database schema.
 *
 * Squad uploads are keyed by (club, match, device) rather than by squad label.
 * Squad labels are free text typed at the range and two tablets can easily
 * both be labelled "Squad 1"; keying on the device makes a collision
 * impossible no matter what anyone names their squad.
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
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

/**
 * Build a JSON error response.
 *
 * `code` is a stable, machine-readable string the app can branch on;
 * `message` is for a human reading logs. Keeping them separate means the
 * wording can change without breaking client code that checks the code.
 *
 * @param {number} status  HTTP status code.
 * @param {string} code    Stable identifier, e.g. "not_found".
 * @param {string} message Human-readable explanation.
 * @returns {Response}
 */
function error(status, code, message) {
  return json({ error: { code, message } }, status);
}

/**
 * CORS headers for browser clients.
 *
 * The PWA runs from a different origin than the Worker, so browsers require
 * these before they will deliver a response to page JavaScript.
 *
 * Allowing any origin is safe here specifically because authentication is a
 * bearer token, not a cookie. A browser attaches cookies automatically, which
 * is what makes cross-origin requests dangerous for cookie-authenticated APIs;
 * a bearer token has to be set deliberately by code that already holds the
 * secret. A hostile page can reach this API either way — it could always have
 * curled it — but it still cannot authenticate.
 *
 * If cookies or Access-Control-Allow-Credentials are ever added, this reasoning
 * no longer holds and the wildcard must become an allowlist.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  // Cache the preflight so a browser is not asking permission before every
  // request during a match.
  "access-control-max-age": "86400",
};

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
 * raw SQL error, and the checks that are not expressible as constraints live
 * alongside the ones that are.
 *
 * @param {unknown} body
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateSquadUpload(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Body must be a JSON object" };
  }

  // device_id identifies the tablet, not the squad. It is required because it
  // is the upload key; squad_key is only a label and may be empty.
  const requiredStrings = ["match_key", "device_id", "match_type", "payload"];
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
      device_id: body.device_id,
      match_type: body.match_type,
      payload: body.payload,
      schema_version: body.schema_version,
      entry_count: entryCount,
      // Display only, all optional. An older tablet build that omits them can
      // still upload; the rows simply show blank labels on the compile screen.
      squad_key: typeof body.squad_key === "string" ? body.squad_key : "",
      squad_label: typeof body.squad_label === "string" ? body.squad_label : "",
      match_label: typeof body.match_label === "string" ? body.match_label : "",
      device_label: typeof body.device_label === "string" ? body.device_label : "",
      app_version: typeof body.app_version === "string" ? body.app_version : "",
      app_build: typeof body.app_build === "string" ? body.app_build : "",
    },
  };
}

/**
 * Validate a roster push.
 *
 * base_revision is the revision the client compiled from, and it is what makes
 * the write safe: the server rejects the push if the roster has moved on
 * since. Absent means "I believe no roster exists yet", which is only valid
 * against a club that has never pushed one.
 *
 * @param {unknown} body
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateRosterPush(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Body must be a JSON object" };
  }

  if (typeof body.payload !== "string" || body.payload.length === 0) {
    return { ok: false, message: 'Field "payload" must be a non-empty string' };
  }

  if (!Number.isInteger(body.schema_version) || body.schema_version < 1) {
    return { ok: false, message: 'Field "schema_version" must be a positive integer' };
  }

  // null means "compiled against no existing roster". Any other value must be
  // a real revision number.
  const baseRevision = body.base_revision ?? null;
  if (baseRevision !== null && (!Number.isInteger(baseRevision) || baseRevision < 1)) {
    return { ok: false, message: 'Field "base_revision" must be a positive integer or null' };
  }

  const entryCount = body.entry_count ?? 0;
  if (!Number.isInteger(entryCount) || entryCount < 0) {
    return { ok: false, message: 'Field "entry_count" must be a non-negative integer' };
  }

    // Which squad uploads this compile absorbed. The server cannot work this out
  // — it never opens a payload, and the merge rules live in the app — so the
  // client reports it. Optional: a push that omits it simply marks nothing.
  const mergedSquads = body.merged_squads ?? [];
  if (!Array.isArray(mergedSquads)) {
    return { ok: false, message: 'Field "merged_squads" must be an array' };
  }
  for (const entry of mergedSquads) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.match_key !== "string" ||
      typeof entry.device_id !== "string" ||
      !Number.isInteger(entry.revision)
    ) {
      return {
        ok: false,
        message: 'Each merged_squads entry needs match_key, device_id, and revision',
      };
    }
  }

  return {
    ok: true,
    value: {
      payload: body.payload,
      schema_version: body.schema_version,
      base_revision: baseRevision,
      entry_count: entryCount,
      merged_squads: mergedSquads,
      app_version: typeof body.app_version === "string" ? body.app_version : "",
      app_build: typeof body.app_build === "string" ? body.app_build : "",
      author: typeof body.author === "string" ? body.author : "",
    },
  };
}

export default {
  /**
   * Entry point: runs once per incoming HTTP request.
   *
   * Routes are checked in order; the first match returns. Anything that falls
   * through reaches the 404 at the bottom.
   *
   * @param {Request} request
   * @param {object}  env  Bindings from wrangler.jsonc; env.DB is the database.
   * @param {object}  ctx  Execution context (unused for now).
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight. Browsers send OPTIONS before any request carrying an
    // Authorization header and block the real request if it goes unanswered.
    // Handled before routing because the browser is asking whether it may send
    // the request at all, not about any particular endpoint.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Liveness check. Deliberately requires no auth and touches no data, so it
    // can answer even when the database is unreachable.
    if (path === "/health" && request.method === "GET") {
      return json({ ok: true, service: "match-scorekeeper-api" });
    }
    
    // Credential check. Touches no data and returns no data — it exists so a
    // tablet's setup screen can validate a pasted configuration and say
    // plainly whether the club id and secret are good. /health is
    // unauthenticated, so a 200 there proves only that the server is up.
    const pingRoute = /^\/v1\/clubs\/([^/]+)\/ping$/.exec(path);
    if (pingRoute && request.method === "GET") {
    const clubId = decodeURIComponent(pingRoute[1]);

    const auth = await authenticateClub(request, env, clubId);
    if (!auth.ok) return auth.response;

    // The display name is what makes this a useful confirmation. A club id
    // is opaque by design, so an RO comparing "m78p9nw7" by eye cannot tell
    // a valid blob from the right one. Returned only after authentication,
    // so it cannot be used to enumerate which club ids exist.
    const club = await env.DB.prepare(
      "SELECT display_name FROM clubs WHERE club_id = ?1"
      )
        .bind(clubId)
        .first();

      return json({
        ok: true,
        club: clubId,
        club_name: club?.display_name ?? "",
      });    }

        // Squads that no roster push has absorbed yet.
    //
    // Until a compile folds a squad in, any shooter added at check-in on that
    // tablet exists in that upload and nowhere else. This is what catches the
    // case that actually happens: a squad uploads after the RO has already
    // compiled, and nothing else would say so.
    const unmergedRoute = /^\/v1\/clubs\/([^/]+)\/squads\/unmerged$/.exec(path);
    if (unmergedRoute && request.method === "GET") {
      const clubId = decodeURIComponent(unmergedRoute[1]);

      const auth = await authenticateClub(request, env, clubId);
      if (!auth.ok) return auth.response;

      // A match that is never published leaves its uploads unclaimed forever,
      // so an unbounded list grows without limit and buries the recent
      // arrivals this endpoint exists to surface. The window is also the
      // dismissal mechanism: an abandoned match ages off on its own, and a
      // wider ?days brings it back if someone needs to look.
      const daysParam = url.searchParams.get("days");
      let days = 60;
      if (daysParam !== null) {
        days = Number(daysParam);
        if (!Number.isInteger(days) || days < 1 || days > 3650) {
          return error(400, "invalid_days", "Query parameter days must be an integer between 1 and 3650");
        }
      }
      const cutoff = Date.now() - days * 86400000;

      // Newest revision per device, as elsewhere, then keep only the ones
      // still unmarked. A squad whose newest revision is unmerged needs
      // attention even if an older revision of it was compiled earlier.
      const result = await env.DB.prepare(
        `SELECT s.match_key, s.match_label, s.device_id, s.device_label,
                s.squad_key, s.squad_label, s.match_type, s.revision,
                s.entry_count, s.uploaded_at
           FROM squad_uploads s
           JOIN (
                 SELECT match_key, device_id, MAX(revision) AS max_revision
                   FROM squad_uploads
                  WHERE club_id = ?1
                  GROUP BY match_key, device_id
                ) latest
             ON latest.match_key = s.match_key
            AND latest.device_id = s.device_id
            AND latest.max_revision = s.revision
          WHERE s.club_id = ?1
            AND s.merged_into_roster_revision IS NULL
            AND s.uploaded_at >= ?2
          ORDER BY s.uploaded_at DESC
          LIMIT 200`
      )
        .bind(clubId, cutoff)
        .all();

      return json({
        ok: true,
        club: clubId,
        days,
        unmerged: result.results,
      });
    }

    // ---------------------------------------------------------------------
    // Upload one squad's scores.
    //
    // Keyed by device: one tablet owns its own uploads, so re-uploading
    // creates the next revision of that device's data and never overwrites
    // another tablet's.
    // ---------------------------------------------------------------------
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

      // If this exact payload is already stored for this device, return the
      // revision it landed as instead of writing a duplicate. A tablet
      // retrying after a dropped connection gets the same answer as the first
      // attempt.
      const existing = await env.DB.prepare(
        `SELECT revision, uploaded_at FROM squad_uploads
          WHERE club_id = ?1 AND match_key = ?2 AND device_id = ?3
            AND content_hash = ?4
          ORDER BY revision DESC
          LIMIT 1`
      )
        .bind(clubId, upload.match_key, upload.device_id, contentHash)
        .first();

      if (existing) {
        return json({
          ok: true,
          duplicate: true,
          revision: existing.revision,
          uploaded_at: existing.uploaded_at,
        });
      }

      // Next revision for this device at this match. Read then write, so two
      // simultaneous uploads from the same device could pick the same number —
      // the UNIQUE constraint catches that below.
      const latest = await env.DB.prepare(
        `SELECT MAX(revision) AS max_revision FROM squad_uploads
          WHERE club_id = ?1 AND match_key = ?2 AND device_id = ?3`
      )
        .bind(clubId, upload.match_key, upload.device_id)
        .first();

      const revision = (latest?.max_revision ?? 0) + 1;
      const uploadedAt = Date.now();

      try {
        await env.DB.prepare(
          `INSERT INTO squad_uploads
             (club_id, match_key, device_id, match_type, revision,
              squad_key, squad_label, match_label, device_label,
              schema_version, app_version, app_build,
              entry_count, content_hash, payload, uploaded_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                   ?14, ?15, ?16)`
        )
          .bind(
            clubId,
            upload.match_key,
            upload.device_id,
            upload.match_type,
            revision,
            upload.squad_key,
            upload.squad_label,
            upload.match_label,
            upload.device_label,
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
        // Another upload from this device claimed the same revision first.
        if (String(err).includes("UNIQUE")) {
          return error(409, "revision_conflict", "Another upload is in progress; retry");
        }
        throw err;
      }

      return json({ ok: true, duplicate: false, revision, uploaded_at: uploadedAt }, 201);
    }

    // ---------------------------------------------------------------------
    // List the squads uploaded for one match.
    //
    // Metadata only — a tablet deciding what to compile should not have to
    // pull every payload to find out what exists. `first_upload_for_device`
    // flags a device this club has not seen before, which usually means a
    // borrowed tablet and is worth showing an RO.
    // ---------------------------------------------------------------------
    const listRoute = /^\/v1\/clubs\/([^/]+)\/matches\/([^/]+)\/squads$/.exec(path);
    if (listRoute && request.method === "GET") {
      const clubId = decodeURIComponent(listRoute[1]);
      const matchKey = decodeURIComponent(listRoute[2]);

      const auth = await authenticateClub(request, env, clubId);
      if (!auth.ok) return auth.response;

      // Only the newest revision per device. Older revisions stay in the table
      // as history but are not what a compile should pick up.
      const result = await env.DB.prepare(
        `SELECT s.device_id, s.device_label, s.squad_key, s.squad_label,
                s.match_type, s.revision, s.entry_count,
                s.app_version, s.app_build, s.uploaded_at,
                s.merged_into_roster_revision,
                NOT EXISTS (
                  SELECT 1 FROM squad_uploads prior
                   WHERE prior.club_id = s.club_id
                     AND prior.device_id = s.device_id
                     AND prior.match_key <> s.match_key
                ) AS first_upload_for_device
           FROM squad_uploads s
           JOIN (
                 SELECT device_id, MAX(revision) AS max_revision
                   FROM squad_uploads
                  WHERE club_id = ?1 AND match_key = ?2
                  GROUP BY device_id
                ) latest
             ON latest.device_id = s.device_id
            AND latest.max_revision = s.revision
          WHERE s.club_id = ?1 AND s.match_key = ?2
          ORDER BY s.squad_key, s.device_id`
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

    // ---------------------------------------------------------------------
    // Download one device's payload for a match.
    //
    // Defaults to the newest revision; an explicit ?revision=N reaches back
    // into the history that append-only uploads preserve.
    // ---------------------------------------------------------------------
    const downloadRoute =
      /^\/v1\/clubs\/([^/]+)\/matches\/([^/]+)\/squads\/([^/]+)$/.exec(path);
    if (downloadRoute && request.method === "GET") {
      const clubId = decodeURIComponent(downloadRoute[1]);
      const matchKey = decodeURIComponent(downloadRoute[2]);
      const deviceId = decodeURIComponent(downloadRoute[3]);

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
          return error(
            400,
            "invalid_revision",
            "Query parameter revision must be a positive integer"
          );
        }
      }

      // Two explicit statements rather than one assembled conditionally.
      // Building SQL from pieces is how the parameter-binding habit erodes,
      // and repetition is the cheaper mistake.
      const statement =
        revision === null
          ? env.DB.prepare(
              `SELECT device_id, device_label, squad_key, squad_label,
                      match_key, match_label, match_type, revision,
                      schema_version, app_version, app_build, entry_count,
                      content_hash, payload, uploaded_at
                 FROM squad_uploads
                WHERE club_id = ?1 AND match_key = ?2 AND device_id = ?3
                ORDER BY revision DESC
                LIMIT 1`
            ).bind(clubId, matchKey, deviceId)
          : env.DB.prepare(
              `SELECT device_id, device_label, squad_key, squad_label,
                      match_key, match_label, match_type, revision,
                      schema_version, app_version, app_build, entry_count,
                      content_hash, payload, uploaded_at
                 FROM squad_uploads
                WHERE club_id = ?1 AND match_key = ?2 AND device_id = ?3
                  AND revision = ?4`
            ).bind(clubId, matchKey, deviceId, revision);

      const row = await statement.first();

      if (!row) {
        return error(
          404,
          "squad_not_found",
          "No upload found for that club, match, device, and revision"
        );
      }

      return json({ ok: true, squad: row });
    }

    // ---------------------------------------------------------------------
    // Roster: GET the current one, PUT a newly compiled one.
    //
    // Unlike squads this is multi-writer — any tablet can compile and push —
    // so PUT is conditional on base_revision. Without that check, two people
    // compiling at once means one silently loses every shooter the other
    // added, and a newly checked-in shooter exists nowhere else.
    // ---------------------------------------------------------------------
    const rosterRoute = /^\/v1\/clubs\/([^/]+)\/roster$/.exec(path);

    if (rosterRoute && request.method === "GET") {
      const clubId = decodeURIComponent(rosterRoute[1]);

      const auth = await authenticateClub(request, env, clubId);
      if (!auth.ok) return auth.response;

      const row = await env.DB.prepare(
        `SELECT revision, content_hash, payload, entry_count, schema_version,
                app_version, app_build, base_revision, author, updated_at
           FROM rosters
          WHERE club_id = ?1
          ORDER BY revision DESC
          LIMIT 1`
      )
        .bind(clubId)
        .first();

      // 404 rather than an empty roster: a new tablet treats this as "start
      // from nothing", which is different from "the roster is empty".
      if (!row) {
        return error(404, "roster_not_found", "This club has no roster yet");
      }

      return json({ ok: true, roster: row });
    }

    if (rosterRoute && request.method === "PUT") {
      const clubId = decodeURIComponent(rosterRoute[1]);

      const auth = await authenticateClub(request, env, clubId);
      if (!auth.ok) return auth.response;

      const parsed = await readJsonBody(request);
      if (!parsed.ok) return parsed.response;

      const validated = validateRosterPush(parsed.value);
      if (!validated.ok) return error(400, "invalid_body", validated.message);

      const push = validated.value;

      const current = await env.DB.prepare(
        `SELECT revision, author, updated_at FROM rosters
          WHERE club_id = ?1
          ORDER BY revision DESC
          LIMIT 1`
      )
        .bind(clubId)
        .first();

      const currentRevision = current?.revision ?? null;

      // The conflict check. Naming who pushed and when gives whoever hit this
      // something actionable instead of a bare refusal.
      if (push.base_revision !== currentRevision) {
        return json(
          {
            error: {
              code: "roster_conflict",
              message:
                currentRevision === null
                  ? "Roster was expected to exist but does not"
                  : `Roster has moved to revision ${currentRevision} since this was compiled`,
            },
            current_revision: currentRevision,
            current_author: current?.author ?? null,
            current_updated_at: current?.updated_at ?? null,
          },
          409
        );
      }

      const revision = (currentRevision ?? 0) + 1;
      const contentHash = await sha256Hex(push.payload);
      const updatedAt = Date.now();

      try {
        await env.DB.prepare(
          `INSERT INTO rosters
             (club_id, revision, content_hash, payload, entry_count,
              schema_version, app_version, app_build, base_revision, author,
              updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
        )
          .bind(
            clubId,
            revision,
            contentHash,
            push.payload,
            push.entry_count,
            push.schema_version,
            push.app_version,
            push.app_build,
            push.base_revision,
            push.author,
            updatedAt
          )
          .run();
      } catch (err) {
        // Two pushes passed the check at the same moment; the UNIQUE
        // constraint decided. Same remedy as a conflict: re-read and retry.
        if (String(err).includes("UNIQUE")) {
          return error(409, "roster_conflict", "Another push landed first; re-read and retry");
        }
        throw err;
      }

      // Mark the squad uploads this roster absorbed. Done after the insert so
      // a failed roster write never leaves squads marked as merged into a
      // revision that does not exist.
      //
      // Failure here is deliberately not fatal: the roster is already saved,
      // and the only cost of an unmarked squad is that it still shows as
      // pending on the compile screen. Better a false "not yet merged" than a
      // rejected push whose roster actually landed.
      let markedSquads = 0;
      if (push.merged_squads.length > 0) {
        const statements = push.merged_squads.map((entry) =>
          env.DB.prepare(
            `UPDATE squad_uploads
                SET merged_into_roster_revision = ?1
              WHERE club_id = ?2 AND match_key = ?3 AND device_id = ?4
                AND revision = ?5
                AND merged_into_roster_revision IS NULL`
          ).bind(revision, clubId, entry.match_key, entry.device_id, entry.revision)
        );

        try {
          const results = await env.DB.batch(statements);
          markedSquads = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
        } catch {
          markedSquads = 0;
        }
      }

      return json(
        { ok: true, revision, updated_at: updatedAt, marked_squads: markedSquads },
        201
      );
    }

    // Anything unrecognized. Returning 404 rather than a friendly default
    // means a typo in a client URL fails loudly instead of looking like it
    // worked.
    return error(404, "not_found", `No route for ${request.method} ${path}`);
  },
};