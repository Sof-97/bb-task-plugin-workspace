import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import type { Root } from "mdast";
import type { Node, Parent } from "unist";

type MdNode = Node & {
  type: string;
  alt?: string | null;
  children?: MdNode[];
  identifier?: string;
  url?: string;
  value?: string;
};

function codePoint(value: string, radix: number, fallback: string) {
  const parsed = Number.parseInt(value, radix);
  return Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= 0x10ffff &&
    !(parsed >= 0xd800 && parsed <= 0xdfff)
    ? String.fromCodePoint(parsed)
    : fallback;
}

function decodeReferences(value: string) {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z][\da-z]+));?/gi,
    (match, decimal: string, hex: string, named: string) => {
      if (decimal) return codePoint(decimal, 10, match);
      if (hex) return codePoint(hex, 16, match);
      return decodeNamedCharacterReference(named) || match;
    },
  );
}

export function isSafeLink(value: string) {
  const normalized = decodeReferences(value)
    .replace(/[\u0000-\u0020\u007f]+/g, "")
    .toLowerCase();
  const scheme = normalized.match(/^([a-z][a-z\d+.-]*):/i)?.[1];
  return !scheme || ["http", "https", "mailto"].includes(scheme);
}

function inertImage(alt?: string | null): MdNode {
  return {
    type: "text",
    value: alt ? `[Image omitted: ${alt}]` : "[Image omitted]",
  };
}

function textFrom(children: MdNode[] | undefined): MdNode[] {
  return children?.length ? children : [{ type: "text", value: "Link" }];
}

function collectUnsafeDefinitions(node: MdNode, result: Set<string>) {
  if (node.type === "definition" && node.url && !isSafeLink(node.url))
    result.add(node.identifier?.toLowerCase() ?? "");
  for (const child of node.children ?? [])
    collectUnsafeDefinitions(child, result);
}

function transformChildren(parent: MdNode, unsafeDefinitions: Set<string>) {
  const transformed: MdNode[] = [];
  for (const child of parent.children ?? []) {
    if (child.type === "image" || child.type === "imageReference") {
      transformed.push(inertImage(child.alt));
      continue;
    }
    if (child.type === "html") {
      transformed.push({ type: "text", value: "[HTML omitted]" });
      continue;
    }
    if (child.type === "link" && child.url && !isSafeLink(child.url)) {
      transformChildren(child, unsafeDefinitions);
      transformed.push(...textFrom(child.children));
      continue;
    }
    if (
      child.type === "linkReference" &&
      unsafeDefinitions.has(child.identifier?.toLowerCase() ?? "")
    ) {
      transformChildren(child, unsafeDefinitions);
      transformed.push(...textFrom(child.children));
      continue;
    }
    if (
      child.type === "definition" &&
      unsafeDefinitions.has(child.identifier?.toLowerCase() ?? "")
    )
      continue;
    transformChildren(child, unsafeDefinitions);
    transformed.push(child);
  }
  parent.children = transformed;
}

export function safeMarkdown(source: string) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkStringify, { bullet: "-", fences: true });
  const tree = processor.parse(source) as MdNode;
  const unsafeDefinitions = new Set<string>();
  collectUnsafeDefinitions(tree, unsafeDefinitions);
  transformChildren(tree, unsafeDefinitions);
  return processor.stringify(tree as Root);
}
