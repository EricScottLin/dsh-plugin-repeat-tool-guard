/**
 * repeat-tool-guard — a hard stop for URL-guessing and unattended runaway loops.
 *
 * The advisory @deepseek-ai/dsh-repeat-tool-reminder only injects a reminder at
 * 3/5/8 *identical* repeats and resets on every user message, so a weak model can
 * ignore it forever. Exact-argument matching is not enough either: the observed
 * failure mode is "same 404 page, keep appending file suffixes"
 * (`audit.ts` → `audit.ts.md5` → `audit.ts.md5.txt` → `.sig` → `.asc` → …) or
 * "same URL, keep bumping a query parameter". Every call has different
 * arguments, so an exact-match guard counts each one as fresh and allows it.
 *
 * This guard therefore keys on the *target*, not the arguments, and adds hard
 * per-turn / per-hour budgets so a turn cannot run forever when nobody is
 * watching:
 *
 *   1. URL normalisation: the query string and fragment are dropped, and the
 *      path is trimmed of trailing file-extension segments (`x.ts.md5` →
 *      `x.ts`), so all suffix variants collapse onto one target.
 *   2. Failure memory: a 4xx/5xx or `404` in the result marks the target failed.
 *      Once a target has failed twice, every further variant of it is refused —
 *      retrying a 404 under another name can only produce another 404.
 *   3. Per-target budget: after `perTarget` fetches a single target is refused
 *      for the rest of the turn, whatever the arguments.
 *   4. Repeat backstop: the same normalised URL several times in a row is refused.
 *   5. Turn budgets: `maxToolCallsPerTurn`, `maxFetchesPerTurn`, and
 *      `maxTurnMinutes` cancel the whole turn via `agent.cancel()`. This is the
 *      unattended safety net: it does not depend on result content, target
 *      identity, or the model cooperating.
 *   6. Hourly fetch budget: `maxFetchesPerHour` caps a multi-turn goal/scheduled
 *      run, which a per-turn counter alone would reset every turn.
 *
 * Everything is per-agent (subagents get their own state). A user message clears
 * duplicate/failure memory (new intent) but does NOT reset the turn/hour
 * budgets; otherwise saying "stop" would hand the runaway a fresh budget.
 *
 * Config (`dsh.profile.bundles` / `cordis.patch.yml`):
 *   - id: repeat-tool-guard
 *     config:
 *       perTarget: 4
 *       maxFailures: 2
 *       maxToolCallsPerTurn: 60
 *       maxFetchesPerTurn: 30
 *       maxTurnMinutes: 15
 *       maxFetchesPerHour: 120
 */

/** Extension segments that get appended when guessing a file name. */
const SUFFIX_SEGMENTS = new Set([
  'md', 'md5', 'sha1', 'sha256', 'sha512', 'sig', 'asc', 'gpg', 'txt', 'json',
  'yaml', 'yml', 'html', 'htm', 'raw', 'gz', 'zip', 'tar', 'bz2', 'xz', 'zst',
])

/** Suffix-only first parts: `x.md5` is a real file, not `x`. */
const STOP_BEFORE_SOFT = new Set(['md5', 'sig', 'asc', 'gpg', 'sha1', 'sha256', 'sha512'])

const HOUR_MS = 60 * 60 * 1000

/**
 * Collapse a fetch target onto the resource it is trying to reach.
 * @param {string} raw - the `url` argument of a `web_fetch` call.
 * @returns {string} normalised target, or '' when there is no usable URL.
 */
export function normaliseTarget(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  let url
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  const host = url.host.toLowerCase()
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  // Strip noise extensions from the LAST segment only, so the directory it lives
  // in is kept: `audit.middleware.ts.md5.txt` → `audit.middleware.ts`.
  const last = segments.length > 0 ? segments[segments.length - 1] : ''
  const parts = last.split('.')
  while (parts.length > 1 && SUFFIX_SEGMENTS.has(parts[parts.length - 1].toLowerCase()) && !STOP_BEFORE_SOFT.has(parts[0].toLowerCase())) {
    parts.pop()
  }
  if (segments.length > 0) segments[segments.length - 1] = parts.join('.')
  return `${host}/${segments.join('/')}`
}

/**
 * Did the tool result report a fetch failure? Results arrive as
 * `{ isError?, content: [{ type: 'text', text }] }`, so read the text blocks.
 */
export function looksFailed(result) {
  if (result === undefined || result === null) return false
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
  if (text === '') return false
  return /(?:HTTP|status)\D{0,3}(?:4\d\d|5\d\d)\b/i.test(text) || /^\s*404/m.test(text) || /\b404:?\s*Not Found/i.test(text)
}

export const name = 'repeat-tool-guard'

// No `Config` export on purpose. DSH treats a plugin's `Config` as a Standard
// Schema validator and calls `Config['~standard'].validate(config)`; a hand
// written factory (or one importing @deepseek-ai/schemastery, which a `link:`
// plugin cannot resolve) throws and DSH skips the whole entry with
// "did not activate". `apply()` resolves the settings itself instead.
export function resolveSettings(config) {
  const int = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
  }
  const positive = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    perTarget: int(config?.perTarget, 4),
    maxFailures: int(config?.maxFailures, 2),
    maxToolCallsPerTurn: int(config?.maxToolCallsPerTurn, 60),
    maxFetchesPerTurn: int(config?.maxFetchesPerTurn, 30),
    maxTurnMinutes: positive(config?.maxTurnMinutes, 15),
    maxFetchesPerHour: int(config?.maxFetchesPerHour, 120),
  }
}

export function apply(ctx, config) {
  const {
    perTarget, maxFailures, maxToolCallsPerTurn, maxFetchesPerTurn,
    maxTurnMinutes, maxFetchesPerHour,
  } = resolveSettings(config)

  /** agent -> per-agent target memory + turn/hour budget */
  const state = new WeakMap()

  const stateOf = (agent) => {
    let entry = state.get(agent)
    if (entry === undefined) {
      const now = Date.now()
      entry = {
        targets: new Map(),
        last: '',
        lastCount: 0,
        turn: { number: undefined, startedAt: now, toolCalls: 0, fetches: 0 },
        window: { startedAt: now, fetches: 0 },
      }
      state.set(agent, entry)
    }
    return entry
  }

  const deny = (reason) => ({ kind: 'deny', reason })

  const cancelTurn = (agent, reason) => {
    try {
      agent?.cancel?.({ kind: 'hook', reason })
    } catch {
      // Cancellation is best-effort; the deny below still blocks this call.
    }
  }

  const budgetDeny = (agent, reason) => {
    cancelTurn(agent, reason)
    return deny(`${reason} This turn has been cancelled to stop an unattended runaway loop.`)
  }

  const refreshWindow = (entry, now) => {
    if (now - entry.window.startedAt > HOUR_MS) {
      entry.window = { startedAt: now, fetches: 0 }
    }
  }

  ctx.on('tools/pre-execute', (exec, next) => {
    const agent = exec.agent
    if (agent === undefined) return next()

    const now = Date.now()
    const entry = stateOf(agent)
    refreshWindow(entry, now)

    // 5. Turn budgets apply to every tool, not just web_fetch: a runaway can
    //    switch to bash/curl, read, or another tool to keep making calls.
    if (now - entry.turn.startedAt > maxTurnMinutes * 60 * 1000) {
      return budgetDeny(
        agent,
        `repeat-tool-guard: this turn has been running for more than ${maxTurnMinutes} minutes `
        + `(${entry.turn.toolCalls} tool calls so far); refusing ${exec.name} and ending the turn.`,
      )
    }
    entry.turn.toolCalls += 1
    if (entry.turn.toolCalls > maxToolCallsPerTurn) {
      return budgetDeny(
        agent,
        `repeat-tool-guard: this turn has made ${entry.turn.toolCalls} tool calls `
        + `(limit ${maxToolCallsPerTurn}); refusing ${exec.name} and ending the turn.`,
      )
    }

    if (exec.name !== 'web_fetch') return next()

    entry.turn.fetches += 1
    entry.window.fetches += 1
    if (entry.turn.fetches > maxFetchesPerTurn) {
      return budgetDeny(
        agent,
        `repeat-tool-guard: this turn has made ${entry.turn.fetches} web_fetch calls `
        + `(limit ${maxFetchesPerTurn}); refusing this request and ending the turn.`,
      )
    }
    if (entry.window.fetches > maxFetchesPerHour) {
      return budgetDeny(
        agent,
        `repeat-tool-guard: ${entry.window.fetches} web_fetch calls in the last hour `
        + `(limit ${maxFetchesPerHour}); refusing this request and ending the turn.`,
      )
    }

    const target = normaliseTarget(exec.arguments?.url)
    // Unparseable URL: not our business, the tool itself will report it.
    if (target === '') return next()

    let slot = entry.targets.get(target)
    if (slot === undefined) {
      slot = { count: 0, failures: 0 }
      entry.targets.set(target, slot)
    }

    // 2. Known-dead target: another suffix will 404 just the same.
    if (slot.failures >= maxFailures) {
      return deny(
        `repeat-tool-guard: "${target}" already failed ${slot.failures} times this turn; `
        + 'this request was NOT executed. The resource does not exist, so a different suffix, '
        + 'query string, or case will not find it either. Stop guessing file names. '
        + 'Use the host API to list the directory (for GitHub: '
        + 'https://api.github.com/repos/<owner>/<repo>/contents/<dir>), or `bash` with git/curl, '
        + 'then fetch the path you actually saw. If that is not possible, say so and stop.',
      )
    }

    // 3. Per-target budget.
    if (slot.count >= perTarget) {
      return deny(
        `repeat-tool-guard: "${target}" has already been fetched ${slot.count} times this turn; `
        + 'this request was NOT executed. Another variant of the same target is not a new method. '
        + 'Read the saved result from disk instead (`/tmp/dsh-spill-*`), list the directory via the '
        + 'host API, or stop and tell the user what is unresolved.',
      )
    }

    // 4. Same target several times in a row.
    if (entry.last === target && entry.lastCount >= 2) {
      return deny(
        `repeat-tool-guard: "${target}" is being requested repeatedly with only cosmetic changes; `
        + 'this request was NOT executed. Change method, not URL.',
      )
    }

    slot.count += 1
    entry.lastCount = entry.last === target ? entry.lastCount + 1 : 1
    entry.last = target
    return next()
  }, { prepend: true })

  // Record failures after the fact so the next call can refuse the target.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name === 'web_fetch' && exec.agent !== undefined && looksFailed(result)) {
      const target = normaliseTarget(exec.arguments?.url)
      if (target !== '') {
        const entry = stateOf(exec.agent)
        const slot = entry.targets.get(target) ?? { count: 0, failures: 0 }
        slot.failures += 1
        entry.targets.set(target, slot)
      }
    }
    return next()
  }, { prepend: true })

  ctx.on('agent/pre-step', ({ agent, turn, messages }, next) => {
    const entry = stateOf(agent)
    // A new turn gets fresh per-turn counters; the hourly window deliberately
    // survives, so a goal/scheduled run cannot reset its own budget each round.
    if (typeof turn === 'number' && entry.turn.number !== turn) {
      entry.turn = { number: turn, startedAt: Date.now(), toolCalls: 0, fetches: 0 }
    }
    // A user message is new intent for duplicate/failure memory, but it must
    // NOT hand a runaway a fresh turn/hour budget: saying "stop" would otherwise
    // reset the very counters that are about to stop it.
    if (messages?.some((message) => message.source?.kind === 'user')) {
      entry.targets.clear()
      entry.last = ''
      entry.lastCount = 0
    }
    return next()
  }, { prepend: true })
}
