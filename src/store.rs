use crate::{
    crypto::Vault,
    model::{Resource, now},
};
use anyhow::Result;
use serde_json::{Value, json};
use sqlx::{
    Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{str::FromStr, time::Duration};

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub vault: Vault,
    pub token_hash: Vec<u8>,
    pub public_url: String,
    pub mock_origin: Option<String>,
    pub client: reqwest::Client,
    pub config_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
}
pub async fn connect(url: &str) -> Result<SqlitePool> {
    let options = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(10));
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}
pub async fn audit(
    tx: &mut Transaction<'_, Sqlite>,
    actor: &str,
    action: &str,
    id: &str,
    detail: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO audit(actor,action,resource_id,detail,created_at) VALUES(?,?,?,?,?)")
        .bind(actor)
        .bind(action)
        .bind(id)
        .bind(detail.to_string())
        .bind(now())
        .execute(&mut **tx)
        .await?;
    Ok(())
}
impl AppState {
    pub async fn resource(&self, id: &str) -> std::result::Result<Resource, sqlx::Error> {
        sqlx::query_as::<_, Resource>("SELECT * FROM resources WHERE id=?")
            .bind(id)
            .fetch_one(&self.db)
            .await
    }
    pub async fn resources(&self, kind: &str) -> Result<Vec<Resource>> {
        Ok(sqlx::query_as::<_, Resource>(
            "SELECT * FROM resources WHERE kind=? ORDER BY created_at,id",
        )
        .bind(kind)
        .fetch_all(&self.db)
        .await?)
    }
    pub async fn key(&self, id: &str) -> Result<String> {
        let r = self.resource(id).await?;
        anyhow::ensure!(r.kind == "keys", "key reference required");
        let c: Value = serde_json::from_str(&r.config)?;
        self.vault.open(
            c["value"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid key"))?,
        )
    }
    pub async fn log(&self, actor: &str, action: &str, id: &str, detail: Value) -> Result<()> {
        let mut tx = self.db.begin().await?;
        audit(&mut tx, actor, action, id, detail).await?;
        tx.commit().await?;
        Ok(())
    }
}
pub fn public_resource(r: &Resource) -> Result<Value> {
    let mut c: Value = serde_json::from_str(&r.config)?;
    if r.kind == "keys" {
        c = json!({"has_value":true});
    }
    Ok(
        json!({"id":r.id,"kind":r.kind,"name":r.name,"config":c,"revision":r.revision,"created_at":r.created_at,"updated_at":r.updated_at}),
    )
}
