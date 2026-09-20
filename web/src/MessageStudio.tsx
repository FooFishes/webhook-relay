import { useEffect, useRef, useState } from "react";
import { Button, Input, InputArea, Popover } from "@cloudflare/kumo";
import {
  ArrowUp,
  ArrowDown,
  Check,
  CaretDown,
  Code,
  DotsSixVertical,
  MagnifyingGlass,
  Plus,
  TextT,
  Trash,
  ArrowCounterClockwise,
  BracketsCurly,
  LinkSimple,
  PencilSimple,
} from "@phosphor-icons/react";
import type { Api } from "./api";
import type {
  ContentBlock,
  DestinationProvider,
  EventDefinition,
  MessageContent,
  MessageOverride,
  MessagePolicy,
  PairPreset,
  SourceProvider,
} from "./types";
import {
  eventCatalog,
  readableTemplate,
  resolveMessage,
  sampleValue,
  variablesFor,
  wireTemplate,
} from "./message-policy";
import { MessageView } from "./MessageView";

export function ProviderMark({
  provider,
  small = false,
}: {
  provider: string;
  small?: boolean;
}) {
  return (
    <span
      className={`provider-mark ${small ? "small" : ""}`}
      data-provider={provider}
      aria-hidden="true"
    >
      {provider === "apple_app_store_connect" ? (
        <svg viewBox="0 0 24 24">
          <path
            fill="currentColor"
            d="M16.2 2c.2 1.4-.4 2.8-1.2 3.6-.9.9-2.2 1.5-3.4 1.4-.2-1.3.4-2.7 1.2-3.5.9-.9 2.3-1.5 3.4-1.5ZM19.9 17.4c-.5 1.1-.8 1.6-1.5 2.6-.9 1.2-2 2.6-3.5 2.6-1.3 0-1.6-.8-3.4-.8s-2.1.8-3.4.8c-1.4 0-2.5-1.2-3.4-2.5C2.1 16.4 1.7 11.2 3.3 8.7c1.1-1.8 2.9-2.8 4.6-2.8 1.4 0 2.3.8 3.5.8 1.1 0 1.8-.8 3.5-.8 1.5 0 3 .8 4 2.1-3.5 2-2.9 7 .9 8.4l.1 1Z"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24">
          <path d="m3 7 8 6-3 8L3 7Z" fill="#39c1db" />
          <path d="m3 7 10 3 8-7-7 14L3 7Z" fill="#3370ff" />
          <path d="m8 21 6-4-3-4-3 8Z" fill="#2058cf" />
        </svg>
      )}
    </span>
  );
}

export function MessageStudio({
  active,
  api,
  sourceName,
  source,
  target,
  pairs,
  value,
  onChange,
  eventTypes = [],
  initialEvent,
}: {
  active: boolean;
  api: Api;
  sourceName: string;
  source: SourceProvider;
  target: DestinationProvider;
  pairs: PairPreset[];
  value: MessagePolicy;
  onChange: (policy: MessagePolicy) => void;
  eventTypes?: string[];
  initialEvent?: string;
}) {
  const [selection, setSelection] = useState(
    initialEvent || "appStoreVersionAppVersionStateUpdated",
  );
  const [search, setSearch] = useState("");
  const [section, setSection] = useState("content");
  const [customizing, setCustomizing] = useState<string | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<{
    key: string;
    payload?: unknown;
    error?: string;
  }>();
  const available = eventCatalog(source).filter(
    ([key]) => !eventTypes.length || eventTypes.includes(key),
  );
  const eventType = available.some(([key]) => key === selection)
    ? selection
    : available[0]?.[0] || "";
  const definition = source.event_definitions?.[eventType];
  const { content, presentation, custom } = resolveMessage(
    source,
    target,
    pairs,
    value,
    eventType,
  );
  const editing = customizing === eventType;
  const groups = [...new Set(available.map(([, d]) => d.group || "事件"))];
  const shown = available.filter(([key, d]) =>
    `${d.name} ${key}`.toLowerCase().includes(search.toLowerCase()),
  );
  const request = JSON.stringify({
    message_policy: value,
    source_provider: source.id,
    destination_provider: target.id,
    source_name: sourceName,
    sample: definition?.sample,
  });
  useEffect(() => {
    if (!active || !definition) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api<{ payload: unknown }>("/preview", "POST", JSON.parse(request))
        .then((result) => {
          if (!cancelled) setPreview({ key: request, payload: result.payload });
        })
        .catch((e: unknown) => {
          if (!cancelled)
            setPreview({
              key: request,
              error: e instanceof Error ? e.message : "预览失败",
            });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, request, api, retry, !!definition]);
  function update(change: Partial<MessageOverride>) {
    onChange({
      ...value,
      overrides: { ...value.overrides, [eventType]: { ...custom, ...change } },
    });
  }
  function updateContent(next: MessageContent) {
    update({ content: next });
  }
  function updateBlock(id: string, change: Partial<ContentBlock>) {
    if (content)
      updateContent({
        ...content,
        blocks: content.blocks.map((b) =>
          b.id === id ? { ...b, ...change } : b,
        ),
      });
  }
  function move(index: number, targetIndex: number) {
    if (!content || targetIndex < 0 || targetIndex >= content.blocks.length)
      return;
    const blocks = [...content.blocks];
    const [block] = blocks.splice(index, 1);
    blocks.splice(targetIndex, 0, block);
    updateContent({ ...content, blocks });
  }
  function reset() {
    const overrides = { ...value.overrides };
    delete overrides[eventType];
    onChange({ ...value, overrides });
    setCustomizing(null);
  }
  const currentPreview = preview?.key === request ? preview : undefined;
  const blockStyle = (block: ContentBlock) => {
    const style = presentation.block_styles[block.id] || "default";
    return target.block_styles?.find((s) => s.id === style)?.name || "默认样式";
  };
  return (
    <div className="template-studio">
      <aside className="studio-events" aria-label="事件模板目录">
        <div className="studio-source">
          <ProviderMark provider={source.id} small />
          <div>
            <strong>{source.name.replace("Apple ", "")}</strong>
          </div>
        </div>
        <div className="event-search">
          <MagnifyingGlass size={16} />
          <input
            aria-label="搜索事件模板"
            placeholder="搜索事件…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="event-catalog">
          {groups.map((group) => {
            const events = shown.filter(
              ([, d]) => (d.group || "事件") === group,
            );
            return events.length ? (
              <div className="event-group" key={group}>
                <p>{group}</p>
                {events.map(([key, d]) => (
                  <button
                    type="button"
                    key={key}
                    className={`event-choice ${key === eventType ? "selected" : ""}`}
                    aria-label={d.name}
                    aria-description={
                      value.overrides[key] ? "已自定义" : undefined
                    }
                    aria-pressed={key === eventType}
                    onClick={() => {
                      setSelection(key);
                      setCustomizing(null);
                    }}
                  >
                    <span>{d.name}</span>
                    {value.overrides[key] && (
                      <span
                        className="event-dot"
                        title="已自定义"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                ))}
              </div>
            ) : null;
          })}
          {!shown.length && <p className="compact-empty">没有匹配的事件</p>}
        </div>
      </aside>
      <section className="studio-editor">
        <div className="studio-event-heading">
          <h2>{definition?.name || "没有可配置的事件"}</h2>
          <span className={`template-badge ${custom ? "custom" : ""}`}>
            {custom ? "已自定义" : "内置预设"}
          </span>
        </div>
        <div className="studio-tabs" role="tablist" aria-label="模板设置">
          {[
            ["content", "消息内容"],
            ["style", "消息样式"],
            ["data", "事件字段"],
          ].map(([key, label]) => (
            <button
              type="button"
              key={key}
              role="tab"
              aria-selected={section === key}
              aria-controls={`studio-panel-${key}`}
              id={`studio-tab-${key}`}
              tabIndex={section === key ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  const tabs = ["content", "style", "data"];
                  const next =
                    tabs[
                      (tabs.indexOf(key) + (e.key === "ArrowRight" ? 1 : 2)) % 3
                    ];
                  setSection(next);
                  document.getElementById(`studio-tab-${next}`)?.focus();
                }
              }}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="studio-editor-body"
          role="tabpanel"
          id={`studio-panel-${section}`}
          aria-labelledby={`studio-tab-${section}`}
        >
          {content && section === "content" && (
            <>
              <div className="content-toolbar">
                <div className="flex gap-2">
                  {custom && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      icon={<ArrowCounterClockwise size={14} />}
                      onClick={reset}
                    >
                      恢复内置
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    icon={
                      editing ? <Check size={14} /> : <PencilSimple size={14} />
                    }
                    onClick={() => setCustomizing(editing ? null : eventType)}
                  >
                    {editing ? "完成编辑" : "自定义此事件"}
                  </Button>
                </div>
              </div>
              <div className="content-title-block">
                {!editing && <span className="block-caption">消息标题</span>}
                {editing ? (
                  <TemplateInput
                    label="消息标题"
                    value={content.title}
                    definition={definition}
                    onChange={(title) => updateContent({ ...content, title })}
                  />
                ) : (
                  <p>
                    <TemplateTokens
                      text={content.title}
                      definition={definition}
                    />
                  </p>
                )}
              </div>
              <div className="content-block-list">
                {content.blocks.map((block, index) => (
                  <article
                    key={block.id}
                    className={`content-block ${editing ? "editable" : ""}`}
                    onDragOver={(e) => {
                      if (dragged !== null) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      if (dragged !== null) {
                        e.preventDefault();
                        move(dragged, index);
                        setDragged(null);
                      }
                    }}
                  >
                    <div className="block-header">
                      <span className="block-caption">
                        {editing && (
                          <span
                            draggable
                            className="drag-handle"
                            onDragStart={(e) => {
                              setDragged(index);
                              e.dataTransfer.setData("text/plain", block.id);
                            }}
                            onDragEnd={() => setDragged(null)}
                          >
                            <DotsSixVertical size={15} />
                          </span>
                        )}
                        {block.kind === "link" ? (
                          <LinkSimple size={15} />
                        ) : (
                          <TextT size={15} />
                        )}
                        {block.label ||
                          (block.kind === "link" ? "操作链接" : "正文")}
                      </span>
                      <StylePicker
                        target={target}
                        block={block}
                        selected={
                          presentation.block_styles[block.id] || "default"
                        }
                        disabled={presentation.style !== "card"}
                        label={blockStyle(block)}
                        onChange={(style) =>
                          update({
                            presentation: {
                              ...custom?.presentation,
                              block_styles: {
                                ...custom?.presentation?.block_styles,
                                [block.id]: style,
                              },
                            },
                          })
                        }
                      />
                    </div>
                    {editing ? (
                      <div className="block-inputs">
                        <Input
                          label="内容标签"
                          value={block.label}
                          onChange={(e) =>
                            updateBlock(block.id, { label: e.target.value })
                          }
                        />
                        <TemplateInput
                          label={`内容 ${index + 1}`}
                          value={block.text}
                          definition={definition}
                          onChange={(text) => updateBlock(block.id, { text })}
                        />
                        {block.kind === "link" && (
                          <TemplateInput
                            label="链接地址"
                            value={block.url || ""}
                            definition={definition}
                            onChange={(url) => updateBlock(block.id, { url })}
                          />
                        )}
                        <div className="block-actions">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`上移内容 ${index + 1}`}
                            icon={<ArrowUp size={14} />}
                            disabled={index === 0}
                            onClick={() => move(index, index - 1)}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`下移内容 ${index + 1}`}
                            icon={<ArrowDown size={14} />}
                            disabled={index === content.blocks.length - 1}
                            onClick={() => move(index, index + 1)}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`删除内容 ${index + 1}`}
                            icon={<Trash size={14} />}
                            disabled={content.blocks.length <= 1}
                            onClick={() => {
                              const block_styles = {
                                ...custom?.presentation?.block_styles,
                              };
                              delete block_styles[block.id];
                              update({
                                content: {
                                  ...content,
                                  blocks: content.blocks.filter(
                                    (b) => b.id !== block.id,
                                  ),
                                },
                                presentation: {
                                  ...custom?.presentation,
                                  block_styles,
                                },
                              });
                            }}
                          />
                        </div>
                      </div>
                    ) : (
                      <p className="block-copy">
                        <TemplateTokens
                          text={block.text}
                          definition={definition}
                        />
                      </p>
                    )}
                  </article>
                ))}
              </div>
              {editing && (
                <div className="add-block-actions">
                  {["text", "link"].map((kind) => (
                    <Button
                      type="button"
                      key={kind}
                      size="sm"
                      variant="ghost"
                      icon={<Plus size={15} />}
                      disabled={content.blocks.length >= 40}
                      onClick={() =>
                        updateContent({
                          ...content,
                          blocks: [
                            ...content.blocks,
                            {
                              id: crypto.randomUUID(),
                              kind: kind as "text" | "link",
                              label: "",
                              text:
                                kind === "link" ? "打开详情" : "新的通知内容",
                              ...(kind === "link"
                                ? { url: "https://appstoreconnect.apple.com/" }
                                : {}),
                            },
                          ],
                        })
                      }
                    >
                      {kind === "link" ? "添加链接" : "添加内容"}
                    </Button>
                  ))}
                </div>
              )}
            </>
          )}
          {content && section === "style" && (
            <div className="style-settings">
              <div className="style-options">
                {target.message_styles?.map((style) => (
                  <button
                    type="button"
                    className={`style-option ${presentation.style === style.id ? "selected" : ""}`}
                    key={style.id}
                    aria-pressed={presentation.style === style.id}
                    onClick={() =>
                      update({
                        presentation: {
                          ...custom?.presentation,
                          style: style.id,
                          block_styles:
                            custom?.presentation?.block_styles || {},
                        },
                      })
                    }
                  >
                    <strong>{style.name}</strong>
                    {presentation.style === style.id && <Check size={16} />}
                  </button>
                ))}
              </div>
              {presentation.style === "card" && (
                <>
                  <h3>卡片颜色</h3>
                  <div className="accent-options">
                    {Object.entries(target.accents || {}).map(([id, name]) => (
                      <button
                        type="button"
                        key={id}
                        aria-label={name}
                        aria-pressed={presentation.accent === id}
                        className="accent-option"
                        data-accent={id}
                        onClick={() =>
                          update({
                            presentation: {
                              ...custom?.presentation,
                              accent: id,
                              block_styles:
                                custom?.presentation?.block_styles || {},
                            },
                          })
                        }
                      >
                        {presentation.accent === id && <Check size={16} />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {section === "data" && (
            <div className="event-schema">
              <p className="text-kumo-subtle">示例值</p>
              {variablesFor(definition).map((field) => (
                <div className="schema-field" key={field.expression}>
                  <span>
                    <BracketsCurly size={16} />
                    {field.label}
                    {field.optional && (
                      <small title="缺失时省略此字段">可选</small>
                    )}
                  </span>
                  {field.path && <code>{field.path}</code>}
                  <p>
                    {field.path
                      ? sampleValue(definition?.sample, field.path)
                      : sourceName}
                  </p>
                </div>
              ))}
              <details>
                <summary>
                  <Code size={16} /> 查看事件示例
                </summary>
                <pre className="code-panel">
                  {JSON.stringify(definition?.sample, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      </section>
      <aside className="studio-preview" aria-label="消息实时预览">
        <div className="preview-toolbar">
          <span>
            <ProviderMark provider={target.id} small />
            {target.name}预览
          </span>
        </div>
        <div className="studio-conversation">
          {!currentPreview ? (
            <div
              className="preview-skeleton"
              role="status"
              aria-label="正在生成预览"
            >
              <i />
              <i />
              <i />
              <i />
            </div>
          ) : currentPreview.error ? (
            <div role="alert" className="error-box">
              <p>{currentPreview.error}</p>
              <Button type="button" onClick={() => setRetry((n) => n + 1)}>
                重新预览
              </Button>
            </div>
          ) : (
            <MessageView provider={target} value={currentPreview.payload} />
          )}
        </div>
        <p className="preview-footnote">
          示例预览，不会发送通知；实际排版以客户端为准。
        </p>
        {currentPreview?.payload !== undefined && (
          <details className="preview-payload">
            <summary>
              <Code size={15} /> 查看发送内容
            </summary>
            <pre className="code-panel">
              {JSON.stringify(currentPreview.payload, null, 2)}
            </pre>
          </details>
        )}
      </aside>
    </div>
  );
}

function TemplateTokens({
  text,
  definition,
}: {
  text: string;
  definition?: EventDefinition;
}) {
  return (
    <>
      {readableTemplate(text, definition)
        .split(/({{.*?}})/g)
        .map((part, i) =>
          part.startsWith("{{") ? (
            <span className="variable-token" key={i}>
              <BracketsCurly size={12} />
              {part.slice(2, -2).trim()}
            </span>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
    </>
  );
}

function TemplateInput({
  label,
  value,
  definition,
  onChange,
}: {
  label: string;
  value: string;
  definition?: EventDefinition;
  onChange: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = readableTemplate(value, definition);
  return (
    <div className="template-input">
      <InputArea
        ref={ref}
        label={label}
        rows={2}
        value={text}
        onChange={(e) => onChange(wireTemplate(e.target.value, definition))}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon={<BracketsCurly size={14} />}
            />
          }
        >
          插入变量
        </Popover.Trigger>
        <Popover.Content className="studio-popover" side="bottom" align="start">
          {variablesFor(definition).map((field) => (
            <button
              type="button"
              className="popover-option"
              key={field.expression}
              onClick={() => {
                const start = ref.current?.selectionStart ?? text.length;
                const end = ref.current?.selectionEnd ?? start;
                const token = `{{ ${field.label} }}`;
                onChange(
                  wireTemplate(
                    text.slice(0, start) + token + text.slice(end),
                    definition,
                  ),
                );
                setOpen(false);
                requestAnimationFrame(() => {
                  ref.current?.focus();
                  ref.current?.setSelectionRange(
                    start + token.length,
                    start + token.length,
                  );
                });
              }}
            >
              <BracketsCurly size={16} />
              <span>{field.label}</span>
              {field.optional && <small title="缺失时省略此字段">可选</small>}
            </button>
          ))}
        </Popover.Content>
      </Popover>
    </div>
  );
}

function StylePicker({
  target,
  block,
  selected,
  disabled,
  label,
  onChange,
}: {
  target: DestinationProvider;
  block: ContentBlock;
  selected: string;
  disabled: boolean;
  label: string;
  onChange: (style: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="block-style-trigger"
            disabled={disabled}
            title={disabled ? "仅适用于消息卡片" : undefined}
            aria-label={`${block.label || block.text}的展示样式`}
          />
        }
      >
        {label}
        <CaretDown size={12} />
      </Popover.Trigger>
      <Popover.Content className="studio-popover" side="bottom" align="end">
        {target.block_styles
          ?.filter((style) => style.kinds.includes(block.kind))
          .map((style) => (
            <button
              type="button"
              className="popover-option"
              key={style.id}
              onClick={() => {
                onChange(style.id);
                setOpen(false);
              }}
            >
              <div>
                <strong>{style.name}</strong>
                {style.id === "default" && <small>按内容类型自动选择</small>}
              </div>
              {style.id === selected && <Check size={16} />}
            </button>
          ))}
      </Popover.Content>
    </Popover>
  );
}
