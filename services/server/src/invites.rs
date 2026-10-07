//! Invite codes (`NEXUS-X7H4-K9P2`). Shared by the admin CLI and the admin API.

use crate::{
    db::{Db, DbConn, now_ms},
    models::Invite,
};

/// No 0/O/1/I so codes stay readable when dictated. 32 symbols = 5 bits each.
const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub fn generate_code(prefix: &str) -> String {
    let bytes: [u8; 8] = rand::random();
    let chars: Vec<char> = bytes.iter().map(|b| ALPHABET[(b & 31) as usize] as char).collect();
    let a: String = chars[..4].iter().collect();
    let b: String = chars[4..].iter().collect();
    format!("{prefix}-{a}-{b}")
}

pub fn normalize_code(code: &str) -> String {
    code.trim().to_ascii_uppercase()
}

pub async fn create(
    db: &Db,
    prefix: &str,
    max_uses: Option<i64>,
    expires_at: Option<i64>,
    created_by: Option<&str>,
) -> anyhow::Result<Invite> {
    let now = now_ms();
    // Collisions are astronomically unlikely, but retrying is free.
    for _ in 0..5 {
        let code = generate_code(prefix);
        let res = sqlx::query(
            "INSERT INTO invites (code, created_by, max_uses, uses, expires_at, revoked, created_at)
             VALUES (?, ?, ?, 0, ?, 0, ?)",
        )
        .bind(&code)
        .bind(created_by)
        .bind(max_uses)
        .bind(expires_at)
        .bind(now)
        .execute(db)
        .await;
        match res {
            Ok(_) => {
                return Ok(Invite {
                    code,
                    max_uses,
                    uses: 0,
                    expires_at,
                    revoked: false,
                    created_at: now,
                });
            }
            Err(e) if crate::db::is_unique_violation(&e) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!("could not generate a unique invite code")
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    code: String,
    max_uses: Option<i64>,
    uses: i64,
    expires_at: Option<i64>,
    revoked: i64,
    created_at: i64,
}

pub async fn list(db: &Db) -> anyhow::Result<Vec<Invite>> {
    let rows: Vec<InviteRow> = sqlx::query_as(
        "SELECT code, max_uses, uses, expires_at, revoked, created_at FROM invites ORDER BY created_at DESC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Invite {
            code: r.code,
            max_uses: r.max_uses,
            uses: r.uses,
            expires_at: r.expires_at,
            revoked: r.revoked != 0,
            created_at: r.created_at,
        })
        .collect())
}

pub async fn revoke(db: &Db, code: &str) -> anyhow::Result<bool> {
    let res = sqlx::query("UPDATE invites SET revoked = 1 WHERE code = ?")
        .bind(normalize_code(code))
        .execute(db)
        .await?;
    Ok(res.rows_affected() == 1)
}

/// Atomically consumes one use. Must run inside the registration transaction
/// so a failed signup does not burn an invite.
pub async fn consume(conn: &mut DbConn, code: &str) -> anyhow::Result<bool> {
    let res = sqlx::query(
        "UPDATE invites SET uses = uses + 1
         WHERE code = ? AND revoked = 0
           AND (expires_at IS NULL OR expires_at > ?)
           AND (max_uses IS NULL OR uses < max_uses)",
    )
    .bind(normalize_code(code))
    .bind(now_ms())
    .execute(&mut *conn)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Parses durations like `30m`, `12h`, `7d`.
pub fn parse_duration_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let (num, unit) = s.split_at(s.len().checked_sub(1)?);
    let n: i64 = num.parse().ok()?;
    if n <= 0 {
        return None;
    }
    let mult = match unit {
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return None,
    };
    n.checked_mul(mult)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_format() {
        let c = generate_code("NEXUS");
        assert_eq!(c.len(), "NEXUS-XXXX-XXXX".len());
        let parts: Vec<&str> = c.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts[1..].iter().all(|p| p.bytes().all(|b| ALPHABET.contains(&b))));
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration_ms("7d"), Some(7 * 86_400_000));
        assert_eq!(parse_duration_ms("90m"), Some(90 * 60_000));
        assert_eq!(parse_duration_ms("0d"), None);
        assert_eq!(parse_duration_ms("x"), None);
        assert_eq!(parse_duration_ms(""), None);
    }
}
