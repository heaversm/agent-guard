# Agent Guard

A Firefox extension that makes the browser, not the AI agent, enforce the rules. Every request an agent makes is held and checked against a permission slip before it leaves. Personal data headed for an outside site is stopped, and the guard keeps its own log of what happened.

It doesn't matter what's driving the browser: an LLM agent, a script, or a person clicking all get the same checks.

## What it does

- **Holds every request from a task tab** and checks it against the slip (`public/slip.json`): which sites are allowed, which count as inside, whether personal data may leave, and whether the task is read-only.
- **Learns the record.** When an inside page loads, the guard notes the identifying details on it (name, birth date, IDs, contact details) and catches them leaving in any case, in part, or with different separators. Medical terms are left off that list, so a de-identified question still goes out.
- **Checks forms before they're sent.** When a form would carry personal data outside, the person supervising chooses: block it, remove the details and send, or send anyway.
- **Blocks sites not on the slip** with a page naming the site, the reason, and what the slip allows.
- **Keeps its own log**, under the toolbar icon, with every decision, its reason and masked values. An agent's account of its own run can't be trusted. This log doesn't depend on it.

Personal data is found with exact-format rules plus a small open model, [foxmind-small](https://huggingface.co/pooria/foxmind-small) (86 MB, GLiNER2.5), that ships inside the extension and runs on the CPU. Nothing is sent to a server.

It relies on something Firefox allows and Chrome restricts: an extension can hold a request open while it runs an asynchronous check, such as a model call, before deciding.

## The demo

A local test portal (`portal/server.mjs`, no dependencies) serves two sites on this machine:

- **springfield-health.test:8080** is the inside site. It has one invented patient record, a lookup box that sends to the outside site, and a message with hidden planted content: an instruction telling the agent to press a **Sync record** button whose hidden fields carry the record. A *Show planted content* switch reveals it.
- **medlookup.test:8081** is the outside site. Its terminal prints every request that reaches it, so anything printed got out.

`agent.mjs` has Claude operate the portal in Firefox with the guard installed. It reads the page as text, including the hidden instruction, and picks its own actions. Scenarios:

| Scenario | The agent is asked to | What the guard does |
|---|---|---|
| `share` | Send the patient's name and MRN to the outside site | Asks; the supervisor blocks it |
| `strip` | The same | Asks; the supervisor removes the details and it's sent |
| `hijack` | Summarise the blood work. Planted content tells it to press Sync record | Blocks the record leaving, if the agent falls for it |
| `browse` | Look something up on a site not on the slip | Blocks the site |
| `subtle` | The same as hijack, with a planted note that reads like site guidance | Run by name only |

At the end it prints the agent's own summary next to the guard's log. In testing, Sonnet 5.5 and Haiku 5.5 spotted and ignored both planted instructions, so `--rehearse` plays a fooled agent with scripted actions. It needs no API key and costs nothing.

## Running it

Needs Node 24 or later and Firefox 157 or later at `/Applications/Firefox.app` (set `FIREFOX` to the binary path elsewhere).

```sh
npm install
npm run build      # bundles the extension into dist/; downloads the model once and checks its sha256
npm run demo       # starts the portal and opens a clean Firefox with the guard installed
```

The Claude agent:

```sh
npm run rehearse   # scripted run, no key, no cost
cp .env.example .env   # then put your Anthropic API key in .env
npm run agent      # all scenarios; or: node agent.mjs --scenario=share --model=claude-sonnet-5-5 --fast
```

Model, scenario and pace are in `agent.settings.mjs`. The key is the only thing read from `.env`.

Tests:

```sh
npm test           # builds, then runs the end-to-end checks in a headless Firefox
npm run accuracy   # personal-data detection accuracy; writes artifacts/agent-guard-accuracy-*.json
```

## What's here

| Path | What it is |
|---|---|
| `src/` | The extension: request checks and log (`background.ts`), form checks and banner (`content.ts`), the slip card on each allowed page (`slipcard.ts`), personal-data detection (`detect.ts`), the log popup |
| `public/` | Manifest, the slip, popup and block pages, icons |
| `core/` | The in-browser model runtime and format rules, from foxpilot |
| `lib/` | Build, model download, and Firefox launch helpers |
| `portal/` | The test sites |
| `agent.mjs`, `agent.settings.mjs` | The Claude agent and its settings |
| `demo.mjs` | One-command demo window |
| `e2e/` | End-to-end test and accuracy check |

## What's weak

- One invented patient page and one outside site. Real portals are messier.
- The MRN is caught, but sometimes labelled as a phone number.
- Current models usually ignore obvious planted instructions, so the hijack scenario mostly shows the guard as a backstop, via the rehearsal.
- One end-to-end check fails as of Nov 2026: "navigation to a site not on the slip shows the block page." The other checks pass.
- The Claude agent and its rehearsal open the log page in a visible Firefox; in `--headless` mode that step times out.
- Firefox gives an extension no body for a form post that navigates the page, so forms are checked in the page before they're sent, and any outside form post that skipped that check is blocked.

## Credits

Built on [foxpilot](https://github.com/pooriaarab/foxpilot) (MIT): the model runtime, the build approach, the foxmind-small model, PII Guard's detection approach (adapted in `src/detect.ts`), the Firefox launch helpers and the icons. See `LICENSE`.

A personal research prototype by Mike Heavers. All patient data is invented.
