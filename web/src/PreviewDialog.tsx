import { useState, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Dialog, InputArea } from "@cloudflare/kumo";
import type { Api } from "./api";
import type { SourceProvider, DestinationProvider } from "./types";
import { MessageView } from "./MessageView";
export function PreviewDialog({
  open,
  onClose,
  payload,
  sourceName,
  sourceProvider,
  destinationProvider,
  api,
}: {
  open: boolean;
  onClose: () => void;
  payload: unknown;
  sourceName: string;
  sourceProvider?: SourceProvider;
  destinationProvider?: DestinationProvider;
  api: Api;
}) {
  const [sampleText, setSample] = useState(
    JSON.stringify(sourceProvider?.sample || {}, null, 2),
  );
  const [result, setResult] = useState<unknown>(null);
  const revision = useRef(0);
  const render = useMutation({
    mutationFn: async () => ({
      revision: revision.current,
      result: await api<{ payload: unknown }>("/preview", "POST", {
        payload_template: payload,
        sample: JSON.parse(sampleText),
        source_name: sourceName,
        source_provider: sourceProvider?.id,
        destination_provider: destinationProvider?.id,
      }),
    }),
    onSuccess: (r) => {
      if (r.revision === revision.current) setResult(r.result.payload);
    },
  });
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          revision.current++;
          setResult(null);
          render.reset();
          onClose();
        }
      }}
    >
      <Dialog size="xl" className="dialog-body">
        <Dialog.Title className="text-xl font-semibold">消息预览</Dialog.Title>
        <Dialog.Description className="mt-1 text-kumo-subtle">
          预览不会发送通知。
        </Dialog.Description>
        <div className="preview-columns mt-5">
          <div className="grid gap-4">
            <InputArea
              label="预览事件"
              value={sampleText}
              className="font-mono"
              rows={15}
              onChange={(e) => {
                revision.current++;
                setSample(e.target.value);
                setResult(null);
              }}
            />
            <Button loading={render.isPending} onClick={() => render.mutate()}>
              运行预览
            </Button>
          </div>
          <div>
            <h3 className="mb-3">
              {result === null ? "消息草稿" : "转换结果"}
            </h3>
            <MessageView
              provider={destinationProvider}
              value={result || payload}
            />
            {result !== null && (
              <details className="mt-4">
                <summary>查看发送内容</summary>
                <pre className="code-panel mt-3" aria-label="转换结果">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </details>
            )}
            {render.error && (
              <p role="alert" className="error-box mt-4">
                {render.error.message}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button
            onClick={() => {
              revision.current++;
              setResult(null);
              render.reset();
              onClose();
            }}
          >
            关闭
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
