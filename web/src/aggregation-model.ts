import type {
  AggregationConfig,
  AggregationPreset,
  AggregationPresetRef,
  AggregationRule,
  AggregationSlot,
  SourceProvider,
} from "./types";

export const isPresetRef = (
  rule: AggregationConfig["rules"][number],
): rule is AggregationPresetRef => "preset" in rule;

export const reasonLabels = {
  settled: "完成后静默结束",
  idle: "空闲超时",
  max_wait: "达到最长等待",
  max_events: "达到事件上限",
} as const;

export const reduceLabels: Record<AggregationSlot["reduce"], string> = {
  first: "首条",
  last: "最新",
  keyed: "按键合并",
  append: "逐条追加",
  count: "计数",
  derive: "计算",
};

// The same wildcard rules as the server: "*", exact, or "prefix.*".
export function matches(pattern: string, eventType: string) {
  return (
    pattern === "*" ||
    pattern === eventType ||
    (pattern.endsWith(".*") && eventType.startsWith(pattern.slice(0, -1)))
  );
}

/** Concrete rule for a list entry, expanding a preset reference. */
export function ruleOf(
  entry: AggregationConfig["rules"][number],
  presets: AggregationPreset[],
): AggregationRule | undefined {
  if (!isPresetRef(entry)) return entry;
  const preset = presets.find((p) => p.id === entry.preset);
  if (!preset) return undefined;
  const rule = structuredClone(preset.rule) as AggregationRule;
  rule.id = preset.id;
  rule.close.notices = (rule.close.notices || []).filter(
    (n) => !n.option || entry.options?.[n.option],
  );
  return rule;
}

/** Catalog events claimed by any rule. */
export function claimedEvents(
  config: AggregationConfig,
  presets: AggregationPreset[],
  source?: SourceProvider,
) {
  const patterns = config.rules.flatMap(
    (entry) => ruleOf(entry, presets)?.group.match || [],
  );
  return Object.keys(source?.event_definitions || {}).filter((event) =>
    patterns.some((p) => matches(p, event)),
  );
}

/** JSON pointers to fields the catalog documents for the given events. */
export function pointerSuggestions(
  source: SourceProvider | undefined,
  events: string[],
) {
  const pointers = new Set<string>();
  for (const [event, definition] of Object.entries(
    source?.event_definitions || {},
  ))
    if (events.some((p) => matches(p, event)))
      for (const field of definition.fields)
        pointers.add("/" + field.path.replaceAll(".", "/"));
  return [...pointers].sort();
}

export const uid = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

export function blankRule(): AggregationRule {
  return {
    id: uid("rule"),
    name: "新规则",
    group: { match: [], key: [] },
    slots: {},
    close: { idle: 60, max_wait: 600, max_events: 200, notices: [] },
    container: {
      title: "{{ group.event_count }} 条事件",
      blocks: [
        {
          id: "summary",
          kind: "text",
          text: "共 {{ group.event_count }} 条事件",
        },
      ],
    },
  };
}

// Lists are edited as comma separated text; numbers and booleans keep their JSON type.
export function parseList(text: string) {
  return text
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^(true|false|-?\d+(\.\d+)?)$/.test(s) ? JSON.parse(s) : s));
}
export const formatList = (values?: unknown[]) =>
  (values || []).map((v) => String(v)).join(", ");
