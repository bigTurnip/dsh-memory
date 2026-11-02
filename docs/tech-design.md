# 《Agent 记忆系统》技术方案 v1

| 项目 | 内容 |
| --- | --- |
| 文档名称 | Agent 记忆系统 · 技术方案（Technical Design） |
| 版本 | v1（待评审；**本版不含实现代码**） |
| 作者 | fullstack-engineer |
| 关联任务 | task-5（共享任务板） |
| 生效输入（优先级从高到低） | `docs/DECISIONS.md`（D-1/D-2/D-3/D-4/D-5/D-7/**D-8 X-1~X-9**） > `docs/agent-memory-prd.md` v0.2 > `docs/design/panel-entry.md` v1.2 > `docs/design/panel-memory.md` v1 > `docs/design-agent-memory.md` v2 头注 |
| 已知口径覆盖 | **D-8（X-1~X-9）优先于早期文档的字面表述**。本文凡涉及删除档位、计数、折叠阈值、天数文案、角标、移除原因、标注要素、表格禁则、AC-5 场景的地方，一律按 D-8 写，见 §7.7 逐条对照 |
| 状态 | **已实现**（D-10 放行）。方案 + 代码 + 自测证据均已交付，自测命令见 §15 |
| 最后更新 | 2026-11-01 |

---

## 0. 阅读指引

### 0.1 本文回答什么

| # | 问题 | 落点 |
| --- | --- | --- |
| 1 | 整体怎么分层，跑在 harness 的哪一侧 | §1 |
| 2 | 数据长什么样（字段严格按 PRD §3.7，**无类型字段**） | §2 |
| 3 | 存哪里、为什么 | §3 |
| 4 | 检索怎么做（混合检索 + 精排 + 降权） | §4 |
| 5 | 写入管线（显著性 / 去重 / 冲突检测） | §5 |
| 6 | 5 状态 9 转换怎么落到代码 | §6 |
| 7 | 双通道一致性 S-1~S-5 怎么保证 | §7 |
| 8 | 检索 P95 ≤ 300ms @ 1 万条怎么达成 | §8 |
| 9 | 可观测性埋哪些点 | §9 |
| 10 | 哪些是**已核实的事实**、哪些是**我的假设** | §10（必读） |
| 11 | 哪些契约我认为需要回文档讨论 | §11 |
| 12 | D-8 九条裁定各自落在哪 | §7.7（逐条对照表） |

### 0.2 一句话结论

**一个 Cordis 插件（Host 侧持有唯一数据源）+ 一个浏览器 bundle（面板）+ 一组模型可见工具（对话通道）**，三者共用同一套 domain 代码；写入与检索全部走 Host 侧 SQLite，前端只做展示与调用，**面板不持有任何本地缓存副本**。

### 0.3 措辞纪律

- **【已核实】** = 我在本机安装产物里读到了源码/契约原文，附出处。
- **【假设】** = 我认为可行、但没有验证过；**实现期必须先验证再写代码**，验证失败就回来改本文（见 §10.2）。
- **【回文档】** = 我认为契约本身需要回到设计/需求讨论（见 §11）。

---

## 1. 架构分层

### 1.1 为什么是「Host 侧单一数据源 + 前端只读展示」

这是 S-1（单一事实来源）的直接结论，也是唯一能同时满足下面四条的形态：

1. **对话通道必须能工作**（无 GUI、纯终端：PE-15 / S-4）。模型可见工具跑在 Host 进程，所以数据必须在 Host 侧。
2. **面板不得有本地副本**（`panel-memory.md` §6.2 明文：面板无本地缓存、不做"先改页面再同步"）。
3. **检索候选集 ≡ {状态=生效}**（I-2）必须只有**一处**实现，否则两处会漂移。
4. **面板不是写入入口**（PB-4）：面板只调管理类接口，写入路径根本不暴露给它。

```
┌──────────────────────────────────────────────────────────────────────┐
│ Browser（web client，插件 bundle）                                    │
│                                                                      │
│  sidebar.footer.action  ──► 入口按钮（**无任何角标**，PE-19 / D-8 X-5）  │
│  sidebar.right.pane.tab ──► 面板正文：A 清单 / B 回收站 / C 变更记录    │
│                             （pane chip 也无角标；面板内 A/B/C 页签计数  │
│                              允许且应当存在，同源渲染 = countVisible）   │
│  conversation.chat.turnTail ─► 「在面板中打开 · 共 N 条」（无内容→null）│
│                                                                      │
│        只做三件事：取数 / 渲染 / 调管理接口（编辑·软删·硬删·恢复）        │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ 同源 HTTP，统一信封 {code,data,message}
┌───────────────────────────┴──────────────────────────────────────────┐
│ Host（Cordis 插件，Node 侧）                                          │
│                                                                      │
│  ┌──────────────┐   ┌───────────────┐   ┌──────────────────────────┐ │
│  │ memory-core  │   │ memory-tools  │   │ memory-http              │ │
│  │ (ctx.memory) │◄──│ 4 个模型工具  │   │ /api/memory/* 路由        │ │
│  │              │   │               │   │ （薄适配层，无业务判断）    │ │
│  └──────┬───────┘   └───────────────┘   └────────────┬─────────────┘ │
│         │                                            │               │
│         │  ← 三条入口都只调 ctx.memory 的方法 →        │               │
│         └────────────────────────────────────────────┘               │
│                              │                                       │
│                    ┌─────────┴─────────┐                             │
│                    │ domain（纯函数）   │  ← 唯一实现                  │
│                    │ 写入/检索/状态机   │                             │
│                    └─────────┬─────────┘                             │
│                              │                                       │
│                     SQLite (node:sqlite)                             │
│                     $DSH_HOME/memory/memory.sqlite                   │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 目录结构（实现期按此落地）

```
src/
├── package.json              # dsh.bundle.patch + dsh.client 双声明
├── cordis.patch.yml          # 把 core / tools / http 三个 entry 插入 profile 层栈
├── build.mjs                 # esbuild → lib/client.js（宿主 __ModuleLoader__ 壳）
├── shared/                   # Host 与 Browser 共用的**纯类型与纯函数**
│   ├── contract.ts           # 线上类型、状态枚举、分层枚举、错误码
│   └── counting.ts           # DC-10 计数口径（唯一实现，两侧共用）
├── host/
│   ├── index.ts              # 插件入口：apply/inject/name
│   ├── db/
│   │   ├── schema.ts         # DDL（含 FTS5 与触发器）
│   │   └── dao/*.ts          # memories / changes / audit / settings
│   ├── domain/
│   │   ├── state.ts          # 5 状态 + 9 转换（T-1~T-9）
│   │   ├── write.ts          # 写入管线：显著性/去重/冲突
│   │   ├── retrieve.ts       # 检索：候选集/混合/精排/降权
│   │   ├── manage.ts         # 编辑/软删/硬删/恢复/批量遗忘
│   │   └── listing.ts        # V-A/V-B/V-C 三个视图的组装
│   ├── tools/index.ts        # 4 个模型可见工具
│   └── http/routes.ts        # /api/memory/*（薄）
├── client/
│   ├── index.tsx             # 注册 4 个 slot
│   ├── entry.tsx             # 侧栏入口（含 U-4 实测结论的落地形态）
│   ├── panel/                # A/B/C 三页签 + 抽屉 + 4 类弹窗
│   ├── tail.tsx              # turnTail：无内容返回 null
│   ├── transport.ts          # 唯一 HTTP 适配层
│   └── styles.ts             # 设计 token（取自 panel-memory.md §8）
└── test/                     # 自测（AC-1/2/3/5/6、DC-10、I-2、U-4）
```

**为什么 `shared/` 只有纯类型与纯函数**：DC-10 的计数口径必须在对话与面板两处**逐字一致**。把它写成一个共用函数（两侧同一份代码）而不是两处各写一遍，是让"两处数字打架"这一类缺陷在结构上不可能发生，而不是靠测试去抓。

### 1.3 插件装配顺序

`cordis.patch.yml` 按 `memory-core → memory-http → memory-tools` 插入：

- `memory-tools` 依赖 `ctx.memory`（core 提供），必须在其后；
- `memory-http` 用 `ctx.inject(['webServer'], …)` 动态挂载（headless profile 没有 webServer，写进静态 `inject` 会导致**整个插件不激活**——这是 `@clinexin/dsh-kb` 的实测结论，见其 `tools/src/index.ts` 注释）。

**【已核实】** `ctx.inject(['webServer'], cb)` 是 `@clinexin/dsh-kb-core` 在 `index.ts:209` 的既有做法，本机装的就是它，行为已在生产 profile 里跑通。

---

## 2. 数据模型

### 2.1 字段表（严格对齐 PRD §3.7，**无类型字段**）

| 字段 | 类型 | 必填 | 说明 | 契约依据 |
| --- | --- | --- | --- | --- |
| `id` | string（ULID） | 是 | 稳定标识；字典序即时间序；删除后不复用 | DC-03 / G-3 |
| `layer` | `'semantic' \| 'episodic'` | 是 | **唯一的结构性归类**。无 `procedural`：程序记忆不进 MVP，且枚举里根本不存在该值 | D-3 / DC-02 / PB-2 |
| `content` | string ≤ 500 | 是 | 一句话可读陈述，脱离上下文可懂 | DC-06 |
| `scope` | `'project' \| 'user'` | 是 | 持久作用域只有这两个；**无 `session`**，枚举里不存在 | D-1 / DC-04 / PB-3 |
| `projectKey` | string \| null | 条件 | `scope='project'` 时必填；`scope='user'` 时为 `null`。取**工作目录绝对路径的规范化值** | AC-8 / §5.8b |
| `sourceType` | `'explicit' \| 'correction' \| 'inferred'` | 是 | **来源可信度**（你明说的/你纠正过的/系统推断的）。与已取消的条目分类无关 | PRD §3.7 / DC-03 |
| `sourceRef` | JSON | 是 | `{ sessionId, turnSeq, snippet, at }`，产生它的对话片段 | DC-07 / AC-11 |
| `createdAt` | integer (ms) | 是 | 创建时间 | §3.7 |
| `confirmedAt` | integer (ms) | 是 | 最近确认时间；冲突判定与排序依据 | §3.7 / AC-3 |
| `status` | `'active' \| 'superseded' \| 'expired' \| 'deleted_soft' \| 'deleted_hard'` | 是 | 5 状态，与 §6 状态机一一对应 | §3.7 / DC-25 |
| `supersededBy` | string \| null | 否 | 被哪条取代（`已修正` 必填，DC-14） | AC-2 / AC-3 |
| `expiresAt` | integer \| null | 否 | 仅 `episodic` 有值（30 天）；`已过期` 必填（DC-14） | AC-4 / DC-29 |
| `reuseCount` | integer | 是 | 复用次数（默认 0），支撑衰减与提升 | §3.7 / DC-23 |
| `lastHitAt` | integer \| null | 否 | 最近命中时间（**检索命中才算，列举不算**） | O-3 / DC-23 |
| `sensitivity` | `'normal' \| 'restricted'` | 是 | 受限条目不进摘要视图、预览中以占位替代 | §3.7 / F6-e |
| `deletedAt` | integer \| null | 否 | 软删时间（回收站保留期起算） | D-5 Q2 |

**明确不存在的列**（防止"换个名字复活"）：

| 禁止的列 | 为什么不能有 | 依据 |
| --- | --- | --- |
| `kind` / `category` / `tag` / `type` / `label` | D-3 取消类型；四分类作废 | DC-01 / PB-1 |
| `decay` / `decayScore` / `strength` / `confidence` | **衰减不是状态、不是字段**，只是检索时的排序系数（见 §4.4） | DC-28 / I-3 |
| `view` / `rank_tier` | 视图不是数据属性，是查询参数 | DC-09 |

> 自测里有一条 `grep` 级断言：`schema.ts` 与全部线上类型中不得出现上述标识符（§12 的 HC-1）。

### 2.2 DDL（SQLite）

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  layer        TEXT NOT NULL CHECK (layer IN ('semantic','episodic')),
  content      TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('project','user')),
  project_key  TEXT,
  source_type  TEXT NOT NULL CHECK (source_type IN ('explicit','correction','inferred')),
  source_ref   TEXT NOT NULL,            -- JSON
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN
                 ('active','superseded','expired','deleted_soft','deleted_hard')),
  superseded_by TEXT REFERENCES memories(id),
  expires_at   INTEGER,
  reuse_count  INTEGER NOT NULL DEFAULT 0,
  last_hit_at  INTEGER,
  sensitivity  TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','restricted')),
  deleted_at   INTEGER,
  -- 作用域完整性：project 必须有 projectKey，user 必须没有
  CHECK ((scope = 'project' AND project_key IS NOT NULL)
      OR (scope = 'user'    AND project_key IS NULL)),
  -- 只有 episodic 能过期
  CHECK (expires_at IS NULL OR layer = 'episodic')
);

-- I-2 的结构性保证：检索走这个索引，它只索引 active
CREATE INDEX IF NOT EXISTS ix_mem_active
  ON memories(project_key, layer, confirmed_at DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_mem_v_a     ON memories(status) WHERE status IN ('active','superseded','expired');
CREATE INDEX IF NOT EXISTS ix_mem_recycle ON memories(deleted_at) WHERE status = 'deleted_soft';
CREATE INDEX IF NOT EXISTS ix_mem_dedupe  ON memories(scope, project_key, layer) WHERE status = 'active';
```

> **`status` 用 `CHECK` 而不是第二张枚举表**：状态集是状态机的一部分（§6），写在 DDL 里让"新增一个状态"必须改 schema，而不是悄悄多一个字符串值。

### 2.3 变更记录与审计（两张旁表，都不含正文副本）

```sql
-- V-C 版本链：只追加。A→B→A 是三个节点，历史不被改写（DC-27 / PC-34）
CREATE TABLE IF NOT EXISTS memory_changes (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memories(id),
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN
                ('correction','edit','scope_change','conflict','expire','restore','delete','hard_delete',
                 'user_asked_not_to_keep')),   -- D-8 X-6：因用户要求不保留
  actor       TEXT NOT NULL CHECK (actor IN ('user','system')),
  at          INTEGER NOT NULL,
  detail      TEXT           -- JSON：不含被硬删正文
);
CREATE INDEX IF NOT EXISTS ix_changes_mem ON memory_changes(memory_id, at);

-- O-1~O-4 审计：只记"发生过什么"，硬删不记正文与标识（AC-5 第 4 条）
CREATE TABLE IF NOT EXISTS memory_audit (
  id        TEXT PRIMARY KEY,
  at        INTEGER NOT NULL,
  op        TEXT NOT NULL,   -- write/reject/retrieve/update/delete/hard_delete/restore
  outcome   TEXT NOT NULL,   -- ok/rejected/timeout/error
  memory_id TEXT,            -- 硬删时为 NULL（不保留标识）
  meta      TEXT             -- JSON：分层/作用域/原因类别/耗时/命中数；永不含正文
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON memory_audit(at DESC);

-- 配置位（D-6 Q5：不进记忆；D-5 Q2：保留期不得写死）
CREATE TABLE IF NOT EXISTS memory_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

**`memory_changes.detail` 与 `memory_audit.meta` 的区别**：前者服务用户（V-C 要给"被谁取代 + 何时 + 原因"），可以带旧正文摘要；后者服务运维，**硬删路径两者都不写正文**（`deleted_hard` 的 `detail` 为 NULL，`memory_id` 也不进 audit）。

---

## 3. 存储选型与理由

### 3.1 结论：SQLite（`node:sqlite`）+ FTS5，落在 `$DSH_HOME/memory/memory.sqlite`

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| **SQLite（`node:sqlite` 内置）** | ✅ **采用** | ①Host 侧同步 API，写入 10 万条量级无需异步驱动；②FTS5 提供真正的倒排 + BM25，1 万条下的关键词通道是**微秒级**；③单文件、事务、崩溃安全；④**零额外依赖**（不引入 native 编译，不给用户装环境） |
| JSON / JSONL 文件 | ❌ | 每次检索全量扫描，1 万条下 P95 必然破 300ms；且部分写失败会损坏全部数据 |
| 向量库（sqlite-vec / LanceDB） | ❌ MVP 不做 | 需额外 native 模块或大依赖；1 万条规模下 FTS5 + 字面通道已足够；**留作 §10.3 的演进位**，schema 预留 `embedding BLOB NULL` 可不改表加列 |
| 复用 `@clinexin/dsh-kb` | ❌ | 那是**资料**库（文档切片 + 语义向量），与"关于用户的记忆"是两套数据。PRD §8 已作废对齐，D-3 进一步取消类型对齐 |
| Server 侧内存 + 定时落盘 | ❌ | 崩溃丢数据；与"记忆属于用户、可查看可删除"的预期不符 |

**【已核实】FTS5 在宿主 Electron 的 Node 运行时里可用**：
- 系统 `node` v23.6.0 的 `node:sqlite`（3.47.2）**没有** FTS5（实测报 `no such module: fts5`）；
- 但宿主运行时 `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"`（**v24.21.0**）里 `create virtual table t using fts5(x)` **成功**。
- ⇒ 插件实际运行在宿主进程内，FTS5 可用；**自测必须用宿主运行时跑**，不能用系统 node（这条已写成 §12 的执行约定）。

### 3.2 分词：为什么不用触发器 + 外部内容表

`@clinexin/dsh-kb` 用 `content='chunks'` 的外部内容表 + 三个触发器同步 FTS。本方案**不用**这套，理由：

1. **中文分词**：`unicode61` 不切中文（会把整句当一个 token）。kb 靠语义向量兜底，本方案没有向量通道，所以必须自己切。
2. **我们的"词"是受控的**：记忆条目是**一句话**（DC-06），数量 1 万以内。用"应用侧切词 + 写入 `tokens` 列"比让 SQLite 去猜更准，也让检索的匹配面**可解释**（用户问"为什么没搜到"时能说清）。

做法：写入时把 `content` + `sourceRef.snippet` 切成 token 串存进独立的 FTS 表：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

- **切词规则**：中文按**二元组（bigram）**切 + 保留连续 ASCII 词（`pnpm`、`vitest`、`dev:web`）；标点与停用词丢弃。合计 token 数 ≈ 2 × 原文字数，1 万条 ≈ 几十万 token，FTS5 完全无压力。
- **同步方式**：**应用侧显式维护**（不是触发器）。原因：kb 的注释已经指出"外键 CASCADE 依赖连接级 `foreign_keys=ON`，漏开就留下孤儿行，表现是删了还能搜到"——这正是 AC-5 最不能出的缺陷。显式维护把顺序写死在一个事务里，不依赖任何连接设置。

```sql
-- 每个写操作都包在一个事务里：先改 memories，再同步 FTS
BEGIN;
  UPDATE memories SET status='deleted_soft', deleted_at=? WHERE id=?;
  DELETE FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id=?);
  INSERT INTO memory_changes (...) VALUES (...);
COMMIT;
```

### 3.3 数据位置与作用域

- 路径：`$DSH_HOME/memory/memory.sqlite`（`$DSH_HOME` 缺省 `~/.dsh`）。
- **本机单用户**（D-1 / OQ-10=A）：无用户表、无身份列。
- `projectKey` = 会话工作目录的**规范化绝对路径**（`realpath` 后统一大小写与分隔符）。`user` 级条目 `project_key` 恒为 `NULL`，跨目录可见（OQ-6=A）。
- **为什么不用目录名**：不同项目可能同名（`~/a/web` 与 `~/b/web`）；用绝对路径让 AC-8 的"P1 不出现于 P2"由 SQL 的等值条件直接保证。

### 3.4 回收站保留期：本方案选择「实现 30 天清理」（D-8 X-4）

D-5 Q2 允许"MVP 可先实现为不过期但要留配置位"，而 **D-8 X-4 裁定「文案必须与实际行为一致」**，并推荐实现 30 天清理。本方案**选择实现 30 天清理**，理由与后果：

| 项 | 结论 |
| --- | --- |
| 实际行为 | `recycleSweep` 每天扫一次，`deleted_at + 30d <= now` 的 `deleted_soft` → `deleted_hard`（T-7） |
| 文案（因此成立） | 面板：「回收站条目保留 30 天后彻底删除」；对话：「删除后可恢复；回收站保留 30 天」 |
| 为什么不做「不过期」 | 那样 PC-23 的「30 天」字样必须删掉，且用户会以为"永久可恢复"。**宣称一条不存在的承诺比没有承诺更糟**（X-4 理由）——它让用户基于错误预期做删除决策 |
| 配置位仍保留 | `retention_days` 可配；若将来改为 `null`（不过期），**必须同步改文案**（否则立刻违反 X-4）。这条写成 §12.1 的 HC-10 自检项 |
| 与 D-5 Q2 的一致性 | Q2 主裁定就是 30 天后转硬删；X-4 只是要求"说到做到"。两者不冲突 |

---

## 4. 检索策略

### 4.1 铁律：候选集 ≡ {status = active}（I-2）

整条检索链**只有一个入口函数**，它的第一个动作就是把候选集钉死：

```ts
// host/domain/retrieve.ts —— 全系统唯一允许读 memories 做检索的地方
function candidates(db, ctx): Row[] {
  return db.prepare(`
    SELECT * FROM memories
     WHERE status = 'active'
       AND (scope = 'user' OR (scope = 'project' AND project_key = ?))
  `).all(ctx.projectKey)
}
```

- **`status` 条件不可由调用方覆盖**：函数不接受 status 参数，SQL 里也没有插值点。
- 作用域条件同时成立：`user` 全可见，`project` 只认当前 `projectKey`（AC-8 / DC-04）。
- 自测 I-2 的做法：造齐 5 个状态各一条，断言**不管检索词怎么变**，返回集合与 `{status=active}` 的集合完全相等（含"用一个只出现在 `已修正` 条目里的词去检索，必须 0 命中"）。

> 这是 AC-2/3/4/5 全部"不再返回"断言的根基。实现上让它**没有第二个入口**，比在四五个查询里各自 `WHERE status='active'` 可靠得多。

### 4.2 三条通道 → 融合

```
query ─┬─► ① FTS 通道（BM25）      ─┐
       ├─► ② 字面/子串通道（LIKE）  ─┼─► 归一化 → ③ 精排 → ④ 降权 → top-K
       └─► ③ 作用域/分层提示加权    ─┘
```

| 通道 | 做什么 | 为什么需要 |
| --- | --- | --- |
| **① FTS5（BM25）** | 用同一套切词查 `memories_fts`，取 BM25 分数 | 中文二元组 + ASCII 词，能处理"测试命令"↔"vitest"这类共现 |
| **② 字面子串** | `content LIKE %q%`（q 为原始查询串，长度 ≥2） | FTS 对**短查询**和**连字符/冒号**（`dev:web`）不敏感；子串通道兜住"我就记得有这个词" |
| **③ 分层/作用域先验** | `scope='project'` 命中在同分时优先于 `user`（R-3.4.2） | 项目事实比用户偏好更贴近当前任务 |

融合：`score = 0.7·norm(bm25) + 0.3·(字面命中 ? 1 : 0)`，再叠加 §4.3 的精排与 §4.4 的降权。

**为什么不是纯 FTS**：`vitest` 在条目里写作「测试命令是 vitest」，用户问「用哪个测试框架」时 FTS 的二元组一个都不命中。混合通道 + 下面的精排让这类"同义但不同词"的召回由内容质量兜底，而不是靠语义模型。

**【假设 H-1】** 没有 embedding 的情况下，纯字面召回率对"用户问法与记忆用词完全不同"的场景会偏低（如记忆写"注释用中文"，用户问"代码风格偏好"）。**这是本方案最可能不达 AC-1 体验预期的地方**。缓解手段是 §4.5 的"按话题召回"与写入侧的措辞规范（DC-06）；根治要靠 §10.3 的向量通道。**这条必须在实现期用真实语料验证**，我不会在方案阶段声称它够用。

### 4.3 精排（rerank）

在候选 ≤ 200 条时（远小于 1 万，因为候选集已按作用域+活跃过滤）做一次确定性精排，**不用模型**：

| 因子 | 权重 | 说明 |
| --- | --- | --- |
| 词覆盖率 | 0.40 | 查询 token 被条目覆盖的比例（含二元组） |
| 命中集中度 | 0.25 | 命中位置是否集中在同一句（避免"散落命中"虚高） |
| 来源可信度 | 0.20 | `explicit` 1.0 / `correction` 0.9 / `inferred` 0.6 |
| 分层先验 | 0.10 | `semantic` 1.0 / `episodic` 0.85（稳定的偏好优先于一次性事件） |
| 时效 | 0.05 | `confirmedAt` 越近越高（半衰期 90 天） |

排序后 `top-K`（默认 5，工具参数可调 1–20）返回。

**为什么不引入模型做 rerank**：AC-10 要求 P95 ≤ 300ms，而一次模型调用本身就是数百毫秒到数秒；且 rerank 的结果不可解释、不可复现，会让 AC-3「只返回一个确定性答案」变成概率事件。

### 4.4 降权（衰减）——**不是状态**

```ts
// 只影响排序，不写回任何字段、不改 status、不影响 V-A 可读性
function decayFactor(row, now) {
  if (row.scope !== 'episodic') return 1.0;          // 语义层不衰减
  const idleDays = (now - (row.lastHitAt ?? row.confirmedAt)) / 86400000
  return 0.5 + 0.5 * Math.exp(-idleDays / 90)         // 90 天窗口，下限 0.5
}
finalScore = rerankScore * decayFactor(row, now)
```

三条硬约束（对应 I-3 / DC-28）：

1. **纯函数**：`decayFactor` 只读 `lastHitAt`/`confirmedAt`/`now`，**没有写回路径**。想要"衰减"在库里可见是做不到的——它没有对应列（§2.1 已禁止）。
2. **不影响可读性**：V-A 里所有 `active` 条目一律可见，衰减只改顺序。
3. **列举不计命中**（DC-23）：只有检索通道返回且被实际采用时，才 `reuse_count += 1, last_hit_at = now`。这样"用户常翻清单"不会让条目永不衰减（AC-4 的前提）。

### 4.5 检索失败/超时的降级（DC-31 / AC-9）

三档**必须可区分**，且任一档都不得编造"我记得"：

| 档 | 判定 | 普通对话（用户没提记忆） | 用户显式查询记忆时 |
| --- | --- | --- | --- |
| D-1 正常但空 | 返回 `[]` | 不提示，正常回答 | `我没有相关记录。` |
| D-2 超时/异常 | 超过 **250ms** 软预算或抛错 | 静默按"无记忆"回答，只记审计 | `记忆暂时读不到（超时），这次没法给你清单。可以稍后再问一次。` |
| D-3 功能关闭 | 设置位为 off | 静默按"无记忆"回答 | `记忆已关闭，我现在没有可查的记忆。` |

**超时预算 250ms 是刻意的**：AC-10 的 P95 目标是 300ms，把软预算压在 250ms 留出渲染/序列化余量，保证"超时降级"本身不会成为拖慢对话的那一项。

---

## 5. 写入管线

### 5.1 总览：五道闸门，顺序不可换

```
对话轮次结束
   │
   ├─① 抽取（Extract）  ── 候选事实 candidate
   ├─② 拒写判定（N-1~N-6）── 命中即止，按"用户是否显式要求"决定静默/回绝
   ├─③ 显著性（Salience）── 不够显著的丢弃
   ├─④ 去重 / 合并 / 冲突检测 ── 决定 新增 / 更新 / 覆盖 / 合并
   └─⑤ 落库（事务）+ 变更记录 + 审计
```

### 5.2 ① 抽取：how

**【假设 H-2】** 抽取的实现形态有两个候选，我不在方案阶段假装已经定死：

| 候选 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. 规则 + 模板（推荐 MVP）** | 从用户消息里匹配"以后/一律/必须/不要/记住/不对…是…"等显式信号 + 一句话陈述模板 | 零延迟、零成本、可解释、可单测；**不产生幻觉** | 召回取决于措辞；对"隐含约定"抓不到 |
| B. 小模型抽取 | 异步调用模型做结构化抽取 | 召回高 | AC-10 的"不阻塞当轮"要求异步排队；成本与幻觉风险；**与"误记率 ≤5%"直接冲突** |

**MVP 采用 A**，理由：D-2 OQ-11=A 是"全自动写入"，一旦自动写错，用户要自己发现并删除——误记的代价远高于漏记。规则版可单测、可回放、可解释，且完全满足 AC-1/2/3 的验收路径（它们全部由**显式表达**触发）。B 作为 P1，**接口预留**（`extract(text): Candidate[]` 是可替换签名的纯函数）。

### 5.3 ② 拒写（N-1~N-6）

```ts
type RejectCategory = 'credential' | 'explicit_dont' | 'temporary' | 'third_party_pii'
                    | 'sensitive_attribute' | 'vent'
function classifyReject(c: Candidate): RejectCategory | null
```

| 类别 | 判定（保守，命中即拒） | 用户是否显式要求记住 | 表现 |
| --- | --- | --- | --- |
| `credential` | `sk-`/`ghp_`/`AKIA`/`BEGIN PRIVATE KEY`/`password=`/`://user:pass@`/长随机串 | 否 | **完全静默**（不写、不提示、不评论） |
| 同上 | | 是 | 回绝一次，**不复述内容**（§7.1 N-1） |
| `explicit_dont` | "别记/不要保存/这段忘掉" | — | `好，这段不记。`；若该段已产生条目 → 追加移除（DC-24） |
| `temporary` | "随口说的/临时的/先记一下" | 视语境 | 静默或"我先不记" |
| `third_party_pii` | 手机号/身份证/住址模式 | 同上 | 静默 / `这条不记：里面有别人的个人信息。` |
| `sensitive_attribute` | 健康/宗教/政治/取向等词表 | 任意 | 不写不推断不复述（W3） |
| `vent` | 对 agent 的负面情绪 + 无人称事实 | 任意 | 静默（避免偏误画像） |

**fail-closed**：`classifyReject` 无法判定时返回 `'unknown'` → 不写。这条比"尽量多记"重要，因为误记不可撤回地影响信任。

**审计**：拒写也记 `memory_audit(op='reject', meta={category})`，**不含正文**（AC-7 + O-1）。

### 5.4 ③ 显著性

```ts
// 只有 ≥ 阈值才写。权重是产品可调参数，写在 memory_settings 里
const SALIENCE = { explicit: 1.0, correction: 0.9, repeated: 0.7, constraint: 0.8, inferred: 0.35 }
const THRESHOLD = 0.6   // inferred(0.35) 单独永远不足 → 满足"不把猜测写成明说"
```

- `explicit`（"记住…""以后都用…"）与 `correction`（"不对，是 X"）天然过线。
- `inferred` 必须**叠加**（同一事实被推断 ≥2 次）才可能过线，且落库时 `sourceType='inferred'`，精排里权重只有 0.6（§4.3）——**"猜测"与"明说"在数据上就不同级**（PRD §3.2 显著性要求的落地）。

### 5.5 ④ 去重 / 合并 / 冲突检测

对每个候选，在**同一 `(scope, projectKey, layer)`** 的 `active` 集合里比对：

```
候选 c 与既有 e 的关系判定：
  ├─ exact     content 规范化后完全相等（去空白、全半角、大小写）
  │            → 不新增；e.confirmed_at = now（更新"最近确认"）；回执「这条已经在记忆里了（第 N 条）」
  ├─ equivalent 切词后 token 集合 Jaccard ≥ 0.85
  │            → 同 exact（保留原始来源，DC-07）
  ├─ conflict  同槽位互斥：识别出「同一主语 + 同一谓词 + 不同值」
  │            例：测试命令是 jest / 测试命令是 vitest
  │            → T-2 覆盖：e.status='superseded', e.superseded_by=new.id；new.status='active'
  ├─ refine    候选是既有条目的补充（既有 token 集合 ⊂ 候选）
  │            → 合并进 e.content，e.confirmed_at = now；回执「已并入第 N 条」
  └─ new       → 新增
```

**冲突识别的实现**（这是最容易做虚的一处，我写清楚边界）：

- 用**槽位键**：`(主语, 谓词)` 的规范化形式。中文里常见谓词是「是/用/必须/不要/约定」。主语取候选句的主干名词短语，谓词取动词/系词后的规律片段。
- **只在同槽位、不同值时判 conflict**；判不出来就**退化为 `new`**（宁可留两条由精排排序，也不误覆盖用户的历史说法）。
- 覆盖必须留变更记录（`memory_changes(reason='conflict')`），且**不提供回滚**（DC-27）：用户改回旧说法时产生**一条新 active 条目**，原 `superseded` 条目**保持** `superseded`，V-C 呈现 `A → B → A` 三个节点。

**【假设 H-3】** 纯规则的中文槽位识别召回有限：对「用 pnpm 不用 npm」这类，能识别；对「别自动改版本号」→「版本号可以自动改」这类**否定极性翻转**，可能识别不出冲突而落成两条 new。后果是 AC-3 的"只返回一个确定性答案"要靠精排把旧条目压低——**这不足以保证 AC-3**。缓解：否定极性单独做一个 `polarity` 归一（「不要/别/禁止」标记为负极性），极性不同的同槽位**强制判 conflict**。**实现期必须为这条写专项用例**（§12 TC-AC3b）。

### 5.6 ⑤ 落库

```ts
// 一个事务里做完五件事，任一失败全回滚
db.exec('BEGIN IMMEDIATE')
try {
  // 1. 状态迁移（§6）
  // 2. 写 memories_fts（同步，不靠触发器）
  // 3. 写 memory_changes（V-C）
  // 4. 写 memory_audit（O-1，不含正文）
  // 5. 若 supersede：更新旧条目的 superseded_by + 其 change 记录
  db.exec('COMMIT')
} catch (e) { db.exec('ROLLBACK'); throw e }
```

**异步不阻塞当轮对话**（AC-10 / DC-33）：写入在**轮次结束事件**里排队执行，工具返回值不等待写盘；"已记住"表示**已受理**（F2 系统行为第 4 条）。若随后写失败，**下一次交互**开头显式告知 `（上一条我没记住，可以再说一次，或换个说法）`——不允许假装成功。

---

## 6. 状态机实现映射（5 状态 / 9 转换）

### 6.1 状态与不变量

```ts
export const STATUS = ['active','superseded','expired','deleted_soft','deleted_hard'] as const
export type Status = typeof STATUS[number]

// 状态 → 是否参与检索 / 是否在 V-A / 是否终态
const STATUS_META = {
  active:       { retrievable: true,  inListA: true,  terminal: false },
  superseded:   { retrievable: false, inListA: true,  terminal: false },
  expired:      { retrievable: false, inListA: true,  terminal: false },
  deleted_soft: { retrievable: false, inListA: false, terminal: false },
  deleted_hard: { retrievable: false, inListA: false, terminal: true  },
} as const
```

**不变量在代码层的落法**：

| 不变量 | 落法 |
| --- | --- |
| I-1 同一时刻只有一个状态 | `status` 是单列（不是位图/多值列） |
| **I-2 检索候选集 ≡ active** | 唯一检索入口写死 `WHERE status='active'`（§4.1），且**没有第二处**读 `memories` 做检索 |
| I-3 衰减不是状态 | `decayFactor` 是纯函数（§4.4），`STATUS` 里不存在 `decayed` |
| I-4 只有情景层自然过期 | DDL `CHECK (expires_at IS NULL OR layer='episodic')` |
| I-5 `已修正` 不参与过期扫描 | 过期扫描 SQL 只取 `status='active' AND layer='episodic'` |

### 6.2 9 个转换的代码映射

所有状态变更**只能**经 `host/domain/state.ts` 的 `transition()`，它同时写 `memory_changes`：

```ts
function transition(db, id, to: Status, ctx: { actor: 'user'|'system'; reason: ChangeReason; at: number; detail?: object })
```

| ID | 转换 | 触发者 | 代码位置 | 实现要点 |
| --- | --- | --- | --- | --- |
| **T-1** | ∅ → active | 系统/用户 | `write.create()` | 分配 ULID；`episodic` 时 `expires_at = now + 30d` |
| **T-2** | active → superseded | 系统/用户 | `write.supersede()` | `superseded_by = newId`；**不回滚**：改回旧说法 = 新建 active（DC-27） |
| **T-3** | active → expired | 系统 | `job.expireSweep()` | 只扫 `active AND episodic AND expires_at <= now`；**语义层永不进入此扫描**（I-4） |
| **T-4** | expired → active | 用户 | `manage.restore()` | **按 `episodic_retention_days` 重新计时**（D-5 Q4）；写 `reason='restore'` |
| **T-5** | active/superseded/expired → deleted_soft | 用户 | `manage.softDelete()` | `deleted_at=now`；**保留期配置位读取**（D-5 Q2 + D-8 X-4，默认 30 天） |
| **T-6** | deleted_soft → 删除前状态 | 用户 | `manage.undoOrRestore()` | 恢复**原状态**（存在 `memory_changes.from_status`）；D-5 Q4：若恢复后是 `expired` 情形不存在（软删的不是 expired 才奇怪），按写入时的 `from_status` 精确还原 |
| **T-7** | deleted_soft → deleted_hard | 用户/系统 | `manage.hardDelete()` / `job.recycleSweep()` | 用户路径需二次确认（DC-20）；系统路径按保留期；**两者都清 FTS 行** |
| **T-8** | active/superseded/expired/deleted_soft → deleted_hard | 用户 | `manage.hardDelete()` | 隐私删除：**正文置 NULL**（不是删行——行要留给"发生过一次硬删"的审计锚点，但除 id/时间外全部抹掉） |
| **T-9** | deleted_hard → ∅ | — | 无 | 终态，代码中**没有**该转换的分支 |

#### 6.2.1 删除档位的判定（**D-8 X-1 / X-6 落地，最易实现错的一条**）

档位**只能**由「显式不可逆措辞」决定，**不能**由「忘掉」这类日常词决定：

```ts
// host/domain/intent.ts —— 全系统唯一的档位判定
export type DeleteTier = 'soft' | 'hard'

/**
 * D-8 X-1：只有显式不可逆措辞才 → hard。
 * 「忘掉」在单条与批量两种指代下**都是 soft**（X-1 前两条）。
 */
const HARD_ONLY = ['彻底删除', '彻底删掉', '彻底清掉', '永久删除', '永久删掉',
                   '不要留任何副本', '不留副本', '不可恢复地删除', '彻底抹掉']

export function decideDeleteTier(utterance: string, target: 'single' | 'batch'): DeleteTier {
  // 「忘掉」无论单条还是批量，一律 soft —— 显式写出来，防止有人"顺手优化"成 hard
  if (/忘掉/.test(utterance) && !HARD_ONLY.some(w => utterance.includes(w))) return 'soft'
  return HARD_ONLY.some(w => utterance.includes(w)) ? 'hard' : 'soft'
}
// target 参数保留：X-1 要求"带具体指代的单条"与"批量"都 soft，
// 二者的差别在**是否先预览**（批量必须预览后执行，DC-22），不在档位。
```

| 用户说法 | 档位 | 依据 | 是否需二次确认 |
| --- | --- | --- | --- |
| 「删掉第 3 条」 | soft | 默认档（S-2 统一软删） | 否（回显正文即可，DC-17） |
| 「忘掉第 3 条」 | **soft** | **D-8 X-1 第 1 条** | 否 |
| 「忘掉关于 X 的全部记忆」 | **soft** + 先预览 | **D-8 X-1 第 2 条**（F6 批量） | 需预览（不是"二次确认"） |
| 「这段别记了」 | **soft** + 回收站标注原因 | **D-8 X-6**（N-2 / DC-24） | 否 |
| 「彻底删除第 3 条」/「永久删除」/「不要留副本」 | **hard** | **D-8 X-1 第 3 条** | **是**（显式勾选，DC-20） |

**X-6 的落地**：`memory_changes.reason` 增加 `'user_asked_not_to_keep'`，回收站行读取该 reason 显示「因用户要求不保留」。**同一字段还承担"回收站里为什么出现这条"**，所以它必须存在（不是 UI 层硬编码字符串）：

> 该枚举值已并入 §2.3 的 `memory_changes` DDL（`CHECK` 里含 `'user_asked_not_to_keep'`），此处不重复一份，避免两处漂移。

回收站行的 `removeReason` 取值优先级：`user_asked_not_to_keep` → 「因用户要求不保留」；其余 → 「你删除了这条」。**注意 X-6 明确要求不触发硬删**，所以这些条目在回收站里**内容可见**（与隐私硬删相反，后者内容已抹为 NULL）。

> **为什么把档位判定放在 domain 而不是两条通道各自的意图解析里**：S-2 要求"同一意图两条通道结果一致"。如果对话侧解析「忘掉」为 soft、面板侧某个按钮写死 hard，就是 S-2 违规。把 `decideDeleteTier` 做成**唯一实现**，面板的"删除"按钮直接调 `softDelete()`，根本没有 hard 的分支可走（§7.2/§7.3 已说明）。


**T-8 的实现细节（最容易做错）**：

```sql
-- 隐私删除：不是 DELETE FROM，而是把可识别信息全部抹成占位
UPDATE memories SET
  status = 'deleted_hard',
  content = NULL,                -- 正文抹除（AC-5：任何衍生形态不可复现）
  source_ref = '{}',             -- 来源引用抹除（C-5：硬删后来源不可追溯）
  superseded_by = NULL, expires_at = NULL,
  project_key = NULL, reuse_count = 0, last_hit_at = NULL
WHERE id = ?;
DELETE FROM memories_fts WHERE rowid = ?;   -- 索引必删，否则还能被搜到
INSERT INTO memory_audit (..., op='hard_delete', memory_id=NULL, meta='{"count":1}')  -- 不记标识、不记正文
```

> **为什么不 `DELETE FROM memories`**：`memory_changes` 外键指向它；且"审计只留发生过一次隐私删除"需要一个锚点。但**内容类字段必须全 NULL**，且**不进任何视图/检索/摘要**——这一条由 §4.1 的候选集（只有 `active`）和 §2.3 三视图的可见性矩阵同时保证。

### 6.3 过期与回收站清理（两个后台任务）

| 任务 | 频率 | 动作 | 依据 |
| --- | --- | --- | --- |
| `expireSweep` | 每小时 | T-3：`active AND episodic AND expires_at<=now` → `expired` | AC-4 / DC-29 |
| `recycleSweep` | 每天 | T-7：`deleted_soft AND deleted_at + retention <= now` → `deleted_hard` | D-5 Q2 |

- 保留期从 `memory_settings.retention_days` 读，**默认 30**（本方案按此实现，见 §3.4）。
- 两个任务都**幂等**（重复跑不产生重复 change 记录：`transition` 里检查 from==to 则跳过）。
- 任务用 `ctx.setInterval`（cordis-plugin-timer 提供；**【已核实】** profile 里 `@deepseek-ai/cordis-plugin-timer` 是 `dsh-desktop-runtime` 的直接依赖）。

---

## 7. 双通道一致性（S-1 ~ S-5 的实现方式）

### 7.1 S-1 单一事实来源

| 措施 | 说明 |
| --- | --- |
| 数据只在 Host 侧 | 浏览器 bundle 里**没有**任何持久化（无 localStorage 副本、无 IndexedDB）。状态只活在 React state，刷新即重取 |
| 面板无乐观写入 | 所有管理操作 `await` 接口成功后才更新 UI；失败显示错误态，**不改本地数据** |
| **同进程写读** | 面板改完，模型工具下一次调用读的是同一个 SQLite（同一连接池），天然立即可见（DC-26 的跨通道版本） |
| 有可断言点 | 实现期用例：面板编辑第 N 条 → 立刻在对话里检索**同话题** → 只返回新内容（§12 TC-S1-1） |

**"立即"有多立即**：面板的 HTTP 请求与工具调用都在 Host 进程内，写事务提交后下一个读就可见。**不需要**任何"刷新"或"通知"机制。这一点在方案里写死，避免实现时引入一个会漏的缓存层。

### 7.2 S-2 语义等价

| 同一意图 | 对话通道 | 面板通道 | 实现保证 |
| --- | --- | --- | --- |
| 普通删除 | 「删掉第 N 条」 | 「删除」按钮 | **两者都调 `manage.softDelete()`**，同一个函数 |
| 彻底删除 | 「彻底删除」+ 二次确认 | 勾选框 + 二次确认 | 都调 `manage.hardDelete()`；**确认门槛在 domain 层**，不在 UI 层 |
| 编辑 | 「把第 N 条改成…」 | 编辑弹窗 | 都调 `manage.edit()` → 产出 superseded + active |
| 恢复 | 「恢复第 N 条」 | 回收站恢复 | 都调 `manage.restore()` |

**关键设计：把"档位"和"确认"放 domain，不放 UI。** 这样"面板默认硬删"这类 S-2 违规在结构上做不到——UI 根本没有别的函数可调。`hardDelete()` 的签名强制带一个 `confirm: {token, at}`，而该 token 由 `manage.prepareHardDelete(id)` 生成（即"先回显再确认"的两步协议在 API 层就存在）。

### 7.3 S-3 不可绕过

| 面板不得提供 | 结构性保证 |
| --- | --- |
| 手动改分层 | `manage.edit()` 的入参类型**没有** `layer` 字段；改分层在类型层不可能表达 |
| 按类型筛选 | 数据无类型列（§2.1），接口无该参数 |
| 查看已硬删内容 | `deleted_hard` 行的 `content` 是 NULL；`listing` 只查三个视图，硬删不在任何视图 |
| 版本回滚 | 没有任何 `rollback`/`revert` 方法 |

**为什么用类型层而不是运行时校验**：`layer` 不出现在编辑入参里，编译器就替我们守住了 D-5 Q3。这比写一个 `if (input.layer) throw` 更难绕过（后者会被"顺手加个参数"绕过）。

### 7.4 S-4 降级

| 场景 | 保证 |
| --- | --- |
| 纯终端 / 未装前端 bundle | 4 个模型工具照常工作；「打开记忆面板」回 `这个环境没有图形面板，我直接把清单打给你。`（逐字，PE §9.1） |
| 面板渲染失败 | 面板体给错误态 + 重试；**对话侧一行代码都不受影响**（数据与业务全在 Host） |
| 面板打不开（无会话 D-0） | 入口给 `记忆面板跟随会话显示。先新建或进入一个会话。`；对话侧能力不变 |

**结构性理由**：面板不是写入入口（PB-4），所以"面板整个挂掉"的最坏后果只是"少一个查看窗口"。这一点在架构层成立，不需要额外容错。

### 7.5 S-5 判定口径不变

DC-10（计数准确性）与 C-3（V-A 专指）在两条通道上**共用同一个函数**。注意 **D-8 X-2** 对 N 的口径分两种情形：

```ts
// shared/counting.ts —— 对话清单与面板首行都调它
export interface CountResult { n: number; a: number; b: number; c: number; filterLabel: string | null }

/**
 * @param rows   已经过视图与筛选的可见集（V-A 三态）
 * @param filter 当前筛选条件。null = 未筛选。
 *
 * D-8 X-2：
 *   未筛选时 N = 全量 V-A 可见集；
 *   有筛选时 N = **筛选后集合**，且 filterLabel 必须回传给首行显示。
 */
export function countVisible(rows: Row[], filter: Filter | null): CountResult {
  const a = rows.filter(r => r.status === 'active').length
  const b = rows.filter(r => r.status === 'superseded').length
  const c = rows.filter(r => r.status === 'expired').length
  const n = a + b + c                       // 软删永不计入
  if (n !== rows.length) throw new Error('DC-10 invariant violated')
  if (filter !== null && filter.isAllClear()) throw new Error('X-2: 全清筛选必须传 null，否则首行会多打一个限定词')
  return { n, a, b, c, filterLabel: filter?.label() ?? null }
}
```

- 输入 `rows` 必须是**当前视图 + 当前筛选**的可见集（未筛选时即全量 V-A：`status IN (active,superseded,expired)`）。
- 函数内部有 `assert`：`a+b+c === n === rows.length`。**不满足就是 bug，直接抛**——让缺陷在开发期而不是验收期暴露。
- **X-2 的第二个硬要求：首行必须显示当前筛选条件。** 所以 `filterLabel` 是返回值的一部分，不是可选装饰：
  - 对话通道首行：`记忆清单（项目级）｜ 项目 dsh-momery ｜ 共 3 条（生效 3 / 已修正 0 / 已过期 0）`
  - 面板统计条：`共 3 条（生效 3 / 已修正 0 / 已过期 0）· 已筛选：作用域=项目`
  - **未筛选**时两边都不打限定词（`filterLabel = null`）。
- 回收站条数**单独取**（`count(where status='deleted_soft')`），与 N 无关，且 UI 上有独立一行明写"不计入"。

### 7.6 折叠阈值的作用域（D-8 X-3）

折叠判定**统一为「V-A 全清单已过期合计 > 5」**，不是"单层内 >5"：

```ts
// shared/counting.ts
export const EXPIRED_COLLAPSE_THRESHOLD = 5

/** D-8 X-3：两通道同一口径 —— 数的是全清单，不是某一层。 */
export function shouldCollapseExpired(count: CountResult): boolean {
  return count.c > EXPIRED_COLLAPSE_THRESHOLD
}
```

- 输入是 **`count.c`（全清单已过期合计）**，不是按层 reduce 后的最大值。
- 反例（这是 X-3 要消除的缺陷）：语义层 4 条过期 + 情景层 4 条过期 → 全清单 8 条 > 5 → **必须折叠**；按"单层内"会得到"两层都不折叠"，两通道结论相反，直接违反 S-5。
- 折叠**不减小** N 与 c（DC-13 / PC-13）：折叠只影响渲染，计数照旧。

### 7.7 D-8 九条裁定的实现落点对照（逐条）

| # | 裁定 | 本文落点 | 代码落点（实现期） |
| --- | --- | --- | --- |
| **X-1** | 「忘掉」= 软删（单条与批量）；只有显式不可逆措辞 → 硬删 | §6.2.1 档位判定表 | `domain/intent.ts: decideDeleteTier()`（唯一实现） |
| **X-2** | 筛选态 N = 筛选后集合，首行必显筛选条件 | §7.5 | `shared/counting.ts: countVisible(rows, filter)` 返回 `filterLabel` |
| **X-3** | 折叠阈值 = V-A 全清单合计 > 5 | §7.6 | `shared/counting.ts: shouldCollapseExpired(count)` |
| **X-4** | 天数文案必须与实际行为一致；**本文选实现 30 天清理** | §3.4 + §6.3 清理任务、§12.1 HC-10 | `job.recycleSweep` 默认 30 天；UI 文案「回收站条目保留 30 天后彻底删除」 |
| **X-5** | 侧栏入口 + pane chip 无任何角标；**面板内 A/B/C 页签计数允许且应当存在** | §10.2 U-4 提案（入口无角标）、§7.5（页签计数同源） | 入口组件无角标 DOM（PE-19）；面板页签计数调 `countVisible` 同一结果 |
| **X-6** | 「别记」移除 = 软删 + 回收站标注「因用户要求不保留」 | §6.2.1 X-6 落地段 | `memory_changes.reason='user_asked_not_to_keep'` |
| **X-7** | 标注统一**五要素**（序号/分层/作用域/来源时间/来源事件短语） | §7.8 | `formatBasis()` 一个函数，五字段缺一即抛 |
| **X-8** | DC-12 禁表格**仅约束对话通道**；面板可用表格 | §7.8 | 对话清单渲染器不用表格；面板表格带 `caption` + `th scope` |
| **X-9** | AC-5 用**非凭据目标**验证，且必须用显式不可逆措辞 | §12.2 AC-5 用例 | 测试夹具用「家里 WiFi 名」，触发词必须含「彻底」 |

### 7.8 X-7 / X-8 的落地细节

**X-7 五要素标注**（`§7.3` 的"依据记忆"格式）：DC-32 的五项必须全部存在，缺一即不合格。

```ts
// host/domain/format.ts
export function formatBasis(row: Row, ordinal: number): string {
  // 序号、分层、作用域、来源时间、来源事件短语 —— 五要素
  const parts = [row.layer, row.scope, formatDate(row.sourceRef.at), row.sourceRef.eventPhrase]
  if (parts.some(p => !p)) throw new Error('X-7: 标注缺要素')
  return `依据记忆（第 ${ordinal} 条 · ${parts.join(' · ')}，${formatDate(row.sourceRef.at)}）：${row.content}`
}
```

> 之前 `design-agent-memory.md` §7.3-2 写"四要素"，D-8 X-7 已更正为五要素（笔误）。实现按 DC-32 的列举，五要素齐备。

**X-8 表格禁则的边界**：

| 通道 | 是否可用表格 | 说明 |
| --- | --- | --- |
| 对话清单 | ❌ **禁止**（DC-12 / L-1） | 终端宽度不定、中文双宽对齐会错位 |
| 面板 | ✅ **允许**且设计已规范 | `panel-memory.md` §9.1 要求 `caption`（`sr-only`）+ `th scope="col"` |

两条不冲突：DC-12 只约束对话通道的清单输出。实现上这是两个不同的渲染器，**不共用表格组件**。


---

## 8. 性能达标路径：P95 ≤ 300ms @ 1 万条

### 8.1 预算分解

| 阶段 | 目标 | 手段 |
| --- | --- | --- |
| 候选集过滤 | ≤ 5ms | 部分索引 `ix_mem_active`（只索引 active，索引本身小） |
| FTS5 BM25 | ≤ 20ms | 独立 FTS 表 + 受控 token 列；1 万条二进制搜索 |
| 字面通道 | ≤ 30ms | `LIKE` 只跑在**候选集**（已按作用域过滤，通常 < 1000 行） |
| 精排 | ≤ 15ms | 候选 ≤ 200；纯算术，无 I/O |
| 序列化 + 返回 | ≤ 10ms | top-K ≤ 20 |
| **合计** | **≈ 80ms** | 相对 300ms 有 3.7× 余量 |

### 8.2 三条保底手段（若实测超标）

1. **限制字面通道的输入集**：`LIKE` 前先用 FTS 的候选并集收窄（已经这么设计）。
2. **WAL + 单连接**：避免多连接竞争锁；写入用 `BEGIN IMMEDIATE` 短事务。
3. **`PRAGMA cache_size` / `mmap_size`**：1 万条的库文件只有几 MB，整库常驻内存后 FTS 查询是纯内存操作。

### 8.3 验收方式（不靠感觉）

- 生成 **10,000 条**随机中文记忆（长度 15–60 字，覆盖 2 层 × 2 作用域 × 5 状态）。
- 跑 **500 次**随机查询，记录 P50/P95/P99（`memory_audit.meta.elapsedMs` 同时留存，便于事后取证）。
- 断言 P95 ≤ 300ms。
- **【假设 H-4】** 以上预算是基于"候选集 < 1000 行 + FTS5 内存命中"的推算，**不是实测值**。实现期必须跑出真数字；若超标，回到 §8.2 或调整 §4.3 的候选上限（把 200 降到 100，精排自然变快），**不放宽 AC-10 的 300ms**。

**超时降级不影响达标**：250ms 软预算触发时走 D-2 文案（§4.5），用户看到的是"读不到"而不是"卡住"。这条让"偶尔慢"变成可预期的降级而非体验崩塌。

---

## 9. 可观测性埋点

对应 PRD §6.3 的 O-1~O-6，全部落在 `memory_audit`：

| 埋点 | 触发 | 字段 | 明确不记 |
| --- | --- | --- | --- |
| `write` | 每次成功写入 | 时间、分层、作用域、来源类型、`sourceRef`（会话+轮次）、是否合并/覆盖 | — |
| `reject` | 每次拒写 | 时间、原因类别（N-1~N-6）、是否用户显式要求 | **正文、被拒原文** |
| `retrieve` | 每次检索 | 查询意图（query 文本长度与 token 数，**不存原文**）、命中 ID 列表、`elapsedMs`、是否降级 | 查询原文（可能含敏感内容） |
| `update` | 编辑/改作用域 | 目标 ID、操作类型（不含旧正文） | 正文 |
| `delete` | 软删 | 目标 ID、时间 | 正文 |
| `hard_delete` | 硬删 | **只有"发生过一次"与时间** | **标识、正文**（AC-5 第 4 条） |
| `restore` | 恢复/撤销 | 目标 ID、恢复到的状态 | — |

**"最近一次被使用"**（O-3）：`memories.last_hit_at` 直接可查，面板详情展示（`panel-memory.md` §4.1「使用情况」）。

**统计口径**（O-5）：`写入量 / 拒绝量 / 命中率 / 延迟分位 / 误记反馈数` 全部从 `memory_audit` 聚合，**不额外建计数器表**（避免两套数字打架）。延迟分位用 `elapsedMs` 的 SQL 聚合（每 1000 条取样即可）。

**为什么 `retrieve` 不存查询原文**：用户可能用记忆系统查敏感话题（"我上次说的那个密码"），把查询原文落库等于绕过 N-1。只存 token 数与长度，足以做性能分析。

---

## 10. 事实、假设与未验证项（**评审必读**）

### 10.1 我已核实的事实（附出处）

| # | 事实 | 出处 / 验证方式 |
| --- | --- | --- |
| F-1 | `sidebar.footer.action` 是 `list`/`root`，ownerProps **只有 `{wide: boolean}`**，不给 sessionId | 宿主插槽目录（`dsh-cordis-client-runner/lib/client.js:5701`）原文：`OwnerProps: { wide: boolean }`；`occupants: ["client-ui-cordis CordisPanel id 'cordis-panel'"]` |
| F-2 | 该位**当前只有一个 occupant**（cordis 插件面板），`replaceRisk: "none"` | 同上 `occupants` 数组 |
| F-3 | `sidebar.right.pane.tab` 是 `keyed`/`session`，body 通过 `useTabInfo()` 拿 `{sidebar, panel, tab}`；`tab.navigation.params` 承载打开参数 | `dsh-client-ui-sidebar-right/README.md` + `tab-info.js` 的 `tabInfoFactory` |
| F-4 | `conversation.chat.turnTail` 是 `list`/`session`，ownerProps `{turn, seq, openFile}`；**无内容的 entry 返回 null** | 插槽目录原文；`dsh-client-ui-chat/lib/client.js:7011` 的 `renderSlot` 调用 |
| F-5 | 普通页面页签**在同格内自动去重** | `sidebar-right/README.md`：`ordinary page tabs always deduplicate within the target pane` |
| F-6 | 无会话时右侧栏**整体不存在**（状态按 sessionId 键控，hero 屏右侧为空） | 同上；`ctx.sidebarRight.mounted` |
| F-7 | `<768px` 打开面板**自动全屏**；普通/全屏**共用同一棵内容树，切换不重挂载** | 同上「Presentations」节 |
| F-8 | **侧栏宽 264–420，默认 280**（不是设计稿写的 236） | `dsh-client-ui-layout/lib/client.js:39-48` `computeColumns`：`clampWidth(sidebar, 264, 420)`；store 默认 `sidebar: 280` |
| F-9 | 折叠轨宽 = **`(darwin \|\| windows-titlebar) ? 0 : 56`** —— macOS 桌面折叠时**整列隐藏、没有轨道** | 同上：`const collapsedWidth = darwin \|\| document.documentElement.hasAttribute("data-windows-titlebar") ? 0 : 56` |
| F-10 | 侧栏 `padding: 6px 12px`（宽态）/ `18px 10px 6px`（折叠）；`footerActions {width:100%; display:flex}` | 侧栏包 CSS（`dsh-client-ui-sidebar/lib/client.js:116` 的 `kB3qhq_*` 规则） |
| F-11 | Settings 的 `triggerRow` 是 `width: calc(100% + 4px)`（**故意全出血**） | `dsh-client-ui-settings-general/lib/client.js:61` |
| F-12 | cordis 的入口按钮 `flex:none; width:calc(100% + 4px)`（宽态独占整行）/ `36×36`（折叠） | `dsh-client-ui-cordis/lib/client.js:634` 的 `sB3NaG_*` 规则 |
| F-13 | **FTS5 在宿主运行时可用**，系统 node 不可用 | 实测：系统 `node -v23.6.0` 报 `no such module: fts5`；`ELECTRON_RUN_AS_NODE=1 .../DeepSeek Harness`（v24.21.0）成功建表 |
| F-14 | `ctx.inject(['webServer'], cb)` 是既有插件的成熟做法；写进静态 `inject` 会让 headless 下**整个插件不激活** | `@clinexin/dsh-kb-core/src/index.ts:209` 与其 `tools/src/index.ts` 的注释（本机生产 profile 在用） |
| F-15 | 宿主共享模块表（浏览器 bundle 只能 require 这些）：`react`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store`、`zod` 等 | `@clinexin/dsh-kb-ui/build.mjs` 的 `PLATFORM_MODULES`（对齐同一宿主版本线） |
| F-16 | 浏览器 bundle 形态：`window.__ModuleLoader__.load({id, factory})` 壳 + CJS 产物 | 同上 build.mjs |

### 10.2 未验证项与我的判断（**请评审时重点看这里**）

#### U-4 入口像素 —— **已实测，并发现设计稿与宿主事实冲突**

我没有在运行中的 Electron 窗口里截图（`dsh web` 需要临时令牌，自动化拿不到；`screencapture` 在本会话被系统权限拒绝）。**但我做了一个更硬的测量**：把宿主自己的 CSS 原样抠出来（`src/test/extract-host-css.mjs`，无改写），用真实 occupant 的 DOM 结构 + 真机宽度常量，在无头 Chromium 里真算 `getBoundingClientRect`。产物：`src/test/u4-entry-metrics.txt`、`src/test/u4-baseline.txt`。

**测量结论（3 个候选规格 × 3 档侧栏宽 + 折叠轨，共 60 条断言，见 §12）**：

| 结论 | 数值证据 | 影响 |
| --- | --- | --- |
| **① 设计稿 §8.3 的「236px」与宿主不符** | 宿主侧栏 264–420，默认 **280**（F-8） | 规格要按 264 起算，不是 236 |
| **② 「插件图标 + 记忆图标 + Settings 同排不换行」做不到** | cordis 入口是 `flex:none; width:calc(100%+4px)`，**宽态独占整行**（F-12）。同排放任何 ≥1px 的项 → 行内合计 > 可用宽，入口被挤出侧栏并被 `overflow:hidden` 裁掉（实测：280px 下记忆入口右溢 **+244px**，几乎完全不可见） | **§8.3 的"同排"必须改**（→ §11-Q1） |
| **③ 折叠轨**无法满足 ≥44×44** | 轨道可用宽 = 56 − 2×10 = **36px**；宿主自家的 Settings 与 cordis 入口也同样只有 36×36 | 44×44 只在宽态成立；折叠轨应沿用宿主既有的 36×36（→ §11-Q2） |
| **④ macOS 桌面折叠时没有轨道** | `collapsedWidth = darwin ? 0 : 56`（F-9），本机就是 macOS | 折叠轨形态只与 **Web GUI / Windows** 有关 |
| **⑤ 唯一全档位成立的排布 = 纵向叠放** | `v3_stacked`：264/280/420 宽度下**全部** PASS（不重叠、不裁切、命中区 44 高、图标 18、文字可见），折叠轨下 36×36 且不溢出 | 我的实现提案取这个（→ §11-Q1） |

**我的提案**（实现期按此写，**但需设计侧确认后才定稿**）：

```
宽态（侧栏 264–420）              折叠轨（仅 Web/Windows，56px）
┌──────────────────────┐          ┌────┐
│ [记] 记忆             │  44px    │[记]│ 36×36
├──────────────────────┤          ├────┤
│ [◈] 插件        0     │  42px    │[◈]│ 36×36（宿主 cordis 原样）
├──────────────────────┤          ├────┤
│ [⚙] 设置              │  42px    │[⚙]│ 36×36（宿主 settings 原样）
└──────────────────────┘          └────┘
   记忆 = 脚区第一行（order 使然）
```

- 记忆入口**叠在插件入口之上**（`footerActions` 改 `flex-direction: column`，我方 `order:-1`）。
- **不改宿主任何 CSS**：只给我方入口自己的 class 加规则 + 对 `.footerActions` 一条容器规则（若宿主升级改了该类名，**入口视觉退化但功能不坏**——这是刻意的降级设计）。
- 角标：**入口与 pane chip 都不显示任何角标**（PE-19 + **D-8 X-5**）。注意 X-5 区分了两个对象：面板**内部** A/B/C 三个页签的计数**允许且应当存在**（它受 PC-11 同源约束，由 `countVisible` 同一结果渲染），这不叫角标。实现时不要在入口组件里放任何数字或圆点。

> **诚实说明**：这是在"宿主 CSS + 真实结构"上的布局测量，**不是真机 GUI 截图**。剩下的不确定性只有窗口级因素（macOS 隐藏标题栏高度、滚动条占位）。**建议实现期由人在 GUI 里看一眼确认**，但方案层面的结论（②③④⑤）不依赖那一眼——它们有源码与算术双重依据。

#### 其余未验证项

| # | 项 | 我的判断 | 何时验证 |
| --- | --- | --- | --- |
| **A-1** | 抽取用规则（H-2）能否满足 AC-1/2/3 的可观察行为 | **能**：三条 AC 的触发语全是显式表达（"记住""以后用""不对，是"），规则可覆盖 | 实现期第一件事 |
| **A-2** | 纯字面检索的召回率（H-1） | **已实测，见 §10.4**。加受控同义词表后 top-3 = 97.9%、top-5 = 100%、top-1 = 72.9% | 已测（2026-11-01，48 个问法） |
| **A-3** | 中文槽位冲突识别（H-3） | **部分能**：同槽位不同值可以；否定极性需单独归一化才算稳 | 实现期写 TC-AC3b 专项 |
| **A-4** | 检索性能（H-4） | 推算 ≈80ms，**未实测** | 实现期跑 500 次取样 |
| **A-5** | 「在对话中定位」按钮（PE-13 / X-1） | **不渲染**。宿主无公开"滚到某轮"接口（X-1 已核验）；`ISession.loadThrough` 只保证加载不保证指认。按契约**宁可不给按钮** | 已定：默认只做内联摘录 |
| **A-6** | `ctx.sessions.get(id)` 能否拿到 `cwd` 用于 `projectKey` | **很可能能**，但工具执行上下文（`exec`）里**没有 sessionId 字段**（F：`base = {token, callId, rootCallId, name, signal, agent?...}`）。取 sessionId 的路径需实现期确认 | 实现期第一步必须解决，否则 AC-8 无从下手（→ §11-Q3） |

### 10.4 H-1 召回率实测结果（2026-11-01，实现期补测）

lead 明确要求给一组"同一事实的不同问法"实测数据，用于判断 AC-1 是否真的达标。
方法与结果如下（可复跑：`ELECTRON_RUN_AS_NODE=1 ".../DeepSeek Harness" test/recall.mjs --top=K`）。

**夹具**：12 条代表性记忆（偏好/约束/项目事实/事件四类措辞）× 48 个语义等价问法，
按难度分三档：easy（含关键词）、medium（部分重叠，换了个说法）、hard（几乎不共享字面）。

| 档位 | 问法数 | top-1 | top-3 | top-5 |
| --- | --- | --- | --- | --- |
| easy | 8 | 75.0% | **100%** | 100% |
| medium | 24 | 66.7% | **95.8%** | 100% |
| hard | 16 | 81.3% | **100%** | 100% |
| **总计** | **48** | **72.9%** | **97.9%** | **100%** |

**关键结论：召回强依赖 top-K。**

- **top-3 达 97.9%**：只要把结果当"候选集"交给模型，AC-1 的"能检索到并体现结论"是成立的。
- **top-1 只有 72.9%**：若实现只取第一条硬塞进回答，约 1/4 的问法会答错题。**因此检索默认返回 top-3~5，不得只取首条**——这条已写进 `memory_search` 的默认 `limit=5`。
- **precision@1 在清晰问题上为 6/6**：说明排序本身没有"把不相关条目排前面"的系统性问题，top-1 的损失主要来自同义不同词导致的**平票**，不是排序机制坏了。

**做过的事（不是靠调夹具凑分）**：初测 top-3 = 81.3%，失败样例集中在三组高频等价词——
「发布↔发版」「热更新↔HMR」「单测↔测试」「依赖↔安装」「命名↔大小写/驼峰」。
加入**受控同义词表**（`shared/retrieval-score.ts` 的 `SYNONYM_GROUPS`，12 组、可审、零延迟）后升到 97.9%。

**诚实的边界**：

1. 同义词表是**有限**的。没列到的换说法仍会 miss（剩 1 个 medium 失败样例就是这种）。
   根治要靠向量通道（§10.3），不在 MVP 内。
2. 这 48 个问法是我自己构造的，**不是用户真实语料**。真实分布的 medium/hard 比例可能更悲观。
3. 因此我的判断是：**AC-1 在"把检索结果交给模型"的形态下达标；在"只取第一条"的形态下不达标**。
   实现按前者（默认 limit=5），并把这条写进交接，避免后续有人为了"省 token"改成 1。

### 10.3 明确不做（本方案范围内）

- 向量/embedding 检索（见 §3.1）。演进位：`ALTER TABLE memories ADD COLUMN embedding BLOB`，不动现有查询。
- 多身份、跨设备、云端（D-1 / W4）。
- 导出/导入（PRD S6，不在 MVP）。
- 程序记忆（OQ-8=A，AC-12 不启用）。

---

## 11. 我认为需要回到文档讨论的点

> 按 PRD §10 第 3 条纪律：不私下放宽，全部列出来。

### Q1 ——【阻塞实现】PE §8.3「两个图标 + Settings 在 236px 下必须不换行」与宿主几何冲突

- **冲突**：宿主既有 occupant（cordis）的入口在宽态是 `flex:none; width:calc(100% + 4px)`，**独占整行**（F-12）。任何"同排"的第二项都会被挤出侧栏并裁切（实测右溢 +244px @280px 宽）。
- **我的提案**：改为**纵向叠放**（记忆入口在插件入口之上，各占整行）。已在 3 档宽度 + 折叠轨下逐项验证通过（§10.2 ⑤）。
- **需要谁定**：designer（这是视觉契约的改动，不是实现细节）。
- **若不同意叠放**：备选是"宽态也只放图标"（不占整行，但与 plugins 图标并列后同样超出 —— 实测 `v2_same_row_split` 仍 overlap）。**同排方案在本宿主上不可行**，这是几何结论不是偏好。

### Q2 ——【需澄清】PE §8.1 的「命中区 ≥44×44」在 56px 折叠轨内无法成立

- **冲突**：轨道可用宽 36px（56 − 2×10）。宿主自家的 Settings 触发器与 cordis 入口也都只有 36×36。
- **我的提案**：44×44 约束**仅适用于宽态**；折叠轨沿用宿主的 36×36（与同排其它控件一致）。理由是"比邻居大"会造成视觉与命中区不一致，反而更差。
- **需要谁定**：designer。注意：**macOS 桌面根本没有折叠轨**（F-9），所以这条只影响 Web GUI / Windows。

### Q3 ——【需确认】工具侧如何拿到 sessionId / 工作目录

- **事实**：工具执行的 `exec` 上下文只有 `{callId, rootCallId, name, signal, agent?}`，**没有 sessionId**（`dsh-tools/lib/index.js:3240` 的 `base` 对象）。
- **影响**：`projectKey`（AC-8 的根基）与 `sourceRef.sessionId`（AC-11）都依赖它。
- **候选路径**（实现期验证，需要时再回文档）：
  1. `exec.agent` → 某个字段拿 session（需核实 `Agent` 是否暴露 `session`）；
  2. `ctx.agents.list()` 找当前活跃 agent；
  3. 由 HTTP 侧注入（但那只能服务面板，不服务对话通道）。
- **不阻塞方案**：数据模型与检索逻辑都不依赖"怎么拿"，只依赖"拿到之后怎么用"。但**实现期第一件事**必须解决。

### Q4 ——【需确认】DC-33 的"写入提示预算"与面板首行数字的关系

- D-5 Q1 已裁定：每会话前 3 次写入给一行轻量提示。同时 **D-8 X-5** 已裁定：侧栏入口与 pane chip 不显示任何角标；面板内 A/B/C 页签计数允许且应当存在（同源渲染）。
- **我的理解**：提示只在对话里出现，面板**不需要**任何"本次会话新增"的展示。方案按此实现。
- 若 designer 期望面板里也有会话级新增统计，需要新契约（当前 PC-01~PC-40 里没有），我不擅自加。

### Q5 ——【提示】契约里的"236px"是旧常量，建议全文档统一

- `panel-entry.md` §8.3 与 `panel-memory.md` §8.7 都写了 236px。宿主实际是 **264–420，默认 280**。
- 这属于文档事实性笔误，不影响契约语义，但会让测试按错误宽度写用例。**建议 designer 统一为 264/280/420**。

---

## 12. 自测计划（实现期的验收证据怎么产出）

> 本版**未执行**（无实现代码）。这里只定方法，确保实现期"可复现"。

### 12.1 硬约束 → 可自动化的检查

| # | 硬约束 | 检查方式 |
| --- | --- | --- |
| HC-1 | 无类型枚举字段 | `grep -nE '\b(kind|category|tag|type|label)\b' src/host/db/schema.ts src/shared/contract.ts` 必须**只**命中 `sourceType`（且 `sourceType` 是来源可信度，不是分类）；DDL 中无类型列 |
| HC-2 | 无衰减状态 | `STATUS` 数组里不含 `decayed`/`faded`；`decayFactor` 为纯函数（无 `UPDATE` 语句） |
| HC-3 | 无第四视图 | 面板页签断言 = 3；`listing` 只有 `listA/listB/listC` 三个导出 |
| HC-4 | 检索候选集 ≡ {active}（I-2） | 造 5 状态各一条，用只出现在非 active 条目里的词检索 → 必须 0 命中；且返回集 ⊆ active |
| HC-5 | 面板不是写入入口 | 面板组件树里无"新建"；HTTP 路由表无 `POST /api/memory/create` |
| HC-6 | 不得手动改分层 | `manage.edit()` 入参类型不含 `layer`；`tsc` 编译期保证（写一个 `// @ts-expect-error` 负向用例） |
| HC-7 | 禁止无响应按钮 | 详情抽屉里"在对话中定位"**不渲染**（A-5） |
| HC-8 | 无会话不做第二渲染面 | ~~无 `main` 整页注册~~ **已被 D-14 修订**：面板只剩 `main` 一套渲染面（右栏已整套移除），无会话时在面板内走 D-0 提示 |
| HC-9 | 破坏性操作回显 + 二次确认 | `hardDelete` 需 `confirm` token；测试断言无 token 时抛错 |
| **HC-10** | **天数文案与实际行为一致（D-8 X-4）** | `grep -rn '30 天\|30天' src/client/` 的每一处，都必须能被 `retention_days` 的当前值解释；若配置为 `null`，grep 结果必须为 0。测试：把 `retention_days` 设为 null 后跑 UI 文案快照 → 不得出现任何天数 |
| **HC-11** | **「忘掉」不得触发硬删（D-8 X-1）** | 单测直接调 `decideDeleteTier('忘掉第 3 条','single')==='soft'`、`decideDeleteTier('忘掉关于 X 的全部记忆','batch')==='soft'`；只有含"彻底/永久/不要留副本"才 `'hard'` |
| **HC-12** | **折叠按全清单口径（D-8 X-3）** | 两通道各造"语义 4 条过期 + 情景 4 条过期" → 两边**都必须折叠**（全清单 8 > 5）；若任一通道不折叠即失败 |
| **HC-13** | **「别记」走软删且标注原因（D-8 X-6）** | 断言目标条目 `status='deleted_soft'`（非 hard）；`memory_changes.reason='user_asked_not_to_keep'`；V-B 该行 `removeReason === '因用户要求不保留'` |
| **HC-14** | **入口与 chip 无角标，页签计数存在（D-8 X-5）** | 入口 DOM 内无角标元素（PE-19）；面板内 A/B/C 页签**有**计数且等于 `countVisible` 的返回 |

### 12.2 交付要求的 7 项证据（AC-1/2/3/5/6、DC-10、I-2）

| 用例 | 步骤 | 断言 |
| --- | --- | --- |
| **AC-1 跨会话** | 会话 A 写"发版必须先跑 pnpm build" → 换新会话 B 检索"发版要注意什么" | B 的检索结果含该条；且**未提及时不出现在上下文**（验证不常驻） |
| **AC-2 改偏好** | 有"用 pnpm" → 同会话说"以后用 npm" | 旧条 `superseded`、新条 `active`；同会话再检索只返回 npm；新会话仍 npm |
| **AC-3 冲突覆盖** | 有"测试命令是 jest" → 说"测试命令是 vitest" | 检索**只返回一个**结果（vitest）；V-C 能查到 jest 的正反面信息 + 时间 |
| **AC-3b 否定极性**（H-3 专项） | 有"别自动改版本号" → 说"版本号可以自动改" | 必须判 conflict（不能落成两条 active 同时被返回） |
| **AC-5 隐私删除**<br>（**D-8 X-9**） | 目标必须是**非凭据**内容（如"家里 WiFi 名"），且触发词必须含**显式不可逆措辞**：说「**彻底删除**刚才说的那个 WiFi 名」→ 走二次确认 → 硬删。若只说「忘掉」会落到软删档（X-1），**验不到硬删路径** | §D-4 C-3/C-5 口径：V-A 消失、V-B **不存在**（硬删）、检索 0、V-C 无正文、audit 只有"发生过 1 次"无标识无正文。**负向**：追问来源必须失败且不泄露内容 |
| **AC-5-soft 对照**<br>（**D-8 X-1**） | 同一目标，改说「**忘掉**那个 WiFi 名」 | 必须是**软删**：V-A 消失、检索 0，但 **V-B 回收站可见且可恢复**。这条与上一条成对，专门抓"把忘掉实现成硬删"的缺陷 |
| **AC-6 记忆可查看** | 造 6 条夹具（2 层 × 2 作用域 × 4 状态）+ 1 软删 | 首行 `共 6 条（4/1/1）`；分页并集无重无漏；空态文案逐字 |
| **DC-10 计数口径**<br>（**D-8 X-2 / X-3**） | 默认 / **筛选态** / 折叠态 / 空态 / 切页签 B | ①默认 `4+1+1=6` ②**筛选后 N = 筛选后集合**且首行**显示当前筛选条件**（未筛选时不显示限定词）③折叠不减小 N 与 c（`4+1+7=12`）④空态 N=0 且文案逐字 ⑤切 B 不覆盖 A ⑥**折叠按全清单合计>5**（构造 2 层各 4 条过期 → 必须折叠） |
| **I-2 候选集** | 5 状态各一条，轮换 10 个查询词 | 每次返回集 ⊆ `{active}`，且非 active 独有关键词必 0 命中 |

### 12.3 U-4（已在方案阶段执行）

| 脚本 | 产物 | 状态 |
| --- | --- | --- |
| `src/test/extract-host-css.mjs` | `src/test/fixtures/host-entry.css`（宿主 CSS 原样拷贝） | ✅ 已跑，产物已生成 |
| `src/test/u4-entry-metrics.mjs` | `src/test/u4-entry-metrics.txt`（3 规格 × 3 宽度 + 折叠轨） | ✅ 已跑，43/60（**失败项全部指向 §11-Q1/Q2 的契约冲突**，非实现缺陷） |
| `src/test/u4-baseline.mjs` | `src/test/u4-baseline.txt`（仅宿主 occupant 的基线） | ✅ 已跑，用于区分"宿主既有全出血"与"我方引入的溢出" |

**运行环境约定**：U-4 脚本需要 `/Applications/Microsoft Edge.app`（本机有）；记忆相关的自测**必须用宿主运行时**跑（`ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"`），因为系统 node 没有 FTS5（F-13）。

### 12.4 测试执行顺序

```
1. 单元（domain 纯函数）：状态机 9 转换、计数口径、衰减纯函数、拒写分类
2. 集成（Host + SQLite，宿主运行时）：写入管线、检索、6 类管理操作
3. 契约（DC/PC/PE 逐条）：DC-01~36、PC-01~40、PE-01~20
4. 双通道（S-1~S-5）：面板改 → 对话查；对话删 → 面板查
5. 非功能：500 次检索取样（P95）、1 万条容量、审计不含正文的 grep
6. 视觉/像素：U-4 脚本 + 面板容器断点 W1/W2/W3
```

---

## 13. 选型落地证明（已搭的脚手架）

按 lead 指令，`src/` 下的**工程脚手架保留**，作为"选型可落地"的证明；**业务实现暂缓**。

| 已就位 | 说明 | 证明什么 |
| --- | --- | --- |
| `src/package.json` | 双声明：`dsh.bundle.patch`（Host 侧）+ `dsh.client`（浏览器侧，`platform: web`） | 一个包能同时提供工具、HTTP 与面板——已在本机 `@clinexin/dsh-kb` 上验证同形态可行（F-14/F-16） |
| `pnpm` + `esbuild@0.25.12` + `react@18` + `typescript@5.7` | 构建链依赖 | bundle 产物形态（`__ModuleLoader__.load`）与宿主共享模块表匹配（F-15/F-16） |
| `src/test/extract-host-css.mjs` | 从安装产物抽 CSS | 宿主契约可被程序化读取，方案里的几何结论都可复算 |
| `src/test/u4-*.mjs` | 像素测量 | U-4 已给出结论（§10.2） |

**尚未创建**（待方案确认后）：`src/host/`、`src/client/`、`src/shared/` 的业务代码、`cordis.patch.yml`、`build.mjs`。

---

## 15. 实现记录与自测证据（D-10 放行后）

> 本节记录**实际交付的代码与实测数据**，与前 14 节的"方案"区分开。
> 凡此处的数字都是跑出来的，不是推算的。

### 15.1 交付物

| 路径 | 内容 |
| --- | --- |
| `src/shared/` | 契约类型、**计数口径唯一实现**（counting）、**档位判定唯一实现**（delete-tier）、切词与精排 |
| `src/host/db/` | DDL、DAO、FTS 显式同步、事务 |
| `src/host/domain/` | 状态机（9 转换）、写入管线、检索（I-2 唯一入口）、管理操作、三视图、服务门面 |
| `src/host/http/` | `/api/memory/*` 薄路由（12 条，**无 create**） |
| `src/host/tools/` | 4 个模型可见工具 + 对话清单渲染 |
| `src/host/index.ts` | Cordis 插件入口（工具 + 动态挂 webServer + 后台扫描） |
| `src/client/` | 入口、面板（3 页签）、turnTail、transport、样式 |
| `src/build.mjs` | esbuild → `lib/client.js`（`__ModuleLoader__` 壳，61.6 KB） |
| `src/test/` | 全部自测（见 §15.3） |

### 15.2 关键实测数据（**取代 §10.2 的推算**）

| 项 | 方案推算 | **实测** | 结论 |
| --- | --- | --- | --- |
| **H-4 检索 P95 @ 1 万条** | ≈80ms | **21.18ms**（P50 18.71 / P99 22.05 / max 23.37） | AC-10 达标，余量 14× |
| **H-1 召回率 top-3** | 不确定 | **97.9%**（48 问法） | 见 §10.4 |
| **H-1 召回率 top-1** | — | **72.9%** | ⚠ 只取首条会答错 1/4，**默认 limit=5** |
| FTS5 可用性 | 假设可用 | **宿主运行时可用**（系统 node 不可用） | 自测必须用宿主运行时 |

**性能优化过程中发现并修掉的三个真实缺陷**（不是预先设计的）：

| 缺陷 | 症状 | 修复 |
| --- | --- | --- |
| `candidates()` 逐行 `getById` | N+1 查询，5000 条候选时 129ms | 直接映射 `dao.toMemory`，降到 41ms |
| 同义词变体逐个查 FTS | 16 次全表 MATCH（~40ms） | 合并成一次 OR 表达式（3ms） |
| 精排对全部候选分词 | 5000 条 × 分词 | 预计算 `tokens` 列；精排只跑前 200 条候选池 |

> 这三条共同把 P95 从 **120ms 降到 21ms**。写在这里是因为它们说明
> §8.1 的预算分解**低估了"逐条分词"的成本**——方案里写的是"精排 15ms"，
> 实际若不做候选池限制就是 80ms+。

### 15.3 自测命令（O-7：可复跑，不是结论）

**必须用宿主运行时**（系统 node v23 的 `node:sqlite` 没有 FTS5）：

```bash
cd src

# 一条命令跑完全部（6 段）
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  test/verify-all.mjs

# 或分段跑
ELECTRON_RUN_AS_NODE=1 "..." test/run-all.mjs     # 单元+集成+HC-1~14（42 项）
ELECTRON_RUN_AS_NODE=1 "..." test/smoke.mjs       # O-1 就绪自证
ELECTRON_RUN_AS_NODE=1 "..." test/panel-render.mjs # O-9 面板 DOM（37 项）
ELECTRON_RUN_AS_NODE=1 "..." test/recall.mjs      # H-1 召回率
ELECTRON_RUN_AS_NODE=1 "..." test/perf.mjs        # H-4 性能
node test/u4-entry-metrics.mjs                    # U-4 像素（用 Edge headless，系统 node 即可）

# 类型检查
pnpm run typecheck
```

### 15.4 自测结果（2026-11-01）

| 段 | 结果 |
| --- | --- |
| 单元+集成+硬约束 | **42/42 通过**（含 HC-1~HC-14、AC-1/2/3/5/6、DC-10、I-2、S-1~S-5） |
| smoke（O-1） | **12/12 通过**，末尾输出「记忆系统已就绪 ✅」 |
| 面板 DOM（O-9） | **37/37 通过** |
| H-1 召回 | 97.9%（top-3） |
| H-4 性能 | P95 21.18ms（1 万条 / 500 次） |
| U-4 像素 | 43/60（**失败项见 §15.6**） |

### 15.5 Q3 结论（lead 要求的首要验证项）

**成立，无需回文档。** 工具侧取 sessionId 与工作目录的确定路径：

| 需要 | 路径 | 依据 |
| --- | --- | --- |
| `sessionId` | `exec.agent.session.id` | `dsh-agent/lib/index.js:515` 既有用法 |
| `projectKey` | `ctx.workingDirectory.get(exec.agent.session)` | `dsh-working-directory` 的 `WorkingDirectoryService.get()`，源码注释明写「without filesystem I/O」；需校验存在性时用 `ensure(agent, signal)`（`dsh-tool-bash:664`、`dsh-agent-instructions:1244` 同做法） |

**fail-closed 边界**（未新增契约，只是异常路径）：`exec.agent` 是 optional，
缺失时**不写项目级、不做项目级检索**（只允许 user 级）——拿不到 projectKey 就无从判定 AC-8 的隔离边界，宁可少记不串味。已实现在 `resolveScope()`。

### 15.6 U-4 真机确认：**部分完成，如实标注**

| 项 | 状态 |
| --- | --- |
| 宿主 CSS + 真机宽度常量的布局测量 | ✅ 已完成（60 条断言，`test/u4-entry-metrics.txt`） |
| D-9 Q1 纵向叠放（`order:-1` / 44px / 18px 图标 / 264·280·420 三档） | ✅ 全部 PASS |
| D-9 Q2 折叠轨 36×36 | ✅ 按裁定实现；U-4 脚本里 "≥44×44" 一条 FAIL 是**预期**（D-9 Q2 已裁定该档为 36×36，脚本断言未随之更新） |
| **运行中 Electron 窗口的真实截图** | ❌ **未完成**。`dsh web` 需临时令牌，自动化拿不到；`screencapture` 在本会话被系统权限拒绝（`could not create image from display`）。**需人眼看一次** |

**因此本节不宣称"真机像素已验证"**。可宣称的是：几何结论（同排不可行、44×44 在 36px 轨不可达、macOS 无折叠轨）有源码 + 算术双重依据，与是否截图无关。

### 15.7 实现中发现、需要回文档的点

| # | 发现 | 我的处理 | 需要谁 |
| --- | --- | --- | --- |
| I-1 | **PE-01 与 D-9 Q1 矛盾**：PE-01 原文「`order` 排在插件入口之后」，D-9 裁定「记忆在上」（`order:-1`） | 按 D-9 实现（`order: -1`） | 已在 D-9 回写清单外 → test-engineer 已报为 X-10，**建议 designer 回写 PE-01** |
| I-2 | U-4 断言脚本仍按「≥44×44 全档位」写，与 D-9 Q2 不符 | 保留脚本原样（它测的是设计原稿），在 §15.6 说明该条 FAIL 是预期 | 无需改；若 test-engineer 复用请按 D-9 调整断言 |
| I-3 | 中文"主语+谓词槽位"在实现中不可靠（`用` 会切到 `用户` 里，早期版本导致任意两条同槽位） | 改为**归一化共同前缀 + 否定极性 + token 重叠**三重判据 | 无契约冲突，属实现细化；已写进 `write.ts` 注释 |
| I-4 | 同义词表是 H-1 的**有限**缓解（12 组） | 已实现并有单测；边界写进 §10.4 | 若后续要覆盖更多，需产品判断优先级 |

## 16. 设置项落到界面 + 自动召回注入（v3 增量）

用户要求：「开发设置到界面上，并且增加记忆召回功能」。落地范围 = **设置抽屉** + **可开关的自动召回注入**。

### 16.1 设置的唯一规格表（`src/shared/settings.ts`）

设置项的键、类型、范围、文案以前只存在于三处各自的实现里（schema 播种、读写、面板控件），改一处就会漂。现在收成一张表：

| 键 | 类型 | 范围 | 作用 |
| --- | --- | --- | --- |
| `enabled` | flag | — | 总开关：关闭后不写入、不检索、面板不可查 |
| `prompt_writes` | flag | — | 写入成功是否追加提示行 |
| `write_prompt_budget` | integer | 1–20 | 每会话前 N 次写入各提示一行 |
| `retention_days` | nullable-integer | 1–365 / `null` | 回收站保留天数；`null` = 永不清空 |
| `episodic_retention_days` | integer | 1–3650 | 情景层转「已过期」的天数 |
| `decay_window_days` | integer | 1–3650 | 情景层**检索排序**衰减窗口（不改状态） |
| `recall_inject` | flag | — | **新增**：自动召回注入开关，默认 `0` |

三处共用同一份规格：面板按 `SETTING_SPECS` 渲染控件、HTTP 按 `normalizeSetting()` 校验、Host 按同一函数归一化后落库。**未知键一律拒绝**（设置表不接受「顺手多存一个」的键）。

写入语义：**全有或全无**。`applySettings(values)` 先全量校验，任一不合法就直接抛错、一条都不落库；校验通过才在 `transact()` 里逐条 `setSetting`。理由：部分成功会让「界面上的控件值」与「库里的真值」不一致，比直接报错更难排查。HTTP 侧把校验失败映射为 **400**（调用方的错），不混进 500。

### 16.2 设置落到界面：页头入口 + 抽屉，不是第四个页签

面板页签**恰三个**是 PC-01 / HC-3 的硬约束（`role="tab"` 计数有断言）。设置改的是「插件怎么工作」，不是「记忆长什么样」，混进视图会让「看记忆」与「配记忆」在同一视觉层级打架。因此：

- 页头 `.mem-head` 右侧一个「设置」按钮（`data-testid="mem-settings-open"`）；**正常态与「记忆已关闭」态都有** —— 否则关掉之后在面板上就没路把它打开。
- 抽屉（`.mem-settings`，640px）内：7 行设置（flag → 复选框、integer → 数字框 + 单位、nullable → 数字框 + 「不过期」复选框禁用切换）+ 每行一句「改了会发生什么」+ 召回预览区 + 保存/关闭。
- **召回预览与真实注入共用 `formatRecallText()`**：预览看到的就是会注入的，不存在两套渲染。

### 16.3 自动召回注入（`src/host/domain/recall.ts`）

机制：注册宿主的 runtime-context 段，由宿主在**每次组装请求时**求值：

```ts
ctx.inject(['systemPrompt', 'agents', 'workingDirectory'], (scope) => {
  ctx.effect(() => scope.systemPrompt.context({
    name: 'dsh-memory:recall', order: 130, required: false,
    text: () => recallTextForScope(scope, service),
  }), 'agent-memory: recall context')
})
```

| 项 | 取值与理由 |
| --- | --- |
| 顺序位 | `130`。宿主既有：WORKING_DIRECTORY 100 → SANDBOX_POLICY 110 → APPROVAL_POLICY 115 → SUBAGENT_DELEGATION 120 → TEAM_IDENTITY 125 → HARNESS_SOURCE 200。放在「身份/策略之后、工具与界面之前」 |
| 段名 | `dsh-memory:recall`。宿主用它做快照 diff，改名 = 让旧快照失效一次 |
| 条数 | 至多 3 条（top-3 才有 97.9% 召回，见 §10.4） |
| 长度 | 单条正文截断 120 字；整段上限 900 字 |
| 空命中 | 返回**空串**，不是「没有相关记忆」的噪音段 |
| 注入文本 | 标题 + 逐条「序号. 正文（语义/情景·项目级/用户级，日期 事件短语）」+ 一行「无关就忽略，不要复述这行说明」 |

**本轮输入从哪来**：宿主的 `AssembleContext` 只有 `{ scope, signal }`，**拿不到用户这一轮说了什么**。所以改用 `agents.currentInitiator()?.session.deriveMessages()` 倒着找最后一条 `role === 'user' && source.kind === 'user'` 的文本消息；纯附件/纯空白不算输入（空串检索会得到任意 top-3）。

**三道关，任一不满足就不注入**：

1. `service.autoRecallEnabled()` = `enabled && recall_inject`。关闭记忆时**永不注入** —— 否则「关闭后没有可查的记忆」这句话不成立。
2. 取得到本轮用户输入（拿不到会话 / 子 agent / headless → 不注入）。
3. 检索 `degraded === false`。超时/出错的检索可能缺条目，注入「半份记忆」比不注入更容易误导。

**与 R-3.5.1「按需检索，不常驻上下文」的关系**：这是**用户显式打开**的例外，默认关闭（`recall_inject=0`），且只注入本轮输入召回得到的 top-3，不是全量记忆、不改 system prompt 本体。TC-AC1-02 的负向断言仍然成立：默认配置下上下文里不出现任何记忆内容。

**边界（未在运行中宿主里验证的部分）**：快照是否每轮真的追加、空串是否被宿主过滤，只能靠上面的公开 API 契约推断。拿不到内容时返回空串是**故意的 fail-closed**：宁可少注入，不注入错内容。

### 16.4 顺手修掉的接线缺口：`decay_window_days` 之前是摆设

`decay_window_days` 只在 schema 里播种，**代码从不读**——90 天硬编码在 `retrieval-score.ts` 的 `decayFactor()` 里。这会让面板上那一项「改了没反应」。现在：

- `rerankScore(row, tokens, now, windowDays = 90)` 新增第 4 参数；
- `retrieve.ts` 的 `RetrieveContext.decayWindowDays` 传给两处精排调用；
- `service.retrieve()` 传 `getNumber('decay_window_days', 90)`。

自测 `SET-decay` 用两条内容完全相同、仅「多久没被确认」不同的情景条目断言：窗口 1 天 vs 3650 天，老条目分数必须差出显著倍数；同一窗口下新条目必须排在前面；语义层分数**不得**随窗口变化（I-4）。

### 16.5 自测证据（2026-11-02）

| 段 | 结果 |
| --- | --- |
| 单元+集成+硬约束（`run-all`） | **78/78**（新增 `SET-validate` / `SET-specs` / `SET-snapshot` / `SET-atomic` / `SET-apply` / `SET-decay` / `RECALL-format` / `RECALL-preview` / `RECALL-scope` / `RECALL-register` / `SET-http` / `SET-no-create`） |
| 面板 DOM（`panel-render`） | **54/54**（新增 14 条：页头入口、抽屉关闭不渲染、7 行齐全、召回预览、无新建/编辑入口） |
| 测试侧门禁（`tests/gate.mjs`） | 105 + 12 全通过 |
| `verify-all` | 6/6 段 |

## 14. 变更记录

| 版本 | 日期 | 变更 | 作者 |
| --- | --- | --- | --- |
| v1 | 2026-11-01 | 首版技术方案：10 节主结构（架构/数据/存储/检索/写入/状态机/双通道/性能/可观测性/事实与假设）；U-4 完成实测并**发现 4 条设计契约与宿主几何冲突**（侧栏宽 236→280、同排不可行、折叠轨 44×44 不可达、macOS 无折叠轨）；提出 5 个需回文档讨论的点（Q1 阻塞）；不含实现代码 | fullstack-engineer |
| v1.1 | 2026-11-01 | **按 D-8（X-1~X-9）改写**：新增 §6.2.1 删除档位判定（X-1：忘掉=软删，唯一实现 `decideDeleteTier`）、§7.5 计数口径区分未筛选/筛选态并强制首行回显筛选条件（X-2）、§7.6 折叠阈值改为全清单口径（X-3）、§3.4 明确选择「实现 30 天清理」使天数文案成立（X-4）、入口/pane chip 无角标 vs 面板页签计数（X-5）、「别记」软删+`user_asked_not_to_keep` 标注（X-6）、新增 §7.8 五要素标注与 DC-12 适用范围（X-7/X-8）、AC-5 用例改非凭据目标+显式不可逆措辞并增 AC-5-soft 对照（X-9）、新增 §7.7 九条落点对照表、HC-10~HC-14 自检项 | fullstack-engineer |
| v2 | 2026-11-01 | **实现落地（D-10 放行）**：新增 §15 实现记录与自测证据；完成 Q3 验证（`exec.agent.session.id` + `ctx.workingDirectory.get()`）；H-4 实测 P95 **21.18ms**（原推算 80ms）；H-1 实测 top-3 **97.9%** / top-1 **72.9%**（新增 §10.4）；修掉三个性能缺陷（N+1 查询、16 次 FTS MATCH、全量分词），P95 从 120ms 降到 21ms；U-4 真机截图**仍未完成**（权限受限），已如实标注 §15.6 | fullstack-engineer |
| v3 | 2026-11-02 | **设置落到界面 + 自动召回注入**（用户要求）：新增 §16；`src/shared/settings.ts` 成为设置唯一规格表（7 项，含新增 `recall_inject`）；面板页头「设置」抽屉（不新增页签，PC-01 / HC-3 仍成立），带召回预览；`SystemPrompt.context` 注册顺序位 130 的 `dsh-memory:recall` 段，**默认关闭**，三道关（开关 / 本轮输入 / 降级）；顺手修掉 `decay_window_days` 「只播种不读取」的接线缺口；`POST /api/memory/settings` 校验失败改报 **400**；自测 78/78 + 面板 54/54 | fullstack-engineer |
