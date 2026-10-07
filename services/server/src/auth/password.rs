use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};

/// Hashes with Argon2id (v19, crate default parameters: m=19456 KiB, t=2, p=1,
/// the OWASP baseline). Runs on the blocking pool: it is deliberately slow.
pub async fn hash(password: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes())
            .map(|h| h.to_string())
            .map_err(|e| anyhow::anyhow!("argon2 hash failed: {e}"))
    })
    .await?
}

pub async fn verify(password: String, stored: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&stored)
            .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// Verifies against a fixed hash so login timing does not reveal whether a
/// username exists.
pub async fn verify_dummy(password: String) {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let stored = DUMMY
        .get_or_init(|| {
            Argon2::default()
                .hash_password(b"nexus-dummy-password")
                .map(|h| h.to_string())
                .unwrap_or_default()
        })
        .clone();
    let _ = verify(password, stored).await;
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn roundtrip() {
        let h = super::hash("correct horse".into()).await.unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(super::verify("correct horse".into(), h.clone()).await);
        assert!(!super::verify("wrong".into(), h).await);
    }
}
