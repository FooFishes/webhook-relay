use super::{Accent, Container, FlushReason, GroupState, Item, Notice, Rule};
use crate::providers::{
    DestinationAdapter,
    message::{self, Block, Content, Presentation},
    template,
};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Renders the group summary sent when the group flushes.
pub fn render(
    rule: &Rule,
    state: &GroupState,
    reason: FlushReason,
    destination: &dyn DestinationAdapter,
) -> Result<Value> {
    compose(
        rule,
        &rule.container,
        state,
        Some(reason),
        None,
        destination,
    )
}

/// Renders an interim notice. `item` is the slot item that triggered it, if any.
pub fn render_notice(
    rule: &Rule,
    notice: &Notice,
    state: &GroupState,
    destination: &dyn DestinationAdapter,
) -> Result<Value> {
    let spec = rule
        .close
        .notices
        .iter()
        .find(|n| n.id == notice.id)
        .ok_or_else(|| anyhow!("unknown notice: {}", notice.id))?;
    let item = notice.item.as_ref().map(Item::view);
    compose(rule, &spec.container, state, None, item, destination)
}

fn compose(
    rule: &Rule,
    container: &Container,
    state: &GroupState,
    reason: Option<FlushReason>,
    item: Option<Value>,
    destination: &dyn DestinationAdapter,
) -> Result<Value> {
    let slots = state.view(rule);
    let group = json!({
        "event_count": state.event_count,
        "opened_at": state.opened_at,
        "span": state.last_event_at - state.opened_at,
        "flush_reason": reason,
    });
    let text = |source: &str, item: Option<&Value>| -> Result<String> {
        let mut context = json!({"slots": slots, "group": group});
        if let Some(item) = item {
            context["item"] = item.clone();
        }
        template::render_str(source, minijinja::Value::from_serialize(&context))
    };
    let mut blocks = Vec::new();
    let mut block_styles = BTreeMap::new();
    for block in &container.blocks {
        let bound: Option<Vec<Value>> = block
            .bind
            .as_ref()
            .map(|slot| state.items(slot).iter().map(Item::view).collect());
        let (body, url) = match (&bound, block.kind.as_str()) {
            (Some(items), "repeat") => {
                let limit = block.limit.unwrap_or(20);
                let mut rows = items
                    .iter()
                    .take(limit)
                    .map(|item| text(&block.text, Some(item)))
                    .collect::<Result<Vec<_>>>()?;
                if items.len() > limit {
                    rows.push(format!("另有 {} 项", items.len() - limit));
                }
                (rows.join("\n"), None)
            }
            // A bound block shows the latest item and disappears while the slot is empty.
            (Some(items), _) => {
                let Some(latest) = items.last() else { continue };
                let url = block.url.as_deref().map(|u| text(u, Some(latest)));
                (text(&block.text, Some(latest))?, url.transpose()?)
            }
            (None, _) => {
                let url = block.url.as_deref().map(|u| text(u, item.as_ref()));
                (text(&block.text, item.as_ref())?, url.transpose()?)
            }
        };
        blocks.push(Block {
            id: block.id.clone(),
            kind: if block.kind == "link" { "link" } else { "text" }.into(),
            label: block.label.clone(),
            text: body,
            url,
        });
        if let Some(style) = &block.style {
            block_styles.insert(block.id.clone(), style.clone());
        }
    }
    let accent = match &container.accent {
        None => None,
        Some(Accent::Fixed(accent)) => Some(accent.clone()),
        Some(Accent::BySlot { slot, map }) => slots[slot]
            .as_str()
            .and_then(|value| map.get(value))
            .or_else(|| map.get("*"))
            .cloned(),
    };
    let content = Content {
        title: text(&container.title, item.as_ref())?,
        blocks,
    };
    let presentation = Presentation {
        style: container.style.clone(),
        accent,
        block_styles,
    };
    message::finish(content, &presentation, destination)
}
