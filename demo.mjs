// Opens the Agent Guard demo in one command: starts the portal (unless it is
// already running), and opens a clean Firefox with the current builds of Agent
// Guard installed, on the portal page. Close the window to stop.
// Usage: npm run demo
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { DIST, FIREFOX } from "./lib/firefox.mjs";
import { PORTAL, SITE_PREFS } from "./sites.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const listening = (port) => new Promise((resolve) => {
  const socket = createConnection(port, "localhost", () => { socket.end(); resolve(true); }).on("error", () => resolve(false));
});

let portal;
if (await listening(8080)) {
  console.log("Portal already running on :8080 — its terminal shows what reaches the outside site.");
} else {
  portal = spawn(process.execPath, [join(here, "portal/server.mjs")], { stdio: "inherit" });
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await puppeteer.launch({
  browser: "firefox", executablePath: FIREFOX, headless: false, defaultViewport: null,
  userDataDir: mkdtempSync(join(tmpdir(), "agent-guard-demo-")),
  extraPrefsFirefox: SITE_PREFS, // resolves the test site names to this machine
});
await browser.installExtension(DIST);
const [page] = await browser.pages();
await page.goto(`${PORTAL}/`);
console.log("Demo window open. Agent Guard is under the puzzle-piece button. Close the window to stop.");

browser.on("disconnected", () => { portal?.kill(); process.exit(0); });
process.on("SIGINT", async () => { await browser.close().catch(() => {}); portal?.kill(); process.exit(0); });
