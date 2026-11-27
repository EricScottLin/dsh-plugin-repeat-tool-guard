# dsh-plugin-repeat-tool-guard

## Summary

**When nobody is watching, a DSH agent can fetch the same resource hundreds of times while only changing a query string, file suffix or number.** This plugin normalises the fetch target, caps repeats, and adds hard per-turn/per-hour budgets; when a budget is exceeded it calls `agent.cancel()` and ends the turn instead of waiting for the model to stop.

- Works with DeepSeek Harness 0.2.x (tested on `0.2.2-rc.5`).
- Targets `web_fetch` variants, 404 suffix guessing and unattended long loops.
- **Runtime fallback on the host side** — not a prompt, not a model fix, no core changes.
- No runtime dependencies, no UI, no new tools.

Install (npm recommended):

```sh
dsh plugin --profile web add dsh-plugin-repeat-tool-guard
```

From GitHub:

```sh
dsh plugin --profile web add github:EricScottLin/dsh-plugin-repeat-tool-guard
```

## Background

On 2026-11-25 I hit a real runaway in a DSH session:

- model: `deepseek-v4-1-flash-1017`
- provider: `mistral`
- reasoning effort: `low`
- DSH version: `0.2.2-rc.5`
- result: 4 turns, 545 tool calls, **488 of them `web_fetch`**; one `chart_stats` URL was fetched **229 times**.

The URLs looked like this:

```
https://www.diving-fish.com/api/maimaidxprober/chart_stats
https://www.diving-fish.com/api/maimaidxprober/chart_stats?t=1
https://raw.githubusercontent.com/.../maimai_analysis_curve.py
https://raw.githubusercontent.com/.../maimai_analysis_curve.py.md5
https://raw.githubusercontent.com/.../maimai_analysis_curve.py.md5.txt
https://raw.githubusercontent.com/.../maimai_analysis_curve.py.sig
```

Every call had different arguments, but they were the same target: 404 suffix guessing and repeated fetches of one large result. The user sent five “what are you doing / stop” messages and the loop kept going.

The dangerous case is **unattended**: a goal, a scheduled task, or a user who walked away. A human can stop a visible loop; nobody stops an invisible one.

## What I tried

### 1. The official `repeat-tool-reminder`

DSH ships it, and it reminds at 3/5/8 identical calls. But:

- it **only reminds**, it does not block;
- every user message **clears the counter**, so nagging the model actually gives it a fresh start.

It only reminds at 3/5/8 by design; it did not stop this loop.

### 2. `@goodandready/dsh-agent-loop-guard` 0.3.6

The most complete community option. I installed it and ran a controlled comparison:

- `example.com` 4 times: calls 3 and 4 were blocked with `[LOOP_GUARD_STEER]` — good;
- `chart_stats` 4 times: **all four passed, none blocked**.

It decides “progress” by result fingerprints. Large results are spilled to `/tmp/...` with a random path on every call, so the fingerprint changes and it sees “new evidence” each time.

### 3. `dsh-loop-breaker` / `dsh-repeat-stop` / `dsh-brake`

I read the sources and did not install these:

- `dsh-loop-breaker`: exact `(tool, arguments)` counting plus a 25-step / 5-minute per-turn budget — close, but **no URL normalisation**; a new suffix or query string is a new call, and user messages reset the counter.
- `dsh-repeat-stop`: exact arguments, hard block after 6 identical calls; **no turn/hour budget**, and user messages reset the counter.
- `dsh-brake`: experimental; no complete budget/cancel semantics documented.

They each cover “exactly the same arguments”; this incident was “different-looking arguments, same target”, plus unattended operation.

In total I evaluated three groups — the official reminder, `@goodandready/dsh-agent-loop-guard`, and the exact-argument family (`dsh-loop-breaker` / `dsh-repeat-stop` / `dsh-brake`) — and none covered this shape.

### Conclusion

A fallback needs four things at once:

1. count by **normalised target**, not by argument string;
2. **do not reset budgets on user messages**;
3. have an **absolute per-turn/hour limit** that does not depend on result changes;
4. **end the turn** on breach, not just reject one call.

## Solution

### Target layer

The `web_fetch` URL is normalised:

- drop the query string and fragment;
- lowercase the host;
- strip trailing noise extensions (`.md5`, `.sig`, `.asc`, `.txt`, `.json`, …).

So `audit.ts?x=1`, `audit.ts.md5`, `audit.ts.md5.txt` and `audit.ts.sig` all collapse to `audit.ts`.

On top of that:

- **failure memory**: a 4xx/5xx or `404` marks the target failed; after two failures, every later variant is refused;
- **per-target cap**: `perTarget` fetches per turn (default 4);
- **consecutive guard**: the same target repeated three times in a row is refused.

### Budget layer

Any of these cancels the whole turn via `agent.cancel()`:

| Budget | Default | Purpose |
|---|---:|---|
| Tool calls per turn | 60 | All tools, so switching tools cannot continue |
| `web_fetch` per turn | 30 | Switching targets cannot continue |
| Wall-clock per turn | 15 min | Model thinking and slow commands count |
| `web_fetch` per hour | 120 | Survives turn resets for goal/scheduled runs |

**User messages do not clear these budgets.** Saying “stop” clears duplicate/failure memory only; it does not hand the runaway a fresh 60-call allowance. Per-turn counters reset only on a new turn; the hourly window survives.

### What kind of measure is this

It is a **runtime fallback**, not a model fix and not a prompt:

- hooks `tools/pre-execute`, `tools/post-execute`, `agent/pre-step` on the host;
- deterministic counters, URL normalisation and time windows;
- on breach, `agent.cancel({ kind: 'hook', reason })`;
- it does not rely on the model understanding the rule, or on a human watching.

It assumes the model may not cooperate, so “stop” is a mechanical condition.

## Test results

### Unit tests

```sh
npm test
```

**10/10 pass**: normalisation, 4xx/5xx detection, defaults, per-target cap, 404 memory, tool budget + user-message non-reset + new-turn reset, fetch budget, hourly budget, wall-clock budget, per-agent isolation.

### Live test

Four sequential calls to the same `chart_stats` URL:

- calls 1–2: normal fetch;
- calls 3–4: refused by `repeat-tool-guard`, **no network request**.

This is the shape that previously produced 229 calls; it now stops in time.

### Install paths

- GitHub source install: `pnpm add github:EricScottLin/dsh-plugin-repeat-tool-guard` → 1.0.0, `import` succeeds.
- npm packaging: `npm publish --dry-run` passes (8 files, ~11 kB).

## Generality

This is not specific to `chart_stats`:

- target normalisation applies to any `web_fetch` URL;
- budgets apply to every tool, not just `web_fetch`;
- counters are per agent; subagents get their own budgets;
- every threshold is configurable; no API, host or model is hardcoded;
- installs as a standard DSH bundle without core changes.

Known limits:

- a single `bash` command that loops `curl` internally is invisible; only the 15-minute wall clock and the bash timeout bound it;
- subagent count is not limited;
- the hourly cap is a rate limit, not a billing cap;
- no semantic similarity: different hosts or completely different paths are different targets.

## Configuration

```yaml
- id: repeat-tool-guard
  config:
    perTarget: 4
    maxFailures: 2
    maxToolCallsPerTurn: 60
    maxFetchesPerTurn: 30
    maxTurnMinutes: 15
    maxFetchesPerHour: 120
```

| Key | Default | Meaning |
|---|---:|---|
| `perTarget` | 4 | Fetches per target per turn |
| `maxFailures` | 2 | Failures before all variants are refused |
| `maxToolCallsPerTurn` | 60 | All tool calls per turn |
| `maxFetchesPerTurn` | 30 | `web_fetch` calls per turn |
| `maxTurnMinutes` | 15 | Wall-clock minutes per turn |
| `maxFetchesPerHour` | 120 | `web_fetch` calls per agent per hour |

## Relationship to existing guards

- `@deepseek-ai/dsh-repeat-tool-reminder`: advisory only; resets on user messages.
- `@goodandready/dsh-agent-loop-guard`: broader, but result-fingerprint-based; random spill paths look like progress.
- `dsh-loop-breaker` / `dsh-repeat-stop`: exact-argument matching; suffix/query variants look new; user messages reset their counters.
- This plugin adds the target-normalised, unattended-budget layer and can coexist with any of them.

## License

MIT
