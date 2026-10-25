import type { ReactNode, Ref } from 'react'

/** The native DSH page hosted in a frame. The floating preview windows and the
 *  official New Session overlay share this shell so both present the real page
 *  with the same size rules; only one of them is mounted at a time.
 *
 *  The frame caches a concrete Session URL, so switching between previewing and
 *  creating mounts a fresh frame: what is reused is this native window shell and
 *  its dimensions, never the same DOM node with the same Session. */
export function NativePageFrame({ src, title, ariaLabel, pending = false, frameRef, onLoad, children }: {
  src: string
  title: string
  ariaLabel?: string
  /** Hide the frame while the requested Session is not confirmed yet. */
  pending?: boolean
  frameRef?: Ref<HTMLIFrameElement>
  onLoad?: () => void
  /** Status copy overlaid on the frame while it boots or stalls. */
  children?: ReactNode
}) {
  return <div className="sd-native-page-wrap" data-preview-pending={pending ? 'true' : undefined}>
    {children}
    <iframe ref={frameRef} className="sd-native-page" src={src} title={title} aria-label={ariaLabel} onLoad={onLoad}/>
  </div>
}
