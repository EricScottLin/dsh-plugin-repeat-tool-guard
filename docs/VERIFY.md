# Verification

## Unit tests

```sh
npm test
```

Result on 2026-11-25: **10/10 pass**.

Covers:

1. target normalisation (query, fragment, case, `.md5/.sig/.txt` suffixes);
2. 4xx/5xx result detection;
3. setting defaults and invalid values;
4. per-target cap;
5. two 404s refusing later suffix variants;
6. tool-call budget + user message does not reset it + new turn resets it;
7. per-turn `web_fetch` budget across distinct targets;
8. hourly budget surviving a per-turn reset;
9. wall-clock budget cancelling a turn;
10. separate agents keeping separate budgets.

## Live test — original failure shape

On 2026-11-25, a subagent was instructed to call `web_fetch` on the same
`https://www.diving-fish.com/api/maimaidxprober/chart_stats` URL four times,
sequentially, using no other tool.

Result with the target guard installed:

- attempt 1: normal fetch;
- attempt 2: normal fetch;
- attempt 3: refused by `repeat-tool-guard` (no network request);
- attempt 4: refused by `repeat-tool-guard` (no network request).

This is the shape that previously produced 229 calls, because the spill path in
each result changed and result-fingerprint guards saw “new progress”.

## What is not live-tested here

The 60-call / 15-minute turn budget is covered by the unit harness, not by a
60-call live turn: triggering it in a shared session would cancel the session
under test. The harness drives the same `tools/pre-execute`,
`tools/post-execute` and `agent/pre-step` handlers with a fake `ctx`, so the
counter and cancellation paths are exercised without spending a real turn.
