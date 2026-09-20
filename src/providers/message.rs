//! Source-owned content, destination-owned presentation, and sparse route overrides.
use super::{DestinationAdapter, registry, template};
use crate::model::RelayEvent;
use anyhow::{Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub title: String,
    pub blocks: Vec<Block>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub label: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Presentation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(default)]
    pub block_styles: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Override {
    pub content: Option<Content>,
    #[serde(default)]
    pub presentation: Presentation,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub preset: String,
    #[serde(default)]
    pub overrides: BTreeMap<String, Override>,
}

pub fn pair_presets() -> Value {
    serde_json::from_str(include_str!("presets/apple_feishu_designs.json"))
        .expect("built-in presentation presets")
}

fn parse_policy(value: &Value) -> Result<Policy> {
    ensure!(
        serde_json::to_vec(value)?.len() <= 256 * 1024,
        "message policy exceeds 256 KB"
    );
    let policy: Policy = serde_json::from_value(value.clone())?;
    ensure!(
        matches!(policy.preset.as_str(), "recommended" | "default"),
        "unknown message preset"
    );
    Ok(policy)
}

fn resolve(
    policy: &Policy,
    source: &Value,
    destination: &Value,
    event_type: &str,
) -> Result<(Content, Presentation)> {
    let definition = source["event_definitions"]
        .get(event_type)
        .ok_or_else(|| anyhow!("unsupported source event: {event_type}"))?;
    let mut content: Content = serde_json::from_value(definition["content_template"].clone())?;
    let mut presentation: Presentation =
        serde_json::from_value(destination["default_presentation"].clone())?;
    if policy.preset == "recommended"
        && let Some(pair) = pair_presets().as_array().unwrap().iter().find(|pair| {
            pair["source_provider"] == source["id"]
                && pair["destination_provider"] == destination["id"]
        })
        && let Some(preset) = pair["events"].get(event_type)
    {
        let preset: Override = serde_json::from_value(preset.clone())?;
        if let Some(replacement) = preset.content {
            content = replacement;
        }
        merge(&mut presentation, &preset.presentation);
    }
    if let Some(custom) = policy.overrides.get(event_type) {
        if let Some(replacement) = &custom.content {
            content = replacement.clone();
        }
        merge(&mut presentation, &custom.presentation);
    }
    // A removed content block must not retain an inherited presentation mapping.
    presentation
        .block_styles
        .retain(|id, _| content.blocks.iter().any(|block| &block.id == id));
    Ok((content, presentation))
}

fn merge(base: &mut Presentation, custom: &Presentation) {
    if custom.style.is_some() {
        base.style.clone_from(&custom.style);
    }
    if custom.accent.is_some() {
        base.accent.clone_from(&custom.accent);
    }
    base.block_styles.extend(custom.block_styles.clone());
}

pub fn validate(value: &Value, source: &Value, destination: &dyn DestinationAdapter) -> Result<()> {
    let policy = parse_policy(value)?;
    let descriptor = destination.descriptor();
    let definitions = source["event_definitions"]
        .as_object()
        .ok_or_else(|| anyhow!("source has no event catalog"))?;
    for event_type in policy.overrides.keys() {
        ensure!(
            definitions.contains_key(event_type),
            "unsupported source event: {event_type}"
        );
    }
    for (event_type, definition) in definitions {
        let (content, presentation) = resolve(&policy, source, &descriptor, event_type)?;
        ensure!(
            !content.title.trim().is_empty() && content.title.len() <= 2000,
            "message title is required (max 2000 bytes)"
        );
        ensure!(
            !content.blocks.is_empty() && content.blocks.len() <= 40,
            "message must contain 1..40 blocks"
        );
        let mut ids = HashSet::new();
        for block in &content.blocks {
            ensure!(
                !block.id.is_empty() && block.id.len() <= 128 && ids.insert(&block.id),
                "invalid or duplicate content block id"
            );
            ensure!(
                matches!(block.kind.as_str(), "text" | "link"),
                "unsupported content block kind"
            );
            ensure!(
                block.text.len() <= 16000 && block.label.len() <= 500,
                "content block exceeds length limit"
            );
            if block.kind == "link" {
                ensure!(
                    block.url.as_ref().is_some_and(|s| !s.is_empty()),
                    "link URL is required"
                );
            }
        }
        if let Some(custom) = policy.overrides.get(event_type) {
            for id in custom.presentation.block_styles.keys() {
                ensure!(
                    content.blocks.iter().any(|block| &block.id == id),
                    "style refers to an unknown content block"
                );
            }
        }
        let style = presentation.style.as_deref().unwrap_or("card");
        ensure!(
            descriptor["message_styles"]
                .as_array()
                .is_some_and(|styles| styles.iter().any(|s| s["id"] == style)),
            "unsupported message style"
        );
        ensure!(
            descriptor["accents"]
                .get(presentation.accent.as_deref().unwrap_or("blue"))
                .is_some(),
            "unsupported accent"
        );
        for (id, style) in &presentation.block_styles {
            let block = content.blocks.iter().find(|b| &b.id == id).unwrap();
            ensure!(
                descriptor["block_styles"]
                    .as_array()
                    .is_some_and(|styles| styles.iter().any(|s| s["id"] == *style
                        && s["kinds"]
                            .as_array()
                            .is_some_and(|kinds| kinds.iter().any(|kind| kind == &block.kind)))),
                "unsupported block style"
            );
        }
        template::validate_value(&serde_json::to_value(&content)?)?;
        let event = registry::source(source["id"].as_str().unwrap())?
            .normalize(&serde_json::to_vec(&definition["sample"])?, "预览来源")?;
        render_resolved(&content, &presentation, &event, destination)?;
    }
    Ok(())
}

pub fn render(
    value: &Value,
    source: &Value,
    event: &RelayEvent,
    destination: &dyn DestinationAdapter,
) -> Result<Option<Value>> {
    if source["event_definitions"].get(&event.event_type).is_none() {
        return Ok(None);
    }
    let (content, presentation) = resolve(
        &parse_policy(value)?,
        source,
        &destination.descriptor(),
        &event.event_type,
    )?;
    render_resolved(&content, &presentation, event, destination).map(Some)
}

fn render_resolved(
    content: &Content,
    presentation: &Presentation,
    event: &RelayEvent,
    destination: &dyn DestinationAdapter,
) -> Result<Value> {
    // Render strings before building provider JSON so optional fields can disappear cleanly.
    let mut rendered: Content = serde_json::from_value(template::render_value(
        &serde_json::to_value(content)?,
        event,
    )?)?;
    rendered
        .blocks
        .retain(|block| !block.text.trim().is_empty());
    ensure!(!rendered.title.trim().is_empty(), "rendered title is empty");
    for block in &rendered.blocks {
        if block.kind == "link" {
            let url = url::Url::parse(block.url.as_deref().unwrap_or(""))?;
            ensure!(
                matches!(url.scheme(), "https" | "http"),
                "links must use http or https"
            );
        }
    }
    let payload = destination.render_content(&rendered, presentation)?;
    destination.validate_payload(&payload)?;
    Ok(payload)
}

pub fn default_policy() -> Value {
    json!({"preset":"recommended","overrides":{}})
}
