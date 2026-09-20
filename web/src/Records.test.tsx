import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Records } from "./Records";
import { resources } from "./test-data";
import type { Api } from "./api";
it("opens delivery details as fields and attempts, while preserving drill-down filters", async () => {
  const row = {
    id: "delivery-1",
    created_at: 10,
    updated_at: 20,
    event_id: "event-1",
    route_id: "route-1",
    destination_id: "dest-1",
    status: "failed",
    attempts: 1,
    max_attempts: 2,
    last_error: "provider_rejected",
  };
  const api = vi.fn(async (path: string) =>
    path.endsWith("/attempts")
      ? [
          {
            id: 1,
            created_at: 20,
            status: "failed",
            attempt: 1,
            http_status: 200,
            provider_code: 19021,
          },
        ]
      : [row],
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Records
        kind="deliveries"
        api={api as Api}
        data={resources}
        initialFilters={{
          status: "failed",
          route_id: "route-1",
          selected_id: "delivery-1",
        }}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("heading", { name: "投递详情" })).toBeTruthy();
  expect(screen.getAllByText("平台拒绝了请求").length).toBeGreaterThan(0);
  expect(await screen.findByText(/HTTP 200/)).toBeTruthy();
  expect(document.querySelector("pre")).toBeNull();
  const params = new URLSearchParams(api.mock.calls[0][0].split("?")[1]);
  expect(params.get("route_id")).toBe("route-1");
  expect(params.get("status")).toBe("failed");
});
it("opens events without raw JSON and navigates to their related deliveries", async () => {
  const navigate = vi.fn();
  const user = userEvent.setup();
  const api = vi.fn().mockResolvedValue([
    {
      id: "event-1",
      created_at: 1,
      source_id: "source-1",
      provider_id: "apple-event",
      event_type: "buildUploadStateUpdated",
      body_sha256: "abcdef",
    },
  ]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Records
        kind="events"
        api={api as Api}
        data={resources}
        onNavigate={navigate}
      />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "查看详情" }));
  expect(screen.getByText("平台事件 ID")).toBeTruthy();
  expect(document.querySelector("pre")).toBeNull();
  await user.click(screen.getByRole("button", { name: "查看关联投递" }));
  expect(navigate).toHaveBeenCalledWith("deliveries", { event_id: "event-1" });
});
