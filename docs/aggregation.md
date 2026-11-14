# 事件聚合设计

Route 可以配置 `aggregation`：匹配的事件不再逐条投递，而是归入聚合组，到期后发出一条汇总。规则可以选用内置预设，也可以在控制台中完整自定义。

## 问题

`relay-events-1794692787134.json` 中，一次 `push`（cursor 26）在 20 分钟内连锁产生了 35 条 GitHub 事件（cursor 26~61，不含 Apple 的 cursor 48）：

| 相对 push | 事件 | 说明 |
| --- | --- | --- |
| +0s | push | 唯一真正有信息量的起点 |
| +4~7s | workflow_run.requested / in_progress、workflow_job.queued / in_progress、check_run.created | 第一个 job 开始 |
| +582~588s | 1 个 job 结束，3 个 job 排队并开始，对应 3 个 check_run.created | 第二阶段 |
| +823s、+955s | 两个 job 结束 | |
| +1200~1203s | deploy job、deployment.created、deployment_status | 部署 |
| +1222~1223s | 最后一个 job、workflow_run.completed、check_suite.completed、deployment_status | 结束；deployment_status 比 workflow_run.completed 晚 1 秒 |

逐条转发的问题：

1. **同一事实重复**：`check_run.*` 与 `workflow_job.*` 描述同一个 Actions job；`check_suite.completed` 与 `workflow_run.completed` 描述同一次运行。
2. **中间态是噪音**：`queued → in_progress → completed` 对接收者有意义的只有最后一步。
3. **事件成簇到达，簇间隔很长**（582s、235s、245s）。固定时间窗（例如 30s 防抖）仍会切成 6~7 条消息，不能只靠时间窗。
4. **结束后还有尾巴**：结束标志之后 1 秒仍有 `deployment_status.created`。

飞书自定义机器人 Webhook（`/open-apis/bot/v2/hook/...`）只能发送，不能更新已发出的卡片，因此不能“先发一张卡片再原地刷新”，只能**缓冲后发一次**，需要时附加阶段提醒。

## 模型：Binding → Slot → Container

聚合把一组事件**归并**成一个结构化视图，再交给布局渲染：

```
事件流 ──Binding──▶ Slot（带 Reducer） ──引用──▶ Container（布局）
                         │
                         └──读取──▶ Close（结束条件）
```

| 概念 | 回答的问题 | 示例（提交流水线） |
| --- | --- | --- |
| **Group** | 哪些事件属于同一组 | 匹配 push / workflow_* / check_* / deployment*，分组键为 head sha |
| **Slot** | 组里保留哪些数据，多条事件写同一个 Slot 时怎么合并 | `commit`（first）、`jobs`（keyed）、`runs`（keyed）、`deploys`（keyed）、`result`（derive） |
| **Binding** | 某类事件把哪些字段写进哪个 Slot | `workflow_job.*` 以 `/workflow_job/id` 为键写入 `jobs` |
| **Close** | 什么时候发出 | `runs` 全部 completed 后静默 20s；空闲 90s；最长 2h |
| **Container** | 消息长什么样 | 标题、提交信息、job 列表（重复行）、部署状态、链接 |

Container 只引用 Slot 名，不直接读事件。因此结束条件与布局无关；同一组 Slot 换目标平台只需换 Container；编辑器可以完全表单化。

### 分组

```jsonc
"group": {
  "match": ["push", "workflow_run.*", "workflow_job.*", "check_run.*", "check_suite.*", "deployment.*", "deployment_status.*"],
  "key": ["/after", "/workflow_run/head_sha", "/workflow_job/head_sha", "/check_suite/head_sha", "/check_run/head_sha", "/deployment/sha"]
}
```

- `match` 支持 `*` 和 `前缀.*` 通配，只能匹配事件目录中已有的类型。
- `key` 是字段路径列表，按顺序取第一个非空的字符串或数字。组的唯一性为 `(route, rule, key)`。取不到键时，事件交给下一条规则，都没命中则照常单条发送。
- 匹配进组但不写任何 Slot 的事件（例如 `check_suite.*`）只更新事件数和最后事件时间（影响静默计时），不会出现在消息里。

### Slot 与 Reducer

| Reducer | 行为 | 模板中的值 |
| --- | --- | --- |
| `first` | 只保留第一次写入 | 对象，未写入时为 `none` |
| `last` | 每次合并，非空字段覆盖旧值 | 对象，未写入时为 `none` |
| `keyed` | 按 Binding 的键 upsert，合并规则同 `last`，`state` 字段的变化记入历史 | 列表 |
| `append` | 每次写入追加一项，只保留最近 `limit` 项（默认 50，1–200） | 列表 |
| `count` | 只计数匹配的事件，不保存内容，Binding 不能映射字段 | 数字 |
| `derive` | 由其他 Slot 计算，不绑定事件 | 标量 |

`derive` 目前只有 `worst`：在 `of` 列出的 `slot.field` 中取最严重的结果，严重程度依次为 failure、error、timed_out、startup_failure、cancelled、action_required、stale、success、neutral、skipped，列表外的值（例如 in_progress）忽略。

```jsonc
"result": { "reduce": "derive", "op": "worst", "of": ["jobs.result", "runs.result", "deploys.state"] }
```

`keyed` 可以声明 `final`：项的 `state` 进入其中某个值之后，后续事件不能再把它改回去，其他字段照常合并。GitHub 不保证投递顺序，晚到的 `in_progress` 否则会把已完成的 run 重新打开，组只能等到 `max_wait`。

列表中每一项是 Binding 映射出的字段，再加上系统字段 `_key`、`_first_seen`、`_last_seen`（接收时间）和 `_history`（`[{state, at}]`）。`_history` 用于渲染 Apple 审核这类状态链。

谓词和区块绑定只能使用有列表项的 Slot（`first`、`last`、`keyed`、`append`）；`count` 与 `derive` 通过模板中的 `slots.*` 读取。

### Binding

```jsonc
"jobs": { "reduce": "keyed", "final": ["completed"], "from": [
  { "event": "workflow_job.*", "key": "/workflow_job/id",
    "map": { "label": "/workflow_job/name", "state": "/workflow_job/status", "result": "/workflow_job/conclusion", "url": "/workflow_job/html_url" } },
  { "event": "check_run.*", "key": "/check_run/id",
    "when": { "pointer": "/check_run/app/slug", "not_in": ["github-actions"] },
    "map": { "label": "/check_run/name", "state": "/check_run/status", "result": "/check_run/conclusion", "url": "/check_run/html_url" } }
]}
```

- 一个 Slot 可以有多个 `from`，一种事件也可以写多个 Slot。
- `keyed` 的 Binding 必须有 `key`，其他 Slot 不能设置；取不到键的事件跳过这个 Binding。
- 字段冲突时后到的非空值覆盖旧值，缺失或为 null 的字段不覆盖。
- `when` 按 `in` / `not_in` 过滤。上例让第三方 check 进入 `jobs`，跳过 Actions 自己的 check_run，因为它与 `workflow_job` 重复。
- 映射值只能是字段路径，格式化放在 Container 中。

### 结束条件

几种条件同时计算，取最早的那个，并记录 `flush_reason`：

| 条件 | 说明 | `flush_reason` |
| --- | --- | --- |
| `when` + `settle` | 谓词成立时，最后一个事件之后静默 `settle` 秒发出；新事件会重新计时 | `settled` |
| `idle` + `pending` | `pending` 不成立时，最后一个事件之后 `idle` 秒发出 | `idle` |
| `max_wait` | 开组之后最长等待时间，到点必发，消息标注“仍在进行” | `max_wait` |
| `max_events` | 事件数达到上限时立即发出，防止超过飞书 20 KB 限制 | `max_events` |

```jsonc
"close": {
  "when": { "slot": "runs", "all": { "state": "completed" } }, "settle": 20,
  "pending": { "slot": "runs", "any": { "state": ["requested", "queued", "in_progress", "waiting", "pending"] } },
  "idle": 90, "max_wait": 7200, "max_events": 200,
  "notices": [...]
}
```

- 谓词结构为 `{ "slot": ..., "all" | "any" | "none": { 字段: 值或值列表 } }` 或 `{ "slot": ..., "exists": true }`，必须且只能设置一种。`all` 要求 Slot 非空。不开放表达式。
- `pending` 必须显式声明。导出数据里第一个 job 跑了约 9.5 分钟，中间没有事件；没有 `pending` 时，`idle: 90` 会在 job 运行期间把组提前发出。
- 时间约束：`settle ≤ idle ≤ max_wait ≤ 24h`，`max_events` 为 1~500，默认 200。

`notices` 是阶段提醒：谓词成立时立即发出一条消息，组保持打开，最终汇总照常发出。

```jsonc
{ "id": "job_failed", "option": "notify_failure",
  "when": { "slot": "jobs", "any": { "result": ["failure", "timed_out", "startup_failure"] } },
  "once_per_item": true, "container": {...} }
```

- 默认每个提醒只发一次。`once_per_item` 要求谓词为 `any`，命中的每一项各发一次，提醒模板里的 `item` 就是这一项。
- `option` 只用于预设，表示由哪个预设开关启用；自定义规则不能设置。

### Container

```jsonc
"container": {
  "title": "{% if slots.commit %}{{ slots.commit.repo | default('', true) }} · ...{% endif %} {{ slots.result | result_icon }}",
  "accent": { "slot": "result", "map": { "success": "green", "failure": "red", "cancelled": "grey", "*": "blue" } },
  "blocks": [
    { "id": "commit",  "kind": "text",   "bind": "commit",  "text": "{{ item.message | default('', true) | first_line }}" },
    { "id": "jobs",    "kind": "repeat", "bind": "jobs",    "text": "{{ item.result | result_icon }} {{ item.label | default('', true) }} · {{ item | duration }}" },
    { "id": "summary", "kind": "text",   "style": "note",   "text": "共 {{ group.event_count }} 条事件 · 耗时 {{ group.span | duration }}" },
    { "id": "run",     "kind": "link",   "bind": "runs",    "text": "{% if item.url %}查看运行{% endif %}", "url": "{{ item.url | default('', true) }}" }
  ]
}
```

- `kind` 为 `text`、`link` 或 `repeat`。`repeat` 必须绑定 `keyed` 或 `append` Slot，对每一项渲染 `text`，按行拼接，`limit` 默认 20，超出时追加“另有 N 项”。
- `text` / `link` 绑定 Slot 时，`item` 是最新一项，Slot 为空时这个区块不渲染。不绑定时，`item` 只在提醒模板中存在。
- 渲染后的区块交给 `message::finish`，与单条消息走同一套收尾：丢弃空文本块、校验链接、调用目标的 `render_content`。飞书适配器不需要改动。`style` 写入 `block_styles`，`accent` 可以固定，也可以按 Slot 值映射（`*` 为默认）。
- 模板变量：`slots.*`、`item`、`group.event_count`、`group.opened_at`、`group.span`（首尾事件时间差，秒）、`group.flush_reason`（提醒中为 none）。
- 新增过滤器：`duration`（秒数，或 item 的 `_last_seen - _first_seen`）、`result_icon`、`first_line`。
- 模板使用 strict 模式，字段可能为 null，所以要写 `| default('', true)`。保存校验会用全为 null 的占位项渲染一遍，提前发现这类问题。

## 预设与自定义

Route 上的 `aggregation` 与 `message_policy` 并列：

```jsonc
"aggregation": {
  "rules": [
    { "preset": "github.commit_pipeline", "options": { "notify_failure": true } },
    { "id": "my_rule", "name": "…", "group": {...}, "slots": {...}, "close": {...}, "container": {...} }
  ]
}
```

- 每条规则可以引用预设并传入开关（预设升级后自动生效），也可以完整自定义。“复制为自定义”会把预设展开写入 Route。
- 事件按顺序匹配第一条命中的规则；没有命中的事件照常单条发送。
- 预设按来源平台存放在 `src/providers/presets/github_aggregations.json` 与 `apple_aggregations.json`，结构为 `{ id, source_provider, name, description, options, rule }`，开关默认关闭。`/api/meta` 的 `aggregation_presets` 返回全部预设。
- 只有路由 `event_types` 选中的事件才会进入聚合。控制台在规则用到的事件不在筛选中时给出提示，并可一键加入。

### 内置预设

| 预设 | 分组键 | 主要 Slot | 结束 | 开关 |
| --- | --- | --- | --- | --- |
| GitHub 提交流水线 `github.commit_pipeline` | head sha | commit、runs、jobs、deploys、result | runs 全部完成 + 静默 20s；无进行中的 run 时空闲 90s；最长 2h | 推送后立即提醒；任务失败立即提醒 |
| GitHub 拉取请求动态 `github.pr_activity` | PR 链接 | pr（last）、changes（append）、reviews（keyed）、comments（append） | 空闲 120s，最长 15min | |
| GitHub Issue 创建 `github.issue_opened` | Issue 链接 | issue、opened、labels、assignees、changes | 空闲 10s，最长 2min | |
| GitHub 版本发布 `github.release` | release id | release（last）、actions（append） | 空闲 60s，最长 10min | |
| GitHub 仓库关注动态 `github.repo_attention` | 仓库 | repo、starred / unstarred / forked / watched（count）、people（append） | 空闲 5min，最长 1h | |
| Apple 版本审核进度 `apple.version_review` | 版本 ID | start（first）、version（keyed，渲染 `_history`） | 进入审核结果后静默 5s；空闲 2min；最长 1h | |
| Apple 构建处理 `apple.build_processing` | 上传 ID | upload（keyed，`final` 为 COMPLETE / FAILED） | 完成或失败后静默 10s；处理中不按空闲发出；空闲 10min；最长 1h | |

拉取请求动态以 `/pull_request/html_url` 或 `/issue/pull_request/html_url` 分组，普通 Issue 下的评论取不到键，会交给后续规则或逐条发送。

用导出数据回放“提交流水线”（`tests/aggregation.rs`）：35 条事件归为一组。+1222s `workflow_run.completed` 使 `runs` 全部完成，+1223s 的 `deployment_status` 重新计时，+1243s 发出一条消息：

```
octo-org/hello-world · main ✅                     （绿色）
feat(deploy): 一键发布到服务器
octocat · 6dcb09b
✅ test · 9m38s
✅ lint · 4m00s
✅ build · 6m13s
✅ docker · 10m17s
✅ deploy · 22s
✅ production · success
共 35 条事件 · 耗时 20m23s                         [查看运行] [查看提交]
```

job 耗时从排队事件算到完成事件，包含排队时间。

### 编辑器

Route 编辑页的“消息聚合”标签页：

1. **规则列表**：从预设或空白规则添加，调整顺序，删除；预设显示开关，可“复制为自定义”展开成完整规则。
2. **分组**：复用 `EventFilter` 选择匹配事件，预设中的 `前缀.*` 作为自定义事件显示；分组键为字段路径列表，输入时提示事件目录中的字段路径。
3. **数据**：每个 Slot 一张卡片，选择归并方式，编辑来源事件、键、条件与字段映射。
4. **结束条件**：完成谓词与静默秒数、进行中谓词、空闲、最长等待和事件上限。
5. **阶段提醒**与**汇总消息**：标题、样式、颜色（固定或按 Slot 值映射）和区块；区块下方列出可用变量，点击插入。
6. **回放最近事件**：调用回放接口，展示“最近 N 条事件 → M 条消息”和每组的卡片预览。

接收与投递记录的详情会显示所属聚合组：等待中的组显示预计发出时间，已发出的组显示原因，并可展开成员事件。

## 代码结构

```
src/aggregation/
  mod.rs       规则类型、预设加载、resolve、classify、validate
  state.rs     GroupState：Binding 写入、Reducer、谓词、due_at、notices、derive
  render.rs    Container 展开为 Content，交给 message::finish
  simulate.rs  虚拟时钟回放，供预览、校验和测试使用
  store.rs     开组、写入成员、发出汇总与提醒，唯一访问数据库的部分
```

除 `store.rs` 外都是纯函数，不访问数据库，也不读系统时钟，`now` 由参数传入：

```rust
pub fn resolve(config: &Value, source_provider: &str) -> Result<Policy>;
impl Policy { pub fn classify(&self, event: &RelayEvent) -> Option<(&Rule, String)>; }
pub fn validate(policy: &Policy, source: &Value, destination: &dyn DestinationAdapter) -> Result<()>;

pub struct GroupState {
    pub slots: BTreeMap<String, Vec<Item>>,  // first / last 最多一项
    pub counts: BTreeMap<String, u64>,       // count Slot
    pub event_count: u32,
    pub opened_at: i64,
    pub last_event_at: i64,
    pub notified: BTreeSet<String>,          // 已发的提醒，避免重复
}
impl GroupState {
    pub fn open(now: i64) -> Self;
    pub fn apply(&mut self, rule: &Rule, event: &RelayEvent, now: i64) -> Vec<Notice>;
    pub fn due_at(&self, rule: &Rule) -> (i64, FlushReason);
}
pub fn render(rule: &Rule, state: &GroupState, reason: FlushReason, destination: &dyn DestinationAdapter) -> Result<Value>;
pub fn render_notice(rule: &Rule, notice: &Notice, state: &GroupState, destination: &dyn DestinationAdapter) -> Result<Value>;
pub fn simulate(policy: &Policy, events: &[(i64, RelayEvent)]) -> Vec<SimGroup>;
```

`validate` 检查引用、谓词和时间约束，再用占位状态（每个 Slot 一项、字段全为 null）渲染汇总和每个提醒。目录里的样例缺少 job id、head sha 等关联字段，不能用来构造真实的组。

为此对现有代码做了两处改动：`template::render_with` / `render_str` 接收任意上下文，并新增三个过滤器；`message::finish` 从单条渲染中拆出，供聚合复用。

调用方：

| 调用方 | 用法 |
| --- | --- |
| `api::receive` | 每条 Route 先 `classify`。命中时调用 `store::attach`：同一键的 open 组若已到期先发出，再开新组；执行 `apply`，写回组状态和 `due_at`；提醒在同一事务中生成立即发送的 delivery。未命中走原有单条渲染路径 |
| `worker::run` | 每轮挑选 delivery 之前调用 `store::flush_due`，持有与接收相同的配置锁，逐个发出到期的组 |
| `POST /api/aggregation/replay` | 从 `events` 表解密原文，用 `event_type` 和接收时间重建事件后调用 `simulate` |
| `config::validate` | 保存 Route 时调用 `resolve` 和 `validate` |

投递入队统一走 `store::queue_delivery`，单条投递、汇总和提醒使用同一套快照与审计。

单条事件消息理论上可以看作“只有一条事件、全部为 `last` Slot 的组”，但现有 274 个 GitHub 模板都直接读 `event.raw`，不做迁移，两条路径并存。

## 存储与执行

迁移 `0004_aggregation.sql` 新增 `aggregates`（`snapshot` 为开组时冻结的规则与投递目标，`group_state` 为序列化的 `GroupState`，二者都加密保存；`group_key` 保存分组键的 SHA-256）和 `aggregate_members`，并重建 `deliveries`：新增 `aggregate_id`，原来的 `UNIQUE(event_id, route_id)` 改为只约束 `aggregate_id IS NULL` 的单条投递，因为同一事件可能既触发提醒又是汇总的最后一个成员。重建在迁移事务中通过 `defer_foreign_keys` 完成，`attempts` 的外键与记录顺序保持不变。

- **事务边界**：事件、组状态、成员关系、提醒投递和审计在同一事务中提交，与现有接收流程一致。
- **delivery 关联**：汇总以最后一个成员事件作为 `event_id`；提醒使用触发它的事件。二者都带 `aggregate_id`，重试、限速和审计沿用原有投递逻辑。
- **晚到事件**：组发出后，同一个键的新事件会开新组。
- **重启**：open 组保存在 SQLite，重启后由 Worker 继续发出；只在发出时生成 delivery，不会重复生成汇总，已开始发送的汇总仍是至少一次投递。
- **配置变更**：组使用开组时冻结的规则与目标，修改或停用 Route 不影响已开的组；停用 Route 时，发出的汇总和其他投递一样暂停。仍有 open 组的 Route 不能删除。
- **审计**：`aggregate.opened`、`aggregate.updated`、`aggregate.flushed`，以及汇总和提醒各自的 `delivery.queued`。

## 取舍

- **为什么不用纯时间窗**：CI 事件成簇、簇间隔几分钟。纯时间窗要么拆成多条，要么为合并把延迟拉到 20 分钟以上。Slot 谓词加短静默可以在流水线结束后约 20s 发出。
- **为什么用 Slot 而不是直接在模板里遍历事件**：模板直接遍历事件时，归并逻辑写在模板里，结束条件无法复用，编辑器只能让用户手写 minijinja，渲染也容易触达 fuel 上限。Slot 把归并收进声明式 Reducer，结束条件、布局和预览都读取同一份数据。
- **为什么聚合挂在 Route 上**：分组语义属于来源，呈现属于目标，Route 同时连接两者。同一来源可以一条 Route 聚合、另一条 Route 逐条发送。
- **为什么路径和谓词不开放表达式**：GitHub 和 Apple 的关联字段都是固定路径；声明式结构可以校验，也能做成表单。确有需要时再引入表达式。
- **不在首版做跨来源关联**：GitHub deploy job 与它触发的 Apple `buildUploadStateUpdated`（cursor 48）没有共同字段，强行关联容易出错。
- **延迟是代价**：聚合消息必然比逐条发送晚，失败场景用阶段提醒补偿。

## 验证

- `tests/aggregation.rs`：用导出数据的时间线回放“提交流水线”（35 → 1、失败提醒只发一次、只有 push 时空闲发出、max_wait 标注仍在进行、晚到的 in_progress 不会重开已完成的 run），各预设通过校验，其他预设的典型事件串各合并为一条。导出没有请求体，夹具 `tests/fixtures/commit_pipeline.json` 保留真实顺序和时间，payload 按 GitHub 各事件的字段补齐。
- `scripts/verify_http.py`：真实 HTTP 下验证自定义规则校验、35 条事件归为一组且只发一条汇总、聚合详情与回放、重启后 open 组照常发出、预设提醒立即发送、有 open 组的 Route 不能删除。
