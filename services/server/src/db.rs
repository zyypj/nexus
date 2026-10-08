//! Database access. Everything goes through the [`Db`] alias so that swapping
//! SQLite for PostgreSQL later is a matter of changing this module, the
//! migrations and the few SQLite-specific statements (partial unique indexes
//! and `INSERT OR IGNORE`), not every handler.

use std::{path::Path, str::FromStr, time::Duration};

use anyhow::Context;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

pub type Db = sqlx::SqlitePool;
pub type DbConn = sqlx::SqliteConnection;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn connect(path: &Path) -> anyhow::Result<Db> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating database directory {}", parent.display()))?;
    }
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    open_with_backup(options, path).await
}

/// Opens the file database; when a schema migration is pending, first saves
/// a consistent copy (`VACUUM INTO`) under `<data>/backups/`, so an upgrade
/// can always be rolled back by restoring that file.
async fn open_with_backup(options: SqliteConnectOptions, path: &Path) -> anyhow::Result<Db> {
    if path.exists() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .context("opening SQLite database")?;
        let applied: Vec<(i64,)> = sqlx::query_as("SELECT version FROM _sqlx_migrations WHERE success = 1")
            .fetch_all(&pool)
            .await
            .unwrap_or_default();
        let pending = MIGRATOR
            .iter()
            .filter(|m| !applied.iter().any(|(v,)| *v == m.version))
            .count();
        if !applied.is_empty() && pending > 0 {
            let dir = path.parent().unwrap_or(Path::new(".")).join("backups");
            tokio::fs::create_dir_all(&dir).await?;
            let latest = applied.iter().map(|(v,)| *v).max().unwrap_or(0);
            let file = dir.join(format!("nexus-schema{latest}-{}.db", now_ms()));
            sqlx::query("VACUUM INTO ?")
                .bind(file.to_string_lossy().to_string())
                .execute(&pool)
                .await
                .context("backing up the database before migrating")?;
            tracing::info!(backup = %file.display(), pending, "database backed up before migrating");
        }
        pool.close().await;
    }
    open(options, 8).await
}

/// Private in-memory database, used by tests.
pub async fn connect_memory() -> anyhow::Result<Db> {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);
    // An in-memory database lives in one connection; the pool must not open more.
    open(options, 1).await
}

async fn open(options: SqliteConnectOptions, max_connections: u32) -> anyhow::Result<Db> {
    let pool = SqlitePoolOptions::new()
        .max_connections(max_connections)
        .min_connections(1)
        .idle_timeout(None)
        .max_lifetime(None)
        .connect_with(options)
        .await
        .context("opening SQLite database")?;
    MIGRATOR.run(&pool).await.context("running migrations")?;
    Ok(pool)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn is_unique_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.is_unique_violation())
}
