import { useState } from "react";
import { Button, Input, Select } from "@cloudflare/kumo";
import type { Api } from "./api";
import type {
  DestinationProvider,
  SourceProvider,
  EventTemplateMap,
  MessagePreset,
} from "./types";
import { object } from "./message-model";
import { PreviewDialog } from "./PreviewDialog";
import { MessageComposer } from "./MessageComposer";

export function defaultEventTemplates(
  source: SourceProvider,
  target: DestinationProvider,
  presets: MessagePreset[],
): EventTemplateMap {
  return Object.fromEntries(
    Object.keys(source.event_definitions || {}).flatMap((eventType) => {
      const matching = presets.filter(
        (preset) =>
          preset.source_provider === source.id &&
          preset.destination_provider === target.id &&
          preset.event_type === eventType,
      );
      return matching.length
        ? [
            [
              eventType,
              {
                active_template_id: matching[0].id,
                templates: matching.map(({ id, name, payload_template }) => ({
                  id,
                  name,
                  payload_template: structuredClone(payload_template),
                })),
              },
            ],
          ]
        : [];
    }),
  );
}

export function EventTemplateEditor({
  active,
  api,
  sourceName,
  source,
  target,
  presets,
  eventTypes,
  value,
  onChange,
}: {
  active: boolean;
  api: Api;
  sourceName: string;
  source: SourceProvider;
  target: DestinationProvider;
  presets: MessagePreset[];
  eventTypes: string[];
  value: EventTemplateMap;
  onChange: (value: EventTemplateMap) => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selection, setSelection] = useState("");
  const available = Object.entries(source.event_definitions || {}).filter(
    ([key]) => !eventTypes.length || eventTypes.includes(key),
  );
  const eventType = available.some(([key]) => key === selection)
    ? selection
    : available[0]?.[0] || "";
  const definition = source.event_definitions?.[eventType];
  const binding = value[eventType];
  const current = binding?.templates.find(
    (item) => item.id === binding.active_template_id,
  );
  const fields = Object.fromEntries(
    (definition?.fields || []).map((field) => [field.expression, field.label]),
  );
  function append(copy: boolean) {
    const id = crypto.randomUUID();
    const name =
      copy && current
        ? `${current.name}副本`
        : `${definition?.name || "事件"}自定义模板`;
    const payload_template =
      copy && current
        ? structuredClone(current.payload_template)
        : {
            msg_type: "interactive",
            card: {
              header: {
                title: {
                  tag: "plain_text",
                  content: `{{ event.source_name }} · ${definition?.name || "通知"}`,
                },
                template: "blue",
              },
              elements: [
                {
                  tag: "div",
                  text: { tag: "plain_text", content: "请填写通知内容" },
                },
              ],
            },
          };
    onChange({
      ...value,
      [eventType]: {
        active_template_id: id,
        templates: [
          ...(binding?.templates || []),
          { id, name, payload_template },
        ],
      },
    });
  }
  return (
    <div className="grid gap-5">
      <Select<string>
        label="配置哪种事件"
        value={eventType}
        items={Object.fromEntries(
          available.map(([key, definition]) => [key, definition.name]),
        )}
        onValueChange={(value) => setSelection(value || "")}
      />
      {definition && (
        <>
          <div className="section-toolbar">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={(binding?.templates.length || 0) >= 20}
                onClick={() => append(false)}
              >
                新增空白模板
              </Button>
              <Button
                type="button"
                disabled={!current || binding.templates.length >= 20}
                onClick={() => append(true)}
              >
                复制当前模板
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const defaults = defaultEventTemplates(
                    source,
                    target,
                    presets,
                  )[eventType];
                  if (!defaults) return;
                  const preset = defaults.templates[0];
                  const id = crypto.randomUUID();
                  onChange({
                    ...value,
                    [eventType]: {
                      active_template_id: id,
                      templates: [
                        ...(binding?.templates || []),
                        { ...preset, id },
                      ],
                    },
                  });
                }}
                disabled={
                  (binding?.templates.length || 0) >= 20 ||
                  !presets.some(
                    (p) =>
                      p.source_provider === source.id &&
                      p.destination_provider === target.id &&
                      p.event_type === eventType,
                  )
                }
              >
                从事件预设新增
              </Button>
            </div>
          </div>
          {current && binding ? (
            <>
              <div className="form-columns">
                <Select<string>
                  label="此事件使用的模板"
                  value={current.id}
                  items={Object.fromEntries(
                    binding.templates.map((item) => [item.id, item.name]),
                  )}
                  onValueChange={(id) => {
                    if (id)
                      onChange({
                        ...value,
                        [eventType]: { ...binding, active_template_id: id },
                      });
                  }}
                />
                <Input
                  label="模板名称"
                  required
                  value={current.name}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      [eventType]: {
                        ...binding,
                        templates: binding.templates.map((item) =>
                          item.id === current.id
                            ? { ...item, name: e.target.value }
                            : item,
                        ),
                      },
                    })
                  }
                />
              </div>
              <MessageComposer
                key={`${source.id}:${target.id}:${eventType}:${current.id}`}
                active={active}
                api={api}
                sourceName={sourceName}
                sourceProvider={{
                  ...source,
                  sample: definition.sample,
                  samples: [
                    { name: definition.name, payload: definition.sample },
                  ],
                }}
                provider={target}
                variables={{
                  "event.source_name": "来源名称",
                  "event.event_type": "事件类型",
                  "event.id": "事件编号",
                  ...fields,
                }}
                value={object(current.payload_template)}
                onChange={(payload_template) =>
                  onChange({
                    ...value,
                    [eventType]: {
                      ...binding,
                      templates: binding.templates.map((item) =>
                        item.id === current.id
                          ? { ...item, payload_template }
                          : item,
                      ),
                    },
                  })
                }
              />
            </>
          ) : (
            <p className="error-box" role="alert">
              此事件尚未配置模板，请从预设新增或创建空白模板。
            </p>
          )}
        </>
      )}
      <PreviewDialog
        key={`${eventType}:${current?.id}`}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        api={api}
        sourceName={sourceName}
        sourceProvider={{ ...source, sample: definition?.sample || {} }}
        destinationProvider={target}
        payload={current?.payload_template || {}}
      />
    </div>
  );
}
