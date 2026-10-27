//! Mentions in message text, Discord syntax: `<@user id>`, `<@&role id>`,
//! `@everyone` and `@here`. Mentions inside code (``` blocks or `inline`)
//! do not count, matching how the apps render the text.
//!
//! Stored per message (see migrations/0003_mentions.sql) so a channel's
//! unread mention count is a single query. `@here` is resolved when the
//! message is sent: only the members online at that moment get a row.

use std::collections::HashSet;

use sqlx::SqliteConnection;

use crate::error::ApiResult;

/// Distinct users/roles kept per message; the rest are ignored.
pub const MAX_MENTIONS: usize = 50;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub users: Vec<String>,
    pub roles: Vec<String>,
    pub everyone: bool,
    pub here: bool,
}

impl Parsed {
    pub fn is_empty(&self) -> bool {
        self.users.is_empty() && self.roles.is_empty() && !self.everyone && !self.here
    }
}

/// What a message ends up mentioning after permission checks.
#[derive(Debug, Default)]
pub struct Resolved {
    pub users: Vec<String>,
    pub roles: Vec<String>,
    /// 0 = none, 1 = @everyone, 2 = @here.
    pub everyone: i64,
    /// For @here: the members online when it was sent.
    pub here_users: Vec<String>,
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_id(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// The text outside ``` blocks and single-line `inline code`.
fn outside_code(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    for (bi, block) in content.split("```").enumerate() {
        if bi % 2 == 1 {
            out.push(' ');
            continue;
        }
        for (li, line) in block.split('\n').enumerate() {
            if li > 0 {
                out.push('\n');
            }
            let parts: Vec<&str> = line.split('`').collect();
            let last = parts.len() - 1;
            for (pi, part) in parts.iter().enumerate() {
                // Odd parts are code only when a closing backtick follows.
                if pi % 2 == 1 && pi < last && !part.is_empty() {
                    out.push(' ');
                } else {
                    out.push_str(part);
                }
            }
        }
    }
    out
}

pub fn parse(content: &str) -> Parsed {
    let text = outside_code(content);
    let bytes = text.as_bytes();
    let mut p = Parsed::default();
    let mut seen = HashSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' && bytes.get(i + 1) == Some(&b'@') {
            let role = bytes.get(i + 2) == Some(&b'&');
            let start = i + if role { 3 } else { 2 };
            if let Some(len) = text.get(start..).and_then(|rest| rest.find('>')) {
                let id = &text[start..start + len];
                if is_id(id) {
                    let list = if role { &mut p.roles } else { &mut p.users };
                    if list.len() < MAX_MENTIONS && seen.insert((role, id.to_string())) {
                        list.push(id.to_string());
                    }
                    i = start + len + 1;
                    continue;
                }
            }
        }
        if bytes[i] == b'@' && (i == 0 || !is_word(bytes[i - 1])) {
            for (word, everyone) in [("everyone", true), ("here", false)] {
                let end = i + 1 + word.len();
                if text.get(i + 1..end) == Some(word) && !bytes.get(end).copied().is_some_and(is_word) {
                    if everyone {
                        p.everyone = true;
                    } else {
                        p.here = true;
                    }
                }
            }
        }
        i += 1;
    }
    p
}

/// Keeps users who can see the conversation and roles of its server.
/// `@everyone`/`@here` only count when `can_mention_everyone`.
pub fn resolve(
    parsed: Parsed,
    author_id: &str,
    viewers: &[String],
    server_roles: &[String],
    can_mention_everyone: bool,
    is_online: impl Fn(&str) -> bool,
) -> Resolved {
    let viewers_set: HashSet<&str> = viewers.iter().map(String::as_str).collect();
    let mut r = Resolved {
        users: parsed
            .users
            .into_iter()
            .filter(|u| viewers_set.contains(u.as_str()))
            .collect(),
        roles: parsed
            .roles
            .into_iter()
            .filter(|id| server_roles.contains(id))
            .collect(),
        ..Default::default()
    };
    if can_mention_everyone {
        if parsed.everyone {
            r.everyone = 1;
        } else if parsed.here {
            r.everyone = 2;
            r.here_users = viewers
                .iter()
                .filter(|u| u.as_str() != author_id && is_online(u))
                .cloned()
                .collect();
        }
    }
    r
}

/// Replaces the stored mentions of a message (send and edit).
pub async fn save(conn: &mut SqliteConnection, message_id: &str, r: &Resolved) -> ApiResult<()> {
    sqlx::query("DELETE FROM message_mentions WHERE message_id = ?")
        .bind(message_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE messages SET mention_everyone = ? WHERE id = ?")
        .bind(r.everyone)
        .bind(message_id)
        .execute(&mut *conn)
        .await?;
    let rows = r
        .users
        .iter()
        .map(|t| ("user", t))
        .chain(r.roles.iter().map(|t| ("role", t)))
        .chain(r.here_users.iter().map(|t| ("here", t)));
    for (kind, target) in rows {
        sqlx::query("INSERT OR IGNORE INTO message_mentions (message_id, kind, target_id) VALUES (?, ?, ?)")
            .bind(message_id)
            .bind(kind)
            .bind(target)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0190a0b0-0000-7000-8000-000000000001";
    const B: &str = "0190a0b0-0000-7000-8000-000000000002";
    const R: &str = "0190a0b0-0000-7000-8000-0000000000aa";

    #[test]
    fn parses_users_roles_and_everyone() {
        let p = parse(&format!("oi <@{A}> e <@&{R}>, <@{A}> de novo @everyone"));
        assert_eq!(p.users, vec![A.to_string()]);
        assert_eq!(p.roles, vec![R.to_string()]);
        assert!(p.everyone);
        assert!(!p.here);
    }

    #[test]
    fn ignores_code_and_partial_words() {
        let p = parse(&format!(
            "`<@{A}>` ```\n<@{B}>\n``` email@here a@everyone @everyones @here!"
        ));
        assert!(p.users.is_empty());
        assert!(!p.everyone);
        assert!(p.here);
    }

    #[test]
    fn unclosed_backtick_is_text() {
        let p = parse(&format!("a ` <@{A}>"));
        assert_eq!(p.users, vec![A.to_string()]);
    }

    #[test]
    fn rejects_bad_ids() {
        assert!(parse("<@123> <@&abc> <@").is_empty());
    }

    #[test]
    fn resolve_filters_and_checks_permission() {
        let viewers = vec![A.to_string(), B.to_string()];
        let p = parse(&format!("<@{A}> <@0190a0b0-0000-7000-8000-00000000ffff> <@&{R}> @here"));
        let r = resolve(p, A, &viewers, &[R.to_string()], true, |_| true);
        assert_eq!(r.users, vec![A.to_string()]);
        assert_eq!(r.roles, vec![R.to_string()]);
        assert_eq!(r.everyone, 2);
        assert_eq!(r.here_users, vec![B.to_string()]);

        let r = resolve(parse("@everyone"), A, &viewers, &[], false, |_| true);
        assert_eq!(r.everyone, 0);
    }
}
