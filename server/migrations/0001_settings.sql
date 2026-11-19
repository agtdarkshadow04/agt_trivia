-- Dashboard settings (CFG-6): one row per EDITABLE_SETTINGS key the Admin has
-- set, the value as JSON. Keys config.yaml sets are never written (CFG-8).
CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
