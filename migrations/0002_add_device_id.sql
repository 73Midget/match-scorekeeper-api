-- Key squad uploads by device rather than by squad label.
--
-- Squad labels are free text typed at the range, and two tablets at the same
-- match can easily both be labelled "Squad 1". Under the original key that was
-- silent data loss: the second tablet's upload became revision 2 of the first,
-- the list endpoint returned only the newest, and one squad's scores
-- disappeared with no error anywhere.
--
-- device_id is generated once when a tablet is configured and never typed by a
-- person, so two tablets can never collide no matter what anyone names their
-- squad. squad_key stays as a display label and may now be empty.
--
-- SQLite cannot alter a UNIQUE constraint in place, so this rebuilds the
-- table: create the new shape, copy the rows, drop the old, rename.

-- Existing rows predate device ids. They get a placeholder derived from the
-- squad label so the copy satisfies NOT NULL; they are local test data only.
CREATE TABLE squad_uploads_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id        TEXT NOT NULL REFERENCES clubs(club_id) ON DELETE CASCADE,

  -- Identity: which device uploaded this squad, at which match.
  match_key      TEXT NOT NULL,
  device_id      TEXT NOT NULL,
  match_type     TEXT NOT NULL CHECK (match_type IN ('indoor', 'outdoor')),
  revision       INTEGER NOT NULL CHECK (revision >= 1),

  -- Display only. squad_key may be empty: a squad label is optional, and
  -- nothing keys off it any more.
  squad_key      TEXT NOT NULL DEFAULT '',
  squad_label    TEXT NOT NULL DEFAULT '',
  match_label    TEXT NOT NULL DEFAULT '',

  -- Human-readable name for the device, e.g. "Club Tablet 2". Set at config
  -- time and shown on the compile screen so an RO can tell two tablets apart
  -- when both squads carry the same label.
  device_label   TEXT NOT NULL DEFAULT '',

  schema_version INTEGER NOT NULL,
  app_version    TEXT NOT NULL DEFAULT '',
  app_build      TEXT NOT NULL DEFAULT '',
  entry_count    INTEGER NOT NULL DEFAULT 0,

  content_hash   TEXT NOT NULL,
  payload        TEXT NOT NULL,
  uploaded_at    INTEGER NOT NULL,

  merged_into_roster_revision INTEGER,

  UNIQUE (club_id, match_key, device_id, revision),
  CHECK (length(device_id) > 0),
  CHECK (length(content_hash) = 64)
);

INSERT INTO squad_uploads_new
  (id, club_id, match_key, device_id, match_type, revision,
   squad_key, squad_label, match_label, device_label,
   schema_version, app_version, app_build, entry_count,
   content_hash, payload, uploaded_at, merged_into_roster_revision)
SELECT
  id, club_id, match_key,
  'legacy-' || squad_key,   -- placeholder; pre-device-id rows
  match_type, revision,
  squad_key, squad_label, match_label,
  '',
  schema_version, app_version, app_build, entry_count,
  content_hash, payload, uploaded_at, merged_into_roster_revision
FROM squad_uploads;

DROP TABLE squad_uploads;
ALTER TABLE squad_uploads_new RENAME TO squad_uploads;

-- Newest revision for one device at one match.
CREATE INDEX idx_squad_lookup
  ON squad_uploads (club_id, match_key, device_id, revision DESC);

-- Listing what has been uploaded for a match.
CREATE INDEX idx_squad_match_list
  ON squad_uploads (club_id, match_key, uploaded_at DESC);

-- Duplicate detection on re-upload.
CREATE INDEX idx_squad_content_hash
  ON squad_uploads (club_id, match_key, device_id, content_hash);

-- Squads not yet folded into a roster.
CREATE INDEX idx_squad_unmerged
  ON squad_uploads (club_id, merged_into_roster_revision);

-- Answers "has this device uploaded for this club before?" without scanning.
CREATE INDEX idx_squad_device_history
  ON squad_uploads (club_id, device_id, uploaded_at);