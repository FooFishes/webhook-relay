import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Badge, Button, Select, Switch } from "@cloudflare/kumo";
import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  Copy,
  PencilSimple,
  Play,
  Trash,
} from "@phosphor-icons/react";
import type { Api } from "./api";
import type {
  AggregationConfig,
  AggregationPreset,
  AggregationRule,
  DestinationProvider,
  ReplayResult,
  SourceProvider,
} from "./types";
import { formatTime } from "./types";
import {
  blankRule,
  claimedEvents,
  isPresetRef,
  reasonLabels,
  ruleOf,
  uid,
} from "./aggregation-model";
import { AggregationRuleEditor } from "./AggregationRuleEditor";
import { MessageView } from "./MessageView";

// Whole minutes and hours read better; anything else stays exact in seconds.
const seconds = (value?: number) =>
  value === undefined
    ? ""
    : value % 3600 === 0 && value
      ? `${value / 3600} 小时`
      : value % 60 === 0 && value
        ? `${value / 60} 分钟`
        : `${value} 秒`;

function closeSummary(rule: AggregationRule) {
  const close = rule.close;
  return [
    close.when && `完成后静默 ${seconds(close.settle || 0)}`,
    close.idle !== undefined && `空闲 ${seconds(close.idle)}`,
    `最长 ${seconds(close.max_wait)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function AggregationEditor({
  api,
  value,
  onChange,
  sourceId,
  source,
  target,
  presets,
  eventTypes,
  onEventTypesChange,
}: {
  api: Api;
  value?: AggregationConfig;
  onChange: (value?: AggregationConfig) => void;
  sourceId?: string;
  source: SourceProvider;
  target: DestinationProvider;
  presets: AggregationPreset[];
  eventTypes: string[];
  onEventTypesChange: (value: string[]) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const rules = value?.rules || [];
  const available = presets.filter((p) => p.source_provider === source.id);
  const set = (next: AggregationConfig["rules"]) =>
    onChange(next.length ? { rules: next } : undefined);
  const update = (index: number, rule: AggregationConfig["rules"][number]) =>
    set(rules.map((r, i) => (i === index ? rule : r)));
  const move = (index: number, delta: number) => {
    const next = [...rules];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    set(next);
  };
  // Events a rule claims never reach it when the route filter leaves them out.
  const missing = eventTypes.length
    ? claimedEvents({ rules }, presets, source).filter(
        (e) => !eventTypes.includes(e),
      )
    : [];
  const replay = useMutation({
    mutationFn: () =>
      api<ReplayResult>("/aggregation/replay", "POST", {
        source_id: sourceId,
        destination_provider: target.id,
        aggregation: { rules },
        event_types: eventTypes,
        limit: 300,
      }),
  });
  return (
    <div className="aggregation-editor">
      <div className="section-toolbar">
        <Select<string>
          aria-label="添加规则"
          placeholder="添加规则"
          value=""
          items={Object.fromEntries([
            ...available.map((p) => [p.id, p.name]),
            ["blank", "空白规则"],
          ])}
          onValueChange={(id) => {
            if (!id) return;
            if (id === "blank") {
              const rule = blankRule();
              set([...rules, rule]);
              setEditing(rule.id);
            } else set([...rules, { preset: id, options: {} }]);
          }}
        />
        <Button
          type="button"
          icon={<Play size={16} />}
          disabled={!rules.length || !sourceId}
          loading={replay.isPending}
          onClick={() => replay.mutate()}
        >
          回放最近事件
        </Button>
      </div>
      {missing.length > 0 && (
        <div className="notice-box flex items-center justify-between gap-3">
          <p>{missing.length} 个聚合事件不在事件筛选中</p>
          <Button
            type="button"
            size="sm"
            onClick={() => onEventTypesChange([...eventTypes, ...missing])}
          >
            加入筛选
          </Button>
        </div>
      )}
      {!rules.length && (
        <p className="text-kumo-subtle py-6 text-center">
          未启用聚合，事件逐条发送
        </p>
      )}
      {rules.map((entry, index) => {
        const preset = isPresetRef(entry)
          ? available.find((p) => p.id === entry.preset)
          : undefined;
        const rule = ruleOf(entry, presets);
        const key = isPresetRef(entry) ? entry.preset : entry.id;
        const open = !isPresetRef(entry) && editing === entry.id;
        return (
          <section className="aggregation-rule" key={key + index}>
            <header>
              <div className="grid gap-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3>{preset?.name || rule?.name || "未知预设"}</h3>
                  <Badge variant={preset ? "secondary" : "outline"}>
                    {preset ? "预设" : "自定义"}
                  </Badge>
                </div>
                <p className="text-kumo-subtle truncate">
                  {preset?.description || (rule && closeSummary(rule))}
                </p>
              </div>
              <div className="flex gap-1 shrink-0">
                {isPresetRef(entry) && rule ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    icon={<Copy size={16} />}
                    onClick={() => {
                      const copy = {
                        ...structuredClone(rule),
                        id: uid("rule"),
                      };
                      update(index, copy);
                      setEditing(copy.id);
                    }}
                  >
                    复制为自定义
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-expanded={open}
                    icon={
                      open ? (
                        <CaretDown size={16} />
                      ) : (
                        <PencilSimple size={16} />
                      )
                    }
                    onClick={() => setEditing(open ? null : key)}
                  >
                    {open ? "收起" : "编辑"}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  shape="square"
                  aria-label="上移"
                  disabled={index === 0}
                  icon={<ArrowUp size={16} />}
                  onClick={() => move(index, -1)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  shape="square"
                  aria-label="下移"
                  disabled={index === rules.length - 1}
                  icon={<ArrowDown size={16} />}
                  onClick={() => move(index, 1)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  shape="square"
                  aria-label="删除规则"
                  icon={<Trash size={16} />}
                  onClick={() => set(rules.filter((_, i) => i !== index))}
                />
              </div>
            </header>
            {isPresetRef(entry) &&
              preset &&
              Object.keys(preset.options).length > 0 && (
                <div className="flex flex-wrap gap-5">
                  {Object.entries(preset.options).map(([option, label]) => (
                    <Switch
                      key={option}
                      label={label}
                      checked={!!entry.options?.[option]}
                      onCheckedChange={(checked) =>
                        update(index, {
                          ...entry,
                          options: { ...entry.options, [option]: checked },
                        })
                      }
                    />
                  ))}
                </div>
              )}
            <div className="aggregation-collapse" data-open={open}>
              <div>
                {open && !isPresetRef(entry) && (
                  <AggregationRuleEditor
                    rule={entry}
                    source={source}
                    target={target}
                    onChange={(rule) => update(index, rule)}
                  />
                )}
              </div>
            </div>
          </section>
        );
      })}
      {replay.error && (
        <p role="alert" className="error-box">
          {replay.error.message}
        </p>
      )}
      {replay.data && <ReplayView result={replay.data} target={target} />}
    </div>
  );
}

function ReplayView({
  result,
  target,
}: {
  result: ReplayResult;
  target: DestinationProvider;
}) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="aggregation-replay">
      <h3>
        最近 {result.events} 条事件 → {result.messages} 条消息
      </h3>
      <p className="text-kumo-subtle">
        {result.groups.length} 组聚合 · {result.singles} 条单独发送
      </p>
      {result.groups.map((group, index) => (
        <div className="replay-group" key={index}>
          <button
            type="button"
            aria-expanded={open === index}
            onClick={() => setOpen(open === index ? null : index)}
          >
            <CaretDown size={14} className="replay-caret" />
            <span className="font-medium">{group.rule_name}</span>
            <span>
              {group.events.length} 条事件
              {group.notices.length ? ` · ${group.notices.length} 条提醒` : ""}
            </span>
            <span className="text-kumo-subtle ml-auto">
              {group.pending ? "预计 " : ""}
              {formatTime(group.flushed_at)} · {reasonLabels[group.reason]}
            </span>
          </button>
          <div className="aggregation-collapse" data-open={open === index}>
            <div>
              {open === index && (
                <div className="replay-body">
                  {group.error ? (
                    <p className="error-box">{group.error}</p>
                  ) : (
                    <MessageView provider={target} value={group.payload} />
                  )}
                  {group.notices.map((notice, i) => (
                    <div key={i} className="grid gap-2">
                      <p className="text-kumo-subtle">
                        阶段提醒 · {formatTime(notice.at)}
                      </p>
                      {notice.error ? (
                        <p className="error-box">{notice.error}</p>
                      ) : (
                        <MessageView provider={target} value={notice.payload} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
