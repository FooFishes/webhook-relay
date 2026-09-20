import { useEffect, useState } from "react";
import { Button, Select } from "@cloudflare/kumo";
import type { Api } from "./api";
import type { SourceProvider, DestinationProvider } from "./types";
import type { MessageObject } from "./message-model";
import { MessageEditor } from "./MessageEditor";
import { MessageView } from "./MessageView";

export function MessageComposer({
  active,
  variables,
  api,
  sourceName,
  sourceProvider,
  provider,
  value,
  onChange,
}: {
  active: boolean;
  variables?: Record<string, string>;
  api: Api;
  sourceName: string;
  sourceProvider?: SourceProvider;
  provider?: DestinationProvider;
  value: MessageObject;
  onChange: (value: MessageObject) => void;
}) {
  const [selection, setSelection] = useState({ provider: "", index: 0 });
  const [retry, setRetry] = useState(0);
  const [rendered, setRendered] = useState<{
    key: string;
    payload?: unknown;
    error?: string;
  } | null>(null);
  const index = selection.provider === sourceProvider?.id ? selection.index : 0;
  const samples = sourceProvider?.samples?.length
    ? sourceProvider.samples
    : [{ name: "来源示例", payload: sourceProvider?.sample }];
  const request = JSON.stringify({
    payload_template: value,
    sample: samples[index]?.payload ?? sourceProvider?.sample,
    source_name: sourceName,
    source_provider: sourceProvider?.id,
    destination_provider: provider?.id,
  });
  const ready = active && !!sourceProvider && !!provider;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api<{ payload: unknown }>("/preview", "POST", JSON.parse(request))
        .then((result) => {
          if (!cancelled)
            setRendered({ key: request, payload: result.payload });
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setRendered({
              key: request,
              error: error instanceof Error ? error.message : "预览失败",
            });
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ready, request, api, retry]);
  const current = rendered?.key === request ? rendered : null;
  return (
    <div className="grid gap-5">
      <div className="composer-columns">
        <div className="min-w-0">
          <MessageEditor
            variables={variables}
            provider={provider}
            value={value}
            onChange={onChange}
          />
        </div>
        <aside className="composer-preview" aria-label="实时预览">
          <h3>消息预览</h3>
          {sourceProvider && samples.length > 1 && (
            <Select<string>
              label="示例事件"
              value={String(index)}
              items={Object.fromEntries(
                samples.map((sample, i) => [String(i), sample.name]),
              )}
              onValueChange={(value) =>
                setSelection({
                  provider: sourceProvider.id,
                  index: Number(value),
                })
              }
            />
          )}
          <div className="preview-conversation">
            {!ready ? (
              <p className="text-kumo-subtle">
                选择事件来源和通知目标后即可预览。
              </p>
            ) : !current ? (
              <p role="status">正在更新预览…</p>
            ) : current.error ? (
              <div role="alert" className="error-box">
                <p>{current.error}</p>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setRendered(null);
                    setRetry((n) => n + 1);
                  }}
                >
                  重新预览
                </Button>
              </div>
            ) : (
              <MessageView provider={provider} value={current.payload} />
            )}
          </div>
          <p className="text-kumo-subtle">
            示例预览，不会发送通知；实际排版以客户端为准。
          </p>
        </aside>
      </div>
    </div>
  );
}
