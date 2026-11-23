CREATE TABLE client_memory_members (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX client_memory_members_by_user
  ON client_memory_members(user_id, registered_at);

CREATE TABLE client_memory_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  storage_bytes INTEGER NOT NULL CHECK (storage_bytes >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX client_memory_messages_by_user
  ON client_memory_messages(user_id, created_at DESC, id DESC);

CREATE TABLE server_archive_settings (
  guild_id TEXT PRIMARY KEY,
  notice_status TEXT NOT NULL CHECK (notice_status IN ('pending', 'posting', 'posted', 'failed')),
  notice_channel_id TEXT,
  notice_posted_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE server_message_archive (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  storage_bytes INTEGER NOT NULL CHECK (storage_bytes >= 0)
);

CREATE INDEX server_message_archive_channel_history
  ON server_message_archive(guild_id, channel_id, created_at DESC, message_id DESC);

CREATE INDEX server_message_archive_oldest
  ON server_message_archive(guild_id, created_at ASC, message_id ASC);

CREATE TABLE server_archive_usage (
  guild_id TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0)
);

CREATE TRIGGER server_message_archive_after_insert
AFTER INSERT ON server_message_archive
BEGIN
  INSERT INTO server_archive_usage(guild_id, used_bytes)
  VALUES (NEW.guild_id, NEW.storage_bytes)
  ON CONFLICT(guild_id) DO UPDATE SET used_bytes = used_bytes + NEW.storage_bytes;
END;

CREATE TRIGGER server_message_archive_after_delete
AFTER DELETE ON server_message_archive
BEGIN
  UPDATE server_archive_usage
  SET used_bytes = MAX(0, used_bytes - OLD.storage_bytes)
  WHERE guild_id = OLD.guild_id;
END;

CREATE TRIGGER server_message_archive_after_update
AFTER UPDATE OF storage_bytes, guild_id ON server_message_archive
BEGIN
  UPDATE server_archive_usage
  SET used_bytes = MAX(0, used_bytes - OLD.storage_bytes)
  WHERE guild_id = OLD.guild_id;
  INSERT INTO server_archive_usage(guild_id, used_bytes)
  VALUES (NEW.guild_id, NEW.storage_bytes)
  ON CONFLICT(guild_id) DO UPDATE SET used_bytes = used_bytes + NEW.storage_bytes;
END;
