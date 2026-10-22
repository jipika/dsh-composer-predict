# dsh-composer-predict

Next-message predictions for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — one quiet suggestion at the end of every turn, accepted with `Tab`.

It is the DSH counterpart of Codex's *Composer predictions*: after a turn completes, the model reads the conversation and guesses what you are about to say next. The guess is rendered as a single faint line in the transcript tail, right under the reply it followed, and several of them can coexist down the history.

## What it does

- **One line per turn, in the flow** — mounted on `conversation.chat.turnTail`, so it inherits the message column's width and scrolls with the transcript. No banner, no border, no background.
- **Tab to accept** — the text becomes an editable draft; it is never sent for you. On a non-empty draft it is *inserted* at the caret instead of replacing what you already typed.
- **Esc to dismiss** a single suggestion.
- **Nothing when there is nothing** — with no prediction the entry renders `null`: no wrapper, no reserved height. A turn in progress counts as nothing, so the previous turn's guess never sits beside fresh output.
- **Quiet by default** — 30-minute expiry, and only the newest 10 turns keep a line.
- **Newest wins** — a newer finished turn cancels a guess still in flight, so you never see a suggestion for an older turn while the newest one went unpredicted.
- **Stands down on a full context** — no prediction once the next request would fill 70% of the window (`maxPressureRatio`).

## Cache behaviour

This is the part worth reading before you tune it.

1. **The auxiliary call is a genuine prefix of the conversation.** It replays the session's own system prompt, tools and message history, then appends its directive as the *final user message*. That is the same construction `compaction-basic` uses, and it is what makes the provider's warm KV prefix cache reusable instead of invalidated.
2. **It never invents a route.** Provider and model come from `session.requestHeader().config`. A different route shares no prefix cache at all.
3. **It never invents a system prompt, a `purpose`, or sampling overrides.** Rewriting message 0 drops the prefix cache immediately.
4. **Results are cached per turn.** Key = `<log seq>|<provider>/<model>`, stored under `sessionId → turn`. Re-entering a finished turn, or a duplicate `turn/end`, costs zero model calls. The host keeps 20 turns per session and 64 sessions.
5. **Newest wins.** Only one auxiliary call streams at a time. When a newer turn finishes while a guess is still in flight, the older call is aborted and counted as *superseded* rather than failed — the suggestion that lands always belongs to the turn that just ended, instead of the newest turn being dropped behind an older guess.
6. **It stands down on a full context.** A prediction replays the whole conversation, so near the context limit it is the most expensive and least reliable call the plugin can make. The host reads the token-meter `contextPressure` projection (an O(1) fold, so the check is free) and skips the turn once the next request would occupy `maxPressureRatio` of the routed window. When that projection, the provider sample, or the route capacity is missing, the guard has no opinion and the prediction runs as usual — a missing signal never blocks a guess.

The listener subscribes to `session/event` with `{ global: true }`. That is required rather than defensive: a plugin fiber is not on a session's scope ancestor chain, so without it the listener never fires.

## Install

```bash
dsh plugin install link:/absolute/path/to/dsh-composer-predict
```

Or add it to your profile's `package.json`:

```jsonc
{
  "dependencies": { "dsh-composer-predict": "link:../../plugins/dsh-composer-predict" },
  "dsh": { "profile": { "bundles": ["dsh-composer-predict"] } }
}
```

The host half needs a **host restart** to mount (it serves `/plugins/dsh-composer-predict/state`); the browser half reloads over HMR.

## Configuration

The bundle patch accepts three optional overrides:

```yaml
- insert:
    - id: composer-predict
      name: dsh-composer-predict
      config:
        maxTokens: 200
        timeoutMs: 25000
        maxPressureRatio: 0.7
```

`maxPressureRatio` is the share of the routed context window above which a finished turn is not predicted. Set it to `0` to disable the guard and always predict.

## Self-check

```bash
curl -s 'http://127.0.0.1:<port>/plugins/dsh-composer-predict/diag'
# {"mountedAt":...,"turnEnds":12,"skipped":2,"starts":10,"superseded":1,
#  "pressureSkips":0,"failures":0,"lastFailure":"","lastKey":"...",
#  "lastPressure":0.31,"sessions":1,"cached":10,"inflight":0}
```

`turnEnds` counts completed turns seen, `starts` predictions actually run, `skipped` turns passed over (aborted, duplicate, or already cached), `superseded` guesses cancelled by a newer turn, `pressureSkips` turns passed over by the occupancy guard, `failures` auxiliary calls that failed, and `cached` stored predictions. `lastPressure` is the last measured occupancy as a fraction of the window. It never carries conversation text.

## Requirements

- DeepSeek Harness `>= 0.2.0`
- A configured provider/model route on the session (the prediction reuses it)

## License

MIT
