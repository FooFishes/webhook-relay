import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import {
  EventTemplateEditor,
  defaultEventTemplates,
} from "./EventTemplateEditor";
import type { Api } from "./api";
import type {
  SourceProvider,
  DestinationProvider,
  MessagePreset,
} from "./types";
const source: SourceProvider = {
  id: "apple",
  name: "Apple",
  category: "",
  fields: [],
  defaults: {},
  event_types: { version: "版本", feedback: "反馈" },
  sample: {},
  event_definitions: {
    version: {
      name: "版本",
      fields: [
        {
          path: "data.attributes.newValue",
          label: "当前版本状态",
          expression: 'event.raw | field("/data/attributes/newValue")',
          optional: true,
        },
      ],
      sample: { data: { id: "v", type: "version" } },
    },
    feedback: {
      name: "反馈",
      fields: [
        {
          path: "data.attributes.timestamp",
          label: "反馈时间",
          expression: 'event.raw | field("/data/attributes/timestamp")',
          optional: true,
        },
      ],
      sample: { data: { id: "f", type: "feedback" } },
    },
  },
};
const target: DestinationProvider = {
  id: "feishu",
  name: "飞书",
  category: "",
  fields: [],
  defaults: {},
  editor: "feishu",
  message_types: {},
  default_template: {},
};
const presets: MessagePreset[] = ["version", "feedback"].map((kind) => ({
  id: kind,
  name: kind + "模板",
  event_type: kind,
  source_provider: "apple",
  destination_provider: "feishu",
  payload_template: { msg_type: "text", content: { text: kind + "原文" } },
}));
it("switches source event fields and preserves independent templates when copying and editing", async () => {
  const change = vi.fn();
  function Harness() {
    const [value, setValue] = useState(
      defaultEventTemplates(source, target, presets),
    );
    return (
      <EventTemplateEditor
        active={false}
        api={vi.fn() as unknown as Api}
        sourceName="应用"
        source={source}
        target={target}
        presets={presets}
        eventTypes={[]}
        value={value}
        onChange={(next) => {
          setValue(next);
          change(next);
        }}
      />
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "当前版本状态" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "反馈时间" })).toBeNull();
  expect(screen.queryByRole("button", { name: "状态摘要" })).toBeNull();
  await user.clear(screen.getByLabelText("消息正文"));
  await user.type(screen.getByLabelText("消息正文"), "版本自定义");
  screen.getByRole("combobox", { name: "配置哪种事件" }).focus();
  await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("option", { name: "反馈" }));
  expect(screen.getByRole("button", { name: "反馈时间" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "当前版本状态" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "复制当前模板" }));
  await user.clear(screen.getByLabelText("消息正文"));
  await user.type(screen.getByLabelText("消息正文"), "反馈副本");
  const latest = change.mock.lastCall![0];
  expect(latest.version.templates[0].payload_template.content.text).toBe(
    "版本自定义",
  );
  expect(latest.feedback.templates[0].payload_template.content.text).toBe(
    "feedback原文",
  );
  expect(latest.feedback.templates[1].payload_template.content.text).toBe(
    "反馈副本",
  );
  expect(latest.feedback.active_template_id).toBe(
    latest.feedback.templates[1].id,
  );
});
