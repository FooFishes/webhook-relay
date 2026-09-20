import { useState } from "react";
import { Button, Checkbox, Input, Select } from "@cloudflare/kumo";

export function EventFilter({
  value,
  eventNames = {},
  onChange,
}: {
  value: string[];
  eventNames?: Record<string, string>;
  onChange: (v: string[]) => void;
}) {
  const [custom, setCustom] = useState("");
  const choices = {
    ...eventNames,
    ...Object.fromEntries(
      value.filter((v) => !eventNames[v]).map((v) => [v, v]),
    ),
  };
  return (
    <div className="grid gap-3">
      <Select<string>
        label="匹配事件"
        value={value.length ? "selected" : "all"}
        items={{ all: "全部事件", selected: "指定事件" }}
        onValueChange={(v) =>
          onChange(
            v === "all" ? [] : [Object.keys(eventNames)[0] || "customEvent"],
          )
        }
      />
      {value.length > 0 && (
        <>
          <div className="event-options">
            {Object.entries(choices).map(([key, label]) => (
              <Checkbox
                key={key}
                label={label}
                checked={value.includes(key)}
                disabled={value.length === 1 && value[0] === key}
                onCheckedChange={(checked) =>
                  onChange(
                    checked ? [...value, key] : value.filter((v) => v !== key),
                  )
                }
              />
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              aria-label="自定义事件类型"
              placeholder="自定义事件类型"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <Button
              type="button"
              disabled={!custom.trim() || value.includes(custom.trim())}
              onClick={() => {
                onChange([...value, custom.trim()]);
                setCustom("");
              }}
            >
              添加
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
