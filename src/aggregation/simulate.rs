use super::{FlushReason, GroupState, Notice, Policy};
use crate::model::RelayEvent;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct SimGroup {
    pub rule: String,
    pub key: String,
    /// Indexes into the replayed events.
    pub members: Vec<usize>,
    pub flushed_at: i64,
    pub reason: FlushReason,
    pub notices: Vec<(i64, Notice)>,
    pub state: GroupState,
}

struct Open {
    rule: usize,
    key: String,
    members: Vec<usize>,
    notices: Vec<(i64, Notice)>,
    state: GroupState,
}

/// Replays timestamped events on a virtual clock and returns groups in flush order.
/// Events the policy does not claim are skipped; they would be delivered one by one.
pub fn simulate(policy: &Policy, events: &[(i64, RelayEvent)]) -> Vec<SimGroup> {
    let mut open: Vec<Open> = Vec::new();
    let mut flushed = Vec::new();
    for (index, (at, event)) in events.iter().enumerate() {
        flush_due(policy, &mut open, &mut flushed, *at);
        let Some((rule, key)) = policy.classify(event) else {
            continue;
        };
        let rule_index = policy.rules.iter().position(|r| r.id == rule.id).unwrap();
        let group = match open
            .iter()
            .position(|g| g.rule == rule_index && g.key == key)
        {
            Some(position) => &mut open[position],
            None => {
                open.push(Open {
                    rule: rule_index,
                    key,
                    members: vec![],
                    notices: vec![],
                    state: GroupState::open(*at),
                });
                open.last_mut().unwrap()
            }
        };
        group.members.push(index);
        let notices = group.state.apply(rule, event, *at);
        group.notices.extend(notices.into_iter().map(|n| (*at, n)));
    }
    flush_due(policy, &mut open, &mut flushed, i64::MAX);
    flushed.sort_by_key(|g: &SimGroup| g.flushed_at);
    flushed
}

fn flush_due(policy: &Policy, open: &mut Vec<Open>, flushed: &mut Vec<SimGroup>, now: i64) {
    let mut index = 0;
    while index < open.len() {
        let rule = &policy.rules[open[index].rule];
        let (due, reason) = open[index].state.due_at(rule);
        if due > now {
            index += 1;
            continue;
        }
        let group = open.remove(index);
        flushed.push(SimGroup {
            rule: rule.id.clone(),
            key: group.key,
            members: group.members,
            flushed_at: due,
            reason,
            notices: group.notices,
            state: group.state,
        });
    }
}
