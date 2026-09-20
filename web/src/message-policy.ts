import type {
  SourceProvider,
  DestinationProvider,
  MessagePolicy,
  PairPreset,
  Presentation,
  EventDefinition,
} from "./types";

export const builtinPolicy = (): MessagePolicy => ({
  preset: "recommended",
  overrides: {},
});

export function resolveMessage(
  source: SourceProvider,
  target: DestinationProvider,
  pairs: PairPreset[],
  policy: MessagePolicy,
  eventType: string,
) {
  const definition = source.event_definitions?.[eventType];
  const pair =
    policy.preset === "recommended"
      ? pairs.find(
          (p) =>
            p.source_provider === source.id &&
            p.destination_provider === target.id,
        )
      : undefined;
  const custom = policy.overrides[eventType];
  const base = target.default_presentation || {
    style: "card",
    accent: "blue",
    block_styles: {},
  };
  const preset = pair?.events[eventType];
  const presentation: Presentation = {
    ...base,
    ...preset?.presentation,
    ...custom?.presentation,
    block_styles: {
      ...base.block_styles,
      ...preset?.presentation?.block_styles,
      ...custom?.presentation?.block_styles,
    },
  };
  return {
    content: custom?.content || preset?.content || definition?.content_template,
    presentation,
    pair,
    custom,
  };
}

export function variablesFor(definition?: EventDefinition) {
  return [
    {
      label: "来源名称",
      expression: "event.source_name",
      path: "",
      optional: false,
    },
    {
      label: "事件编号",
      expression: "event.id",
      path: "data.id",
      optional: false,
    },
    ...(definition?.fields || []),
  ];
}

export function readableTemplate(text: string, definition?: EventDefinition) {
  let result = text.replace(/{%.*?%}/gs, "");
  for (const field of variablesFor(definition))
    result = result.replaceAll(
      `{{ ${field.expression} }}`,
      `{{ ${field.label} }}`,
    );
  return result;
}
export function wireTemplate(text: string, definition?: EventDefinition) {
  let result = text;
  for (const field of variablesFor(definition))
    result = result.replaceAll(
      `{{ ${field.label} }}`,
      `{{ ${field.expression} }}`,
    );
  return result;
}
export function sampleValue(sample: unknown, path: string): string {
  let value = sample;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object") return "—";
    value = (value as Record<string, unknown>)[part];
  }
  return value === undefined || value === null
    ? "—"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}

export function eventCatalog(source: SourceProvider) {
  return Object.entries(source.event_definitions || {}).sort(
    ([, a], [, b]) => (a.order ?? 100) - (b.order ?? 100),
  );
}
