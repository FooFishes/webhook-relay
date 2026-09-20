CREATE TABLE resources (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
    config TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX resources_kind ON resources(kind);
CREATE TABLE events (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    event_type TEXT NOT NULL, payload TEXT NOT NULL, body_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL, UNIQUE(source_id, provider_id)
);
CREATE TABLE deliveries (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
    route_id TEXT NOT NULL, destination_id TEXT NOT NULL,
    snapshot TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, last_error TEXT, UNIQUE(event_id, route_id)
);
CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
CREATE TABLE attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    attempt INTEGER NOT NULL, status TEXT NOT NULL, http_status INTEGER,
    provider_code INTEGER, error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
    resource_id TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX audit_created ON audit(created_at);
-- Append-only through the application and guarded against accidental SQL changes.
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
