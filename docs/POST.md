# Draft: warning post for the DSH community

Status: draft, not posted. Suggested venue: DeepSeek Harness GitHub Discussions
(“Show and tell” or the plugin category), with a link from the repo README.
Related upstream discussion: https://github.com/deepseek-ai/deepseek-harness/discussions/5976

---

## Title

Unattended DSH agents can loop forever on `web_fetch` — here is the shape, and a guard

## Body

I want to flag a failure mode that cost a real session ~488 `web_fetch` calls
and produced nothing:

- one `chart_stats` URL fetched **229 times**;
- 4 turns, 488 fetches total;
- the user sent five “stop / what are you doing” messages and it kept fetching;
- every result was spilled to `/tmp/...` with a different random path, so
  result-fingerprint guards saw “new progress” on every call.

It is not just “the model is dumb”. Three things stack up:

1. **The official `repeat-tool-reminder` is advisory.** It fires at 3/5/8
   identical calls, and any user message clears the counter. If nobody is
   watching, there is no one to act on the reminder.
2. **The harness has no per-turn step or wall-clock cap.** The agent loop can
   run for hundreds of steps; `maxParallelToolCalls` is not a step budget.
3. **Large results defeat result-based dedupe.** Spill paths and compression
   stubs change per call, so “same result” looks like “new evidence”.

The dangerous version is **unattended**: a goal, a scheduled task, or just a
user who walked away. A human can stop a visible loop; nobody stops an
invisible one.

### What helped

I wrote a small host plugin, `dsh-plugin-repeat-tool-guard`, which adds a
budget layer rather than another reminder:

- normalise the fetch target (drop query/fragment, strip `.md5/.sig/...`
  suffixes) and cap repeats per target;
- remember 404s: after two failures, every suffix variant is refused;
- **hard budgets** that call `agent.cancel()`: 60 tool calls, 30 `web_fetch`,
  or 15 minutes per turn; 120 fetches per hour across turns;
- user messages do **not** reset the budgets — saying “stop” must not hand the
  loop a fresh allowance.

It is deliberately small, dependency-free, and MIT. Unit tests and the live
reproduction are in the repo:
https://github.com/EricScottLin/dsh-plugin-repeat-tool-guard

It is a complement, not a replacement: `@goodandready/dsh-agent-loop-guard`
covers more shapes (stream loops, error thrashing), and `dsh-loop-breaker` /
`dsh-repeat-stop` cover exact-argument repeats. Use whichever fits; the point
is to have at least one **hard** budget when nobody is watching.

### Ask

If you ship an agent plugin, consider exposing a hard per-turn tool/time budget
in addition to any “reminder” logic. Reminders are for cooperative models;
budgets are for the 3 a.m. case.
