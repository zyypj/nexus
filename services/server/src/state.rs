use std::sync::Arc;

use crate::{config::Config, db::Db, gateway::hub::Hub, rate_limit::RateLimiter, storage::Storage};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: Db,
    pub hub: Arc<Hub>,
    pub limiter: Arc<RateLimiter>,
    pub storage: Storage,
    /// Outbound HTTP (LiveKit RoomService).
    pub http: reqwest::Client,
}

impl AppState {
    pub async fn new(config: Config, db: Db) -> anyhow::Result<Self> {
        let storage = Storage::new(config.storage.uploads_dir.clone(), &config.jwt_secret).await?;
        storage.clean_tmp().await;
        Ok(Self {
            limiter: Arc::new(RateLimiter::new(config.rate_limit_enabled)),
            config: Arc::new(config),
            db,
            hub: Arc::new(Hub::new()),
            storage,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()?,
        })
    }
}
