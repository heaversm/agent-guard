// Shows the guard's own record: every decision, newest first.
import type { Entry } from "./background";

type Browser = {
  storage: {
    local: { get(keys: string[]): Promise<Record<string, unknown>> };
    onChanged: { addListener(fn: () => void): void };
  };
  runtime: { sendMessage(m: { type: string }): Promise<unknown> };
};
const ext = (globalThis as unknown as { browser: Browser }).browser;
const $ = (id: string) => document.getElementById(id)!;

function row(e: Entry): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const found = e.found?.length ? `<div class="found">${e.found.map(esc).join(" · ")}</div>` : "";
  return `<li class="${e.decision}"><div><b>${e.decision}</b> ${esc(e.method)} ${esc(e.url)}</div>
<div class="why">${esc(e.reason)}${e.ms !== undefined ? ` · ${e.ms} ms` : ""} · ${esc(e.t.slice(11, 19))}</div>${found}</li>`;
}

async function render() {
  const { log = [], enabled = true } = (await ext.storage.local.get(["log", "enabled"])) as { log?: Entry[]; enabled?: boolean };
  $("state").textContent = enabled ? "On" : "Off";
  $("toggle").textContent = enabled ? "Turn off" : "Turn on";
  const blocked = log.filter((e) => e.decision === "blocked").length;
  $("count").textContent = `${log.length} decisions · ${blocked} blocked`;
  $("log").innerHTML = log.map(row).join("");
}

async function init() {
  const slip = (await ext.runtime.sendMessage({ type: "slip" })) as { task: string; allowedOrigins: string[]; insideOrigins: string[]; readOnly: boolean };
  $("slip").textContent = `${slip.task} · allowed: ${slip.allowedOrigins.join(", ")} · inside: ${slip.insideOrigins.join(", ")}${slip.readOnly ? " · read-only" : ""}`;
  $("toggle").addEventListener("click", async () => {
    await ext.runtime.sendMessage({ type: "toggle" });
    await render();
  });
  $("clear").addEventListener("click", async () => {
    await ext.runtime.sendMessage({ type: "clear" });
    await render();
  });
  $("export").addEventListener("click", async () => {
    const { log = [] } = await ext.storage.local.get(["log"]);
    const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "agent-guard-log.json" });
    a.click();
  });
  ext.storage.onChanged.addListener(() => void render());
  await render();
}
void init();
