//! Folds related events into slots, then renders the group through one container.
mod render;
mod simulate;
mod state;
pub mod store;

pub use render::{render, render_notice};
pub use simulate::{SimGroup, simulate};
pub use state::{Change, FlushReason, GroupState, Item, Notice};

use crate::{model::RelayEvent, providers::DestinationAdapter};
use anyhow::{Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub group: Group,
    pub slots: BTreeMap<String, Slot>,
    pub close: Close,
    pub container: Container,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    #[serde(rename = "match")]
    pub events: Vec<String>,
    /// JSON pointers tried in order; the first non-empty value is the group key.
    pub key: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "reduce", rename_all = "snake_case", deny_unknown_fields)]
pub enum Slot {
    First {
        from: Vec<Binding>,
    },
    Last {
        from: Vec<Binding>,
    },
    Keyed {
        from: Vec<Binding>,
        /// Once an item reaches one of these states, later events cannot move it back.
        #[serde(default, rename = "final")]
        terminal: Vec<Value>,
    },
    Derive {
        op: DeriveOp,
        of: Vec<String>,
    },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeriveOp {
    Worst,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<When>,
    pub map: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct When {
    pub pointer: String,
    #[serde(default, rename = "in", skip_serializing_if = "Option::is_none")]
    pub one_of: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_in: Option<Vec<Value>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Close {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<Predicate>,
    #[serde(default)]
    pub settle: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<Predicate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle: Option<i64>,
    pub max_wait: i64,
    #[serde(default = "default_max_events")]
    pub max_events: u32,
    #[serde(default)]
    pub notices: Vec<NoticeSpec>,
}
fn default_max_events() -> u32 {
    200
}
/// Exactly one of `all`, `any`, `none` or `exists` is set; values may be a list of choices.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Predicate {
    pub slot: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub any: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub none: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoticeSpec {
    pub id: String,
    /// Preset option that enables this notice; custom rules leave it empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option: Option<String>,
    pub when: Predicate,
    #[serde(default)]
    pub once_per_item: bool,
    pub container: Container,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Container {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<Accent>,
    pub blocks: Vec<ContainerBlock>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Accent {
    Fixed(String),
    BySlot {
        slot: String,
        map: BTreeMap<String, String>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContainerBlock {
    pub id: String,
    /// `text`, `link`, or `repeat` (one rendered row per item of a keyed slot).
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub source_provider: String,
    pub name: String,
    pub description: String,
    /// Option id to label. Every option defaults to off.
    pub options: BTreeMap<String, String>,
    pub rule: Rule,
}
static PRESETS: LazyLock<Vec<Preset>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../providers/presets/github_aggregations.json"
    ))
    .expect("built-in aggregation presets")
});
pub fn presets() -> &'static [Preset] {
    &PRESETS
}

#[derive(Clone, Debug)]
pub struct Policy {
    pub rules: Vec<Rule>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    rules: Vec<RuleRef>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum RuleRef {
    Preset(PresetRef),
    Custom(Box<Rule>),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PresetRef {
    preset: String,
    #[serde(default)]
    options: BTreeMap<String, bool>,
}

/// Expands preset references in a route's `aggregation` config into concrete rules.
pub fn resolve(value: &Value, source_provider: &str) -> Result<Policy> {
    ensure!(
        serde_json::to_vec(value)?.len() <= 256 * 1024,
        "aggregation exceeds 256 KB"
    );
    let config: Config = serde_json::from_value(value.clone())?;
    let rules = config
        .rules
        .into_iter()
        .map(|rule| match rule {
            RuleRef::Custom(rule) => {
                ensure!(
                    rule.close.notices.iter().all(|n| n.option.is_none()),
                    "notice options are only available in presets"
                );
                Ok(*rule)
            }
            RuleRef::Preset(selected) => {
                let preset = presets()
                    .iter()
                    .find(|p| p.id == selected.preset && p.source_provider == source_provider)
                    .ok_or_else(|| anyhow!("unknown aggregation preset: {}", selected.preset))?;
                for option in selected.options.keys() {
                    ensure!(
                        preset.options.contains_key(option),
                        "unknown preset option: {option}"
                    );
                }
                let mut rule = preset.rule.clone();
                rule.id.clone_from(&preset.id);
                rule.close.notices.retain(|notice| {
                    notice
                        .option
                        .as_ref()
                        .is_none_or(|option| selected.options.get(option) == Some(&true))
                });
                Ok(rule)
            }
        })
        .collect::<Result<_>>()?;
    Ok(Policy { rules })
}

impl Policy {
    /// The first rule whose events match and whose key resolves owns the event.
    pub fn classify(&self, event: &RelayEvent) -> Option<(&Rule, String)> {
        self.rules.iter().find_map(|rule| {
            if !rule
                .group
                .events
                .iter()
                .any(|p| matches(p, &event.event_type))
            {
                return None;
            }
            let key = rule
                .group
                .key
                .iter()
                .find_map(|p| scalar(event.raw.pointer(p)?))?;
            Some((rule, key))
        })
    }
}

pub(crate) fn matches(pattern: &str, event_type: &str) -> bool {
    pattern == "*"
        || pattern == event_type
        || pattern.strip_suffix(".*").is_some_and(|prefix| {
            event_type
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('.'))
        })
}
pub(crate) fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Checks references and timings, then renders every container with placeholder items.
pub fn validate(
    policy: &Policy,
    source: &Value,
    destination: &dyn DestinationAdapter,
) -> Result<()> {
    let catalog = source["event_definitions"]
        .as_object()
        .ok_or_else(|| anyhow!("source has no event catalog"))?;
    let descriptor = destination.descriptor();
    ensure!(policy.rules.len() <= 20, "at most 20 aggregation rules");
    let mut ids = HashSet::new();
    for rule in &policy.rules {
        ensure!(
            !rule.id.is_empty() && rule.id.len() <= 128 && ids.insert(&rule.id),
            "invalid or duplicate aggregation rule id"
        );
        ensure!(
            !rule.name.trim().is_empty() && rule.name.len() <= 200,
            "aggregation rule name is required"
        );
        let in_group = |pattern: &str| {
            catalog.keys().any(|event| {
                matches(pattern, event) && rule.group.events.iter().any(|p| matches(p, event))
            })
        };
        ensure!(
            !rule.group.events.is_empty() && rule.group.events.iter().all(|p| in_group(p)),
            "group matches an unknown event"
        );
        ensure!(
            !rule.group.key.is_empty() && rule.group.key.iter().all(|p| p.starts_with('/')),
            "group key must be a list of JSON pointers"
        );
        for (name, slot) in &rule.slots {
            ensure!(
                !name.is_empty()
                    && name.len() <= 64
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
                "invalid slot name: {name}"
            );
            match slot {
                Slot::Derive { of, .. } => {
                    for source in of {
                        let (slot, field) = source
                            .split_once('.')
                            .ok_or_else(|| anyhow!("derive source must be slot.field"))?;
                        ensure!(
                            !field.is_empty()
                                && rule
                                    .slots
                                    .get(slot)
                                    .is_some_and(|s| !matches!(s, Slot::Derive { .. })),
                            "derive refers to an unknown slot: {slot}"
                        );
                    }
                }
                Slot::First { from } | Slot::Last { from } | Slot::Keyed { from, .. } => {
                    ensure!(!from.is_empty(), "slot {name} has no binding");
                    for binding in from {
                        ensure!(
                            in_group(&binding.event),
                            "binding event is outside the group: {}",
                            binding.event
                        );
                        ensure!(
                            matches!(slot, Slot::Keyed { .. }) == binding.key.is_some(),
                            "keyed slots need a binding key, other slots must not set one"
                        );
                        let pointers = binding
                            .key
                            .iter()
                            .chain(binding.when.iter().map(|w| &w.pointer))
                            .chain(binding.map.values());
                        ensure!(
                            pointers.into_iter().all(|p| p.starts_with('/')),
                            "binding paths must be JSON pointers"
                        );
                    }
                }
            }
        }
        let close = &rule.close;
        let idle = close.idle.unwrap_or(close.max_wait);
        ensure!(
            0 <= close.settle
                && close.settle <= idle
                && idle <= close.max_wait
                && 0 < close.max_wait
                && close.max_wait <= 86_400,
            "close timings must satisfy settle <= idle <= max_wait <= 24h"
        );
        ensure!(
            (1..=500).contains(&close.max_events),
            "max_events must be 1..500"
        );
        let mut notice_ids = HashSet::new();
        for predicate in close
            .when
            .iter()
            .chain(&close.pending)
            .chain(close.notices.iter().map(|n| &n.when))
        {
            check_predicate(rule, predicate)?;
        }
        check_container(rule, &rule.container, &descriptor)?;
        for notice in &close.notices {
            ensure!(
                !notice.id.is_empty() && notice_ids.insert(&notice.id),
                "invalid or duplicate notice id"
            );
            ensure!(
                !notice.once_per_item || notice.when.any.is_some(),
                "once_per_item notices need an `any` predicate"
            );
            check_container(rule, &notice.container, &descriptor)?;
        }
        let preview = GroupState::preview(rule);
        render(rule, &preview, FlushReason::Settled, destination)?;
        for notice in &close.notices {
            let item = notice
                .once_per_item
                .then(|| preview.items(&notice.when.slot).first().cloned())
                .flatten();
            render_notice(
                rule,
                &Notice {
                    id: notice.id.clone(),
                    item,
                },
                &preview,
                destination,
            )?;
        }
    }
    Ok(())
}

fn check_predicate(rule: &Rule, predicate: &Predicate) -> Result<()> {
    ensure!(
        rule.slots
            .get(&predicate.slot)
            .is_some_and(|s| !matches!(s, Slot::Derive { .. })),
        "predicate refers to an unknown slot: {}",
        predicate.slot
    );
    let tests = [
        predicate.all.is_some(),
        predicate.any.is_some(),
        predicate.none.is_some(),
        predicate.exists.is_some(),
    ];
    ensure!(
        tests.iter().filter(|set| **set).count() == 1,
        "predicate needs exactly one of all, any, none or exists"
    );
    Ok(())
}

fn check_container(rule: &Rule, container: &Container, descriptor: &Value) -> Result<()> {
    ensure!(
        !container.title.trim().is_empty() && container.title.len() <= 2000,
        "container title is required"
    );
    ensure!(
        !container.blocks.is_empty() && container.blocks.len() <= 40,
        "container must contain 1..40 blocks"
    );
    ensure!(
        descriptor["message_styles"]
            .as_array()
            .is_some_and(|styles| styles
                .iter()
                .any(|s| s["id"] == container.style.as_deref().unwrap_or("card"))),
        "unsupported message style"
    );
    let accents = match &container.accent {
        None => vec![],
        Some(Accent::Fixed(accent)) => vec![accent],
        Some(Accent::BySlot { slot, map }) => {
            ensure!(
                rule.slots.contains_key(slot),
                "accent refers to an unknown slot"
            );
            map.values().collect()
        }
    };
    ensure!(
        accents
            .iter()
            .all(|a| descriptor["accents"].get(a.as_str()).is_some()),
        "unsupported accent"
    );
    let mut ids = HashSet::new();
    for block in &container.blocks {
        ensure!(
            !block.id.is_empty() && block.id.len() <= 128 && ids.insert(&block.id),
            "invalid or duplicate block id"
        );
        ensure!(
            matches!(block.kind.as_str(), "text" | "link" | "repeat"),
            "unsupported block kind"
        );
        ensure!(
            block.text.len() <= 16000 && block.label.len() <= 500,
            "block exceeds length limit"
        );
        if let Some(bind) = &block.bind {
            let slot = rule
                .slots
                .get(bind)
                .ok_or_else(|| anyhow!("block binds an unknown slot: {bind}"))?;
            ensure!(
                !matches!(slot, Slot::Derive { .. }),
                "derived slots are read through `slots`, not bound"
            );
        }
        if block.kind == "repeat" {
            ensure!(
                block
                    .bind
                    .as_ref()
                    .is_some_and(|b| matches!(rule.slots[b], Slot::Keyed { .. })),
                "repeat blocks must bind a keyed slot"
            );
        }
        ensure!(
            (block.kind == "link") == block.url.is_some(),
            "link blocks need a URL, other blocks must not set one"
        );
        if let Some(style) = &block.style {
            let kind = if block.kind == "link" { "link" } else { "text" };
            ensure!(
                descriptor["block_styles"]
                    .as_array()
                    .is_some_and(|styles| styles.iter().any(|s| s["id"] == *style
                        && s["kinds"]
                            .as_array()
                            .is_some_and(|kinds| kinds.iter().any(|k| k == kind)))),
                "unsupported block style"
            );
        }
    }
    Ok(())
}
