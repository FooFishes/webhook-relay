import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageComposer } from "./MessageComposer";
import type { SourceProvider, DestinationProvider } from "./types";
import type { Api } from "./api";
const text = (value: string) => ({
  msg_type: "text",
  content: { text: value },
});
const source: SourceProvider = {
  id: "apple",
  name: "Apple",
  category: "",
  fields: [],
  defaults: {},
  event_types: {},
  sample: { data: { id: "sample" } },
};
const provider: DestinationProvider = {
  id: "feishu",
  name: "飞书",
  category: "",
  fields: [],
  defaults: {},
  editor: "feishu",
  message_types: {},
  default_template: text("默认"),
};
afterEach(() => vi.useRealTimers());
it("debounces edits and rejects late preview results from earlier drafts", async () => {
  vi.useFakeTimers();
  const resolves: ((value: unknown) => void)[] = [];
  const api = vi.fn(
    () => new Promise((resolve) => resolves.push(resolve)),
  ) as unknown as Api;
  const props = {
    active: true,
    api,
    sourceName: "应用",
    sourceProvider: source,
    provider,
    onChange: vi.fn(),
  };
  const view = render(<MessageComposer {...props} value={text("旧草稿")} />);
  await act(() => vi.advanceTimersByTimeAsync(600));
  view.rerender(<MessageComposer {...props} value={text("新草稿")} />);
  await act(() => vi.advanceTimersByTimeAsync(600));
  await act(async () => {
    resolves[1]({ payload: text("新预览") });
  });
  await act(async () => {
    resolves[0]({ payload: text("过期预览") });
  });
  expect(screen.getByText("新预览")).toBeTruthy();
  expect(screen.queryByText("过期预览")).toBeNull();
  expect(api).toHaveBeenCalledTimes(2);
  view.rerender(
    <MessageComposer {...props} active={false} value={text("关闭后的草稿")} />,
  );
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(api).toHaveBeenCalledTimes(2);
});
