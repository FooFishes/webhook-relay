use crate::{
    config,
    model::{self, DeliverySnapshot, Resource, ResourceInput},
    providers::{registry, template},
    store::{AppState, audit, public_resource},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use subtle::ConstantTimeEq;

pub struct ApiError(pub(crate) StatusCode, pub(crate) String);
pub(crate) type Result<T> = std::result::Result<T, ApiError>;
impl From<anyhow::Error> for ApiError {
    fn from(_: anyhow::Error) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "内部处理失败，请检查服务日志与配置".into(),
        )
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => Self(StatusCode::NOT_FOUND, "记录不存在".into()),
            _ => Self(StatusCode::INTERNAL_SERVER_ERROR, "数据库操作失败".into()),
        }
    }
}
impl From<serde_json::Error> for ApiError {
    fn from(_: serde_json::Error) -> Self {
        bad("JSON 格式错误")
    }
}
fn bad(s: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, s.into())
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}

pub fn router(s: AppState, web_dir: &str) -> Router {
    let admin = Router::new()
        .route("/meta", get(meta))
        .route("/overview", get(crate::dashboard::overview))
        .route(
            "/resources/{kind}",
            get(list_resources).post(create_resource),
        )
        .route(
            "/resources/{kind}/{id}",
            axum::routing::put(update_resource).delete(delete_resource),
        )
        .route("/preview", post(preview))
        .route("/events", get(events))
        .route("/deliveries", get(deliveries))
        .route("/deliveries/{id}/attempts", get(attempts))
        .route("/deliveries/{id}/retry", post(retry))
        .route("/audit", get(audits))
        .route_layer(middleware::from_fn_with_state(s.clone(), authenticate));
    Router::new()
        .nest("/api", admin)
        .route("/healthz", get(|| async { Json(json!({"status":"ok"})) }))
        .route("/hooks/{id}", post(receive))
        .route("/hooks/apple/{id}", post(receive))
        .fallback_service(tower_http::services::ServeDir::new(web_dir))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn(security_headers))
        .with_state(s)
}
async fn security_headers(req: Request, next: Next) -> Response {
    let mut r = next.run(req).await;
    for (k, v) in [
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("cache-control", "no-store"),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ] {
        r.headers_mut().insert(
            header::HeaderName::from_static(k),
            header::HeaderValue::from_static(v),
        );
    }
    r
}
async fn authenticate(State(s): State<AppState>, req: Request, next: Next) -> Result<Response> {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.strip_prefix("Bearer "))
        .unwrap_or("");
    let digest = Sha256::digest(token.as_bytes());
    if !bool::from(digest.as_slice().ct_eq(&s.token_hash)) {
        s.log("anonymous", "auth.rejected", "admin", json!({}))
            .await?;
        return Err(ApiError(StatusCode::UNAUTHORIZED, "管理令牌无效".into()));
    }
    Ok(next.run(req).await)
}
async fn meta(State(s): State<AppState>) -> Json<Value> {
    Json(
        json!({"public_url":s.public_url,"default_template":serde_json::from_str::<Value>(crate::providers::feishu::DEFAULT_TEMPLATE).unwrap(),"source_providers":registry::sources(),"destination_providers":registry::destinations(),"message_presets":crate::providers::presets::catalog(),"pair_presets":crate::providers::message::pair_presets()}),
    )
}
async fn list_resources(
    State(s): State<AppState>,
    Path(kind): Path<String>,
) -> Result<Json<Value>> {
    if !config::valid_kind(&kind) {
        return Err(bad("资源类型无效"));
    }
    let values = s
        .resources(&kind)
        .await?
        .iter()
        .map(public_resource)
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(Json(json!(values)))
}
async fn create_resource(
    State(s): State<AppState>,
    Path(kind): Path<String>,
    Json(input): Json<ResourceInput>,
) -> Result<Json<Value>> {
    save(s, kind, model::id(), input, false).await
}
async fn update_resource(
    State(s): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    Json(input): Json<ResourceInput>,
) -> Result<Json<Value>> {
    save(s, kind, id, input, true).await
}
async fn save(
    s: AppState,
    kind: String,
    id: String,
    mut input: ResourceInput,
    update: bool,
) -> Result<Json<Value>> {
    let _guard = s.config_lock.lock().await;
    if !config::valid_kind(&kind) || input.name.trim().is_empty() || input.name.len() > 120 {
        return Err(bad("资源类型或名称无效"));
    }
    if !input.config.is_object() {
        return Err(bad("config must be an object"));
    }
    if kind == "keys"
        && (input
            .config
            .as_object()
            .unwrap()
            .keys()
            .any(|k| k != "value")
            || input.config.get("value").is_some_and(|v| !v.is_string()))
    {
        return Err(bad("Key config only accepts a string value field"));
    }
    let previous = if update {
        let r = s.resource(&id).await?;
        if r.kind != kind {
            return Err(bad("资源类型不匹配"));
        }
        Some(r)
    } else {
        None
    };
    if let Some(old) = &previous
        && input.revision != Some(old.revision)
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "配置已更新，请刷新后重试".into(),
        ));
    }
    if let Some(old) = &previous
        && ["sources", "destinations"].contains(&kind.as_str())
    {
        let old_config: Value = serde_json::from_str(&old.config)?;
        if old_config["provider"] != input.config["provider"] {
            return Err(bad("已有实例不能更换平台，请创建新的实例"));
        }
    }
    if kind == "keys" && update && input.config["value"].as_str().is_none_or(str::is_empty) {
        input.config = json!({"value":s.key(&id).await?});
    }
    config::validate(&s, &kind, &input.config)
        .await
        .map_err(|e| bad(e.to_string()))?;
    // Validate URL-key rotations against all existing consumers before committing.
    if kind == "keys" && update {
        for d in s.resources("destinations").await? {
            let c: Value = serde_json::from_str(&d.config)?;
            let descriptor = registry::destination(config::field(&c, "provider")?)?.descriptor();
            if config::field_for_role(&descriptor, "endpoint")
                .is_some_and(|key| c[&key].as_str() == Some(&id))
            {
                registry::destination(config::field(&c, "provider")?)?
                    .validate_url(
                        config::field(&input.config, "value")?,
                        s.mock_origin.as_deref(),
                    )
                    .map_err(|_| bad("该密钥被用作目标地址，新值不符合对应适配器要求"))?;
            }
        }
    }
    let audit_after = audit_config(&kind, &input.config);
    let audit_before = previous
        .as_ref()
        .map(|r| serde_json::from_str::<Value>(&r.config).map(|v| audit_config(&kind, &v)))
        .transpose()?;
    let changed_fields = input
        .config
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    if kind == "keys" {
        input.config["value"] = s.vault.seal(config::field(&input.config, "value")?)?.into();
    }
    let revision = previous.as_ref().map_or(1, |x| x.revision + 1);
    let mut tx = s.db.begin().await?;
    if update {
        sqlx::query("UPDATE resources SET name=?,config=?,revision=?,updated_at=? WHERE id=?")
            .bind(input.name.trim())
            .bind(input.config.to_string())
            .bind(revision)
            .bind(model::now())
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query(
            "INSERT INTO resources(id,kind,name,config,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(&id)
        .bind(&kind)
        .bind(input.name.trim())
        .bind(input.config.to_string())
        .bind(model::now())
        .bind(model::now())
        .execute(&mut *tx)
        .await?;
    }
    audit(&mut tx,"admin",if update {"config.updated"}else{"config.created"},&id,json!({"kind":kind,"name":input.name.trim(),"previous_revision":previous.as_ref().map(|r|r.revision),"revision":revision,"fields":changed_fields,"before":audit_before,"after":audit_after})).await?;
    tx.commit().await?;
    Ok(Json(public_resource(&s.resource(&id).await?)?))
}
fn audit_config(kind: &str, config: &Value) -> Value {
    if kind == "keys" {
        return json!({"has_value":true});
    }
    let mut result = config.clone();
    for key in ["payload_template", "event_templates", "message_policy"] {
        if let Some(template) = result.as_object_mut().and_then(|o| o.remove(key)) {
            result[format!("{key}_sha256")] =
                hex::encode(Sha256::digest(template.to_string().as_bytes())).into();
        }
    }
    result
}
async fn delete_resource(
    State(s): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    let _guard = s.config_lock.lock().await;
    let r = s.resource(&id).await?;
    if r.kind != kind {
        return Err(bad("资源类型不匹配"));
    }
    let rows = sqlx::query_as::<_, Resource>("SELECT * FROM resources")
        .fetch_all(&s.db)
        .await?;
    for row in rows {
        if row.id != id && config::references(&serde_json::from_str(&row.config)?, &id) {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "该资源仍被其他配置引用".into(),
            ));
        }
    }
    let pending:i64=sqlx::query_scalar("SELECT count(*) FROM deliveries WHERE (route_id=? OR destination_id=?) AND status IN ('pending','sending','retrying')").bind(&id).bind(&id).fetch_one(&s.db).await?;
    if pending > 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "该资源仍有未完成的投递任务".into(),
        ));
    }
    let mut tx = s.db.begin().await?;
    sqlx::query("DELETE FROM resources WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        "admin",
        "config.deleted",
        &id,
        json!({"kind":kind,"name":r.name,"revision":r.revision}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Preview {
    payload_template: Option<Value>,
    message_policy: Option<Value>,
    sample: Value,
    source_name: Option<String>,
    source_provider: Option<String>,
    destination_provider: Option<String>,
}
async fn preview(State(s): State<AppState>, Json(p): Json<Preview>) -> Result<Json<Value>> {
    // Optional provider IDs preserve the original preview API for existing clients.
    let source = registry::source(
        p.source_provider
            .as_deref()
            .unwrap_or("apple_app_store_connect"),
    )
    .map_err(|e| bad(e.to_string()))?;
    let destination = registry::destination(p.destination_provider.as_deref().unwrap_or("feishu"))
        .map_err(|e| bad(e.to_string()))?;
    if p.payload_template.is_some() && p.message_policy.is_some() {
        return Err(bad("choose one message configuration mode"));
    }
    let event = source
        .normalize(
            &serde_json::to_vec(&p.sample)?,
            p.source_name.as_deref().unwrap_or("预览来源"),
        )
        .map_err(|e| bad(e.to_string()))?;
    let payload = if let Some(payload_template) = p.payload_template {
        template::validate_for(&payload_template, destination).map_err(|e| bad(e.to_string()))?;
        template::render_for(&payload_template, &event, destination)
            .map_err(|e| bad(e.to_string()))?
    } else {
        let policy = p
            .message_policy
            .unwrap_or_else(crate::providers::message::default_policy);
        crate::providers::message::validate(&policy, &source.descriptor(), destination)
            .map_err(|e| bad(e.to_string()))?;
        crate::providers::message::render(&policy, &source.descriptor(), &event, destination)
            .map_err(|e| bad(e.to_string()))?
            .ok_or_else(|| bad("unsupported source event"))?
    };
    s.log(
        "admin",
        "template.previewed",
        "preview",
        json!({"event_type":event.event_type}),
    )
    .await?;
    Ok(Json(json!({"payload":payload,"event":event})))
}
async fn receive(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Result<(StatusCode, Json<Value>)> {
    let _guard = s.config_lock.lock().await;
    let source = s.resource(&id).await?;
    let c: Value = serde_json::from_str(&source.config)?;
    if source.kind != "sources" || !config::enabled(&c) {
        return Err(ApiError(StatusCode::NOT_FOUND, "来源不可用".into()));
    }
    let provider_id = config::field(&c, "provider")?;
    let adapter = registry::source(provider_id)?;
    let secret = config::secret_for_role(&s, &c, &adapter.descriptor(), "verification")
        .await?
        .unwrap_or_default();
    let signature = headers
        .get(adapter.signature_header())
        .and_then(|x| x.to_str().ok())
        .unwrap_or("");
    if adapter.verify(&raw, signature, &secret).is_err() {
        s.log(
            provider_id,
            "webhook.signature_rejected",
            &id,
            json!({"bytes":raw.len()}),
        )
        .await?;
        return Err(ApiError(StatusCode::UNAUTHORIZED, "签名校验失败".into()));
    }
    let event = match adapter.normalize(&raw, &source.name) {
        Ok(e) => e,
        Err(_) => {
            s.log(
                provider_id,
                "webhook.payload_rejected",
                &id,
                json!({"bytes":raw.len()}),
            )
            .await?;
            return Err(bad("来源事件格式无效"));
        }
    };
    let body_hash = hex::encode(Sha256::digest(&raw));
    let existing =
        sqlx::query("SELECT id,body_sha256 FROM events WHERE source_id=? AND provider_id=?")
            .bind(&id)
            .bind(&event.id)
            .fetch_optional(&s.db)
            .await?;
    if let Some(row) = existing {
        let same = row.get::<String, _>("body_sha256") == body_hash;
        s.log(
            provider_id,
            if same {
                "webhook.duplicate"
            } else {
                "webhook.id_conflict"
            },
            &id,
            json!({"event_id":row.get::<String,_>("id")}),
        )
        .await?;
        if !same {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "相同事件 ID 对应不同请求体".into(),
            ));
        }
        return Ok((
            StatusCode::OK,
            Json(json!({"duplicate":true,"event_id":row.get::<String,_>("id")})),
        ));
    }
    let event_id = model::id();
    let mut jobs = Vec::new();
    for route in s.resources("routes").await? {
        let rc: Value = serde_json::from_str(&route.config)?;
        if !config::enabled(&rc) || rc["source_id"].as_str() != Some(&id) {
            continue;
        }
        let types = rc["event_types"]
            .as_array()
            .ok_or_else(|| bad("路由事件过滤配置无效"))?;
        if !types.is_empty() && !types.iter().any(|v| v.as_str() == Some(&event.event_type)) {
            continue;
        }
        let d = s.resource(config::field(&rc, "destination_id")?).await?;
        let dc: Value = serde_json::from_str(&d.config)?;
        if !config::enabled(&dc) {
            continue;
        }
        let destination_provider = config::field(&dc, "provider")?;
        let adapter = registry::destination(destination_provider)?;
        let payload = if rc.get("message_policy").is_some()
            || (rc.get("event_templates").is_none() && rc.get("payload_template").is_none())
        {
            match crate::providers::message::render(
                rc.get("message_policy")
                    .unwrap_or(&crate::providers::message::default_policy()),
                &registry::source(provider_id)?.descriptor(),
                &event,
                adapter,
            ) {
                Ok(Some(payload)) => Ok(payload),
                Ok(None) => continue,
                Err(error) => Err(error),
            }
        } else {
            let Some(selected_template) = template::select_for_event(&rc, &event.event_type) else {
                continue;
            };
            template::render_for(selected_template, &event, adapter)
        };
        let (payload, error) = match payload {
            Ok(p) => (p, None),
            Err(_) => (Value::Null, Some("template_render_failed")),
        };
        let snapshot = DeliverySnapshot {
            provider: destination_provider.to_owned(),
            url: config::secret_for_role(
                &s,
                &dc,
                &registry::destination(destination_provider)?.descriptor(),
                "endpoint",
            )
            .await?
            .ok_or_else(|| bad("目标缺少 Webhook 地址"))?,
            signing_secret: config::secret_for_role(
                &s,
                &dc,
                &registry::destination(destination_provider)?.descriptor(),
                "signing",
            )
            .await?,
            payload,
            route_revision: route.revision,
            destination_revision: d.revision,
        };
        jobs.push((
            route.id,
            d.id,
            rc["max_attempts"].as_i64().unwrap_or(5),
            s.vault.seal(&serde_json::to_string(&snapshot)?)?,
            error,
        ));
    }
    let mut tx = s.db.begin().await?;
    sqlx::query("INSERT INTO events(id,source_id,provider_id,event_type,payload,body_sha256,created_at) VALUES(?,?,?,?,?,?,?)")
        .bind(&event_id).bind(&id).bind(&event.id).bind(&event.event_type).bind(s.vault.seal(std::str::from_utf8(&raw).map_err(|_|bad("payload must be UTF-8"))?)?).bind(body_hash).bind(model::now()).execute(&mut *tx).await?;
    for (route_id, destination_id, max_attempts, snapshot, error) in &jobs {
        let delivery_id = model::id();
        sqlx::query("INSERT INTO deliveries(id,event_id,route_id,destination_id,snapshot,status,max_attempts,next_attempt_at,created_at,updated_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&delivery_id).bind(&event_id).bind(route_id).bind(destination_id).bind(snapshot).bind(if error.is_some(){"failed"}else{"pending"}).bind(max_attempts).bind(model::now()).bind(model::now()).bind(model::now()).bind(error).execute(&mut *tx).await?;
        audit(&mut tx,"system",if error.is_some(){"delivery.failed"}else{"delivery.queued"},&delivery_id,json!({"event_id":event_id,"route_id":route_id,"destination_id":destination_id,"error":error})).await?;
    }
    audit(&mut tx,provider_id,"webhook.accepted",&id,json!({"event_id":event_id,"event_type":event.event_type,"deliveries":jobs.len(),"signature":"verified"})).await?;
    tx.commit().await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"event_id":event_id,"deliveries":jobs.len()})),
    ))
}
#[derive(Deserialize)]
struct Page {
    id: Option<String>,
    limit: Option<i64>,
    before: Option<i64>,
    status: Option<String>,
    action: Option<String>,
    source_id: Option<String>,
    route_id: Option<String>,
    destination_id: Option<String>,
    event_id: Option<String>,
    event_type: Option<String>,
}
impl Page {
    fn limit(&self) -> i64 {
        self.limit.unwrap_or(50).clamp(1, 200)
    }
}
async fn events(State(s): State<AppState>, Query(p): Query<Page>) -> Result<Json<Value>> {
    let rows=sqlx::query("SELECT rowid AS cursor,id,source_id,provider_id,event_type,body_sha256,created_at FROM events WHERE rowid < ? AND (? IS NULL OR id=?) AND (? IS NULL OR source_id=?) AND (? IS NULL OR event_type=?) ORDER BY rowid DESC LIMIT ?").bind(p.before.unwrap_or(i64::MAX)).bind(&p.id).bind(&p.id).bind(&p.source_id).bind(&p.source_id).bind(&p.event_type).bind(&p.event_type).bind(p.limit()).fetch_all(&s.db).await?;
    Ok(Json(json!(rows.iter().map(|r|json!({"cursor":r.get::<i64,_>("cursor"),"id":r.get::<String,_>("id"),"source_id":r.get::<String,_>("source_id"),"provider_id":r.get::<String,_>("provider_id"),"event_type":r.get::<String,_>("event_type"),"body_sha256":r.get::<String,_>("body_sha256"),"created_at":r.get::<i64,_>("created_at")})).collect::<Vec<_>>())))
}
async fn deliveries(State(s): State<AppState>, Query(p): Query<Page>) -> Result<Json<Value>> {
    let rows=sqlx::query("SELECT rowid AS cursor,* FROM deliveries WHERE rowid < ? AND (? IS NULL OR id=?) AND (? IS NULL OR status=? OR (?='queued' AND status IN ('pending','retrying','sending'))) AND (? IS NULL OR route_id=?) AND (? IS NULL OR destination_id=?) AND (? IS NULL OR event_id=?) ORDER BY rowid DESC LIMIT ?").bind(p.before.unwrap_or(i64::MAX)).bind(&p.id).bind(&p.id).bind(&p.status).bind(&p.status).bind(&p.status).bind(&p.route_id).bind(&p.route_id).bind(&p.destination_id).bind(&p.destination_id).bind(&p.event_id).bind(&p.event_id).bind(p.limit()).fetch_all(&s.db).await?;
    Ok(Json(json!(rows.iter().map(|r|json!({"cursor":r.get::<i64,_>("cursor"),"id":r.get::<String,_>("id"),"event_id":r.get::<String,_>("event_id"),"route_id":r.get::<String,_>("route_id"),"destination_id":r.get::<String,_>("destination_id"),"status":r.get::<String,_>("status"),"attempts":r.get::<i64,_>("attempts"),"max_attempts":r.get::<i64,_>("max_attempts"),"last_error":r.get::<Option<String>,_>("last_error"),"next_attempt_at":r.get::<i64,_>("next_attempt_at"),"updated_at":r.get::<i64,_>("updated_at"),"created_at":r.get::<i64,_>("created_at")})).collect::<Vec<_>>())))
}
async fn attempts(State(s): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>> {
    let rows = sqlx::query("SELECT * FROM attempts WHERE delivery_id=? ORDER BY id DESC LIMIT 200")
        .bind(id)
        .fetch_all(&s.db)
        .await?;
    Ok(Json(json!(rows.iter().map(|r|json!({"id":r.get::<i64,_>("id"),"attempt":r.get::<i64,_>("attempt"),"status":r.get::<String,_>("status"),"http_status":r.get::<Option<i64>,_>("http_status"),"provider_code":r.get::<Option<i64>,_>("provider_code"),"error":r.get::<Option<String>,_>("error"),"created_at":r.get::<i64,_>("created_at")})).collect::<Vec<_>>())))
}
async fn audits(State(s): State<AppState>, Query(p): Query<Page>) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "SELECT * FROM audit WHERE id < ? AND (? IS NULL OR action=?) ORDER BY id DESC LIMIT ?",
    )
    .bind(p.before.unwrap_or(i64::MAX))
    .bind(&p.action)
    .bind(&p.action)
    .bind(p.limit())
    .fetch_all(&s.db)
    .await?;
    Ok(Json(json!(rows.iter().map(|r|json!({"cursor":r.get::<i64,_>("id"),"id":r.get::<i64,_>("id"),"actor":r.get::<String,_>("actor"),"action":r.get::<String,_>("action"),"resource_id":r.get::<String,_>("resource_id"),"detail":serde_json::from_str::<Value>(&r.get::<String,_>("detail")).unwrap_or(Value::Null),"created_at":r.get::<i64,_>("created_at")})).collect::<Vec<_>>())))
}
async fn retry(State(s): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>> {
    let mut tx = s.db.begin().await?;
    let changed=sqlx::query("UPDATE deliveries SET status='retrying',max_attempts=attempts+5,next_attempt_at=?,updated_at=? WHERE id=? AND status='failed' AND last_error != 'template_render_failed'")
        .bind(model::now()).bind(model::now()).bind(&id).execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "仅支持重试投递失败的任务；模板失败需修正配置后重新发送新事件".into(),
        ));
    }
    audit(
        &mut tx,
        "admin",
        "delivery.retried",
        &id,
        json!({"additional_attempts":5,"uses_original_snapshot":true}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
