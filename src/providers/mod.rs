pub mod apple;
pub mod feishu;
pub mod message;
pub mod presets;
pub mod registry;
pub mod template;

use crate::model::RelayEvent;
use anyhow::Result;
// Providers own their wire protocol. Routing and persistence remain provider-independent.
pub trait SourceAdapter: Send + Sync {
    fn descriptor(&self) -> serde_json::Value;
    fn signature_header(&self) -> &'static str;
    fn verify(&self, raw: &[u8], signature: &str, secret: &str) -> Result<()>;
    fn normalize(&self, raw: &[u8], source_name: &str) -> Result<RelayEvent>;
}
pub struct DeliveryResponse {
    pub success: bool,
    pub retryable: bool,
    pub code: Option<i64>,
    pub error: Option<&'static str>,
}
pub trait DestinationAdapter: Send + Sync {
    fn descriptor(&self) -> serde_json::Value;
    fn validate_url(&self, value: &str, mock_origin: Option<&str>) -> Result<()>;
    fn classify(&self, status: u16, body: &[u8]) -> DeliveryResponse;
    fn validate_payload(&self, payload: &serde_json::Value) -> Result<()>;
    fn render_content(
        &self,
        content: &message::Content,
        presentation: &message::Presentation,
    ) -> Result<serde_json::Value>;
    fn prepare(
        &self,
        payload: serde_json::Value,
        secret: Option<&str>,
        timestamp: i64,
    ) -> Result<serde_json::Value>;
}
