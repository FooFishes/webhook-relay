//! Persistence for open groups. The rule and delivery target are frozen when a group opens.
use super::{GroupState, Rule, render, render_notice};
use crate::{
    model::{self, RelayEvent},
    providers::registry,
    store::{AppState, Target, audit, queue_delivery},
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, Transaction};

#[derive(Serialize, Deserialize)]
struct Snapshot {
    rule: Rule,
    target: Target,
}

/// Adds an event to its open group, opening one if needed, and queues any notices.
pub async fn attach(
    tx: &mut Transaction<'_, Sqlite>,
    s: &AppState,
    rule: &Rule,
    key: &str,
    target: Target,
    event: &RelayEvent,
    event_id: &str,
) -> Result<String> {
    let now = model::now();
    let key_hash = hex::encode(Sha256::digest(key.as_bytes()));
    let open = sqlx::query("SELECT id,due_at FROM aggregates WHERE route_id=? AND rule_id=? AND group_key=? AND state='open'")
        .bind(&target.route_id).bind(&rule.id).bind(&key_hash)
        .fetch_optional(&mut **tx).await?;
    // A group past its deadline is sent before the new event starts the next one.
    let open = match open {
        Some(row) if row.get::<i64, _>("due_at") <= now => {
            flush(tx, s, &row.get::<String, _>("id"), now).await?;
            None
        }
        other => other,
    };
    let (id, snapshot, mut state) = match open {
        Some(row) => {
            let id: String = row.get("id");
            let (snapshot, state) = load(tx, s, &id).await?;
            (id, snapshot, state)
        }
        None => (
            model::id(),
            Snapshot {
                rule: rule.clone(),
                target,
            },
            GroupState::open(now),
        ),
    };
    let fresh = state.event_count == 0;
    let notices = state.apply(&snapshot.rule, event, now);
    let (due, _) = state.due_at(&snapshot.rule);
    let sealed_state = s.vault.seal(&serde_json::to_string(&state)?)?;
    if fresh {
        sqlx::query("INSERT INTO aggregates(id,route_id,rule_id,group_key,state,snapshot,group_state,event_count,opened_at,last_event_at,due_at) VALUES(?,?,?,?,'open',?,?,?,?,?,?)")
            .bind(&id).bind(&snapshot.target.route_id).bind(&snapshot.rule.id).bind(&key_hash)
            .bind(s.vault.seal(&serde_json::to_string(&snapshot)?)?).bind(&sealed_state)
            .bind(state.event_count).bind(state.opened_at).bind(state.last_event_at).bind(due)
            .execute(&mut **tx).await?;
    } else {
        sqlx::query(
            "UPDATE aggregates SET group_state=?,event_count=?,last_event_at=?,due_at=? WHERE id=?",
        )
        .bind(&sealed_state)
        .bind(state.event_count)
        .bind(state.last_event_at)
        .bind(due)
        .bind(&id)
        .execute(&mut **tx)
        .await?;
    }
    sqlx::query("INSERT INTO aggregate_members(aggregate_id,event_id,seq) VALUES(?,?,?)")
        .bind(&id)
        .bind(event_id)
        .bind(state.event_count)
        .execute(&mut **tx)
        .await?;
    let destination = registry::destination(&snapshot.target.provider)?;
    for notice in &notices {
        let payload = render_notice(&snapshot.rule, notice, &state, destination);
        queue_delivery(tx, &s.vault, &snapshot.target, event_id, Some(&id), payload).await?;
    }
    audit(
        tx,
        "system",
        if fresh {
            "aggregate.opened"
        } else {
            "aggregate.updated"
        },
        &id,
        json!({"event_id":event_id,"route_id":snapshot.target.route_id,"rule_id":snapshot.rule.id,"events":state.event_count,"due_at":due,"notices":notices.len()}),
    )
    .await?;
    Ok(id)
}

/// Renders the summary of an open group as one delivery and closes the group.
pub async fn flush(
    tx: &mut Transaction<'_, Sqlite>,
    s: &AppState,
    id: &str,
    now: i64,
) -> Result<()> {
    let still_open: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM aggregates WHERE id=? AND state='open'")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    if still_open.is_none() {
        return Ok(());
    }
    let (snapshot, state) = load(tx, s, id).await?;
    let (_, reason) = state.due_at(&snapshot.rule);
    let last_event: String = sqlx::query_scalar(
        "SELECT event_id FROM aggregate_members WHERE aggregate_id=? ORDER BY seq DESC LIMIT 1",
    )
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    let destination = registry::destination(&snapshot.target.provider)?;
    let payload = render(&snapshot.rule, &state, reason, destination);
    let delivery = queue_delivery(
        tx,
        &s.vault,
        &snapshot.target,
        &last_event,
        Some(id),
        payload,
    )
    .await?;
    sqlx::query("UPDATE aggregates SET state='flushed',flush_reason=?,flushed_at=? WHERE id=?")
        .bind(serde_json::to_value(reason)?.as_str())
        .bind(now)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    audit(
        tx,
        "system",
        "aggregate.flushed",
        id,
        json!({"reason":reason,"events":state.event_count,"delivery_id":delivery}),
    )
    .await?;
    Ok(())
}

/// Flushes every group whose deadline has passed.
pub async fn flush_due(s: &AppState) -> Result<usize> {
    let now = model::now();
    let due: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM aggregates WHERE state='open' AND due_at<=? ORDER BY due_at LIMIT 50",
    )
    .bind(now)
    .fetch_all(&s.db)
    .await?;
    if due.is_empty() {
        return Ok(0);
    }
    // Receive updates groups under the same lock, so a flush never races an attach.
    let _guard = s.config_lock.lock().await;
    for id in &due {
        let mut tx = s.db.begin().await?;
        flush(&mut tx, s, id, now).await?;
        tx.commit().await?;
    }
    Ok(due.len())
}

async fn load(
    tx: &mut Transaction<'_, Sqlite>,
    s: &AppState,
    id: &str,
) -> Result<(Snapshot, GroupState)> {
    let row = sqlx::query("SELECT snapshot,group_state FROM aggregates WHERE id=?")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    Ok((
        serde_json::from_str(&s.vault.open(&row.get::<String, _>("snapshot"))?)?,
        serde_json::from_str(&s.vault.open(&row.get::<String, _>("group_state"))?)?,
    ))
}
