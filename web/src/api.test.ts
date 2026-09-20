import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, HttpError } from "./api";
afterEach(() => vi.unstubAllGlobals());
describe("admin API client", () => {
  it("sends bearer credentials only in headers and encodes JSON", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "one" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    await createApi("private-token")("/resources/keys", "POST", {
      name: "test",
      config: { value: 'quote"\n' },
    });
    expect(fetch.mock.calls[0][0]).toBe("/api/resources/keys");
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer private-token",
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body).config.value).toBe(
      'quote"\n',
    );
  });
  it("preserves server validation and conflict errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "配置已更新" }), {
          status: 409,
        }),
      ),
    );
    await expect(createApi("token")("/resources/routes")).rejects.toMatchObject(
      { message: "配置已更新", status: 409 },
    );
  });
  it("reports invalid proxy responses without leaking HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>private proxy response</html>", { status: 502 }),
        ),
    );
    await expect(createApi("token")("/meta")).rejects.toBeInstanceOf(HttpError);
  });
});
