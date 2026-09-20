import { useState } from "react";
import { expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeyPicker } from "./KeyPicker";
import { resource } from "./test-data";
import type { Api } from "./api";
it("creates and selects a key inline without submitting the parent configuration", async () => {
  const api = vi
    .fn()
    .mockResolvedValue(
      resource("keys", "key-new", "新签名", { has_value: true }),
    );
  const outerSubmit = vi.fn();
  function Harness() {
    const [id, setId] = useState<string | null>("");
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          outerSubmit();
        }}
      >
        <KeyPicker
          label="Apple 验签密钥"
          keys={[]}
          value={id}
          onChange={setId}
          api={api as Api}
        />
      </form>
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "新建" }));
  await user.type(screen.getByLabelText("密钥名称"), "新签名");
  await user.type(screen.getByLabelText("密钥值"), "local-only-value");
  await user.click(screen.getByRole("button", { name: /创建并使用/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: /Apple 验签密钥/ }).textContent,
    ).toContain("新签名"),
  );
  expect(outerSubmit).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledWith("/resources/keys", "POST", {
    name: "新签名",
    config: { value: "local-only-value" },
  });
  expect(document.querySelector('input[type="password"]')).toBeNull();
});
