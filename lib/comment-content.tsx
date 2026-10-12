import { createElement, type ReactNode } from "react";
import { parseDocument } from "htmlparser2";
type ChildNode = ReturnType<typeof parseDocument>["children"][number];
import { HN } from "./links";
const tags = new Set([
  "p",
  "br",
  "pre",
  "code",
  "i",
  "em",
  "b",
  "strong",
  "ul",
  "ol",
  "li",
  "blockquote",
]);
export function commentContent(html: string): ReactNode {
  const render = (node: ChildNode, key: number): ReactNode => {
    if (node.type === "text") return node.data;
    if (node.type !== "tag") return null;
    const element = node;
    const children = element.children.map(render);
    if (element.name === "a") {
      let href: string | undefined;
      try {
        const url = new URL(element.attribs.href ?? "", HN);
        if (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        )
          href = url.href;
      } catch {}
      return createElement(
        href ? "a" : "span",
        { key, ...(href ? { href, rel: "nofollow noopener noreferrer" } : {}) },
        children,
      );
    }
    if (!tags.has(element.name))
      return createElement("span", { key }, children);
    return createElement(
      element.name,
      { key },
      element.name === "br" ? undefined : children,
    );
  };
  // Construct escaped React elements from a small allowlist. Never inject source HTML.
  return parseDocument(html, { decodeEntities: true }).children.map(render);
}
