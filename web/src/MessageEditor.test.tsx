import { useState } from "react";
import { expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeishuMessageEditor as MessageEditor } from "./providers/feishu/MessageEditor";
import { createMessage, object } from "./providers/feishu/message-model";
import type { MessageObject } from "./providers/feishu/message-model";

function setup(value: MessageObject) {
  const change = vi.fn();
  function Harness() {
    const [message, setMessage] = useState(value);
    return (
      <MessageEditor
        value={message}
        onChange={(v) => {
          setMessage(v);
          change(v);
        }}
      />
    );
  }
  const view = render(<Harness />);
  return { ...view, change, user: userEvent.setup() };
}
it("edits text and inserts variables without losing provider fields or using a JSON editor", async () => {
  const original = {
    msg_type: "text",
    content: { text: "原文", extra: "preserved" },
    extension: { enabled: true },
  };
  const { change, user, container } = setup(original);
  await user.clear(screen.getByLabelText("消息正文"));
  await user.type(screen.getByLabelText("消息正文"), "发布：");
  await user.click(screen.getByRole("button", { name: "状态摘要" }));
  expect(change).toHaveBeenLastCalledWith({
    ...original,
    content: { ...original.content, text: "发布：{{ event.summary }}" },
  });
  expect(container.querySelector("pre")).toBeNull();
  expect(
    [...container.querySelectorAll("textarea")].some((t) =>
      t.value.trim().startsWith("{"),
    ),
  ).toBe(false);
  expect(original.content.text).toBe("原文");
});
it("edits rich text, preserves other languages, and reorders paragraph contents", async () => {
  const en = {
    title: "English",
    content: [[{ tag: "text", text: "untouched" }]],
  };
  const value = {
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title: "原题",
          content: [
            [{ tag: "text", text: "第一段", un_escape: true }],
            [{ tag: "text", text: "第二段" }],
          ],
        },
        en_us: en,
      },
    },
  };
  const { change, user } = setup(value);
  await user.clear(screen.getByRole("textbox", { name: "标题" }));
  await user.type(screen.getByRole("textbox", { name: "标题" }), "发布");
  const section = screen
    .getByRole("heading", { name: "段落 1" })
    .closest("section")!;
  await user.click(within(section).getAllByRole("button", { name: "下移" })[0]);
  const post = object(object(change.mock.lastCall![0].content).post);
  expect(post.en_us).toEqual(en);
  expect(post.zh_cn).toEqual({
    title: "发布",
    content: [
      [{ tag: "text", text: "第二段" }],
      [{ tag: "text", text: "第一段", un_escape: true }],
    ],
  });
});
it("edits a card v2 body without dropping header or body options", async () => {
  const card = {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: "发布" },
      template: "green",
    },
    body: {
      padding: "12px",
      elements: [{ tag: "markdown", content: "原文", text_align: "left" }],
    },
    config: { update_multi: true },
  };
  const { change, user } = setup({ msg_type: "interactive", card });
  await user.clear(screen.getByLabelText("内容块 1 正文"));
  await user.type(screen.getByLabelText("内容块 1 正文"), "新内容");
  expect(change).toHaveBeenLastCalledWith({
    msg_type: "interactive",
    card: {
      ...card,
      body: {
        ...card.body,
        elements: [{ tag: "markdown", content: "新内容", text_align: "left" }],
      },
    },
  });
});
it("requires a deliberate confirmation before replacing content on a type change", async () => {
  const { change, user } = setup(createMessage("text"));
  await user.click(screen.getByRole("combobox", { name: /消息类型/ }));
  await user.click(await screen.findByRole("option", { name: "富文本" }));
  expect(change).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByLabelText("消息正文")).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: /消息类型/ }));
  await user.click(await screen.findByRole("option", { name: "富文本" }));
  await user.click(screen.getByRole("button", { name: "切换类型" }));
  expect(change).toHaveBeenLastCalledWith(createMessage("post"));
});
it("edits card link buttons through named fields", async () => {
  const original = {
    tag: "button",
    text: { tag: "plain_text", content: "详情" },
    url: "https://example.com",
    type: "primary",
    confirm: { title: { tag: "plain_text", content: "确认" } },
  };
  const { user, change } = setup({
    msg_type: "interactive",
    card: { elements: [{ tag: "action", actions: [original] }] },
  });
  await user.clear(screen.getByLabelText("按钮 1 文字"));
  await user.type(screen.getByLabelText("按钮 1 文字"), "查看版本");
  expect(object(change.mock.lastCall![0].card).elements).toEqual([
    {
      tag: "action",
      actions: [
        { ...original, text: { tag: "plain_text", content: "查看版本" } },
      ],
    },
  ]);
});

it("drags a field to the selection and reorders card blocks without dropping extensions", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const { container, change } = setup({
    msg_type: "interactive",
    card: {
      elements: [
        {
          tag: "div",
          text: { tag: "plain_text", content: "first" },
          extra: "keep",
        },
        { tag: "hr" },
        { tag: "div", text: { tag: "plain_text", content: "third" } },
      ],
    },
  });
  const input = screen.getByLabelText("内容块 1 正文") as HTMLTextAreaElement;
  input.setSelectionRange(0, 5);
  const dataTransfer = {
    setData: vi.fn(),
    getData: () => "event.id",
    types: ["application/x-relay-variable"],
  };
  fireEvent.drop(input, { dataTransfer });
  expect(input.value).toBe("{{ event.id }}");
  const handles = container.querySelectorAll(".drag-handle");
  fireEvent.dragStart(handles[0], { dataTransfer });
  fireEvent.drop(container.querySelectorAll(".message-block")[2], {
    dataTransfer,
  });
  expect(object(change.mock.lastCall![0].card).elements).toEqual([
    { tag: "hr" },
    { tag: "div", text: { tag: "plain_text", content: "third" } },
    {
      tag: "div",
      text: { tag: "plain_text", content: "{{ event.id }}" },
      extra: "keep",
    },
  ]);
});
