const POLL_MS = 700
const POLL_TIMEOUT_MS = 5000
const PROMPT_PREDICTION_STATE_PATH = '/api/agentkit/prompt-prediction/state'
const PROMPT_PREDICTION_FEEDBACK_PATH = '/api/agentkit/prompt-prediction/feedback'

/** Install the native composer ghost-text overlay. */
export function installPromptPrediction(ctx, { React, h, window }) {
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register(
    { name: 'conversation.input.overlay', id: 'agentkit-studio-prompt-prediction', order: -20 },
    props => h(PromptPredictionOverlay, { ...props, React, h, window }),
  ))
}

function PromptPredictionOverlay(props) {
  const { React, h, window, useInput, inputActions, sessionId } = props
  if (typeof useInput !== 'function' || inputActions === undefined || sessionId === undefined) return null
  const input = useInput(value => value)
  const session = typeof props.useSession === 'function' ? props.useSession(value => value) : undefined
  const plan = typeof props.useProjection === 'function'
    ? props.useProjection('plan', value => value != null && (value.pending ? !value.active : value.active))
    : false
  const [snapshot, setSnapshot] = React.useState(null)
  const [dismissed, setDismissed] = React.useState(null)
  const cardRef = React.useRef(null)

  const draft = typeof input?.draft === 'string' ? input.draft : ''
  const empty = draft.length === 0 && (input?.attachmentIds?.length ?? 0) === 0 && (input?.occurrences?.length ?? 0) === 0
  const busy = session !== undefined && (session.running || session.removed || session.openState !== 'open')
  const active = empty && input?.phase === 'plain' && (input?.queue?.length ?? 0) === 0 && !busy && !plan
  const visible = active && snapshot?.sessionId === sessionId && snapshot.status === 'ready'
    && typeof snapshot.text === 'string' && snapshot.text.length > 0
    && !(dismissed?.sessionId === sessionId && dismissed.turnSeq === snapshot.turnSeq && dismissed.text === snapshot.text)

  React.useEffect(() => {
    if (!active) {
      setSnapshot(null)
      return undefined
    }
    let cancelled = false
    let timer
    let controller
    let revision = -1
    const poll = async () => {
      if (cancelled) return
      controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), POLL_TIMEOUT_MS)
      try {
        const response = await window.fetch(`${PROMPT_PREDICTION_STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}&rev=${revision}`, {
          headers: { accept: 'application/json' }, signal: controller.signal,
        })
        if (!response.ok) throw new Error(`prediction state ${response.status}`)
        const next = await response.json()
        if (!cancelled && next?.unchanged !== true && Number.isSafeInteger(next?.rev)) {
          revision = next.rev
          setSnapshot({ ...next, sessionId })
        }
      } catch {
        if (!cancelled) { revision = -1; setSnapshot(null) }
      } finally {
        window.clearTimeout(timeout)
        if (!cancelled) timer = window.setTimeout(poll, POLL_MS)
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      controller?.abort()
    }
  }, [active, sessionId, window])

  React.useEffect(() => {
    const card = cardRef.current?.closest?.('[data-composer-card]')
    if (card === null || card === undefined) return undefined
    const placeholder = card.querySelector?.('[data-composer-placeholder]')
    const previousVisibility = placeholder?.style?.visibility
    if (visible) {
      card.setAttribute('data-agentkit-prediction-active', '')
      if (placeholder?.style !== undefined) placeholder.style.visibility = 'hidden'
    } else card.removeAttribute('data-agentkit-prediction-active')
    return () => {
      card.removeAttribute('data-agentkit-prediction-active')
      if (placeholder?.style !== undefined) placeholder.style.visibility = previousVisibility || ''
    }
  }, [visible])

  const sendFeedback = React.useCallback((action, extra = {}) => {
    void window.fetch(PROMPT_PREDICTION_FEEDBACK_PATH, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, action, turnSeq: snapshot?.turnSeq ?? null, ...extra }),
    }).catch(() => {})
  }, [sessionId, snapshot?.turnSeq, window])

  const accept = React.useCallback(() => {
    if (!visible) return false
    try {
      const span = inputActions.captureInsertion()
      if (!inputActions.insertText(snapshot.text, span)) {
        sendFeedback('conflict')
        return false
      }
      sendFeedback('accepted', { text: snapshot.text })
      setDismissed(null)
      setSnapshot(null)
      return true
    } catch {
      sendFeedback('conflict')
      return false
    }
  }, [inputActions, sendFeedback, snapshot, visible])

  React.useEffect(() => {
    if (!visible) return undefined
    const onKeyDown = event => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return
      if (!['Tab', 'ArrowRight', 'Escape'].includes(event.key)) return
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
      const card = cardRef.current?.closest?.('[data-composer-card]')
      const editor = card?.querySelector?.('[contenteditable]')
      if (editor === null || editor === undefined || !editor.contains(document.activeElement)) return
      if (event.key === 'Escape') {
        setDismissed({ sessionId, turnSeq: snapshot.turnSeq, text: snapshot.text })
        sendFeedback('dismissed', { text: snapshot.text })
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (!accept()) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [accept, sessionId, sendFeedback, snapshot, visible, window])

  if (!visible) return h('span', { ref: cardRef, 'data-agentkit-prediction-anchor': 'empty' })
  const text = snapshot.text.split('\n')[0]
  return h('span', {
    ref: cardRef,
    'data-agentkit-prediction-anchor': 'ghost',
    'aria-hidden': 'true',
    style: {
      position: 'absolute', left: '12px', top: '8px', right: '12px',
      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
      pointerEvents: 'none', color: 'var(--dsw-alias-label-tertiary)',
      opacity: 0.72, font: 'inherit', lineHeight: 'inherit', zIndex: 0,
    },
  }, text)
}
