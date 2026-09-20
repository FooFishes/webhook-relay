use crate::{model::RelayEvent, providers::SourceAdapter};
use anyhow::{Result, anyhow, ensure};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

pub struct Apple;
impl SourceAdapter for Apple {
    fn descriptor(&self) -> Value {
        descriptor()
    }
    fn signature_header(&self) -> &'static str {
        "x-apple-signature"
    }
    fn verify(&self, raw: &[u8], signature: &str, secret: &str) -> Result<()> {
        let digest = hex::decode(
            signature
                .strip_prefix("hmacsha256=")
                .ok_or_else(|| anyhow!("invalid signature"))?,
        )?;
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
        mac.update(raw);
        mac.verify_slice(&digest)
            .map_err(|_| anyhow!("invalid signature"))
    }
    fn normalize(&self, raw: &[u8], source_name: &str) -> Result<RelayEvent> {
        let raw: Value = serde_json::from_slice(raw)?;
        let d = &raw["data"];
        let id = d["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or_else(|| anyhow!("data.id is required"))?
            .to_owned();
        let event_type = d["type"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or_else(|| anyhow!("data.type is required"))?
            .to_owned();
        ensure!(d.is_object(), "data must be an object");
        let a = &d["attributes"];
        let old = a["oldValue"]
            .as_str()
            .or(a["oldExternalBuildState"].as_str())
            .unwrap_or("—");
        let new = a["newValue"]
            .as_str()
            .or(a["newExternalBuildState"].as_str())
            .or(a["newState"].as_str())
            .unwrap_or("收到新事件");
        let instance = d
            .pointer("/relationships/instance/data/id")
            .and_then(Value::as_str)
            .unwrap_or("—");
        // Retain the legacy summary contract; event templates use their native fields.
        let summary = if event_type == "webhookPingCreated" {
            "已收到 App Store Connect 连通性测试通知。".to_owned()
        } else {
            format!("{old} → {new}\n资源 ID: {instance}")
        };
        Ok(RelayEvent {
            id,
            event_type,
            source_name: source_name.into(),
            summary,
            raw,
        })
    }
}

fn descriptor() -> Value {
    let definitions: Value =
        serde_json::from_str(include_str!("apple_events.json")).expect("Apple event definitions");
    let names: serde_json::Map<String, Value> = definitions
        .as_object()
        .unwrap()
        .iter()
        .map(|(kind, definition)| (kind.clone(), definition["name"].clone()))
        .collect();
    json!({"id":"apple_app_store_connect","name":"Apple App Store Connect","category":"应用发布",
      "fields":[{"key":"key_id","label":"Webhook 验签密钥","required":true,"type":"secret","role":"verification"}],
      "defaults":{"key_id":""},
      "event_types":names,
      "sample":definitions["appStoreVersionAppVersionStateUpdated"]["sample"],
      "event_definitions":definitions
    })
}
