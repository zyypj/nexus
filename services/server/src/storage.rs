//! Local file storage for attachments and avatars.
//!
//! Files are stored under random 128-bit hex names; user-supplied names never
//! touch the filesystem, which rules out path traversal by construction.
//! Downloads use short-lived HMAC-signed URLs because `<img src>` cannot send
//! an Authorization header; a URL is only ever handed to conversation members.

use std::path::{Path, PathBuf};

use anyhow::Context;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

pub const SIGNED_URL_TTL_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Clone)]
pub struct Storage {
    root: PathBuf,
    signing_key: Vec<u8>,
}

impl Storage {
    pub async fn new(root: PathBuf, jwt_secret: &[u8]) -> anyhow::Result<Self> {
        for sub in ["files", "avatars", "tmp"] {
            let dir = root.join(sub);
            tokio::fs::create_dir_all(&dir)
                .await
                .with_context(|| format!("creating {}", dir.display()))?;
        }
        // Derive a dedicated key so file signatures and JWTs never share a key.
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(jwt_secret).expect("hmac accepts any key length");
        mac.update(b"nexus-file-signing-v1");
        let signing_key = mac.finalize().into_bytes().to_vec();
        Ok(Self { root, signing_key })
    }

    pub fn new_storage_name() -> String {
        hex::encode(rand::random::<[u8; 16]>())
    }

    pub fn is_valid_storage_name(name: &str) -> bool {
        name.len() == 32 && name.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    pub fn file_path(&self, storage_name: &str) -> Option<PathBuf> {
        Self::is_valid_storage_name(storage_name).then(|| self.root.join("files").join(storage_name))
    }

    pub fn avatar_path(&self, storage_name: &str) -> Option<PathBuf> {
        Self::is_valid_storage_name(storage_name).then(|| self.root.join("avatars").join(storage_name))
    }

    pub fn temp_path(&self) -> PathBuf {
        self.root.join("tmp").join(Self::new_storage_name())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn signature(&self, attachment_id: &str, expires_ms: i64) -> String {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.signing_key).expect("hmac key");
        mac.update(attachment_id.as_bytes());
        mac.update(b"|");
        mac.update(expires_ms.to_string().as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// Relative URL; clients prefix it with the server base URL.
    pub fn signed_file_url(&self, attachment_id: &str, file_name: &str, now_ms: i64) -> String {
        // Round expiry to the hour so repeated fetches produce identical URLs
        // and clients can cache images.
        let hour = 60 * 60 * 1000;
        let expires = ((now_ms + SIGNED_URL_TTL_MS) / hour + 1) * hour;
        format!(
            "/api/files/{attachment_id}/{}?exp={expires}&sig={}",
            url_path_segment(file_name),
            self.signature(attachment_id, expires)
        )
    }

    pub fn verify_signature(&self, attachment_id: &str, expires_ms: i64, sig: &str, now_ms: i64) -> bool {
        expires_ms > now_ms && crate::auth::tokens::secure_eq(&self.signature(attachment_id, expires_ms), sig)
    }

    /// Removes leftovers in tmp/ (crashed uploads). Called at startup.
    pub async fn clean_tmp(&self) {
        if let Ok(mut rd) = tokio::fs::read_dir(self.root.join("tmp")).await {
            while let Ok(Some(entry)) = rd.next_entry().await {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
}

pub fn avatar_url(storage_name: &Option<String>) -> Option<String> {
    storage_name.as_ref().map(|n| format!("/api/avatars/{n}"))
}

/// Strips anything dangerous from a user-supplied file name. The result is only
/// used for display and `Content-Disposition`, never as a path.
pub fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '"' | '<' | '>' | ':' | '|' | '?' | '*'))
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let mut out: String = trimmed.chars().take(180).collect();
    if out.is_empty() {
        out = "file".to_string();
    }
    out
}

fn url_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn content_disposition(file_name: &str, inline: bool) -> String {
    let ascii: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "{}; filename=\"{}\"; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        ascii,
        url_path_segment(file_name)
    )
}

/// Image types we render inline. Everything else is served as a download with
/// `application/octet-stream` to avoid any chance of executing content.
/// Video/audio played inline by the apps (`<video>`/`<audio>`, seeking via
/// Range requests). Media types cannot run script, so serving them inline is
/// as safe as images; anything else is still forced to download.
pub fn inline_media_mime(stored: Option<&str>) -> Option<&'static str> {
    match stored? {
        "video/mp4" | "video/quicktime" => Some("video/mp4"),
        "video/webm" => Some("video/webm"),
        "video/x-matroska" => Some("video/x-matroska"),
        "audio/mpeg" => Some("audio/mpeg"),
        "audio/ogg" => Some("audio/ogg"),
        "audio/x-wav" | "audio/wav" => Some("audio/wav"),
        "audio/x-flac" | "audio/flac" => Some("audio/flac"),
        "audio/m4a" | "audio/mp4" | "audio/x-m4a" => Some("audio/mp4"),
        _ => None,
    }
}

pub fn inline_image_mime(sniffed: Option<&str>) -> Option<&'static str> {
    match sniffed? {
        "image/png" => Some("image/png"),
        "image/jpeg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_file_name("..."), "file");
        assert_eq!(sanitize_file_name("a\"b<c>.txt"), "abc.txt");
        assert_eq!(sanitize_file_name("foto férias.png"), "foto férias.png");
    }

    #[test]
    fn storage_names() {
        let n = Storage::new_storage_name();
        assert!(Storage::is_valid_storage_name(&n));
        assert!(!Storage::is_valid_storage_name("../aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!Storage::is_valid_storage_name("ABCDEF0123456789abcdef0123456789"));
    }

    #[tokio::test]
    async fn signatures() {
        let dir = tempfile::tempdir().unwrap();
        let s = Storage::new(dir.path().to_path_buf(), b"0123456789abcdef0123456789abcdef")
            .await
            .unwrap();
        let url = s.signed_file_url("att1", "a b.png", 1_000);
        let q = url.split_once('?').unwrap().1;
        let mut exp = 0;
        let mut sig = "";
        for kv in q.split('&') {
            let (k, v) = kv.split_once('=').unwrap();
            if k == "exp" {
                exp = v.parse().unwrap();
            } else {
                sig = v;
            }
        }
        assert!(s.verify_signature("att1", exp, sig, 1_000));
        assert!(!s.verify_signature("att2", exp, sig, 1_000));
        assert!(!s.verify_signature("att1", exp, sig, exp + 1));
        assert!(url.contains("a%20b.png"));
    }
}
