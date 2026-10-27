-- Mentions (Discord style): `<@user id>`, `<@&role id>`, `@everyone`, `@here`
-- in the message text. Parsed on send/edit so unread mention counts are one
-- query per channel.

-- 0 = none, 1 = @everyone, 2 = @here (only the members online at send time
-- get a 'here' row below).
ALTER TABLE messages ADD COLUMN mention_everyone INTEGER NOT NULL DEFAULT 0;

-- kind: 'user' (target = user id), 'role' (target = role id) or 'here'
-- (target = a user who was online when @here was sent).
CREATE TABLE message_mentions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('user', 'role', 'here')),
    target_id  TEXT NOT NULL,
    PRIMARY KEY (message_id, kind, target_id)
);
CREATE INDEX message_mentions_target ON message_mentions(target_id, message_id);
