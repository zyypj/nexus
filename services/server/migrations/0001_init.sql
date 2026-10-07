-- Nexus initial schema. Timestamps are unix milliseconds (INTEGER).
-- IDs are UUIDv7 strings: lexicographic order == creation order, which the
-- message pagination and unread counters rely on.

CREATE TABLE users (
    id            TEXT PRIMARY KEY NOT NULL,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar        TEXT,
    bio           TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'online'
                  CHECK (status IN ('online', 'idle', 'dnd', 'invisible')),
    is_admin      INTEGER NOT NULL DEFAULT 0,
    disabled      INTEGER NOT NULL DEFAULT 0,
    invite_code   TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
    id           TEXT PRIMARY KEY NOT NULL,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_hash TEXT NOT NULL,
    device_name  TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    revoked_at   INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE invites (
    code       TEXT PRIMARY KEY NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    max_uses   INTEGER,
    uses       INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    revoked    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE friend_requests (
    id         TEXT PRIMARY KEY NOT NULL,
    from_user  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (from_user, to_user)
);
CREATE INDEX friend_requests_to ON friend_requests(to_user);

-- One row per pair, user_a < user_b.
CREATE TABLE friendships (
    user_a     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
);
CREATE INDEX friendships_b ON friendships(user_b);

CREATE TABLE blocked_users (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocked_users_blocked ON blocked_users(blocked_id);

CREATE TABLE conversations (
    id              TEXT PRIMARY KEY NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
    name            TEXT,
    owner_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
    -- "<smaller user id>:<bigger user id>" for DMs, guarantees one DM per pair.
    dm_key          TEXT UNIQUE,
    last_message_id TEXT,
    created_at      INTEGER NOT NULL
);

CREATE TABLE conversation_members (
    conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at            INTEGER NOT NULL,
    last_read_message_id TEXT,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON conversation_members(user_id);

CREATE TABLE messages (
    id              TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    reply_to_id     TEXT REFERENCES messages(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL,
    edited_at       INTEGER
);
CREATE INDEX messages_conversation ON messages(conversation_id, id);

CREATE TABLE message_reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);

-- message_id is NULL while an upload is pending (uploaded, not yet sent).
CREATE TABLE message_attachments (
    id              TEXT PRIMARY KEY NOT NULL,
    message_id      TEXT REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    uploader_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_name       TEXT NOT NULL,
    storage_name    TEXT NOT NULL UNIQUE,
    content_type    TEXT NOT NULL,
    size            INTEGER NOT NULL,
    width           INTEGER,
    height          INTEGER,
    created_at      INTEGER NOT NULL
);
CREATE INDEX message_attachments_message ON message_attachments(message_id);

CREATE TABLE calls (
    id              TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    room_name       TEXT NOT NULL UNIQUE,
    started_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL,
    ended_at        INTEGER
);
-- At most one active call per conversation; different conversations get
-- independent rooms and can run at the same time.
CREATE UNIQUE INDEX calls_active_conversation ON calls(conversation_id) WHERE ended_at IS NULL;

CREATE TABLE call_participants (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id   TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    left_at   INTEGER,
    muted     INTEGER NOT NULL DEFAULT 0,
    deafened  INTEGER NOT NULL DEFAULT 0,
    video     INTEGER NOT NULL DEFAULT 0,
    screen    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX call_participants_active ON call_participants(call_id, user_id) WHERE left_at IS NULL;
-- A user is in at most one call at a time.
CREATE UNIQUE INDEX call_participants_one_call ON call_participants(user_id) WHERE left_at IS NULL;
