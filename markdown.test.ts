import { expect, test } from "vitest";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import type { Node, Parent } from "unist";
import { isSafeLink, safeMarkdown } from "./markdown";

function types(node: Node): string[] {
  return [
    node.type,
    ...("children" in node
      ? (node as Parent).children.flatMap((child) => types(child))
      : []),
  ];
}

test("safe Markdown preserves GFM prose and code while making every image and raw HTML inert", () => {
  const source = `# Heading

**Strong** and [safe](https://example.test/a_(b)).

- [ ] Checklist

> Quote

<img src="https://remote.test/html.png"><script>alert(1)</script>

![inline](https://remote.test/a_(b).png)
![reference][remote]
![collapsed][]
![shortcut]

[remote]: https://remote.test/reference.png
[collapsed]: https://remote.test/collapsed.png
[shortcut]: https://remote.test/shortcut.png

\`\`\`md
![code stays code](https://remote.test/code.png)
<script>also code</script>
\`\`\`
`;
  const output = safeMarkdown(source);
  const reparsed = unified().use(remarkParse).use(remarkGfm).parse(output);
  expect(types(reparsed)).not.toContain("image");
  expect(types(reparsed)).not.toContain("imageReference");
  expect(types(reparsed)).not.toContain("html");
  expect(output).toContain("# Heading");
  expect(output).toContain("**Strong**");
  expect(output).toContain("- [ ] Checklist");
  expect(output).toContain("> Quote");
  expect(output).toContain("Image omitted: inline");
  expect(output).toContain("![code stays code](https://remote.test/code.png)");
  expect(output).toContain("<script>also code</script>");
});

test("unsafe schemes are decoded and rejected without crashing on invalid entities", () => {
  expect(isSafeLink("jav&#x61;script&colon;alert(1)")).toBe(false);
  expect(isSafeLink("java\nscript:alert(1)")).toBe(false);
  expect(isSafeLink("data:text/html,bad")).toBe(false);
  expect(isSafeLink("file:///tmp/private")).toBe(false);
  expect(isSafeLink("https://example.test")).toBe(true);
  expect(isSafeLink("/relative/path")).toBe(true);
  expect(() =>
    isSafeLink("jav&#999999999999999999999;ascript:bad"),
  ).not.toThrow();
  const output = safeMarkdown(
    "[bad](javascript:alert(1)) [entity](jav&#x61;script&colon;alert(1)) ![x](https://remote.test/x.png) [![nested](https://remote.test/nested.png)](javascript:alert(1)) [![nested-ref][pic]][bad-ref]\n\n[pic]: https://remote.test/pic.png\n[bad-ref]: data:text/html,bad",
  );
  const reparsed = unified().use(remarkParse).parse(output);
  expect(types(reparsed)).not.toContain("image");
  expect(types(reparsed)).not.toContain("imageReference");
  expect(output.toLowerCase()).not.toContain("javascript:");
});
