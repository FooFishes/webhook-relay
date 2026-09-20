import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Dialog,
  Input,
  Select,
  Switch,
  Table,
} from "@cloudflare/kumo";
import {
  Plus,
  Copy,
  PencilSimple,
  Trash,
  ArrowRight,
  Eye,
} from "@phosphor-icons/react";
import type { Api } from "./api";
import type { Config, Kind, Meta, Resource } from "./types";
import { labels, initialConfig, formatTime } from "./types";

import {
  EventTemplateEditor,
  defaultEventTemplates,
} from "./EventTemplateEditor";
import { MessageComposer } from "./MessageComposer";
import { object } from "./message-model";
import type { MessageObject } from "./message-model";
import { MessageStudio } from "./MessageStudio";
import { builtinPolicy } from "./message-policy";
import { EventFilter } from "./EventFilter";
import { PreviewDialog } from "./PreviewDialog";
import { KeyPicker } from "./KeyPicker";

export function Resources({
  kind,
  data,
  meta,
  api,
}: {
  kind: Kind;
  data: Record<Kind, Resource[]>;
  meta: Meta;
  api: Api;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Resource | null>(null);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Config>(initialConfig(kind));
  const [policyMode, setPolicyMode] = useState(false);
  const [routeSection, setRouteSection] = useState("connection");
  const [eventTemplateMode, setEventTemplateMode] = useState(false);
  const [template, setTemplate] = useState<MessageObject>({});
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("");
  const [targetSwitch, setTargetSwitch] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<Resource | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const client = useQueryClient();
  const providers =
    kind === "sources"
      ? meta.source_providers
      : kind === "destinations"
        ? meta.destination_providers
        : [];
  const provider = providers.find((p) => p.id === config.provider);
  const sourceInstance = data.sources.find((r) => r.id === config.source_id);
  const sourceProvider = meta.source_providers.find(
    (p) => p.id === sourceInstance?.config.provider,
  );
  const targetInstance = data.destinations.find(
    (r) => r.id === config.destination_id,
  );
  const targetProvider = meta.destination_providers.find(
    (p) => p.id === targetInstance?.config.provider,
  );
  const supportsEventTemplates =
    !!sourceProvider?.event_definitions && !!targetProvider;
  const supportsPolicy =
    !!targetProvider?.message_styles &&
    Object.values(sourceProvider?.event_definitions || {}).some(
      (d) => d.content_template,
    );
  const usePolicy = supportsPolicy && (policyMode || !editing);
  const useEventTemplates =
    !usePolicy && supportsEventTemplates && (eventTemplateMode || !editing);
  const policy = config.message_policy || builtinPolicy();
  const eventTemplateMap =
    config.event_templates ||
    (supportsEventTemplates
      ? defaultEventTemplates(
          sourceProvider!,
          targetProvider!,
          meta.message_presets || [],
        )
      : {});
  const rows = data[kind].filter(
    (row) =>
      row.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
      (!providerFilter || row.config.provider === providerFilter) &&
      (statusFilter === "all" ||
        Boolean(row.config.enabled) === (statusFilter === "enabled")),
  );
  const toggle = useMutation({
    mutationFn: (row: Resource) =>
      api<Resource>(`/resources/${kind}/${row.id}`, "PUT", {
        name: row.name,
        revision: row.revision,
        config: { ...row.config, enabled: !row.config.enabled },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["resources"] });
      void client.invalidateQueries({ queryKey: ["overview"] });
      setError("");
    },
    onError: (e) => setError(e.message),
  });
  function change<K extends keyof Config>(key: K, value: Config[K]) {
    const sourceChanged =
      key === "source_id" &&
      data.sources.find((r) => r.id === value)?.config.provider !==
        sourceInstance?.config.provider;
    if (sourceChanged) setEventTypes([]);
    setConfig((c) => {
      const next = { ...c, [key]: value };
      if (sourceChanged) {
        delete next.event_templates;
        delete next.message_policy;
      }
      return next;
    });
  }
  function chooseProvider(id: string) {
    const selected = providers.find((p) => p.id === id);
    setConfig({ enabled: config.enabled, provider: id, ...selected?.defaults });
  }
  function chooseTarget(id: string) {
    const next = data.destinations.find((r) => r.id === id);
    const adapter = meta.destination_providers.find(
      (p) => p.id === next?.config.provider,
    );
    if (targetProvider && adapter && targetProvider.id !== adapter.id) {
      setTargetSwitch(id);
      return;
    }
    change("destination_id", id);
    if (!targetProvider && adapter)
      setTemplate(structuredClone(object(adapter.default_template)));
  }
  function start(row?: Resource) {
    setEditing(row || null);
    setName(row?.name || "");
    const next = row ? { ...row.config } : initialConfig(kind);
    if (kind === "keys") {
      delete next.has_value;
      next.value = "";
    }
    setConfig(next);
    setEventTemplateMode(!!next.event_templates);
    setPolicyMode(
      !!next.message_policy ||
        (!next.event_templates && !next.payload_template),
    );
    setRouteSection("connection");
    setTemplate(structuredClone(object(next.payload_template)));
    setEventTypes(next.event_types || []);
    setError("");

    setNotice("");
    setOpen(true);
  }
  function close() {
    setOpen(false);
    setConfig((c) => ({ ...c, value: "" }));
  }
  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) {
        setRouteSection("connection");
        throw new Error("请填写配置名称。");
      }
      let next = { ...config };
      if (kind === "routes")
        next = {
          ...next,
          ...(usePolicy
            ? { message_policy: policy }
            : useEventTemplates
              ? { event_templates: eventTemplateMap }
              : { payload_template: template }),
          event_types: eventTypes,
        };
      if (kind === "routes") {
        if (usePolicy) {
          delete next.payload_template;
          delete next.event_templates;
        } else {
          delete next.message_policy;
          if (useEventTemplates) delete next.payload_template;
          else delete next.event_templates;
        }
      }
      return api<Resource>(
        `/resources/${kind}${editing ? `/${editing.id}` : ""}`,
        editing ? "PUT" : "POST",
        { name, config: next, revision: editing?.revision },
      );
    },
    onSuccess: () => {
      close();
      setNotice("配置已保存。");
      void client.invalidateQueries({ queryKey: ["resources"] });
      void client.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/resources/${kind}/${deleting!.id}`, "DELETE"),
    onSuccess: () => {
      setDeleting(null);
      setDeleteError("");
      setNotice("配置已删除，历史记录已保留。");
      void client.invalidateQueries({ queryKey: ["resources"] });
      void client.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => setDeleteError(e.message),
  });
  const nameOf = (id?: string | null) =>
    Object.values(data)
      .flat()
      .find((r) => r.id === id)?.name ||
    id ||
    "未设置";
  const pick = (
    label: string,
    key:
      | "key_id"
      | "url_key_id"
      | "signing_key_id"
      | "source_id"
      | "destination_id",
    items: Resource[],
    optional = false,
  ) => (
    <Select<string>
      label={label}
      required={!optional}
      className="w-full"
      placeholder="请选择"
      value={config[key] || ""}
      onValueChange={(value) => {
        if (key === "destination_id") chooseTarget(value || "");
        else {
          if (
            key === "source_id" &&
            sourceInstance?.config.provider !==
              data.sources.find((r) => r.id === value)?.config.provider
          )
            setEventTypes([]);
          change(key, value || null);
        }
      }}
      items={Object.fromEntries([
        ...(optional ? [["", "不启用签名"]] : []),
        ...items.map((r) => [
          r.id,
          r.name +
            " · " +
            ([...meta.source_providers, ...meta.destination_providers].find(
              (p) => p.id === r.config.provider,
            )?.name ||
              r.config.provider ||
              ""),
        ]),
      ])}
    />
  );
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("回调地址已复制。");
    } catch {
      setNotice("复制失败，请从下方手动复制回调地址。");
    }
  }
  return (
    <div className="grid gap-5">
      <div className="section-toolbar">
        <div className="flex gap-3 items-center flex-wrap">
          <Input
            aria-label="搜索配置"
            placeholder="搜索名称"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {kind !== "keys" && (
            <Select<string>
              aria-label="配置状态筛选"
              value={statusFilter}
              items={{ all: "全部状态", enabled: "已启用", disabled: "已停用" }}
              onValueChange={(v) => setStatusFilter(v || "all")}
            />
          )}
          {providers.length > 0 && (
            <Select<string>
              aria-label="平台筛选"
              value={providerFilter}
              onValueChange={(v) => setProviderFilter(v || "")}
              items={{
                "": "全部平台",
                ...Object.fromEntries(providers.map((p) => [p.id, p.name])),
              }}
            />
          )}
          <span className="text-kumo-subtle">
            {rows.length} / {data[kind].length}
          </span>
        </div>
        <Button
          variant="primary"
          icon={<Plus size={16} />}
          onClick={() => start()}
        >
          添加{labels[kind]}
        </Button>
      </div>
      {notice && (
        <p role="status" className="notice-box">
          {notice}
        </p>
      )}
      {rows.length === 0 ? (
        <section className="empty-state">
          <h2>
            {data[kind].length ? "没有匹配的配置" : `暂无${labels[kind]}`}
          </h2>
        </section>
      ) : (
        <div className="table-shell">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>
                  {kind === "sources" || kind === "destinations"
                    ? "实例名称"
                    : "名称"}
                </Table.Head>
                <Table.Head>
                  {kind === "routes" ? "来源 → 目标" : "平台与连接"}
                </Table.Head>
                <Table.Head>状态</Table.Head>
                <Table.Head>更新时间</Table.Head>
                <Table.Head>操作</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    <div className="font-medium">{row.name}</div>
                    <span className="text-kumo-subtle">
                      版本 {row.revision}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    {kind === "keys" ? (
                      <span>已加密保存 · 不回显</span>
                    ) : kind === "sources" ? (
                      <div className="grid gap-1">
                        <span>
                          {meta.source_providers.find(
                            (p) => p.id === row.config.provider,
                          )?.name || row.config.provider}
                        </span>
                        <div className="flex items-center gap-2">
                          <code className="break-all">
                            {meta.public_url}/hooks/{row.id}
                          </code>
                          <Button
                            size="sm"
                            variant="ghost"
                            shape="square"
                            aria-label={`复制 ${row.name} 回调地址`}
                            icon={<Copy size={16} />}
                            onClick={() =>
                              void copy(`${meta.public_url}/hooks/${row.id}`)
                            }
                          />
                        </div>
                      </div>
                    ) : kind === "destinations" ? (
                      <div>
                        {meta.destination_providers.find(
                          (p) => p.id === row.config.provider,
                        )?.name || row.config.provider}
                        <p className="text-kumo-subtle">
                          {
                            data.routes.filter(
                              (r) => r.config.destination_id === row.id,
                            ).length
                          }{" "}
                          条关联规则
                        </p>
                      </div>
                    ) : (
                      <div>
                        <span className="inline-flex items-center gap-2">
                          {nameOf(row.config.source_id)}{" "}
                          <ArrowRight size={14} />
                          {nameOf(row.config.destination_id)}
                        </span>
                        <p className="text-kumo-subtle">
                          {row.config.event_types?.length
                            ? `${row.config.event_types.length} 类事件`
                            : "所有事件"}{" "}
                          · 最多 {row.config.max_attempts} 次投递
                        </p>
                      </div>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <Badge
                      variant={
                        kind === "keys" || row.config.enabled
                          ? "success"
                          : "neutral"
                      }
                    >
                      {kind === "keys"
                        ? "已保存"
                        : row.config.enabled
                          ? "已启用"
                          : "已停用"}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">
                    {formatTime(row.updated_at)}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex gap-2 items-center">
                      {kind !== "keys" && (
                        <Switch
                          label={`启用 ${row.name}`}
                          checked={row.config.enabled || false}
                          disabled={toggle.isPending}
                          onCheckedChange={() => toggle.mutate(row)}
                        />
                      )}
                      <Button
                        size="sm"
                        icon={<PencilSimple size={14} />}
                        onClick={() => start(row)}
                      >
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        shape="square"
                        aria-label={`删除 ${row.name}`}
                        icon={<Trash size={16} />}
                        onClick={() => {
                          setDeleting(row);
                          setDeleteError("");
                        }}
                      />
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      {!open && error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (!save.isPending) {
            if (value) setOpen(true);
            else close();
          }
        }}
      >
        <Dialog
          size={kind === "routes" ? "xl" : "lg"}
          className={`dialog-body ${kind === "routes" ? "route-editor-dialog" : ""}`}
        >
          <Dialog.Title className="text-xl font-semibold">
            {editing ? "编辑" : "添加"}
            {labels[kind]}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-kumo-subtle">
            {kind === "keys"
              ? "密钥加密保存；编辑时留空表示保留原值。"
              : "保存后立即生效。已有投递任务保留原配置。"}
          </Dialog.Description>
          {kind === "routes" && supportsPolicy && (
            <div className="route-section-tabs">
              <button
                type="button"
                className={routeSection === "connection" ? "selected" : ""}
                onClick={() => setRouteSection("connection")}
              >
                连接与规则
              </button>
              <button
                type="button"
                className={routeSection === "templates" ? "selected" : ""}
                onClick={() => setRouteSection("templates")}
              >
                消息模板
              </button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError("");
              save.mutate();
            }}
            className="mt-6 grid gap-5"
          >
            <div
              hidden={
                kind === "routes" &&
                supportsPolicy &&
                routeSection === "templates"
              }
            >
              <Input
                label="名称"
                required={
                  !(
                    kind === "routes" &&
                    supportsPolicy &&
                    routeSection === "templates"
                  )
                }
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {kind === "keys" && (
              <Input
                label={editing ? "替换密钥值（可留空）" : "密钥值"}
                type="password"
                autoComplete="new-password"
                required={!editing}
                value={config.value || ""}
                onChange={(e) => change("value", e.target.value)}
              />
            )}
            {(kind === "sources" || kind === "destinations") && (
              <>
                <Select<string>
                  label={kind === "sources" ? "来源平台" : "目标平台"}
                  required
                  disabled={!!editing}
                  placeholder="选择平台"
                  value={config.provider || ""}
                  items={Object.fromEntries(
                    providers.map((p) => [p.id, p.name + " · " + p.category]),
                  )}
                  onValueChange={(v) => chooseProvider(v || "")}
                />
                {provider?.fields.map((field) => (
                  <KeyPicker
                    key={provider.id + field.key}
                    label={field.label}
                    value={
                      typeof config[field.key] === "string"
                        ? (config[field.key] as string)
                        : null
                    }
                    keys={data.keys}
                    onChange={(v) => change(field.key, v)}
                    api={api}
                    optional={!field.required}
                  />
                ))}
              </>
            )}
            {kind === "routes" && (
              <>
                <div hidden={supportsPolicy && routeSection === "templates"}>
                  <div className="form-columns">
                    {pick("事件来源", "source_id", data.sources)}
                    {pick("通知目标", "destination_id", data.destinations)}
                  </div>
                  <EventFilter
                    value={eventTypes}
                    onChange={setEventTypes}
                    eventNames={sourceProvider?.event_types}
                  />
                  {usePolicy && (
                    <div className="route-template-summary">
                      <p>
                        {Object.keys(policy.overrides).length
                          ? `${Object.keys(policy.overrides).length} 个事件已自定义`
                          : "使用内置模板"}
                      </p>
                      <Button
                        type="button"
                        onClick={() => setRouteSection("templates")}
                      >
                        编辑模板
                      </Button>
                    </div>
                  )}
                </div>
                <section
                  className={
                    usePolicy ? "route-studio-section" : "editor-section"
                  }
                  hidden={supportsPolicy && routeSection !== "templates"}
                >
                  <div className="section-toolbar mb-4" hidden={usePolicy}>
                    <h2>
                      消息内容
                      {targetProvider ? " · " + targetProvider.name : ""}
                    </h2>
                    <Button
                      type="button"
                      icon={<Eye size={16} />}
                      disabled={
                        !sourceProvider || !targetProvider || useEventTemplates
                      }
                      onClick={() => setPreviewOpen(true)}
                    >
                      预览消息
                    </Button>
                  </div>
                  {!usePolicy && supportsPolicy && (
                    <div className="notice-box mb-4">
                      <p>切换将替换当前消息配置，保存后生效。</p>
                      <Button type="button" onClick={() => setPolicyMode(true)}>
                        使用完整内置预设
                      </Button>
                    </div>
                  )}
                  {usePolicy ? (
                    <MessageStudio
                      active={open && routeSection === "templates"}
                      api={api}
                      sourceName={sourceInstance?.name || "我的应用"}
                      source={sourceProvider!}
                      target={targetProvider!}
                      pairs={meta.pair_presets || []}
                      eventTypes={eventTypes}
                      value={policy}
                      onChange={(value) => change("message_policy", value)}
                    />
                  ) : useEventTemplates ? (
                    <EventTemplateEditor
                      active={open}
                      api={api}
                      sourceName={sourceInstance?.name || "预览来源"}
                      source={sourceProvider!}
                      target={targetProvider!}
                      presets={meta.message_presets || []}
                      eventTypes={eventTypes}
                      value={eventTemplateMap}
                      onChange={(value) => change("event_templates", value)}
                    />
                  ) : (
                    <>
                      {supportsEventTemplates && (
                        <Button
                          type="button"
                          onClick={() => setEventTemplateMode(true)}
                        >
                          改为按事件配置模板
                        </Button>
                      )}
                      <MessageComposer
                        key={`${editing?.id || "new"}:${open}:${sourceProvider?.id}:${targetProvider?.id}`}
                        active={open}
                        api={api}
                        sourceName={sourceInstance?.name || "预览来源"}
                        sourceProvider={sourceProvider}
                        provider={targetProvider}
                        value={template}
                        onChange={setTemplate}
                      />
                    </>
                  )}
                </section>
                <section
                  className="editor-section"
                  hidden={supportsPolicy && routeSection === "templates"}
                >
                  <h2 className="mb-4">投递设置</h2>
                  <Input
                    label="最多投递次数（含首次）"
                    type="number"
                    min={1}
                    max={10}
                    required
                    value={config.max_attempts || 1}
                    onChange={(e) =>
                      change("max_attempts", Number(e.target.value))
                    }
                  />
                </section>
              </>
            )}
            {kind !== "keys" &&
              !(
                kind === "routes" &&
                supportsPolicy &&
                routeSection === "templates"
              ) && (
                <Switch
                  label="启用此配置"
                  checked={config.enabled || false}
                  onCheckedChange={(value) => change("enabled", value)}
                />
              )}
            {error && (
              <p role="alert" className="error-box">
                {error}
              </p>
            )}
            <div className="route-form-footer flex justify-end gap-2">
              <Button type="button" disabled={save.isPending} onClick={close}>
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={save.isPending}
                disabled={
                  kind === "routes"
                    ? !sourceProvider || !targetProvider
                    : providers.length > 0 && !provider
                }
              >
                保存配置
              </Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
      <PreviewDialog
        key={
          String(config.source_id || "") +
          "-" +
          String(config.destination_id || "")
        }
        sourceProvider={sourceProvider}
        destinationProvider={targetProvider}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        payload={template}
        sourceName={
          data.sources.find((r) => r.id === config.source_id)?.name || name
        }
        api={api}
      />
      <Dialog.Root
        open={targetSwitch !== null}
        onOpenChange={(v) => {
          if (!v) setTargetSwitch(null);
        }}
      >
        <Dialog size="lg" className="dialog-body">
          <Dialog.Title>更换目标平台</Dialog.Title>
          <Dialog.Description>
            消息格式将改用新目标平台的默认配置，当前消息内容会被替换。
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setTargetSwitch(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                const instance = data.destinations.find(
                  (r) => r.id === targetSwitch,
                );
                const adapter = meta.destination_providers.find(
                  (p) => p.id === instance?.config.provider,
                );
                change("destination_id", targetSwitch!);
                setTemplate(structuredClone(object(adapter?.default_template)));
                setConfig((c) => {
                  const next = { ...c };
                  delete next.event_templates;
                  delete next.message_policy;
                  return next;
                });
                setTargetSwitch(null);
              }}
            >
              更换并重置消息
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
      <Dialog.Root
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v && !remove.isPending) setDeleting(null);
        }}
      >
        <Dialog size="lg" className="dialog-body">
          <Dialog.Title className="text-lg font-semibold">
            删除配置
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            确定删除“{deleting?.name}
            ”？历史记录会保留。仍被引用或存在待投递任务的配置无法删除。
          </Dialog.Description>
          {deleteError && (
            <p role="alert" className="error-box mt-4">
              {deleteError}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              disabled={remove.isPending}
              onClick={() => setDeleting(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              删除配置
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
