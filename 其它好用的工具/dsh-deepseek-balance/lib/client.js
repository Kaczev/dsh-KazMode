window.__ModuleLoader__.load({ id: 'dsh-deepseek-balance', factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
/**
 * dsh-deepseek-balance — browser half.
 *
 * A tiny floating widget on the DSH shell.overlay layer:
 *   - polls the local balance route (server proxies DeepSeek, so no API key is exposed)
 *   - draggable with pointer events
 *   - snaps to the nearest screen edge when dropped near one
 *   - remembers its position in localStorage
 */

const React = require('react')
const { createElement, useState, useEffect, useRef, useCallback } = React

const BALANCE_PATH = '/dsh-deepseek-balance/balance'
const POS_STORAGE_KEY = 'dsh-deepseek-balance:pos'
const STYLE_TAG_ID = 'dsh-deepseek-balance/styles'
const POLL_MS = 60000
const SNAP_THRESHOLD = 80
const EDGE_MARGIN = 12

const CSS = `
.dsb-root {
  position: fixed;
  z-index: 2147483000;
  pointer-events: auto;
  user-select: none;
  touch-action: none;
  font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif;
  cursor: grab;
}
.dsb-root.dsb-dragging {
  cursor: grabbing;
  opacity: 0.92;
  transition: none !important;
}
.dsb-card {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 6px 10px 6px 12px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-overlay, rgba(255,255,255,0.92));
  color: var(--dsw-alias-label-primary, #1f2328);
  border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.14));
  box-shadow: 0 8px 28px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08);
  backdrop-filter: blur(12px) saturate(1.1);
  white-space: nowrap;
}
.dsb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f59e0b;
  flex: none;
  box-shadow: 0 0 0 3px rgba(245,158,11,0.18);
}
.dsb-dot.ok {
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34,197,94,0.18);
}
.dsb-dot.bad {
  background: #ef4444;
  box-shadow: 0 0 0 3px rgba(239,68,68,0.18);
}
.dsb-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dsb-amount {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.dsb-currency {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
}
.dsb-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.dsb-refresh:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dsb-refresh:active {
  transform: rotate(90deg);
  transition: transform 120ms ease;
}
.dsb-detail {
  max-width: 240px;
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #6b7280);
  background: var(--dsw-alias-bg-overlay, rgba(255,255,255,0.92));
  border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.14));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.14);
  white-space: normal;
  overflow-wrap: anywhere;
}
@media (prefers-reduced-motion: reduce) {
  .dsb-card, .dsb-refresh { transition: none !important; }
}
`

function adoptStyles() {
  const existing = document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
  if (existing !== null) {
    return () => existing.remove()
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-deepseek-balance'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => tag.remove()
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

function loadPosition() {
  const fallback = { x: Math.max(12, window.innerWidth - 210), y: Math.max(12, window.innerHeight - 90) }
  try {
    const raw = window.localStorage.getItem(POS_STORAGE_KEY)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return fallback
    const x = typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : fallback.x
    const y = typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : fallback.y
    return { x, y }
  } catch {
    return fallback
  }
}

function savePosition(pos) {
  try {
    window.localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(pos))
  } catch {
    // private mode / storage full: keep in-memory only
  }
}

function BalanceWidget() {
  const rootRef = useRef(null)
  const [pos, setPos] = useState(loadPosition)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(null)

  const [data, setData] = useState(null)
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(BALANCE_PATH, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      })
      const payload = await response.json()
      if (payload !== null && typeof payload === 'object' && payload.ok === true) {
        setData(payload)
        setStatus('ready')
        setError('')
        setUpdatedAt(new Date())
      } else {
        setData(null)
        setStatus('error')
        setError((payload && typeof payload.message === 'string' ? payload.message : '余额获取失败'))
      }
    } catch (err) {
      setData(null)
      setStatus('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    const onResize = () => {
      setPos((prev) => {
        const rect = rootRef.current?.getBoundingClientRect()
        const w = rect?.width ?? 180
        const h = rect?.height ?? 40
        return {
          x: clamp(prev.x, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerWidth - w - EDGE_MARGIN)),
          y: clamp(prev.y, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerHeight - h - EDGE_MARGIN)),
        }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  const clampToViewport = (x, y) => {
    const rect = rootRef.current?.getBoundingClientRect()
    const w = rect?.width ?? 180
    const h = rect?.height ?? 40
    return {
      x: clamp(x, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerWidth - w - EDGE_MARGIN)),
      y: clamp(y, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerHeight - h - EDGE_MARGIN)),
    }
  }

  const onPointerDown = (event) => {
    if (event.target.closest && event.target.closest('.dsb-refresh')) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
    }
    setDragging(true)
    try {
      rootRef.current?.setPointerCapture(event.pointerId)
    } catch {
      // ignore capture failure
    }
  }

  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const next = clampToViewport(
      drag.originX + (event.clientX - drag.startX),
      drag.originY + (event.clientY - drag.startY),
    )
    setPos(next)
  }

  const endDrag = (event) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    try {
      rootRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect) {
      const candidates = [
        { key: 'left', dist: rect.left },
        { key: 'right', dist: window.innerWidth - rect.right },
        { key: 'top', dist: rect.top },
        { key: 'bottom', dist: window.innerHeight - rect.bottom },
      ]
      const best = candidates.reduce((a, b) => (b.dist < a.dist ? b : a))
      if (best.dist <= SNAP_THRESHOLD) {
        let nextX = rect.left
        let nextY = rect.top
        if (best.key === 'left') nextX = EDGE_MARGIN
        if (best.key === 'right') nextX = window.innerWidth - rect.width - EDGE_MARGIN
        if (best.key === 'top') nextY = EDGE_MARGIN
        if (best.key === 'bottom') nextY = window.innerHeight - rect.height - EDGE_MARGIN
        const snapped = clampToViewport(nextX, nextY)
        setPos(snapped)
        savePosition(snapped)
      } else {
        savePosition({ x: rect.left, y: rect.top })
      }
    }
    dragRef.current = null
    setDragging(false)
  }

  const info = data && Array.isArray(data.balanceInfos) && data.balanceInfos.length > 0 ? data.balanceInfos[0] : null
  const amount = status === 'ready' && info ? info.totalBalance : '--'
  const currency = status === 'ready' && info ? info.currency : ''
  const available = status === 'ready' ? data.isAvailable : null
  const dotClass = status === 'ready' ? (available ? 'ok' : 'bad') : status === 'error' ? 'bad' : ''

  const detailText =
    status === 'error'
      ? error || '余额获取失败'
      : status === 'loading'
        ? '正在读取余额…'
        : `${currency} 余额：${amount}\n赠送：${info?.grantedBalance ?? '--'} ${currency}\n充值：${info?.toppedUpBalance ?? '--'} ${currency}`

  return createElement(
    'div',
    {
      ref: rootRef,
      className: 'dsb-root' + (dragging ? ' dsb-dragging' : ''),
      style: { left: pos.x + 'px', top: pos.y + 'px' },
      onPointerDown: onPointerDown,
      onPointerMove: onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      title: updatedAt ? `更新于 ${updatedAt.toLocaleTimeString()}\n${detailText}` : detailText,
      'aria-label': 'DeepSeek 账户余额挂件',
    },
    createElement(
      'div',
      { className: 'dsb-card' },
      createElement('span', { className: 'dsb-dot' + (dotClass ? ' ' + dotClass : '') }),
      createElement('span', { className: 'dsb-label' }, '余额'),
      createElement('span', { className: 'dsb-amount' }, amount),
      currency !== '' && createElement('span', { className: 'dsb-currency' }, currency),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsb-refresh',
          title: '刷新余额',
          onPointerDown: (event) => event.stopPropagation(),
          onClick: () => void refresh(),
        },
        '↻',
      ),
    ),
  )
}

function apply(ctx) {
  const removeStyle = adoptStyles()
  ctx.effect(() => () => removeStyle())

  const slots = ctx.slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

  slots.inject('shell.overlay', () =>
    slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-deepseek-balance',
        order: 90,
        label: 'DeepSeek 余额',
      },
      () => createElement(BalanceWidget),
    ),
  )
}

module.exports = { apply, inject: ['slots'] }
return module.exports;
} });
