export type Kind = "keys" | "sources" | "destinations" | "routes";
export type Tab =
  "overview" | Kind | "templates" | "events" | "deliveries" | "audit";
export interface Config {
  enabled?: boolean;
  provider?: string;
  key_id?: string;
  url_key_id?: string;
  signing_key_id?: string | null;
  source_id?: string;
  destination_id?: string;
  event_types?: string[];
  payload_template?: unknown;
  event_templates?: EventTemplateMap;
  message_policy?: MessagePolicy;
  aggregation?: AggregationConfig;
  max_attempts?: number;
  has_value?: boolean;
  value?: string;
  [key: string]: unknown;
}
export interface Resource {
  id: string;
  kind: Kind;
  name: string;
  config: Config;
  revision: number;
  created_at: number;
  updated_at: number;
}
export interface RecordRow {
  id: string | number;
  cursor?: number;
  created_at: number;
  status?: string;
  event_type?: string;
  source_id?: string;
  provider_id?: string;
  destination_id?: string;
  event_id?: string;
  route_id?: string;
  attempts?: number;
  max_attempts?: number;
  last_error?: string;
  action?: string;
  actor?: string;
  resource_id?: string;
  detail?: unknown;
  updated_at?: number;
  next_attempt_at?: number;
  body_sha256?: string;
  attempt?: number;
  http_status?: number;
  provider_code?: number;
  error?: string;
  aggregate_id?: string | null;
}
export interface Meta {
  public_url: string;
  default_template: unknown;
  message_presets?: MessagePreset[];
  pair_presets?: PairPreset[];
  aggregation_presets?: AggregationPreset[];
  source_providers: SourceProvider[];
  destination_providers: DestinationProvider[];
}
export const labels: Record<Tab, string> = {
  overview: "概览",
  keys: "密钥",
  sources: "来源",
  destinations: "通知目标",
  routes: "转发规则",
  templates: "消息模板",
  events: "接收记录",
  deliveries: "投递记录",
  audit: "审计日志",
};
export function initialConfig(kind: Kind): Config {
  switch (kind) {
    case "keys":
      return { value: "" };
    case "sources":
      return { enabled: true, provider: "" };
    case "destinations":
      return {
        enabled: true,
        provider: "",
      };
    case "routes":
      return {
        enabled: true,
        source_id: "",
        destination_id: "",
        event_types: [],
        payload_template: {},
        max_attempts: 5,
      };
  }
}
export function formatTime(value: number) {
  return new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });
}

export interface RecordFilters {
  status?: string;
  route_id?: string;
  source_id?: string;
  destination_id?: string;
  event_id?: string;
  event_type?: string;
  selected_id?: string;
}
export type Navigate = (tab: Tab, filters?: RecordFilters) => void;
export interface OverviewData {
  window: { since: number; until: number; hours: number };
  received: number;
  succeeded: number;
  failed: number;
  success_rate: number | null;
  queue: { pending: number; retrying: number; sending: number; paused: number };
  attention_failed: number;
  series: {
    start: number;
    events: number;
    succeeded: number;
    failed: number;
  }[];
  routes: {
    id: string;
    name: string;
    enabled: boolean;
    source_name: string | null;
    destination_name: string | null;
    source_enabled: boolean;
    destination_enabled: boolean;
    queued: number;
    failed: number;
    last_delivery_at: number | null;
  }[];
  recent_failed: {
    id: string;
    route_id: string;
    route_name: string | null;
    destination_name: string | null;
    last_error: string | null;
    attempts: number;
    updated_at: number;
  }[];
  recent_events: {
    id: string;
    source_id: string;
    source_name: string | null;
    event_type: string;
    created_at: number;
    deliveries: number;
  }[];
}

export interface ProviderField {
  key: string;
  label: string;
  required: boolean;
  type: "secret";
  role?: string;
}
export interface Provider {
  id: string;
  name: string;
  category: string;
  fields: ProviderField[];
  defaults: Config;
}
export interface SourceProvider extends Provider {
  event_types: Record<string, string>;
  sample: unknown;
  event_definitions?: Record<string, EventDefinition>;
  samples?: { name: string; payload: unknown }[];
}
export interface DestinationProvider extends Provider {
  editor: string;
  message_types: Record<string, string>;
  default_template: unknown;
  default_presentation?: Presentation;
  message_styles?: { id: string; name: string; description: string }[];
  block_styles?: {
    id: string;
    name: string;
    description: string;
    kinds: string[];
  }[];
  accents?: Record<string, string>;
}

export interface EventDefinition {
  name: string;
  group?: string;
  order?: number;
  description?: string;
  content_template?: MessageContent;
  fields: {
    path: string;
    label: string;
    expression: string;
    optional: boolean;
  }[];
  sample: unknown;
}
export interface EventTemplate {
  id: string;
  name: string;
  payload_template: unknown;
}
export type EventTemplateMap = Record<
  string,
  { active_template_id: string; templates: EventTemplate[] }
>;
export interface MessagePreset extends EventTemplate {
  source_provider: string;
  event_type: string;
  destination_provider: string;
}

export interface ContentBlock {
  id: string;
  kind: "text" | "link";
  label: string;
  text: string;
  url?: string;
}
export interface MessageContent {
  title: string;
  blocks: ContentBlock[];
}
export interface Presentation {
  style?: string;
  accent?: string;
  block_styles: Record<string, string>;
}
export interface MessageOverride {
  content?: MessageContent;
  presentation?: Presentation;
}
export interface MessagePolicy {
  preset: "recommended" | "default";
  overrides: Record<string, MessageOverride>;
}
export interface PairPreset {
  id: string;
  name: string;
  description: string;
  source_provider: string;
  destination_provider: string;
  events: Record<string, MessageOverride>;
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface AggregationBinding {
  event: string;
  key?: string;
  when?: { pointer: string; in?: JsonValue[]; not_in?: JsonValue[] };
  map?: Record<string, string>;
}
export type AggregationSlot =
  | { reduce: "first" | "last" | "count"; from: AggregationBinding[] }
  | { reduce: "keyed"; from: AggregationBinding[]; final?: JsonValue[] }
  | { reduce: "append"; from: AggregationBinding[]; limit?: number }
  | { reduce: "derive"; op: "worst"; of: string[] };
export type PredicateTest = "all" | "any" | "none" | "exists";
export interface AggregationPredicate {
  slot: string;
  all?: Record<string, JsonValue>;
  any?: Record<string, JsonValue>;
  none?: Record<string, JsonValue>;
  exists?: boolean;
}
export interface ContainerBlock {
  id: string;
  kind: "text" | "link" | "repeat";
  label?: string;
  bind?: string;
  text: string;
  url?: string;
  limit?: number;
  style?: string;
}
export interface AggregationContainer {
  title: string;
  style?: string;
  accent?: string | { slot: string; map: Record<string, string> };
  blocks: ContainerBlock[];
}
export interface AggregationNotice {
  id: string;
  option?: string;
  when: AggregationPredicate;
  once_per_item?: boolean;
  container: AggregationContainer;
}
export interface AggregationRule {
  id: string;
  name: string;
  group: { match: string[]; key: string[] };
  slots: Record<string, AggregationSlot>;
  close: {
    when?: AggregationPredicate;
    settle?: number;
    pending?: AggregationPredicate;
    idle?: number;
    max_wait: number;
    max_events?: number;
    notices?: AggregationNotice[];
  };
  container: AggregationContainer;
}
export interface AggregationPresetRef {
  preset: string;
  options?: Record<string, boolean>;
}
export interface AggregationConfig {
  rules: (AggregationPresetRef | AggregationRule)[];
}
export interface AggregationPreset {
  id: string;
  source_provider: string;
  name: string;
  description: string;
  options: Record<string, string>;
  rule: Omit<AggregationRule, "id">;
}
export interface ReplayGroup {
  rule_id: string;
  rule_name: string;
  events: { event_type: string; at: number }[];
  opened_at: number;
  flushed_at: number;
  pending: boolean;
  reason: "settled" | "idle" | "max_wait" | "max_events";
  payload: unknown;
  error: string | null;
  notices: { at: number; id: string; payload: unknown; error: string | null }[];
}
export interface ReplayResult {
  events: number;
  grouped: number;
  singles: number;
  messages: number;
  groups: ReplayGroup[];
}
export interface AggregateRecord {
  id: string;
  route_id: string;
  rule_id: string;
  state: "open" | "flushed";
  event_count: number;
  opened_at: number;
  last_event_at: number;
  due_at: number;
  flush_reason: ReplayGroup["reason"] | null;
  flushed_at: number | null;
  members: {
    event_id: string;
    seq: number;
    event_type: string;
    created_at: number;
  }[];
  deliveries: string[];
}
