import { useState } from "react";
import { Button, Dialog, Select } from "@cloudflare/kumo";
import { ArrowRight, X } from "@phosphor-icons/react";
import type { Api } from "./api";
import type { Meta, Navigate } from "./types";
import { MessageStudio } from "./MessageStudio";
import { builtinPolicy, eventCatalog } from "./message-policy";

export function TemplateLibrary({
  meta,
  api,
  onNavigate,
}: {
  meta: Meta;
  api: Api;
  onNavigate: Navigate;
}) {
  const [sourceId, setSourceId] = useState(meta.source_providers[0]?.id || "");
  const [targetId, setTargetId] = useState(
    meta.destination_providers[0]?.id || "",
  );
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState("");
  const [policy, setPolicy] = useState(builtinPolicy);
  const source = meta.source_providers.find((p) => p.id === sourceId)!;
  const target = meta.destination_providers.find((p) => p.id === targetId)!;
  const definitions = eventCatalog(source);
  const pair = meta.pair_presets?.find(
    (p) =>
      p.source_provider === sourceId && p.destination_provider === targetId,
  );
  const [group, setGroup] = useState("全部事件");
  const groups = [
    "全部事件",
    ...new Set(definitions.map(([, d]) => d.group || "事件")),
  ];
  function inspect(key: string) {
    setEvent(key);
    setPolicy(builtinPolicy());
    setOpen(true);
  }
  return (
    <div className="template-library">
      <div className="library-pair">
        <div className="flex items-center gap-3">
          {meta.source_providers.length === 1 ? (
            <span>{source.name}</span>
          ) : (
            <Select<string>
              aria-label="模板来源平台"
              value={sourceId}
              items={Object.fromEntries(
                meta.source_providers.map((p) => [p.id, p.name]),
              )}
              onValueChange={(id) => {
                setSourceId(id || "");
                setGroup("全部事件");
              }}
            />
          )}
          <ArrowRight size={16} />
          {meta.destination_providers.length === 1 ? (
            <span>{target.name}</span>
          ) : (
            <Select<string>
              aria-label="模板目标平台"
              value={targetId}
              items={Object.fromEntries(
                meta.destination_providers.map((p) => [p.id, p.name]),
              )}
              onValueChange={(id) => setTargetId(id || "")}
            />
          )}
        </div>
      </div>
      <div className="library-catalog-heading">
        <div className="library-filters" aria-label="事件分类">
          {groups.map((name) => (
            <button
              type="button"
              key={name}
              className={name === group ? "selected" : ""}
              aria-pressed={name === group}
              onClick={() => setGroup(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="template-grid">
        {definitions
          .filter(
            ([, d]) => group === "全部事件" || (d.group || "事件") === group,
          )
          .map(([key, definition]) => {
            const presentation = pair?.events[key]?.presentation;
            return (
              <button
                type="button"
                key={key}
                className="template-tile"
                data-accent={presentation?.accent || "blue"}
                onClick={() => inspect(key)}
                aria-label={`查看${definition.name}模板`}
              >
                <span className="mini-message-header">{definition.name}</span>
              </button>
            );
          })}
      </div>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog className="template-workspace-dialog" size="xl">
          <header className="template-dialog-header">
            <div>
              <Dialog.Title>模板工作区</Dialog.Title>
              <Dialog.Description>
                此处修改仅用于预览；自定义内容需在转发规则中保存。
              </Dialog.Description>
            </div>
            <Button
              type="button"
              variant="ghost"
              shape="square"
              aria-label="关闭模板工作区"
              icon={<X size={18} />}
              onClick={() => setOpen(false)}
            />
          </header>
          {source && target && (
            <MessageStudio
              key={`${sourceId}:${targetId}:${event}`}
              initialEvent={event}
              active={open}
              api={api}
              sourceName="我的应用"
              source={source}
              target={target}
              pairs={meta.pair_presets || []}
              value={policy}
              onChange={setPolicy}
            />
          )}
          <footer className="template-dialog-footer">
            <Button
              onClick={() => {
                setOpen(false);
                onNavigate("routes");
              }}
              variant="primary"
            >
              前往转发规则
              <ArrowRight size={15} />
            </Button>
          </footer>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
