import type { DestinationProvider } from "./types";
import { FeishuMessageView } from "./providers/feishu/MessageView";
const previews = { feishu: FeishuMessageView };
export function MessageView({
  provider,
  value,
}: {
  provider?: DestinationProvider;
  value: unknown;
}) {
  const Preview = provider
    ? previews[provider.editor as keyof typeof previews]
    : undefined;
  return Preview ? (
    <Preview value={value} />
  ) : (
    <p className="text-kumo-subtle">此目标没有可用的内容预览</p>
  );
}
