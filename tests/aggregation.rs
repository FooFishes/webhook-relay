// The fixture keeps the order and timing of a real relay export (one push, cursors 25-61,
// without the Apple event); payloads carry the fields GitHub sends for each event.
use serde_json::{Value, json};
use webhook_relay::{
    aggregation::{self, FlushReason, Policy},
    model::RelayEvent,
    providers::{SourceAdapter, feishu::Feishu, github::GitHub},
};

const PUSH_AT: i64 = 1794686621;

fn events() -> Vec<(i64, RelayEvent)> {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/commit_pipeline.json")).unwrap();
    rows.into_iter()
        .map(|row| {
            let event = RelayEvent {
                id: row["cursor"].to_string(),
                event_type: row["event_type"].as_str().unwrap().into(),
                source_name: "GitHub".into(),
                summary: String::new(),
                raw: row["raw"].clone(),
            };
            (row["at"].as_i64().unwrap(), event)
        })
        .collect()
}

fn pipeline(options: Value) -> Policy {
    aggregation::resolve(
        &json!({"rules":[{"preset":"github.commit_pipeline","options":options}]}),
        "github",
    )
    .unwrap()
}

// Card text in reading order, so assertions read like the message.
fn texts(payload: &Value) -> Vec<String> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(o) => {
                if let Some(Value::String(s)) = o.get("content") {
                    out.push(s.clone());
                }
                o.values().for_each(|v| walk(v, out));
            }
            Value::Array(a) => a.iter().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = vec![
        payload["card"]["header"]["title"]["content"]
            .as_str()
            .unwrap()
            .to_owned(),
    ];
    walk(&payload["card"]["elements"], &mut out);
    out
}

#[test]
fn one_push_and_its_pipeline_become_one_message() {
    let events = events();
    let policy = pipeline(json!({}));
    let groups = aggregation::simulate(&policy, &events);
    assert_eq!(
        groups.len(),
        1,
        "the ping stays outside, the rest is one group"
    );
    let group = &groups[0];
    assert_eq!(group.members.len(), 35);
    // workflow_run.completed at +1222, deployment_status at +1223, then 20s of quiet.
    assert_eq!(
        (group.flushed_at - PUSH_AT, group.reason),
        (1243, FlushReason::Settled)
    );
    assert!(group.notices.is_empty());
    let payload =
        aggregation::render(&policy.rules[0], &group.state, group.reason, &Feishu).unwrap();
    assert_eq!(payload["card"]["header"]["template"], "green");
    assert_eq!(
        texts(&payload),
        [
            "octo-org/hello-world · main ✅",
            "feat(deploy): 一键发布到服务器\noctocat · 6dcb09b",
            "✅ test · 9m38s\n✅ lint · 4m00s\n✅ build · 6m13s\n✅ docker · 10m17s\n✅ deploy · 22s",
            "✅ production · success",
            "共 35 条事件 · 耗时 20m23s",
            "查看运行",
            "查看提交",
        ]
    );
}

#[test]
fn a_failed_job_turns_the_summary_red_and_notifies_once() {
    let mut events = events();
    for (_, event) in &mut events {
        if let Some(job) = event.raw.get_mut("workflow_job")
            && job["name"] == "lint"
            && job["status"] == "completed"
        {
            job["conclusion"] = json!("failure");
        }
    }
    assert!(
        aggregation::simulate(&pipeline(json!({})), &events)[0]
            .notices
            .is_empty()
    );
    let policy = pipeline(json!({"notify_failure": true}));
    let group = &aggregation::simulate(&policy, &events)[0];
    // Every later event still matches the failure predicate; only the first one notifies.
    assert_eq!(group.notices.len(), 1);
    let (at, notice) = &group.notices[0];
    assert_eq!(at - PUSH_AT, 823);
    let rule = &policy.rules[0];
    let alert = aggregation::render_notice(rule, notice, &group.state, &Feishu).unwrap();
    assert_eq!(alert["card"]["header"]["template"], "red");
    assert_eq!(texts(&alert)[0], "octo-org/hello-world · lint 失败");
    let summary = aggregation::render(rule, &group.state, group.reason, &Feishu).unwrap();
    assert_eq!(summary["card"]["header"]["template"], "red");
}

#[test]
fn quiet_stuck_and_reordered_pipelines_still_close_correctly() {
    let events = events();
    let policy = pipeline(json!({}));
    let only = |cursors: &[i64]| -> Vec<(i64, RelayEvent)> {
        let mut picked: Vec<_> = events
            .iter()
            .filter(|(_, e)| cursors.contains(&e.id.parse().unwrap()))
            .cloned()
            .collect();
        picked.sort_by_key(|(_, e)| cursors.iter().position(|c| e.id == c.to_string()));
        picked
    };
    // A push without CI waits for the idle timeout.
    let push = aggregation::simulate(&policy, &only(&[26]));
    assert_eq!(
        (push[0].flushed_at - PUSH_AT, push[0].reason),
        (90, FlushReason::Idle)
    );
    // A run that never finishes is not cut short by idle; max_wait reports it as unfinished.
    let stuck = aggregation::simulate(&policy, &only(&[26, 27, 29, 30, 31]));
    assert_eq!(
        (stuck[0].flushed_at - PUSH_AT, stuck[0].reason),
        (7200, FlushReason::MaxWait)
    );
    let payload =
        aggregation::render(&policy.rules[0], &stuck[0].state, stuck[0].reason, &Feishu).unwrap();
    assert!(texts(&payload).iter().any(|t| t.ends_with("· 仍在进行")));
    // GitHub does not guarantee order: a late in_progress must not reopen a completed run.
    let all: Vec<i64> = (25..=61).filter(|c| *c != 48 && *c != 54).collect();
    let mut reordered = only(&all);
    let late = events.iter().find(|(_, e)| e.id == "54").unwrap().1.clone();
    reordered.push((PUSH_AT + 1225, late));
    let groups = aggregation::simulate(&policy, &reordered);
    assert_eq!(groups.len(), 1);
    assert_eq!(
        (groups[0].flushed_at - PUSH_AT, groups[0].reason),
        (1245, FlushReason::Settled)
    );
}

#[test]
fn presets_validate_and_broken_references_are_rejected() {
    let github = GitHub.descriptor();
    for preset in aggregation::presets() {
        let options: serde_json::Map<String, Value> = preset
            .options
            .keys()
            .map(|k| (k.clone(), json!(true)))
            .collect();
        let policy = aggregation::resolve(
            &json!({"rules":[{"preset":preset.id,"options":options}]}),
            &preset.source_provider,
        )
        .unwrap();
        aggregation::validate(&policy, &github, &Feishu).unwrap();
    }
    let mut rule = serde_json::to_value(&pipeline(json!({})).rules[0]).unwrap();
    rule["container"]["blocks"][1]["bind"] = json!("missing");
    let policy = aggregation::resolve(&json!({"rules":[rule]}), "github").unwrap();
    assert!(aggregation::validate(&policy, &github, &Feishu).is_err());
    assert!(
        aggregation::resolve(
            &json!({"rules":[{"preset":"github.commit_pipeline","options":{"nope":true}}]}),
            "github"
        )
        .is_err()
    );
}
