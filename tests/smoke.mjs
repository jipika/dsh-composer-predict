/**
 * Offline smoke test for the host half: no real model, no real webserver.
 * It exercises the whole chain — mount, turn/end listener, prefix replay,
 * stream collection, cleaning, the per-turn result cache, and both routes.
 *
 * Run: node tests/smoke.mjs
 */

import assert from 'node:assert/strict'
import { apply } from '../index.js'

const routes = []
let listener
let listenerOptions

const ctx = {
  llm: {
    /** @param {object} options - the exact request the plugin builds. */
    async *stream(options) {
      ctx.calls = (ctx.calls ?? 0) + 1
      ctx.lastOptions = options
      yield { type: 'text-delta', index: 0, text: '"把测试跑一遍，' }
      yield { type: 'text-delta', index: 0, text: '然后告诉我结果。"' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  webServer: {
    /** @param {object} route - registered route. */
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
  on(name, fn, options) {
    if (name === 'session/event') {
      listener = fn
      listenerOptions = options
    }
  },
}

apply(ctx, {})

assert.equal(routes.length, 2, 'state + diag routes are registered')
const stateRoute = routes.find(route => route.path === '/plugins/dsh-composer-predict/state')
const diagRoute = routes.find(route => route.path === '/plugins/dsh-composer-predict/diag')
assert.ok(stateRoute, 'state route exists')
assert.ok(diagRoute, 'diag route exists')
assert.equal(stateRoute.kind, 'exact')
assert.equal(typeof listener, 'function', 'turn/end listener is mounted')
// Admission rule: a plugin fiber is not on a session's ancestor chain, so the
// listener only ever fires with `global: true`.
assert.deepEqual(listenerOptions, { global: true }, 'listener opts into global admission')

const session = {
  id: 'session-1',
  seq: 42,
  requestHeader: () => ({ config: { provider: 'demo-provider', model: 'demo-model' }, tools: [{ name: 'shell' }] }),
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] },
    { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
  ],
  toolHistory: () => ({ calls: [] }),
}

/** Read the whole per-turn payload for one session. */
function readState(sessionId) {
  let body = ''
  stateRoute.handler(
    { method: 'GET', url: `/plugins/dsh-composer-predict/state?session=${sessionId}` },
    { writeHead() {}, end(chunk) { body = chunk } },
  )
  return JSON.parse(body)
}

listener(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await new Promise(resolve => setTimeout(resolve, 100))

// --- the request must be a genuine prefix of the conversation -------------
const sent = ctx.lastOptions
assert.ok(sent, 'a model call was made')
assert.equal(sent.provider, 'demo-provider', 'same provider as the conversation')
assert.equal(sent.model, 'demo-model', 'same model as the conversation')
assert.deepEqual(sent.tools, [{ name: 'shell' }], 'tools replayed unchanged')
assert.equal(sent.messages.length, 4, 'history + one trailing directive')
assert.equal(sent.messages[0].role, 'system', 'system stays in the replayed prefix')
assert.equal(sent.messages[3].role, 'user', 'directive is the FINAL user message')
assert.ok(sent.messages[3].content[0].text.includes('predict'), 'directive is the prediction ask')
assert.equal(sent.purpose, undefined, 'purpose is not invented')
assert.equal(sent.system, undefined, 'no separate system field (that would break the prefix)')

// --- the cached answer is addressable by turn ----------------------------
const first = readState('session-1')
assert.deepEqual(Object.keys(first), ['1'], 'stored under the completed turn')
assert.equal(first['1'].text, '把测试跑一遍，然后告诉我结果。', 'quotes stripped, newlines folded')
assert.equal(first['1'].model, 'demo-model')

// --- cache: a duplicate turn/end on the same log position is free --------
const callsBefore = ctx.calls
listener(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await new Promise(resolve => setTimeout(resolve, 50))
assert.equal(ctx.calls, callsBefore, 'same turn + same key => no second model call')

// --- a later turn adds a second entry instead of replacing the first -----
session.seq = 43
listener(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
await new Promise(resolve => setTimeout(resolve, 100))
const second = readState('session-1')
assert.deepEqual(Object.keys(second).sort(), ['1', '2'], 'predictions coexist per turn')

// --- non-completed turns are skipped -------------------------------------
const beforeAbort = ctx.calls
session.seq = 44
listener(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted' } } })
await new Promise(resolve => setTimeout(resolve, 50))
assert.equal(ctx.calls, beforeAbort, 'aborted turn spends nothing')
assert.deepEqual(Object.keys(readState('session-1')).sort(), ['1', '2'], 'aborted turn adds no entry')

// --- unknown session answers an empty map --------------------------------
assert.deepEqual(readState('nope'), {}, 'unknown session answers {}')

// --- method guard --------------------------------------------------------
let status = 0
stateRoute.handler({ method: 'POST', url: '/plugins/dsh-composer-predict/state' }, {
  writeHead(code) { status = code },
  end() {},
})
assert.equal(status, 405, 'non-GET is refused')

// --- diag answers without conversation text ------------------------------
let diag = ''
diagRoute.handler({ method: 'GET', url: '/plugins/dsh-composer-predict/diag' }, {
  writeHead() {},
  end(chunk) { diag = chunk },
})
const diagPayload = JSON.parse(diag)
assert.equal(diagPayload.turnEnds, 4, 'every turn/end was seen')
assert.equal(diagPayload.starts, 2, 'two predictions actually ran')
assert.ok(diagPayload.skipped >= 2, 'duplicate + aborted were skipped')
assert.equal(diagPayload.cached, 2, 'two cached turns')
assert.equal(diagPayload.sessions, 1, 'one cached session')
assert.ok(!JSON.stringify(diagPayload).includes('把测试'), 'diag never carries prediction text')

console.log('smoke OK — prefix replay, per-turn cache, coexistence, skip, diag, and routes all verified')
