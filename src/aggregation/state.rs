use super::{Binding, DeriveOp, Predicate, Rule, Slot, matches, scalar};
use crate::model::RelayEvent;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlushReason {
    Settled,
    Idle,
    MaxWait,
    MaxEvents,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub state: Value,
    pub at: i64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub key: String,
    pub fields: Map<String, Value>,
    pub first_seen: i64,
    pub last_seen: i64,
    /// Changes of the `state` field, for rendering state chains.
    pub history: Vec<Change>,
}
impl Item {
    fn new(key: String, fields: Map<String, Value>, now: i64) -> Self {
        let history = match fields.get("state") {
            Some(state) if !state.is_null() => vec![Change {
                state: state.clone(),
                at: now,
            }],
            _ => vec![],
        };
        Self {
            key,
            fields,
            first_seen: now,
            last_seen: now,
            history,
        }
    }
    // A missing field never erases a value that an earlier event provided.
    fn merge(&mut self, fields: Map<String, Value>, terminal: &[Value], now: i64) {
        let settled = self
            .fields
            .get("state")
            .is_some_and(|s| terminal.contains(s));
        for (name, value) in fields {
            if value.is_null() || (name == "state" && settled) {
                continue;
            }
            if name == "state" && self.fields.get("state") != Some(&value) {
                self.history.push(Change {
                    state: value.clone(),
                    at: now,
                });
            }
            self.fields.insert(name, value);
        }
        self.last_seen = now;
    }
    pub(crate) fn view(&self) -> Value {
        let mut view = self.fields.clone();
        view.insert("_key".into(), json!(self.key));
        view.insert("_first_seen".into(), json!(self.first_seen));
        view.insert("_last_seen".into(), json!(self.last_seen));
        view.insert("_history".into(), json!(self.history));
        Value::Object(view)
    }
    fn fits(&self, expected: &BTreeMap<String, Value>) -> bool {
        expected.iter().all(|(name, want)| {
            let value = self.fields.get(name).unwrap_or(&Value::Null);
            match want {
                Value::Array(choices) => choices.contains(value),
                want => want == value,
            }
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Notice {
    pub id: String,
    pub item: Option<Item>,
}

/// Everything known about one open group. Pure data, so it can be stored and replayed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct GroupState {
    pub slots: BTreeMap<String, Vec<Item>>,
    #[serde(default)]
    pub counts: BTreeMap<String, u64>,
    pub event_count: u32,
    pub opened_at: i64,
    pub last_event_at: i64,
    pub notified: BTreeSet<String>,
}

impl GroupState {
    pub fn open(now: i64) -> Self {
        Self {
            opened_at: now,
            last_event_at: now,
            ..Self::default()
        }
    }

    /// One placeholder item per slot, with every mapped field null.
    pub(crate) fn preview(rule: &Rule) -> Self {
        let mut state = Self::open(0);
        for (name, slot) in rule.slots.iter().filter(|(_, slot)| slot.has_items()) {
            let fields = slot
                .bindings()
                .iter()
                .flat_map(|b| b.map.keys())
                .map(|field| (field.clone(), Value::Null))
                .collect();
            state
                .slots
                .insert(name.clone(), vec![Item::new("preview".into(), fields, 0)]);
        }
        state
    }

    pub fn items(&self, slot: &str) -> &[Item] {
        self.slots.get(slot).map(Vec::as_slice).unwrap_or_default()
    }

    pub fn apply(&mut self, rule: &Rule, event: &RelayEvent, now: i64) -> Vec<Notice> {
        self.event_count += 1;
        self.last_event_at = now;
        for (name, slot) in &rule.slots {
            let terminal: &[Value] = match slot {
                Slot::Keyed { terminal, .. } => terminal,
                _ => &[],
            };
            for binding in slot
                .bindings()
                .iter()
                .filter(|b| matches(&b.event, &event.event_type) && accepts(b, &event.raw))
            {
                if let Slot::Count { .. } = slot {
                    *self.counts.entry(name.clone()).or_default() += 1;
                    continue;
                }
                let key = match &binding.key {
                    Some(pointer) => match event.raw.pointer(pointer).and_then(scalar) {
                        Some(key) => key,
                        None => continue,
                    },
                    // Append items are distinct by arrival; first and last hold a single item.
                    None if matches!(slot, Slot::Append { .. }) => self.event_count.to_string(),
                    None => String::new(),
                };
                let fields = binding
                    .map
                    .iter()
                    .map(|(field, pointer)| {
                        let value = event.raw.pointer(pointer).cloned();
                        (field.clone(), value.unwrap_or(Value::Null))
                    })
                    .collect();
                let items = self.slots.entry(name.clone()).or_default();
                match items.iter_mut().find(|item| item.key == key) {
                    Some(_) if matches!(slot, Slot::First { .. }) => {}
                    Some(item) => item.merge(fields, terminal, now),
                    None => items.push(Item::new(key, fields, now)),
                }
                if let Slot::Append { limit, .. } = slot
                    && items.len() > *limit
                {
                    items.remove(0);
                }
            }
        }
        self.notices(rule)
    }

    fn notices(&mut self, rule: &Rule) -> Vec<Notice> {
        let mut notices = Vec::new();
        for spec in &rule.close.notices {
            if spec.once_per_item {
                let expected = spec.when.any.as_ref().expect("validated predicate");
                for item in self
                    .items(&spec.when.slot)
                    .iter()
                    .filter(|i| i.fits(expected))
                {
                    if !self.notified.contains(&format!("{}:{}", spec.id, item.key)) {
                        notices.push(Notice {
                            id: spec.id.clone(),
                            item: Some(item.clone()),
                        });
                    }
                }
            } else if self.holds(&spec.when) && !self.notified.contains(&spec.id) {
                notices.push(Notice {
                    id: spec.id.clone(),
                    item: None,
                });
            }
        }
        for notice in &notices {
            self.notified.insert(match &notice.item {
                Some(item) => format!("{}:{}", notice.id, item.key),
                None => notice.id.clone(),
            });
        }
        notices
    }

    pub fn holds(&self, predicate: &Predicate) -> bool {
        let items = self.items(&predicate.slot);
        if let Some(expected) = &predicate.all {
            !items.is_empty() && items.iter().all(|i| i.fits(expected))
        } else if let Some(expected) = &predicate.any {
            items.iter().any(|i| i.fits(expected))
        } else if let Some(expected) = &predicate.none {
            !items.iter().any(|i| i.fits(expected))
        } else {
            predicate.exists == Some(!items.is_empty())
        }
    }

    /// The earliest moment a close condition fires.
    pub fn due_at(&self, rule: &Rule) -> (i64, FlushReason) {
        let close = &rule.close;
        let mut due = (self.opened_at + close.max_wait, FlushReason::MaxWait);
        let mut consider = |at: i64, reason| {
            if at < due.0 {
                due = (at, reason);
            }
        };
        if self.event_count >= close.max_events {
            consider(self.last_event_at, FlushReason::MaxEvents);
        }
        if close.when.as_ref().is_some_and(|p| self.holds(p)) {
            consider(self.last_event_at + close.settle, FlushReason::Settled);
        }
        if let Some(idle) = close.idle
            && !close.pending.as_ref().is_some_and(|p| self.holds(p))
        {
            consider(self.last_event_at + idle, FlushReason::Idle);
        }
        due
    }

    /// Slot values as templates see them: single item, list, or derived value.
    pub(crate) fn view(&self, rule: &Rule) -> Value {
        let slots = rule
            .slots
            .iter()
            .map(|(name, slot)| {
                let items = self.items(name);
                let value = match slot {
                    Slot::First { .. } | Slot::Last { .. } => {
                        items.first().map(Item::view).unwrap_or(Value::Null)
                    }
                    Slot::Keyed { .. } | Slot::Append { .. } => {
                        Value::Array(items.iter().map(Item::view).collect())
                    }
                    Slot::Count { .. } => json!(self.counts.get(name).copied().unwrap_or(0)),
                    Slot::Derive { op, of } => self.derive(*op, of),
                };
                (name.clone(), value)
            })
            .collect();
        Value::Object(slots)
    }

    fn derive(&self, op: DeriveOp, of: &[String]) -> Value {
        match op {
            DeriveOp::Worst => {
                // Most severe first. Values outside the list, such as in_progress, are ignored.
                const SEVERITY: [&str; 10] = [
                    "failure",
                    "error",
                    "timed_out",
                    "startup_failure",
                    "cancelled",
                    "action_required",
                    "stale",
                    "success",
                    "neutral",
                    "skipped",
                ];
                of.iter()
                    .filter_map(|source| source.split_once('.'))
                    .flat_map(|(slot, field)| {
                        self.items(slot).iter().filter_map(move |item| {
                            let value = item.fields.get(field)?.as_str()?;
                            SEVERITY.iter().position(|s| *s == value)
                        })
                    })
                    .min()
                    .map_or(Value::Null, |rank| json!(SEVERITY[rank]))
            }
        }
    }
}

fn accepts(binding: &Binding, raw: &Value) -> bool {
    let Some(when) = &binding.when else {
        return true;
    };
    let value = raw.pointer(&when.pointer).unwrap_or(&Value::Null);
    when.one_of
        .as_ref()
        .is_none_or(|choices| choices.contains(value))
        && when
            .not_in
            .as_ref()
            .is_none_or(|choices| !choices.contains(value))
}
