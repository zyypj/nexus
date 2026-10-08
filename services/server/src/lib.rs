pub mod admin_cli;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod gateway;
pub mod invites;
pub mod livekit;
pub mod models;
pub mod rate_limit;
pub mod routes;
pub mod state;
pub mod storage;

use std::{net::SocketAddr, time::Duration};

use anyhow::Context;

pub use crate::{config::Config, state::AppState};

/// rustls needs a process-wide crypto provider; `ring` avoids the aws-lc C build.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub fn app(state: AppState) -> axum::Router {
    routes::router(state)
}

/// Hourly maintenance: purge never-sent uploads and expired sessions.
fn spawn_maintenance(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            match routes::attachments::purge_pending(&state).await {
                Ok(n) if n > 0 => tracing::info!(count = n, "purged pending uploads"),
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "upload purge failed"),
            }
            let cutoff = db::now_ms() - 7 * 86_400_000;
            if let Err(e) = sqlx::query("DELETE FROM sessions WHERE expires_at < ?1 OR revoked_at < ?1")
                .bind(cutoff)
                .execute(&state.db)
                .await
            {
                tracing::warn!(error = %e, "session cleanup failed");
            }
        }
    });
}

/// Calls left "active" by a previous process cannot have live participants
/// we know about; end them so clients do not see ghost calls.
async fn end_stale_calls(state: &AppState) -> anyhow::Result<()> {
    let now = db::now_ms();
    sqlx::query("UPDATE call_participants SET left_at = ? WHERE left_at IS NULL")
        .bind(now)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE calls SET ended_at = ? WHERE ended_at IS NULL")
        .bind(now)
        .execute(&state.db)
        .await?;
    Ok(())
}

pub async fn serve(config: Config) -> anyhow::Result<()> {
    install_crypto_provider();
    let db = db::connect(&config.storage.database_path).await?;
    let addr = SocketAddr::new(config.host, config.port);
    let tls = match (&config.tls_cert, &config.tls_key) {
        (Some(c), Some(k)) => Some((c.clone(), k.clone())),
        (None, None) => None,
        _ => anyhow::bail!("NEXUS_TLS_CERT and NEXUS_TLS_KEY must be set together"),
    };
    let state = AppState::new(config, db).await?;
    end_stale_calls(&state).await?;
    spawn_maintenance(state.clone());
    if std::env::var_os("NEXUS_DISABLE_CONSOLE").is_none() {
        admin_cli::spawn_console(state.db.clone());
    }

    tracing::info!(
        %addr,
        database = %state.config.storage.database_path.display(),
        uploads = %state.config.storage.uploads_dir.display(),
        calls = state.config.livekit.is_some(),
        public_registration = state.config.allow_public_registration,
        tls = tls.is_some(),
        "{} server listening", state.config.app_name
    );
    let app = app(state).into_make_service_with_connect_info::<SocketAddr>();

    if let Some((cert, key)) = tls {
        let rustls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert, &key)
            .await
            .context("loading TLS certificate/key")?;
        let handle = axum_server::Handle::new();
        let h = handle.clone();
        tokio::spawn(async move {
            shutdown_signal().await;
            h.graceful_shutdown(Some(Duration::from_secs(10)));
        });
        axum_server::bind_rustls(addr, rustls_config)
            .handle(handle)
            .serve(app)
            .await?;
    } else {
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("binding {addr}"))?;
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal())
            .await?;
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
    tracing::info!("shutting down");
}
