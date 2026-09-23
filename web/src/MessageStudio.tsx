import { useEffect, useRef, useState } from "react";
import { Button, Popover } from "@cloudflare/kumo";
import {
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

// Drag payloads use private MIME types so a dragged block never drops into a
// text field as plain text. Only field chips also carry text/plain.
const BLOCK_MIME = "application/x-relay-block";
const NEW_MIME = "application/x-relay-new";
const FIELD_MIME = "application/x-relay-field";
type Drag =
  | { type: "block"; index: number }
  | { type: "new"; kind: ContentBlock["kind"] }
  | { type: "field"; token: string; label: string };
type Field = ReturnType<typeof variablesFor>[number];

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
  // "title", a block id, or null when nothing is being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
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
  const fields = variablesFor(definition);
  const isCard = presentation.style === "card";
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
  function setBlockStyle(id: string, style: string) {
    update({
      presentation: {
        ...custom?.presentation,
        block_styles: { ...custom?.presentation?.block_styles, [id]: style },
      },
    });
  }
  function setPresentation(change: { style?: string; accent?: string }) {
    update({
      presentation: {
        ...custom?.presentation,
        ...change,
        block_styles: custom?.presentation?.block_styles || {},
      },
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
  // Inserts a new block; a field chip becomes a labelled side-by-side field.
  function insert(at: number, kind: ContentBlock["kind"], field?: Field) {
    if (!content || content.blocks.length >= 40) return;
    const block: ContentBlock = {
      id: crypto.randomUUID(),
      kind,
      label: field?.label || "",
      text: field
        ? `{{ ${field.expression} }}`
        : kind === "link"
          ? "打开详情"
          : "新的通知内容",
      ...(kind === "link" ? { url: "https://appstoreconnect.apple.com/" } : {}),
    };
    const blocks = [...content.blocks];
    blocks.splice(at, 0, block);
    update({
      content: { ...content, blocks },
      ...(field && target.block_styles?.some((s) => s.id === "field")
        ? {
            presentation: {
              ...custom?.presentation,
              block_styles: {
                ...custom?.presentation?.block_styles,
                [block.id]: "field",
              },
            },
          }
        : {}),
    });
    if (!field) setEditing(block.id);
  }
  function remove(block: ContentBlock) {
    if (!content) return;
    const block_styles = { ...custom?.presentation?.block_styles };
    delete block_styles[block.id];
    update({
      content: {
        ...content,
        blocks: content.blocks.filter((b) => b.id !== block.id),
      },
      presentation: { ...custom?.presentation, block_styles },
    });
    if (editing === block.id) setEditing(null);
  }
  function reset() {
    const overrides = { ...value.overrides };
    delete overrides[eventType];
    onChange({ ...value, overrides });
    setEditing(null);
  }
  // A chip click inserts at the caret of the field being edited; with nothing
  // open it adds the field to the end of the message.
  function applyField(field: Field) {
    if (!content) return;
    const input = editing
      ? (document.getElementById(
          `studio-input-${editing}`,
        ) as HTMLTextAreaElement | null)
      : null;
    if (!input || !editing) return insert(content.blocks.length, "text", field);
    const text = input.value;
    const start = input.selectionStart ?? text.length;
    const end = input.selectionEnd ?? start;
    const token = `{{ ${field.label} }}`;
    const next = wireTemplate(
      text.slice(0, start) + token + text.slice(end),
      definition,
    );
    if (editing === "title") updateContent({ ...content, title: next });
    else updateBlock(editing, { text: next });
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + token.length, start + token.length);
    });
  }
  function dropPosition(e: React.DragEvent<HTMLOListElement>) {
    // Side-by-side fields share a row, so within a row compare horizontally.
    const rows = [...e.currentTarget.querySelectorAll(":scope > li")];
    const index = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      if (e.clientY < rect.top) return true;
      if (e.clientY > rect.bottom) return false;
      return rect.width < e.currentTarget.clientWidth * 0.75
        ? e.clientX < rect.left + rect.width / 2
        : e.clientY < rect.top + rect.height / 2;
    });
    return index < 0 ? rows.length : index;
  }
  function endDrag() {
    drag.current = null;
    setDropIndex(null);
    setDraggingId(null);
  }
  function styleOf(block: ContentBlock) {
    if (!isCard) return "plain";
    const style = presentation.block_styles[block.id] || "default";
    if (style !== "default") return style;
    return block.kind === "link" ? "button" : "text";
  }
  const currentPreview = preview?.key === request ? preview : undefined;
  const styleName = (block: ContentBlock) => {
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
                      setEditing(null);
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
          {custom && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              icon={<ArrowCounterClockwise size={14} />}
              onClick={reset}
            >
              恢复内置
            </Button>
          )}
        </div>
        {content && (
          <div className="studio-toolbar">
            <div className="segmented" role="group" aria-label="消息样式">
              {target.message_styles?.map((style) => (
                <button
                  type="button"
                  key={style.id}
                  title={style.description}
                  aria-pressed={presentation.style === style.id}
                  onClick={() => setPresentation({ style: style.id })}
                >
                  {style.name}
                </button>
              ))}
            </div>
            {isCard && (
              <div
                className="accent-options"
                role="group"
                aria-label="卡片颜色"
              >
                {Object.entries(target.accents || {}).map(([id, name]) => (
                  <button
                    type="button"
                    key={id}
                    aria-label={name}
                    title={name}
                    aria-pressed={presentation.accent === id}
                    className="accent-option"
                    data-accent={id}
                    onClick={() => setPresentation({ accent: id })}
                  >
                    {presentation.accent === id && <Check size={12} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {content && (
          <div className="studio-editor-body">
            <div className="field-shelf" aria-label="事件字段">
              <p>
                把字段拖进文字里；编辑时点击会插入到光标处，否则添加为新的一行。
              </p>
              <div className="field-chips">
                {fields.map((field) => (
                  <button
                    type="button"
                    key={field.expression}
                    className="field-chip"
                    aria-label={`字段：${field.label}`}
                    draggable
                    title={`示例：${field.path ? sampleValue(definition?.sample, field.path) : sourceName}`}
                    onDragStart={(e) => {
                      const token = `{{ ${field.label} }}`;
                      drag.current = {
                        type: "field",
                        token,
                        label: field.label,
                      };
                      e.dataTransfer.setData("text/plain", token);
                      e.dataTransfer.setData(FIELD_MIME, field.expression);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onDragEnd={endDrag}
                    onClick={() => applyField(field)}
                  >
                    <BracketsCurly size={13} />
                    {field.label}
                    {field.optional && <small>可选</small>}
                  </button>
                ))}
              </div>
            </div>
            <div
              className="message-canvas"
              data-style={presentation.style}
              data-accent={presentation.accent || "blue"}
            >
              <div className="canvas-title">
                <Editable
                  id="title"
                  label="消息标题"
                  placeholder="添加标题"
                  value={content.title}
                  definition={definition}
                  editing={editing === "title"}
                  onEdit={setEditing}
                  onChange={(title) => updateContent({ ...content, title })}
                />
              </div>
              <ol
                className="canvas-blocks"
                aria-label="消息内容"
                onDragOver={(e) => {
                  const current = drag.current;
                  if (!current) return;
                  // Over a text, a field chip is inserted into that text instead.
                  if (
                    current.type === "field" &&
                    (e.target as HTMLElement).closest(".canvas-editable")
                  )
                    return setDropIndex(null);
                  e.preventDefault();
                  e.dataTransfer.dropEffect =
                    current.type === "block" ? "move" : "copy";
                  const at = dropPosition(e);
                  // Dropping a block right where it already is changes nothing.
                  setDropIndex(
                    current.type === "block" &&
                      (at === current.index || at === current.index + 1)
                      ? null
                      : at,
                  );
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node))
                    setDropIndex(null);
                }}
                onDrop={(e) => {
                  const current = drag.current;
                  if (!current || dropIndex === null) return;
                  e.preventDefault();
                  if (current.type === "block") {
                    const to =
                      dropIndex > current.index ? dropIndex - 1 : dropIndex;
                    move(current.index, to);
                  } else if (current.type === "new") {
                    insert(dropIndex, current.kind);
                  } else {
                    const field = fields.find((f) => f.label === current.label);
                    if (field) insert(dropIndex, "text", field);
                  }
                  endDrag();
                }}
              >
                {content.blocks.map((block, index) => {
                  const style = styleOf(block);
                  const label = `内容 ${index + 1}`;
                  const isEditing = editing === block.id;
                  return (
                    <li
                      key={block.id}
                      className="canvas-block"
                      data-block-style={style}
                      data-editing={isEditing || undefined}
                      data-dragging={draggingId === block.id || undefined}
                      data-drop-before={dropIndex === index || undefined}
                      data-drop-after={
                        (index === content.blocks.length - 1 &&
                          dropIndex === content.blocks.length) ||
                        undefined
                      }
                    >
                      <button
                        type="button"
                        className="drag-handle"
                        data-handle={block.id}
                        draggable
                        aria-label={`移动${label}，可用上下方向键调整顺序`}
                        title="拖动调整顺序"
                        onDragStart={(e) => {
                          drag.current = { type: "block", index };
                          e.dataTransfer.setData(BLOCK_MIME, block.id);
                          e.dataTransfer.effectAllowed = "move";
                          const row = e.currentTarget.closest("li");
                          if (row) e.dataTransfer.setDragImage(row, 20, 20);
                          setDraggingId(block.id);
                        }}
                        onDragEnd={endDrag}
                        onKeyDown={(e) => {
                          const delta =
                            e.key === "ArrowUp"
                              ? -1
                              : e.key === "ArrowDown"
                                ? 1
                                : 0;
                          if (!delta) return;
                          e.preventDefault();
                          move(index, index + delta);
                          requestAnimationFrame(() =>
                            (
                              document.querySelector(
                                `[data-handle="${block.id}"]`,
                              ) as HTMLElement | null
                            )?.focus(),
                          );
                        }}
                      >
                        <DotsSixVertical size={16} />
                      </button>
                      <div className="canvas-block-body">
                        {isEditing ? (
                          <input
                            className="canvas-label-input"
                            aria-label={`${label}的标签`}
                            placeholder="标签（可选）"
                            value={readableTemplate(block.label, definition)}
                            onChange={(e) =>
                              updateBlock(block.id, {
                                label: wireTemplate(e.target.value, definition),
                              })
                            }
                          />
                        ) : (
                          block.label && (
                            <span className="canvas-block-label">
                              <TemplateTokens
                                text={block.label}
                                definition={definition}
                              />
                            </span>
                          )
                        )}
                        <Editable
                          id={block.id}
                          label={label}
                          placeholder={
                            block.kind === "link" ? "按钮文字" : "输入内容"
                          }
                          value={block.text}
                          definition={definition}
                          editing={isEditing}
                          onEdit={setEditing}
                          onChange={(text) => updateBlock(block.id, { text })}
                          icon={
                            style === "button" ? (
                              <LinkSimple size={14} />
                            ) : undefined
                          }
                        />
                        {isEditing && block.kind === "link" && (
                          <label className="canvas-url">
                            <LinkSimple size={14} />
                            <input
                              aria-label={`${label}的链接地址`}
                              placeholder="https://"
                              value={readableTemplate(
                                block.url || "",
                                definition,
                              )}
                              onChange={(e) =>
                                updateBlock(block.id, {
                                  url: wireTemplate(e.target.value, definition),
                                })
                              }
                            />
                          </label>
                        )}
                      </div>
                      <div className="canvas-block-tools">
                        <StylePicker
                          target={target}
                          block={block}
                          selected={
                            presentation.block_styles[block.id] || "default"
                          }
                          disabled={!isCard}
                          label={styleName(block)}
                          onChange={(s) => setBlockStyle(block.id, s)}
                        />
                        <button
                          type="button"
                          className="canvas-icon-button"
                          aria-label={`删除${label}`}
                          title="删除"
                          disabled={content.blocks.length <= 1}
                          onClick={() => remove(block)}
                        >
                          <Trash size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="canvas-add">
                {(["text", "link"] as const).map((kind) => (
                  <button
                    type="button"
                    key={kind}
                    className="canvas-add-button"
                    draggable
                    disabled={content.blocks.length >= 40}
                    title="点击添加到末尾，或拖到指定位置"
                    onDragStart={(e) => {
                      drag.current = { type: "new", kind };
                      e.dataTransfer.setData(NEW_MIME, kind);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onDragEnd={endDrag}
                    onClick={() => insert(content.blocks.length, kind)}
                  >
                    <Plus size={14} />
                    {kind === "link" ? (
                      <LinkSimple size={14} />
                    ) : (
                      <TextT size={14} />
                    )}
                    {kind === "link" ? "添加链接" : "添加内容"}
                  </button>
                ))}
              </div>
            </div>
            {!isCard && (
              <p className="canvas-footnote">
                {presentation.style === "text" ? "纯文本" : "富文本"}
                不区分内容样式，切换到消息卡片后可为每段内容选择展示方式。
              </p>
            )}
          </div>
        )}
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
        {definition && (
          <details className="preview-payload">
            <summary>
              <Code size={15} /> 查看事件示例
            </summary>
            <pre className="code-panel">
              {JSON.stringify(definition.sample, null, 2)}
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
              {part.slice(2, -2).trim()}
            </span>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
    </>
  );
}

/**
 * Text shown as it will read, with variables as chips. Click to edit in
 * place; field chips can be dropped in while editing (native text drop) or
 * onto the rendered text, which appends the variable.
 */
function Editable({
  id,
  label,
  placeholder,
  value,
  definition,
  editing,
  onEdit,
  onChange,
  icon,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  definition?: EventDefinition;
  editing: boolean;
  onEdit: (id: string | null) => void;
  onChange: (text: string) => void;
  icon?: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const text = readableTemplate(value, definition);
  if (editing)
    return (
      <div className="canvas-editable" data-editing>
        <textarea
          id={`studio-input-${id}`}
          aria-label={label}
          autoFocus
          rows={Math.max(1, text.split("\n").length)}
          placeholder={placeholder}
          value={text}
          onChange={(e) => onChange(wireTemplate(e.target.value, definition))}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onEdit(null);
            }
          }}
        />
        <button
          type="button"
          className="canvas-done"
          aria-label={`完成编辑${label}`}
          onClick={() => onEdit(null)}
        >
          <Check size={14} />
        </button>
      </div>
    );
  return (
    <div
      className="canvas-editable"
      role="button"
      tabIndex={0}
      aria-label={`编辑${label}`}
      data-over={over || undefined}
      onClick={() => onEdit(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEdit(id);
        }
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FIELD_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const token = e.dataTransfer.getData("text/plain");
        setOver(false);
        if (!e.dataTransfer.types.includes(FIELD_MIME) || !token) return;
        e.preventDefault();
        e.stopPropagation();
        onChange(wireTemplate(text + (text ? " " : "") + token, definition));
      }}
    >
      {icon}
      {text ? (
        <TemplateTokens text={value} definition={definition} />
      ) : (
        <span className="canvas-placeholder">{placeholder}</span>
      )}
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
                <small>{style.description}</small>
              </div>
              {style.id === selected && <Check size={16} />}
            </button>
          ))}
      </Popover.Content>
    </Popover>
  );
}
