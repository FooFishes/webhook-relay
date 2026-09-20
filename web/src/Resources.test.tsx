import { expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Resources } from "./Resources";
import { defaultTemplate, testMeta } from "./test-data";
import type { Resource } from "./types";
import type { Api } from "./api";
it("edits write-only keys without submitting read-only metadata", async () => {
  const key: Resource = {
    id: "key-1",
    name: "Apple key",
    kind: "keys",
    config: { has_value: true },
    revision: 3,
    created_at: 1,
    updated_at: 1,
  };
  const api = vi.fn().mockResolvedValue({ ...key, revision: 4 });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Resources
        kind="keys"
        data={{ keys: [key], sources: [], destinations: [], routes: [] }}
        meta={{
          ...testMeta,
          public_url: "http://localhost:8080",
          default_template: defaultTemplate,
        }}
        api={api as Api}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "编辑" }));
  expect(await screen.findByLabelText(/替换密钥值/)).toHaveProperty(
    "value",
    "",
  );
  await user.type(screen.getByLabelText(/替换密钥值/), "replacement");
  await user.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/resources/keys/key-1", "PUT", {
      name: "Apple key",
      config: { value: "replacement" },
      revision: 3,
    }),
  );
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "配置已保存。",
  );
});

it("saves route message fields directly as an object, with no raw JSON configuration", async () => {
  const { resources } = await import("./test-data");
  const template = { ...defaultTemplate, extension: { preserve: true } };
  const route = {
    ...resources.routes[0],
    config: {
      ...resources.routes[0].config,
      event_types: [],
      max_attempts: 3,
      payload_template: template,
    },
  };
  const api = vi.fn().mockResolvedValue(route);
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Resources
        kind="routes"
        data={{ ...resources, routes: [route] }}
        meta={{
          ...testMeta,
          public_url: "http://localhost:8080",
          default_template: defaultTemplate,
        }}
        api={api as Api}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.clear(screen.getByLabelText("消息正文"));
  await user.type(screen.getByLabelText("消息正文"), "构建完成");
  expect(document.querySelector("pre")).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/resources/routes/route-1", "PUT", {
      name: route.name,
      revision: route.revision,
      config: {
        ...route.config,
        payload_template: { ...template, content: { text: "构建完成" } },
      },
    }),
  );
});

it("builds instance fields from the selected provider instead of a fixed platform form", async () => {
  const { resource, resources } = await import("./test-data");
  const custom = {
    id: "test_source",
    name: "测试来源适配器",
    category: "测试",
    fields: [
      {
        key: "token_id",
        label: "访问凭据",
        required: true,
        type: "secret" as const,
      },
    ],
    defaults: { token_id: "" },
    event_types: { changed: "内容变更" },
    sample: {},
  };
  const api = vi.fn().mockResolvedValue({});
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Resources
        kind="sources"
        data={{
          ...resources,
          keys: [resource("keys", "token-1", "服务凭据", { has_value: true })],
        }}
        meta={{
          ...testMeta,
          source_providers: [...testMeta.source_providers, custom],
        }}
        api={api as Api}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "添加来源" }));
  await user.type(screen.getByLabelText("名称"), "内部服务");
  await user.click(screen.getByRole("combobox", { name: "来源平台" }));
  await user.click(
    await screen.findByRole("option", { name: "测试来源适配器 · 测试" }),
  );
  expect(
    screen.queryByRole("combobox", { name: "Webhook 验签密钥" }),
  ).toBeNull();
  await user.click(screen.getByRole("combobox", { name: "访问凭据" }));
  await user.click(await screen.findByRole("option", { name: "服务凭据" }));
  await user.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/resources/sources", "POST", {
      name: "内部服务",
      revision: undefined,
      config: { provider: "test_source", enabled: true, token_id: "token-1" },
    }),
  );
});
it("requires confirmation before changing a rule to a different destination platform", async () => {
  const { resource, resources } = await import("./test-data");
  const target = resource("destinations", "dest-other", "其他目标", {
    provider: "test_destination",
    enabled: true,
  });
  const adapter = {
    ...testMeta.destination_providers[0],
    id: "test_destination",
    name: "测试目标适配器",
    default_template: { msg_type: "text", content: { text: "新平台默认消息" } },
  };
  const route = {
    ...resources.routes[0],
    config: {
      ...resources.routes[0].config,
      event_types: [],
      max_attempts: 3,
      payload_template: defaultTemplate,
    },
  };
  const api = vi.fn().mockResolvedValue(route);
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Resources
        kind="routes"
        data={{
          ...resources,
          routes: [route],
          destinations: [...resources.destinations, target],
        }}
        meta={{
          ...testMeta,
          destination_providers: [...testMeta.destination_providers, adapter],
        }}
        api={api as Api}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.click(screen.getByRole("combobox", { name: "通知目标" }));
  await user.click(
    await screen.findByRole("option", { name: "其他目标 · 测试目标适配器" }),
  );
  expect(screen.getByRole("heading", { name: "更换目标平台" })).toBeTruthy();
  expect(api).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "更换并重置消息" }));
  expect(screen.getByLabelText("消息正文")).toHaveProperty(
    "value",
    "新平台默认消息",
  );
  await user.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/resources/routes/route-1", "PUT", {
      name: route.name,
      revision: 1,
      config: {
        ...route.config,
        destination_id: "dest-other",
        payload_template: adapter.default_template,
      },
    }),
  );
});

it("converts an existing rule to event bindings without saving a legacy template alongside them", async () => {
  const { resources } = await import("./test-data");
  const type = "webhookPingCreated";
  const rule = {
    ...resources.routes[0],
    config: {
      ...resources.routes[0].config,
      event_types: [],
      max_attempts: 3,
      payload_template: defaultTemplate,
    },
  };
  const preset = {
    id: "ping",
    name: "连通性测试",
    source_provider: testMeta.source_providers[0].id,
    destination_provider: testMeta.destination_providers[0].id,
    event_type: type,
    payload_template: { msg_type: "text", content: { text: "测试通知" } },
  };
  const meta = {
    ...testMeta,
    source_providers: [
      {
        ...testMeta.source_providers[0],
        event_definitions: {
          [type]: {
            name: "连通性测试",
            fields: [],
            sample: { data: { id: "ping", type } },
          },
        },
      },
    ],
    message_presets: [preset],
  };
  const api = vi.fn().mockResolvedValue(rule);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Resources
        kind="routes"
        data={{ ...resources, routes: [rule] }}
        meta={meta}
        api={api as Api}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.click(screen.getByRole("button", { name: "改为按事件配置模板" }));
  await user.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() =>
    expect(
      api.mock.calls.some(
        ([path, method]) =>
          path === "/resources/routes/route-1" && method === "PUT",
      ),
    ).toBe(true),
  );
  const saved = api.mock.calls.find(
    ([path, method]) =>
      path === "/resources/routes/route-1" && method === "PUT",
  )![2].config;
  expect(saved.payload_template).toBeUndefined();
  expect(saved.event_templates[type]).toEqual({
    active_template_id: "ping",
    templates: [
      {
        id: "ping",
        name: "连通性测试",
        payload_template: preset.payload_template,
      },
    ],
  });
});

it("saves a new rule with built-in defaults without opening or editing any event", async () => {
  const { resources } = await import("./test-data");
  const source = {
    ...testMeta.source_providers[0],
    event_definitions: {
      webhookPingCreated: {
        name: "连通性测试",
        fields: [],
        sample: {},
        content_template: {
          title: "连接测试",
          blocks: [
            { id: "intro", kind: "text" as const, label: "", text: "连接成功" },
          ],
        },
      },
    },
  };
  const target = {
    ...testMeta.destination_providers[0],
    message_styles: [{ id: "card", name: "消息卡片", description: "" }],
  };
  const api = vi.fn().mockResolvedValue({});
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Resources
        kind="routes"
        data={resources}
        meta={{
          ...testMeta,
          source_providers: [source],
          destination_providers: [target],
        }}
        api={api as Api}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "添加转发规则" }));
  await user.type(screen.getByLabelText("名称"), "默认事件消息");
  screen.getByRole("combobox", { name: "事件来源" }).focus();
  await user.keyboard("{ArrowDown}");
  await user.click(
    await screen.findByRole("option", {
      name: "生产应用 · Apple App Store Connect",
    }),
  );
  screen.getByRole("combobox", { name: "通知目标" }).focus();
  await user.keyboard("{ArrowDown}");
  await user.click(
    await screen.findByRole("option", { name: "发布群 · 飞书" }),
  );
  expect(screen.getByText("使用内置模板")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/resources/routes", "POST", {
      name: "默认事件消息",
      revision: undefined,
      config: {
        enabled: true,
        source_id: "source-1",
        destination_id: "dest-1",
        event_types: [],
        max_attempts: 5,
        message_policy: { preset: "recommended", overrides: {} },
      },
    }),
  );
});
