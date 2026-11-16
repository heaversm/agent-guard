// Checks each form on an inside page before it is sent. Firefox gives webRequest
// no body for a form post that navigates, so this is where the guard reads what
// a form carries out. The background page judges it; a clean form is sent on,
// a form carrying personal data out of the inside origins is stopped, with a
// banner saying why. Works the same whether an agent or a person submits.
import type { FormCheck, FormDecision, FormVerdict, Slip } from "./background";
import { showSlipCard } from "./slipcard";

type Browser = {
  runtime: { sendMessage<T>(m: object): Promise<T> };
  storage: { onChanged: { addListener(fn: (changes: Record<string, { newValue?: unknown }>) => void): void } };
};
const ext = (globalThis as unknown as { browser: Browser }).browser;

/** Forms this script already passed; their resubmission must not be checked again. */
const passed = new WeakSet<HTMLFormElement>();

function banner(text: string) {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;background:#c50042;color:#fff;font:14px system-ui;padding:12px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3)";
  document.documentElement.append(el);
  setTimeout(() => el.remove(), 20000);
}

/** How long the guard waits for the person before blocking. */
const ASK_MS = 60_000;
/** Tags that replace removed values, as PII Guard uses: one value keeps one number. */
const TAGS: Record<string, string> = {
  "person name": "NAME", email: "EMAIL", phone: "PHONE", "card number": "CARD", "street address": "ADDRESS",
  "ID number": "ID", "date of birth": "DOB", "health condition": "HEALTH",
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces each found value in every field of the form with a tag like [NAME_1], ignoring case. */
function strip(form: HTMLFormElement, values: { type: string; text: string }[]) {
  const counts: Record<string, number> = {};
  const tags = values
    .sort((a, b) => b.text.length - a.text.length) // longest first, so a full name goes before its parts
    .map((v) => {
      const tag = TAGS[v.type] ?? "REMOVED";
      counts[tag] = (counts[tag] ?? 0) + 1;
      return { re: new RegExp(escapeRe(v.text), "gi"), tag: `[${tag}_${counts[tag]}]` };
    });
  for (const el of [...form.elements] as HTMLInputElement[]) {
    if (typeof el.value !== "string" || !el.value) continue;
    let value = el.value;
    for (const { re, tag } of tags) value = value.replace(re, tag);
    el.value = value;
  }
}

const escHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** The form's own text, as it would be sent. */
const formText = (form: HTMLFormElement) =>
  ([...form.elements] as HTMLInputElement[]).map((el) => el.value).filter((v) => typeof v === "string" && v !== "").join(" · ");

/**
 * Holds the form and asks the person: remove the details, send anyway, or block.
 * Removing is two steps: the details are replaced with tags in the form, the person sees
 * exactly what would go out, then sends or cancels (which puts the original text back).
 */
function ask(form: HTMLFormElement, verdict: FormVerdict) {
  mark("awaiting decision");
  const box = document.createElement("div");
  box.id = "agent-guard-prompt";
  box.style.cssText = "position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:2147483647;width:min(560px,92vw);background:#fff;color:#222;font:14px/1.45 system-ui;border-radius:10px;border-top:5px solid #c50042;box-shadow:0 10px 32px rgba(0,0,0,.28);padding:14px 16px";
  const title = document.createElement("div");
  title.style.cssText = "font-weight:700;font-size:15px;margin-bottom:4px";
  title.textContent = "🛡 Agent Guard: this would send patient details to another site";
  const detail = document.createElement("div");
  detail.style.cssText = "color:#555;margin-bottom:10px";
  const to = new URL(form.action).host;
  detail.textContent = `To ${to} — ${verdict.found.join(", ")}`;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
  box.append(title, detail, row);

  let done = false;
  let timer: ReturnType<typeof setTimeout>;
  const finish = async (choice: FormDecision["choice"], opts: { sent?: string; note?: string } = {}) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    box.remove();
    await ext.runtime.sendMessage({ type: "form-decision", id: verdict.ask!, choice, sent: opts.sent } satisfies FormDecision);
    mark(`decided: ${choice}`);
    if (choice === "send") {
      passed.add(form);
      HTMLFormElement.prototype.submit.call(form);
    } else if (choice === "strip") {
      form.requestSubmit(); // back through the check, now without the details
    } else {
      banner(opts.note ?? `Agent Guard blocked this form: ${choice === "timeout" ? "nobody answered" : "the person chose to block it"} (${verdict.found.join(", ")}).`);
    }
  };
  const PRIMARY = "background:#1d3b8b;color:#fff;border-color:#1d3b8b";
  const button = (id: string, label: string, style: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.id = id;
    b.type = "button";
    b.textContent = label;
    b.style.cssText = `font:600 14px system-ui;padding:8px 12px;border-radius:6px;border:1px solid #ccc;cursor:pointer;${style}`;
    b.addEventListener("click", onClick);
    row.append(b);
  };

  /** Step two of removing: show what would go out, with each replacement marked. */
  const review = () => {
    clearTimeout(timer);
    const fields = [...form.elements] as HTMLInputElement[];
    const original = fields.map((el) => el.value);
    const restore = () => fields.forEach((el, k) => (el.value = original[k] ?? ""));
    strip(form, verdict.values ?? []);
    const sent = formText(form);
    mark("reviewing removal");
    title.textContent = "🛡 Patient details removed. Send this?";
    detail.innerHTML = `To ${escHtml(to)}:<div id="ag-preview" style="margin-top:6px;padding:8px 10px;border-radius:6px;background:#f3f6ff;color:#222;font:13px/1.5 ui-monospace,monospace;word-break:break-word">${escHtml(sent).replace(/\[[A-Z]+_\d+\]/g, (t) => `<mark style="background:#ffe08a;padding:0 2px;border-radius:3px">${t}</mark>`)}</div>`;
    row.replaceChildren();
    button("ag-strip-send", "Send", PRIMARY, () => void finish("strip", { sent }));
    button("ag-strip-cancel", "Cancel", "background:#fff", () => {
      restore();
      void finish("block", { note: "Not sent. The original text is back in the form." });
    });
    timer = setTimeout(() => {
      restore();
      void finish("timeout");
    }, ASK_MS);
  };

  // Outside <body>, like the slip card: the person sees it, the agent reading the page doesn't.
  document.documentElement.append(box);
  // The slip says Remove: no choice, straight to the review, so the person sees the replacements before anything is sent.
  if (verdict.mode === "remove") return review();
  button("ag-strip", "Remove patient details", PRIMARY, review);
  button("ag-send", "Send anyway", "background:#fff", () => void finish("send"));
  button("ag-block", "Block", "background:#fff;color:#c50042;border-color:#c50042", () => void finish("block"));
  timer = setTimeout(() => void finish("timeout"), ASK_MS);
}

/** Each step, on <html data-agent-guard>, for the e2e test and for debugging. */
const mark = (state: string) => (document.documentElement.dataset.agentGuard = state);

async function main() {
  mark("starting");
  let slip = await ext.runtime.sendMessage<Slip>({ type: "slip" });
  // The person can edit the slip from the card; checks below use the current one.
  ext.storage.onChanged.addListener((changes) => {
    if (changes.slip?.newValue) slip = changes.slip.newValue as Slip;
  });
  // The slip card goes on every allowed page, inside or out.
  if (slip.allowedOrigins.includes(location.origin)) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void showSlipCard(slip), { once: true });
    else void showSlipCard(slip);
  }
  if (!slip.insideOrigins.includes(location.origin)) return mark("not an inside page");
  mark("watching forms");
  // Tell the guard what this inside page shows, so it can recognize those details if they try to leave.
  const share = () => void ext.runtime.sendMessage({ type: "inside-page", text: document.body?.innerText ?? "" });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", share, { once: true });
  else share();

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      mark(`saw submit: ${String((form as Element)?.tagName)} ${form instanceof HTMLFormElement}`);
      if (!(form instanceof HTMLFormElement) || passed.has(form)) return;
      const action = new URL(form.action || location.href, location.href).href;
      if (slip.insideOrigins.includes(new URL(action).origin)) return;

      // Hold the form while the guard decides.
      event.preventDefault();
      event.stopImmediatePropagation();
      let values: string[];
      try {
        const submitter = (event as SubmitEvent).submitter;
        values = [...new FormData(form, submitter ?? undefined).values()].filter((v): v is string => typeof v === "string");
      } catch (error) {
        mark(`formdata error: ${String(error)}`);
        values = [...form.elements].map((el) => (el as HTMLInputElement).value).filter((v) => typeof v === "string" && v !== "");
      }
      const check: FormCheck = { type: "check-form", action, method: (form.method || "get").toUpperCase(), text: values.join("\n"), page: location.href, pageText: document.body?.innerText ?? "" };

      mark("checking form");
      void ext.runtime.sendMessage<FormVerdict>(check).then(
        (verdict) => {
          mark(`verdict: ${verdict ? (verdict.blocked ? "blocked" : "clean") : "no answer"}`);
          if (verdict.blocked && verdict.ask) return void ask(form, verdict);
          if (verdict.blocked) {
            banner(`Agent Guard blocked this form: ${verdict.reason}${verdict.found.length ? ` (${verdict.found.join(", ")})` : ""}.`);
            return;
          }
          passed.add(form);
          // submit() sends without firing another submit event.
          HTMLFormElement.prototype.submit.call(form);
        },
        (error) => {
          mark(`error: ${String(error)}`);
          banner(`Agent Guard could not check this form, so it was not sent: ${String(error)}`);
        },
      );
    },
    true,
  );
}

void main().catch((error) => mark(`failed: ${String(error)}`));
