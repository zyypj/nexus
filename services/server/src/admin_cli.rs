//! `nexus-server admin ...` commands. They talk to the database directly, so
//! they work while the server is running (SQLite WAL allows concurrent access)
//! and do not need JWT/LiveKit secrets.

use clap::Subcommand;

use crate::{config::StorageConfig, db, invites, routes::admin};

#[derive(Subcommand, Debug)]
pub enum AdminCommand {
    /// Manage invite codes
    Invite {
        #[command(subcommand)]
        cmd: InviteCommand,
    },
    /// Manage users
    User {
        #[command(subcommand)]
        cmd: UserCommand,
    },
}

#[derive(Subcommand, Debug)]
pub enum InviteCommand {
    /// Create a new invite code
    Create {
        /// Maximum number of accounts that can use this code (default: unlimited)
        #[arg(long)]
        max_uses: Option<i64>,
        /// Expiration, e.g. 30m, 12h, 7d (default: never)
        #[arg(long)]
        expires_in: Option<String>,
    },
    /// List all invite codes
    List,
    /// Revoke an invite code
    Revoke { code: String },
}

#[derive(Subcommand, Debug)]
pub enum UserCommand {
    /// List all users
    List,
    /// Disable a user (signs them out everywhere)
    Disable { username: String },
    /// Re-enable a disabled user
    Enable { username: String },
    /// Grant administrator rights
    Promote { username: String },
    /// Remove administrator rights
    Demote { username: String },
}

fn fmt_time(ms: Option<i64>) -> String {
    match ms {
        None => "-".into(),
        Some(ms) => {
            let secs = ms / 1000;
            let days = secs.div_euclid(86_400);
            let rem = secs.rem_euclid(86_400);
            let (y, m, d) = civil_from_days(days);
            format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", rem / 3600, (rem % 3600) / 60)
        }
    }
}

/// Howard Hinnant's days-to-civil algorithm (avoids a date crate for one printout).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

async fn user_id_by_name(pool: &db::Db, username: &str) -> anyhow::Result<String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE username = ?")
        .bind(username.trim().to_ascii_lowercase())
        .fetch_optional(pool)
        .await?;
    row.map(|r| r.0)
        .ok_or_else(|| anyhow::anyhow!("user '{username}' not found"))
}

pub async fn run(cmd: AdminCommand) -> anyhow::Result<()> {
    let storage = StorageConfig::from_env();
    let pool = db::connect(&storage.database_path).await?;
    let prefix = std::env::var("INVITE_PREFIX")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "NEXUS".into())
        .to_uppercase();

    match cmd {
        AdminCommand::Invite { cmd } => match cmd {
            InviteCommand::Create { max_uses, expires_in } => {
                if max_uses.is_some_and(|n| n < 1) {
                    anyhow::bail!("--max-uses must be at least 1");
                }
                let expires_at = match expires_in.as_deref() {
                    Some(s) => Some(
                        db::now_ms()
                            + invites::parse_duration_ms(s)
                                .ok_or_else(|| anyhow::anyhow!("--expires-in must look like 30m, 12h or 7d"))?,
                    ),
                    None => None,
                };
                let invite = invites::create(&pool, &prefix, max_uses, expires_at, None).await?;
                println!("Invite criado:\n{}", invite.code);
                println!(
                    "usos: {}  expira: {}",
                    invite.max_uses.map_or("ilimitado".into(), |n| n.to_string()),
                    fmt_time(invite.expires_at)
                );
            }
            InviteCommand::List => {
                let list = invites::list(&pool).await?;
                if list.is_empty() {
                    println!("Nenhum invite.");
                }
                println!("{:<18} {:>9} {:<22} {:<8}", "CODE", "USES", "EXPIRES", "STATUS");
                for i in list {
                    let uses = format!("{}/{}", i.uses, i.max_uses.map_or("∞".into(), |n| n.to_string()));
                    let expired = i.expires_at.is_some_and(|e| e <= db::now_ms());
                    let exhausted = i.max_uses.is_some_and(|m| i.uses >= m);
                    let status = if i.revoked {
                        "revoked"
                    } else if expired {
                        "expired"
                    } else if exhausted {
                        "used"
                    } else {
                        "active"
                    };
                    println!(
                        "{:<18} {:>9} {:<22} {:<8}",
                        i.code,
                        uses,
                        fmt_time(i.expires_at),
                        status
                    );
                }
            }
            InviteCommand::Revoke { code } => {
                if invites::revoke(&pool, &code).await? {
                    println!("Invite {} revogado.", invites::normalize_code(&code));
                } else {
                    anyhow::bail!("invite '{code}' not found");
                }
            }
        },
        AdminCommand::User { cmd } => match cmd {
            UserCommand::List => {
                let users = admin::all_users(&pool).await?;
                println!(
                    "{:<24} {:<24} {:<6} {:<9} {:<22}",
                    "USERNAME", "DISPLAY NAME", "ADMIN", "STATUS", "CREATED"
                );
                for u in users {
                    println!(
                        "{:<24} {:<24} {:<6} {:<9} {:<22}",
                        u.username,
                        u.display_name,
                        if u.is_admin { "yes" } else { "" },
                        if u.disabled { "disabled" } else { "active" },
                        fmt_time(Some(u.created_at))
                    );
                }
            }
            UserCommand::Disable { username } => {
                let id = user_id_by_name(&pool, &username).await?;
                admin::set_disabled(&pool, &id, true).await?;
                println!("Usuário {username} desativado e desconectado de todas as sessões.");
            }
            UserCommand::Enable { username } => {
                let id = user_id_by_name(&pool, &username).await?;
                admin::set_disabled(&pool, &id, false).await?;
                println!("Usuário {username} reativado.");
            }
            UserCommand::Promote { username } => {
                let id = user_id_by_name(&pool, &username).await?;
                sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?")
                    .bind(&id)
                    .execute(&pool)
                    .await?;
                println!("Usuário {username} agora é administrador.");
            }
            UserCommand::Demote { username } => {
                let id = user_id_by_name(&pool, &username).await?;
                sqlx::query("UPDATE users SET is_admin = 0 WHERE id = ?")
                    .bind(&id)
                    .execute(&pool)
                    .await?;
                println!("Usuário {username} não é mais administrador.");
            }
        },
    }
    pool.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn civil() {
        assert_eq!(super::civil_from_days(0), (1970, 1, 1));
        assert_eq!(super::civil_from_days(20_000), (2024, 10, 4));
    }
}
