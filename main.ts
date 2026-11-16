// Harness driver: reads /input/cases.json (or $MAKEFUN_INPUT_DIR), renders
// each case on its own with parse(), writes /output/html.json (or
// $MAKEFUN_OUTPUT_DIR). Run with no arguments as `node main.ts`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

type Case = { id: string; markdown: string };

const cases: Case[] = JSON.parse(readFileSync(join(inputDir, "cases.json"), "utf8"));
const html: string[] = cases.map((c) => parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
