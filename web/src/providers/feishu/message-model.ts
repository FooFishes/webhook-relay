import { object } from "../../message-model";
import type { MessageObject } from "../../message-model";
export { object, string, move } from "../../message-model";
export type { MessageObject } from "../../message-model";
export const messageTypes = {
  text: "文本",
  post: "富文本",
  interactive: "消息卡片",
  image: "图片",
  share_chat: "群名片",
};
export const variables = {
  "event.source_name": "来源名称",
  "event.event_type": "事件类型",
  "event.summary": "状态摘要",
  "event.id": "事件编号",
};
export function createMessage(type: string): MessageObject {
  switch (type) {
    case "post":
      return {
        msg_type: type,
        content: {
          post: {
            zh_cn: {
              title: "通知",
              content: [[{ tag: "text", text: "请填写通知内容" }]],
            },
          },
        },
      };
    case "interactive":
      return {
        msg_type: type,
        card: {
          header: {
            title: { tag: "plain_text", content: "通知" },
            template: "blue",
          },
          elements: [
            {
              tag: "div",
              text: { tag: "lark_md", content: "请填写通知内容" },
            },
          ],
        },
      };
    case "image":
      return { msg_type: type, content: { image_key: "" } };
    case "share_chat":
      return { msg_type: type, content: { share_chat_id: "" } };
    default:
      return {
        msg_type: "text",
        content: {
          text: "[通知] {{ event.source_name }}\n请填写通知内容",
        },
      };
  }
}
// Update one visible field while preserving platform extensions and other locales.
export function patchContent(
  value: MessageObject,
  patch: MessageObject,
): MessageObject {
  return { ...value, content: { ...object(value.content), ...patch } };
}
export function patchPost(
  value: MessageObject,
  locale: string,
  patch: MessageObject,
): MessageObject {
  const post = object(object(value.content).post);
  return patchContent(value, {
    post: { ...post, [locale]: { ...object(post[locale]), ...patch } },
  });
}
