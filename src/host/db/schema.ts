/**
 * DDL（`tech-design.md` §2.2 / §2.3）。
 *
 * 硬约束（会在自测 HC-1 里 grep 验证）：
 * - **没有类型列**（kind/category/tag/type/label）—— D-3 取消四类型。
 * - **没有衰减列**（decay/strength/confidence）—— 衰减不是状态，是排序系数（DC-28）。
 * - `layer` 的 CHECK 只有 semantic/episodic —— 程序记忆不进 MVP。
 * - `scope` 的 CHECK 只有 project/user —— session 不持久化。
 *
 * 关于 FTS5：本文件**不用外部内容表 + 触发器**（`@clinexin/dsh-kb` 那样）。
 * 原因见 tech-design.md §3.2：触发器依赖连接级 `foreign_keys=ON`，漏开就留孤儿索引行，
 * 表现正是"删了还能搜到" —— 那恰好是 AC-5 最不能出的缺陷。这里改为应用侧显式同步，
 * 顺序写死在一个事务里，不依赖任何连接设置。
 */

export const SCHEMA_VERSION = 1

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  layer         TEXT NOT NULL CHECK (layer IN ('semantic','episodic')),
  content       TEXT,
  scope         TEXT NOT NULL CHECK (scope IN ('project','user')),
  project_key   TEXT,
  source_type   TEXT NOT NULL CHECK (source_type IN ('explicit','correction','inferred')),
  source_ref    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  confirmed_at  INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('active','superseded','expired','deleted_soft','deleted_hard')),
  superseded_by TEXT REFERENCES memories(id),
  expires_at    INTEGER,
  reuse_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_at   INTEGER,
  sensitivity   TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','restricted')),
  deleted_at    INTEGER,
  -- 预计算的切词结果（空格分隔）。检索精排直接读它，避免每次查询都对正文重新分词。
  -- 这是**派生列**：写入/编辑时必须同步，见 dao.insert / dao.updateContent。
  tokens        TEXT NOT NULL DEFAULT '',
  CHECK ((scope = 'project' AND project_key IS NOT NULL)
      OR (scope = 'user'    AND project_key IS NULL)),
  CHECK (expires_at IS NULL OR layer = 'episodic')
);

CREATE INDEX IF NOT EXISTS ix_mem_active
  ON memories(project_key, layer, confirmed_at DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_mem_scope_status ON memories(scope, status);
CREATE INDEX IF NOT EXISTS ix_mem_recycle ON memories(deleted_at) WHERE status = 'deleted_soft';
CREATE INDEX IF NOT EXISTS ix_mem_dedupe
  ON memories(scope, project_key, layer) WHERE status = 'active';

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS memory_changes (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memories(id),
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN
                ('correction','edit','scope_change','conflict','expire','restore','delete',
                 'hard_delete','user_asked_not_to_keep')),
  actor       TEXT NOT NULL CHECK (actor IN ('user','system')),
  at          INTEGER NOT NULL,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS ix_changes_mem ON memory_changes(memory_id, at);

CREATE TABLE IF NOT EXISTS memory_audit (
  id        TEXT PRIMARY KEY,
  at        INTEGER NOT NULL,
  op        TEXT NOT NULL,
  outcome   TEXT NOT NULL,
  memory_id TEXT,
  meta      TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON memory_audit(at DESC);

CREATE TABLE IF NOT EXISTS memory_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/**
 * 默认设置。
 *
 * `retention_days = 30`：**D-8 X-4** 要求文案与实际行为一致，本方案选择实现 30 天清理，
 * 因此「回收站条目保留 30 天后彻底删除」这条文案成立。改成 null 就必须同步删掉文案
 * （自测 HC-10 会检查这一点）。
 *
 * `write_prompt_budget = 3`：D-5 Q1，每会话前 3 次写入给一行轻量提示。
 * `prompt_writes = 1`：用户可以说「以后别提示写入」关掉（D-6 Q5：存配置，不存记忆）。
 * `recall_inject = 0`：自动召回注入**默认关闭**。它会把内容写进每轮上下文，
 * 属于 R-3.5.1「不常驻上下文」的例外，所以必须由用户在面板里显式打开，
 * 不能因为是新能力就默认改变模型看到的东西。
 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  enabled: '1',
  retention_days: '30',
  write_prompt_budget: '3',
  prompt_writes: '1',
  episodic_retention_days: '30',
  decay_window_days: '90',
  recall_inject: '0',
}
