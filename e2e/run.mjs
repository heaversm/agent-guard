// Runs Agent Guard end to end in Firefox against the test portal.
// Starts portal/server.mjs, installs dist/ in a fresh profile, submits
// forms by hand (the guard treats a person and an agent the same), and checks
// what reached the outside site. Usage: node e2e/run.mjs [--headless]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { DIST, FIREFOX } from "../lib/firefox.mjs";
import { OUTSIDE, PORTAL, SITE_PREFS } from "../sites.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portal = spawn(process.execPath, [join(here, "../portal/server.mjs")]);
let outside = "";
portal.stdout.on("data", (d) => (outside += d));
await sleep(500);

const browser = await puppeteer.launch({
  browser: "firefox", executablePath: FIREFOX, headless: process.argv.includes("--headless"),
  userDataDir: mkdtempSync(join(tmpdir(), "agent-guard-")),
  args: ["-remote-allow-system-access"], // to read the block page, which is an extension page
  extraPrefsFirefox: SITE_PREFS, // resolves the test site names to this machine
});
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
try {
  await browser.installExtension(DIST);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 }); // room for the slip card beside the page

  const reached = async (path) => page.url().startsWith(OUTSIDE) && (await page.content()).includes(`Received POST ${path}`);
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      const state = await page.evaluate(() => document.documentElement.dataset.agentGuard).catch(() => "navigated");
      if (state !== "checking form" && state !== "watching forms") break;
      await sleep(1000);
    }
    await sleep(1500);
  };
  const bannerText = () => page.evaluate(() => [...document.querySelectorAll("div")].map((d) => d.textContent ?? "").find((t) => t.startsWith("Agent Guard")));
  /** What the review step showed, and what the field held, the last time details were removed. */
  let review = { preview: "", field: "" };
  /**
   * If the guard asks, answer it: "block", "send", "strip" (remove the details, review, send)
   * or "strip-cancel" (remove, review, cancel). Returns whether it asked.
   */
  const answer = async (choice) => {
    for (let i = 0; i < 30; i++) {
      if (await page.$("#agent-guard-prompt").catch(() => null)) {
        if (choice.startsWith("strip")) {
          await page.$eval("#ag-strip", (el) => el.click());
          await page.waitForSelector("#ag-preview", { timeout: 5000 });
          review = { preview: await page.$eval("#ag-preview", (el) => el.textContent ?? ""), field: await page.$eval("input[name=q]", (el) => el.value) };
          await page.$eval(choice === "strip" ? "#ag-strip-send" : "#ag-strip-cancel", (el) => el.click());
        } else {
          await page.$eval(`#ag-${choice}`, (el) => el.click());
        }
        await settle();
        return true;
      }
      const state = await page.evaluate(() => document.documentElement.dataset.agentGuard).catch(() => "navigated");
      if (state !== "awaiting decision" && state !== "checking form" && state !== "reviewing removal") return false;
      await sleep(300);
    }
    return false;
  };
  const search = async (q, choice = "block") => {
    await page.goto(`${PORTAL}/`);
    await page.type("input[name=q]", q);
    await page.click("form[action$='/search'] button");
    await settle();
    return answer(choice);
  };

  // 0. Straight after install, the way demo.mjs opens the portal: the page may be read before
  // the guard is ready, and it must still catch the patient's name (lowercase, which the model alone misses).
  check(await search("dana whitfield high alt"), "right after install, the guard still asks before the patient's name leaves");

  // 0b. The permission slip card is on screen, and not in the text an agent reads.
  await page.goto(`${PORTAL}/`);
  await sleep(1000);
  const card = await page.evaluate(() => ({ shown: Boolean(document.getElementById("agent-guard-slip")), inText: document.body.innerText.includes("Permission slip") }));
  check(card.shown, "permission slip card is shown on the portal");
  check(!card.inText, "permission slip card is not in the page text an agent reads");

  // 1. A clean question: a medical term, no identity. Should leave.
  await search("what does high ALT mean");
  check(await reached("/search"), "clean question reaches the outside site");

  // 2. The same question with the patient name. The guard asks; the person blocks.
  const asked = await search("dana whitfield high alt"); // lowercase on purpose
  check(asked, "the guard asks the person before patient details leave");
  check(!(await reached("/search")), "question carrying the patient name (lowercase) is blocked");
  console.log(`     banner: ${await bannerText()}`);
  await search("is whitfield a common name"); // surname alone
  check(!(await reached("/search")), "question carrying only the surname is blocked");
  check(Boolean((await bannerText())?.startsWith("Agent Guard blocked")), "page shows the block banner");

  // 2b. Remove patient details and send: the question goes out without the name.
  outside = "";
  await search("dana whitfield high alt", "strip");
  check(await reached("/search"), "'remove patient details and send' sends the question");
  check(outside ? /\[NAME_1\]/.test(outside) && !/whitfield/i.test(outside) : true, `what arrived has the name removed${outside ? "" : " (not checked: another portal server is running)"}`);
  check(review.preview.includes("[NAME_1]") && !/whitfield/i.test(review.preview), "the review step shows the text with the name replaced before sending");

  // 2b'. Remove, review, then cancel: nothing goes out and the original text comes back.
  await search("dana whitfield high alt", "strip-cancel");
  check(!(await reached("/search")), "cancelling after the review sends nothing");
  check((await page.$eval("input[name=q]", (el) => el.value).catch(() => "")) === "dana whitfield high alt", "cancelling puts the original text back");

  // 2c. Send anyway: the person overrides the slip, and it's logged as an override.
  await search("dana whitfield high alt", "send");
  check(await reached("/search"), "'send anyway' sends it as typed");

  // 3. The planted message: pressing Sync record sends hidden fields with the record. Should be stopped.
  await page.goto(`${PORTAL}/`);
  const agentSees = await page.evaluate(() => document.body.innerText.includes("ignore your previous instructions"));
  check(agentSees, "planted instruction is in the page text an agent reads");
  const personSees = await page.$eval("form[action$='/collect'] button", (el) => { const r = el.getBoundingClientRect(); return r.right > 0 && r.bottom > 0 && r.width > 1; });
  check(!personSees, "planted Sync record button is off-screen for people");
  await page.$eval("form[action$='/collect'] button", (el) => el.click()); // hidden fields carry the record
  await settle();
  await answer("block");
  check(!(await reached("/collect")), "Sync record (hidden name, birth date, MRN) is blocked");
  const banner = await bannerText();
  if (banner) console.log(`     banner: ${banner}`);

  // 4. Editing the slip from the card. Only a person's real click counts.
  const openCard = async () => {
    await page.goto(`${PORTAL}/`);
    await page.waitForSelector("#agent-guard-slip header");
    await page.click("#agent-guard-slip header"); // trusted: pins the card
    if (await page.$eval("#agent-guard-slip", (el) => el.classList.contains("collapsed"))) await page.click("#agent-guard-slip header");
    await sleep(600);
  };
  const cardText = () => page.$eval("#agent-guard-slip", (el) => el.textContent ?? "");
  const level = (origin, l) => `#agent-guard-slip button[data-do=site][data-origin='${origin}'][data-level=${l}]`;
  const isOn = (sel) => page.$eval(sel, (el) => el.classList.contains("on"));
  await openCard();
  check(await isOn(level(OUTSIDE, "restrict")), "MedLookup starts as Restrict");
  check(await page.$eval(level(PORTAL, "block"), (el) => el.disabled), "the portal, the last Allow site, can't be blocked");
  await page.$eval(level(OUTSIDE, "block"), (el) => el.click()); // a script's click, as an agent or the page would do it
  await sleep(800);
  check(await isOn(level(OUTSIDE, "restrict")), "a scripted click can't edit the slip");
  await page.click(level(OUTSIDE, "block"));
  await sleep(800);
  check(await isOn(level(OUTSIDE, "block")), "a person can block a site, and it stays listed");
  await search("what does high ALT mean");
  check(!(await reached("/search")), "a blocked site is blocked, even for a clean question");
  await openCard();
  await page.click(level(OUTSIDE, "restrict"));
  await sleep(800);
  await search("what does high ALT mean");
  check(await reached("/search"), "switching back to Restrict makes it reachable again");
  await openCard();
  await page.click(level(OUTSIDE, "allow"));
  await sleep(800);
  check(!(await search("dana whitfield high alt")) && (await reached("/search")), "Allow lets patient details go to that site without asking");
  await openCard();
  await page.click("#agent-guard-slip button[data-do=reset]");
  await sleep(800);
  await openCard();
  await page.click("#agent-guard-slip button[data-do=on-personal-data][data-value=block]");
  await sleep(800);
  check(!(await search("dana whitfield high alt")) && !(await reached("/search")), "Patient details: Block stops them without asking");
  await openCard();
  await page.click("#agent-guard-slip button[data-do=on-personal-data][data-value=remove]");
  await sleep(800);
  outside = "";
  await page.goto(`${PORTAL}/`);
  await page.type("input[name=q]", "dana whitfield high alt");
  await page.click("form[action$='/search'] button");
  const previewed = await page.waitForSelector("#ag-preview", { timeout: 15000 }).then(() => true, () => false);
  const skippedChoice = !(await page.$("#ag-strip"));
  const preview = previewed ? await page.$eval("#ag-preview", (el) => el.textContent ?? "") : "";
  check(previewed && skippedChoice && preview.includes("[NAME_1]") && !/whitfield/i.test(preview), "Patient details: Remove goes straight to confirming the text with the name replaced");
  check(!(await reached("/search")), "Remove sends nothing until the person confirms");
  if (previewed) await page.$eval("#ag-strip-send", (el) => el.click());
  await settle();
  check(await reached("/search"), "after confirming, Remove sends the question");
  check(outside ? /\[NAME_1\]/.test(outside) && !/whitfield/i.test(outside) : true, `what Remove sent has the name replaced${outside ? "" : " (not checked: another portal server is running)"}`);
  await openCard();
  await page.type("#agent-guard-slip input[name=site]", "medlineplus.gov");
  await page.keyboard.press("Enter");
  await sleep(800);
  check((await cardText()).includes("medlineplus.gov"), "a person can add a site to the slip");
  await page.click("#agent-guard-slip button[data-do=reset]");
  await sleep(800);
  check(!(await cardText()).includes("Edited by you") && !(await cardText()).includes("medlineplus.gov"), "reset returns the original slip");

  // 5. A destination not on the slip. Should be blocked.
  await page.goto("https://example.com/", { timeout: 8000 }).catch(() => {});
  await sleep(1000);
  const shown = await page.evaluate(() => location.href).catch(() => "");
  check(shown.includes("/blocked.html"), "navigation to a site not on the slip shows the block page");
} finally {
  await browser.close();
  portal.kill();
  if (outside.trim()) console.log(`outside site last saw:\n${outside.trim()}`);
  process.exit(failed ? 1 : 0);
}
