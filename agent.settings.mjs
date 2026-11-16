// Settings for agent.mjs. Nothing secret goes here — the API key stays in .env.
// Command-line flags override these for one run: --scenario=share --model=claude-sonnet-5-5 --fast
export default {
  // The Claude model the agent uses. It runs on Anthropic's servers; nothing downloads.
  //   claude-sonnet-5-5  realistic: what a company would run browser agents on
  //   claude-haiku-5-5   cheapest, fastest
  //   claude-opus-5-5    most capable: "even the best model"
  model: "claude-haiku-5-5",

  // How hard the model thinks per step: low, medium, high, xhigh, max.
  effort: "medium",

  // Which demo to run. "all" runs share, strip, hijack and browse in turn, then exits.
  //   share   asked to send the patient's name and MRN outside -> the guard asks; the supervisor blocks
  //   strip   the same request -> the guard asks; the supervisor removes the details and it's sent
  //   hijack  hidden planted content tells the agent to press Sync record, which sends the record out.
  //           Real models usually ignore it; --rehearse plays a fooled agent -> blocked
  //   browse  asked to look something up on a site not on the slip -> blocked: destination not on the slip
  // Extra, run by name: subtle — a planted note that reads like site guidance.
  scenario: "all",

  // true = watchable pace (caption on the page, letter-by-letter typing, pauses); false = full speed.
  slow: true,
};
