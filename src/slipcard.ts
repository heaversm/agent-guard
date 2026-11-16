// The permission slip, shown as a card in the top-right of every allowed page: the task,
// each site's level (Block, Restrict, Allow), the rules, and a live count of
// what the guard allowed and blocked. It sits outside <body>, so an agent reading the
// page's text never sees it — the slip shouldn't change how the agent behaves.
//
// The person can edit the slip here: add sites, set each one to Block, Restrict (no
// patient details) or Allow, and pick the rules. Only real clicks and key presses count (event.isTrusted):
// a page script or an agent clicking through the page's structure can't widen its own slip.
import type { Entry, SiteLevel, Slip, SlipChange, SlipEdit } from "./background";

const LEVEL_LABEL: Record<SiteLevel, string> = { block: "Block", restrict: "Restrict", allow: "Allow" };
const RESTRICT_HELP = "Block: the agent can't reach this site. Allow: the agent can visit and send patient details here. Restrict: the agent can visit, but no patient details may be sent here.";
const HELP = {
  details: "Only for sites set to Restrict. Ask me pauses and lets you choose. Remove replaces patient details with tags like [NAME_1] and shows you what will be sent before it goes. Block stops the request.",
  forms: "Whether the agent may submit forms, such as a search or a booking. Submit lets it send forms to sites on this slip, still checked for patient details. Read only lets it look at pages but not send anything.",
};

type Browser = {
  runtime: { sendMessage<T>(m: object): Promise<T> };
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>> };
    onChanged: { addListener(fn: (changes: Record<string, { newValue?: unknown }>) => void): void };
  };
};
const ext = (globalThis as unknown as { browser: Browser }).browser;

const CSS = `
#agent-guard-slip{position:fixed;top:56px;right:16px;z-index:2147483645;width:300px;font:13px/1.45 system-ui;color:#222;
  background:#fff;border-radius:10px;border-top:5px solid #1d3b8b;box-shadow:0 6px 24px rgba(0,0,0,.18);overflow:hidden}
#agent-guard-slip header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px 6px;font-weight:700;font-size:14px;cursor:pointer}
#agent-guard-slip header span{font-weight:400;color:#888;font-size:12px}
#agent-guard-slip .body{padding:0 12px 10px;max-height:680px;opacity:1;transition:max-height .45s ease,opacity .35s ease,padding .45s ease}
#agent-guard-slip.collapsed .body{max-height:0;opacity:0;padding-bottom:0}
#agent-guard-slip.pulse-blocked{animation:ag-pulse-red 1.2s ease 2}
#agent-guard-slip.pulse-allowed{animation:ag-pulse-green 1.2s ease 1}
@keyframes ag-pulse-red{0%,100%{box-shadow:0 6px 24px rgba(0,0,0,.18)}50%{box-shadow:0 0 0 6px rgba(197,0,66,.45),0 6px 24px rgba(0,0,0,.18)}}
@keyframes ag-pulse-green{0%,100%{box-shadow:0 6px 24px rgba(0,0,0,.18)}50%{box-shadow:0 0 0 6px rgba(42,138,58,.4),0 6px 24px rgba(0,0,0,.18)}}
#agent-guard-slip h4{margin:8px 0 3px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#666}
#agent-guard-slip ul{list-style:none;margin:0;padding:0}
#agent-guard-slip li{padding:2px 0}
#agent-guard-slip .yes::before{content:"✓ ";color:#2a8a3a;font-weight:700}
#agent-guard-slip .no::before{content:"✗ ";color:#c50042;font-weight:700}
#agent-guard-slip li.site,#agent-guard-slip li.setting{flex-wrap:wrap;align-items:center;padding:4px 0}
#agent-guard-slip li.blocked .text{color:#999;text-decoration:line-through}
#agent-guard-slip li.site .text{flex-basis:100%} /* name on one line, its switch under it, the same for every site */
#agent-guard-slip .help{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid #bbb;color:#777;font-size:11px;cursor:help}
#agent-guard-slip .seg{display:inline-flex;border:1px solid #ccc;border-radius:6px;overflow:hidden}
#agent-guard-slip .seg button{border:0;border-radius:0;border-right:1px solid #ccc;padding:2px 8px}
#agent-guard-slip .seg button:last-child{border-right:0}
#agent-guard-slip .seg button.on{background:#1d3b8b;color:#fff}
#agent-guard-slip .seg button:disabled{color:#bbb;cursor:default}
#agent-guard-slip .muted{color:#777}
#agent-guard-slip .stats{margin-top:8px;padding-top:8px;border-top:1px solid #eee}
#agent-guard-slip .last{margin-top:4px;padding:6px 8px;border-radius:6px;background:#f3f6ff;word-break:break-all}
#agent-guard-slip .last.blocked{background:#fdecef;color:#9b0036}
#agent-guard-slip li{display:flex;gap:6px;align-items:baseline}
#agent-guard-slip li .text{flex:1}
#agent-guard-slip button{font:12px system-ui;border:1px solid #ccc;background:#fff;border-radius:5px;padding:1px 6px;cursor:pointer;color:#333}
#agent-guard-slip button:hover{border-color:#1d3b8b;color:#1d3b8b}
#agent-guard-slip form{display:flex;gap:6px;margin-top:4px}
#agent-guard-slip input{flex:1;font:12px system-ui;padding:3px 6px;border:1px solid #ccc;border-radius:5px;min-width:0}
#agent-guard-slip .edited{margin-top:6px;font-size:12px;color:#777;display:flex;justify-content:space-between;align-items:center}
`;

/** How long the card stays open when it opens by itself. */
const PEEK_MS = 5000;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const host = (origin: string) => origin.replace(/^https?:\/\//, "");
/** Edits since the last reset; the full history stays in storage. History is newest first. */
const sinceReset = (edits: SlipEdit[] | undefined = []) => {
  const reset = edits.findIndex((e) => e.change.startsWith("reset"));
  return reset < 0 ? edits.length : reset;
};

export async function showSlipCard(slip: Slip & { labels?: Record<string, string> }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  const card = document.createElement("aside");
  card.id = "agent-guard-slip";
  card.innerHTML = `
    <header>🛡 Permission slip <span>Agent Guard</span></header>
    <div class="body">
      <div id="ag-slip"></div>
      <div class="stats"><b id="ag-allowed">0</b> allowed · <b id="ag-blocked">0</b> blocked this session
        <div class="last" id="ag-last" hidden></div></div>
    </div>`;
  const showSlip = (slip: Slip & { labels?: Record<string, string> }, edits: number) => {
    // The site's name only; its address shows on hover.
    const name = (origin: string) => `<span title="${esc(host(origin))}">${esc(slip.labels?.[origin] ?? host(origin))}</span>`;
    // One switch per site: Block | Restrict | Allow. Blocked sites stay listed, greyed, so undo is one click.
    const blocked = slip.blockedOrigins ?? [];
    const lastAllow = slip.insideOrigins.length === 1;
    const sites = [...slip.allowedOrigins, ...blocked]
      .map((o) => {
        const level: SiteLevel = blocked.includes(o) ? "block" : slip.insideOrigins.includes(o) ? "allow" : "restrict";
        // The last Allow site stays Allow: it's what the task is about, and where the guard learns the patient's details.
        const locked = level === "allow" && lastAllow;
        const buttons = (["block", "allow", "restrict"] as const)
          .map((l) => `<button data-do="site" data-origin="${esc(o)}" data-level="${l}" class="${l === level ? "on" : ""}"${l === "restrict" ? ` title="${RESTRICT_HELP}"` : ""}${locked && l !== "allow" ? " disabled" : ""}>${LEVEL_LABEL[l]}</button>`)
          .join("");
        return `<li class="site${level === "block" ? " blocked" : ""}"><span class="text">${name(o)}</span><span class="seg">${buttons}</span><span class="help" title="${RESTRICT_HELP}">?</span></li>`;
      })
      .join("");
    /** A setting shown as its choices side by side, the current one highlighted. */
    const choice = (label: string, help: string, what: string, options: [string, string][], value: string) =>
      `<li class="setting"><span class="text">${label} <span class="help" title="${help}">?</span></span><span class="seg">${options
        .map(([v, text]) => `<button data-do="${what}" data-value="${v}" class="${v === value ? "on" : ""}">${text}</button>`)
        .join("")}</span></li>`;
    card.querySelector("#ag-slip")!.innerHTML = `
      <h4>Sites</h4>
      <ul>${sites}</ul>
      <form id="ag-add"><input name="site" placeholder="Add a site, e.g. medlineplus.gov" aria-label="Add a site"><button type="submit">Add</button></form>
      <h4>Rules</h4>
      <ul>
        ${choice("Patient details", HELP.details, "on-personal-data", [["ask", "Ask me"], ["remove", "Remove"], ["block", "Block"]], slip.onPersonalData ?? "block")}
        ${choice("Forms", HELP.forms, "forms", [["submit", "Submit"], ["read-only", "Read only"]], slip.readOnly ? "read-only" : "submit")}
      </ul>
      ${edits ? `<div class="edited">Edited by you · ${edits} change${edits === 1 ? "" : "s"}<button data-do="reset">Reset</button></div>` : ""}`;
    current = slip;
  };
  let current: Slip = slip;
  const send = (change: SlipChange) => void ext.runtime.sendMessage({ type: "slip-edit", change });
  card.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-do]");
    if (!button) return;
    pinned = true; // editing holds the card open
    clearTimeout(timer);
    if (!event.isTrusted) return; // a script's click, not a person's
    const what = button.dataset.do!;
    const origin = button.dataset.origin ?? "";
    const value = button.dataset.value;
    if (button.classList.contains("on")) return; // already the current choice
    if (what === "site") send({ kind: "site", origin, level: button.dataset.level as SiteLevel });
    else if (what === "forms") send({ kind: "rule", rule: "readOnly", value: value === "read-only" });
    else if (what === "on-personal-data") send({ kind: "on-personal-data", value: value === "ask" || value === "remove" ? value : "block" });
    else if (what === "reset") send({ kind: "reset" });
  });
  card.addEventListener("submit", (event) => {
    event.preventDefault();
    pinned = true;
    clearTimeout(timer);
    if (!event.isTrusted) return;
    const input = (event.target as HTMLFormElement).elements.namedItem("site") as HTMLInputElement;
    if (input.value.trim()) send({ kind: "add-site", origin: input.value });
    input.value = "";
  });
  // Folded to its header by default. It opens for a few seconds when the page loads and on each
  // decision, then folds again — but never while the pointer is over it. Clicking the header
  // pins it: a peeking card stays open, a pinned one toggles. Pinning stops the automatic opening.
  card.classList.add("collapsed");
  let pinned = false;
  let hovering = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const foldLater = () => {
    clearTimeout(timer);
    if (!pinned && !hovering) timer = setTimeout(() => card.classList.add("collapsed"), PEEK_MS);
  };
  card.addEventListener("mouseenter", () => {
    hovering = true;
    clearTimeout(timer);
  });
  card.addEventListener("mouseleave", () => {
    hovering = false;
    foldLater();
  });
  card.querySelector("header")!.addEventListener("click", () => {
    clearTimeout(timer);
    const open = !card.classList.contains("collapsed");
    if (!pinned && open) return void (pinned = true); // first click on a peeking card keeps it open
    pinned = true;
    card.classList.toggle("collapsed");
  });
  const peek = (pulse?: "blocked" | "allowed") => {
    if (pinned) return;
    card.classList.remove("collapsed", "pulse-blocked", "pulse-allowed");
    if (pulse) {
      void card.offsetWidth; // restart the animation
      card.classList.add(`pulse-${pulse}`);
    }
    foldLater();
  };
  // Outside <body>: on screen for people, not in the text an agent reads.
  document.documentElement.append(style, card);

  const render = (log: Entry[]) => {
    const blocked = log.filter((e) => e.decision === "blocked");
    card.querySelector("#ag-allowed")!.textContent = String(log.length - blocked.length);
    card.querySelector("#ag-blocked")!.textContent = String(blocked.length);
    const last = log[0];
    const box = card.querySelector<HTMLElement>("#ag-last")!;
    if (!last) return void (box.hidden = true);
    box.hidden = false;
    box.className = `last ${last.decision}`;
    box.textContent = `Last: ${last.decision === "blocked" ? "✗ blocked" : "✓ allowed"} ${last.method} ${host(new URL(last.url).origin)}${new URL(last.url).pathname} — ${last.reason}`;
  };
  const stored = await ext.storage.local.get("log");
  const { slipEdits } = await ext.storage.local.get("slipEdits");
  showSlip(slip, sinceReset(slipEdits as SlipEdit[] | undefined));
  render((stored.log as Entry[] | undefined) ?? []);
  setTimeout(() => peek(), 300); // after first paint, so the opening is seen
  ext.storage.onChanged.addListener((changes) => {
    if (changes.slip?.newValue) showSlip(changes.slip.newValue as Slip, sinceReset(changes.slipEdits?.newValue as SlipEdit[] | undefined));
    if (!changes.log) return;
    const log = (changes.log.newValue as Entry[] | undefined) ?? [];
    render(log);
    if (log[0]) peek(log[0].decision);
  });
}
