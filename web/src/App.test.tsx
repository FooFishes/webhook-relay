import { expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { emptyOverview } from "./test-data";
import { defaultTemplate, testMeta } from "./test-data";
afterEach(() => vi.unstubAllGlobals());
it("logs in, loads the workspace, and keeps credentials out of browser storage", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (input: string) =>
        new Response(
          JSON.stringify(
            input.endsWith("/meta")
              ? {
                  ...testMeta,
                  public_url: "http://localhost:8080",
                  default_template: defaultTemplate,
                }
              : input.includes("/overview")
                ? emptyOverview
                : [],
          ),
          { status: 200 },
        ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("管理令牌"),
    "a-very-private-admin-token-12345678",
  );
  await user.click(screen.getByRole("button", { name: /进入控制台/ }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "概览" })).toBeTruthy(),
  );
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  await user.click(screen.getByRole("button", { name: "退出" }));
  expect(screen.getByLabelText("管理令牌")).toHaveProperty("value", "");
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});
it("shows a failed login and stays on the login screen", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "管理令牌无效" }), {
        status: 401,
      }),
    ),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <App />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("管理令牌"), "wrong");
  await user.click(screen.getByRole("button", { name: /进入控制台/ }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "管理令牌无效",
  );
});
