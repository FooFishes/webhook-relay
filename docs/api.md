# 管理 API

除 `/healthz`、`/hooks/{id}` 及旧 Apple 回调路径外，所有接口要求：

```http
Authorization: Bearer <RELAY_ADMIN_TOKEN>
Content-Type: application/json
```

失败通常返回 `{"error":"说明"}`。Axum 的 JSON / Query 提取错误和请求体超限可能返回纯文本及 `400` / `422` / `413`；客户端需要处理非 JSON 错误响应。

## 路由表

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 进程存活检查 |
| GET | `/api/overview` | 完整数据库的运行统计与待处理任务 |
| GET | `/api/meta` | 公网基础地址、Provider 和默认模板 |
| GET | `/api/resources/{kind}` | 列出资源 |
| POST | `/api/resources/{kind}` | 创建资源 |
| PUT | `/api/resources/{kind}/{id}` | 更新资源，必须提供旧 `revision` |
| DELETE | `/api/resources/{kind}/{id}` | 删除无引用、无未完成任务的资源 |
| POST | `/api/preview` | 转换示例，返回预览；不发出通知 |
| GET | `/api/events` | 已验签事件元数据 |
| GET | `/api/deliveries` | 投递任务，不返回快照或密钥 |
| GET | `/api/deliveries/{id}/attempts` | 最近 200 次发送尝试 |
| POST | `/api/deliveries/{id}/retry` | 对失败任务增加最多五次投递机会 |
| GET | `/api/audit` | 审计记录 |
| POST | `/hooks/{source_id}` | 按来源实例的适配器接收请求 |
| POST | `/hooks/apple/{source_id}` | 兼容原有 Apple 回调地址 |

## 平台能力与实例

`GET /api/meta` 返回：

- `public_url`：生成实例回调地址的基础 URL。
- `source_providers`：已注册来源适配器列表，每项包含 `id`、`name`、`category`、`fields`、`defaults`、`event_types`、`sample`。
- `destination_providers`：已注册目标适配器列表，每项包含 `id`、`name`、`category`、`fields`、`defaults`、`editor`、`message_types`、`default_template`。
- `default_template`：兼容旧客户端的飞书默认模板；新客户端使用所选目标适配器自己的默认模板。

字段描述含 `key`、`label`、`type`、`required`，可带 `role`；当前字段类型 `secret` 表示配置中保存 Key 资源 ID。类型选择写入实例的 `config.provider`，同一类型允许创建多个实例。更新已有实例时不能更换 provider。

来源实例之间的事件去重独立。每条规则连接一个来源和一个目标；多条规则支持分发和共用目标，任务与重试独立。

## 运行概览

`GET /api/overview?hours=24`，支持 `24`（默认）和 `168`，其他值返回 400。

返回字段：

| 字段 | 统计口径 |
| --- | --- |
| `window` | `since`、`until`（Unix 秒）及 `hours` |
| `received` | 时间范围内接收并保存的事件数 |
| `succeeded` / `failed` | 当前处于对应结束状态，且最近更新时间在范围内的任务数 |
| `success_rate` | `succeeded / (succeeded + failed) × 100`；没有结束任务时为 `null` |
| `queue` | 所有时间的 `pending`、`retrying`、`sending` 数量；`paused` 是规则或目标停用/缺失造成的待处理任务子集 |
| `attention_failed` | 所有时间的当前失败任务数 |
| `series` | 24 个小时区间或 7 个日区间，每项含 `start`、`events`、`succeeded`、`failed` |
| `routes` | 每条规则的名称、来源/目标名称与启用状态、当前队列数、失败数、最近任务更新时间 |
| `recent_failed` | 最近更新的 8 条失败任务 |
| `recent_events` | 最近接收的 8 条事件及关联投递数 |

所有查询在同一个只读事务中完成，统计不受列表分页限制。时间区间以请求时刻向前计算。任务手动重试后进入队列，暂时不计入结束状态；这些统计描述任务当前结果，不是历史发送尝试次数。暂停数已包含在 `pending` / `retrying` 中，计算队列总量时不要重复相加。

## 资源请求与响应

### 内置事件消息与可视化自定义

新规则默认使用完整的内置事件消息。连接 Source、Destination 并设置事件范围即可使用，不需要为每个事件创建或复制模板。`GET /api/meta` 公开以下能力描述（仍需管理端鉴权）：

- `source_providers[].event_definitions[event].content_template`：该 Source 事件的完整默认内容，含 `title` 和有序 `blocks`；各字段使用该事件自己的取值表达式。
- `destination_providers[].default_presentation`、`message_styles`、`block_styles`、`accents`：目标平台的默认展示方式及可选样式。当前飞书的结构化事件消息支持消息卡片、富文本、纯文本；图片和群名片仍可通过旧版原生消息编辑器配置。
- `pair_presets[]`：Source → Destination 的完整特调预设。`events[event]` 含 `content` 与 `presentation`，目前覆盖 13 个 Apple 事件到飞书的成品消息。

规则可省略所有消息配置字段，或显式保存：

```json
{
  "message_policy": {
    "preset": "recommended",
    "overrides": {}
  }
}
```

`recommended` 优先使用平台组合预设；没有组合预设时使用 Source 的完整事件内容与 Destination 默认展示。`default` 直接使用后者。未知事件不会套用其他事件的内容，事件会保留，但该规则不创建投递任务。

仅为需要自定义的事件添加覆盖：

```json
{
  "message_policy": {
    "preset": "recommended",
    "overrides": {
      "webhookPingCreated": {
        "content": {
          "title": "{{ event.source_name }} · 连接测试",
          "blocks": [
            {"id": "intro", "kind": "text", "label": "", "text": "已成功收到测试事件。"}
          ]
        },
        "presentation": {
          "style": "card",
          "block_styles": {"intro": "note"}
        }
      }
    }
  }
}
```

`content` 可省略，省略表示继承完整的内置内容；指定时替换该事件的标题与内容块。`presentation` 可省略或局部指定 `style`、`accent`、`block_styles`。未指定的部分继承预设；单个内容块设为 `default` 时改用目标平台针对内容类型的默认样式。删除对应事件的覆盖即可恢复完整预设。

内容块支持 `text` 和 `link`，链接还需 `url`，仅接受 HTTP/HTTPS。空的渲染结果会省略，布尔值 `false` 不视为缺失。卡片支持正文、并排字段、辅助说明、链接按钮；切换富文本/纯文本保留内容和链接，局部卡片样式只在卡片模式下应用。每个事件允许 1–40 个内容块，配置总大小限制为 256 KB；最终消息仍受 Destination 限制。

`POST /api/preview` 可传 `message_policy`、`sample`、`source_provider`、`destination_provider`、`source_name`，省略 `message_policy` 和 `payload_template` 时预览完整内置消息。预览与 Webhook 接收使用同一渲染路径。

`message_policy`、旧版 `event_templates`、`payload_template` 三种配置互斥。旧规则保持原来的选择和发送逻辑，不自动覆盖用户已有内容。控制台可显式切换为完整内置预设，保存后生效。自定义内容保存在当前规则中；模板库的试用编辑不修改规则。审计仅保存 `message_policy_sha256`，不记录完整消息正文；已入队任务保持接收时的消息快照。

`kind` 为 `keys`、`sources`、`destinations`、`routes`。

创建：

```json
{
  "name": "生产环境 Apple",
  "config": {
    "provider": "apple_app_store_connect",
    "key_id": "密钥资源 ID",
    "enabled": true
  }
}
```

成功返回资源对象，含 `id`、`kind`、`name`、`config`、`revision`、`created_at`、`updated_at`。时间戳单位为 Unix 秒。创建成功状态为 `200`。

更新使用同样的请求体并增加 `revision`。更新是整份配置替换，不是局部 PATCH；字段缺失会校验失败。版本冲突返回 `409`。

### Key

写入配置：

```json
{"value":"密钥字符串或完整飞书机器人 URL"}
```

读取配置只返回 `{"has_value":true}`。更新时发送 `{"value":""}` 保留原值。不要将只读字段 `has_value` 作为写入配置发送。

### Source

```json
{
  "provider": "apple_app_store_connect",
  "key_id": "Apple 验签密钥 ID",
  "enabled": true
}
```

### Destination

```json
{
  "provider": "feishu",
  "url_key_id": "飞书机器人 URL 密钥 ID",
  "signing_key_id": null,
  "enabled": true
}
```

`signing_key_id` 可为飞书签名密钥 ID 或 `null`。URL 密钥在创建目标和后续轮换时均校验。生产环境只允许飞书机器人域名。

### Route

```json
{
  "source_id": "来源 ID",
  "destination_id": "目标 ID",
  "event_types": ["appStoreVersionAppVersionStateUpdated"],
  "payload_template": {
    "msg_type": "text",
    "content": {"text": "[App Store Connect] {{ event.summary }}"}
  },
  "max_attempts": 5,
  "enabled": true
}
```

`event_types` 为空数组时匹配所有事件；最多 100 项。`max_attempts` 是 1–10 的整数。`enabled` 必须显式提供布尔值。

## 预览

```json
{
  "source_name": "生产应用",
  "source_provider": "apple_app_store_connect",
  "destination_provider": "feishu",
  "payload_template": {
    "msg_type": "text",
    "content": {"text": "{{ event.source_name }}: {{ event.summary }}"}
  },
  "sample": {
    "data": {
      "id": "sample-001",
      "type": "buildUploadStateUpdated",
      "attributes": {"newState":"COMPLETE"}
    }
  }
}
```

`source_provider` 与 `destination_provider` 指定预览适配器，未注册类型返回 400。为兼容旧请求，省略时使用原有 Apple / 飞书组合；WebUI 始终明确传递所选实例的平台。

返回 `{"payload":{...},"event":{...}}`。预览不读 Key、不发送通知；只记录预览动作和事件类型，不将示例原文写入审计。

## 列表、筛选和分页

`events`、`deliveries`、`audit` 支持：

- `limit`：默认 50，限制在 1–200。
- `before`：上一页最后一项的 `cursor`，返回更旧记录。
- `/api/events?source_id=…&event_type=…`：组合筛选来源与事件类型。
- `/api/deliveries?status=failed`：按投递状态精确筛选；`status=queued` 包含 `pending`、`retrying`、`sending`。
- 投递列表还支持 `route_id`、`destination_id`、`event_id`，多个条件按 AND 组合。
- 接收和投递列表支持 `id` 精确筛选，用于打开第一页之外的指定记录。不存在时返回空数组。
- 投递记录包含 `updated_at` 与 `next_attempt_at`，详情使用独立查询刷新。
- `/api/audit?action=webhook.signature_rejected`：按动作精确筛选。

结果直接返回数组。第一页可定时刷新；继续翻页使用上一页提供的 cursor。资源列表当前一次返回全部配置，不适用于数万条配置的管理场景。

投递状态：`pending`、`sending`、`retrying`、`succeeded`、`failed`。发送尝试另有 `unknown`，表示发送期间进程中断、远端结果不确定。

常见审计动作：

```text
auth.rejected
config.created / config.updated / config.deleted
template.previewed
webhook.signature_rejected / webhook.payload_rejected
webhook.duplicate / webhook.id_conflict / webhook.accepted
delivery.queued / delivery.started / delivery.succeeded
delivery.retrying / delivery.failed / delivery.retried
worker.recovered
```

## Apple 接收端

必须发送 `x-apple-signature: hmacsha256=<HMAC-SHA256 原始正文的 hex digest>`。共享密钥来自 Source 引用的 Key，不需要管理令牌。

| 状态码 | 含义 |
| --- | --- |
| `202` | 验签、解析成功且已持久化；可能匹配零条规则，不代表飞书已发送成功 |
| `200` | 已接收过完全相同的事件，不创建重复任务 |
| `400` | 原始正文不是受支持的 Apple JSON 事件 |
| `401` | 缺失或错误的签名 |
| `404` | 来源不存在、类型错误或已停用 |
| `409` | 同一来源中相同事件 ID 对应不同正文 |
| `413` | 请求体超过 256 KiB |
| `500` | 持久化或内部处理失败，不应将其视为已成功接收 |

原始事件必须包含非空的 `data.id` 和 `data.type`。新事件回应包含本地 `event_id` 和任务数 `deliveries`。所有平台通知和结果详情应通过投递记录确认。


## 按来源事件配置消息模板

`GET /api/meta` 新增以下元数据：

- `source_providers[].event_definitions`：以来源事件类型为键，提供名称、该事件专属的字段列表与原始示例。字段包括 `path`、`label`、`expression`、`optional`。
- `message_presets`：模板列表，按 `source_provider`、`event_type`、`destination_provider` 匹配。每个模板包含 `id`、`name`、`payload_template`。

Source 保留平台原始 payload，事件预设直接读取对应事件的字段。通用编辑器从事件定义获取可选字段，不把不同事件转换成统一的状态对象。`event.summary` 仅供既有规则兼容使用。

新规则可用 `event_templates` 替代单一的 `payload_template`：

```json
{
  "source_id": "SOURCE_ID",
  "destination_id": "DESTINATION_ID",
  "enabled": true,
  "event_types": ["webhookPingCreated"],
  "max_attempts": 5,
  "event_templates": {
    "webhookPingCreated": {
      "active_template_id": "ping-custom",
      "templates": [
        {
          "id": "ping-custom",
          "name": "连通性测试通知",
          "payload_template": {
            "msg_type": "text",
            "content": {"text": "{{ event.source_name }}：已收到连通性测试通知。"}
          }
        }
      ]
    }
  }
}
```

每种事件可以保存 1–20 个模板，但只能选用其中一个。自定义模板保存在当前规则内，Source 平台和目标平台由规则引用确定；没有新增全局模板资源。

- 收到事件后，按 `data.type` 精确选择该事件的活动模板。
- `event_types` 不为空时，其中每项都必须有模板配置；为空时按已配置的事件模板匹配。
- 没有匹配模板的未知事件仍保留接收记录，不创建投递任务，不使用其他事件的模板。
- `payload_template` 和 `event_templates` 互斥；旧规则继续使用原配置。
- 模板库最大 256 KB，最多配置 100 种已注册事件；ID 必须唯一，活动 ID 必须存在。
- 审计中只记录模板库哈希，不记录完整模板正文。

模板可使用 `field` 过滤器读取原始 JSON Pointer，例如 `{{ event.raw | field("/data/attributes/newValue") }}`。路径不存在时返回空值；可配合条件省略不存在的字段。布尔值 `false` 与缺失值分别处理。事件时间保留来源提供的时区。

内置 App Store Connect → 飞书预设覆盖 12 种业务事件和连通性测试，共 13 项。应用和反馈详情未包含在 webhook 时，不虚构字段，也不自动执行额外的 App Store Connect API 查询。
