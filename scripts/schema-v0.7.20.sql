PRAGMA journal_mode = WAL;
PRAGMA secure_delete = ON;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('person','org','place','pet','thing','project')),
  name          TEXT NOT NULL,
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  relation      TEXT,
  privacy       TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','sensitive','secret')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS ix_ent_name ON entities(name);

CREATE TABLE IF NOT EXISTS consolidations (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('nap','deep','forget_flush')),
  trigger       TEXT NOT NULL,
  upto_seq      INTEGER NOT NULL,
  turn_from     INTEGER,
  turn_to       INTEGER,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('running','written','compacted','failed','empty')),
  error         TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  compaction_start_seq INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_consolidations_scope_upto ON consolidations(scope, upto_seq, kind);
CREATE INDEX IF NOT EXISTS ix_consolidations_scope ON consolidations(scope, upto_seq);

CREATE TABLE IF NOT EXISTS episodes (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL DEFAULT 'main',
  session_id          TEXT NOT NULL,
  consolidation_id    TEXT REFERENCES consolidations(id),
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT,
  evidence            TEXT,
  topics_json         TEXT NOT NULL DEFAULT '[]',
  entities_json       TEXT NOT NULL DEFAULT '[]',
  mood                TEXT CHECK (mood IN ('positive','neutral','tired','anxious','low','excited')),
  mood_evidence       TEXT,
  -- L120-M4：情景领域（life / work）。旧行为 NULL（不门控），新行由巩固写入。
  domain              TEXT CHECK (domain IN ('life','work')),
  salience            TEXT NOT NULL CHECK (salience IN ('trivial','normal','notable','explicit','pinned')),
  privacy             TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','sensitive','secret')),
  strength_days       REAL,
  last_reinforced_at  INTEGER NOT NULL,
  recall_count        INTEGER NOT NULL DEFAULT 0,
  fidelity            TEXT NOT NULL DEFAULT 'full' CHECK (fidelity IN ('full','gist','index')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','tombstoned')),
  deleted_at          INTEGER,
  purge_payload       TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT ck_ep_pin_decay CHECK ((salience = 'pinned' AND strength_days IS NULL)
                                 OR (salience <> 'pinned' AND strength_days IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_ep_scope_time ON episodes(scope, started_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_ep_decay ON episodes(status, last_reinforced_at) WHERE strength_days IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ep_purge ON episodes(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS facts (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL DEFAULT 'main',
  kind                TEXT NOT NULL CHECK (kind IN ('identity','relation','preference','project','knowledge','lifestyle','mood','other')),
  subject_id          TEXT REFERENCES entities(id),
  subject_text        TEXT NOT NULL,
  predicate           TEXT NOT NULL,
  object_text         TEXT,
  statement           TEXT NOT NULL,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('user_explicit','turn','task','consolidated','inferred')),
  source_episode_id   TEXT REFERENCES episodes(id),
  source_excerpt      TEXT,
  salience            TEXT NOT NULL CHECK (salience IN ('trivial','normal','notable','explicit','pinned')),
  privacy             TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','sensitive','secret')),
  observed_at         INTEGER NOT NULL,
  valid_from          INTEGER,
  valid_to            INTEGER,
  strength_days       REAL,
  last_reinforced_at  INTEGER NOT NULL,
  recall_count        INTEGER NOT NULL DEFAULT 0,
  injected_count      INTEGER NOT NULL DEFAULT 0,
  used_count          INTEGER NOT NULL DEFAULT 0,
  unused_streak       INTEGER NOT NULL DEFAULT 0,
  fidelity            TEXT NOT NULL DEFAULT 'full' CHECK (fidelity IN ('full','gist','index')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','superseded','tombstoned')),
  superseded_by       TEXT REFERENCES facts(id),
  deleted_at          INTEGER,
  purge_payload       TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  first_reneed_at     INTEGER,
  first_reneed_tier   TEXT,
  reneed_kind         TEXT,
  same_context        INTEGER NOT NULL DEFAULT 0 CHECK (same_context IN (0,1)),
  first_used_at       INTEGER,
  first_used_tier     TEXT,
  used_same_context   INTEGER CHECK (used_same_context IN (0,1)),
  CONSTRAINT ck_fact_pin_decay CHECK ((salience = 'pinned' AND strength_days IS NULL)
                                   OR (salience <> 'pinned' AND strength_days IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_facts_key ON facts(subject_text, predicate, status);
CREATE INDEX IF NOT EXISTS ix_facts_scope ON facts(scope, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_facts_decay ON facts(status, last_reinforced_at) WHERE strength_days IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_facts_purge ON facts(deleted_at) WHERE deleted_at IS NOT NULL;

-- P2-b：可选向量召回。hashEmbed 的离线向量投影；只随 facts 生命周期维护，
-- 关闭向量时表为空也不会影响检索。FK 级联保证物理删除后不留孤儿。
CREATE TABLE IF NOT EXISTS fact_vectors (
  fact_id     TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,
  embedder_id TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fact_vectors_dim ON fact_vectors(dim);

CREATE TABLE IF NOT EXISTS reminders (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL DEFAULT 'main',
  kind              TEXT NOT NULL CHECK (kind IN ('todo','schedule','repeat','commitment')),
  title             TEXT NOT NULL,
  detail            TEXT,
  counterparty      TEXT,
  due_at            INTEGER,
  due_granularity   TEXT CHECK (due_granularity IN ('exact','day','week','month','none')),
  rrule             TEXT,
  next_fire_at      INTEGER,
  retry_at          INTEGER,
  last_fire_key     TEXT,
  occurrence_key    TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','delivering','fired','snoozed','done','cancelled','expired')),
  closed_at         INTEGER,
  source_episode_id TEXT REFERENCES episodes(id),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  -- v15（A4/A5）：过期提醒的一次性通知标记 + 重复提醒的系列序号。
  expired_notified_at INTEGER,
  series_index      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at        INTEGER
);
-- V8-L1：到期扫描按 status + max(next_fire_at, retry_at) 过滤与排序，索引必须是
-- 同一表达式才能命中；旧的 ix_rm_fire(status, next_fire_at) 永远服务不了这条查询。
-- 注意：ix_rm_due 不在这里建——它引用 retry_at，而旧库（v3..v11）此时还没有该列，
-- 直接在 SCHEMA_SQL 里建会在补列之前报 no such column。它由
-- #ensureReminderDueIndex 在补列之后统一创建并对旧库就地补建（同时 DROP 旧索引）。
CREATE INDEX IF NOT EXISTS ix_rm_done ON reminders(closed_at) WHERE status IN ('done','cancelled');

CREATE TABLE IF NOT EXISTS state_board (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,
  section           TEXT NOT NULL CHECK (section IN ('in_progress','decided','open_question','upcoming','threads')),
  line              TEXT NOT NULL,
  ref_episode_id    TEXT REFERENCES episodes(id),
  ref_thread_key    TEXT,
  last_mentioned_at INTEGER NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS ix_sb_scope ON state_board(scope, section, last_mentioned_at DESC);

CREATE TABLE IF NOT EXISTS state_board_rev (
  scope            TEXT PRIMARY KEY,
  revision         INTEGER NOT NULL,
  rendered         TEXT NOT NULL,
  staged_revision  INTEGER,
  staged_rendered  TEXT,
  staged_at        INTEGER,
  updated_at       INTEGER NOT NULL
);

-- P3-b（v14）：情绪状态与情绪事件。
-- 时间戳约定：这两张表用「毫秒」epoch（既有表多用秒），卡面要求新表独立口径，
-- 因此 updated_at / last_event_at / at 都是毫秒，不参与既有表的秒级比较。
-- 每 scope 一行状态；事件行由 store 侧保证每 scope 只留最近 50 条。
CREATE TABLE IF NOT EXISTS emotion_state (
  scope         TEXT PRIMARY KEY,
  pleasure      REAL NOT NULL,
  arousal       REAL NOT NULL,
  dominance     REAL NOT NULL,
  energy        REAL NOT NULL,
  updated_at    INTEGER NOT NULL,  -- 毫秒
  last_event_at INTEGER            -- 毫秒，可空
);
CREATE TABLE IF NOT EXISTS emotion_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,
  at          INTEGER NOT NULL,    -- 毫秒
  type        TEXT NOT NULL,
  deltas_json TEXT NOT NULL,       -- {"pleasure":..,"arousal":..,"dominance":..,"energy":..}
  note        TEXT
);
CREATE INDEX IF NOT EXISTS ix_emotion_events ON emotion_events (scope, at);

CREATE TABLE IF NOT EXISTS threads (
  key             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  -- SA-B2（v0.7.7 阶段 4）：子代理会话 id（宿主 SubagentActivation.childId）。
  -- 续派锚用它走 sendMessage；旧库由 #ensureThreadChildSessionColumn 就地补列。
  child_session_id TEXT,
  description     TEXT NOT NULL,
  last_progress   TEXT,
  last_active_at  INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','retired')),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
-- H3：一个线程会话只对应一条线程目录行；按 session_id 反查 scope 依赖唯一性。
CREATE UNIQUE INDEX IF NOT EXISTS ux_threads_session ON threads(session_id);

CREATE TABLE IF NOT EXISTS memory_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL DEFAULT (unixepoch()),
  action      TEXT NOT NULL CHECK (action IN (
                'ADD','UPDATE','SUPERSEDE','MERGE','NOOP','SKIP',
                'REINFORCE','DECAY','DEGRADE','TOMBSTONE','RESTORE','PURGED',
                'READ','USED','EXPORT','govern','EDIT','scrub')),
  table_name  TEXT NOT NULL,
  row_id      TEXT,
  actor       TEXT NOT NULL CHECK (actor IN ('consolidator','user','scheduler','migrator')),
  reason      TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_ev_row ON memory_events(table_name, row_id, at DESC);
CREATE TRIGGER IF NOT EXISTS ev_no_update BEFORE UPDATE ON memory_events
BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS ev_no_delete BEFORE DELETE ON memory_events
BEGIN SELECT RAISE(ABORT,'append-only'); END;

-- v15（A1）：token 入账账本。
-- day_key 由调用方按配置时区算好的本地日键（YYYY-MM-DD），store 不读时区配置；
-- at 是毫秒（与 emotion_* 一致，便于 5 小时滑窗），其余表多用秒。
-- peak 预留给 v0.4.14 错峰计价，当前只写入、不参与聚合。
CREATE TABLE IF NOT EXISTS token_usage (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               INTEGER NOT NULL,
  day_key          TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('main','consolidate','smalltalk','embedding','task','thread','appraise')),
  scope            TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  peak             TEXT CHECK (peak IS NULL OR peak IN ('peak','offpeak')),
  request_id       TEXT
);
CREATE INDEX IF NOT EXISTS ix_token_usage_day ON token_usage(day_key, source);

-- 全文检索：列名 txt 存放 toBigrams() 结果，rowid 与主表 rowid 对齐
CREATE VIRTUAL TABLE IF NOT EXISTS fts_facts USING fts5(txt, tokenize = 'unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(txt, tokenize = 'unicode61');
