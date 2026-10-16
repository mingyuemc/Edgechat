-- 狼人杀：对局、参与者、开局申请、逐轮记录与夜晚行动/投票。历史永久保留，不接入 GC。

CREATE TABLE werewolf_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL CHECK (scope IN ('public', 'channel', 'manual')),
  channel_id INTEGER REFERENCES channels(id),
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'playing' CHECK (status IN ('playing', 'ended')),
  phase TEXT NOT NULL DEFAULT 'lobby' CHECK (phase IN ('lobby', 'night', 'day', 'vote', 'ended')),
  phase_deadline_ms INTEGER,
  round_no INTEGER NOT NULL DEFAULT 0,
  role_config TEXT NOT NULL DEFAULT '{}',
  assign_mode TEXT NOT NULL DEFAULT 'auto' CHECK (assign_mode IN ('auto', 'manual')),
  winner TEXT CHECK (winner IN ('wolves', 'villagers')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT
);
CREATE INDEX idx_werewolf_games_status ON werewolf_games(status, id);

CREATE TABLE werewolf_participants (
  game_id INTEGER NOT NULL REFERENCES werewolf_games(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  is_creator INTEGER NOT NULL DEFAULT 0 CHECK (is_creator IN (0, 1)),
  role TEXT CHECK (role IN ('wolf', 'seer', 'witch', 'villager')),
  alive INTEGER NOT NULL DEFAULT 1 CHECK (alive IN (0, 1)),
  death_round INTEGER,
  death_cause TEXT CHECK (death_cause IN ('wolf', 'poison', 'vote')),
  antidote_used INTEGER NOT NULL DEFAULT 0 CHECK (antidote_used IN (0, 1)),
  poison_used INTEGER NOT NULL DEFAULT 0 CHECK (poison_used IN (0, 1)),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, user_id)
);

CREATE TABLE werewolf_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL CHECK (scope IN ('public', 'channel', 'manual')),
  channel_id INTEGER REFERENCES channels(id),
  invited_user_ids TEXT NOT NULL DEFAULT '[]',
  role_config TEXT NOT NULL DEFAULT '{}',
  assign_mode TEXT NOT NULL DEFAULT 'auto',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewer_id INTEGER,
  review_reason TEXT NOT NULL DEFAULT '',
  game_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);
CREATE INDEX idx_werewolf_applications_status ON werewolf_applications(status, id);

CREATE TABLE werewolf_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES werewolf_games(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL,
  wolf_target_user_id INTEGER,
  saved INTEGER NOT NULL DEFAULT 0 CHECK (saved IN (0, 1)),
  poisoned_user_id INTEGER,
  deaths TEXT NOT NULL DEFAULT '[]',
  exiled_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  UNIQUE (game_id, round_no)
);

CREATE TABLE werewolf_night_actions (
  game_id INTEGER NOT NULL REFERENCES werewolf_games(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('wolf_kill', 'seer_check', 'witch_save', 'witch_poison', 'witch_skip')),
  target_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, round_no, actor_id)
);
CREATE INDEX idx_werewolf_night_actions_round ON werewolf_night_actions(game_id, round_no, action);

CREATE TABLE werewolf_votes (
  game_id INTEGER NOT NULL REFERENCES werewolf_games(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL,
  voter_id INTEGER NOT NULL REFERENCES users(id),
  target_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, round_no, voter_id)
);

INSERT OR IGNORE INTO site_settings (setting_key, setting_value)
VALUES ('werewolf_allow_member_create', '0');
