import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, normaliseTarget, looksFailed, resolveSettings } from '../index.js'

/** Build a fake Cordis context and drive its event waterfalls. */
function harness(config) {
  const handlers = new Map()
  const ctx = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
    },
  }
  apply(ctx, config)
  const call = (event, ...args) => {
    const list = handlers.get(event) ?? []
    let index = -1
    const next = () => {
      index += 1
      if (index >= list.length) return { kind: 'allow' }
      return list[index](...args, next)
    }
    return next()
  }
  const agent = {
    cancelled: [],
    cancel(cause) { this.cancelled.push(cause) },
  }
  const exec = (name, args = {}) => ({ name, arguments: args, agent })
  return { ctx, agent, call, exec }
}

const URL_A = 'https://example.com/a/audit.ts'

test('normaliseTarget collapses query, fragment, case and suffix variants', () => {
  assert.equal(normaliseTarget('https://EXAMPLE.com/a/audit.ts?x=1#f'), 'example.com/a/audit.ts')
  assert.equal(normaliseTarget('https://example.com/a/audit.ts.md5'), 'example.com/a/audit.ts')
  assert.equal(normaliseTarget('https://example.com/a/audit.ts.md5.txt'), 'example.com/a/audit.ts')
  assert.equal(normaliseTarget('https://example.com/a/audit.ts.sig'), 'example.com/a/audit.ts')
  assert.equal(normaliseTarget('not a url'), '')
})

test('looksFailed recognises 4xx/5xx text', () => {
  assert.equal(looksFailed({ content: [{ type: 'text', text: 'Fetched x (HTTP 404)' }] }), true)
  assert.equal(looksFailed({ content: [{ type: 'text', text: 'Fetched x (HTTP 200)' }] }), false)
})

test('resolveSettings applies defaults and rejects nonsense', () => {
  const settings = resolveSettings({ perTarget: '3', maxTurnMinutes: 0 })
  assert.equal(settings.perTarget, 3)
  assert.equal(settings.maxTurnMinutes, 15)
  assert.equal(settings.maxToolCallsPerTurn, 60)
  assert.equal(settings.maxFetchesPerTurn, 30)
  assert.equal(settings.maxFetchesPerHour, 120)
})

test('per-target cap blocks the same target after N fetches', () => {
  const h = harness({ perTarget: 2, maxToolCallsPerTurn: 100, maxFetchesPerTurn: 100 })
  h.call('agent/pre-step', { agent: h.agent, turn: 1, messages: [] })
  assert.equal(h.call('tools/pre-execute', h.exec('web_fetch', { url: URL_A })).kind, 'allow')
  assert.equal(h.call('tools/pre-execute', h.exec('web_fetch', { url: URL_A })).kind, 'allow')
  const blocked = h.call('tools/pre-execute', h.exec('web_fetch', { url: URL_A }))
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /already been fetched 2 times/)
})

test('two 404s refuse every later suffix variant', async () => {
  const h = harness({ perTarget: 10, maxFailures: 2, maxToolCallsPerTurn: 100, maxFetchesPerTurn: 100 })
  h.call('agent/pre-step', { agent: h.agent, turn: 1, messages: [] })
  const result404 = { isError: true, content: [{ type: 'text', text: 'HTTP 404 Not Found' }] }
  await h.call('tools/post-execute', h.exec('web_fetch', { url: URL_A }), result404)
  await h.call('tools/post-execute', h.exec('web_fetch', { url: URL_A }), result404)
  const blocked = h.call('tools/pre-execute', h.exec('web_fetch', { url: URL_A + '.md5' }))
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /already failed 2 times/)
})

test('tool-call budget cancels the turn and ignores user messages', () => {
  const h = harness({ maxToolCallsPerTurn: 3, maxFetchesPerTurn: 100 })
  h.call('agent/pre-step', { agent: h.agent, turn: 1, messages: [] })
  for (let i = 0; i < 3; i++) {
    assert.equal(h.call('tools/pre-execute', h.exec('bash', { command: `echo ${i}` })).kind, 'allow')
  }
  // A user message must not hand the runaway a fresh budget.
  h.call('agent/pre-step', { agent: h.agent, turn: 1, messages: [{ source: { kind: 'user' } }] })
  const blocked = h.call('tools/pre-execute', h.exec('bash', { command: 'echo again' }))
  assert.equal(blocked.kind, 'deny')
  assert.equal(h.agent.cancelled.length, 1)
  // A new turn resets the per-turn budget.
  h.call('agent/pre-step', { agent: h.agent, turn: 2, messages: [] })
  assert.equal(h.call('tools/pre-execute', h.exec('bash', { command: 'echo t2' })).kind, 'allow')
})

test('fetch budget blocks after N distinct targets', () => {
  const h = harness({ maxToolCallsPerTurn: 100, maxFetchesPerTurn: 2, maxFetchesPerHour: 100 })
  h.call('agent/pre-step', { agent: h.agent, turn: 1, messages: [] })
  assert.equal(h.call('tools/pre-execute', h.exec('web_fetch', { url: 'https://example.com/1' })).kind, 'allow')
  assert.equal(h.call('tools/pre-execute', h.exec('web_fetch', { url: 'https://example.com/2' })).kind, 'allow')
  const blocked = h.call('tools/pre-execute', h.exec('web_fetch', { url: 'https://example.com/3' }))
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /3 web_fetch calls/)
})

test('hourly budget survives per-turn reset', () => {
  const h = harness({
    maxToolCallsPerTurn: 100, maxFetchesPerTurn: 100, maxFetchesPerHour: 4,
  })
  h.call('agent/pre-step', { agent: h.agent, turn: 1, messages: [] })
  for (let i = 1; i <= 4; i++) {
    assert.equal(h.call('tools/pre-execute', h.exec('web_fetch', { url: `https://example.com/${i}` })).kind, 'allow')
  }
  h.call('agent/pre-step', { agent: h.agent, turn: 2, messages: [] })
  const blocked = h.call('tools/pre-execute', h.exec('web_fetch', { url: 'https://example.com/5' }))
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /in the last hour/)
})

test('wall-clock budget cancels a turn that runs too long', () => {
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const h = harness({ maxTurnMinutes: 1, maxToolCallsPerTurn: 100, maxFetchesPerTurn: 100 })
    h.call('agent/pre-step', { agent: h.agent, turn: 1, messages: [] })
    now += 61_000
    const blocked = h.call('tools/pre-execute', h.exec('bash', { command: 'echo late' }))
    assert.equal(blocked.kind, 'deny')
    assert.match(blocked.reason, /more than 1 minutes/)
    assert.equal(h.agent.cancelled.length, 1)
  } finally {
    Date.now = realNow
  }
})

test('separate agents keep separate budgets', () => {
  const h = harness({ maxToolCallsPerTurn: 2, maxFetchesPerTurn: 100 })
  const other = { cancelled: [], cancel(cause) { this.cancelled.push(cause) } }
  h.call('agent/pre-step', { agent: h.agent, turn: 1, messages: [] })
  h.call('agent/pre-step', { agent: other, turn: 1, messages: [] })
  for (let i = 0; i < 2; i++) {
    assert.equal(h.call('tools/pre-execute', h.exec('bash', { command: `a${i}` })).kind, 'allow')
  }
  assert.equal(h.call('tools/pre-execute', h.exec('bash', { command: 'a3' })).kind, 'deny')
  const otherExec = { name: 'bash', arguments: { command: 'b1' }, agent: other }
  assert.equal(h.call('tools/pre-execute', otherExec).kind, 'allow')
  assert.equal(other.cancelled.length, 0)
})
