import { expect, test } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
test("imports use only public SDK and declared public dependencies", () => {
  const result = experimental_scanPublicSdkOnly(process.cwd(), {
    allow: [
      /^react(?:\/.*)?$/,
      /^react-dom(?:\/.*)?$/,
      /^@radix-ui\/react-dialog$/,
      /^@hugeicons\/react$/,
      /^@hugeicons\/core-free-icons$/,
      /^vitest$/,
      /^@testing-library\/react$/,
      /^@radix-ui\/react-slot$/,
      /^class-variance-authority$/,
      /^clsx$/,
      /^tailwind-merge$/,
      /^decode-named-character-reference$/,
      /^mdast$/,
      /^remark-gfm$/,
      /^remark-parse$/,
      /^remark-stringify$/,
      /^unified$/,
      /^unist$/,
    ],
  });
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});
