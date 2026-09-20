use crate::{
    model::{self, DeliverySnapshot},
    providers::registry,
    store::{AppState, audit},
};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use sqlx::Row;
use std::time::Duration;

struct Outcome {
    success: bool,
    retryable: bool,
    http: Option<i64>,
    code: Option<i64>,
    error: Option<&'static str>,
    retry_after: i64,
}
impl Outcome {
    fn error(error: &'static str, retryable: bool) -> Self {
        Self {
            success: false,
            retryable,
            http: None,
            code: None,
            error: Some(error),
            retry_after: 0,
        }
    }
}
async fn send(s: &AppState, snapshot: &str) -> Outcome {
    let snapshot = s
        .vault
        .open(snapshot)
        .and_then(|v| Ok(serde_json::from_str::<DeliverySnapshot>(&v)?));
    let snapshot = match snapshot {
        Ok(v) => v,
        Err(_) => return Outcome::error("snapshot_decryption_failed", false),
    };
    let adapter = match registry::destination(&snapshot.provider) {
        Ok(v) => v,
        Err(_) => return Outcome::error("unsupported_destination_provider", false),
    };
    if adapter
        .validate_url(&snapshot.url, s.mock_origin.as_deref())
        .is_err()
    {
        return Outcome::error("destination_url_rejected", false);
    }
    let payload = match adapter.prepare(
        snapshot.payload,
        snapshot.signing_secret.as_deref(),
        model::now(),
    ) {
        Ok(v) => v,
        Err(_) => return Outcome::error("payload_invalid_or_too_large", false),
    };
    let response = s.client.post(snapshot.url).json(&payload).send().await;
    let mut response = match response {
        Ok(v) => v,
        Err(_) => return Outcome::error("network_or_timeout", true),
    };
    let status = response.status();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.parse::<i64>().ok())
        .unwrap_or(0)
        .clamp(0, 3600);
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > 64 * 1024 {
                    return Outcome::error("response_too_large", false);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return Outcome::error("response_read_failed", true),
        }
    }
    let result = adapter.classify(status.as_u16(), &body);
    Outcome {
        success: result.success,
        retryable: result.retryable,
        http: Some(status.as_u16().into()),
        code: result.code,
        error: result.error,
        retry_after,
    }
}
pub async fn run(s: AppState) -> Result<()> {
    // A crash can happen after remote delivery and before local acknowledgement.
    // Recover with at-least-once semantics and preserve the uncertain attempt.
    let mut tx = s.db.begin().await?;
    sqlx::query(
        "UPDATE attempts SET status='unknown',error='process_interrupted' WHERE status='sending'",
    )
    .execute(&mut *tx)
    .await?;
    let n = sqlx::query(
        "UPDATE deliveries SET status='retrying',next_attempt_at=? WHERE status='sending'",
    )
    .bind(model::now() + 1)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n > 0 {
        audit(
            &mut tx,
            "system",
            "worker.recovered",
            "worker",
            json!({"deliveries":n,"delivery_semantics":"at_least_once"}),
        )
        .await?;
    }
    tx.commit().await?;
    loop {
        // Globally conservative pacing: at most 80 sends/minute, also covering two
        // destination resources that refer to the same bot. Deliberate v1 tradeoff.
        tokio::time::sleep(Duration::from_millis(750)).await;
        let selected = sqlx::query("SELECT d.* FROM deliveries d JOIN resources r ON r.id=d.route_id JOIN resources t ON t.id=d.destination_id WHERE d.status IN ('pending','retrying') AND d.next_attempt_at<=? AND json_extract(r.config,'$.enabled')=1 AND json_extract(t.config,'$.enabled')=1 ORDER BY d.next_attempt_at,d.created_at LIMIT 1")
            .bind(model::now()).fetch_optional(&s.db).await?;
        let Some(row) = selected else { continue };
        let id: String = row.get("id");
        let attempt: i64 = row.get::<i64, _>("attempts") + 1;
        let max: i64 = row.get("max_attempts");
        let mut tx = s.db.begin().await?;
        sqlx::query("UPDATE deliveries SET status='sending',attempts=?,updated_at=? WHERE id=?")
            .bind(attempt)
            .bind(model::now())
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        let attempt_id = sqlx::query(
            "INSERT INTO attempts(delivery_id,attempt,status,created_at) VALUES(?,?,'sending',?)",
        )
        .bind(&id)
        .bind(attempt)
        .bind(model::now())
        .execute(&mut *tx)
        .await?
        .last_insert_rowid();
        audit(
            &mut tx,
            "system",
            "delivery.started",
            &id,
            json!({"attempt":attempt}),
        )
        .await?;
        tx.commit().await?;
        let result = send(&s, &row.get::<String, _>("snapshot")).await;
        let status = if result.success {
            "succeeded"
        } else if result.retryable && attempt < max {
            "retrying"
        } else {
            "failed"
        };
        let delay = (2_i64.pow(attempt.clamp(1, 8) as u32)
            + i64::from(uuid::Uuid::new_v4().as_bytes()[0] % 3))
        .max(result.retry_after);
        let mut tx = s.db.begin().await?;
        sqlx::query(
            "UPDATE attempts SET status=?,http_status=?,provider_code=?,error=? WHERE id=?",
        )
        .bind(if result.success {
            "succeeded"
        } else {
            "failed"
        })
        .bind(result.http)
        .bind(result.code)
        .bind(result.error)
        .bind(attempt_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE deliveries SET status=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?",
        )
        .bind(status)
        .bind(model::now() + delay)
        .bind(result.error)
        .bind(model::now())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
        audit(&mut tx,"system",&format!("delivery.{status}"),&id,json!({"attempt":attempt,"http_status":result.http,"provider_code":result.code,"error":result.error})).await?;
        tx.commit().await?;
    }
}
pub async fn ensure_master_key(s: &AppState) -> Result<()> {
    // Keep a permanent verifier even if all business keys are later deleted.
    if let Some(value) =
        sqlx::query_scalar::<_, String>("SELECT verification FROM vault_metadata WHERE id=1")
            .fetch_optional(&s.db)
            .await?
    {
        if s.vault.open(&value).ok().as_deref() != Some("webhook-relay-vault-v1") {
            bail!("RELAY_MASTER_KEY cannot decrypt existing data");
        }
        return Ok(());
    }
    // Fail at startup with an incorrect key, before accepting more encrypted data.
    if let Some(value) =
        sqlx::query_scalar::<_, String>("SELECT config FROM resources WHERE kind='keys' LIMIT 1")
            .fetch_optional(&s.db)
            .await?
    {
        let c: Value = serde_json::from_str(&value)?;
        if s.vault.open(c["value"].as_str().unwrap_or("")).is_err() {
            bail!("RELAY_MASTER_KEY cannot decrypt existing data");
        }
    }
    sqlx::query("INSERT INTO vault_metadata(id,verification) VALUES(1,?)")
        .bind(s.vault.seal("webhook-relay-vault-v1")?)
        .execute(&s.db)
        .await?;
    Ok(())
}
