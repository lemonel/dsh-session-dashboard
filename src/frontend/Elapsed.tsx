import { useEffect, useState } from 'react'

/** 00:00 below one hour, h:mm:ss above it; negative clocks clamp to zero. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** An absolute clock: every tick, and every remount after a page switch, recomputes
 *  `now - startedAt` from the durable round start instead of restarting a counter. */
export function RunningElapsed({ startedAt, text, title }: { startedAt: number; text: (time: string) => string; title?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return <span className="sd-elapsed" title={title}>{text(formatElapsed(now - startedAt))}</span>
}
