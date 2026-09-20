import type { OverviewData, Resource } from "./types";
export const emptyOverview: OverviewData = {
  window: { since: 1, until: 86401, hours: 24 },
  received: 0,
  succeeded: 0,
  failed: 0,
  success_rate: null,
  queue: { pending: 0, retrying: 0, sending: 0, paused: 0 },
  attention_failed: 0,
  series: [],
  routes: [],
  recent_failed: [],
  recent_events: [],
};
export const resource = (
  kind: Resource["kind"],
  id: string,
  name: string,
  config: Resource["config"] = {},
): Resource => ({
  kind,
  id,
  name,
  config,
  revision: 1,
  created_at: 1,
  updated_at: 1,
});
export const resources = {
  keys: [],
  sources: [
    resource("sources", "source-1", "生产应用", {
      provider: "apple_app_store_connect",
      key_id: "key-1",
      enabled: true,
    }),
  ],
  destinations: [
    resource("destinations", "dest-1", "发布群", {
      provider: "feishu",
      url_key_id: "key-2",
      enabled: true,
    }),
  ],
  routes: [
    resource("routes", "route-1", "发布通知", {
      source_id: "source-1",
      destination_id: "dest-1",
      enabled: true,
    }),
  ],
};

export const sample = {
  data: {
    type: "appStoreVersionAppVersionStateUpdated",
    id: "preview-event-001",
    version: 1,
    attributes: {
      oldValue: "PREPARE_FOR_SUBMISSION",
      newValue: "READY_FOR_REVIEW",
      timestamp: "2026-09-15T02:00:00Z",
    },
    relationships: {
      instance: {
        data: { type: "appStoreVersions", id: "example-version-id" },
      },
    },
  },
};
export const defaultTemplate = {
  msg_type: "text",
  content: {
    text: "[App Store Connect] {{ event.source_name }}\n{{ event.event_type }}\n{{ event.summary }}\n事件 ID: {{ event.id }}",
  },
};

export const testMeta: import("./types").Meta = {
  public_url: "http://localhost:8080",
  default_template: defaultTemplate,
  source_providers: [
    {
      id: "apple_app_store_connect",
      name: "Apple App Store Connect",
      category: "应用发布",
      fields: [
        {
          key: "key_id",
          label: "Webhook 验签密钥",
          required: true,
          type: "secret",
        },
      ],
      defaults: { key_id: "" },
      event_types: { buildUploadStateUpdated: "构建上传状态变更" },
      sample,
    },
  ],
  destination_providers: [
    {
      id: "feishu",
      name: "飞书",
      category: "群机器人",
      fields: [
        {
          key: "url_key_id",
          label: "Webhook 地址",
          required: true,
          type: "secret",
        },
        {
          key: "signing_key_id",
          label: "签名密钥",
          required: false,
          type: "secret",
        },
      ],
      defaults: { url_key_id: "", signing_key_id: null },
      editor: "feishu",
      message_types: { text: "文本" },
      default_template: defaultTemplate,
    },
  ],
};
