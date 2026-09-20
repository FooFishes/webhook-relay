import { useState } from "react";
import { Button, Input, InputArea, Select, Switch } from "@cloudflare/kumo";
import { Trash, ArrowUp, ArrowDown } from "@phosphor-icons/react";
import { object, string, move } from "./message-model";
const fieldLabels: Record<string, string> = {
  msg_type: "消息类型",
  content: "内容",
  post: "富文本",
  card: "卡片",
  header: "标题区",
  title: "标题",
  text: "文字",
  tag: "元素类型",
  elements: "内容块",
  body: "主体",
  actions: "按钮",
  url: "链接地址",
  href: "链接地址",
  type: "样式",
  template: "主题颜色",
  schema: "卡片版本",
  config: "卡片设置",
  wide_screen_mode: "宽屏模式",
  enable_forward: "允许转发",
  image_key: "图片 Key",
  share_chat_id: "群 ID",
  zh_cn: "简体中文",
  en_us: "English",
};
// A typed field form also preserves less common provider fields; never serializes
// them into a JSON text area or drops them when the user edits a common field.
export function Fields({
  value,
  onChange,
  label = "字段",
  depth = 0,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  label?: string;
  depth?: number;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("text");
  const defaults: Record<string, unknown> = {
    text: "",
    number: 0,
    boolean: false,
    object: {},
    array: [],
    null: null,
  };
  if (depth > 24)
    return <p className="text-kumo-danger">字段嵌套过深，无法在此编辑。</p>;
  if (Array.isArray(value))
    return (
      <div className="field-group">
        {value.map((v, i) => (
          <div className="field-item" key={i}>
            <Fields
              label={`${label} ${i + 1}`}
              value={v}
              depth={depth + 1}
              onChange={(next) =>
                onChange(value.map((old, index) => (i === index ? next : old)))
              }
            />
            <FieldOrderActions
              index={i}
              total={value.length}
              onMove={(d) => onChange(move(value, i, d))}
              onRemove={() => onChange(value.filter((_, index) => index !== i))}
            />
          </div>
        ))}
        <div className="flex gap-2">
          <Select<string>
            aria-label={`${label}新增项类型`}
            value={kind}
            items={{
              text: "文字",
              number: "数字",
              boolean: "开关",
              object: "字段组",
              array: "列表",
              null: "空值",
            }}
            onValueChange={(v) => setKind(v || "text")}
          />
          <Button
            type="button"
            size="sm"
            onClick={() =>
              onChange([...value, structuredClone(defaults[kind])])
            }
          >
            添加项目
          </Button>
        </div>
      </div>
    );
  if (value !== null && typeof value === "object")
    return (
      <div className="field-group">
        {Object.entries(object(value)).map(([key, v]) => (
          <div className="field-item" key={key}>
            <div className="grow min-w-0">
              {v !== null && typeof v === "object" ? (
                <details open={depth < 2}>
                  <summary>{fieldLabels[key] || key}</summary>
                  <Fields
                    value={v}
                    label={fieldLabels[key] || key}
                    depth={depth + 1}
                    onChange={(next) =>
                      onChange({ ...object(value), [key]: next })
                    }
                  />
                </details>
              ) : (
                <Fields
                  value={v}
                  label={fieldLabels[key] || key}
                  depth={depth + 1}
                  onChange={(next) =>
                    onChange({ ...object(value), [key]: next })
                  }
                />
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              shape="square"
              aria-label={`删除字段 ${fieldLabels[key] || key}`}
              icon={<Trash size={14} />}
              onClick={() =>
                onChange(
                  Object.fromEntries(
                    Object.entries(object(value)).filter(([k]) => k !== key),
                  ),
                )
              }
            />
          </div>
        ))}
        <div className="flex gap-2 flex-wrap">
          <Input
            aria-label={`${label}新增字段名`}
            placeholder="字段名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select<string>
            aria-label={`${label}新增字段类型`}
            value={kind}
            items={{
              text: "文字",
              number: "数字",
              boolean: "开关",
              object: "字段组",
              array: "列表",
              null: "空值",
            }}
            onValueChange={(v) => setKind(v || "text")}
          />
          <Button
            type="button"
            size="sm"
            disabled={!name.trim() || Object.hasOwn(object(value), name.trim())}
            onClick={() => {
              onChange({
                ...object(value),
                [name.trim()]: structuredClone(defaults[kind]),
              });
              setName("");
            }}
          >
            添加字段
          </Button>
        </div>
      </div>
    );
  if (typeof value === "boolean")
    return <Switch label={label} checked={value} onCheckedChange={onChange} />;
  if (typeof value === "number")
    return (
      <Input
        label={label}
        type="number"
        step="any"
        value={value}
        onChange={(e) => {
          if (e.target.value !== "" && Number.isFinite(Number(e.target.value)))
            onChange(Number(e.target.value));
        }}
      />
    );
  if (value === null)
    return (
      <div className="flex gap-2 items-center">
        <span>{label} · 空值</span>
        <Button type="button" size="sm" onClick={() => onChange("")}>
          改为文字
        </Button>
      </div>
    );
  return (
    <InputArea
      label={label}
      value={string(value)}
      rows={2}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function FieldOrderActions({
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
        type="button"
        size="sm"
        variant="ghost"
        shape="square"
        aria-label="上移"
        icon={<ArrowUp size={14} />}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        shape="square"
        aria-label="下移"
        icon={<ArrowDown size={14} />}
        disabled={index === total - 1}
        onClick={() => onMove(1)}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        shape="square"
        aria-label="删除项目"
        icon={<Trash size={14} />}
        onClick={onRemove}
      />
    </div>
  );
}
