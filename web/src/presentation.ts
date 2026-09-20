export function eventName(
  value?: string,
  eventNames: Record<string, string> = {},
) {
  return value ? eventNames[value] || value : "—";
}
export const errorNames: Record<string, string> = {
  template_render_failed: "消息模板转换失败",
  network_or_timeout: "连接失败或请求超时",
  provider_rejected: "平台拒绝了请求",
  invalid_provider_response: "平台响应格式异常",
  response_read_failed: "读取平台响应失败",
  response_too_large: "平台响应超过大小限制",
  payload_invalid_or_too_large: "消息格式错误或超过大小限制",
  destination_url_rejected: "目标地址校验失败",
  snapshot_decryption_failed: "投递配置解密失败",
  process_interrupted: "发送过程中服务中断",
};
export function errorName(value?: string | null) {
  return value ? errorNames[value] || value : "—";
}
export const statusNames: Record<string, string> = {
  pending: "等待投递",
  sending: "正在发送",
  retrying: "等待重试",
  succeeded: "投递成功",
  failed: "投递失败",
  unknown: "结果未知",
};
