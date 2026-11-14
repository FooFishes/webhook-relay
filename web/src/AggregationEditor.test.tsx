import { expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AggregationEditor } from "./AggregationEditor";
import type { Api } from "./api";
import type {
  AggregationPreset,
  DestinationProvider,
  SourceProvider,
} from "./types";

const preset = {
  id: "github.commit_pipeline",
  source_provider: "github",
  name: "提交流水线",
  description: "一次提交合并为一条消息",
  options: { notify_failure: "任务失败立即提醒" },
  rule: {
    name: "提交流水线",
    group: { match: ["push", "workflow_run.*"], key: ["/after"] },
    slots: {},
    close: { idle: 90, max_wait: 7200 },
    container: { title: "t", blocks: [] },
  },
} as AggregationPreset;
const source = {
  id: "github",
  name: "GitHub",
  event_definitions: {
    push: { name: "推送", fields: [], sample: {} },
    "workflow_run.completed": {
      name: "工作流运行已结束",
      fields: [],
      sample: {},
    },
  },
} as unknown as SourceProvider;
const target = { id: "feishu", editor: "feishu" } as DestinationProvider;

it("toggles preset options, flags filtered events and replays recent events", async () => {
  const onChange = vi.fn();
  const onEventTypes = vi.fn();
  const api = vi.fn().mockResolvedValue({
    events: 36,
    grouped: 35,
    singles: 1,
    messages: 2,
    groups: [],
  });
  const value = { rules: [{ preset: preset.id, options: {} }] };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AggregationEditor
        api={api as Api}
        value={value}
        onChange={onChange}
        sourceId="source-1"
        source={source}
        target={target}
        presets={[preset]}
        eventTypes={["push"]}
        onEventTypesChange={onEventTypes}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("switch", { name: "任务失败立即提醒" }));
  expect(onChange).toHaveBeenCalledWith({
    rules: [{ preset: preset.id, options: { notify_failure: true } }],
  });
  await user.click(screen.getByRole("button", { name: "加入筛选" }));
  expect(onEventTypes).toHaveBeenCalledWith(["push", "workflow_run.completed"]);
  await user.click(screen.getByRole("button", { name: /回放最近事件/ }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/aggregation/replay", "POST", {
      source_id: "source-1",
      destination_provider: "feishu",
      aggregation: value,
      event_types: ["push"],
      limit: 300,
    }),
  );
  expect(await screen.findByText("最近 36 条事件 → 2 条消息")).toBeTruthy();
});
