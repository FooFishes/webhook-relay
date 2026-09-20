use serde_json::json;
use webhook_relay::{
    crypto::Vault,
    model::RelayEvent,
    providers::{
        DestinationAdapter, SourceAdapter,
        apple::Apple,
        feishu::{DEFAULT_TEMPLATE, Feishu, validate_url},
        template,
    },
};

#[test]
fn apple_official_signature_vector_and_raw_body() {
    let header = "hmacsha256=7f062172b01cb00b53ca068614674a3d982a34062a0f5d37687d5e3377e54657";
    assert!(
        Apple
            .verify(b"Hello, World!", header, "This is my secret")
            .is_ok()
    );
    assert!(
        Apple
            .verify(b"Hello, World!\n", header, "This is my secret")
            .is_err()
    );
    for bad in ["", "sha256=1234", "hmacsha256=xyz", "hmacsha256=00"] {
        assert!(
            Apple
                .verify(b"Hello, World!", bad, "This is my secret")
                .is_err()
        );
    }
}
#[test]
fn feishu_signature_uses_empty_message_and_refreshes_fields() {
    let body = json!({"msg_type":"text","content":{"text":"hello"},"timestamp":"old","sign":"bad"});
    let p = Feishu
        .prepare(body.clone(), Some("secret"), 1_700_000_000)
        .unwrap();
    // Independently generated using Python's hmac.new(b"1700000000\nsecret", b"", sha256).
    assert_eq!(p["timestamp"], "1700000000");
    assert_eq!(p["sign"], "fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=");
    let unsigned = Feishu.prepare(body, None, 1).unwrap();
    assert!(unsigned.get("sign").is_none());
    assert!(unsigned.get("timestamp").is_none());
}
#[test]
fn templates_escape_json_and_reject_missing_fields() {
    let event = RelayEvent {
        id: "123".into(),
        event_type: "state".into(),
        source_name: "\"中文\"\n\\".into(),
        summary: "done".into(),
        raw: json!({}),
    };
    let template = serde_json::from_str(DEFAULT_TEMPLATE).unwrap();
    let output = template::render_for(&template, &event, &Feishu).unwrap();
    let roundtrip: serde_json::Value = serde_json::from_str(&output.to_string()).unwrap();
    assert!(
        roundtrip["content"]["text"]
            .as_str()
            .unwrap()
            .contains(&event.source_name)
    );
    assert!(
        template::render_for(
            &json!({"msg_type":"text","content":{"text":"{{ event.not_here }}"}}),
            &event,
            &Feishu
        )
        .is_err()
    );
    assert!(template::render_for(&json!({"msg_type":"text","content":{"text":"{% for i in range(1000000) %}x{% endfor %}"}}),&event,&Feishu).is_err());
    assert!(
        template::render_for(
            &json!({"msg_type":"text","content":{"text":"x".repeat(21000)}}),
            &event,
            &Feishu
        )
        .is_err()
    );
}
#[test]
fn destination_urls_reject_credentials_queries_and_foreign_hosts() {
    assert!(validate_url("https://open.feishu.cn/open-apis/bot/v2/hook/example", None).is_ok());
    for value in [
        "http://open.feishu.cn/open-apis/bot/v2/hook/a",
        "https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/a",
        "https://name:pass@open.feishu.cn/open-apis/bot/v2/hook/a",
        "https://open.feishu.cn/open-apis/bot/v2/hook/a?key=secret",
        "https://127.0.0.1/open-apis/bot/v2/hook/a",
        "https://open.feishu.cn/",
    ] {
        assert!(validate_url(value, None).is_err(), "{value}");
    }
    assert!(
        validate_url(
            "http://127.0.0.1:1234/open-apis/bot/v2/hook/a",
            Some("http://127.0.0.1:1234")
        )
        .is_ok()
    );
}
#[test]
fn vault_random_nonce_and_authentication() {
    let v = Vault::new("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").unwrap();
    let a = v.seal("secret").unwrap();
    let b = v.seal("secret").unwrap();
    assert_ne!(a, b);
    assert_eq!(v.open(&a).unwrap(), "secret");
    let other = Vault::new("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=").unwrap();
    assert!(other.open(&a).is_err());
    assert!(v.open("AAAA").is_err());
}
#[test]
fn apple_normalizes_event_specific_state_fields() {
    for (attrs, expected) in [
        (json!({"newState":"COMPLETE"}), "COMPLETE"),
        (
            json!({"oldExternalBuildState":"A","newExternalBuildState":"B"}),
            "A → B",
        ),
        (json!({"oldValue":"C","newValue":"D"}), "C → D"),
    ] {
        let raw =
            json!({"data":{"id":"event","type":"buildUploadStateUpdated","attributes":attrs}});
        let event = Apple.normalize(raw.to_string().as_bytes(), "app").unwrap();
        assert!(event.summary.contains(expected));
    }
}

#[test]
fn registry_and_legacy_snapshots_preserve_provider_identity() {
    use webhook_relay::{model::DeliverySnapshot, providers::registry};
    assert!(registry::source("unknown").is_err());
    assert!(registry::destination("unknown").is_err());
    let apple = registry::source("apple_app_store_connect").unwrap();
    assert_eq!(apple.descriptor()["id"], "apple_app_store_connect");
    let snapshot:DeliverySnapshot=serde_json::from_value(json!({"url":"https://example.com","signing_secret":null,"payload":{},"route_revision":1,"destination_revision":1})).unwrap();
    assert_eq!(snapshot.provider, "feishu");
    let explicit:DeliverySnapshot=serde_json::from_value(json!({"provider":"another","url":"https://example.com","signing_secret":null,"payload":{},"route_revision":1,"destination_revision":1})).unwrap();
    assert_eq!(explicit.provider, "another");
    assert!(registry::destination(&explicit.provider).is_err());
}

#[test]
fn each_apple_event_has_a_native_feishu_template_and_scoped_fields() {
    use webhook_relay::providers::presets;
    let source = Apple.descriptor();
    let presets = presets::catalog();
    let definitions = source["event_definitions"].as_object().unwrap();
    assert_eq!(definitions.len(), 13);
    assert_eq!(presets.as_array().unwrap().len(), definitions.len());
    for (kind, definition) in definitions {
        let preset = presets
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["event_type"] == *kind)
            .unwrap();
        let raw = &definition["sample"];
        let event = Apple
            .normalize(raw.to_string().as_bytes(), "i山大")
            .unwrap();
        let output = template::render_for(&preset["payload_template"], &event, &Feishu).unwrap();
        assert_eq!(event.raw, *raw);
        let text = output.to_string();
        assert!(text.contains(definition["name"].as_str().unwrap()));
        assert!(!text.contains("{{"));
        assert!(
            !preset["payload_template"]
                .to_string()
                .contains("event.summary")
        );
        if kind == "alternativeDistributionPackageAvailableUpdated" {
            assert!(text.contains("是否可用：否"));
            assert!(text.contains("适用地区：DNK、IRL"));
        }
        if kind == "webhookPingCreated" {
            assert!(!text.contains("资源"));
            assert!(!text.contains('→'));
        }
        let missing = json!({"data":{"id":"missing-optional", "type":kind}});
        let event = Apple
            .normalize(missing.to_string().as_bytes(), "i山大")
            .unwrap();
        let minimal = template::render_for(&preset["payload_template"], &event, &Feishu).unwrap();
        assert!(!minimal.to_string().contains("事件时间："));
        for field in definition["fields"].as_array().unwrap() {
            let payload = json!({"msg_type":"text", "content":{"text":format!("字段：{{{{ {} }}}}",field["expression"].as_str().unwrap())}});
            assert!(
                template::render_for(&payload, &event, &Feishu).is_ok(),
                "{}",
                field["path"]
            );
        }
    }
}

#[test]
fn event_template_selection_is_exact_and_validates_active_templates() {
    let payload_a = json!({"msg_type":"text", "content":{"text":"version-only"}});
    let payload_b = json!({"msg_type":"text", "content":{"text":"ping-only"}});
    let mut config = json!({"event_templates":{
        "appStoreVersionAppVersionStateUpdated":{"active_template_id":"a", "templates":[{"id":"a","name":"版本", "payload_template":payload_a}]},
        "webhookPingCreated":{"active_template_id":"b", "templates":[{"id":"b","name":"测试", "payload_template":payload_b}]}
    }});
    assert_eq!(
        template::select_for_event(&config, "webhookPingCreated"),
        Some(&payload_b)
    );
    assert_eq!(
        template::select_for_event(&config, "appStoreVersionAppVersionStateUpdated"),
        Some(&payload_a)
    );
    assert!(template::select_for_event(&config, "futureEvent").is_none());
    assert!(
        template::validate_event_templates(
            &config["event_templates"],
            &Apple.descriptor(),
            &Feishu
        )
        .is_ok()
    );
    config["event_templates"]["webhookPingCreated"]["active_template_id"] = "missing".into();
    assert!(
        template::validate_event_templates(
            &config["event_templates"],
            &Apple.descriptor(),
            &Feishu
        )
        .is_err()
    );
    let legacy = json!({"payload_template":payload_a});
    assert_eq!(
        template::select_for_event(&legacy, "anything"),
        Some(&payload_a)
    );
}

#[test]
fn builtin_content_is_complete_for_every_event_and_renders_in_every_style() {
    use webhook_relay::providers::message;
    let source = Apple.descriptor();
    let definitions = source["event_definitions"].as_object().unwrap();
    for preset in ["recommended", "default"] {
        let default = json!({"preset":preset,"overrides":{}});
        message::validate(&default, &source, &Feishu).unwrap();
        for (kind, definition) in definitions {
            let mut event = Apple
                .normalize(
                    &serde_json::to_vec(&definition["sample"]).unwrap(),
                    "发布助手",
                )
                .unwrap();
            for style in ["card", "post", "text"] {
                let policy =
                    json!({"preset":preset,"overrides":{kind:{"presentation":{"style":style}}}});
                message::validate(&policy, &source, &Feishu).unwrap();
                let result = message::render(&policy, &source, &event, &Feishu)
                    .unwrap()
                    .unwrap();
                let output = result.to_string();
                assert!(output.contains("发布助手"));
                assert!(!output.contains("{{"));
                assert!(!output.contains("None"));
                if kind == "webhookPingCreated" {
                    assert!(!output.contains("资源编号"));
                }
            }
            event.raw = json!({"data":{"id":"minimal","type":kind,"attributes":{}}});
            let minimal = message::render(&default, &source, &event, &Feishu)
                .unwrap()
                .unwrap()
                .to_string();
            assert!(!minimal.contains("None"));
            assert!(!minimal.contains("关联资源编号"));
        }
    }
}

#[test]
fn content_overrides_are_event_scoped_and_default_presentation_is_inherited() {
    use webhook_relay::providers::message;
    let source = Apple.descriptor();
    let event = Apple
        .normalize(
            &serde_json::to_vec(&source["event_definitions"]["webhookPingCreated"]["sample"])
                .unwrap(),
            "App",
        )
        .unwrap();
    let mut policy = json!({"preset":"recommended","overrides":{"webhookPingCreated":{"content":{"title":"自定义测试","blocks":[{"id":"a","kind":"text","text":"Webhook 已连接"}]}}}});
    message::validate(&policy, &source, &Feishu).unwrap();
    let rendered = message::render(&policy, &source, &event, &Feishu)
        .unwrap()
        .unwrap();
    assert_eq!(rendered["card"]["header"]["template"], "green");
    assert_eq!(
        rendered["card"]["elements"][0]["text"]["content"],
        "Webhook 已连接"
    );
    let mut other = event.clone();
    other.event_type = "appStoreVersionAppVersionStateUpdated".into();
    assert!(
        !message::render(&policy, &source, &other, &Feishu)
            .unwrap()
            .unwrap()
            .to_string()
            .contains("自定义测试")
    );
    other.event_type = "futureEvent".into();
    assert!(
        message::render(&policy, &source, &other, &Feishu)
            .unwrap()
            .is_none()
    );
    policy["overrides"]["webhookPingCreated"]["presentation"] =
        json!({"block_styles":{"a":"button"}});
    assert!(message::validate(&policy, &source, &Feishu).is_err());
    policy["overrides"]["webhookPingCreated"]["presentation"] = json!({"style":"image"});
    assert!(message::validate(&policy, &source, &Feishu).is_err());
    policy["overrides"]["webhookPingCreated"]["presentation"] =
        json!({"block_styles":{"unknown":"note"}});
    assert!(message::validate(&policy, &source, &Feishu).is_err());
}

#[test]
fn structured_templates_preserve_false_and_reject_unsafe_links() {
    use webhook_relay::providers::message;
    let source = Apple.descriptor();
    let mut raw =
        source["event_definitions"]["alternativeDistributionPackageAvailableUpdated"]["sample"]
            .clone();
    raw["data"]["attributes"]["available"] = false.into();
    let event = Apple
        .normalize(&serde_json::to_vec(&raw).unwrap(), "App")
        .unwrap();
    let rendered = message::render(&message::default_policy(), &source, &event, &Feishu)
        .unwrap()
        .unwrap();
    assert!(rendered.to_string().contains("是否可用：否"));
    let policy = json!({"preset":"default","overrides":{"webhookPingCreated":{"content":{"title":"安全链接","blocks":[{"id":"link","kind":"link","text":"打开","url":"javascript:alert(1)"}]}}}});
    assert!(message::validate(&policy, &source, &Feishu).is_err());
}
