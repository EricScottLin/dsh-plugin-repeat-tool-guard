# Changelog

## 1.0.0 — 2026-11-25

- First public release.
- URL target normalisation: query/fragment removal, lowercased host, trailing noise-extension stripping.
- Failure memory: after two 4xx/5xx fetches, every variant of the target is refused.
- Per-target cap (`perTarget`, default 4).
- Unattended budgets that cancel the turn: 60 tool calls, 30 `web_fetch` calls, 15 minutes per turn, 120 `web_fetch` calls per hour.
- User messages clear duplicate/failure memory but do **not** reset the turn/hour budgets.
- Per-agent isolation for subagents.
- 10-test suite with a fake Cordis context; no runtime dependencies.
