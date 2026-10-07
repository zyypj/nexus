use base64::Engine;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize, Deserialize)]
pub struct AccessClaims {
    /// User id.
    pub sub: String,
    /// Session id: lets every request be checked against revocation.
    pub sid: String,
    pub iat: i64,
    pub exp: i64,
    /// Token type marker so other HS256 tokens signed with the same secret
    /// can never be used as access tokens.
    pub typ: String,
}

const ACCESS_TYP: &str = "nexus-access";

pub fn issue_access(secret: &[u8], user_id: &str, session_id: &str, ttl_secs: i64) -> anyhow::Result<String> {
    let now = crate::db::now_ms() / 1000;
    let claims = AccessClaims {
        sub: user_id.to_string(),
        sid: session_id.to_string(),
        iat: now,
        exp: now + ttl_secs,
        typ: ACCESS_TYP.to_string(),
    };
    Ok(jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret),
    )?)
}

pub fn verify_access(secret: &[u8], token: &str) -> Option<AccessClaims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 30;
    validation.set_required_spec_claims(&["exp", "sub"]);
    let data = jsonwebtoken::decode::<AccessClaims>(token, &DecodingKey::from_secret(secret), &validation).ok()?;
    (data.claims.typ == ACCESS_TYP).then_some(data.claims)
}

/// Refresh tokens are `<session id>.<random secret>`. Only the SHA-256 of the
/// secret is stored, so a database leak does not leak usable tokens.
pub struct RefreshToken {
    pub session_id: String,
    pub secret: String,
}

impl RefreshToken {
    pub fn generate(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            secret: random_token(32),
        }
    }

    pub fn parse(token: &str) -> Option<Self> {
        let (sid, secret) = token.split_once('.')?;
        if sid.is_empty() || sid.len() > 64 || secret.len() < 32 || secret.len() > 128 {
            return None;
        }
        Some(Self {
            session_id: sid.to_string(),
            secret: secret.to_string(),
        })
    }

    pub fn encode(&self) -> String {
        format!("{}.{}", self.session_id, self.secret)
    }

    pub fn hash(&self) -> String {
        sha256_hex(self.secret.as_bytes())
    }
}

pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    for chunk in buf.chunks_mut(32) {
        let r: [u8; 32] = rand::random();
        chunk.copy_from_slice(&r[..chunk.len()]);
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Constant-time string comparison for secrets.
pub fn secure_eq(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";

    #[test]
    fn access_roundtrip() {
        let t = issue_access(SECRET, "u1", "s1", 60).unwrap();
        let c = verify_access(SECRET, &t).unwrap();
        assert_eq!(c.sub, "u1");
        assert_eq!(c.sid, "s1");
        assert!(verify_access(b"another-secret-another-secret-xx", &t).is_none());
    }

    #[test]
    fn expired_access_rejected() {
        let t = issue_access(SECRET, "u1", "s1", -120).unwrap();
        assert!(verify_access(SECRET, &t).is_none());
    }

    #[test]
    fn refresh_parse() {
        let r = RefreshToken::generate("abc");
        let parsed = RefreshToken::parse(&r.encode()).unwrap();
        assert_eq!(parsed.session_id, "abc");
        assert_eq!(parsed.hash(), r.hash());
        assert!(RefreshToken::parse("nodot").is_none());
        assert!(RefreshToken::parse("a.short").is_none());
    }
}
