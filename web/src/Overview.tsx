import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Select, Table } from "@cloudflare/kumo";
import {
  ArrowClockwise,
  ArrowRight,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Api } from "./api";
import type { Navigate, OverviewData, Meta, Resource } from "./types";
import { formatTime } from "./types";
import { errorName, eventName } from "./presentation";

export function Overview({
  api,
  onNavigate,
  meta,
  sources = [],
}: {
  api: Api;
  meta?: Meta;
  sources?: Resource[];
  onNavigate: Navigate;
}) {
  const [hours, setHours] = useState(24);
  const query = useQuery({
    queryKey: ["overview", hours],
    queryFn: () => api<OverviewData>(`/overview?hours=${hours}`),
    refetchInterval: 5000,
  });
  if (query.isPending) return <p role="status">正在加载运行数据…</p>;
  if (query.error)
    return (
      <div role="alert" className="error-box">
        {query.error.message}
        <Button onClick={() => void query.refetch()}>重试</Button>
      </div>
    );
  const d = query.data!;
  const queued = d.queue.pending + d.queue.retrying + d.queue.sending;
  return (
    <div className="grid gap-6">
      <div className="section-toolbar">
        <span className="text-kumo-subtle">
          更新于 {formatTime(d.window.until)}
        </span>
        <div className="flex gap-2">
          <Select<number>
            aria-label="统计时间范围"
            value={hours}
            onValueChange={(v) => setHours(v || 24)}
            items={[
              { value: 24, label: "过去 24 小时" },
              { value: 168, label: "过去 7 天" },
            ]}
          />
          <Button
            icon={<ArrowClockwise size={16} />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            刷新
          </Button>
        </div>
      </div>
      <div className="metrics-grid">
        <div className="metric">
          <span>接收事件</span>
          <span className="metric-value">{d.received.toLocaleString()}</span>
          <span className="text-kumo-subtle">所选时间内接收</span>
        </div>
        <div className="metric">
          <span>投递成功率</span>
          <span className="metric-value">
            {d.success_rate === null ? "—" : `${d.success_rate.toFixed(1)}%`}
          </span>
          <span className="text-kumo-subtle">
            已结束投递：{d.succeeded} 成功 / {d.failed} 失败
          </span>
        </div>
        <button
          className="metric"
          onClick={() => onNavigate("deliveries", { status: "queued" })}
        >
          <span>当前队列</span>
          <span className="metric-value">{queued.toLocaleString()}</span>
          <span className="text-kumo-subtle">
            发送中 {d.queue.sending} · 待重试 {d.queue.retrying} · 暂停{" "}
            {d.queue.paused}
          </span>
        </button>
        <button
          className={`metric ${d.attention_failed ? "metric-attention" : ""}`}
          onClick={() => onNavigate("deliveries", { status: "failed" })}
        >
          <span>待处理失败</span>
          <span className="metric-value">
            {d.attention_failed.toLocaleString()}
          </span>
          <span className="text-kumo-subtle">
            所有时间的失败任务 <ArrowRight size={14} />
          </span>
        </button>
      </div>
      <section className="dashboard-panel">
        <div className="section-toolbar">
          <h2>事件与投递趋势</h2>
          <div className="chart-legend">
            <span>
              <i className="legend-received" />
              接收
            </span>
            <span>
              <i className="legend-success" />
              成功
            </span>
            <span>
              <i className="legend-failed" />
              失败
            </span>
          </div>
        </div>
        <Trend series={d.series} hours={hours} />
        <p className="text-kumo-subtle">
          接收按事件接收时间统计；成功和失败按任务结束时间统计。
        </p>
      </section>
      <section>
        <div className="section-toolbar mb-3">
          <h2>规则运行状态</h2>
          <Button variant="ghost" onClick={() => onNavigate("routes")}>
            管理规则 <ArrowRight size={14} />
          </Button>
        </div>
        {d.routes.length === 0 ? (
          <div className="compact-empty">暂无转发规则</div>
        ) : (
          <div className="table-shell">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>规则</Table.Head>
                  <Table.Head>连接</Table.Head>
                  <Table.Head>运行状态</Table.Head>
                  <Table.Head>队列</Table.Head>
                  <Table.Head>失败</Table.Head>
                  <Table.Head>最近投递</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {d.routes.map((r) => (
                  <Table.Row key={r.id}>
                    <Table.Cell>
                      <Button
                        variant="ghost"
                        className="justify-start"
                        onClick={() =>
                          onNavigate("deliveries", { route_id: r.id })
                        }
                      >
                        {r.name}
                      </Button>
                    </Table.Cell>
                    <Table.Cell>
                      {r.source_name || "已删除来源"} →{" "}
                      {r.destination_name || "已删除目标"}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge
                        variant={
                          !r.enabled ||
                          !r.destination_enabled ||
                          !r.source_enabled
                            ? "neutral"
                            : r.failed
                              ? "warning"
                              : "success"
                        }
                      >
                        {!r.enabled
                          ? "规则停用"
                          : !r.source_enabled
                            ? "来源停用"
                            : !r.destination_enabled
                              ? "目标停用"
                              : r.failed
                                ? "有失败任务"
                                : "已启用"}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>{r.queued}</Table.Cell>
                    <Table.Cell>
                      {r.failed ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            onNavigate("deliveries", {
                              route_id: r.id,
                              status: "failed",
                            })
                          }
                        >
                          {r.failed} 条
                        </Button>
                      ) : (
                        "0"
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {r.last_delivery_at
                        ? formatTime(r.last_delivery_at)
                        : "—"}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </section>
      <div className="dashboard-columns">
        <section className="dashboard-panel">
          <div className="section-toolbar">
            <h2>失败投递</h2>
            <Button
              variant="ghost"
              onClick={() => onNavigate("deliveries", { status: "failed" })}
            >
              全部
            </Button>
          </div>
          {!d.recent_failed.length ? (
            <div className="compact-empty">当前没有失败任务</div>
          ) : (
            d.recent_failed.map((row) => (
              <button
                key={row.id}
                className="activity-row"
                onClick={() =>
                  onNavigate("deliveries", {
                    status: "failed",
                    route_id: row.route_id,
                    selected_id: row.id,
                  })
                }
              >
                <WarningCircle
                  size={18}
                  className="text-kumo-danger shrink-0"
                />
                <div className="grow min-w-0">
                  <span className="font-medium">
                    {row.route_name || "已删除规则"}
                  </span>
                  <p>{errorName(row.last_error)}</p>
                  <p className="text-kumo-subtle">
                    {row.destination_name || "已删除目标"} ·{" "}
                    {formatTime(row.updated_at)}
                  </p>
                </div>
                <ArrowRight size={16} />
              </button>
            ))
          )}
        </section>
        <section className="dashboard-panel">
          <div className="section-toolbar">
            <h2>最近接收</h2>
            <Button variant="ghost" onClick={() => onNavigate("events")}>
              全部
            </Button>
          </div>
          {!d.recent_events.length ? (
            <div className="compact-empty">暂无接收记录</div>
          ) : (
            d.recent_events.map((row) => (
              <button
                key={row.id}
                className="activity-row"
                onClick={() => onNavigate("deliveries", { event_id: row.id })}
              >
                <div className="grow min-w-0">
                  <span className="font-medium">
                    {eventName(
                      row.event_type,
                      meta?.source_providers.find(
                        (p) =>
                          p.id ===
                          sources.find((r) => r.id === row.source_id)?.config
                            .provider,
                      )?.event_types,
                    )}
                  </span>
                  <p className="text-kumo-subtle">
                    {row.source_name || "已删除来源"} ·{" "}
                    {formatTime(row.created_at)}
                  </p>
                </div>
                <span>{row.deliveries} 次投递</span>
                <ArrowRight size={16} />
              </button>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
function Trend({
  series,
  hours,
}: {
  series: OverviewData["series"];
  hours: number;
}) {
  const max = Math.max(
    1,
    ...series.flatMap((x) => [x.events, x.succeeded, x.failed]),
  );
  const label = (start: number) =>
    new Date(start * 1000).toLocaleString(
      "zh-CN",
      hours === 24
        ? { hour: "2-digit", minute: "2-digit", hour12: false }
        : { month: "numeric", day: "numeric" },
    );
  return (
    <div className="trend-chart" aria-label="事件与投递统计图">
      <div className="chart-scale">
        <span>{max}</span>
        <span>0</span>
      </div>
      <div className="chart-columns">
        {series.map((row, i) => (
          <div className="chart-column" key={row.start}>
            <div
              className="chart-bars"
              tabIndex={0}
              aria-label={`${label(row.start)}：接收 ${row.events}，成功 ${row.succeeded}，失败 ${row.failed}`}
              title={`${label(row.start)}\n接收 ${row.events}\n成功 ${row.succeeded}\n失败 ${row.failed}`}
            >
              {(["events", "succeeded", "failed"] as const).map((key) => (
                <span
                  key={key}
                  className={`chart-bar bar-${key}`}
                  style={{ height: `${(row[key] / max) * 100}%` }}
                />
              ))}
            </div>
            <span className="chart-label">
              {hours === 168 || i % 4 === 0 || i === series.length - 1
                ? label(row.start)
                : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
