use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Resource {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub config: String,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceInput {
    pub name: String,
    pub config: Value,
    pub revision: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct RelayEvent {
    pub id: String,
    pub event_type: String,
    pub source_name: String,
    pub summary: String,
    pub raw: Value,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct DeliverySnapshot {
    // Snapshots written before the adapter registry only contained Feishu jobs.
    #[serde(default = "legacy_destination_provider")]
    pub provider: String,
    pub url: String,
    pub signing_secret: Option<String>,
    pub payload: Value,
    pub route_revision: i64,
    pub destination_revision: i64,
}
fn legacy_destination_provider() -> String {
    "feishu".into()
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
