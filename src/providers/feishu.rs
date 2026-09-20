use crate::providers::DestinationAdapter;
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

pub struct Feishu;
impl DestinationAdapter for Feishu {
    fn render_content(
        &self,
        content: &super::message::Content,
        presentation: &super::message::Presentation,
    ) -> Result<Value> {
        let line = |b: &super::message::Block| {
            let text = if b.label.is_empty() {
                b.text.clone()
            } else {
                format!("{}：{}", b.label, b.text)
            };
            if b.kind == "link" {
                format!("{}\n{}", text, b.url.as_deref().unwrap_or(""))
            } else {
                text
            }
        };
        match presentation.style.as_deref().unwrap_or("card") {
            "text" => Ok(
                json!({"msg_type":"text","content":{"text":std::iter::once(content.title.clone()).chain(content.blocks.iter().map(line)).collect::<Vec<_>>().join("\n\n")}}),
            ),
            "post" => {
                let rows: Vec<Value> = content
                    .blocks
                    .iter()
                    .map(|block| {
                        if block.kind == "link" {
                            json!([{"tag":"a","text":block.text,"href":block.url}])
                        } else {
                            json!([{"tag":"text","text":line(block)}])
                        }
                    })
                    .collect();
                Ok(
                    json!({"msg_type":"post","content":{"post":{"zh_cn":{"title":content.title,"content":rows}}}}),
                )
            }
            "card" => {
                let mut elements = Vec::<Value>::new();
                for block in &content.blocks {
                    let style = presentation
                        .block_styles
                        .get(&block.id)
                        .map(String::as_str)
                        .unwrap_or("default");
                    // "default" explicitly removes pair-specific styling for this block.
                    let style = if style == "default" {
                        if block.kind == "link" {
                            "button"
                        } else if !block.label.is_empty() {
                            "field"
                        } else {
                            "text"
                        }
                    } else {
                        style
                    };
                    match style {
                        "field" => {
                            let field = json!({"is_short":true,"text":{"tag":"plain_text","content":line(block)}});
                            if let Some(last) = elements.last_mut().filter(|last| last.get("fields").is_some()) {
                                last["fields"].as_array_mut().unwrap().push(field);
                            } else { elements.push(json!({"tag":"div","fields":[field]})); }
                        }
                        "note" => elements.push(json!({"tag":"note","elements":[{"tag":"plain_text","content":line(block)}]})),
                        "button" => elements.push(json!({"tag":"action","actions":[{"tag":"button","text":{"tag":"plain_text","content":block.text},"type":"primary","url":block.url}]})),
                        _ => elements.push(json!({"tag":"div","text":{"tag":"plain_text","content":line(block)}})),
                    }
                }
                // A valid message can consist solely of a title when optional source fields are absent.
                if elements.is_empty() {
                    elements.push(
                        json!({"tag":"div","text":{"tag":"plain_text","content":content.title}}),
                    );
                }
                Ok(
                    json!({"msg_type":"interactive","card":{"config":{"wide_screen_mode":true},"header":{"title":{"tag":"plain_text","content":content.title},"template":presentation.accent.as_deref().unwrap_or("blue")},"elements":elements}}),
                )
            }
            _ => anyhow::bail!("unsupported Feishu presentation"),
        }
    }
    fn descriptor(&self) -> Value {
        descriptor()
    }
    fn validate_url(&self, value: &str, mock_origin: Option<&str>) -> Result<()> {
        validate_url(value, mock_origin)
    }
    fn classify(&self, status: u16, body: &[u8]) -> super::DeliveryResponse {
        let parsed = serde_json::from_slice::<Value>(body).ok();
        let code = parsed
            .as_ref()
            .and_then(|v| v["code"].as_i64().or(v["StatusCode"].as_i64()));
        let success = (200..300).contains(&status) && code == Some(0);
        super::DeliveryResponse {
            success,
            code,
            retryable: status >= 500 || status == 429 || matches!(code, Some(11232 | 99991400)),
            error: if success {
                None
            } else if (200..300).contains(&status) && code.is_none() {
                Some("invalid_provider_response")
            } else {
                Some("provider_rejected")
            },
        }
    }
    fn validate_payload(&self, p: &Value) -> Result<()> {
        let valid = match p["msg_type"].as_str() {
            Some("text") => p
                .pointer("/content/text")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty()),
            Some("post") => p.pointer("/content/post").is_some_and(Value::is_object),
            Some("interactive") => p["card"].is_object(),
            Some("image") => p
                .pointer("/content/image_key")
                .and_then(Value::as_str)
                .is_some(),
            Some("share_chat") => p
                .pointer("/content/share_chat_id")
                .and_then(Value::as_str)
                .is_some(),
            _ => false,
        };
        ensure!(valid, "invalid Feishu message structure");
        ensure!(
            serde_json::to_vec(p)?.len() <= 20 * 1024,
            "Feishu payload exceeds 20 KB"
        );
        Ok(())
    }
    fn prepare(&self, mut p: Value, secret: Option<&str>, timestamp: i64) -> Result<Value> {
        self.validate_payload(&p)?;
        let obj = p.as_object_mut().expect("validated object");
        obj.remove("timestamp");
        obj.remove("sign");
        if let Some(secret) = secret {
            let key = format!("{timestamp}\n{secret}");
            let mac = Hmac::<Sha256>::new_from_slice(key.as_bytes())?;
            obj.insert("timestamp".into(), timestamp.to_string().into());
            obj.insert(
                "sign".into(),
                STANDARD.encode(mac.finalize().into_bytes()).into(),
            );
        }
        self.validate_payload(&p)?;
        Ok(p)
    }
}
pub fn validate_url(value: &str, mock_origin: Option<&str>) -> Result<()> {
    let url = url::Url::parse(value)?;
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "invalid bot URL"
    );
    let production =
        url.scheme() == "https" && url.host_str() == Some("open.feishu.cn") && url.port().is_none();
    let mock = mock_origin.is_some_and(|origin| url.origin().ascii_serialization() == origin);
    ensure!(
        production || mock,
        "only https://open.feishu.cn bot URLs are allowed"
    );
    ensure!(
        url.path().starts_with("/open-apis/bot/v2/hook/")
            && url
                .path()
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .is_some_and(|x| !x.is_empty() && x != "hook"),
        "invalid bot URL path"
    );
    Ok(())
}

fn descriptor() -> Value {
    json!({"id":"feishu","name":"飞书","category":"群机器人","editor":"feishu",
      "fields":[
        {"key":"url_key_id","label":"Webhook 地址","required":true,"type":"secret","role":"endpoint"},
        {"key":"signing_key_id","label":"签名密钥","required":false,"type":"secret","role":"signing"}
      ],
      "defaults":{"url_key_id":"","signing_key_id":null},
      "message_types":{"text":"文本","post":"富文本","interactive":"消息卡片","image":"图片","share_chat":"群名片"},
      "default_presentation":{"style":"card","accent":"blue","block_styles":{}},
      "message_styles":[
        {"id":"card","name":"消息卡片","description":"清晰分组，突出状态与操作"},
        {"id":"post","name":"富文本","description":"紧凑排版，保留标题与链接"},
        {"id":"text","name":"纯文本","description":"轻量通知，完整传递内容"}
      ],
      "block_styles":[
        {"id":"default","name":"默认样式","description":"由内容类型自动选择","kinds":["text","link"]},
        {"id":"text","name":"正文段落","description":"完整展示这部分内容","kinds":["text","link"]},
        {"id":"field","name":"并排字段","description":"将相关信息排成两列","kinds":["text"]},
        {"id":"note","name":"辅助说明","description":"弱化时间、编号等次要信息","kinds":["text"]},
        {"id":"button","name":"链接按钮","description":"突出可打开的链接","kinds":["link"]}
      ],
      "accents":{"blue":"蓝色","green":"绿色","orange":"橙色","red":"红色","purple":"紫色","grey":"灰色","indigo":"靛蓝"},
      "default_template":{"msg_type":"text","content":{"text":"{{ event.source_name }}\n{{ event.event_type }}\n{{ event.summary }}"}}
    })
}

pub const DEFAULT_TEMPLATE: &str = r#"{
  "msg_type": "text",
  "content": {
    "text": "{{ event.source_name }}\n{{ event.event_type }}\n{{ event.summary }}\n事件 ID: {{ event.id }}"
  }
}"#;
