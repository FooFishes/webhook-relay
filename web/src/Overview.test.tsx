import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Overview } from "./Overview";
import { emptyOverview } from "./test-data";
import type { Api } from "./api";
it("shows server aggregates and opens the complete queue and failure filters", async () => {
  const api = vi.fn().mockResolvedValue({
    ...emptyOverview,
    received: 1872,
    succeeded: 7,
    failed: 1,
    success_rate: 87.5,
    attention_failed: 9,
    queue: { pending: 3, retrying: 2, sending: 1, paused: 2 },
  });
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Overview api={api as Api} onNavigate={navigate} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("1,872")).toBeTruthy();
  expect(screen.getByText("87.5%")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /当前队列/ }));
  expect(navigate).toHaveBeenLastCalledWith("deliveries", { status: "queued" });
  await user.click(screen.getByRole("button", { name: /待处理失败/ }));
  expect(navigate).toHaveBeenLastCalledWith("deliveries", { status: "failed" });
  expect(screen.queryByText(/接入指引|第一步|创建第一个/)).toBeNull();
});
it("shows an absent rate for a workspace with no completed deliveries", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Overview
        api={vi.fn().mockResolvedValue(emptyOverview) as Api}
        onNavigate={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("—")).toBeTruthy();
  expect(screen.getByText("暂无转发规则")).toBeTruthy();
  expect(screen.queryByText("100.0%")).toBeNull();
});
