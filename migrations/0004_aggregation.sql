-- deliveries is rebuilt inside the migration transaction. Deferred foreign keys let
-- attempts point at the dropped table until the rows are inserted again.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE aggregates (
    id TEXT PRIMARY KEY, route_id TEXT NOT NULL, rule_id TEXT NOT NULL,
    group_key TEXT NOT NULL, state TEXT NOT NULL,
    snapshot TEXT NOT NULL, group_state TEXT NOT NULL,
    event_count INTEGER NOT NULL, opened_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, due_at INTEGER NOT NULL,
    flush_reason TEXT, flushed_at INTEGER
);
CREATE UNIQUE INDEX aggregates_open ON aggregates(route_id, rule_id, group_key) WHERE state = 'open';
CREATE INDEX aggregates_due ON aggregates(state, due_at);
CREATE INDEX aggregates_route ON aggregates(route_id, state);
CREATE TABLE aggregate_members (
    aggregate_id TEXT NOT NULL REFERENCES aggregates(id),
    event_id TEXT NOT NULL REFERENCES events(id),
    seq INTEGER NOT NULL,
    PRIMARY KEY (aggregate_id, event_id)
);
CREATE INDEX aggregate_members_event ON aggregate_members(event_id);
-- A summary and a notice of the same group may share an event, so uniqueness per
-- (event, route) only applies to single-event deliveries.
CREATE TABLE deliveries_copy AS SELECT * FROM deliveries ORDER BY rowid;
DROP TABLE deliveries;
CREATE TABLE deliveries (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
    route_id TEXT NOT NULL, destination_id TEXT NOT NULL,
    snapshot TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, last_error TEXT,
    aggregate_id TEXT REFERENCES aggregates(id)
);
INSERT INTO deliveries(id,event_id,route_id,destination_id,snapshot,status,attempts,max_attempts,next_attempt_at,created_at,updated_at,last_error)
    SELECT id,event_id,route_id,destination_id,snapshot,status,attempts,max_attempts,next_attempt_at,created_at,updated_at,last_error FROM deliveries_copy ORDER BY rowid;
DROP TABLE deliveries_copy;
CREATE UNIQUE INDEX deliveries_single ON deliveries(event_id, route_id) WHERE aggregate_id IS NULL;
CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
CREATE INDEX deliveries_updated ON deliveries(status, updated_at);
CREATE INDEX deliveries_route ON deliveries(route_id, status);
CREATE INDEX deliveries_destination ON deliveries(destination_id, status);
CREATE INDEX deliveries_aggregate ON deliveries(aggregate_id);
