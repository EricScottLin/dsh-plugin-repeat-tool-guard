# dsh-plugin-repeat-tool-guard

**Hard stop for unattended tool-call runaway loops.** When nobody is watching, a DeepSeek Harness agent can keep calling `web_fetch` against the same resource while only changing the query string, file suffix or numeric suffix. This plugin normalises the target, caps repeats, and cancels the whole turn once a per-turn or hourly budget is exceeded.

It is a brake, not a reminder: it does not depend on the model cooperating.

## The incident it was built from

In a real DSH session on 2026-11-25:

- one `chart_stats` URL was fetched **229 times**;
- 488 `web_fetch` calls across four turns, many of them suffix-guessing 404s (`maidle.py`, `record_filter.py`);
- the user sent five "what are you doing / stop" messages and the loop kept going;
- large results were spilled to `/tmp/...` with a random path on every call, so guards that key on the result fingerprint saw "new progress" every time.

Two root causes:

1. the official `repeat-tool-reminder` **only reminds** and clears its counter on every user message;
2. the agent loop has **no per-turn step or wall-clock cap**.

## What it enforces

### Target normalisation

The `web_fetch` URL drops its query string and fragment, lowercases the host, and strips trailing noise extensions (`.md5`, `.sig`, `.asc`, `.txt`, `.json`, …). These all collapse to one target:

```
https://example.com/a/audit.ts?x=1
https://example.com/a/audit.ts.md5
https://example.com/a/audit.ts.md5.txt
https://example.com/a/audit.ts.sig
```

### Failure memory

A 4xx/5xx or `404` result marks the target failed. After `maxFailures` (default 2), every later variant of that target is refused — retrying a 404 under another name cannot produce a 200.

### Per-target cap

The same target is allowed `perTarget` times per turn (default 4), then refused.

### Unattended budgets

Any of these cancels the whole turn via `agent.cancel()`:

| Budget | Default | Purpose |
|---|---:|---|
| Tool calls per turn | 60 | All tools, so switching tools cannot continue the loop |
| `web_fetch` per turn | 30 | Switching targets cannot continue the loop |
| Wall-clock per turn | 15 min | Model thinking, slow commands and retries all count |
| `web_fetch` per hour | 120 | Survives turn resets, so a goal/scheduled run cannot reset its budget every round |

**User messages do not clear these budgets.** Saying "stop" clears duplicate/failure memory only; it does not hand the runaway a fresh 60-call allowance. Per-turn counters reset only on a new turn; the hourly window survives.

### Per-agent isolation

Subagents have their own budgets and counters.

## Install

```sh
dsh plugin --profile web add dsh-plugin-repeat-tool-guard
```

or from GitHub:

```sh
dsh plugin --profile web add github:EricScottLin/dsh-plugin-repeat-tool-guard
```

Restart `dsh web` (or let the profile hot-reload) after installing. The plugin ships no UI and registers no tools.

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
| `perTarget` | 4 | Fetches per normalised target per turn |
| `maxFailures` | 2 | Failures before all variants of a target are refused |
| `maxToolCallsPerTurn` | 60 | All tool calls per turn |
| `maxFetchesPerTurn` | 30 | `web_fetch` calls per turn |
| `maxTurnMinutes` | 15 | Wall-clock minutes per turn (decimals allowed) |
| `maxFetchesPerHour` | 120 | `web_fetch` calls per agent per hour |

## Verification

```sh
npm test
```

Ten tests cover normalisation, 404 memory, per-target, tool, fetch, wall-clock and hourly budgets, user-message non-reset, new-turn reset, and agent isolation. See `docs/VERIFY.md` for the live `chart_stats` test: calls 3 and 4 were refused with no network request.

## Limitations

- A single `bash` command that loops `curl` internally is invisible to the plugin; only the 15-minute wall clock and the bash tool timeout bound it.
- Subagent count is not limited; each subagent has its own budget.
- The hourly cap is a rate limit, not a billing cap.
- It does not do semantic similarity: different hosts or completely different paths are different targets.

## Relationship to existing guards

- `@deepseek-ai/dsh-repeat-tool-reminder`: advisory only, resets on user messages.
- `@goodandready/dsh-agent-loop-guard`: broader, but result-fingerprint-based; random spill paths look like progress.
- `dsh-loop-breaker` / `dsh-repeat-stop`: exact-argument matching, so suffix/query variants look new; user messages reset their counters.
- This plugin adds the target-normalised, unattended-budget layer and can coexist with any of them.

## License

MIT
