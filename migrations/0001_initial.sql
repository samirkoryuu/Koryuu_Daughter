PRAGMA foreign_keys = ON;

CREATE TABLE general_kn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE relationship_kn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE status_astri (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT,
  true_name TEXT,
  title_name TEXT,
  title TEXT,
  partner TEXT,
  relationship_since TEXT,
  account_created TEXT,
  relationship_level INTEGER NOT NULL DEFAULT 1 CHECK (relationship_level >= 1),
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('active', 'away', 'offline')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO status_astri (id) VALUES (1);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE TABLE media_objects (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shop_storage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unique_id TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('memories', 'pins', 'traits', 'tokens', 'letters', 'portraits', 'titles')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price_rp INTEGER NOT NULL CHECK (price_rp >= 0),
  opt_story TEXT,
  opt_link TEXT,
  opt_name TEXT,
  token_type TEXT CHECK (token_type IS NULL OR token_type IN ('date', 'food', 'visual', 'creative')),
  token_amount INTEGER NOT NULL DEFAULT 1 CHECK (token_amount > 0),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 10080),
  media_id TEXT REFERENCES media_objects(id),
  r2_key TEXT,
  status TEXT NOT NULL DEFAULT 'on_sell' CHECK (status IN ('on_sell', 'sold')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((category = 'tokens' AND token_type IS NOT NULL) OR (category != 'tokens' AND token_type IS NULL)),
  CHECK ((category IN ('pins', 'portraits') AND media_id IS NOT NULL) OR category NOT IN ('pins', 'portraits')),
  CHECK (
    (category = 'traits' AND duration_minutes IS NOT NULL) OR
    (category = 'titles') OR
    (category NOT IN ('traits', 'titles') AND duration_minutes IS NULL)
  )
);

CREATE INDEX shop_storage_status_category ON shop_storage(status, active, category, id);

CREATE TABLE rp_wallets (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
);

CREATE TABLE rp_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount != 0 OR kind = 'purchase'),
  kind TEXT NOT NULL CHECK (kind IN ('award', 'deduction', 'purchase')),
  note TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  legacy_import INTEGER NOT NULL DEFAULT 0 CHECK (legacy_import IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX rp_transactions_user ON rp_transactions(user_id, created_at);

CREATE TRIGGER rp_transactions_validate
BEFORE INSERT ON rp_transactions
WHEN NEW.kind IN ('award', 'deduction') AND NEW.legacy_import = 0
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'award' AND NEW.amount <= 0
      THEN RAISE(ABORT, 'RP awards must be positive.')
    WHEN NEW.kind = 'deduction' AND NEW.amount >= 0
      THEN RAISE(ABORT, 'RP deductions must be negative.')
    WHEN NEW.kind = 'deduction' AND NOT EXISTS (
      SELECT 1 FROM rp_wallets
      WHERE user_id = NEW.user_id AND balance >= -NEW.amount
    ) THEN RAISE(ABORT, 'That would make the RP balance negative.')
  END;
END;

CREATE TRIGGER rp_transactions_apply
AFTER INSERT ON rp_transactions
WHEN NEW.kind IN ('award', 'deduction') AND NEW.legacy_import = 0
BEGIN
  INSERT INTO rp_wallets(user_id, balance) VALUES (NEW.user_id, NEW.amount)
  ON CONFLICT(user_id) DO UPDATE SET balance = balance + NEW.amount;
END;

CREATE TABLE astri_collection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_item_id INTEGER NOT NULL REFERENCES shop_storage(id),
  unique_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price_paid INTEGER NOT NULL CHECK (price_paid >= 0),
  token_type TEXT,
  token_amount INTEGER NOT NULL DEFAULT 1,
  duration_minutes INTEGER,
  opt_story TEXT,
  opt_name TEXT,
  media_id TEXT REFERENCES media_objects(id),
  r2_key TEXT,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX astri_collection_category ON astri_collection(category, acquired_at);

CREATE TABLE memory_collectibles (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  written_record TEXT NOT NULL
);
CREATE TABLE pins (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_objects(id)
);
CREATE TABLE traits (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  personality_mode TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 10080)
);
CREATE TABLE tokens (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  token_type TEXT NOT NULL CHECK (token_type IN ('date', 'food', 'visual', 'creative')),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE TABLE letters (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  letter_text TEXT NOT NULL
);
CREATE TABLE portraits (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_objects(id)
);
CREATE TABLE titles (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  title_name TEXT NOT NULL,
  expires_at TEXT
);
CREATE TABLE active_traits (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  collection_id INTEGER NOT NULL REFERENCES traits(collection_id),
  activated_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE date_tokens (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE TABLE food_tokens (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE TABLE visual_tokens (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE TABLE creative_tokens (
  collection_id INTEGER PRIMARY KEY REFERENCES astri_collection(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_item_id INTEGER NOT NULL REFERENCES shop_storage(id),
  unique_id TEXT NOT NULL,
  item_title TEXT NOT NULL,
  price_paid INTEGER NOT NULL CHECK (price_paid >= 0),
  buyer_id TEXT NOT NULL,
  legacy_import INTEGER NOT NULL DEFAULT 0 CHECK (legacy_import IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER purchases_validate
BEFORE INSERT ON purchases
WHEN NEW.legacy_import = 0
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM shop_storage
      WHERE id = NEW.shop_item_id
        AND unique_id = NEW.unique_id
        AND title = NEW.item_title
        AND price_rp = NEW.price_paid
        AND status = 'on_sell' AND active = 1
    ) THEN RAISE(ABORT, 'This shop item is no longer available.')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM rp_wallets
      WHERE user_id = NEW.buyer_id AND balance >= NEW.price_paid
    ) THEN RAISE(ABORT, 'Not enough RP to purchase this item.')
  END;
END;

CREATE TRIGGER purchases_apply
AFTER INSERT ON purchases
WHEN NEW.legacy_import = 0
BEGIN
  UPDATE rp_wallets
  SET balance = balance - NEW.price_paid
  WHERE user_id = NEW.buyer_id;

  INSERT INTO rp_transactions(user_id, amount, kind, note, actor_id)
  VALUES (NEW.buyer_id, -NEW.price_paid, 'purchase', 'Purchased ' || NEW.item_title, NEW.buyer_id);

  UPDATE shop_storage SET status = 'sold' WHERE id = NEW.shop_item_id;

  INSERT INTO astri_collection(
    shop_item_id, unique_id, category, title, description, price_paid,
    token_type, token_amount, duration_minutes, opt_story, opt_name, media_id, r2_key
  )
  SELECT id, unique_id, category, title, description, price_rp,
    token_type, token_amount, duration_minutes, opt_story, opt_name, media_id, r2_key
  FROM shop_storage WHERE id = NEW.shop_item_id;

  INSERT INTO system_logs(actor_id, action, details)
  VALUES (
    NEW.buyer_id,
    'shop.purchase',
    json_object('item', NEW.item_title, 'price', NEW.price_paid, 'unique_id', NEW.unique_id)
  );
END;

CREATE TRIGGER collection_add_memory
AFTER INSERT ON astri_collection
WHEN NEW.category = 'memories'
BEGIN
  INSERT INTO memory_collectibles(collection_id, written_record)
  VALUES (NEW.id, COALESCE(NEW.opt_story, NEW.description));
END;
CREATE TRIGGER collection_add_pin
AFTER INSERT ON astri_collection
WHEN NEW.category = 'pins'
BEGIN
  INSERT INTO pins(collection_id, media_id) VALUES (NEW.id, NEW.media_id);
END;
CREATE TRIGGER collection_add_trait
AFTER INSERT ON astri_collection
WHEN NEW.category = 'traits'
BEGIN
  INSERT INTO traits(collection_id, personality_mode, duration_minutes)
  VALUES (NEW.id, COALESCE(NEW.opt_story, NEW.description), NEW.duration_minutes);
END;
CREATE TRIGGER collection_add_token
AFTER INSERT ON astri_collection
WHEN NEW.category = 'tokens'
BEGIN
  INSERT INTO tokens(collection_id, token_type, quantity)
  VALUES (NEW.id, NEW.token_type, NEW.token_amount);
END;
CREATE TRIGGER collection_add_letter
AFTER INSERT ON astri_collection
WHEN NEW.category = 'letters'
BEGIN
  INSERT INTO letters(collection_id, letter_text)
  VALUES (NEW.id, COALESCE(NEW.opt_story, NEW.description));
END;
CREATE TRIGGER collection_add_portrait
AFTER INSERT ON astri_collection
WHEN NEW.category = 'portraits'
BEGIN
  INSERT INTO portraits(collection_id, media_id) VALUES (NEW.id, NEW.media_id);
END;
CREATE TRIGGER collection_add_title
AFTER INSERT ON astri_collection
WHEN NEW.category = 'titles'
BEGIN
  INSERT INTO titles(collection_id, title_name, expires_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.opt_name, NEW.title),
    CASE WHEN NEW.duration_minutes IS NULL THEN NULL
      ELSE datetime('now', '+' || NEW.duration_minutes || ' minutes') END
  );
END;

CREATE TRIGGER collection_add_date_token
AFTER INSERT ON astri_collection
WHEN NEW.category = 'tokens' AND NEW.token_type = 'date'
BEGIN
  INSERT INTO date_tokens(collection_id, quantity) VALUES (NEW.id, NEW.token_amount);
END;
CREATE TRIGGER collection_add_food_token
AFTER INSERT ON astri_collection
WHEN NEW.category = 'tokens' AND NEW.token_type = 'food'
BEGIN
  INSERT INTO food_tokens(collection_id, quantity) VALUES (NEW.id, NEW.token_amount);
END;
CREATE TRIGGER collection_add_visual_token
AFTER INSERT ON astri_collection
WHEN NEW.category = 'tokens' AND NEW.token_type = 'visual'
BEGIN
  INSERT INTO visual_tokens(collection_id, quantity) VALUES (NEW.id, NEW.token_amount);
END;
CREATE TRIGGER collection_add_creative_token
AFTER INSERT ON astri_collection
WHEN NEW.category = 'tokens' AND NEW.token_type = 'creative'
BEGIN
  INSERT INTO creative_tokens(collection_id, quantity) VALUES (NEW.id, NEW.token_amount);
END;

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX conversations_by_user_expiry ON conversations(user_id, expires_at, created_at);

CREATE TABLE chat_rate_limits (
  user_id TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL CHECK (message_count > 0)
);

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX pending_actions_by_actor ON pending_actions(actor_id, status, expires_at);

CREATE TABLE admin_sessions (
  user_id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE admin_auth_attempts (
  user_id TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE gateway_request_nonces (
  nonce TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE discord_interaction_nonces (
  interaction_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unique_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE mission_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL REFERENCES missions(id),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  completed_at TEXT,
  UNIQUE(mission_id, user_id)
);

CREATE TABLE relationship_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  achieved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unique_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE achievement_awards (
  achievement_id INTEGER NOT NULL REFERENCES achievements(id),
  user_id TEXT NOT NULL,
  awarded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (achievement_id, user_id)
);
