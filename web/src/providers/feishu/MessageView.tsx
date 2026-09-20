import { object, string } from "./message-model";
function Markdown({ text }: { text: string }) {
  // Render a small safe subset; never interpret payload strings as HTML.
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong className="font-medium" key={i}>
            {part.slice(2, -2)}
          </strong>
        ) : (
          part
        ),
      )}
    </>
  );
}
export function FeishuMessageView({ value }: { value: unknown }) {
  const message = object(value);
  const content = object(message.content);
  const card = object(message.card);
  if (message.msg_type === "text")
    return (
      <div className="message-view">
        <p className="whitespace-pre-wrap break-words">
          {string(content.text) || "暂无消息内容"}
        </p>
      </div>
    );
  if (message.msg_type === "post") {
    const entry = object(Object.values(object(content.post))[0]);
    return (
      <div className="message-view">
        <h3>{string(entry.title)}</h3>
        {(Array.isArray(entry.content) ? entry.content : []).map((row, i) => (
          <p className="whitespace-pre-wrap break-words" key={i}>
            {(Array.isArray(row) ? row : []).map((v, j) => {
              const e = object(v);
              return (
                <span key={j}>
                  {e.tag === "at"
                    ? `@${string(e.user_id)}`
                    : e.tag === "img"
                      ? "[图片]"
                      : string(e.text)}
                </span>
              );
            })}
          </p>
        ))}
      </div>
    );
  }
  if (message.msg_type === "interactive") {
    const elems =
      card.schema === "2.0" ? object(card.body).elements : card.elements;
    return (
      <div
        className="message-view feishu-card"
        data-color={string(object(card.header).template) || "blue"}
      >
        <h3 className="card-heading">
          {string(object(object(card.header).title).content)}
        </h3>
        {(Array.isArray(elems) ? elems : []).map((v, i) => {
          const b = object(v);
          if (b.tag === "hr") return <hr key={i} />;
          if (b.tag === "action")
            return (
              <div key={i} className="flex flex-wrap gap-2">
                {(Array.isArray(b.actions) ? b.actions : []).map(
                  (action, j) => (
                    <span className="preview-card-button" key={j}>
                      {string(object(object(action).text).content) ||
                        "操作按钮"}
                    </span>
                  ),
                )}
              </div>
            );
          if (b.tag === "note")
            return (
              <p key={i} className="preview-card-note">
                {(Array.isArray(b.elements) ? b.elements : [])
                  .map((e) => string(object(e).content))
                  .join("\n")}
              </p>
            );
          const text = string(b.content) || string(object(b.text).content);
          if (b.tag === "div" || b.tag === "markdown")
            return (
              <div className="whitespace-pre-wrap break-words" key={i}>
                {b.tag === "markdown" || object(b.text).tag === "lark_md" ? (
                  <Markdown text={text} />
                ) : (
                  text
                )}
                {Array.isArray(b.fields) && (
                  <div className="grid grid-cols-2 gap-3">
                    {b.fields.map((field, j) => (
                      <span key={j}>
                        {string(object(object(field).text).content)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          return (
            <p className="text-kumo-subtle" key={i}>
              [此内容块暂不支持预览：{string(b.tag)}]
            </p>
          );
        })}
      </div>
    );
  }
  return (
    <div className="message-view">
      <span>{message.msg_type === "image" ? "图片消息" : "群名片"}</span>
      <p className="text-kumo-subtle break-all">
        {string(content.image_key) || string(content.share_chat_id)}
      </p>
    </div>
  );
}
