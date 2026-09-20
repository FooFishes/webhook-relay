import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Input, Select } from "@cloudflare/kumo";
import type { Api } from "./api";
import type { Resource } from "./types";
export function KeyPicker({
  label,
  value,
  keys,
  onChange,
  api,
  optional = false,
}: {
  label: string;
  value: string | null | undefined;
  keys: Resource[];
  onChange: (v: string | null) => void;
  api: Api;
  optional?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [created, setCreated] = useState<Resource[]>([]);
  const client = useQueryClient();
  const choices = [
    ...keys,
    ...created.filter((r) => !keys.some((k) => k.id === r.id)),
  ];
  const save = useMutation({
    mutationFn: () =>
      api<Resource>("/resources/keys", "POST", {
        name,
        config: { value: secret },
      }),
    onSuccess: (r) => {
      setCreated([...created, r]);
      onChange(r.id);
      setSecret("");
      setOpen(false);
      void client.invalidateQueries({ queryKey: ["resources"] });
    },
  });
  return (
    <div>
      <div className="reference-picker">
        <Select<string>
          label={label}
          required={!optional}
          value={value || ""}
          onValueChange={(v) => onChange(v || null)}
          placeholder="选择密钥"
          className="w-full"
          items={Object.fromEntries([
            ...(optional ? [["", "不设置"]] : []),
            ...choices.map((r) => [r.id, r.name]),
          ])}
        />
        <Button
          type="button"
          onClick={() => {
            setName("");
            setSecret("");
            save.reset();
            setOpen(true);
          }}
        >
          新建
        </Button>
      </div>
      <Dialog.Root
        open={open}
        onOpenChange={(v) => {
          if (!save.isPending) {
            setOpen(v);
            if (!v) setSecret("");
          }
        }}
      >
        <Dialog size="lg" className="dialog-body">
          <Dialog.Title className="text-lg font-semibold">
            新建{label}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-kumo-subtle">
            保存后用于当前配置。
          </Dialog.Description>
          <form
            className="mt-5 grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              save.mutate();
            }}
          >
            <Input
              label="密钥名称"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              label="密钥值"
              required
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            {save.error && (
              <p role="alert" className="error-box">
                {save.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                disabled={save.isPending}
                onClick={() => {
                  setOpen(false);
                  setSecret("");
                }}
              >
                取消
              </Button>
              <Button type="submit" variant="primary" loading={save.isPending}>
                创建并使用
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
