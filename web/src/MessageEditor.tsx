import type { DestinationProvider } from "./types";
import type { MessageObject } from "./message-model";
import {
  FeishuMessageEditor,
  VariableContext,
} from "./providers/feishu/MessageEditor";
const editors = { feishu: FeishuMessageEditor };
export function MessageEditor({
  provider,
  value,
  onChange,
  variables,
}: {
  provider?: DestinationProvider;
  value: MessageObject;
  variables?: Record<string, string>;
  onChange: (v: MessageObject) => void;
}) {
  if (!provider) return <p className="text-kumo-subtle">请选择通知目标</p>;
  const Editor = editors[provider.editor as keyof typeof editors];
  if (!Editor)
    return (
      <p role="alert" className="error-box">
        当前客户端不支持此目标的消息编辑器
      </p>
    );
  return variables ? (
    <VariableContext.Provider value={variables}>
      <Editor value={value} onChange={onChange} />
    </VariableContext.Provider>
  ) : (
    <Editor value={value} onChange={onChange} />
  );
}
