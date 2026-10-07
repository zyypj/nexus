use std::{net::IpAddr, path::PathBuf, time::Duration};

use anyhow::{Context, bail};

/// Storage locations. Admin commands only need this part, so they work without
/// JWT/LiveKit secrets being present.
#[derive(Clone, Debug)]
pub struct StorageConfig {
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
    pub uploads_dir: PathBuf,
}

impl StorageConfig {
    pub fn from_env() -> Self {
        let data_dir = PathBuf::from(env_or("NEXUS_DATA_DIR", "/data"));
        let database_path = std::env::var("NEXUS_DATABASE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("nexus.db"));
        let uploads_dir = std::env::var("NEXUS_UPLOADS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("uploads"));
        Self {
            data_dir,
            database_path,
            uploads_dir,
        }
    }
}

#[derive(Clone, Debug)]
pub struct LiveKitConfig {
    /// URL handed to clients, e.g. `wss://media.example.com` or `ws://1.2.3.4:7880`.
    pub url: String,
    /// HTTP(S) base used by the server for the RoomService API. Defaults to
    /// `url` with ws->http; set LIVEKIT_API_URL to use an internal address.
    pub api_url: String,
    pub api_key: String,
    pub api_secret: String,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub app_name: String,
    pub host: IpAddr,
    pub port: u16,
    pub public_url: String,
    pub storage: StorageConfig,
    pub jwt_secret: Vec<u8>,
    pub livekit: Option<LiveKitConfig>,
    pub allow_public_registration: bool,
    pub max_upload_size: u64,
    pub max_avatar_size: u64,
    pub log_level: String,
    pub invite_prefix: String,
    pub access_token_ttl: Duration,
    pub refresh_token_ttl: Duration,
    /// Trust `X-Forwarded-For` for rate limiting. Only enable behind a proxy you control.
    pub trust_proxy: bool,
    pub extra_cors_origins: Vec<String>,
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    /// Disables the rate limiter (integration tests hammer the API from one IP).
    pub rate_limit_enabled: bool,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let jwt_secret = std::env::var("JWT_SECRET").context("JWT_SECRET is required")?;
        if jwt_secret.len() < 32 {
            bail!("JWT_SECRET must be at least 32 characters");
        }

        let livekit = match (
            std::env::var("LIVEKIT_URL").ok().filter(|s| !s.is_empty()),
            std::env::var("LIVEKIT_API_KEY").ok().filter(|s| !s.is_empty()),
            std::env::var("LIVEKIT_API_SECRET").ok().filter(|s| !s.is_empty()),
        ) {
            (Some(url), Some(api_key), Some(api_secret)) => {
                if api_secret.len() < 32 {
                    bail!("LIVEKIT_API_SECRET must be at least 32 characters");
                }
                let api_url = std::env::var("LIVEKIT_API_URL")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| ws_to_http(&url));
                Some(LiveKitConfig {
                    url,
                    api_url: api_url.trim_end_matches('/').to_string(),
                    api_key,
                    api_secret,
                })
            }
            (None, None, None) => None,
            _ => bail!("LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set together"),
        };

        let port: u16 = env_or("NEXUS_PORT", "3000")
            .parse()
            .context("NEXUS_PORT must be a port number")?;
        let host: IpAddr = env_or("NEXUS_HOST", "0.0.0.0")
            .parse()
            .context("NEXUS_HOST must be an IP address")?;

        Ok(Self {
            app_name: env_or("NEXUS_APP_NAME", "Nexus"),
            host,
            port,
            public_url: env_or("NEXUS_PUBLIC_URL", &format!("http://localhost:{port}"))
                .trim_end_matches('/')
                .to_string(),
            storage: StorageConfig::from_env(),
            jwt_secret: jwt_secret.into_bytes(),
            livekit,
            allow_public_registration: parse_bool(&env_or("ALLOW_PUBLIC_REGISTRATION", "false"))
                .context("ALLOW_PUBLIC_REGISTRATION must be true/false")?,
            max_upload_size: parse_size(&env_or("MAX_UPLOAD_SIZE", "25MB"))
                .context("MAX_UPLOAD_SIZE must look like 25MB, 500KB or a byte count")?,
            max_avatar_size: parse_size(&env_or("MAX_AVATAR_SIZE", "4MB")).context("MAX_AVATAR_SIZE is invalid")?,
            log_level: env_or("LOG_LEVEL", "info"),
            invite_prefix: env_or("INVITE_PREFIX", "NEXUS").to_uppercase(),
            access_token_ttl: Duration::from_secs(
                env_or("ACCESS_TOKEN_TTL_SECONDS", "900")
                    .parse()
                    .context("ACCESS_TOKEN_TTL_SECONDS")?,
            ),
            refresh_token_ttl: Duration::from_secs(
                env_or("REFRESH_TOKEN_TTL_DAYS", "30")
                    .parse::<u64>()
                    .context("REFRESH_TOKEN_TTL_DAYS")?
                    * 86_400,
            ),
            trust_proxy: parse_bool(&env_or("TRUST_PROXY", "false")).context("TRUST_PROXY")?,
            extra_cors_origins: env_or("CORS_ORIGINS", "")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect(),
            tls_cert: std::env::var("NEXUS_TLS_CERT")
                .ok()
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
            tls_key: std::env::var("NEXUS_TLS_KEY")
                .ok()
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
            rate_limit_enabled: true,
        })
    }
}

pub fn ws_to_http(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = url.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        url.to_string()
    }
}

impl Config {
    /// Self-contained configuration for integration tests and local tooling.
    pub fn for_tests(data_dir: &std::path::Path) -> Self {
        Self {
            app_name: "Nexus".into(),
            host: IpAddr::from([127, 0, 0, 1]),
            port: 0,
            public_url: "http://127.0.0.1".into(),
            storage: StorageConfig {
                data_dir: data_dir.to_path_buf(),
                database_path: data_dir.join("nexus.db"),
                uploads_dir: data_dir.join("uploads"),
            },
            jwt_secret: b"test-secret-test-secret-test-secret!".to_vec(),
            livekit: Some(LiveKitConfig {
                url: "ws://127.0.0.1:7880".into(),
                // Port 9 (discard) refuses quickly: RoomService calls fail fast in tests.
                api_url: "http://127.0.0.1:9".into(),
                api_key: "APItestkey".into(),
                api_secret: "livekit-test-secret-livekit-test-secret".into(),
            }),
            allow_public_registration: false,
            max_upload_size: 1024 * 1024,
            max_avatar_size: 256 * 1024,
            log_level: "warn".into(),
            invite_prefix: "NEXUS".into(),
            access_token_ttl: Duration::from_secs(900),
            refresh_token_ttl: Duration::from_secs(30 * 86_400),
            trust_proxy: false,
            extra_cors_origins: Vec::new(),
            tls_cert: None,
            tls_key: None,
            rate_limit_enabled: false,
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

pub fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Accepts `1048576`, `500KB`, `25MB`, `1GB` (binary multiples).
pub fn parse_size(value: &str) -> Option<u64> {
    let v = value.trim().to_ascii_uppercase();
    let (num, mult) = if let Some(n) = v.strip_suffix("GB") {
        (n, 1024 * 1024 * 1024)
    } else if let Some(n) = v.strip_suffix("MB") {
        (n, 1024 * 1024)
    } else if let Some(n) = v.strip_suffix("KB") {
        (n, 1024)
    } else if let Some(n) = v.strip_suffix('B') {
        (n, 1)
    } else {
        (v.as_str(), 1)
    };
    num.trim().parse::<u64>().ok().map(|n| n * mult)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(parse_size("25MB"), Some(25 * 1024 * 1024));
        assert_eq!(parse_size("500kb"), Some(500 * 1024));
        assert_eq!(parse_size("1234"), Some(1234));
        assert_eq!(parse_size("abc"), None);
    }

    #[test]
    fn bools() {
        assert_eq!(parse_bool("TRUE"), Some(true));
        assert_eq!(parse_bool("0"), Some(false));
        assert_eq!(parse_bool("maybe"), None);
    }
}
