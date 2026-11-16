// Bundles the extension into dist/: copies public/, ONNX Runtime's wasm and the
// sha256-checked model, then bundles the three entry points with esbuild.
// Usage: node lib/build.mjs [--watch]
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { models } from "../core/model/models.ts";
import { fetchModel } from "./fetch-model.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const dist = join(root, "dist");
const entries = {
  background: "src/background.ts",
  popup: "src/popup.ts",
  // A content script is a plain script, not a module.
  content: { in: "src/content.ts", format: "iife" },
};
// The small personal-data model. It ships inside the add-on and runs on the CPU,
// so the guard needs no GPU and makes no network request for it.
const MODEL = "foxmind-small";
const model = { name: MODEL, ...models[MODEL] };

// ONNX Runtime's wasm must ship inside the extension (MV3 blocks remote code).
const transformersDir = realpathSync(join(root, "node_modules/@huggingface/transformers"));
const ortDist = join(dirname(realpathSync(join(root, "node_modules/onnxruntime-web/package.json"))), "dist");
if (!existsSync(ortDist)) throw new Error(`onnxruntime-web not found at ${ortDist}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "ort"), { recursive: true });
cpSync(join(root, "public"), dist, { recursive: true });
for (const file of readdirSync(ortDist)) {
  if (/^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(file)) cpSync(join(ortDist, file), join(dist, "ort", file));
}
const cache = await fetchModel(MODEL);
for (const file of Object.keys(model.files)) {
  const to = join(dist, "models", MODEL, file);
  mkdirSync(dirname(to), { recursive: true });
  // AMO refuses text files over 5 MB. Indented tokenizer.json is 8.3 MB, minified 4 MB.
  if (file.endsWith(".json")) writeFileSync(to, JSON.stringify(JSON.parse(readFileSync(join(cache, file), "utf8"))));
  else cpSync(join(cache, file), to);
}

const common = {
  bundle: true,
  format: "esm",
  target: "firefox157",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  outdir: dist,
  absWorkingDir: root,
  alias: { "@huggingface/transformers": join(transformersDir, "dist/transformers.web.js") },
  // The models.ts entry plus its name; see core/model/load.ts.
  define: { __MODEL__: JSON.stringify(model) },
};
for (const [name, entry] of Object.entries(entries)) {
  const { in: source, ...options } = typeof entry === "string" ? { in: entry } : entry;
  const build = { ...common, ...options, entryPoints: { [name]: source } };
  if (watch) await (await esbuild.context(build)).watch();
  else await esbuild.build(build);
}
if (!watch) {
  const size = (dir) =>
    readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
  console.log(`built ${dist} (${(size(dist) / 1e6).toFixed(1)} MB)`);
}
