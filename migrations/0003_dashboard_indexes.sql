CREATE INDEX events_created ON events(created_at);
CREATE INDEX deliveries_updated ON deliveries(status,updated_at);
CREATE INDEX deliveries_route ON deliveries(route_id,status);
CREATE INDEX deliveries_destination ON deliveries(destination_id,status);
