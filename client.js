/**
 * dsh-composer-predict — browser half.
 *
 * One `conversation.chat.turnTail` entry per completed turn: the suggestion sits
 * at the END of the transcript, right under the reply it followed, the same
 * place @jipika/dsh-memory puts its per-turn memory line. Because it is an entry
 * of the flow itself (not a bar above the composer) it inherits the message
 * column's width, needs no background of its own, and several predictions can
 * coexist down the history.
 *
 * Accepting never sends: it calls `inputActions.setDraft(text)`, so the text
 * becomes an editable draft and the user still presses Enter.
 *
 * Polling is shared per session. Every turnTail instance for one session rides
 * the same fetch loop, so a long transcript costs one request per interval, not
 * one per rendered turn.
 */

window.__ModuleLoader__.load({
  id: 'dsh-composer-predict',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const STATE_PATH = '/plugins/dsh-composer-predict/state'
    const POLL_MS = 2000
    /** A suggestion older than this stops showing, even if the turn stays visible. */
    const TTL_MS = 30 * 60 * 1000
    /** Only this many of the newest turns keep a line; older turns are history. */
    const RECENT_TURNS = 10

    const styles = {
      tail: {
        marginTop: '6px',
        color: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        cursor: 'pointer',
        userSelect: 'none',
      },
    }

    /** sessionId -> { data, listeners, timer } — one poll loop per session. */
    const watchers = new Map()

    /**
     * Fetch this session's per-turn predictions once and reschedule.
     * @param {string} sessionId - owning session id.
     * @param {{data: object, listeners: Set<(data: object) => void>, timer: any}} watcher - shared loop state.
     */
    async function tick(sessionId, watcher) {
      try {
        const response = await fetch(
          `${STATE_PATH}?session=${encodeURIComponent(sessionId)}`,
          { headers: { accept: 'application/json' }, cache: 'no-store' },
        )
        if (response.ok) {
          const data = await response.json()
          watcher.data = data !== null && typeof data === 'object' ? data : {}
          for (const listener of watcher.listeners) listener(watcher.data)
        }
      } catch {
        /* transport hiccup: keep the last value, retry on the next tick */
      }
      if (watcher.listeners.size > 0) {
        watcher.timer = setTimeout(() => { void tick(sessionId, watcher) }, POLL_MS)
      }
    }

    /**
     * Join the shared loop for one session.
     * @param {string} sessionId - owning session id.
     * @param {(data: object) => void} listener - receives every new payload.
     * @returns {() => void} unsubscribe; the last one out stops the loop.
     */
    function subscribe(sessionId, listener) {
      let watcher = watchers.get(sessionId)
      if (watcher === undefined) {
        watcher = { data: {}, listeners: new Set(), timer: null }
        watchers.set(sessionId, watcher)
      }
      watcher.listeners.add(listener)
      if (watcher.timer === null) {
        listener(watcher.data)
        void tick(sessionId, watcher)
      }
      return () => {
        watcher.listeners.delete(listener)
        if (watcher.listeners.size > 0) return
        clearTimeout(watcher.timer)
        watcher.timer = null
        watchers.delete(sessionId)
      }
    }

    /**
     * One turn's suggestion line, rendered under that turn.
     * @param {object} props - slot props (owner TurnTailOwnerProps + standard hooks).
     */
    function PredictionTail(props) {
      const { useInput, inputActions } = props
      const turn = props.turn?.turn
      // `sid` comes from the registrant's inject face, matching how @jipika/dsh-memory
      // addresses the session from turnTail (its owner currency is turn/seq/openFile).
      const sessionId = props.sid ?? props.sessionId
      const draft = useInput(state => state.draft)
      const [dismissedAt, setDismissedAt] = React.useState(null)
      const [data, setData] = React.useState({})

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
        return subscribe(sessionId, setData)
      }, [sessionId])

      if (typeof turn !== 'number') return null

      const turnKeys = Object.keys(data).map(Number).filter(Number.isFinite)
      const latestTurn = turnKeys.length > 0 ? Math.max(...turnKeys) : 0
      const entry = data[String(turn)]
      const text = typeof entry?.text === 'string' ? entry.text : ''
      const at = typeof entry?.at === 'number' ? entry.at : 0
      const fresh = at > 0 && Date.now() - at < TTL_MS
      // Draft contents do not gate the line: this reads as a per-turn note, not
      // as a composer affordance, so it stays put while the user is already
      // typing something else.
      const visible = text.length > 0 && fresh
        && dismissedAt !== at && turn >= latestTurn - RECENT_TURNS

      // `setDraft` replaces everything (and drops reference chips), so it is only
      // safe on an empty composer. `insertText` is the contract's own answer for
      // a non-empty draft: "Insert asynchronous text without replacing subsequent
      // edits or reference chips", guarded by the captured span, returning false
      // when the draft moved on. A false result simply does nothing.
      const accept = React.useCallback(() => {
        if (!visible) return
        if (draft.length === 0) {
          inputActions.setDraft(text)
          return
        }
        inputActions.insertText(text, inputActions.captureInsertion())
      }, [visible, draft, text, inputActions])

      React.useEffect(() => {
        if (!visible) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            setDismissedAt(at)
            return
          }
          if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
          if (event.isComposing === true) return
          // Only steal Tab when the caret actually sits in the composer.
          if (document.activeElement?.isContentEditable !== true) return
          event.preventDefault()
          event.stopPropagation()
          accept()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [visible, accept, at])

      if (!visible) return null

      // A line of the flow, not a surface: no background, no border, no fixed
      // width — the transcript column already sets all of that. Hover only
      // brightens the text, and no node appears on hover (that used to change
      // the line box height).
      return h(
        'div',
        {
          className: 'dsh-composer-predict',
          style: { ...styles.tail, opacity: 0.6 },
          role: 'status',
          title: 'Tab 采纳 · Esc 关闭',
          onClick: accept,
          onMouseEnter: event => { event.currentTarget.style.opacity = '0.85' },
          onMouseLeave: event => { event.currentTarget.style.opacity = '0.6' },
        },
        text,
      )
    }

    return {
      name: 'dsh-composer-predict',
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
            name: 'conversation.chat.turnTail',
            id: 'composer-predict',
            order: 30,
            label: '预测',
            inject: (sessionId) => ({ sid: sessionId }),
          }, PredictionTail))
        } catch (error) {
          console.error('[dsh-composer-predict] browser half failed to mount:', error)
        }
      },
    }
  },
})
