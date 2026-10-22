/**
 * dsh-composer-predict — host half.
 *
 * After a completed turn it asks the model for the user's most likely NEXT
 * message and caches the answer per (session, log position, route). The browser
 * half draws it above the composer and accepts it with Tab.
 *
 * Cache discipline (the reason this plugin exists in this shape):
 *   1. Prefix reuse. The auxiliary call replays the conversation's own system
 *      prompt, tools and message prefix, then appends its directive as the
 *      FINAL user message — exactly the construction `compaction-basic` uses
 *      (`packages/compaction/compaction-basic/src/summarizer.ts:26-34`). That
 *      makes the call a genuine prefix of the last routed request, so the
 *      provider's warm KV prefix cache is reused instead of invalidated.
 *   2. Same route. The call reuses `session.requestHeader().config`'s
 *      provider/model. A different route shares no prefix cache at all, so the
 *      plugin never invents one.
 *   3. Result cache. `sessionId -> { key, text }` with key
 *      `<log seq>|<provider>/<model>`: re-entering a finished turn, or a
 *      duplicate turn/end, costs zero model calls.
 *   4. Skip before spend. Empty drafts are decided in the browser half; here we
 *      skip non-completed turns, sessions that never routed a request, turns
 *      whose prediction is already cached, and turns whose NEXT request would
 *      occupy more than `maxPressureRatio` of the routed context window. That
 *      last guard reads the token-meter `contextPressure` projection — an O(1)
 *      fold — and silently stands down when the projection, the route capacity,
 *      or the projection service itself is absent.
 *   5. Newest wins. At most one auxiliary call runs: when a newer turn finishes
 *      while a guess is still streaming, the older call is aborted and counted
 *      as superseded, not as a failure. The suggestion that lands therefore
 *      always belongs to the turn that just ended.
 *
 * This file loads through the bundle patch channel (`cordis.patch.yml`), so a
 * change here needs a host restart; the browser half reloads over HMR.
 */

/** Cordis plugin name. */
export const name = 'dsh-composer-predict'

/** Services this plugin reads; `llm` is the only one that talks to a model. */
export const inject = ['llm', 'webServer']

/** Exact path the browser half polls. */
const STATE_PATH = '/plugins/dsh-composer-predict/state'

/** Exact path of the self-check answer (admission + counts + last failure name). */
const DIAG_PATH = '/plugins/dsh-composer-predict/diag'

/** Upper bound on one prediction; a next-message guess is one short sentence. */
const DEFAULT_MAX_TOKENS = 200

/** The auxiliary call must never outlive the turn that produced it by much. */
const DEFAULT_TIMEOUT_MS = 25_000

/**
 * Stand down once the next request would occupy this share of the context
 * window. A prediction replays the whole conversation, so on a nearly full
 * context it is the most expensive and least useful call the plugin can make.
 * `0` disables the guard.
 */
const DEFAULT_MAX_PRESSURE_RATIO = 0.7

/** Sessions kept in the result cache (LRU, insertion-ordered Map). */
const CACHE_LIMIT = 64

/**
 * Predictions kept per session. History carries one suggestion per completed
 * turn, so the cache is keyed by turn; old turns fall off in insertion order.
 */
const TURNS_PER_SESSION = 20

/**
 * Predictions allowed to run at once across all sessions. The one slot is
 * deliberately exclusive: the plugin exists to guess the NEXT message, so a
 * guess for an older turn is worth less than one for the turn that just ended.
 */
const CONCURRENCY = 1

/**
 * The directive is delivered as the final user message of the replayed
 * conversation, never as a separate system prompt: a distinct system prompt
 * would rewrite message 0 and drop the provider's prefix cache.
 */
const INSTRUCTION = [
  'Read the conversation above and predict the single message the user is most likely to send next.',
  '',
  'Rules:',
  '- Output ONLY that message text. No explanation, no quotes, no role prefix such as "User:".',
  '- Write in the same language the user has been using.',
  '- Aim at the user\'s real next intent: confirm or reject a pending result, ask for a specific revision, or start the natural next action once the work looks done.',
  '- One sentence, at most 60 Chinese characters (or 40 English words).',
  '- If no meaningful prediction exists, output exactly: SKIP',
].join('\n')

/**
 * Returned to the browser for a session with no stored prediction at all.
 * @type {Record<string, never>}
 */
const EMPTY = {}

/**
 * sessionId -> Map<turn, { key, text, at, model }>.
 *
 * Keyed by turn, not by session: the browser half renders one entry per
 * completed turn in the transcript tail, so several predictions coexist and
 * each one has to be addressable on its own.
 */
const cache = new Map()

/** Predictions currently in flight; mirrors whether {@link running} is set. */
let inflight = 0

/**
 * The one prediction allowed to stream right now, or null. Kept by reference
 * identity: a superseding turn replaces it, so the older call's `finally` sees
 * `running !== slot` and leaves the slot and the timer alone.
 * @type {{ controller: AbortController, superseded: boolean, timedOut: boolean, sessionId: string, turn: number } | null}
 */
let running = null

/**
 * Mount-time counters for {@link DIAG_PATH}. They hold no conversation text:
 * counts, the last failure CLASS (never a message, which can quote the
 * transcript), and the last cache key — that key is `<seq>|<provider>/<model>`,
 * routing metadata only.
 */
const stats = {
  mountedAt: 0,
  turnEnds: 0,
  skipped: 0,
  starts: 0,
  superseded: 0,
  pressureSkips: 0,
  failures: 0,
  lastFailure: '',
  lastKey: '',
  /** Last measured occupancy as a share of the route's context window, or 0. */
  lastPressure: 0,
}

/**
 * Store one prediction for one turn, evicting the oldest turn of that session
 * and then the least recently touched session.
 * @param {string} sessionId - owning session.
 * @param {number} turn - completed turn the prediction belongs to.
 * @param {{key: string, text: string, at: number, model: string}} entry - prediction record.
 */
function remember(sessionId, turn, entry) {
  let turns = cache.get(sessionId)
  if (turns === undefined) {
    turns = new Map()
  } else {
    // Re-insert so the session counts as most recently touched.
    cache.delete(sessionId)
  }
  cache.set(sessionId, turns)

  turns.delete(turn)
  turns.set(turn, entry)
  while (turns.size > TURNS_PER_SESSION) {
    const oldest = turns.keys().next()
    if (oldest.done === true) break
    turns.delete(oldest.value)
  }
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/**
 * Identity of "the same finished turn on the same route".
 * `session.seq` advances on every appended event, so any new turn or message
 * invalidates the stored prediction, while re-reading an untouched turn hits.
 * @param {import('@deepseek-ai/dsh-session/types').Session} session - live session.
 * @returns {string} cache key.
 */
function cacheKey(session) {
  const config = session.requestHeader()?.config
  const route = config === undefined ? '' : `${config.provider}/${config.model}`
  return `${session.seq}|${route}`
}

/**
 * Occupancy the NEXT request would reach, as a share of the routed capacity.
 *
 * Read from the token-meter `contextPressure` projection rather than estimated
 * here: that unit already folds the provider's newest prompt sample plus the
 * signed surface movement since it, so the number is anchored to what the
 * provider actually charged and stays correct across a compaction. Every
 * unavailable input means "no opinion" (`undefined`) — never a false stop:
 * the projection service, the usage sample, and the route capacity each have
 * to be present.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} session - finished session.
 * @returns {number|undefined} share of the window in use, or undefined.
 */
function pressureRatio(ctx, session) {
  const registry = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
  if (registry === undefined || typeof registry.snapshot !== 'function') return undefined
  let view
  try {
    // O(1): the unit is folded incrementally on every committed event.
    view = registry.snapshot(session, ['contextPressure']).values.contextPressure
  } catch {
    // A missing unit, a schema mismatch, or a half-restored cell all mean the
    // same thing to a guess: no occupancy signal this turn.
    return undefined
  }
  if (view === undefined) return undefined
  const tokens = view.projectedTokens ?? view.pressureTokens
  const capacity = view.contextWindow
  if (typeof tokens !== 'number' || typeof capacity !== 'number' || capacity <= 0) return undefined
  return tokens / capacity
}

/**
 * Reduce model output to one clean draft: strip code fences, wrapping quotes, role
 * prefixes, and newlines; honor the SKIP sentinel.
 * @param {string} raw - accumulated text-delta output.
 * @returns {string} the draft to show, or '' for "no suggestion".
 */
function clean(raw) {
  let text = String(raw ?? '').trim()
  if (text.length === 0) return ''
  if (/^SKIP\b/i.test(text)) return ''
  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim()
  text = text.replace(/^(?:用户|User)\s*[:：]\s*/i, '')
  text = text.replace(/^["'“”『』「」`]+/, '').replace(/["'“”『』「」`]+$/, '')
  text = text.split('\n').map(line => line.trim()).filter(line => line.length > 0).join(' ')
  text = text.trim()
  if (text.length > 300) text = text.slice(0, 300).trim()
  return text
}

/**
 * Run one prediction for a finished session and store it.
 *
 * The request deliberately omits `purpose` (the type only admits `compaction`
 * and `session-title`), `system` (the system prompt is already message 0 of the
 * replayed history), and sampling overrides (they belong to the conversation's
 * epoch header and would drift from it).
 *
 * @param {object} ctx - host plugin context.
 * @param {object} session - finished session.
 * @param {number} turn - completed turn the prediction belongs to.
 * @param {number} maxTokens - completion cap.
 * @param {AbortSignal} signal - caller-owned cancellation: supersession or timeout.
 * @returns {Promise<void>} resolves when the prediction is stored or skipped.
 */
async function predict(ctx, session, turn, maxTokens, signal) {
  const header = session.requestHeader()
  const config = header?.config
  if (config === undefined || config.provider === undefined || config.model === undefined) return

  // Surface-projected LLM history: the same messages the session's own requests
  // are derived from, so the replayed prefix is byte-identical up to our tail.
  const prefix = session.deriveMessages()
  if (!Array.isArray(prefix) || prefix.length === 0) return

  const options = {
    provider: config.provider,
    model: config.model,
    messages: [
      ...prefix,
      { role: 'user', content: [{ type: 'text', text: INSTRUCTION }] },
    ],
    toolHistory: session.toolHistory(),
    ...(header.tools === undefined ? {} : { tools: header.tools }),
    maxTokens,
    sessionId: session.id,
    signal,
  }

  let text = ''
  let failed = false
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') failed = true
  }
  if (failed) return

  // An abort can land after the stream already settled; storing that text is
  // still correct (the turn's own guess is complete), so no check is needed.
  remember(session.id, turn, {
    key: cacheKey(session),
    text: clean(text),
    at: Date.now(),
    model: String(config.model),
  })
}

/**
 * Mount the plugin. A failure here must never take the host down with it, so the
 * real body lives in `mount` and any throw is logged and swallowed.
 * @param {object} ctx - Cordis host context carrying `llm` and `webServer`, plus
 *   an optionally-available `sessionProjections` read through `ctx.get`.
 * @param {object} [rawConfig] - patch config overrides.
 */
export function apply(ctx, rawConfig) {
  try {
    mount(ctx, rawConfig)
  } catch (error) {
    console.error('[dsh-composer-predict] host half failed to mount; predictions stay off:', error)
  }
}

/**
 * Register the state route and the turn/end listener.
 * @param {object} ctx - Cordis host context carrying `llm` and `webServer`, plus
 *   an optionally-available `sessionProjections` read through `ctx.get`.
 * @param {object} [rawConfig] - patch config overrides.
 */
function mount(ctx, rawConfig) {
  const config = rawConfig ?? {}
  const maxTokens = Number.isFinite(config.maxTokens) ? Number(config.maxTokens) : DEFAULT_MAX_TOKENS
  const timeoutMs = Number.isFinite(config.timeoutMs) ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS
  // `0` (or a negative) turns the occupancy guard off entirely.
  const maxPressureRatio = Number.isFinite(config.maxPressureRatio)
    ? Number(config.maxPressureRatio)
    : DEFAULT_MAX_PRESSURE_RATIO
  stats.mountedAt = Date.now()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      const url = new URL(req.url ?? STATE_PATH, 'http://localhost')
      const sessionId = url.searchParams.get('session') ?? ''
      const turns = sessionId.length === 0 ? undefined : cache.get(sessionId)
      // One key per completed turn: the browser renders one tail entry per turn
      // and several predictions coexist in the transcript.
      const body = {}
      if (turns !== undefined) {
        for (const [turn, entry] of turns) {
          body[turn] = { text: entry.text, at: entry.at, model: entry.model }
        }
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(turns === undefined ? EMPTY : body))
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DIAG_PATH,
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({
        ...stats,
        sessions: cache.size,
        cached: [...cache.values()].reduce((total, turns) => total + turns.size, 0),
        inflight,
      }))
    },
  }))

  // `session/event` is a post-commit, fire-and-forget feed: a slow or throwing
  // listener cannot delay or fail the append that produced it. That is exactly
  // what an auxiliary model call needs — the turn is already closed here, unlike
  // `agent/turn-stopping`, which is serial and would block turn teardown.
  //
  // `{ global: true }` is REQUIRED, not defensive. A session dispatches through a
  // scope carrier, and `packages/core/scope/src/index.ts:32-38` states the rule:
  // "event admission extends UP it (a listener tagged with an ancestor receives
  // events dispatched to a descendant key)". A plugin fiber is not on a session's
  // ancestor chain, so without `global` the listener never fires — silently.
  // Admission is per-dispatch only: each handler receives the session object it
  // was called with, so one session's turn can never land in another's cache.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    stats.turnEnds += 1
    if (event.data?.reason?.kind !== 'completed') {
      stats.skipped += 1
      return
    }

    const turn = event.data.turn
    const key = cacheKey(session)
    const hit = cache.get(session.id)?.get(turn)
    if (hit !== undefined && hit.key === key) {
      stats.skipped += 1
      return
    }

    // Occupancy guard: a nearly full context makes the replayed prefix the most
    // expensive request the plugin can send, for the least reliable guess.
    const ratio = pressureRatio(ctx, session)
    if (ratio !== undefined) {
      stats.lastPressure = Math.round(ratio * 1000) / 1000
      if (maxPressureRatio > 0 && ratio >= maxPressureRatio) {
        stats.pressureSkips += 1
        return
      }
    }

    // Newest wins: the exclusive slot is handed to this turn, and whatever was
    // streamed for an older one is cancelled. The older call's `finally` sees a
    // different slot, so it neither clears `running` nor touches `inflight`;
    // its own timer is cleared there too, before this branch could be revisited.
    if (running !== null) {
      running.superseded = true
      running.controller.abort()
    }
    const controller = new AbortController()
    const slot = { controller, superseded: false, timedOut: false, sessionId: session.id, turn }
    const timer = setTimeout(() => {
      slot.timedOut = true
      controller.abort()
    }, timeoutMs)
    running = slot

    stats.starts += 1
    stats.lastKey = key
    inflight = CONCURRENCY
    void predict(ctx, session, turn, maxTokens, controller.signal)
      .catch((error) => {
        // Supersession is the slot working as designed, not a broken call.
        if (slot.superseded) {
          stats.superseded += 1
          return
        }
        stats.failures += 1
        // Class only: an error message can quote the transcript, and this value
        // is served over HTTP. A timeout is reported as such, never as a name
        // the transport happened to raise.
        stats.lastFailure = slot.timedOut ? 'Timeout' : String(error?.name ?? typeof error)
        console.error('[dsh-composer-predict] prediction failed:', stats.lastFailure)
      })
      .finally(() => {
        clearTimeout(timer)
        if (running !== slot) return
        running = null
        inflight = 0
      })
  }, { global: true })
}
