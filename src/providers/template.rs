use crate::{model::RelayEvent, providers::DestinationAdapter};
use anyhow::{Result, ensure};
use minijinja::{Environment, UndefinedBehavior};
use serde_json::Value;

struct BoundedOutput(Vec<u8>);
impl std::io::Write for BoundedOutput {
    fn write(&mut self, s: &[u8]) -> std::io::Result<usize> {
        if self.0.len() + s.len() > 256 * 1024 {
            return Err(std::io::Error::other("rendered payload exceeds 256 KB"));
        }
        self.0.extend_from_slice(s);
        Ok(s.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub fn render_for(
    template: &Value,
    event: &RelayEvent,
    destination: &dyn DestinationAdapter,
) -> Result<Value> {
    let result = render_value(template, event)?;
    destination.validate_payload(&result)?;
    Ok(result)
}
pub fn render_value(template: &Value, event: &RelayEvent) -> Result<Value> {
    let mut env = environment();
    env.set_undefined_behavior(UndefinedBehavior::Strict);
    env.set_fuel(Some(20_000));
    let context = minijinja::context!(event => event);
    fn walk(
        v: &Value,
        env: &Environment<'_>,
        ctx: &minijinja::Value,
        depth: usize,
    ) -> Result<Value> {
        ensure!(depth < 32, "template nesting exceeds limit");
        Ok(match v {
            Value::String(s) => {
                let mut output = BoundedOutput(Vec::new());
                env.template_from_str(s)?
                    .render_captured_to(ctx, &mut output)?;
                Value::String(String::from_utf8(output.0)?)
            }
            Value::Array(a) => Value::Array(
                a.iter()
                    .map(|x| walk(x, env, ctx, depth + 1))
                    .collect::<Result<_>>()?,
            ),
            Value::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, v)| Ok((k.clone(), walk(v, env, ctx, depth + 1)?)))
                    .collect::<Result<_>>()?,
            ),
            _ => v.clone(),
        })
    }
    let result = walk(template, &env, &context, 0)?;
    Ok(result)
}
pub fn validate_for(template: &Value, destination: &dyn DestinationAdapter) -> Result<()> {
    validate_value(template)?;
    destination.validate_payload(template)
}
pub fn validate_value(template: &Value) -> Result<()> {
    ensure!(
        serde_json::to_vec(template)?.len() <= 256 * 1024,
        "template exceeds 256 KB"
    );
    let env = environment();
    fn walk(v: &Value, env: &Environment<'_>) -> Result<()> {
        match v {
            Value::String(s) => {
                env.template_from_str(s)?;
            }
            Value::Array(a) => {
                for v in a {
                    walk(v, env)?;
                }
            }
            Value::Object(o) => {
                for v in o.values() {
                    walk(v, env)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(template, &env)?;
    Ok(())
}

// Each enabled event chooses exactly one template. Unknown events never use another event's template.
pub fn select_for_event<'a>(config: &'a Value, event_type: &str) -> Option<&'a Value> {
    if let Some(bindings) = config.get("event_templates") {
        let binding = bindings.get(event_type)?;
        let active = binding["active_template_id"].as_str()?;
        binding["templates"]
            .as_array()?
            .iter()
            .find(|template| template["id"].as_str() == Some(active))?
            .get("payload_template")
    } else {
        config.get("payload_template")
    }
}

pub fn validate_event_templates(
    value: &Value,
    source: &Value,
    destination: &dyn DestinationAdapter,
) -> Result<()> {
    ensure!(
        serde_json::to_vec(value)?.len() <= 256 * 1024,
        "event templates exceed 256 KB"
    );
    let bindings = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("event_templates must be an object"))?;
    ensure!(
        !bindings.is_empty() && bindings.len() <= 100,
        "configure at least one event template"
    );
    for (event_type, binding) in bindings {
        ensure!(
            source["event_definitions"].get(event_type).is_some(),
            "unsupported source event: {event_type}"
        );
        let active = binding["active_template_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("active_template_id is required"))?;
        let items = binding["templates"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("templates must be an array"))?;
        ensure!(
            !items.is_empty() && items.len() <= 20,
            "each event must have 1..20 templates"
        );
        let mut ids = std::collections::HashSet::new();
        for item in items {
            let id = item["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 128)
                .ok_or_else(|| anyhow::anyhow!("invalid template id"))?;
            ensure!(ids.insert(id), "duplicate template id");
            ensure!(
                item["name"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200),
                "template name is required"
            );
            validate_for(&item["payload_template"], destination)?;
        }
        ensure!(ids.contains(active), "active template does not exist");
    }
    Ok(())
}

fn environment() -> Environment<'static> {
    let mut env = Environment::new();
    env.add_filter(
        "field",
        |raw: minijinja::value::ViaDeserialize<Value>, pointer: String| {
            minijinja::Value::from_serialize(raw.0.pointer(&pointer))
        },
    );
    env
}
