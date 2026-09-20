use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{env, str::FromStr, sync::Arc, time::Duration};
use webhook_relay::{
    api,
    crypto::Vault,
    store::{self, AppState},
    worker,
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "webhook_relay=info".into()),
        )
        .json()
        .init();
    let token =
        env::var("RELAY_ADMIN_TOKEN").context("set RELAY_ADMIN_TOKEN (at least 32 characters)")?;
    ensure!(
        token.len() >= 32,
        "admin token must contain at least 32 characters"
    );
    let vault = Vault::new(
        &env::var("RELAY_MASTER_KEY")
            .context("set RELAY_MASTER_KEY to a base64-encoded random 32-byte key")?,
    )?;
    let database = env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://data/relay.db".into());
    if database == "sqlite://data/relay.db" {
        std::fs::create_dir_all("data")?;
    }
    let database_options = sqlx::sqlite::SqliteConnectOptions::from_str(&database)?;
    let lock_path = database_options.get_filename().with_extension("db.lock");
    let _database_lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .context("open database lock file")?;
    _database_lock
        .try_lock()
        .context("another relay instance is using this database")?;
    let db = store::connect(&database).await?;
    let public_url = env::var("RELAY_PUBLIC_URL")
        .unwrap_or_else(|_| "http://localhost:8080".into())
        .trim_end_matches('/')
        .to_owned();
    let public = url::Url::parse(&public_url)?;
    ensure!(
        matches!(public.scheme(), "https" | "http"),
        "invalid public URL"
    );
    let mock_origin = env::var("RELAY_TEST_FEISHU_ORIGIN").ok();
    if let Some(origin) = &mock_origin {
        let u = url::Url::parse(origin)?;
        ensure!(
            u.scheme() == "http"
                && u.host_str() == Some("127.0.0.1")
                && u.origin().ascii_serialization() == *origin,
            "test origin must be an exact http://127.0.0.1:PORT origin"
        );
        tracing::warn!("Loopback-only Feishu test endpoint enabled");
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("webhook-relay/0.1")
        .build()?;
    let s = AppState {
        db,
        vault,
        token_hash: Sha256::digest(token.as_bytes()).to_vec(),
        public_url,
        mock_origin,
        client,
        config_lock: Arc::new(tokio::sync::Mutex::new(())),
    };
    worker::ensure_master_key(&s).await?;
    let app = api::router(
        s.clone(),
        &env::var("RELAY_WEB_DIR").unwrap_or_else(|_| "web/dist".into()),
    );
    let bind = env::var("RELAY_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(address=%bind,"Webhook Relay listening");
    let worker_task = tokio::spawn(worker::run(s));
    let server = axum::serve(listener, app).with_graceful_shutdown(async {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("signal handler");
            tokio::select! {_ = tokio::signal::ctrl_c()=>{},_ = terminate.recv()=>{}}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
    });
    tokio::select! {result=worker_task=>{result??; anyhow::bail!("worker stopped unexpectedly");},result=server=>{result?;}}
    Ok(())
}
