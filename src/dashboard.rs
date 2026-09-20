use crate::{
    api::{ApiError, Result},
    model::now,
    store::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

#[derive(Deserialize)]
pub struct Window {
    hours: Option<i64>,
}
pub async fn overview(
    State(s): State<AppState>,
    Query(window): Query<Window>,
) -> Result<Json<Value>> {
    let hours = window.hours.unwrap_or(24);
    if ![24, 168].contains(&hours) {
        return Err(ApiError(
            axum::http::StatusCode::BAD_REQUEST,
            "时间范围仅支持 24 或 168 小时".into(),
        ));
    }
    let until = now();
    let since = until - hours * 3600;
    let bucket = if hours == 24 { 3600 } else { 86400 };
    // A read transaction keeps cards, chart and attention lists on one snapshot.
    let mut tx = s.db.begin().await?;
    let received: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE created_at>=? AND created_at<=?")
            .bind(since)
            .bind(until)
            .fetch_one(&mut *tx)
            .await?;
    let totals=sqlx::query("SELECT status,count(*) AS total FROM deliveries WHERE status IN ('succeeded','failed') AND updated_at>=? AND updated_at<=? GROUP BY status").bind(since).bind(until).fetch_all(&mut *tx).await?;
    let count = |status: &str| {
        totals
            .iter()
            .find(|r| r.get::<String, _>("status") == status)
            .map_or(0, |r| r.get::<i64, _>("total"))
    };
    let succeeded = count("succeeded");
    let failed = count("failed");
    let queue=sqlx::query("SELECT d.status,count(*) AS total,sum(CASE WHEN d.status!='sending' AND (coalesce(json_extract(r.config,'$.enabled'),0)!=1 OR coalesce(json_extract(t.config,'$.enabled'),0)!=1) THEN 1 ELSE 0 END) AS paused FROM deliveries d LEFT JOIN resources r ON r.id=d.route_id LEFT JOIN resources t ON t.id=d.destination_id WHERE d.status IN ('pending','sending','retrying') GROUP BY d.status").fetch_all(&mut *tx).await?;
    let queue_count = |status: &str| {
        queue
            .iter()
            .find(|r| r.get::<String, _>("status") == status)
            .map_or(0, |r| r.get::<i64, _>("total"))
    };
    let paused: i64 = queue.iter().map(|r| r.get::<i64, _>("paused")).sum();
    let attention_failed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM deliveries WHERE status='failed'")
            .fetch_one(&mut *tx)
            .await?;
    let event_buckets=sqlx::query("SELECT (created_at-?)/? AS bucket,count(*) AS total FROM events WHERE created_at>=? AND created_at<=? GROUP BY bucket").bind(since).bind(bucket).bind(since).bind(until).fetch_all(&mut *tx).await?;
    let delivery_buckets=sqlx::query("SELECT (updated_at-?)/? AS bucket,status,count(*) AS total FROM deliveries WHERE status IN ('succeeded','failed') AND updated_at>=? AND updated_at<=? GROUP BY bucket,status").bind(since).bind(bucket).bind(since).bind(until).fetch_all(&mut *tx).await?;
    let series=(0..hours*3600/bucket).map(|index| {
        // Include a row exactly at 'until' in the last interval.
        let belongs=|b:i64|b.min(hours*3600/bucket-1)==index;
        let events:i64=event_buckets.iter().filter(|r|belongs(r.get("bucket"))).map(|r|r.get::<i64,_>("total")).sum();
        let counts=|status:&str|delivery_buckets.iter().filter(|r|belongs(r.get("bucket"))&&r.get::<String,_>("status")==status).map(|r|r.get::<i64,_>("total")).sum::<i64>();
        json!({"start":since+index*bucket,"events":events,"succeeded":counts("succeeded"),"failed":counts("failed")})
    }).collect::<Vec<_>>();
    let routes=sqlx::query("SELECT r.id,r.name,json_extract(r.config,'$.enabled') AS enabled,s.name AS source_name,t.name AS destination_name,coalesce(json_extract(s.config,'$.enabled'),0) AS source_enabled,coalesce(json_extract(t.config,'$.enabled'),0) AS destination_enabled,(SELECT count(*) FROM deliveries d WHERE d.route_id=r.id AND d.status IN ('pending','retrying','sending')) AS queued,(SELECT count(*) FROM deliveries d WHERE d.route_id=r.id AND d.status='failed') AS failed,(SELECT max(d.updated_at) FROM deliveries d WHERE d.route_id=r.id) AS last_delivery_at FROM resources r LEFT JOIN resources s ON s.id=json_extract(r.config,'$.source_id') LEFT JOIN resources t ON t.id=json_extract(r.config,'$.destination_id') WHERE r.kind='routes' ORDER BY failed DESC,queued DESC,r.name").fetch_all(&mut *tx).await?.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"enabled":r.get::<i64,_>("enabled")==1,"source_name":r.get::<Option<String>,_>("source_name"),"destination_name":r.get::<Option<String>,_>("destination_name"),"source_enabled":r.get::<i64,_>("source_enabled")==1,"destination_enabled":r.get::<i64,_>("destination_enabled")==1,"queued":r.get::<i64,_>("queued"),"failed":r.get::<i64,_>("failed"),"last_delivery_at":r.get::<Option<i64>,_>("last_delivery_at")})).collect::<Vec<_>>();
    let recent_failed=sqlx::query("SELECT d.id,d.route_id,r.name AS route_name,t.name AS destination_name,d.last_error,d.attempts,d.updated_at FROM deliveries d LEFT JOIN resources r ON r.id=d.route_id LEFT JOIN resources t ON t.id=d.destination_id WHERE d.status='failed' ORDER BY d.updated_at DESC,d.rowid DESC LIMIT 8").fetch_all(&mut *tx).await?.iter().map(|r|json!({"id":r.get::<String,_>("id"),"route_id":r.get::<String,_>("route_id"),"route_name":r.get::<Option<String>,_>("route_name"),"destination_name":r.get::<Option<String>,_>("destination_name"),"last_error":r.get::<Option<String>,_>("last_error"),"attempts":r.get::<i64,_>("attempts"),"updated_at":r.get::<i64,_>("updated_at")})).collect::<Vec<_>>();
    let recent_events=sqlx::query("SELECT e.id,e.source_id,s.name AS source_name,e.event_type,e.created_at,(SELECT count(*) FROM deliveries d WHERE d.event_id=e.id) AS deliveries FROM events e LEFT JOIN resources s ON s.id=e.source_id ORDER BY e.rowid DESC LIMIT 8").fetch_all(&mut *tx).await?.iter().map(|r|json!({"id":r.get::<String,_>("id"),"source_id":r.get::<String,_>("source_id"),"source_name":r.get::<Option<String>,_>("source_name"),"event_type":r.get::<String,_>("event_type"),"created_at":r.get::<i64,_>("created_at"),"deliveries":r.get::<i64,_>("deliveries")})).collect::<Vec<_>>();
    tx.commit().await?;
    Ok(Json(
        json!({"window":{"since":since,"until":until,"hours":hours},"received":received,"succeeded":succeeded,"failed":failed,"success_rate":if succeeded+failed==0 {None}else{Some(succeeded as f64*100.0/(succeeded+failed) as f64)},"queue":{"pending":queue_count("pending"),"retrying":queue_count("retrying"),"sending":queue_count("sending"),"paused":paused},"attention_failed":attention_failed,"series":series,"routes":routes,"recent_failed":recent_failed,"recent_events":recent_events}),
    ))
}
