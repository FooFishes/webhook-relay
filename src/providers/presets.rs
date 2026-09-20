use serde_json::Value;

// Templates belong to a source event and destination pair, independently of adapters.
pub fn catalog() -> Value {
    serde_json::from_str(include_str!("presets/apple_feishu.json")).expect("built-in templates")
}
