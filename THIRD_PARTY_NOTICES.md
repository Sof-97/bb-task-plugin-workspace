# Third-party notices

This plugin is a local, source-available first release. It vendors no community
Wayfinder viewer code: no source was copied or adapted from the community
viewers inventoried during planning, so no additional MIT notice is required
for them. The local reader derives explicit-status tickets from files the human
attaches.

The following third-party packages are used directly. Each package ships its
own license text under `node_modules/<package>/`; versions are the ones pinned
by `package-lock.json` at the verified runtime.

## Runtime dependencies

| Package                            | Version | License |
| ---------------------------------- | ------- | ------- |
| `@hugeicons/core-free-icons`       | 4.3.2   | MIT     |
| `@hugeicons/react`                 | 1.1.10  | MIT     |
| `@radix-ui/react-checkbox`         | 1.3.11  | MIT     |
| `@radix-ui/react-slot`             | 1.3.3   | MIT     |
| `decode-named-character-reference` | 1.3.0   | MIT     |
| `remark-parse`                     | 11.0.0  | MIT     |
| `remark-gfm`                       | 4.0.1   | MIT     |
| `remark-stringify`                 | 11.0.0  | MIT     |
| `unified`                          | 11.0.5  | MIT     |
| `zod`                              | 4.6.2   | MIT     |

## Development and build dependencies

| Package                                                                                                                           | Version       | License                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------- |
| `@get-bb/plugin-sdk`                                                                                                              | 0.4.47        | build-time SDK surface, no license field published |
| `@pierre/diffs`                                                                                                                   | 1.4.2         | Apache-2.0                                         |
| `@radix-ui/*` (dialog, dropdown-menu, hover-card, menubar, navigation-menu, popover, select, tooltip, alert-dialog, context-menu) | 1.1–2.3       | MIT                                                |
| `@testing-library/react`                                                                                                          | 16.3.3        | MIT                                                |
| `@types/better-sqlite3`, `@types/node`, `@types/react`, `@types/react-dom`                                                        | 7.6 / 22 / 19 | MIT                                                |
| `better-sqlite3`                                                                                                                  | 12.11.1       | MIT                                                |
| `class-variance-authority`                                                                                                        | 0.7.1         | Apache-2.0                                         |
| `clsx`                                                                                                                            | 2.1.1         | MIT                                                |
| `cron-parser`                                                                                                                     | 5.10.0        | MIT                                                |
| `hono`                                                                                                                            | 4.13.7        | MIT                                                |
| `jsdom`                                                                                                                           | 29.1.1        | MIT                                                |
| `prettier`                                                                                                                        | 3.9.6         | MIT                                                |
| `sonner`                                                                                                                          | 1.7.4         | MIT                                                |
| `tailwind-merge`                                                                                                                  | 3.6.0         | MIT                                                |
| `typescript`                                                                                                                      | 5.9.3         | Apache-2.0                                         |
| `vaul`                                                                                                                            | 1.1.2         | MIT                                                |
| `vitest`                                                                                                                          | 4.1.11        | MIT                                                |

## Vendored UI primitives

`components/ui/`, `lib/utils.ts`, `lib/portal-scope.ts` and
`hooks/useBrowserDimmingModal.ts` are adapted from the shadcn/ui "new-york" style and the BB
plugin registry (`components.json` `registries.@bb`), both MIT-licensed, and
include the responsive dialog and its supporting primitives from BB desktop-v0.42.1. `@hugeicons/*` icon data and
React bindings are MIT-licensed.

No package is redistributed in a modified binary form by this repository; the
built `dist/` bundle is ignored and rebuilt locally. License texts are available
from each installed package under `node_modules/`, from npm, or from the
package's upstream repository.

## Preserved vendored-source license texts

BB scaffold source: [BB desktop-v0.42.1 license](https://raw.githubusercontent.com/get-bb/bb/desktop-v0.42.1/LICENSE).

shadcn/ui source: [upstream license](https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md).

```text
MIT License

Copyright (c) 2026 Michael Yong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
