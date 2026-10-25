import type { ReactNode } from 'react'

/** Where an overlay is mounted. The host provides react-dom as a platform seed, so
 *  the real entry installs `createPortal` once; unit tests that render components
 *  without a plugin entry can inject the same shape after their DOM exists. */
export type PortalRenderer = (children: ReactNode, container: Element) => ReactNode
let renderer: PortalRenderer | null = null
export function setPortalRenderer(next: PortalRenderer | null): void { renderer = next }
export function getPortalRenderer(): PortalRenderer | null { return renderer }
/** Plugin dispose clears the singleton so a reload starts from a clean module. */
export function resetPortalRenderer(): void { renderer = null }
