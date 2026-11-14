// The fixture keeps the order and timing of a real relay export (one push, cursors 25-61,
// without the Apple event); payloads carry the fields GitHub sends for each event.
use serde_json::{Value, json};
use webhook_relay::{
    aggregation::{self, FlushReason, Policy},
    model::RelayEvent,
    providers::{SourceAdapter, feishu::Feishu, github::GitHub, registry},
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
        let source = registry::source(&preset.source_provider)
            .unwrap()
            .descriptor();
        if let Err(error) = aggregation::validate(&policy, &source, &Feishu) {
            panic!("{}: {error}", preset.id);
        }
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

fn at(seconds: i64, event_type: &str, raw: Value) -> (i64, RelayEvent) {
    let event = RelayEvent {
        id: format!("{event_type}-{seconds}"),
        event_type: event_type.into(),
        source_name: "来源".into(),
        summary: String::new(),
        raw,
    };
    (seconds, event)
}

fn fold(
    preset: &str,
    source: &str,
    events: &[(i64, RelayEvent)],
) -> (aggregation::SimGroup, Vec<String>) {
    let policy = aggregation::resolve(&json!({"rules":[{"preset":preset}]}), source).unwrap();
    let groups = aggregation::simulate(&policy, events);
    assert_eq!(groups.len(), 1, "{preset} folds the burst into one group");
    let group = groups.into_iter().next().unwrap();
    let payload =
        aggregation::render(&policy.rules[0], &group.state, group.reason, &Feishu).unwrap();
    (group, texts(&payload))
}

#[test]
fn other_presets_fold_their_bursts() {
    let repo = json!({"full_name": "octo-org/hello-world", "html_url": "https://github.com/octo-org/hello-world", "stargazers_count": 12});
    let url = "https://github.com/octo-org/hello-world/pull/42";
    let pr = json!({"number": 42, "title": "修复登录页", "html_url": url, "user": {"login": "alice"}, "head": {"ref": "fix/login"}, "base": {"ref": "main"}});
    let (group, texts) = fold(
        "github.pr_activity",
        "github",
        &[
            at(
                0,
                "pull_request.opened",
                json!({"action": "opened", "pull_request": pr, "repository": repo, "sender": {"login": "alice"}}),
            ),
            at(
                1,
                "pull_request.review_requested",
                json!({"action": "review_requested", "pull_request": pr, "repository": repo, "sender": {"login": "alice"}, "requested_reviewer": {"login": "bob"}}),
            ),
            at(
                30,
                "pull_request_review.submitted",
                json!({"action": "submitted", "pull_request": pr, "repository": repo, "review": {"id": 7, "user": {"login": "bob"}, "state": "approved", "body": "LGTM"}}),
            ),
            at(
                60,
                "issue_comment.created",
                json!({"action": "created", "issue": {"number": 42, "title": "修复登录页", "html_url": url, "pull_request": {"html_url": url}}, "repository": repo, "comment": {"user": {"login": "carol"}, "body": "感谢"}}),
            ),
        ],
    );
    assert_eq!((group.flushed_at, group.reason), (180, FlushReason::Idle));
    assert_eq!(
        texts[..6],
        [
            "octo-org/hello-world #42 修复登录页",
            "alice · fix/login → main",
            "alice 打开了\nalice 请求评审 bob",
            "✅ 批准 · bob：LGTM",
            "💬 carol：感谢",
            "共 4 条事件",
        ]
    );

    let star = |seconds, login: &str| {
        at(
            seconds,
            "star.created",
            json!({"action": "created", "repository": repo, "sender": {"login": login}}),
        )
    };
    let (_, texts) = fold(
        "github.repo_attention",
        "github",
        &[
            star(0, "a"),
            star(10, "b"),
            star(20, "a"),
            at(
                30,
                "fork",
                json!({"forkee": {}, "repository": repo, "sender": {"login": "c"}}),
            ),
        ],
    );
    assert_eq!(
        texts[1..4],
        ["⭐ +3 · 🍴 +1", "来自：a、b、c", "当前共 12 个 Star"]
    );

    let version = |seconds, old: &str, new: &str| {
        at(
            seconds,
            "appStoreVersionAppVersionStateUpdated",
            json!({"data": {
        "type": "appStoreVersionAppVersionStateUpdated", "attributes": {"oldValue": old, "newValue": new},
        "relationships": {"instance": {"data": {"id": "version-1"}}}}}),
        )
    };
    let (group, texts) = fold(
        "apple.version_review",
        "apple_app_store_connect",
        &[
            version(0, "PREPARE_FOR_SUBMISSION", "WAITING_FOR_REVIEW"),
            version(100, "WAITING_FOR_REVIEW", "IN_REVIEW"),
            version(200, "IN_REVIEW", "PENDING_DEVELOPER_RELEASE"),
        ],
    );
    assert_eq!(
        (group.flushed_at, group.reason),
        (205, FlushReason::Settled)
    );
    assert_eq!(
        texts[1],
        "状态变化：PREPARE_FOR_SUBMISSION → WAITING_FOR_REVIEW → IN_REVIEW → PENDING_DEVELOPER_RELEASE"
    );
}
