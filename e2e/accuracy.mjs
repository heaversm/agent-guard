// Scores Agent Guard's personal-data detector on PII Guard's 40 test messages, the same way
// PII Guard scores its own: a hit is a found span of the right type that overlaps the expected text.
// Only the detector is measured — not what the guard learns from the record page.
// Usage: node e2e/accuracy.mjs [--headless]
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { DIST, extensionOf, FIREFOX, openExtensionPage, root } from "../lib/firefox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const messages = JSON.parse(readFileSync(join(here, "../../pii-guard/e2e/fixtures/messages.json"), "utf8"));
const guard = extensionOf();
const browser = await puppeteer.launch({
  browser: "firefox", executablePath: FIREFOX, headless: process.argv.includes("--headless"),
  userDataDir: mkdtempSync(join(tmpdir(), "agent-guard-acc-")),
  args: ["-remote-allow-system-access"], extraPrefsFirefox: guard.prefs,
});
try {
  await browser.installExtension(DIST);
  const page = await browser.newPage();
  await openExtensionPage(page, `moz-extension://${guard.uuid}/popup.html`);

  const spansOf = (text, found) => found.map((f) => { const start = text.indexOf(f.text); return { type: f.type, text: f.text, start, end: start + f.text.length }; });
  const overlaps = (a, b) => a.type === b.type && a.start < b.end && b.start < a.end;
  const results = [];
  for (const m of messages) {
    const { found, modelError } = await page.evaluate((text) => browser.runtime.sendMessage({ type: "detect", text }), m.text);
    const spans = spansOf(m.text, found);
    const expected = m.pii.map(([type, value]) => { const start = m.text.indexOf(value); return { type, text: value, start, end: start + value.length }; });
    results.push({
      text: m.text, modelError,
      found: expected.map((e) => ({ ...e, hit: spans.some((s) => overlaps(s, e)) })),
      falsePositives: spans.filter((s) => !expected.some((e) => overlaps(s, e))),
    });
  }
  const types = [...new Set(messages.flatMap((m) => m.pii.map(([t]) => t)))];
  const perType = Object.fromEntries(types.map((type) => {
    const tp = results.flatMap((r) => r.found).filter((f) => f.type === type && f.hit).length;
    const fn = results.flatMap((r) => r.found).filter((f) => f.type === type && !f.hit).length;
    const fp = results.flatMap((r) => r.falsePositives).filter((s) => s.type === type).length;
    return [type, { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null }];
  }));
  const pct = (x) => (x === null ? "  -  " : `${Math.round(x * 100)}%`.padStart(5));
  console.log(`\nAgent Guard detector on PII Guard's ${messages.length} messages\n`);
  console.log("type              found  missed  extra  precision  recall");
  for (const [type, r] of Object.entries(perType)) console.log(`${type.padEnd(17)} ${String(r.tp).padStart(5)}  ${String(r.fn).padStart(6)}  ${String(r.fp).padStart(5)}  ${pct(r.precision).padStart(9)}  ${pct(r.recall).padStart(6)}`);
  const all = Object.values(perType).reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn }), { tp: 0, fp: 0, fn: 0 });
  console.log(`${"all".padEnd(17)} ${String(all.tp).padStart(5)}  ${String(all.fn).padStart(6)}  ${String(all.fp).padStart(5)}  ${pct(all.tp / (all.tp + all.fp)).padStart(9)}  ${pct(all.tp / (all.tp + all.fn)).padStart(6)}`);
  const clean = results.filter((r) => !r.found.length);
  console.log(`\nMessages with no personal data: ${clean.length}; flagged anyway: ${clean.filter((r) => r.falsePositives.length).length}`);
  const errors = results.filter((r) => r.modelError).length;
  if (errors) console.log(`Model unavailable on ${errors} messages (shape rules only).`);
  mkdirSync(join(root, "artifacts"), { recursive: true });
  const out = join(root, "artifacts", `agent-guard-accuracy-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ messages: messages.length, perType, results }, null, 2));
  console.log(`\nDetails: ${out}`);
} finally {
  await browser.close();
}
