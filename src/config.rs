use crate::{
    providers::{message, registry, template},
    store::AppState,
};
use anyhow::{Result, anyhow, ensure};
use serde_json::Value;

pub fn field<'a>(v: &'a Value, name: &str) -> Result<&'a str> {
    v[name]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("{name} is required"))
}
pub fn enabled(c: &Value) -> bool {
    c["enabled"].as_bool().unwrap_or(false)
}
pub fn valid_kind(kind: &str) -> bool {
    ["keys", "sources", "destinations", "routes"].contains(&kind)
}
async fn reference(s: &AppState, c: &Value, field_name: &str, kind: &str) -> Result<()> {
    ensure!(
        s.resource(field(c, field_name)?).await?.kind == kind,
        "invalid {field_name} reference"
    );
    Ok(())
}
pub async fn validate(s: &AppState, kind: &str, c: &Value) -> Result<()> {
    ensure!(c.is_object(), "config must be an object");
    let allowed: Vec<String> = match kind {
        "keys" => vec!["value".into()],
        "sources" | "destinations" => {
            let descriptor = if kind == "sources" {
                registry::source(field(c, "provider")?)?.descriptor()
            } else {
                registry::destination(field(c, "provider")?)?.descriptor()
            };
            let mut fields = vec!["provider".into(), "enabled".into()];
            fields.extend(
                descriptor["fields"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| f["key"].as_str().unwrap().to_owned()),
            );
            fields
        }
        "routes" => [
            "source_id",
            "destination_id",
            "event_types",
            "payload_template",
            "event_templates",
            "message_policy",
            "max_attempts",
            "enabled",
        ]
        .map(str::to_owned)
        .to_vec(),
        _ => return Err(anyhow!("unsupported resource kind")),
    };
    for key in c.as_object().unwrap().keys() {
        ensure!(allowed.contains(key), "unknown field: {key}");
    }
    if kind != "keys" {
        ensure!(c["enabled"].is_boolean(), "enabled must be boolean");
    }
    match kind {
        "keys" => {
            ensure!(field(c, "value")?.len() <= 16384, "key exceeds 16 KB");
        }
        "sources" | "destinations" => {
            let descriptor = if kind == "sources" {
                registry::source(field(c, "provider")?)?.descriptor()
            } else {
                registry::destination(field(c, "provider")?)?.descriptor()
            };
            for f in descriptor["fields"].as_array().unwrap() {
                let key = f["key"].as_str().unwrap();
                if f["required"] == true || !c[key].is_null() {
                    reference(s, c, key, "keys").await?;
                    if f["role"] == "endpoint" {
                        registry::destination(field(c, "provider")?)?.validate_url(
                            &s.key(field(c, key)?).await?,
                            s.mock_origin.as_deref(),
                        )?;
                    }
                }
            }
        }
        "routes" => {
            reference(s, c, "source_id", "sources").await?;
            reference(s, c, "destination_id", "destinations").await?;
            let types = c["event_types"]
                .as_array()
                .ok_or_else(|| anyhow!("event_types must be an array"))?;
            ensure!(
                types.len() <= 100
                    && types
                        .iter()
                        .all(|x| x.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128)),
                "invalid event_types"
            );
            ensure!(
                c["max_attempts"]
                    .as_i64()
                    .is_some_and(|x| (1..=10).contains(&x)),
                "max_attempts must be 1..10"
            );
            let target = s.resource(field(c, "destination_id")?).await?;
            let target_config: Value = serde_json::from_str(&target.config)?;
            let destination = registry::destination(field(&target_config, "provider")?)?;
            let modes = ["message_policy", "event_templates", "payload_template"]
                .iter()
                .filter(|key| c.get(**key).is_some())
                .count();
            ensure!(modes <= 1, "choose exactly one message configuration mode");
            if c.get("message_policy").is_some() || modes == 0 {
                let source = s.resource(field(c, "source_id")?).await?;
                let source_config: Value = serde_json::from_str(&source.config)?;
                let descriptor = registry::source(field(&source_config, "provider")?)?.descriptor();
                message::validate(
                    c.get("message_policy")
                        .unwrap_or(&message::default_policy()),
                    &descriptor,
                    destination,
                )?;
                for event_type in types {
                    ensure!(
                        descriptor["event_definitions"]
                            .get(event_type.as_str().unwrap())
                            .is_some(),
                        "unsupported source event"
                    );
                }
            } else if let Some(event_templates) = c.get("event_templates") {
                ensure!(
                    c.get("payload_template").is_none(),
                    "choose either legacy or event templates"
                );
                let source = s.resource(field(c, "source_id")?).await?;
                let source_config: Value = serde_json::from_str(&source.config)?;
                let descriptor = registry::source(field(&source_config, "provider")?)?.descriptor();
                template::validate_event_templates(event_templates, &descriptor, destination)?;
                for event_type in types {
                    ensure!(
                        event_templates.get(event_type.as_str().unwrap()).is_some(),
                        "selected event is missing a template"
                    );
                }
            } else {
                template::validate_for(&c["payload_template"], destination)?;
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}
pub fn references(c: &Value, target: &str) -> bool {
    if ["source_id", "destination_id"]
        .iter()
        .any(|key| c[*key].as_str() == Some(target))
    {
        return true;
    }
    registry::sources()
        .into_iter()
        .chain(registry::destinations())
        .filter(|d| d["id"] == c["provider"])
        .any(|d| {
            d["fields"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| c[f["key"].as_str().unwrap()].as_str() == Some(target))
        })
}

pub fn field_for_role(descriptor: &Value, role: &str) -> Option<String> {
    descriptor["fields"]
        .as_array()?
        .iter()
        .find(|f| f["role"] == role)?["key"]
        .as_str()
        .map(str::to_owned)
}
pub async fn secret_for_role(
    s: &AppState,
    c: &Value,
    descriptor: &Value,
    role: &str,
) -> Result<Option<String>> {
    match field_for_role(descriptor, role).and_then(|key| c[&key].as_str().map(str::to_owned)) {
        Some(id) => Ok(Some(s.key(&id).await?)),
        None => Ok(None),
    }
}
