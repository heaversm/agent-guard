// Agent Guard: the browser, not the agent, enforces the permission slip and
// writes the record. Any agent driving this Firefox (foxpilot, Playwright, a
// person) goes through the same checks.
//
// Scope: only task tabs, meaning tabs that have loaded a page on an inside
// origin. Other tabs (your mail, your other browsing) are left alone.
//
// Two checkpoints, because Firefox does not give webRequest the body of a form
// post that navigates the page:
//   - content.ts checks each form on an inside page before it is sent, and asks
//     this page to judge what the form carries. A clean form gets a clearance.
//   - Every request from a task tab is held here (blocking webRequest, async —
//     a Firefox capability) and decided:
//       1. Destination not on the slip -> blocked.
//       2. Slip is read-only and the request writes -> blocked.
//       3. Leaves the inside origins carrying personal data -> blocked.
//       4. A form post leaving the inside origins with no clearance -> blocked,
//          so nothing gets out by skipping the form check.
// Each decision goes into the log, written from what the browser saw.
import { loadModel, type AppModel } from "../core/model/load";
import type { Scorer } from "../core/model/scorer";
import { findPersonalData, mask } from "./detect";

declare const __MODEL__: AppModel;

export type Slip = {
  task: string;
  /** Origins the agent may reach at all. */
  allowedOrigins: string[];
  /** Origins that count as inside ("Allow" on the card): patient details may go there. Anywhere else is checked for personal data. */
  insideOrigins: string[];
  /** Sites the person blocked from the card. Kept so the card can show them greyed out and undo is one click. */
  blockedOrigins?: string[];
  /** Check what leaves for personal data. Always on from the card now; each site's level says where details may go. */
  blockPersonalData: boolean;
  /** Only GET and HEAD to any origin. */
  readOnly: boolean;
  /**
   * Patient details in a form going to a Restrict site: "ask" the person (remove / send anyway / block),
   * "remove" them (replaced with tags, then the person confirms what's sent), or "block" the request.
   */
  onPersonalData?: "block" | "ask" | "remove";
};

export type Entry = {
  t: string;
  decision: "allowed" | "blocked";
  reason: string;
  method: string;
  url: string;
  type: string;
  from?: string;
  found?: string[];
  ms?: number;
};

type Details = {
  url: string;
  method: string;
  type: string;
  originUrl?: string;
  documentUrl?: string;
  tabId: number;
  requestBody?: { formData?: Record<string, string[]>; raw?: { bytes?: ArrayBuffer }[] };
};

/** pageText: what the inside page shows, sent again with each check in case the page was read too early. */
export type FormCheck = { type: "check-form"; action: string; method: string; text: string; page: string; pageText?: string };
export type FormVerdict = {
  blocked: boolean;
  found: string[];
  reason: string;
  /** Set when the slip says to ask or remove: the person decides, and content.ts reports the choice with this id. */
  ask?: string;
  /** "remove": skip the choice and go straight to reviewing the form with the details replaced. */
  mode?: "ask" | "remove";
  /** The values found, unmasked, so content.ts can remove them from the form. Never logged. */
  values?: { type: string; text: string }[];
};
/** sent: for "strip", the form's text after the details were removed — what actually went out, safe to log. */
export type FormDecision = { type: "form-decision"; id: string; choice: "strip" | "send" | "block" | "timeout"; sent?: string };
/** A site's level on the card: Block (not reachable), Restrict (reachable, no patient details), Allow (patient details may go there). */
export type SiteLevel = "block" | "restrict" | "allow";
/** One change a person makes on the slip card. */
export type SlipChange =
  | { kind: "add-site"; origin: string }
  | { kind: "site"; origin: string; level: SiteLevel }
  | { kind: "rule"; rule: "readOnly"; value: boolean }
  | { kind: "on-personal-data"; value: "block" | "ask" | "remove" }
  | { kind: "reset" };
export type SlipEdit = { t: string; change: string };

type Browser = {
  webRequest: {
    onBeforeRequest: {
      addListener(listener: (d: Details) => Promise<{ cancel?: boolean; redirectUrl?: string }>, filter: { urls: string[] }, extra: string[]): void;
    };
  };
  tabs: { onRemoved: { addListener(fn: (tabId: number) => void): void } };
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  runtime: { getURL(path: string): string; onMessage: { addListener(fn: (m: { type?: string }, sender: { tab?: { id?: number }; url?: string }) => unknown): void } };
};
const ext = (globalThis as unknown as { browser: Browser }).browser;

const MAX_LOG = 500;
/** How long a cleared form may take to turn into its request. */
const CLEARANCE_MS = 10_000;
/** Page loads, frames, fetch/XHR, form posts. Images and styles are noise for this record. */
const LOGGED_TYPES = new Set(["main_frame", "sub_frame", "xmlhttprequest", "beacon", "websocket", "ping", "other"]);

// The slip starts as slip.json; edits made on the slip card are kept in storage and win over it.
type FullSlip = Slip & { labels?: Record<string, string> };
const original: Promise<FullSlip> = fetch(ext.runtime.getURL("slip.json")).then((r) => r.json());
let slipReady: Promise<FullSlip> = Promise.all([original, ext.storage.local.get("slip")]).then(([o, r]) => (r.slip as FullSlip | undefined) ?? o);

/** "example.com", "localhost:9000", "medlookup.test:8081" or a full URL -> its origin. Local and .test names default to http. */
function toOrigin(input: string): string | undefined {
  const s = input.trim();
  if (!s) return undefined;
  try {
    const url = new URL(/^https?:\/\//.test(s) ? s : `${/^(localhost|127\.)|^[^/:]+\.test(:|$)/.test(s) ? "http" : "https"}://${s}`);
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Applies one change from the slip card, saves it, and adds it to the slip's history. */
async function editSlip(c: SlipChange): Promise<FullSlip> {
  const slip: FullSlip = structuredClone(await slipReady);
  const name = (o: string) => slip.labels?.[o] ?? o.replace(/^https?:\/\//, "");
  let change: string;
  let next = slip;
  if (c.kind === "reset") {
    next = await original;
    change = "reset to the original slip";
  } else if (c.kind === "add-site") {
    const o = toOrigin(c.origin);
    if (!o || slip.allowedOrigins.includes(o)) return slip;
    slip.blockedOrigins = (slip.blockedOrigins ?? []).filter((b) => b !== o);
    slip.allowedOrigins.push(o);
    change = `added ${name(o)}, restricted`;
  } else if (c.kind === "site") {
    const blocked = slip.blockedOrigins ?? [];
    if (!slip.allowedOrigins.includes(c.origin) && !blocked.includes(c.origin)) return slip;
    // Keep at least one Allow site: those are the sites the task is about, and the ones the guard learns patient details from.
    if (slip.insideOrigins.includes(c.origin) && c.level !== "allow" && slip.insideOrigins.length === 1) return slip;
    slip.insideOrigins = slip.insideOrigins.filter((o) => o !== c.origin);
    if (c.level === "block") {
      slip.allowedOrigins = slip.allowedOrigins.filter((o) => o !== c.origin);
      if (!blocked.includes(c.origin)) slip.blockedOrigins = [...blocked, c.origin];
    } else {
      // Unblocking moves the site back to the end of the list; switching Restrict and Allow keeps its place.
      if (!slip.allowedOrigins.includes(c.origin)) slip.allowedOrigins.push(c.origin);
      slip.blockedOrigins = blocked.filter((o) => o !== c.origin);
      if (c.level === "allow") slip.insideOrigins.push(c.origin);
    }
    change = `${name(c.origin)}: ${c.level === "block" ? "blocked" : c.level === "restrict" ? "restricted, no patient details" : "allowed, patient details too"}`;
  } else if (c.kind === "rule") {
    slip[c.rule] = c.value;
    change = c.value ? "made read only" : "allowed submitting forms";
  } else {
    slip.onPersonalData = c.value;
    change = c.value === "ask" ? "ask before patient details leave" : c.value === "remove" ? "remove patient details, then confirm what's sent" : "block requests carrying patient details";
  }
  slipReady = Promise.resolve(next);
  const { slipEdits = [] } = (await ext.storage.local.get("slipEdits")) as { slipEdits?: SlipEdit[] };
  await ext.storage.local.set({ slip: next, slipEdits: [{ t: new Date().toISOString(), change }, ...slipEdits].slice(0, MAX_LOG) });
  return next;
}

// The model loads once; a failed load retries on the next call. Calls run one at a time.
let scorerLoad: Promise<Scorer> | undefined;
const scorer = () =>
  (scorerLoad ??= loadModel(__MODEL__).catch((error: unknown) => {
    scorerLoad = undefined;
    throw error;
  }));
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}
void scorer().catch((e) => console.warn("[agent-guard] model failed to load; shape rules only", e));

let log: Entry[] = [];
const logReady = ext.storage.local.get("log").then((r) => (log = (r.log as Entry[] | undefined) ?? []));
let enabled = true;
void ext.storage.local.get("enabled").then((r) => (enabled = r.enabled !== false));

async function record(entry: Entry) {
  await logReady;
  log = [entry, ...log].slice(0, MAX_LOG);
  await ext.storage.local.set({ log });
}

const taskTabs = new Set<number>();
ext.tabs.onRemoved.addListener((tabId) => taskTabs.delete(tabId));
/** Form actions content.ts has checked and passed, with when the clearance runs out. */
const cleared = new Map<string, number>();

const originOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
};

/** Everything a request carries out: query values, form fields, raw body. */
function outgoingText(d: Details): string {
  const parts: string[] = [];
  for (const [, v] of new URL(d.url).searchParams) parts.push(v);
  const body = d.requestBody;
  if (body?.formData) for (const values of Object.values(body.formData)) parts.push(...values);
  if (body?.raw) {
    const decoder = new TextDecoder();
    for (const piece of body.raw) if (piece.bytes) parts.push(decoder.decode(piece.bytes));
  }
  return parts.filter((p) => p.trim()).join("\n");
}

// Identifying details seen on inside pages: the guard learns them from what the
// agent was shown, then refuses to let them leave, however they're written.
// Medical terms are not identifying, so they are not on this list.
const IDENTIFYING = new Set(["person name", "date of birth", "ID number", "phone", "email", "street address", "card number"]);
const seen = new Map<string, string>(); // lowercased value -> type
/** Name parts count on their own ("whitfield"), so a partial name is caught too. */
function remember(type: string, value: string) {
  const v = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (v.length < 3) return;
  seen.set(v, type);
  if (type === "person name") for (const part of v.split(" ")) if (part.length >= 3) seen.set(part, type);
  // Digits only, so "4471-2290" is caught as "44712290" and with other separators.
  const digits = v.replace(/\D/g, "");
  if (digits.length >= 6) seen.set(digits, type);
}
/** Pages still being read. A check waits for them, so a fast agent can't beat the learning. */
let learning: Promise<unknown> = Promise.resolve();
function learn(text: string) {
  learning = Promise.all([learning, readPage(text)]);
  return learning;
}
/** Pages read with the model loaded. A page read without it (too early, or the model failed) is read again at the next check. */
const readWithModel = new Set<string>();
async function readPage(text: string) {
  const model = await scorer().catch(() => undefined);
  for (let i = 0; i < text.length; i += 1_400) {
    const { found } = await serial(() => findPersonalData(text.slice(i, i + 1_500), model));
    for (const f of found) if (IDENTIFYING.has(f.type)) remember(f.type, f.text);
  }
  if (model) readWithModel.add(text);
}
function fromInside(text: string): { type: string; text: string }[] {
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  const digits = lower.replace(/\D/g, "");
  const hits: { type: string; text: string }[] = [];
  for (const [value, type] of seen) {
    const hit = /^\d+$/.test(value) ? digits.includes(value) : new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower);
    if (hit && !hits.some((h) => h.text.includes(value) || value.includes(h.text))) hits.push({ type, text: value });
  }
  return hits;
}

async function judge(text: string): Promise<{ found: string[]; values: { type: string; text: string }[]; note?: string }> {
  await learning.catch(() => undefined);
  const model = await scorer().catch(() => undefined);
  const { found, modelError } = await serial(() => findPersonalData(text, model));
  // One line per detail: a formatted hit beats its digits-only twin, and the record beats the model.
  const inside = fromInside(text);
  const kept = inside.filter((h) => !/^\d+$/.test(h.text) || !inside.some((o) => o !== h && o.type === h.type && !/^\d+$/.test(o.text)));
  const knownTypes = new Set(kept.map((h) => h.type));
  const fromModel = found.filter((f) => !knownTypes.has(f.type));
  const marked = [
    ...kept.map((h) => `from the record: ${mask({ ...h, by: "shape" })}`),
    ...fromModel.map(mask),
  ];
  const values = [...kept.map((h) => ({ type: h.type, text: h.text })), ...fromModel.map((f) => ({ type: f.type, text: f.text }))];
  return { found: marked, values, note: modelError ? `shape rules only: ${modelError}` : undefined };
}

async function decide(d: Details): Promise<{ cancel?: boolean; redirectUrl?: string }> {
  if (!/^https?:/.test(d.url) || !enabled || d.tabId < 0) return {};
  const slip = await slipReady;
  const to = originOf(d.url)!;
  if (d.type === "main_frame" && slip.insideOrigins.includes(to)) taskTabs.add(d.tabId);
  if (!taskTabs.has(d.tabId)) return {};

  const started = performance.now();
  const from = originOf(d.originUrl ?? d.documentUrl);
  const base = { t: new Date().toISOString(), method: d.method, url: d.url, type: d.type, from };
  const ms = () => Math.round(performance.now() - started);

  if (!slip.allowedOrigins.includes(to)) {
    await record({ ...base, decision: "blocked", reason: "destination not on the slip" });
    // A blocked page load shows a block page saying why, instead of silently going nowhere.
    if (d.type === "main_frame") {
      const params = new URLSearchParams({ url: d.url, reason: "this site is not on the permission slip", allowed: slip.allowedOrigins.join(", ") });
      return { redirectUrl: ext.runtime.getURL(`blocked.html?${params}`) };
    }
    return { cancel: true };
  }
  if (slip.readOnly && !["GET", "HEAD"].includes(d.method)) {
    await record({ ...base, decision: "blocked", reason: "slip is read-only" });
    return { cancel: true };
  }
  const leaving = !slip.insideOrigins.includes(to);
  // A form content.ts already checked and logged: let it through without a second entry.
  const until = cleared.get(d.url);
  if (leaving && until && until > Date.now() && (d.type === "main_frame" || d.type === "sub_frame")) {
    cleared.delete(d.url);
    return {};
  }
  const text = leaving ? outgoingText(d) : "";
  if (leaving && text && slip.blockPersonalData) {
    const { found, note } = await judge(text);
    if (found.length) {
      await record({ ...base, decision: "blocked", reason: "patient details going to a site not trusted with patient details", found, ms: ms() });
      return { cancel: true };
    }
    await record({ ...base, decision: "allowed", reason: `to a site not trusted with patient details; no patient details found${note ? ` (${note})` : ""}`, ms: ms() });
    return {};
  }
  // A form post that navigates arrives here without its body. Only a form content.ts already checked may leave.
  const formPost = leaving && d.method === "POST" && (d.type === "main_frame" || d.type === "sub_frame");
  if (formPost && slip.blockPersonalData) {
    await record({ ...base, decision: "blocked", reason: "form sent to a site not trusted with patient details without passing the form check" });
    return { cancel: true };
  }
  if (LOGGED_TYPES.has(d.type) || d.method !== "GET") {
    await record({ ...base, decision: "allowed", reason: leaving ? "to a site not trusted with patient details; nothing sent" : "trusted site", ms: ms() });
  }
  return {};
}

ext.webRequest.onBeforeRequest.addListener(decide, { urls: ["<all_urls>"] }, ["blocking", "requestBody"]);

/** Forms held while the person decides, by id. */
const pending = new Map<string, { base: Omit<Entry, "decision" | "reason">; found: string[]; action: string; ms: number }>();

async function decideForm(d: FormDecision) {
  const held = pending.get(d.id);
  if (!held) return;
  pending.delete(d.id);
  const { base, found, action, ms } = held;
  if (d.choice === "send") {
    // The person overrode the slip for this one form.
    cleared.set(action, Date.now() + CLEARANCE_MS);
    await record({ ...base, decision: "allowed", reason: "personal data sent anyway — the person overrode the slip", found, ms });
  } else if (d.choice === "strip") {
    // The cleaned-up form comes back through checkForm and is logged again there. What went out is already redacted, so it's safe to log.
    const sent = d.sent ? ` — sent: "${d.sent.slice(0, 200)}"` : "";
    await record({ ...base, decision: "blocked", reason: `personal data removed by the person before sending${sent}`, found, ms });
  } else {
    await record({ ...base, decision: "blocked", reason: d.choice === "timeout" ? "personal data leaving — nobody answered, so blocked" : "personal data leaving — the person chose to block", found, ms });
  }
}

async function checkForm(m: FormCheck, tabId: number | undefined): Promise<FormVerdict> {
  const slip = await slipReady;
  const started = performance.now();
  if (tabId !== undefined) taskTabs.add(tabId);
  const base = { t: new Date().toISOString(), method: m.method, url: m.action, type: "form", from: originOf(m.page) };
  const to = originOf(m.action);
  if (!enabled || !to || slip.insideOrigins.includes(to) || !slip.blockPersonalData) return { blocked: false, found: [], reason: "not leaving" };
  if (!slip.allowedOrigins.includes(to)) {
    await record({ ...base, decision: "blocked", reason: "form destination not on the slip" });
    return { blocked: true, found: [], reason: "destination not on the slip" };
  }
  // The page may have been read before the guard was ready (right after install, say). Read it again now.
  if (m.pageText && !readWithModel.has(m.pageText)) await learn(m.pageText);
  const { found, values, note } = await judge(m.text);
  const elapsed = Math.round(performance.now() - started);
  if (found.length && (slip.onPersonalData === "ask" || slip.onPersonalData === "remove")) {
    // Hold it for the person: a choice ("ask") or a review of the form with the details replaced ("remove").
    // The outcome is logged when content.ts reports it.
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pending.set(id, { base, found, action: m.action, ms: elapsed });
    return { blocked: true, ask: id, mode: slip.onPersonalData, found, values, reason: "patient details going to a site not trusted with patient details" };
  }
  if (found.length) {
    await record({ ...base, decision: "blocked", reason: "form carries patient details to a site not trusted with patient details", found, ms: elapsed });
    return { blocked: true, found, reason: "patient details going to a site not trusted with patient details" };
  }
  cleared.set(m.action, Date.now() + CLEARANCE_MS);
  await record({ ...base, decision: "allowed", reason: `form checked; no personal data found${note ? ` (${note})` : ""}`, ms: elapsed });
  return { blocked: false, found: [], reason: "clean" };
}

ext.runtime.onMessage.addListener(async (m, sender) => {
  if (m.type === "slip") return slipReady;
  // Edits come from the slip card, which only sends them for a person's real click.
  if (m.type === "slip-edit") return editSlip((m as unknown as { change: SlipChange }).change);
  if (m.type === "enabled") return enabled;
  if (m.type === "check-form") return checkForm(m as unknown as FormCheck, sender.tab?.id);
  if (m.type === "form-decision") return decideForm(m as unknown as FormDecision);
  if (m.type === "inside-page") return learn(String((m as { text?: string }).text ?? ""));
  // For the accuracy test (e2e/accuracy.mjs): the detector alone, unmasked, without what was learned from pages.
  // The extension's own pages only, never a content script.
  if (m.type === "detect" && sender.url?.startsWith(ext.runtime.getURL(""))) {
    const model = await scorer().catch(() => undefined);
    return serial(() => findPersonalData(String((m as { text?: string }).text ?? ""), model));
  }
  if (m.type === "clear") {
    log = [];
    await ext.storage.local.set({ log });
  }
  if (m.type === "toggle") {
    enabled = !enabled;
    await ext.storage.local.set({ enabled });
    return enabled;
  }
  return undefined;
});
