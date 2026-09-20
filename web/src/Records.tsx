import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Dialog, Input, Select, Table } from "@cloudflare/kumo";
import {
  ArrowClockwise,
  DownloadSimple,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import type { Api } from "./api";
import type {
  Kind,
  RecordRow,
  Resource,
  RecordFilters,
  Navigate,
  Meta,
} from "./types";
import { formatTime } from "./types";

import { statusNames, eventName, errorName } from "./presentation";
function Status({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === "succeeded"
          ? "success"
          : status === "failed"
            ? "error"
            : status === "retrying" || status === "unknown"
              ? "warning"
              : "neutral"
      }
    >
      {statusNames[status] || status}
    </Badge>
  );
}
export function Records({
  kind,
  api,
  data,
  initialFilters = {},
  meta,
  onNavigate,
}: {
  kind: "events" | "deliveries" | "audit";
  api: Api;
  meta?: Meta;
  data: Record<Kind, Resource[]>;
  initialFilters?: RecordFilters;
  onNavigate?: Navigate;
}) {
  const eventLabels = (sourceId?: string) =>
    meta?.source_providers.find(
      (p) =>
        p.id === data.sources.find((r) => r.id === sourceId)?.config.provider,
    )?.event_types || {};
  const eventNames = Object.assign(
    {},
    ...(meta?.source_providers || []).map((p) => p.event_types),
  );
  const [before, setBefore] = useState<number>();
  const [history, setHistory] = useState<(number | undefined)[]>([]);
  const [filter, setFilter] = useState(initialFilters.status || "");
  const [scope, setScope] = useState<RecordFilters>(initialFilters);
  const [dismissed, setDismissed] = useState(false);
  const [filterInput, setFilterInput] = useState("");
  const [selection, setSelection] = useState<RecordRow | null>(null);
  function setSelected(row: RecordRow | null) {
    setSelection(row);
    setDismissed(true);
  }
  const [retryTarget, setRetryTarget] = useState<RecordRow | null>(null);
  const [error, setError] = useState("");
  const client = useQueryClient();
  const params = new URLSearchParams({
    limit: "50",
    ...(before ? { before: String(before) } : {}),
    ...(filter ? { [kind === "audit" ? "action" : "status"]: filter } : {}),
  });
  Object.entries(scope).forEach(([key, value]) => {
    if (key === "selected_id" && value) params.set("id", value);
    if (value && !["selected_id", "status"].includes(key))
      params.set(key, value);
  });
  const query = useQuery({
    queryKey: ["records", kind, params.toString()],
    queryFn: () => api<RecordRow[]>(`/${kind}?${params}`),
    refetchInterval: before ? false : 5000,
  });
  const selectionId =
    selection?.id || (!dismissed ? scope.selected_id : undefined);
  const detail = useQuery({
    queryKey: ["record-detail", kind, selectionId],
    queryFn: () =>
      api<RecordRow[]>(
        `/${kind}?id=${encodeURIComponent(String(selectionId))}`,
      ),
    enabled: kind !== "audit" && !!selectionId,
    refetchInterval: kind === "deliveries" && selectionId ? 3000 : false,
  });
  const selected =
    detail.data?.[0] ||
    (query.data || []).find((row) => row.id === selectionId) ||
    selection;
  const attempts = useQuery({
    queryKey: ["attempts", selected?.id],
    queryFn: () => api<RecordRow[]>(`/deliveries/${selected!.id}/attempts`),
    enabled: kind === "deliveries" && !!selected,
    refetchInterval: selected ? 3000 : false,
  });
  const retry = useMutation({
    mutationFn: () => api(`/deliveries/${retryTarget!.id}/retry`, "POST"),
    onSuccess: () => {
      setRetryTarget(null);
      setError("");
      void client.invalidateQueries({ queryKey: ["records"] });
      void client.invalidateQueries({ queryKey: ["overview"] });
      void client.invalidateQueries({ queryKey: ["record-detail"] });
    },
    onError: (e) => setError(e.message),
  });
  const nameOf = (id?: string) =>
    Object.values(data)
      .flat()
      .find((r) => r.id === id)?.name ||
    id ||
    "—";
  function applyFilter(value: string) {
    setFilter(value);
    setBefore(undefined);
    setHistory([]);
  }
  function scopeFilter(key: keyof RecordFilters, value: string) {
    setScope({ ...scope, [key]: value });
    setBefore(undefined);
    setHistory([]);
  }
  const resourceFilter = (
    key: keyof RecordFilters,
    resourceKind: Kind,
    label: string,
  ) => (
    <Select<string>
      aria-label={label}
      value={scope[key] || ""}
      onValueChange={(v) => scopeFilter(key, v || "")}
      items={{
        "": "全部" + label,
        ...Object.fromEntries(data[resourceKind].map((r) => [r.id, r.name])),
        ...(scope[key] && !data[resourceKind].some((r) => r.id === scope[key])
          ? { [scope[key]!]: "已删除的" + label }
          : {}),
      }}
    />
  );
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(query.data, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `relay-${kind}-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const rows = query.data || [];
  return (
    <div className="grid gap-5">
      <div className="section-toolbar">
        <div className="flex flex-wrap gap-2 items-center">
          {kind === "deliveries" && (
            <Select<string>
              aria-label="投递状态筛选"
              value={filter}
              onValueChange={(v) => applyFilter(v || "")}
              items={{
                "": "全部状态",
                queued: "当前队列",
                pending: "等待投递",
                sending: "正在发送",
                retrying: "等待重试",
                succeeded: "投递成功",
                failed: "投递失败",
              }}
            />
          )}
          {kind === "events" && (
            <>
              {resourceFilter("source_id", "sources", "来源")}
              <Select<string>
                aria-label="事件类型筛选"
                value={scope.event_type || ""}
                onValueChange={(v) => scopeFilter("event_type", v || "")}
                items={{
                  "": "全部事件类型",
                  ...(scope.source_id
                    ? eventLabels(scope.source_id)
                    : eventNames),
                }}
              />
            </>
          )}
          {kind === "deliveries" && (
            <>
              {resourceFilter("route_id", "routes", "规则")}
              {resourceFilter("destination_id", "destinations", "目标")}
            </>
          )}
          {scope.selected_id && (
            <Button
              onClick={() => {
                scopeFilter("selected_id", "");
                setSelected(null);
              }}
            >
              指定投递 {scope.selected_id.slice(0, 8)} ×
            </Button>
          )}
          {scope.event_id && (
            <Button onClick={() => scopeFilter("event_id", "")}>
              关联事件 {scope.event_id.slice(0, 8)} ×
            </Button>
          )}
          {kind === "audit" && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                applyFilter(filterInput);
              }}
            >
              <Input
                aria-label="审计动作筛选"
                placeholder="动作，如 webhook.signature_rejected"
                value={filterInput}
                onChange={(e) => setFilterInput(e.target.value)}
              />
              <Button type="submit" icon={<MagnifyingGlass size={16} />}>
                筛选
              </Button>
            </form>
          )}
          <span className="text-kumo-subtle">
            {before ? "历史记录" : "最近记录 · 每 5 秒刷新"}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            icon={<ArrowClockwise size={16} />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            刷新
          </Button>
          <Button
            icon={<DownloadSimple size={16} />}
            disabled={!rows.length}
            onClick={download}
          >
            导出本页
          </Button>
        </div>
      </div>
      {query.isPending ? (
        <p role="status">正在加载记录…</p>
      ) : query.error ? (
        <p className="error-box" role="alert">
          {query.error.message}
        </p>
      ) : rows.length === 0 ? (
        <section className="empty-state">
          <h2>暂无匹配记录</h2>
        </section>
      ) : (
        <div className="table-shell">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>时间</Table.Head>
                <Table.Head>
                  {kind === "audit"
                    ? "操作"
                    : kind === "events"
                      ? "事件类型"
                      : "投递状态"}
                </Table.Head>
                <Table.Head>
                  {kind === "audit"
                    ? "操作者 / 资源"
                    : kind === "events"
                      ? "来源"
                      : "转发规则 / 目标"}
                </Table.Head>
                {kind === "deliveries" && <Table.Head>投递次数</Table.Head>}
                <Table.Head>详情</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell className="whitespace-nowrap">
                    {formatTime(row.created_at)}
                  </Table.Cell>
                  <Table.Cell>
                    {kind === "deliveries" ? (
                      <>
                        <Status status={row.status!} />
                        {row.last_error && (
                          <p className="text-kumo-subtle mt-1">
                            {errorName(row.last_error)}
                          </p>
                        )}
                      </>
                    ) : (
                      <code>
                        {kind === "audit"
                          ? row.action
                          : eventName(
                              row.event_type,
                              eventLabels(row.source_id),
                            )}
                      </code>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {kind === "audit" ? (
                      <>
                        <span>{row.actor}</span>
                        <p className="text-kumo-subtle break-all">
                          {nameOf(row.resource_id)}
                        </p>
                      </>
                    ) : kind === "events" ? (
                      nameOf(row.source_id)
                    ) : (
                      <>
                        {nameOf(row.route_id)}
                        <p className="text-kumo-subtle">
                          {nameOf(row.destination_id)}
                        </p>
                      </>
                    )}
                  </Table.Cell>
                  {kind === "deliveries" && (
                    <Table.Cell>
                      {row.attempts} / {row.max_attempts}
                    </Table.Cell>
                  )}
                  <Table.Cell>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => setSelected(row)}>
                        查看详情
                      </Button>
                      {kind === "deliveries" &&
                        row.status === "failed" &&
                        row.last_error !== "template_render_failed" && (
                          <Button
                            size="sm"
                            onClick={() => {
                              setRetryTarget(row);
                              setError("");
                            }}
                          >
                            重试
                          </Button>
                        )}
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-kumo-subtle">
          第 {history.length + 1} 页 · {rows.length} 条记录
        </span>
        <div className="flex gap-2">
          <Button
            disabled={!history.length}
            onClick={() => {
              setBefore(history[history.length - 1]);
              setHistory(history.slice(0, -1));
            }}
          >
            上一页
          </Button>
          <Button
            disabled={rows.length < 50}
            onClick={() => {
              setHistory([...history, before]);
              setBefore(rows[rows.length - 1].cursor);
            }}
          >
            下一页
          </Button>
        </div>
      </div>
      <Dialog.Root
        open={!!selected}
        onOpenChange={(v) => {
          if (!v) setSelected(null);
        }}
      >
        <Dialog size="xl" className="dialog-body">
          <Dialog.Title className="text-xl font-semibold">
            {kind === "deliveries" ? "投递详情" : "记录详情"}
          </Dialog.Title>
          {selected && (
            <>
              <Dialog.Description className="mt-1 text-kumo-subtle">
                {formatTime(selected.created_at)}
              </Dialog.Description>
              {kind === "audit" ? (
                <pre className="code-panel mt-5">
                  {JSON.stringify(selected, null, 2)}
                </pre>
              ) : (
                <dl className="detail-grid mt-5">
                  <div>
                    <dt>记录 ID</dt>
                    <dd>{selected.id}</dd>
                  </div>
                  {kind === "events" ? (
                    <>
                      <div>
                        <dt>来源</dt>
                        <dd>{nameOf(selected.source_id)}</dd>
                      </div>
                      <div>
                        <dt>事件类型</dt>
                        <dd>
                          {eventName(
                            selected.event_type,
                            eventLabels(selected.source_id),
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>平台事件 ID</dt>
                        <dd>{selected.provider_id}</dd>
                      </div>
                      <div className="col-span-full">
                        <dt>请求摘要 SHA-256</dt>
                        <dd>{selected.body_sha256}</dd>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <dt>状态</dt>
                        <dd>
                          <Status status={selected.status!} />
                        </dd>
                      </div>
                      <div>
                        <dt>转发规则</dt>
                        <dd>{nameOf(selected.route_id)}</dd>
                      </div>
                      <div>
                        <dt>目标平台</dt>
                        <dd>{nameOf(selected.destination_id)}</dd>
                      </div>
                      <div>
                        <dt>事件 ID</dt>
                        <dd>{selected.event_id}</dd>
                      </div>
                      <div>
                        <dt>投递次数</dt>
                        <dd>
                          {selected.attempts} / {selected.max_attempts}
                        </dd>
                      </div>
                      <div>
                        <dt>最近更新</dt>
                        <dd>
                          {selected.updated_at
                            ? formatTime(selected.updated_at)
                            : "—"}
                        </dd>
                      </div>
                      {["pending", "retrying"].includes(
                        selected.status || "",
                      ) && (
                        <div>
                          <dt>下次尝试时间</dt>
                          <dd>
                            {selected.next_attempt_at
                              ? formatTime(selected.next_attempt_at)
                              : "—"}
                          </dd>
                        </div>
                      )}
                      {selected.last_error && (
                        <div>
                          <dt>错误原因</dt>
                          <dd>{errorName(selected.last_error)}</dd>
                        </div>
                      )}
                    </>
                  )}
                </dl>
              )}
              {kind === "events" && onNavigate && (
                <Button
                  className="mt-4"
                  onClick={() =>
                    onNavigate("deliveries", { event_id: String(selected.id) })
                  }
                >
                  查看关联投递
                </Button>
              )}
            </>
          )}
          {kind === "deliveries" && (
            <section className="mt-5">
              <h3 className="mb-3">投递尝试</h3>
              {attempts.isPending ? (
                <p>正在加载…</p>
              ) : attempts.error ? (
                <p role="alert" className="error-box">
                  {attempts.error.message}
                </p>
              ) : attempts.data?.length ? (
                <div className="grid gap-3">
                  {attempts.data.map((a) => (
                    <div key={a.id} className="attempt-row">
                      <span>第 {a.attempt} 次</span>
                      <Status status={a.status!} />
                      <span>
                        HTTP {a.http_status ?? "—"} · 平台业务码{" "}
                        {a.provider_code ?? "—"}
                      </span>
                      <span className="text-kumo-subtle">
                        {formatTime(a.created_at)}
                        {a.error && " · " + errorName(a.error)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-kumo-subtle">尚未发起网络投递。</p>
              )}
            </section>
          )}
          <div className="mt-6 flex justify-end">
            <Button onClick={() => setSelected(null)}>关闭</Button>
          </div>
        </Dialog>
      </Dialog.Root>
      <Dialog.Root
        open={!!retryTarget}
        onOpenChange={(v) => {
          if (!v && !retry.isPending) setRetryTarget(null);
        }}
      >
        <Dialog size="lg" className="dialog-body">
          <Dialog.Title className="text-lg font-semibold">
            重新投递通知
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            使用接收事件时保存的目标和消息内容，再增加最多 5
            次投递机会。若平台曾收到消息但响应丢失，重试可能产生重复通知。
          </Dialog.Description>
          {error && (
            <p role="alert" className="error-box mt-4">
              {error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              disabled={retry.isPending}
              onClick={() => setRetryTarget(null)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              loading={retry.isPending}
              onClick={() => retry.mutate()}
            >
              确认重试
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
