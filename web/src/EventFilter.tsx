import { useState } from "react";
import { Button, Checkbox, Input, Select } from "@cloudflare/kumo";
import { CaretDown, MagnifyingGlass } from "@phosphor-icons/react";
import type { SourceProvider } from "./types";
import { eventCatalog } from "./message-policy";

export function EventFilter({
  value,
  source,
  onChange,
}: {
  value: string[];
  source?: SourceProvider;
  onChange: (v: string[]) => void;
}) {
  const [custom, setCustom] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const catalog: [string, { name: string; group?: string }][] =
    source?.event_definitions
      ? eventCatalog(source)
      : Object.entries(source?.event_types || {}).map(([key, name]) => [
          key,
          { name },
        ]);
  // Selected types outside the catalog stay visible so they can be removed.
  const entries = [
    ...catalog,
    ...value
      .filter((key) => !catalog.some(([k]) => k === key))
      .map((key): [string, { name: string; group?: string }] => [
        key,
        { name: key, group: "自定义事件" },
      ]),
  ];
  const query = search.trim().toLowerCase();
  const shown = entries.filter(
    ([key, d]) => !query || `${d.name} ${key}`.toLowerCase().includes(query),
  );
  const groups = [...new Set(entries.map(([, d]) => d.group || "事件"))];
  // An empty list means every event, so the last selected event cannot be removed.
  const set = (next: string[]) => next.length && onChange(next);
  return (
    <div className="grid gap-3">
      <Select<string>
        label="匹配事件"
        value={value.length ? "selected" : "all"}
        items={{ all: "全部事件", selected: "指定事件" }}
        onValueChange={(v) =>
          onChange(v === "all" ? [] : [catalog[0]?.[0] || "customEvent"])
        }
      />
      {value.length > 0 && (
        <div className="event-picker">
          <div className="event-picker-bar">
            <div className="event-search">
              <MagnifyingGlass size={16} />
              <input
                aria-label="搜索事件"
                placeholder="搜索事件…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <span>已选 {value.length} 个</span>
          </div>
          <div className="event-picker-groups">
            {groups.map((group) => {
              const keys = shown
                .filter(([, d]) => (d.group || "事件") === group)
                .map(([key]) => key);
              if (!keys.length) return null;
              const total = entries.filter(
                ([, d]) => (d.group || "事件") === group,
              ).length;
              const picked = keys.filter((key) => value.includes(key));
              const open = !!query || expanded.includes(group);
              const rest = value.filter((key) => !keys.includes(key));
              return (
                <section className="event-picker-group" key={group}>
                  <div className="event-picker-head">
                    <Checkbox
                      aria-label={`选择全部${group}事件`}
                      checked={picked.length === keys.length}
                      indeterminate={
                        picked.length > 0 && picked.length < keys.length
                      }
                      disabled={picked.length === keys.length && !rest.length}
                      onCheckedChange={() =>
                        set(
                          picked.length === keys.length
                            ? rest
                            : [...rest, ...keys],
                        )
                      }
                    />
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() =>
                        setExpanded(
                          expanded.includes(group)
                            ? expanded.filter((g) => g !== group)
                            : [...expanded, group],
                        )
                      }
                    >
                      <span>{group}</span>
                      <span className="event-picker-count">
                        {
                          value.filter((key) =>
                            entries.some(
                              ([k, d]) =>
                                k === key && (d.group || "事件") === group,
                            ),
                          ).length
                        }
                        /{total}
                      </span>
                      <CaretDown size={14} />
                    </button>
                  </div>
                  {open && (
                    <div className="event-options">
                      {shown
                        .filter(([key]) => keys.includes(key))
                        .map(([key, d]) => (
                          <Checkbox
                            key={key}
                            label={d.name}
                            checked={value.includes(key)}
                            disabled={value.length === 1 && value[0] === key}
                            onCheckedChange={(checked) =>
                              set(
                                checked
                                  ? [...value, key]
                                  : value.filter((v) => v !== key),
                              )
                            }
                          />
                        ))}
                    </div>
                  )}
                </section>
              );
            })}
            {!shown.length && <p className="compact-empty">没有匹配的事件</p>}
          </div>
          <div className="flex gap-2">
            <Input
              aria-label="自定义事件类型"
              placeholder="自定义事件类型"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <Button
              type="button"
              disabled={!custom.trim() || value.includes(custom.trim())}
              onClick={() => {
                onChange([...value, custom.trim()]);
                setCustom("");
              }}
            >
              添加
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
