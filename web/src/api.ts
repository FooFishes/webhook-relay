export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export function createApi(token: string) {
  return async function api<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response
      .json()
      .catch(() => ({ error: "服务器返回了无法解析的响应" }));
    if (!response.ok)
      throw new HttpError(
        data.error || `请求失败 (${response.status})`,
        response.status,
      );
    return data as T;
  };
}
export type Api = ReturnType<typeof createApi>;
