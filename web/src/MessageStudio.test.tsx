import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { Api } from "./api";
import type {
  DestinationProvider,
  MessagePolicy,
  SourceProvider,
} from "./types";
import { MessageStudio } from "./MessageStudio";
import { builtinPolicy, resolveMessage } from "./message-policy";
import { testMeta } from "./test-data";

const source: SourceProvider = {
  ...testMeta.source_providers[0],
  event_definitions: Object.fromEntries(
    ["version", "ping"].map((type) => [
      type,
      {
        name: type === "version" ? "版本变更" : "连接测试",
        fields: [],
        sample: { data: { id: type, type } },
        content_template: {
          title: type + "标题",
          blocks: [
            {
              id: "body",
              kind: "text" as const,
              label: "",
              text: type + "完整通知",
            },
          ],
        },
      },
    ]),
  ),
};
const target: DestinationProvider = {
  ...testMeta.destination_providers[0],
  default_presentation: { style: "card", accent: "blue", block_styles: {} },
  message_styles: [
    { id: "card", name: "消息卡片", description: "卡片排版" },
    { id: "text", name: "纯文本", description: "完整文字" },
  ],
  block_styles: [
    {
      id: "default",
      name: "默认样式",
      description: "自动选择",
      kinds: ["text"],
    },
    { id: "note", name: "辅助说明", description: "次要内容", kinds: ["text"] },
  ],
  accents: { blue: "蓝色", green: "绿色" },
};

it("uses complete built-ins without creating overrides, and keeps edits scoped to an event across styles", async () => {
  const change = vi.fn();
  const api = vi.fn().mockResolvedValue({
    payload: { msg_type: "text", content: { text: "后端渲染的完整消息" } },
  });
  function Harness() {
    const [policy, setPolicy] = useState(builtinPolicy);
    return (
      <MessageStudio
        active
        api={api as Api}
        sourceName="我的应用"
        source={source}
        target={target}
        pairs={[]}
        value={policy}
        onChange={(next) => {
          change(next);
          setPolicy(next);
        }}
      />
    );
  }
  render(<Harness />);
  const user = userEvent.setup();
  expect(screen.getByText("version完整通知")).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
  await screen.findByText("后端渲染的完整消息");
  expect(api.mock.lastCall?.[2].message_policy).toEqual(builtinPolicy());
  await user.click(screen.getByRole("button", { name: "编辑内容 1" }));
  await user.clear(screen.getByLabelText("内容 1"));
  await user.type(screen.getByLabelText("内容 1"), "我的发布内容");
  await user.click(screen.getByRole("button", { name: "纯文本" }));
  const latest = change.mock.lastCall![0] as MessagePolicy;
  expect(latest.overrides.version.content?.blocks[0].text).toBe("我的发布内容");
  expect(latest.overrides.version.presentation?.style).toBe("text");
  expect(
    resolveMessage(source, target, [], latest, "ping").content?.blocks[0].text,
  ).toBe("ping完整通知");
  await user.click(screen.getByRole("button", { name: "连接测试" }));
  expect(screen.getByText("ping完整通知")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "版本变更" }));
  await user.click(screen.getByRole("button", { name: "恢复内置" }));
  expect(change.mock.lastCall![0]).toEqual(builtinPolicy());
  expect(screen.getByText("version完整通知")).toBeTruthy();
});

it("applies a block style through the popover without changing message content", async () => {
  const change = vi.fn();
  render(
    <MessageStudio
      active={false}
      api={vi.fn() as unknown as Api}
      sourceName="应用"
      source={source}
      target={target}
      pairs={[]}
      value={builtinPolicy()}
      onChange={change}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "version完整通知的展示样式" }),
  );
  await user.click(screen.getByRole("button", { name: /辅助说明/ }));
  expect(change.mock.lastCall![0].overrides.version).toEqual({
    presentation: { block_styles: { body: "note" } },
  });
  expect(screen.getByText("version完整通知")).toBeTruthy();
});

it("ignores an older preview when switching to another event", async () => {
  let finishOld: (value: unknown) => void = () => {};
  const api = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValue({
      payload: { msg_type: "text", content: { text: "连接测试的预览" } },
    });
  render(
    <MessageStudio
      active
      api={api as Api}
      sourceName="应用"
      source={source}
      target={target}
      pairs={[]}
      value={builtinPolicy()}
      onChange={vi.fn()}
    />,
  );
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("button", { name: "连接测试" }));
  await screen.findByText("连接测试的预览");
  finishOld({ payload: { msg_type: "text", content: { text: "过期预览" } } });
  await waitFor(() => expect(screen.queryByText("过期预览")).toBeNull());
});

it("adds a field as a side-by-side line, or inserts it at the caret while editing", async () => {
  const withFields: SourceProvider = {
    ...source,
    event_definitions: {
      version: {
        ...source.event_definitions!.version,
        fields: [
          {
            label: "新状态",
            path: "data.attributes.newValue",
            expression: "event.data.attributes.newValue",
            optional: false,
          },
        ],
      },
    },
  };
  const change = vi.fn();
  function Harness() {
    const [policy, setPolicy] = useState(builtinPolicy);
    return (
      <MessageStudio
        active={false}
        api={vi.fn() as unknown as Api}
        sourceName="应用"
        source={withFields}
        target={{
          ...target,
          block_styles: [
            ...target.block_styles!,
            { id: "field", name: "并排字段", description: "", kinds: ["text"] },
          ],
        }}
        pairs={[]}
        value={policy}
        onChange={(next) => {
          change(next);
          setPolicy(next);
        }}
      />
    );
  }
  render(<Harness />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "字段：新状态" }));
  let latest = change.mock.lastCall![0] as MessagePolicy;
  const added = latest.overrides.version.content!.blocks[1];
  expect(added).toMatchObject({
    label: "新状态",
    text: "{{ event.data.attributes.newValue }}",
  });
  expect(latest.overrides.version.presentation?.block_styles[added.id]).toBe(
    "field",
  );

  await user.click(screen.getByRole("button", { name: "编辑内容 1" }));
  const input = screen.getByLabelText("内容 1") as HTMLTextAreaElement;
  input.setSelectionRange(0, 0);
  await user.click(screen.getByRole("button", { name: "字段：新状态" }));
  latest = change.mock.lastCall![0] as MessagePolicy;
  expect(latest.overrides.version.content!.blocks[0].text).toBe(
    "{{ event.data.attributes.newValue }}version完整通知",
  );
});

it("reorders blocks from the keyboard with the drag handle", async () => {
  const change = vi.fn();
  const twoBlocks: SourceProvider = {
    ...source,
    event_definitions: {
      version: {
        ...source.event_definitions!.version,
        content_template: {
          title: "标题",
          blocks: [
            { id: "a", kind: "text", label: "", text: "第一段" },
            { id: "b", kind: "text", label: "", text: "第二段" },
          ],
        },
      },
    },
  };
  render(
    <MessageStudio
      active={false}
      api={vi.fn() as unknown as Api}
      sourceName="应用"
      source={twoBlocks}
      target={target}
      pairs={[]}
      value={builtinPolicy()}
      onChange={change}
    />,
  );
  screen.getByRole("button", { name: /移动内容 2/ }).focus();
  await userEvent.keyboard("{ArrowUp}");
  expect(
    (
      change.mock.lastCall![0] as MessagePolicy
    ).overrides.version.content!.blocks.map((b) => b.id),
  ).toEqual(["b", "a"]);
});
