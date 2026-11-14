import { useId, useState } from "react";
import { Button, Input, InputArea, Select, Switch } from "@cloudflare/kumo";
import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import type {
  AggregationBinding,
  AggregationContainer,
  AggregationNotice,
  AggregationPredicate,
  AggregationRule,
  AggregationSlot,
  ContainerBlock,
  DestinationProvider,
  JsonValue,
  PredicateTest,
  SourceProvider,
} from "./types";
import { EventFilter } from "./EventFilter";
import {
  formatList,
  matches,
  parseList,
  pointerSuggestions,
  reduceLabels,
  uid,
} from "./aggregation-model";

type Change<T> = (value: T) => void;
const itemSlot = (slot?: AggregationSlot) =>
  !!slot && slot.reduce !== "count" && slot.reduce !== "derive";

// Renames a key while keeping the order of the other entries.
function renameKey<T>(record: Record<string, T>, from: string, to: string) {
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k === from ? to : k, v]),
  );
}
function move<T>(list: T[], index: number, delta: number) {
  const next = [...list];
  [next[index], next[index + delta]] = [next[index + delta], next[index]];
  return next;
}

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="aggregation-section">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <CaretDown size={14} className="replay-caret" />
        {title}
      </button>
      <div className="aggregation-collapse" data-open={open}>
        <div>
          <div className="aggregation-section-body">{children}</div>
        </div>
      </div>
    </section>
  );
}

function PointerInput({
  label,
  value,
  onChange,
  suggestions,
}: {
  label: string;
  value: string;
  onChange: Change<string>;
  suggestions: string[];
}) {
  const id = useId();
  return (
    <>
      <Input
        label={label}
        list={id}
        placeholder="/path/to/field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={id}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
}

function RowActions({
  index,
  total,
  onMove,
  onRemove,
  label,
}: {
  index: number;
  total: number;
  onMove?: (delta: number) => void;
  onRemove: () => void;
  label: string;
}) {
  return (
    <div className="row-actions flex gap-1 items-end pb-1">
      {onMove && (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            shape="square"
            aria-label={`上移${label}`}
            disabled={index === 0}
            icon={<ArrowUp size={14} />}
            onClick={() => onMove(-1)}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            shape="square"
            aria-label={`下移${label}`}
            disabled={index === total - 1}
            icon={<ArrowDown size={14} />}
            onClick={() => onMove(1)}
          />
        </>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        shape="square"
        aria-label={`删除${label}`}
        icon={<Trash size={14} />}
        onClick={onRemove}
      />
    </div>
  );
}

function FieldValues({
  value,
  onChange,
  valueLabel,
}: {
  value: Record<string, JsonValue>;
  onChange: Change<Record<string, JsonValue>>;
  valueLabel: string;
}) {
  const entries = Object.entries(value);
  return (
    <div className="grid gap-2">
      {entries.map(([field, expected], index) => (
        <div className="aggregation-row" key={index}>
          <Input
            label="字段"
            value={field}
            onChange={(e) => onChange(renameKey(value, field, e.target.value))}
          />
          <Input
            label={valueLabel}
            value={
              Array.isArray(expected)
                ? formatList(expected)
                : String(expected ?? "")
            }
            onChange={(e) => {
              const list = parseList(e.target.value);
              onChange({
                ...value,
                [field]: list.length === 1 ? list[0] : list,
              });
            }}
          />
          <RowActions
            index={index}
            total={entries.length}
            label="字段"
            onRemove={() =>
              onChange(
                Object.fromEntries(entries.filter((_, i) => i !== index)),
              )
            }
          />
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        icon={<Plus size={14} />}
        onClick={() =>
          onChange({ ...value, [`field${entries.length + 1}`]: "" })
        }
      >
        添加字段
      </Button>
    </div>
  );
}

const tests: Record<PredicateTest, string> = {
  all: "全部满足",
  any: "任一满足",
  none: "都不满足",
  exists: "已有数据",
};
function PredicateEditor({
  label,
  value,
  slots,
  optional,
  onChange,
}: {
  label: string;
  value?: AggregationPredicate;
  slots: string[];
  optional?: boolean;
  onChange: Change<AggregationPredicate | undefined>;
}) {
  const test =
    (Object.keys(tests) as PredicateTest[]).find(
      (t) => value?.[t] !== undefined,
    ) || "all";
  return (
    <div className="grid gap-3">
      {optional && (
        <Switch
          label={label}
          checked={!!value}
          onCheckedChange={(on) =>
            onChange(on ? { slot: slots[0] || "", all: {} } : undefined)
          }
        />
      )}
      {value && (
        <>
          <div className="form-columns">
            <Select<string>
              className="w-full"
              label={optional ? "数据" : label}
              value={value.slot}
              items={Object.fromEntries(slots.map((s) => [s, s]))}
              onValueChange={(slot) => onChange({ ...value, slot: slot || "" })}
            />
            <Select<string>
              className="w-full"
              label="判断"
              value={test}
              items={tests}
              onValueChange={(next) => {
                const t = (next || "all") as PredicateTest;
                onChange({
                  slot: value.slot,
                  ...(t === "exists"
                    ? { exists: true }
                    : { [t]: test === "exists" ? {} : value[test] }),
                });
              }}
            />
          </div>
          {test !== "exists" && (
            <FieldValues
              valueLabel="可选值（逗号分隔）"
              value={(value[test] as Record<string, JsonValue>) || {}}
              onChange={(fields) =>
                onChange({ slot: value.slot, [test]: fields })
              }
            />
          )}
        </>
      )}
    </div>
  );
}

function BindingEditor({
  binding,
  slot,
  events,
  suggestions,
  onChange,
}: {
  binding: AggregationBinding;
  slot: AggregationSlot;
  events: string[];
  suggestions: string[];
  onChange: Change<AggregationBinding>;
}) {
  const map = binding.map || {};
  const fields = Object.entries(map);
  return (
    <div className="aggregation-binding">
      <div className="form-columns">
        <Select<string>
          className="w-full"
          label="事件"
          value={binding.event}
          items={Object.fromEntries(
            [...new Set([binding.event, ...events])]
              .filter(Boolean)
              .map((e) => [e, e]),
          )}
          onValueChange={(event) =>
            onChange({ ...binding, event: event || "" })
          }
        />
        {slot.reduce === "keyed" && (
          <PointerInput
            label="键"
            value={binding.key || ""}
            suggestions={suggestions}
            onChange={(key) => onChange({ ...binding, key })}
          />
        )}
      </div>
      <div className="aggregation-row">
        <PointerInput
          label="条件字段（可选）"
          value={binding.when?.pointer || ""}
          suggestions={suggestions}
          onChange={(pointer) =>
            onChange({
              ...binding,
              when: pointer ? { ...binding.when, pointer } : undefined,
            })
          }
        />
        <Select<string>
          className="w-full"
          label="条件"
          value={binding.when?.in ? "in" : "not_in"}
          disabled={!binding.when}
          items={{ in: "属于", not_in: "不属于" }}
          onValueChange={(mode) => {
            const values = binding.when?.in || binding.when?.not_in || [];
            onChange({
              ...binding,
              when: { pointer: binding.when!.pointer, [mode || "in"]: values },
            });
          }}
        />
        <Input
          label="值（逗号分隔）"
          disabled={!binding.when}
          value={formatList(binding.when?.in || binding.when?.not_in)}
          onChange={(e) => {
            const mode = binding.when?.in ? "in" : "not_in";
            onChange({
              ...binding,
              when: {
                pointer: binding.when!.pointer,
                [mode]: parseList(e.target.value),
              },
            });
          }}
        />
      </div>
      {slot.reduce !== "count" && (
        <div className="grid gap-2">
          {fields.map(([field, pointer], index) => (
            <div className="aggregation-row" key={index}>
              <Input
                label="字段名"
                value={field}
                onChange={(e) =>
                  onChange({
                    ...binding,
                    map: renameKey(map, field, e.target.value),
                  })
                }
              />
              <PointerInput
                label="取自"
                value={pointer}
                suggestions={suggestions}
                onChange={(p) =>
                  onChange({ ...binding, map: { ...map, [field]: p } })
                }
              />
              <RowActions
                index={index}
                total={fields.length}
                label="字段"
                onRemove={() =>
                  onChange({
                    ...binding,
                    map: Object.fromEntries(
                      fields.filter((_, i) => i !== index),
                    ),
                  })
                }
              />
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() =>
              onChange({
                ...binding,
                map: { ...map, [`field${fields.length + 1}`]: "" },
              })
            }
          >
            添加字段
          </Button>
        </div>
      )}
    </div>
  );
}

function SlotEditor({
  name,
  slot,
  rule,
  events,
  suggestions,
  onRename,
  onChange,
  onRemove,
}: {
  name: string;
  slot: AggregationSlot;
  rule: AggregationRule;
  events: string[];
  suggestions: string[];
  onRename: Change<string>;
  onChange: Change<AggregationSlot>;
  onRemove: () => void;
}) {
  const changeReduce = (reduce: AggregationSlot["reduce"]) => {
    if (reduce === "derive") onChange({ reduce, op: "worst", of: [] });
    else {
      const from =
        "from" in slot ? slot.from : [{ event: events[0] || "", map: {} }];
      onChange({
        reduce,
        from: from.map((b) => ({
          ...b,
          key: reduce === "keyed" ? b.key || "" : undefined,
          map: reduce === "count" ? undefined : b.map || {},
        })),
      } as AggregationSlot);
    }
  };
  return (
    <div className="aggregation-slot">
      <div className="aggregation-row">
        <Input
          label="名称"
          value={name}
          onChange={(e) => onRename(e.target.value)}
        />
        <Select<string>
          className="w-full"
          label="归并方式"
          value={slot.reduce}
          items={reduceLabels}
          onValueChange={(r) =>
            r && changeReduce(r as AggregationSlot["reduce"])
          }
        />
        <RowActions
          index={0}
          total={1}
          label={`数据 ${name}`}
          onRemove={onRemove}
        />
      </div>
      {slot.reduce === "keyed" && (
        <Input
          label="终态（到达后不再回退，逗号分隔）"
          value={formatList(slot.final)}
          onChange={(e) =>
            onChange({ ...slot, final: parseList(e.target.value) })
          }
        />
      )}
      {slot.reduce === "append" && (
        <Input
          label="保留条数"
          type="number"
          min={1}
          max={200}
          value={slot.limit ?? 50}
          onChange={(e) => onChange({ ...slot, limit: Number(e.target.value) })}
        />
      )}
      {slot.reduce === "derive" ? (
        <Input
          label="取最严重结果，来源（slot.field，逗号分隔）"
          value={slot.of.join(", ")}
          onChange={(e) =>
            onChange({ ...slot, of: parseList(e.target.value).map(String) })
          }
        />
      ) : (
        <>
          {slot.from.map((binding, index) => (
            <div key={index} className="grid gap-2">
              <BindingEditor
                binding={binding}
                slot={slot}
                events={events}
                suggestions={suggestions}
                onChange={(b) =>
                  onChange({
                    ...slot,
                    from: slot.from.map((x, i) => (i === index ? b : x)),
                  })
                }
              />
              {slot.from.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  icon={<Trash size={14} />}
                  onClick={() =>
                    onChange({
                      ...slot,
                      from: slot.from.filter((_, i) => i !== index),
                    })
                  }
                >
                  删除来源
                </Button>
              )}
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() =>
              onChange({
                ...slot,
                from: [
                  ...slot.from,
                  {
                    event: rule.group.match[0] || "",
                    ...(slot.reduce === "keyed" ? { key: "" } : {}),
                    ...(slot.reduce === "count" ? {} : { map: {} }),
                  },
                ],
              } as AggregationSlot)
            }
          >
            添加来源事件
          </Button>
        </>
      )}
    </div>
  );
}

function ContainerEditor({
  container,
  rule,
  target,
  forNotice,
  onChange,
}: {
  container: AggregationContainer;
  rule: AggregationRule;
  target: DestinationProvider;
  forNotice?: boolean;
  onChange: Change<AggregationContainer>;
}) {
  const slots = Object.keys(rule.slots);
  const accentBySlot = typeof container.accent === "object";
  const accents = target.accents || {};
  const setBlock = (index: number, block: ContainerBlock) =>
    onChange({
      ...container,
      blocks: container.blocks.map((b, i) => (i === index ? block : b)),
    });
  const variables = (block: ContainerBlock) => {
    const slot = block.bind ? rule.slots[block.bind] : undefined;
    const fields =
      slot && "from" in slot
        ? [...new Set(slot.from.flatMap((b) => Object.keys(b.map || {})))]
        : [];
    return [
      ...(block.bind || forNotice ? fields.map((f) => `item.${f}`) : []),
      ...(block.bind ? ["item | duration", "item._history"] : []),
      ...slots
        .filter((s) => !rule.slots[s] || !itemSlot(rule.slots[s]))
        .map((s) => `slots.${s}`),
      "group.event_count",
      ...(forNotice ? [] : ["group.span | duration"]),
    ];
  };
  return (
    <div className="grid gap-4">
      <Input
        label="标题"
        value={container.title}
        onChange={(e) => onChange({ ...container, title: e.target.value })}
      />
      <div className="form-columns">
        <Select<string>
          className="w-full"
          label="消息样式"
          value={container.style || "card"}
          items={Object.fromEntries(
            (target.message_styles || []).map((s) => [s.id, s.name]),
          )}
          onValueChange={(style) =>
            onChange({ ...container, style: style || undefined })
          }
        />
        <Select<string>
          className="w-full"
          label="颜色"
          value={accentBySlot ? "slot" : (container.accent as string) || "blue"}
          items={{ ...accents, slot: "按数据取色" }}
          onValueChange={(accent) =>
            onChange({
              ...container,
              accent:
                accent === "slot"
                  ? { slot: slots[0] || "", map: { "*": "blue" } }
                  : accent || undefined,
            })
          }
        />
      </div>
      {typeof container.accent === "object" && (
        <div className="grid gap-2">
          <Select<string>
            className="w-full"
            label="取色数据"
            value={container.accent.slot}
            items={Object.fromEntries(slots.map((s) => [s, s]))}
            onValueChange={(slot) =>
              onChange({
                ...container,
                accent: {
                  ...(container.accent as { map: Record<string, string> }),
                  slot: slot || "",
                },
              })
            }
          />
          {Object.entries(container.accent.map).map(
            ([value, accent], index, all) => {
              const current = container.accent as {
                slot: string;
                map: Record<string, string>;
              };
              return (
                <div className="aggregation-row" key={index}>
                  <Input
                    label="数据值（* 为其余）"
                    value={value}
                    onChange={(e) =>
                      onChange({
                        ...container,
                        accent: {
                          ...current,
                          map: renameKey(current.map, value, e.target.value),
                        },
                      })
                    }
                  />
                  <Select<string>
                    className="w-full"
                    label="颜色"
                    value={accent}
                    items={accents}
                    onValueChange={(a) =>
                      onChange({
                        ...container,
                        accent: {
                          ...current,
                          map: { ...current.map, [value]: a || "blue" },
                        },
                      })
                    }
                  />
                  <RowActions
                    index={index}
                    total={all.length}
                    label="取色"
                    onRemove={() =>
                      onChange({
                        ...container,
                        accent: {
                          ...current,
                          map: Object.fromEntries(
                            all.filter((_, i) => i !== index),
                          ),
                        },
                      })
                    }
                  />
                </div>
              );
            },
          )}
          <Button
            type="button"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => {
              const current = container.accent as {
                slot: string;
                map: Record<string, string>;
              };
              onChange({
                ...container,
                accent: {
                  ...current,
                  map: {
                    ...current.map,
                    [`value${Object.keys(current.map).length}`]: "blue",
                  },
                },
              });
            }}
          >
            添加取色
          </Button>
        </div>
      )}
      {container.blocks.map((block, index) => (
        <div className="aggregation-block" key={block.id}>
          <div className="aggregation-row">
            <Select<string>
              className="w-full"
              label="区块"
              value={block.kind}
              items={{ text: "文本", link: "链接", repeat: "列表" }}
              onValueChange={(kind) => {
                const next = {
                  ...block,
                  kind: (kind || "text") as ContainerBlock["kind"],
                };
                if (next.kind === "link") next.url = next.url || "";
                else delete next.url;
                setBlock(index, next);
              }}
            />
            <Select<string>
              className="w-full"
              label="数据"
              value={block.bind || ""}
              items={Object.fromEntries([
                ["", "不绑定"],
                ...slots
                  .filter((s) => itemSlot(rule.slots[s]))
                  .map((s) => [s, s]),
              ])}
              onValueChange={(bind) =>
                setBlock(index, { ...block, bind: bind || undefined })
              }
            />
            <Input
              label="标签"
              value={block.label || ""}
              onChange={(e) =>
                setBlock(index, {
                  ...block,
                  label: e.target.value || undefined,
                })
              }
            />
            <RowActions
              index={index}
              total={container.blocks.length}
              label="区块"
              onMove={(d) =>
                onChange({
                  ...container,
                  blocks: move(container.blocks, index, d),
                })
              }
              onRemove={() =>
                onChange({
                  ...container,
                  blocks: container.blocks.filter((_, i) => i !== index),
                })
              }
            />
          </div>
          <InputArea
            label={
              block.kind === "repeat"
                ? "每一项"
                : block.kind === "link"
                  ? "链接文字"
                  : "内容"
            }
            rows={2}
            value={block.text}
            onChange={(e) =>
              setBlock(index, { ...block, text: e.target.value })
            }
          />
          <div className="aggregation-variables">
            {variables(block).map((v) => (
              <button
                type="button"
                key={v}
                onClick={() =>
                  setBlock(index, { ...block, text: `${block.text}{{ ${v} }}` })
                }
              >
                {v}
              </button>
            ))}
          </div>
          <div className="aggregation-row">
            {block.kind === "link" && (
              <Input
                label="链接地址"
                value={block.url || ""}
                onChange={(e) =>
                  setBlock(index, { ...block, url: e.target.value })
                }
              />
            )}
            {block.kind === "repeat" && (
              <Input
                label="最多显示"
                type="number"
                min={1}
                value={block.limit ?? 20}
                onChange={(e) =>
                  setBlock(index, { ...block, limit: Number(e.target.value) })
                }
              />
            )}
            <Select<string>
              className="w-full"
              label="展示"
              value={block.style || ""}
              items={Object.fromEntries([
                ["", "默认"],
                ...(target.block_styles || [])
                  .filter(
                    (s) =>
                      s.id !== "default" &&
                      s.kinds.includes(block.kind === "link" ? "link" : "text"),
                  )
                  .map((s) => [s.id, s.name]),
              ])}
              onValueChange={(style) =>
                setBlock(index, { ...block, style: style || undefined })
              }
            />
          </div>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        icon={<Plus size={14} />}
        onClick={() =>
          onChange({
            ...container,
            blocks: [
              ...container.blocks,
              { id: uid("block"), kind: "text", text: "" },
            ],
          })
        }
      >
        添加区块
      </Button>
    </div>
  );
}

export function AggregationRuleEditor({
  rule,
  source,
  target,
  onChange,
}: {
  rule: AggregationRule;
  source: SourceProvider;
  target: DestinationProvider;
  onChange: Change<AggregationRule>;
}) {
  const match = rule.group.match;
  const events = [
    ...new Set([
      ...match,
      ...Object.keys(source.event_definitions || {}).filter((e) =>
        match.some((p) => matches(p, e)),
      ),
    ]),
  ];
  const suggestions = pointerSuggestions(source, match);
  const itemSlots = Object.keys(rule.slots).filter((s) =>
    itemSlot(rule.slots[s]),
  );
  const close = rule.close;
  const setClose = (next: Partial<AggregationRule["close"]>) =>
    onChange({ ...rule, close: { ...close, ...next } });
  const number = (value: string) => (value === "" ? undefined : Number(value));
  const notices = close.notices || [];
  const setNotice = (index: number, notice: AggregationNotice) =>
    setClose({ notices: notices.map((n, i) => (i === index ? notice : n)) });
  return (
    <div className="aggregation-rule-editor">
      <Input
        label="规则名称"
        value={rule.name}
        onChange={(e) => onChange({ ...rule, name: e.target.value })}
      />
      <Section title="分组" defaultOpen>
        <EventFilter
          value={match.includes("*") ? [] : match}
          source={source}
          onChange={(next) =>
            onChange({
              ...rule,
              group: { ...rule.group, match: next.length ? next : ["*"] },
            })
          }
        />
        {rule.group.key.map((pointer, index) => (
          <div className="aggregation-row" key={index}>
            <PointerInput
              label={index ? "备选分组键" : "分组键"}
              value={pointer}
              suggestions={suggestions}
              onChange={(p) =>
                onChange({
                  ...rule,
                  group: {
                    ...rule.group,
                    key: rule.group.key.map((k, i) => (i === index ? p : k)),
                  },
                })
              }
            />
            <RowActions
              index={index}
              total={rule.group.key.length}
              label="分组键"
              onMove={(d) =>
                onChange({
                  ...rule,
                  group: { ...rule.group, key: move(rule.group.key, index, d) },
                })
              }
              onRemove={() =>
                onChange({
                  ...rule,
                  group: {
                    ...rule.group,
                    key: rule.group.key.filter((_, i) => i !== index),
                  },
                })
              }
            />
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          icon={<Plus size={14} />}
          onClick={() =>
            onChange({
              ...rule,
              group: { ...rule.group, key: [...rule.group.key, ""] },
            })
          }
        >
          添加分组键
        </Button>
      </Section>
      <Section title={`数据 · ${Object.keys(rule.slots).length}`}>
        {Object.entries(rule.slots).map(([name, slot], index) => (
          <SlotEditor
            key={index}
            name={name}
            slot={slot}
            rule={rule}
            events={events}
            suggestions={suggestions}
            onRename={(to) =>
              onChange({ ...rule, slots: renameKey(rule.slots, name, to) })
            }
            onChange={(next) =>
              onChange({ ...rule, slots: { ...rule.slots, [name]: next } })
            }
            onRemove={() =>
              onChange({
                ...rule,
                slots: Object.fromEntries(
                  Object.entries(rule.slots).filter(([n]) => n !== name),
                ),
              })
            }
          />
        ))}
        <Button
          type="button"
          size="sm"
          icon={<Plus size={14} />}
          onClick={() =>
            onChange({
              ...rule,
              slots: {
                ...rule.slots,
                [`slot${Object.keys(rule.slots).length + 1}`]: {
                  reduce: "last",
                  from: [{ event: events[0] || "", map: {} }],
                },
              },
            })
          }
        >
          添加数据
        </Button>
      </Section>
      <Section title="结束条件">
        <PredicateEditor
          label="完成后静默发出"
          optional
          value={close.when}
          slots={itemSlots}
          onChange={(when) =>
            setClose({ when, settle: when ? (close.settle ?? 20) : undefined })
          }
        />
        {close.when && (
          <Input
            label="静默秒数"
            type="number"
            min={0}
            value={close.settle ?? 0}
            onChange={(e) => setClose({ settle: Number(e.target.value) })}
          />
        )}
        <PredicateEditor
          label="进行中时不按空闲发出"
          optional
          value={close.pending}
          slots={itemSlots}
          onChange={(pending) => setClose({ pending })}
        />
        <div className="form-columns">
          <Input
            label="空闲秒数（可选）"
            type="number"
            min={0}
            value={close.idle ?? ""}
            onChange={(e) => setClose({ idle: number(e.target.value) })}
          />
          <Input
            label="最长等待秒数"
            type="number"
            min={1}
            max={86400}
            value={close.max_wait}
            onChange={(e) => setClose({ max_wait: Number(e.target.value) })}
          />
          <Input
            label="事件上限"
            type="number"
            min={1}
            max={500}
            value={close.max_events ?? 200}
            onChange={(e) => setClose({ max_events: Number(e.target.value) })}
          />
        </div>
      </Section>
      <Section title={`阶段提醒 · ${notices.length}`}>
        {notices.map((notice, index) => (
          <div className="aggregation-slot" key={notice.id}>
            <PredicateEditor
              label="触发条件"
              value={notice.when}
              slots={itemSlots}
              onChange={(when) => when && setNotice(index, { ...notice, when })}
            />
            <div className="flex items-center justify-between">
              <Switch
                label="每一项各提醒一次"
                checked={!!notice.once_per_item}
                disabled={!notice.when.any}
                onCheckedChange={(once) =>
                  setNotice(index, { ...notice, once_per_item: once })
                }
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon={<Trash size={14} />}
                onClick={() =>
                  setClose({ notices: notices.filter((_, i) => i !== index) })
                }
              >
                删除提醒
              </Button>
            </div>
            <ContainerEditor
              container={notice.container}
              rule={rule}
              target={target}
              forNotice
              onChange={(container) =>
                setNotice(index, { ...notice, container })
              }
            />
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          icon={<Plus size={14} />}
          onClick={() =>
            setClose({
              notices: [
                ...notices,
                {
                  id: uid("notice"),
                  when: { slot: itemSlots[0] || "", exists: true },
                  container: {
                    title: rule.name,
                    blocks: [{ id: "text", kind: "text", text: "" }],
                  },
                },
              ],
            })
          }
        >
          添加提醒
        </Button>
      </Section>
      <Section title="汇总消息">
        <ContainerEditor
          container={rule.container}
          rule={rule}
          target={target}
          onChange={(container) => onChange({ ...rule, container })}
        />
      </Section>
    </div>
  );
}
