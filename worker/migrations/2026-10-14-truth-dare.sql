-- 真心话大冒险：对局、参与者、开局申请与逐轮记录。历史永久保留，不接入 GC。

CREATE TABLE truth_dare_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL CHECK (scope IN ('public', 'channel', 'manual')),
  channel_id INTEGER REFERENCES channels(id),
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'playing' CHECK (status IN ('playing', 'ended')),
  phase TEXT NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle', 'choosing', 'collecting', 'voting', 'answering', 'confirming', 'resolved')),
  phase_deadline_ms INTEGER,
  round_no INTEGER NOT NULL DEFAULT 0,
  chosen_user_id INTEGER,
  choice TEXT CHECK (choice IN ('truth', 'dare')),
  winning_prompt_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT
);
CREATE INDEX idx_truth_dare_games_status ON truth_dare_games(status, id);

CREATE TABLE truth_dare_participants (
  game_id INTEGER NOT NULL REFERENCES truth_dare_games(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  is_creator INTEGER NOT NULL DEFAULT 0 CHECK (is_creator IN (0, 1)),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, user_id)
);

CREATE TABLE truth_dare_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL CHECK (scope IN ('public', 'channel', 'manual')),
  channel_id INTEGER REFERENCES channels(id),
  invited_user_ids TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewer_id INTEGER,
  review_reason TEXT NOT NULL DEFAULT '',
  game_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);
CREATE INDEX idx_truth_dare_applications_status ON truth_dare_applications(status, id);

CREATE TABLE truth_dare_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES truth_dare_games(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL,
  chosen_user_id INTEGER NOT NULL REFERENCES users(id),
  choice TEXT CHECK (choice IN ('truth', 'dare')),
  choice_auto INTEGER NOT NULL DEFAULT 0 CHECK (choice_auto IN (0, 1)),
  winning_prompt_id INTEGER,
  answer_text TEXT NOT NULL DEFAULT '',
  answer_voice_key TEXT,
  answer_voice_duration_ms INTEGER,
  confirmed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  UNIQUE (game_id, round_no)
);

CREATE TABLE truth_dare_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES truth_dare_games(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('truth', 'dare')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (game_id, round_no, author_id)
);

CREATE TABLE truth_dare_votes (
  game_id INTEGER NOT NULL REFERENCES truth_dare_games(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL,
  voter_id INTEGER NOT NULL REFERENCES users(id),
  prompt_id INTEGER NOT NULL REFERENCES truth_dare_prompts(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, round_no, voter_id)
);
CREATE INDEX idx_truth_dare_votes_prompt ON truth_dare_votes(game_id, round_no, prompt_id);

INSERT OR IGNORE INTO site_settings (setting_key, setting_value)
VALUES ('truth_dare_allow_member_create', '0');
