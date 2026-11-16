// Helpers the demo, agent and test scripts share for driving the built
// extension (dist/) in a real Firefox. Env: FIREFOX (binary path).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST = join(root, "dist");
export const FIREFOX = process.env.FIREFOX ?? "/Applications/Firefox.app/Contents/MacOS/firefox";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// BiDi does not report navigation events for moz-extension: pages, so goto()
// never resolves there and waitForFunction() dies when the page reloads.
// Poll with plain evaluate() calls instead, retrying across reloads.
async function poll(page, fn, arg, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await page.evaluate(fn, arg).catch(() => false);
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${fn.toString().slice(0, 80)}`);
    await sleep(250);
  }
}
export async function openExtensionPage(page, target) {
  page.goto(target, { timeout: 0 }).catch(() => {});
  await poll(page, (u) => location.href === u && document.readyState === "complete", target, 30_000);
}

// The gecko id comes from the manifest. The UUID is fixed per gecko id
// (pass `prefs` to puppeteer.launch), so extension page URLs are known before it loads.
export function extensionOf() {
  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  const id = manifest.browser_specific_settings.gecko.id;
  const hex = createHash("sha256").update(id).digest("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { id, uuid, manifest, prefs: { "extensions.webextensions.uuids": JSON.stringify({ [id]: uuid }) } };
}
