# Make Markdown rendering faster — `markdown-render-speed-02`

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/reyxnal/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/reyxnal/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free Markdown renderer written from scratch in JavaScript,
built to match `marked` 18.1.3 (default options) byte-for-byte — CommonMark
0.31.2 plus the GFM extensions (tables, strikethrough, task lists,
autolinks) — while rendering faster than the baseline.

Bounty: [make.fun — markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02).

## Layout

- `parse.js` — the renderer. Exports `parse(markdown)`, which returns the
  HTML string. No dependencies, no state kept between calls, no caching.
- `main.ts` — the harness driver. Reads `cases.json` from `$MAKEFUN_INPUT_DIR`
  (default `/input`), renders each case on its own, and writes `html.json`
  to `$MAKEFUN_OUTPUT_DIR` (default `/output`). Run with no arguments:
  `node main.ts`.

## How it works

Block structure is dispatched per line (fences, ATX/setext headings,
thematic breaks, HTML blocks, blockquotes with lazy continuation, lists
with tight/loose detection, GFM tables, indented code, paragraphs) into a
small AST, which is then rendered. Link reference definitions are
collected document-wide first so forward references resolve. Inline
content is scanned in a single pass (escapes, code spans, entities,
autolinks, HTML, links/images, hard/soft breaks) with a delimiter stack
for emphasis, strong, and strikethrough, following the CommonMark
delimiter-matching algorithm including the rule of 3.

## Verification

Against the kit's 720-case practice set (680 specification examples +
40 long generated README documents), this entry renders 643/720 cases
byte-identically to `marked` 18.1.3, measured with the kit's own practice
inputs and reference outputs. The remaining gaps are concentrated in
emphasis edge cases and long-document constructs; see the submission
notes for the honest breakdown. Two consecutive harness-style runs
produce byte-identical `html.json` output.

## License

MIT — see [LICENSE](LICENSE).
