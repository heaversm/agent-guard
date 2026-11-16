// Finds personal data in text that is about to leave the browser.
// Same approach as PII Guard (apps/pii-guard/src/content/content.ts): shape rules
// for exact formats, then GLiNER for names, addresses, IDs and health terms,
// filtered to spans with a plausible shape.
import type { Labels, Scorer } from "../core/model/scorer";
import { SHAPES, type Kind } from "../core/text/ask";

export type Found = { type: string; text: string; by: "shape" | "model" };

const LABELS: Labels = {
  "person name": "first or last name of a person",
  phone: "phone number",
  "street address": "street or postal address of a home or office",
  "ID number": "passport, social security, licence, tax, patient or account number",
  "date of birth": "the date a person was born",
  "health condition": "illness, diagnosis, medication or medical condition",
};
const SHAPE_TYPE: Partial<Record<Kind, string>> = {
  email: "email", card: "card number", phone: "phone", cvv: "card number", expiry: "card number", zip: "street address", code: "ID number",
};
/** A number counts as an ID only after words like these. Adds MRN and record to PII Guard's list. */
const ID_BEFORE = /\b(?:id|passport|licen[cs]e|ssn|social security|insurance|account|member|patient|policy|tax|mrn|record)\b[^.!?\n]{0,24}$/i;
/** GLiNER2.5 small reads about 512 tokens; the labels take part of them. */
const MAX_MODEL_CHARS = 1_500;

function shapes(text: string): Found[] {
  const found: Found[] = [];
  for (const [kind, shape] of SHAPES) {
    const type = SHAPE_TYPE[kind];
    if (!type) continue;
    for (const m of text.matchAll(shape)) {
      const start = m.index + (m[1] ? m[0].indexOf(m[1]) : 0);
      if (kind === "code" && !ID_BEFORE.test(text.slice(Math.max(0, start - 40), start))) continue;
      found.push({ type, text: m[1] ?? m[0], by: "shape" });
    }
  }
  return found;
}

/** The model marks some span for most labels ("I" as a name). Keep the ones with the right shape. */
function plausible(type: string, span: string, before: string): boolean {
  const digits = span.replace(/\D/g, "").length;
  if (type === "person name") return span.split(/\s+/).every((w) => /^\p{Lu}/u.test(w) && /\p{Ll}/u.test(w));
  if (type === "phone") return digits >= 7;
  if (type === "ID number") return digits >= 4 && ID_BEFORE.test(before);
  if (type === "date of birth") return digits > 0;
  return true;
}

function cut(text: string): string {
  if (text.length <= MAX_MODEL_CHARS) return text;
  const space = text.lastIndexOf(" ", MAX_MODEL_CHARS);
  return text.slice(0, space > 0 ? space : MAX_MODEL_CHARS);
}

/** Shape matches always; model matches when the model answers. Never throws: a model failure is reported, shapes still count. */
export async function findPersonalData(text: string, scorer: Scorer | undefined): Promise<{ found: Found[]; modelError?: string }> {
  const found = shapes(text);
  if (!scorer) return { found, modelError: "model not loaded" };
  const modelText = cut(text);
  try {
    const byType = await scorer.extractEntities(modelText, LABELS);
    for (const [type, list] of Object.entries(byType)) {
      for (const e of list) {
        const start = e.start ?? modelText.indexOf(e.text);
        if (start < 0 || !plausible(type, e.text, modelText.slice(0, start))) continue;
        // "MRN 4471-2290" looks like a phone number to the model; it's an ID.
        // Only spans with digits: "admitted for asthma" after "Patient ID: …" is still a health condition.
        const kind = /\d/.test(e.text) && (/\bmrn\b/i.test(e.text) || ID_BEFORE.test(modelText.slice(Math.max(0, start - 30), start))) ? "ID number" : type;
        if (!found.some((f) => f.text.includes(e.text) || e.text.includes(f.text))) found.push({ type: kind, text: e.text, by: "model" });
      }
    }
    return { found };
  } catch (error) {
    return { found, modelError: error instanceof Error ? error.message : String(error) };
  }
}

/** For the log: the type and a masked value, so the guard's own record holds no personal data. */
export function mask(f: Found): string {
  const masked = f.text.replace(/[\p{L}\p{N}]/gu, (c, i) => (i === 0 ? c : "•"));
  return `${f.type}: ${masked}`;
}
