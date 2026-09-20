// Only implemented adapters are registered. The same descriptors drive the UI.
use super::{DestinationAdapter, SourceAdapter, apple::Apple, feishu::Feishu};
use anyhow::{Result, anyhow};
use serde_json::Value;
pub fn source(id: &str) -> Result<&'static dyn SourceAdapter> {
    match id {
        "apple_app_store_connect" => Ok(&Apple),
        _ => Err(anyhow!("unsupported source provider: {id}")),
    }
}
pub fn destination(id: &str) -> Result<&'static dyn DestinationAdapter> {
    match id {
        "feishu" => Ok(&Feishu),
        _ => Err(anyhow!("unsupported destination provider: {id}")),
    }
}
pub fn sources() -> Vec<Value> {
    vec![Apple.descriptor()]
}
pub fn destinations() -> Vec<Value> {
    vec![Feishu.descriptor()]
}
