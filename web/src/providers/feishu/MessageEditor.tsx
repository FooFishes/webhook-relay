import {
  useState,
  useRef,
  useLayoutEffect,
  useContext,
  createContext,
} from "react";
import { Button, Dialog, Input, InputArea, Select } from "@cloudflare/kumo";
import {
  ArrowDown,
  ArrowUp,
  DotsSixVertical,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import {
  createMessage,
  messageTypes,
  object,
  string,
  patchContent,
  patchPost,
  move,
  variables as defaultVariables,
} from "./message-model";
import { Fields } from "../../MessageFields";
import type { MessageObject } from "./message-model";

export const VariableContext = createContext(
  defaultVariables as Record<string, string>,
);

export function MessageField({
  label,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  const variables = useContext(VariableContext);
  const input = useRef<HTMLTextAreaElement>(null);
  const cursor = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (cursor.current !== null && input.current) {
      input.current.focus();
      input.current.setSelectionRange(cursor.current, cursor.current);
      cursor.current = null;
    }
  }, [value]);
  function insert(key: string) {
    if (!(key in variables)) return;
    const expression = `{{ ${key} }}`;
    const start = input.current?.selectionStart ?? value.length;
    const end = input.current?.selectionEnd ?? start;
    cursor.current = start + expression.length;
    onChange(value.slice(0, start) + expression + value.slice(end));
  }
  return (
    <div className="grid gap-2">
      <InputArea
        ref={input}
        label={label}
        required
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-relay-variable"))
            e.preventDefault();
        }}
        onDrop={(e) => {
          const key = e.dataTransfer.getData("application/x-relay-variable");
          if (!(key in variables)) return;
          e.preventDefault();
          insert(key);
        }}
      />
      <div className="variable-actions">
        <span className="text-kumo-subtle">插入变量</span>
        {Object.entries(variables).map(([key, name]) => (
          <Button
            key={key}
            size="sm"
            type="button"
            variant="ghost"
            draggable
            title={`点击或拖到正文光标处插入 ${key}`}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-relay-variable", key);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => insert(key)}
          >
            {name}
          </Button>
        ))}
      </div>
    </div>
  );
}
function OrderActions({
  index,
  total,
  onMove,
  onRemove,
}: {
  index: number;
  total: number;
  onMove: (d: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex gap-1">
      <Button
        size="sm"
        type="button"
        variant="ghost"
        shape="square"
        aria-label="上移"
        icon={<ArrowUp size={14} />}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      />
      <Button
        size="sm"
        type="button"
        variant="ghost"
        shape="square"
        aria-label="下移"
        icon={<ArrowDown size={14} />}
        disabled={index === total - 1}
        onClick={() => onMove(1)}
      />
      <Button
        size="sm"
        type="button"
        variant="ghost"
        shape="square"
        aria-label="删除内容块"
        icon={<Trash size={14} />}
        onClick={onRemove}
      />
    </div>
  );
}
export function FeishuMessageEditor({
  value,
  onChange,
}: {
  value: MessageObject;
  onChange: (v: MessageObject) => void;
}) {
  const type = string(value.msg_type) || "text";
  const dragged = useRef<{ kind: string; index: number } | null>(null);
  const dragHandle = (kind: string, index: number) => (
    <span
      className="drag-handle"
      draggable
      title="拖动调整顺序，也可使用上移和下移按钮"
      onDragStart={(e) => {
        dragged.current = { kind, index };
        e.dataTransfer.setData("application/x-relay-block", kind);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        dragged.current = null;
      }}
    >
      <DotsSixVertical size={18} aria-hidden="true" />
    </span>
  );
  const dropProps = (
    kind: string,
    index: number,
    items: unknown[],
    update: (items: unknown[]) => void,
  ) => ({
    onDragOver: (e: React.DragEvent) => {
      if (dragged.current?.kind === kind) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      const from = dragged.current;
      if (!from || from.kind !== kind) return;
      e.preventDefault();
      dragged.current = null;
      if (from.index === index) return;
      const next = [...items];
      const [item] = next.splice(from.index, 1);
      next.splice(index, 0, item);
      update(next);
    },
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [nextType, setNextType] = useState<string | null>(null);
  const [locale, setLocale] = useState(
    Object.keys(object(object(value.content).post))[0] || "zh_cn",
  );
  const content = object(value.content);
  const card = object(value.card);
  const selectedPost = object(object(content.post)[locale]);
  const paragraphs = Array.isArray(selectedPost.content)
    ? selectedPost.content
    : [];
  const cardV2 = card.schema === "2.0";
  const elements = cardV2 ? object(card.body).elements : card.elements;
  const blocks = Array.isArray(elements) ? elements : [];
  const updateBlocks = (items: unknown[]) =>
    onChange({
      ...value,
      card: cardV2
        ? { ...card, body: { ...object(card.body), elements: items } }
        : { ...card, elements: items },
    });
  return (
    <div className="grid gap-5">
      <Select<string>
        label="消息类型"
        value={type}
        items={messageTypes}
        onValueChange={(v) => {
          if (v && v !== type) setNextType(v);
        }}
      />
      {type === "text" && (
        <MessageField
          label="消息正文"
          value={string(content.text)}
          rows={6}
          onChange={(text) => onChange(patchContent(value, { text }))}
        />
      )}
      {type === "image" && (
        <Input
          label="图片 Key"
          required
          value={string(content.image_key)}
          onChange={(e) =>
            onChange(patchContent(value, { image_key: e.target.value }))
          }
        />
      )}
      {type === "share_chat" && (
        <Input
          label="群 ID"
          required
          value={string(content.share_chat_id)}
          onChange={(e) =>
            onChange(patchContent(value, { share_chat_id: e.target.value }))
          }
        />
      )}
      {type === "post" && (
        <>
          <div className="form-columns">
            <Select<string>
              label="语言"
              value={locale}
              items={{
                zh_cn: "简体中文",
                en_us: "English",
                ...Object.fromEntries(
                  Object.keys(object(content.post))
                    .filter((k) => !["zh_cn", "en_us"].includes(k))
                    .map((k) => [k, k]),
                ),
              }}
              onValueChange={(v) => setLocale(v || "zh_cn")}
            />
            <Input
              label="标题"
              value={string(selectedPost.title)}
              onChange={(e) =>
                onChange(patchPost(value, locale, { title: e.target.value }))
              }
            />
          </div>
          {paragraphs.map((paragraph, index) => (
            <section
              className="message-block"
              key={index}
              {...dropProps("post", index, paragraphs, (content) =>
                onChange(patchPost(value, locale, { content })),
              )}
            >
              <div className="section-toolbar">
                <h3 className="flex items-center gap-2">
                  {dragHandle("post", index)}段落 {index + 1}
                </h3>
                <OrderActions
                  index={index}
                  total={paragraphs.length}
                  onMove={(d) =>
                    onChange(
                      patchPost(value, locale, {
                        content: move(paragraphs, index, d),
                      }),
                    )
                  }
                  onRemove={() =>
                    onChange(
                      patchPost(value, locale, {
                        content: paragraphs.filter((_, i) => i !== index),
                      }),
                    )
                  }
                />
              </div>
              <RichParagraph
                value={Array.isArray(paragraph) ? paragraph : []}
                onChange={(row) =>
                  onChange(
                    patchPost(value, locale, {
                      content: paragraphs.map((p, i) =>
                        i === index ? row : p,
                      ),
                    }),
                  )
                }
              />
            </section>
          ))}
          <Button
            type="button"
            icon={<Plus size={16} />}
            onClick={() =>
              onChange(
                patchPost(value, locale, {
                  content: [...paragraphs, [{ tag: "text", text: "" }]],
                }),
              )
            }
          >
            添加段落
          </Button>
        </>
      )}
      {type === "interactive" && (
        <>
          <div className="form-columns">
            <MessageField
              rows={1}
              label="卡片标题"
              value={string(object(object(card.header).title).content)}
              onChange={(title) =>
                onChange({
                  ...value,
                  card: {
                    ...card,
                    header: {
                      ...object(card.header),
                      title: {
                        ...object(object(card.header).title),
                        tag: "plain_text",
                        content: title,
                      },
                    },
                  },
                })
              }
            />
            <Select<string>
              label="标题颜色"
              value={string(object(card.header).template) || "blue"}
              items={{
                blue: "蓝色",
                green: "绿色",
                orange: "橙色",
                red: "红色",
                purple: "紫色",
                grey: "灰色",
              }}
              onValueChange={(v) =>
                onChange({
                  ...value,
                  card: {
                    ...card,
                    header: { ...object(card.header), template: v },
                  },
                })
              }
            />
          </div>
          {blocks.map((block, index) => {
            const b = object(block);
            const text = object(b.text);
            const markdown = b.tag === "markdown";
            const div =
              b.tag === "div" &&
              ["lark_md", "plain_text"].includes(string(text.tag));
            return (
              <section
                className="message-block"
                key={index}
                {...dropProps("card", index, blocks, updateBlocks)}
              >
                <div className="section-toolbar">
                  <h3 className="flex items-center gap-2">
                    {dragHandle("card", index)}
                    {b.tag === "hr" ? "分隔线" : `内容块 ${index + 1}`}
                  </h3>
                  <OrderActions
                    index={index}
                    total={blocks.length}
                    onMove={(d) => updateBlocks(move(blocks, index, d))}
                    onRemove={() =>
                      updateBlocks(blocks.filter((_, i) => i !== index))
                    }
                  />
                </div>
                {markdown || div ? (
                  <MessageField
                    label={`内容块 ${index + 1} 正文`}
                    value={string(markdown ? b.content : text.content)}
                    onChange={(t) =>
                      updateBlocks(
                        blocks.map((item, i) =>
                          i !== index
                            ? item
                            : markdown
                              ? { ...b, content: t }
                              : { ...b, text: { ...text, content: t } },
                        ),
                      )
                    }
                  />
                ) : b.tag === "action" ? (
                  <CardActions
                    value={Array.isArray(b.actions) ? b.actions : []}
                    onChange={(actions) =>
                      updateBlocks(
                        blocks.map((item, i) =>
                          i === index ? { ...b, actions } : item,
                        ),
                      )
                    }
                  />
                ) : b.tag !== "hr" ? (
                  <Fields
                    value={b}
                    onChange={(v) =>
                      updateBlocks(
                        blocks.map((item, i) => (i === index ? v : item)),
                      )
                    }
                  />
                ) : null}
              </section>
            );
          })}
          <div className="flex gap-2">
            <Button
              type="button"
              icon={<Plus size={16} />}
              onClick={() =>
                updateBlocks([
                  ...blocks,
                  cardV2
                    ? { tag: "markdown", content: "" }
                    : { tag: "div", text: { tag: "lark_md", content: "" } },
                ])
              }
            >
              添加正文
            </Button>
            <Button
              type="button"
              onClick={() => updateBlocks([...blocks, { tag: "hr" }])}
            >
              添加分隔线
            </Button>
            {!cardV2 && (
              <Button
                type="button"
                onClick={() =>
                  updateBlocks([
                    ...blocks,
                    {
                      tag: "action",
                      actions: [
                        {
                          tag: "button",
                          text: { tag: "plain_text", content: "打开链接" },
                          url: "https://",
                          type: "default",
                        },
                      ],
                    },
                  ])
                }
              >
                添加按钮
              </Button>
            )}
          </div>
          <details>
            <summary>其他卡片属性</summary>
            <div className="mt-3">
              <Fields
                value={Object.fromEntries(
                  Object.entries(card).filter(
                    ([key]) => !["header", "elements", "body"].includes(key),
                  ),
                )}
                onChange={(rest) => {
                  const preserved = Object.fromEntries(
                    Object.entries(card).filter(([key]) =>
                      ["header", "elements", "body"].includes(key),
                    ),
                  );
                  onChange({
                    ...value,
                    card: { ...preserved, ...object(rest) },
                  });
                }}
              />
            </div>
          </details>
        </>
      )}
      <details
        className="advanced-fields"
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
      >
        <summary>完整字段表单</summary>
        <div className="mt-3">
          {advancedOpen && (
            <Fields value={value} onChange={(v) => onChange(object(v))} />
          )}
        </div>
      </details>
      <Dialog.Root
        open={!!nextType}
        onOpenChange={(v) => {
          if (!v) setNextType(null);
        }}
      >
        <Dialog size="lg" className="dialog-body">
          <Dialog.Title className="text-lg font-semibold">
            切换消息类型
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            当前消息内容将被替换为新的类型。已保存的规则在点击“保存配置”前不会改变。
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" onClick={() => setNextType(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                onChange(createMessage(nextType!));
                setNextType(null);
              }}
            >
              切换类型
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
function RichParagraph({
  value,
  onChange,
}: {
  value: unknown[];
  onChange: (v: unknown[]) => void;
}) {
  const patch = (index: number, fields: MessageObject) =>
    onChange(
      value.map((v, i) => (i === index ? { ...object(v), ...fields } : v)),
    );
  return (
    <div className="grid gap-4">
      {value.map((item, index) => {
        const element = object(item);
        const tag = string(element.tag);
        return (
          <div className="rich-element" key={index}>
            <div className="section-toolbar">
              <span>
                {(
                  {
                    text: "文本",
                    a: "链接",
                    at: "提及",
                    img: "图片",
                  } as Record<string, string>
                )[tag] || tag}
              </span>
              <OrderActions
                index={index}
                total={value.length}
                onMove={(d) => onChange(move(value, index, d))}
                onRemove={() => onChange(value.filter((_, i) => i !== index))}
              />
            </div>
            {["text", "a"].includes(tag) && (
              <MessageField
                label={`内容 ${index + 1}`}
                value={string(element.text)}
                onChange={(text) => patch(index, { text })}
              />
            )}
            {tag === "a" && (
              <Input
                label="链接地址"
                required
                value={string(element.href)}
                onChange={(e) => patch(index, { href: e.target.value })}
              />
            )}
            {tag === "at" && (
              <Input
                label="用户 ID（所有人为 all）"
                required
                value={string(element.user_id)}
                onChange={(e) => patch(index, { user_id: e.target.value })}
              />
            )}
            {tag === "img" && (
              <Input
                label="图片 Key"
                required
                value={string(element.image_key)}
                onChange={(e) => patch(index, { image_key: e.target.value })}
              />
            )}
            {!["text", "a", "at", "img"].includes(tag) && (
              <Fields
                value={element}
                onChange={(v) =>
                  onChange(value.map((item, i) => (i === index ? v : item)))
                }
              />
            )}
          </div>
        );
      })}
      <div className="flex gap-2 flex-wrap">
        {Object.entries({
          text: "文本",
          a: "链接",
          at: "提及",
          img: "图片",
        }).map(([tag, label]) => (
          <Button
            size="sm"
            type="button"
            key={tag}
            onClick={() =>
              onChange([
                ...value,
                {
                  tag,
                  ...(tag === "at"
                    ? { user_id: "all" }
                    : tag === "img"
                      ? { image_key: "" }
                      : tag === "a"
                        ? { text: "", href: "" }
                        : { text: "" }),
                },
              ])
            }
          >
            添加{label}
          </Button>
        ))}
      </div>
    </div>
  );
}
function CardActions({
  value,
  onChange,
}: {
  value: unknown[];
  onChange: (v: unknown[]) => void;
}) {
  return (
    <div className="grid gap-4">
      {value.map((item, index) => {
        const b = object(item);
        const patch = (fields: MessageObject) =>
          onChange(
            value.map((old, i) => (i === index ? { ...b, ...fields } : old)),
          );
        return (
          <div className="rich-element" key={index}>
            <div className="section-toolbar">
              <h3>按钮 {index + 1}</h3>
              <OrderActions
                index={index}
                total={value.length}
                onMove={(d) => onChange(move(value, index, d))}
                onRemove={() => onChange(value.filter((_, i) => i !== index))}
              />
            </div>
            {b.tag === "button" ? (
              <>
                <Input
                  label={`按钮 ${index + 1} 文字`}
                  required
                  value={string(object(b.text).content)}
                  onChange={(e) =>
                    patch({
                      text: {
                        ...object(b.text),
                        tag: "plain_text",
                        content: e.target.value,
                      },
                    })
                  }
                />
                <Input
                  label={`按钮 ${index + 1} 链接地址`}
                  value={string(b.url)}
                  onChange={(e) => patch({ url: e.target.value })}
                />
                <Select<string>
                  label={`按钮 ${index + 1} 样式`}
                  value={string(b.type) || "default"}
                  items={{ default: "普通", primary: "主要", danger: "警示" }}
                  onValueChange={(type) => patch({ type })}
                />
              </>
            ) : (
              <Fields
                value={b}
                onChange={(v) =>
                  onChange(value.map((old, i) => (i === index ? v : old)))
                }
              />
            )}
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        onClick={() =>
          onChange([
            ...value,
            {
              tag: "button",
              text: { tag: "plain_text", content: "打开链接" },
              url: "",
              type: "default",
            },
          ])
        }
      >
        添加同组按钮
      </Button>
    </div>
  );
}
