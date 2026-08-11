import type { Content, Message } from "spectrum-ts";

/** Flatten one Spectrum message without assuming caption/file ordering. */
export function parts(message: Message): Content[] {
  if (message.content.type === "group") {
    return message.content.items.map((item) => item.content);
  }
  return [message.content];
}

export function textOf(contents: Content[]): string {
  return contents
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
}

export function attachmentsOf(contents: Content[]) {
  return contents.filter((part) => part.type === "attachment");
}

/** What lands in messages.content — a turn can carry both text and files. */
export function summarize(contents: Content[]): string {
  const text = textOf(contents);
  const files = attachmentsOf(contents).map((part) => part.name);
  return [text, files.length ? `[${files.join(", ")}]` : ""].filter(Boolean).join(" ").trim();
}
