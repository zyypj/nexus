//! Server (guild) permissions.
//!
//! Effective permissions, in order:
//! 1. the server owner has everything;
//! 2. base = @everyone role | every role of the member; ADMINISTRATOR = everything;
//! 3. channel overwrites, category first then the channel itself; within each
//!    layer @everyone's overwrite first, then the union of the member's roles'
//!    overwrites (deny removed, then allow added);
//! 4. without VIEW_CHANNEL a channel grants nothing.
//!
//! Hierarchy: acting on another member (kick, ban, roles, nickname) needs a
//! strictly higher top role; the owner is above everyone.

use std::collections::{HashMap, HashSet};

use crate::{
    db::Db,
    error::{ApiError, ApiResult},
};

pub const VIEW_CHANNEL: i64 = 1 << 0;
pub const SEND_MESSAGES: i64 = 1 << 1;
pub const ATTACH_FILES: i64 = 1 << 2;
pub const ADD_REACTIONS: i64 = 1 << 3;
pub const MANAGE_MESSAGES: i64 = 1 << 4;
pub const CONNECT: i64 = 1 << 5;
pub const SPEAK: i64 = 1 << 6;
/// Camera and screen share in voice channels.
pub const VIDEO: i64 = 1 << 7;
pub const CREATE_INVITE: i64 = 1 << 8;
pub const KICK_MEMBERS: i64 = 1 << 9;
pub const BAN_MEMBERS: i64 = 1 << 10;
pub const MANAGE_CHANNELS: i64 = 1 << 11;
pub const MANAGE_ROLES: i64 = 1 << 12;
pub const MANAGE_SERVER: i64 = 1 << 13;
pub const ADMINISTRATOR: i64 = 1 << 14;
pub const CHANGE_NICKNAME: i64 = 1 << 15;
pub const MANAGE_NICKNAMES: i64 = 1 << 16;

pub const ALL: i64 = (1 << 17) - 1;

/// What everyone can do in a new server.
pub const DEFAULT_EVERYONE: i64 = VIEW_CHANNEL
    | SEND_MESSAGES
    | ATTACH_FILES
    | ADD_REACTIONS
    | CONNECT
    | SPEAK
    | VIDEO
    | CREATE_INVITE
    | CHANGE_NICKNAME;

/// Permissions that only make sense per channel (allowed in overwrites).
pub const CHANNEL_SCOPED: i64 =
    VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | ADD_REACTIONS | MANAGE_MESSAGES | CONNECT | SPEAK | VIDEO;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RoleRow {
    pub id: String,
    pub name: String,
    pub color: i64,
    pub position: i64,
    pub permissions: i64,
    pub hoist: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OverwriteRow {
    pub target_id: String,
    pub role_id: String,
    pub allow: i64,
    pub deny: i64,
}

/// A member as seen by the permission engine.
#[derive(Debug, Clone)]
pub struct MemberCtx {
    pub owner: bool,
    /// Role ids including @everyone (= server id).
    pub roles: HashSet<String>,
    pub base: i64,
    /// Highest role position (@everyone = 0); owner = i64::MAX.
    pub top: i64,
}

impl MemberCtx {
    pub fn build(server_id: &str, owner_id: &str, user_id: &str, member_roles: &[String], roles: &[RoleRow]) -> Self {
        let mut set: HashSet<String> = member_roles.iter().cloned().collect();
        set.insert(server_id.to_string());
        let mut base = 0;
        let mut top = 0;
        for r in roles.iter().filter(|r| set.contains(&r.id)) {
            base |= r.permissions;
            top = top.max(r.position);
        }
        let owner = owner_id == user_id;
        Self {
            owner,
            roles: set,
            base,
            top: if owner { i64::MAX } else { top },
        }
    }

    /// Server-level permissions.
    pub fn server(&self) -> i64 {
        if self.owner || self.base & ADMINISTRATOR != 0 {
            ALL
        } else {
            self.base
        }
    }

    pub fn has(&self, perm: i64) -> bool {
        self.server() & perm == perm
    }

    /// Permissions in a channel given the overwrites of its category and of
    /// the channel itself.
    pub fn channel(&self, everyone_id: &str, category: &[&OverwriteRow], channel: &[&OverwriteRow]) -> i64 {
        let base = self.server();
        if base == ALL {
            return ALL;
        }
        let mut p = base;
        for layer in [category, channel] {
            if let Some(o) = layer.iter().find(|o| o.role_id == everyone_id) {
                p = (p & !o.deny) | o.allow;
            }
            let (mut allow, mut deny) = (0, 0);
            for o in layer
                .iter()
                .filter(|o| o.role_id != everyone_id && self.roles.contains(&o.role_id))
            {
                allow |= o.allow;
                deny |= o.deny;
            }
            p = (p & !deny) | allow;
        }
        if p & VIEW_CHANNEL == 0 { 0 } else { p }
    }

    /// May act on a member whose top position is `target_top`.
    pub fn outranks(&self, target_top: i64) -> bool {
        self.top > target_top
    }
}

/// Everything about one server needed to compute permissions and views.
pub struct Snapshot {
    pub id: String,
    pub owner_id: String,
    pub roles: Vec<RoleRow>,
    pub overwrites: Vec<OverwriteRow>,
    /// user_id -> role ids (without @everyone).
    pub member_roles: HashMap<String, Vec<String>>,
}

impl Snapshot {
    pub async fn load(db: &Db, server_id: &str) -> ApiResult<Self> {
        let owner: Option<(String,)> = sqlx::query_as("SELECT owner_id FROM servers WHERE id = ?")
            .bind(server_id)
            .fetch_optional(db)
            .await?;
        let (owner_id,) = owner.ok_or(ApiError::NotFound("server"))?;
        let roles: Vec<RoleRow> = sqlx::query_as(
            "SELECT id, name, color, position, permissions, hoist FROM server_roles
             WHERE server_id = ? ORDER BY position DESC",
        )
        .bind(server_id)
        .fetch_all(db)
        .await?;
        let overwrites: Vec<OverwriteRow> =
            sqlx::query_as("SELECT target_id, role_id, allow, deny FROM permission_overwrites WHERE server_id = ?")
                .bind(server_id)
                .fetch_all(db)
                .await?;
        let members: Vec<(String,)> = sqlx::query_as("SELECT user_id FROM server_members WHERE server_id = ?")
            .bind(server_id)
            .fetch_all(db)
            .await?;
        let mut member_roles: HashMap<String, Vec<String>> = members.into_iter().map(|(u,)| (u, Vec::new())).collect();
        let links: Vec<(String, String)> =
            sqlx::query_as("SELECT user_id, role_id FROM member_roles WHERE server_id = ?")
                .bind(server_id)
                .fetch_all(db)
                .await?;
        for (u, r) in links {
            member_roles.entry(u).or_default().push(r);
        }
        Ok(Self {
            id: server_id.to_string(),
            owner_id,
            roles,
            overwrites,
            member_roles,
        })
    }

    pub fn is_member(&self, user_id: &str) -> bool {
        self.member_roles.contains_key(user_id)
    }

    pub fn ctx(&self, user_id: &str) -> Option<MemberCtx> {
        let roles = self.member_roles.get(user_id)?;
        Some(MemberCtx::build(&self.id, &self.owner_id, user_id, roles, &self.roles))
    }

    fn overwrites_for(&self, target: Option<&str>) -> Vec<&OverwriteRow> {
        match target {
            Some(t) => self.overwrites.iter().filter(|o| o.target_id == t).collect(),
            None => Vec::new(),
        }
    }

    pub fn channel_perms(&self, ctx: &MemberCtx, category_id: Option<&str>, channel_id: &str) -> i64 {
        ctx.channel(
            &self.id,
            &self.overwrites_for(category_id),
            &self.overwrites_for(Some(channel_id)),
        )
    }

    /// Top position of a member (for hierarchy checks).
    pub fn top_of(&self, user_id: &str) -> i64 {
        self.ctx(user_id).map(|c| c.top).unwrap_or(0)
    }

    pub fn role(&self, role_id: &str) -> Option<&RoleRow> {
        self.roles.iter().find(|r| r.id == role_id)
    }
}

/// Server and category of a channel (None for DMs/groups).
pub async fn channel_location(db: &Db, channel_id: &str) -> ApiResult<Option<(String, Option<String>)>> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT server_id, category_id FROM conversations WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(db)
            .await?;
    let (server_id, category_id) = row.ok_or(ApiError::NotFound("conversation"))?;
    Ok(server_id.map(|s| (s, category_id)))
}

/// A user's permissions in a server channel (0 when not a member).
pub async fn channel_permissions(
    db: &Db,
    server_id: &str,
    category_id: Option<&str>,
    channel_id: &str,
    user_id: &str,
) -> ApiResult<i64> {
    let snap = Snapshot::load(db, server_id).await?;
    Ok(match snap.ctx(user_id) {
        Some(ctx) => snap.channel_perms(&ctx, category_id, channel_id),
        None => 0,
    })
}

/// Requires `perm` in the conversation when it is a server channel; DMs and
/// groups pass (their rules are membership + blocks).
pub async fn require_channel_perm(
    db: &Db,
    conversation_id: &str,
    user_id: &str,
    perm: i64,
    msg: &'static str,
) -> ApiResult<i64> {
    match channel_location(db, conversation_id).await? {
        Some((server_id, category)) => {
            let p = channel_permissions(db, &server_id, category.as_deref(), conversation_id, user_id).await?;
            if p & perm != perm {
                return Err(ApiError::Forbidden(msg));
            }
            Ok(p)
        }
        None => Ok(ALL),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn role(id: &str, position: i64, permissions: i64) -> RoleRow {
        RoleRow {
            id: id.into(),
            name: id.into(),
            color: 0,
            position,
            permissions,
            hoist: false,
        }
    }

    fn ow(target: &str, role: &str, allow: i64, deny: i64) -> OverwriteRow {
        OverwriteRow {
            target_id: target.into(),
            role_id: role.into(),
            allow,
            deny,
        }
    }

    #[test]
    fn owner_and_admin_have_everything() {
        let roles = vec![role("s", 0, 0), role("admin", 2, ADMINISTRATOR)];
        let owner = MemberCtx::build("s", "u1", "u1", &[], &roles);
        assert_eq!(owner.server(), ALL);
        let admin = MemberCtx::build("s", "u1", "u2", &["admin".into()], &roles);
        assert_eq!(admin.server(), ALL);
        let deny_all = ow("c", "s", 0, ALL);
        assert_eq!(admin.channel("s", &[], &[&deny_all]), ALL);
    }

    #[test]
    fn roles_union_and_hierarchy() {
        let roles = vec![
            role("s", 0, VIEW_CHANNEL),
            role("mod", 5, KICK_MEMBERS),
            role("vip", 2, ATTACH_FILES),
        ];
        let m = MemberCtx::build("s", "owner", "u", &["mod".into(), "vip".into()], &roles);
        assert_eq!(m.server(), VIEW_CHANNEL | KICK_MEMBERS | ATTACH_FILES);
        assert_eq!(m.top, 5);
        assert!(m.outranks(2));
        assert!(!m.outranks(5));
        let owner = MemberCtx::build("s", "owner", "owner", &[], &roles);
        assert!(owner.outranks(1_000));
    }

    #[test]
    fn overwrites_layer_category_then_channel() {
        let roles = vec![role("s", 0, DEFAULT_EVERYONE), role("staff", 3, 0)];
        let staff = MemberCtx::build("s", "o", "a", &["staff".into()], &roles);
        let pleb = MemberCtx::build("s", "o", "b", &[], &roles);
        // Private category: hidden for @everyone, visible for staff.
        let cat = [ow("cat", "s", 0, VIEW_CHANNEL), ow("cat", "staff", VIEW_CHANNEL, 0)];
        let cat: Vec<&OverwriteRow> = cat.iter().collect();
        assert_eq!(pleb.channel("s", &cat, &[]), 0);
        assert_ne!(staff.channel("s", &cat, &[]) & VIEW_CHANNEL, 0);
        // The channel re-opens it read-only for @everyone.
        let chan = [ow("ch", "s", VIEW_CHANNEL, SEND_MESSAGES)];
        let chan: Vec<&OverwriteRow> = chan.iter().collect();
        let p = pleb.channel("s", &cat, &chan);
        assert_ne!(p & VIEW_CHANNEL, 0);
        assert_eq!(p & SEND_MESSAGES, 0);
        // Role overwrite beats @everyone in the same layer.
        let chan2 = [ow("ch", "s", 0, SEND_MESSAGES), ow("ch", "staff", SEND_MESSAGES, 0)];
        let chan2: Vec<&OverwriteRow> = chan2.iter().collect();
        assert_ne!(staff.channel("s", &cat, &chan2) & SEND_MESSAGES, 0);
    }

    #[test]
    fn no_view_means_nothing() {
        let roles = vec![role("s", 0, DEFAULT_EVERYONE)];
        let m = MemberCtx::build("s", "o", "u", &[], &roles);
        let hide = [ow("ch", "s", 0, VIEW_CHANNEL)];
        let hide: Vec<&OverwriteRow> = hide.iter().collect();
        assert_eq!(m.channel("s", &[], &hide), 0);
    }
}
