-- no-transaction
-- Servers (guilds): members, roles, bans, invites, categories, channels and
-- per-channel permission overwrites.
--
-- Text and voice channels are rows of `conversations` (kinds 'text'/'voice')
-- linked to a server, so messages, attachments, reactions, typing, unread
-- counts and calls work for them unchanged. Changing the kind CHECK needs the
-- SQLite table-rebuild procedure, which requires foreign keys off — hence no
-- implicit transaction here and an explicit one below.

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE servers (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL,
    icon       TEXT,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL
);

CREATE TABLE server_members (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname  TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
);
CREATE INDEX server_members_user ON server_members(user_id);

-- The @everyone role has id = server id and position 0. Higher position =
-- higher in the hierarchy. color: 0xRRGGBB, 0 = no color.
CREATE TABLE server_roles (
    id          TEXT PRIMARY KEY NOT NULL,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL,
    permissions INTEGER NOT NULL,
    hoist       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
CREATE INDEX server_roles_server ON server_roles(server_id, position);

CREATE TABLE member_roles (
    server_id TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    role_id   TEXT NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (server_id, user_id, role_id),
    FOREIGN KEY (server_id, user_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
);

CREATE TABLE server_bans (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason     TEXT,
    banned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
);

CREATE TABLE server_invites (
    code       TEXT PRIMARY KEY NOT NULL,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    max_uses   INTEGER,
    uses       INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX server_invites_server ON server_invites(server_id);

CREATE TABLE channel_categories (
    id        TEXT PRIMARY KEY NOT NULL,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL
);
CREATE INDEX channel_categories_server ON channel_categories(server_id);

-- target_id: a category or a channel (conversation) id. Applied in order:
-- category, then channel; within each, @everyone first, then the member's roles.
CREATE TABLE permission_overwrites (
    target_id TEXT NOT NULL,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    role_id   TEXT NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
    allow     INTEGER NOT NULL DEFAULT 0,
    deny      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (target_id, role_id)
);

-- Read state for server channels (DMs/groups keep using conversation_members).
CREATE TABLE channel_reads (
    channel_id           TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id TEXT,
    PRIMARY KEY (channel_id, user_id)
);

-- Rebuild conversations: new kinds and channel columns.
CREATE TABLE conversations_new (
    id              TEXT PRIMARY KEY NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'text', 'voice')),
    name            TEXT,
    owner_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
    dm_key          TEXT UNIQUE,
    last_message_id TEXT,
    created_at      INTEGER NOT NULL,
    server_id       TEXT REFERENCES servers(id) ON DELETE CASCADE,
    category_id     TEXT REFERENCES channel_categories(id) ON DELETE SET NULL,
    position        INTEGER NOT NULL DEFAULT 0,
    topic           TEXT
);
INSERT INTO conversations_new (id, kind, name, owner_id, dm_key, last_message_id, created_at)
    SELECT id, kind, name, owner_id, dm_key, last_message_id, created_at FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX conversations_server ON conversations(server_id);

COMMIT;

PRAGMA foreign_keys = ON;
