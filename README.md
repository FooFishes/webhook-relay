# Webhook Relay

消息模板现在按 Source 事件提供完整内置内容。新建转发规则时选择来源和目标即可使用，当前 Apple → 飞书的 13 类事件均有完整预设；可在「消息模板」浏览成品，在规则的「消息模板」工作区按事件自定义内容、变量、卡片/富文本/纯文本及局部展示方式。

本地查看模板界面（使用隔离数据库和真实服务端渲染，不需要凭据，不创建资源或发送通知）：

```bash
cargo build
python3 scripts/preview_templates.py
# 浏览器打开 http://127.0.0.1:5196
```

使用 Rust 和 WebUI 配置通知转发：

```text
Source → 验签与标准化 → Payload 转换 → 持久化队列 → Destination
                       └──────── 审计记录 ────────┘
```

这是一个支持多个来源实例、多个目标实例的 Webhook 转发平台。来源和目标通过适配器接入，规则负责事件筛选、消息转换及投递策略。当前已实现的适配器是 **Apple App Store Connect（来源）** 和 **飞书（目标）**。

采用单实例、自托管部署，Rust 同时提供管理 API、Webhook 接收端和 WebUI 静态文件。

## 能力

- **Source**：来源实例选择一个已注册的来源适配器，每个实例具有独立配置、回调地址和去重范围；同一平台可以创建多个实例。
- **Destination**：目标实例选择一个已注册的目标适配器，独立保存连接和凭据引用；多个来源可以共用一个目标。
- **Key**：独立密钥资源，AES-256-GCM 加密存储，管理 API 不回显已有值。支持替换，留空保留原值。
- **Route**：每条规则连接一个来源实例和一个目标实例，分别配置事件筛选、消息内容和投递次数。一个来源通过多条规则分发到多个目标，各目标独立产生投递任务。
- **Payload**：可视化消息表单、变量插入、服务端预览和严格变量检查。消息类型由目标适配器提供；当前飞书适配器支持文本、富文本、消息卡片、图片和群名片。
- **可靠投递**：原始请求体验签、按来源及事件 ID 去重、事务保存事件和任务、发送结果记录、自动重试、手动重试、重启恢复。
- **Audit**：配置新增/修改/删除、验签失败、格式拒绝、重复事件、任务入队、每次投递、重试及恢复记录。支持筛选、游标分页、导出当前页。
- **WebUI**：Kumo 组件、浅色/深色模式、响应式导航、运行概览、配置搜索与直接启停、关联记录筛选、结构化投递详情和审计查询。配置界面不提供原始 JSON 编辑器。

## 技术选型

| 层次 | 第三方库 | 用途 |
| --- | --- | --- |
| HTTP / 异步 | Axum、Tokio、Tower HTTP | 路由、异步 I/O、请求体限制、静态文件 |
| 数据库 | SQLx、SQLite WAL | 异步查询、版本化迁移、配置与持久化队列 |
| HTTP 客户端 | Reqwest + Rustls | 连接/总超时、禁止重定向、HTTPS 投递 |
| 序列化 / 模板 | Serde、Serde JSON、MiniJinja | 类型边界、JSON 字段模板、渲染工作量限制 |
| 密码学 | RustCrypto AES-GCM、HMAC、SHA-256 | 加密、Apple 验签、飞书签名 |
| 可观测性 | Tracing | JSON 格式服务日志 |
| WebUI | React、TypeScript、Vite | 管理控制台 |
| 组件 / 数据 | Kumo、Tailwind CSS、TanStack Query | 交互组件、语义主题、服务端状态与缓存 |
| 测试 | Rust tests、Vitest、Testing Library、Python 标准库 | 协议测试、组件测试、真实 HTTP 回归 |

实际版本由 `Cargo.lock` 与 `web/pnpm-lock.yaml` 锁定。无需 Redis、额外消息队列或 Node.js 生产服务。

## 本地启动

需要 Rust 1.89+、Node.js 24、Corepack、Python 3.9+。推荐使用当前稳定版 Rust。

```bash
# 在项目根目录
python3 scripts/init_env.py

# 加载生成的环境变量；程序不会自动读取 .env
set -a
. ./.env
set +a

cd web
corepack pnpm install --frozen-lockfile
corepack pnpm build
cd ..
cargo run --locked
```

访问 <http://localhost:8080>，使用 `.env` 中的 `RELAY_ADMIN_TOKEN` 登录。令牌只保存在当前页面内存中，刷新页面后需要重新输入。

`.env` 由初始化脚本以 `0600` 权限创建，已加入 Git 忽略规则。脚本不会覆盖已有文件。

### 前端开发

先启动 Rust 服务，再在另一个终端执行：

```bash
cd web
corepack pnpm dev
```

Vite 将 `/api` 代理到 `http://127.0.0.1:8080`。访问 Vite 输出的地址进行开发。Webhook 直接发送到 Rust 端口。

## Docker 部署

```bash
python3 scripts/init_env.py
# 编辑 .env，将 RELAY_PUBLIC_URL 设置为实际 HTTPS 地址
# 例如 https://relay.example.com
docker compose up -d --build
```

Compose 默认只把 `8080` 映射到宿主机回环地址。通过 Caddy、Nginx 或已有网关提供 HTTPS，然后反向代理到 `127.0.0.1:8080`。若代理也运行在容器中，需要按实际网络结构调整连接方式。

数据保存在 `relay-data` 命名卷，容器以非 root 用户运行。请保持 **一个服务实例对应一个数据库文件**，不要共享 SQLite 文件运行多个副本。

## 配置 Apple → 飞书

1. **密钥**：添加 Apple Webhook Secret、完整飞书机器人 URL，以及可选的飞书签名密钥。每种用途建立独立条目。
2. **来源**：新建 App Store Connect 来源，选择 Apple 验签密钥，保存后复制回调地址：`https://你的域名/hooks/{source_id}`。
3. **目标平台**：新建飞书目标，选择机器人 URL 密钥；若飞书启用了签名校验，同时选择对应的签名密钥。
4. **转发规则**：关联来源和目标，勾选事件类型，使用消息表单编辑内容并设置投递次数。先使用内置示例或实际事件结构预览，再保存启用。
5. **Apple 控制台**：在 Users and Access → Integrations → Webhooks 创建配置，填写回调地址及相同的 Secret，选择 App 和订阅事件。执行测试 Webhook。
6. **查看结果**：先检查接收记录，再检查投递记录中的 HTTP 状态与飞书业务码；验签失败查看审计日志。

如果飞书开启了关键词校验，消息文本必须包含配置的关键词。若使用 IP 白名单，加入服务器实际出口 IP。

Apple 订阅配置使用大写枚举，例如 `APP_STORE_VERSION_APP_VERSION_STATE_UPDATED`；本项目规则过滤使用收到的 `data.type`，例如 `appStoreVersionAppVersionStateUpdated`。两者不可混用。

## WebUI

- **平台与实例**：来源和目标列表按实例管理，展示所属平台，支持按平台筛选。创建实例时选择平台，配置字段来自后端适配器描述；已有实例的平台类型不可更换。
- **规则关联**：来源选项、目标选项均展示实例名称及平台。事件类型和预览示例由来源决定，消息编辑器与默认消息由目标决定。换用其他目标平台前确认消息重置。
- **概览**：过去 24 小时 / 7 天的接收数、投递成功率和趋势；当前队列、暂停任务、失败任务及各规则运行状态。点击失败任务或规则进入对应投递记录。
- **消息编辑**：文本正文；富文本标题、段落、文本、链接、提及和图片；卡片标题、颜色、正文、分隔线及链接按钮。内容可以增删、排序，在光标处插入变量。
- **完整字段表单**：以文字、数字、开关、字段组和列表编辑额外平台属性。编辑常用字段时保留原模板的扩展字段和其他语言内容。
- **配置管理**：按名称和启用状态筛选，直接启停；创建来源或目标时，可以就地新建并选择密钥。
- **记录**：接收记录支持来源和事件类型筛选，投递记录支持状态、规则、目标和关联事件筛选；详情按字段展示，投递尝试单独列出。
- **预览与审计**：只有预览示例、生成结果和审计详情使用原始 JSON。消息预览展示内容结构，不模拟飞书客户端的完整排版。

## Payload 模板

WebUI 使用上述表单生成模板，无需编写 JSON。以下说明适用于模板变量与 API 集成。

模板本身必须是有效 JSON，在**字符串值**中使用 MiniJinja 表达式。各字符串渲染后再由 JSON 序列化器编码，引号、换行和中文不会破坏消息格式。

```json
{
  "msg_type": "text",
  "content": {
    "text": "[App Store Connect] {{ event.source_name }}\n{{ event.event_type }}\n{{ event.summary }}\n事件 ID: {{ event.id }}"
  }
}
```

模板上下文：

| 字段 | 内容 |
| --- | --- |
| `event.id` | Apple 事件 ID |
| `event.event_type` | `data.type` |
| `event.source_name` | 本地配置的来源名称 |
| `event.summary` | 根据 Apple 常见状态字段与关联资源 ID 生成的摘要 |
| `event.raw` | 验签后的原始 JSON 对象 |

可直接引用 `{{ event.raw.data.attributes.newValue }}`；事件字段不保证存在时使用 `{{ event.raw.data.attributes.newValue | default('未知') }}`。不要把 Key 放进模板，签名字段由目标适配器在发送时生成。

模板保存时检查 JSON、语法和基本飞书结构；运行时检查实际字段与渲染结果。缺失字段导致转换失败时，保留事件与失败任务，不会发送不完整消息。修正规则后，应以新的事件 ID 发送新事件；重复原事件不会绕过去重重新生成任务。

完整飞书 Payload（包括签名）最多 20 KB；入站请求体最多 256 KiB。图片和群名片类型要求已有有效 `image_key` / `share_chat_id`，本项目不负责上传图片或查询群信息。

## 投递语义与配置生效范围

- 验签使用**收到的原始字节**，在解析 JSON 前验证 `x-apple-signature: hmacsha256=<hex>`。
- 事件与所有匹配任务在同一事务中保存后，返回 HTTP `202`；重复且正文一致返回 `200`，相同事件 ID 但正文不同返回 `409`。
- 没有匹配规则时，仍保存事件和接收审计，生成零个任务。停用来源时拒绝新请求；停用目标或规则时不为其生成新任务，并暂停相应待投递任务。
- 每个任务保存加密的消息和目标快照。后续更改模板、URL 或密钥只影响新事件；手动重试也使用原快照。已经开始的网络请求可能在停用后完成。
- HTTP 成功且飞书 `code=0` 才标记成功；兼容旧版 `StatusCode=0`。HTTP 200 中的非零业务码仍是失败。
- 网络错误、HTTP 5xx/429 及已识别的飞书限流业务码自动重试；使用指数退避和随机抖动，遵守数字形式的 `Retry-After`，最大等待一小时。其他业务错误直接标记失败。
- 全局发送间隔至少 750ms，首版吞吐量约为每分钟 80 条，保守满足飞书限流，也覆盖多个目标引用同一机器人 URL 的情况。
- **至少一次投递**：如果远端已收到通知、服务却在记录结果前中断，重启后可能重复发送。原尝试标记为 `unknown`，恢复过程写入审计。飞书自定义机器人没有可用于保证严格一次投递的幂等接口。
- 规则中的投递次数包含首次发送；手动重试增加最多五次机会。删除仍被引用或存在未完成任务的配置会返回冲突。

## Audit 与密钥保护

审计记录包含操作者类别（`admin` / `apple` / `system` / `anonymous`）、动作、资源 ID、时间及结构化详情。配置变更保留前后版本和不含密钥的配置元数据；Payload 模板保留 SHA-256 摘要，不把模板正文写入审计。

审计不保存 Authorization、签名头、密钥明文、完整机器人 URL 或上游响应正文。原始事件和投递快照在数据库中加密保存，查询页面展示元数据及状态码。

首版使用单个管理员令牌，不区分不同操作人员；**不是多人账号、RBAC 或合规级不可篡改审计系统**。应用不提供审计修改/删除接口，SQLite 触发器防止意外更新删除，但拥有数据库管理权限的人仍能修改数据库或移除触发器。

默认不自动删除历史记录。部署者应监控磁盘空间并定期备份；按日期自动清理、归档和外部审计存储不在首版范围内。

**请备份主密钥**：`RELAY_MASTER_KEY` 用于解密所有已保存的 Key、原始事件和任务快照，不能直接替换或重新生成，否则旧数据无法恢复。更换管理员令牌只需修改 `RELAY_ADMIN_TOKEN` 并重启。业务密钥可在 WebUI 中替换。

SQLite 使用 WAL。在线备份使用 SQLite backup API 或 `sqlite3 ... '.backup ...'`，不要只复制运行中的 `.db` 文件而遗漏 WAL；也可以停止容器后备份数据卷。数据库备份与主密钥应分别保管。

## 验证

```bash
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked

cd web
corepack pnpm build
corepack pnpm test
corepack pnpm format:check
cd ..

cargo build --locked
python3 scripts/verify_http.py
```

HTTP 验证会启动真实 Rust 进程、临时 SQLite 和本地飞书模拟服务，使用 Python 独立生成/验证签名，检查幂等、重试、错误分类、重启恢复、审计和敏感值不回显。它不会连接真实 Apple 或飞书，也不会修改正式数据库。

Docker 验证可执行 `docker build -t webhook-relay:verify .` 后运行 `python3 scripts/verify_docker.py`，会使用临时容器及数据卷检查启动、权限与重启持久化，结束后自动清理。

生成 `reports/http-verification.html` 与 JSON 报告；报告及运行数据已被 Git 忽略。CI 执行相同验证并上传报告。

## 当前范围

- 首版转发 Apple 事件本身携带的信息。TestFlight 截图/崩溃事件通常只包含关联资源；**尚未使用 `.p8` 凭证调用 App Store Connect API 补充反馈正文、截图或崩溃日志**。
- App Store Server Notifications V2 的订阅、退款和内购 `signedPayload` 属于另一套协议，本项目当前不支持。
- Provider 通过 Rust trait 扩展，首版只有 Apple Source 和 Feishu Destination；不支持任意网络地址的通用 HTTP 目标，也不执行用户脚本。
- 已提供 Docker 构建与 Compose 配置；Docker 镜像在本机完成构建及启动检查；公网 TLS 和真实平台联调需在部署环境验证。

进一步说明见 [架构](docs/architecture.md) 与 [管理 API](docs/api.md)；已执行的检查见 [验证记录](docs/verification.md)。

## 官方参考

- [Apple Webhook 配置与验签](https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications)
- [Apple 事件说明](https://developer.apple.com/documentation/appstoreconnectapi/webhook-events)
- [Apple 事件订阅枚举](https://developer.apple.com/documentation/appstoreconnectapi/webhookeventtype)
- [飞书自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
- [Axum](https://docs.rs/axum/latest/axum/)、[SQLx](https://docs.rs/sqlx/latest/sqlx/)、[MiniJinja](https://docs.rs/minijinja/latest/minijinja/)
- [Kumo](https://github.com/cloudflare/kumo)、[Vite](https://vite.dev/guide/)、[React](https://react.dev/)
