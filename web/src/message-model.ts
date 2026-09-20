export type MessageObject = Record<string, unknown>;
export function object(value: unknown): MessageObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as MessageObject)
    : {};
}
export function string(value: unknown) {
  return typeof value === "string" ? value : "";
}
export function move<T>(items: T[], index: number, delta: number): T[] {
  const next = [...items];
  const target = index + delta;
  if (target < 0 || target >= items.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
