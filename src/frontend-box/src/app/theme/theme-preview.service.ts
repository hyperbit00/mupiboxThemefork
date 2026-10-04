import { Injectable } from '@angular/core'
import { KmThemeService } from './km-theme.service'

/**
 * The live preview of the admin interface's theme editor (MuPiBox settings -> Theme -> "Customize this theme").
 *
 * The admin page shows this display in a frame (800x480) and talks to it by postMessage:
 *  - mupibox-theme-css      { themeId, masterCss?, css }   the theme as it is being edited, before anything is saved
 *  - mupibox-theme-pick     { on }                         edit mode: a tap selects an element, dragging moves it, the
 *                                                          corner handle resizes it (nothing is started on the display)
 *  - mupibox-theme-relative { dir: 'up' | 'down' }         select the parent / the child towards the tapped point
 *  - mupibox-theme-refresh                                 measure the selected element again (after a change)
 * and gets back: mupibox-theme-ready, -picked, -moved, -resized.
 *
 * Only in a frame, only from the page that shows it, and only from the same host (the admin interface, port 80).
 * On the display itself nothing of this is active (no listener is set up).
 */
@Injectable({ providedIn: 'root' })
export class ThemePreviewService {
  private parentOrigin = ''
  private pickOn = false
  private selected?: HTMLElement
  private leaf?: HTMLElement
  private outline?: HTMLElement
  private handle?: HTMLElement
  private drag?: {
    mode: 'move' | 'resize'
    x: number
    y: number
    tx: number
    ty: number
    w: number
    h: number
    moved: boolean
    el: HTMLElement
  }
  private readonly captured = ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'contextmenu']

  public constructor(private km: KmThemeService) {
    if (window.parent === window) return
    try {
      const ref = new URL(document.referrer)
      if (ref.hostname === location.hostname) this.parentOrigin = ref.origin
    } catch {
      // no referrer: the origin is taken from the first message
    }
    window.addEventListener('message', (event) => this.onMessage(event))
    window.addEventListener('load', () => this.post({ type: 'mupibox-theme-ready' }))
    window.setTimeout(() => this.post({ type: 'mupibox-theme-ready' }), 800)
  }

  private post(data: Record<string, unknown>): void {
    if (this.parentOrigin) window.parent.postMessage(data, this.parentOrigin)
  }

  private onMessage(event: MessageEvent): void {
    if (event.source !== window.parent || event.source === window) return
    try {
      if (new URL(event.origin).hostname !== location.hostname) return
    } catch {
      return
    }
    this.parentOrigin = event.origin
    const data = event.data as { type?: string; [key: string]: unknown } | undefined
    switch (data?.type) {
      case 'mupibox-theme-css':
        this.applyCss(data)
        break
      case 'mupibox-theme-pick':
        this.setPick(data.on === true)
        break
      case 'mupibox-theme-relative':
        this.selectRelative(data.dir === 'up' ? 'up' : 'down')
        break
      case 'mupibox-theme-refresh':
        this.placeOutline()
        break
    }
  }

  // ---------------------------------------------------------------- the theme's css

  private styleEl(id: string): HTMLStyleElement {
    let el = document.getElementById(id) as HTMLStyleElement | null
    if (!el) {
      el = document.createElement('style')
      el.id = id
      document.head.appendChild(el)
    }
    return el
  }

  private applyCss(data: { [key: string]: unknown }): void {
    const masterCss = typeof data.masterCss === 'string' ? data.masterCss : undefined
    const css = typeof data.css === 'string' ? data.css : ''
    if (masterCss !== undefined) {
      // the theme being edited instead of the one in use: its master css replaces the linked stylesheets
      for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href*="active_theme"]'))) {
        link.disabled = true
      }
      this.styleEl('mupi-theme-base').textContent = masterCss
    }
    if (typeof data.themeId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.themeId)) this.km.previewTheme(data.themeId)
    this.styleEl('mupi-theme-live').textContent = css
    // the live styles of a drag that has ended are replaced by the css now
    if (this.selected && !this.drag) {
      this.selected.style.removeProperty('translate')
      this.selected.style.removeProperty('width')
      this.selected.style.removeProperty('height')
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => this.placeOutline()))
  }

  // ---------------------------------------------------------------- edit mode

  private readonly block = (event: Event): void => {
    const target = event.target as Element | null
    if (target?.closest?.('#mupi-theme-handle')) return
    event.stopImmediatePropagation()
    if (event.cancelable) event.preventDefault()
  }

  private setPick(on: boolean): void {
    if (on === this.pickOn) return
    this.pickOn = on
    if (on) {
      // before everything else in the page: nothing is started on the display while editing. The editor's own
      // handlers are added first (listeners of one target run in the order they were added), then the blocker.
      window.addEventListener('pointerdown', this.onDown, { capture: true, passive: false })
      window.addEventListener('pointermove', this.onMove, { capture: true, passive: false })
      window.addEventListener('pointerup', this.onUp, { capture: true, passive: false })
      for (const type of this.captured) window.addEventListener(type, this.block, { capture: true, passive: false })
      window.addEventListener('scroll', this.onScroll, { capture: true, passive: true })
      document.documentElement.style.setProperty('touch-action', 'none')
    } else {
      for (const type of this.captured) window.removeEventListener(type, this.block, { capture: true })
      window.removeEventListener('pointerdown', this.onDown, { capture: true })
      window.removeEventListener('pointermove', this.onMove, { capture: true })
      window.removeEventListener('pointerup', this.onUp, { capture: true })
      window.removeEventListener('scroll', this.onScroll, { capture: true })
      document.documentElement.style.removeProperty('touch-action')
      this.select(undefined)
    }
  }

  private readonly onScroll = (): void => {
    this.placeOutline()
  }

  private readonly onDown = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null
    if (!target || !(target instanceof HTMLElement)) return
    if (target.id === 'mupi-theme-handle' && this.selected) {
      event.stopImmediatePropagation()
      event.preventDefault()
      const r = this.selected.getBoundingClientRect()
      this.drag = { mode: 'resize', x: event.clientX, y: event.clientY, tx: 0, ty: 0, w: r.width, h: r.height, moved: false, el: this.selected }
      return
    }
    if (target.id === 'mupi-theme-outline') return
    // a tap on the selected element (or something in it) moves it; any other element is selected first
    if (!this.selected || !this.selected.contains(target)) {
      this.leaf = target
      this.select(target)
    }
    const el = this.selected
    if (!el) return
    const [tx, ty] = this.translateOf(el)
    this.drag = { mode: 'move', x: event.clientX, y: event.clientY, tx, ty, w: 0, h: 0, moved: false, el }
  }

  private readonly onMove = (event: PointerEvent): void => {
    const d = this.drag
    if (!d) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    if (d.mode === 'move') {
      d.el.style.setProperty('translate', `${Math.round(d.tx + dx)}px ${Math.round(d.ty + dy)}px`, 'important')
    } else {
      d.el.style.setProperty('width', `${Math.max(16, Math.round(d.w + dx))}px`, 'important')
      d.el.style.setProperty('height', `${Math.max(16, Math.round(d.h + dy))}px`, 'important')
    }
    this.placeOutline()
  }

  private readonly onUp = (): void => {
    const d = this.drag
    this.drag = undefined
    if (!d) return
    if (!d.moved) {
      if (d.mode === 'move') this.reportPick()
      return
    }
    if (d.mode === 'move') {
      this.post({ type: 'mupibox-theme-moved', translate: d.el.style.getPropertyValue('translate') })
    } else {
      this.post({ type: 'mupibox-theme-resized', width: d.el.style.getPropertyValue('width'), height: d.el.style.getPropertyValue('height') })
    }
    // the inline values stay until the editor has sent the css that contains them (applyCss), or for 2 s at most
    const el = d.el
    window.setTimeout(() => {
      el.style.removeProperty('translate')
      el.style.removeProperty('width')
      el.style.removeProperty('height')
      this.placeOutline()
    }, 2000)
  }

  private translateOf(el: HTMLElement): [number, number] {
    const value = getComputedStyle(el).translate
    if (!value || value === 'none') return [0, 0]
    const [x, y] = value.split(/\s+/)
    return [Number.parseFloat(x) || 0, Number.parseFloat(y ?? '0') || 0]
  }

  // ---------------------------------------------------------------- selected element

  private select(el: HTMLElement | undefined): void {
    this.selected = el
    if (!el) {
      this.outline?.remove()
      this.handle?.remove()
      this.outline = undefined
      this.handle = undefined
      return
    }
    if (!this.outline) {
      this.outline = document.createElement('div')
      this.outline.id = 'mupi-theme-outline'
      this.outline.style.cssText =
        'position:fixed;pointer-events:none;z-index:2147483600;border:2px dashed #ff3d71;box-sizing:border-box;border-radius:3px;background:rgba(255,61,113,.08)'
      document.body.appendChild(this.outline)
      this.handle = document.createElement('div')
      this.handle.id = 'mupi-theme-handle'
      this.handle.style.cssText =
        'position:fixed;z-index:2147483601;width:22px;height:22px;border-radius:50%;background:#ff3d71;border:3px solid #fff;box-sizing:border-box;cursor:nwse-resize;touch-action:none'
      document.body.appendChild(this.handle)
    }
    this.placeOutline()
    this.reportPick()
  }

  private placeOutline(): void {
    const el = this.selected
    if (!el || !this.outline || !this.handle) return
    if (!el.isConnected) {
      this.select(undefined)
      return
    }
    const r = el.getBoundingClientRect()
    Object.assign(this.outline.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    const hx = Math.min(Math.max(r.right - 11, 0), window.innerWidth - 22)
    const hy = Math.min(Math.max(r.bottom - 11, 0), window.innerHeight - 22)
    Object.assign(this.handle.style, { left: `${hx}px`, top: `${hy}px` })
  }

  private selectRelative(dir: 'up' | 'down'): void {
    const el = this.selected
    if (!el) return
    if (dir === 'up') {
      const parent = el.parentElement
      if (parent && parent !== document.body && parent !== document.documentElement) this.select(parent)
      return
    }
    // towards the point that was tapped
    const leaf = this.leaf
    if (!leaf || leaf === el || !el.contains(leaf)) return
    let child: HTMLElement = leaf
    while (child.parentElement && child.parentElement !== el) child = child.parentElement
    this.select(child)
  }

  // ---------------------------------------------------------------- selectors

  private static readonly IGNORED_CLASS =
    /^(hydrated|md|ios|ion-activatable|ion-focusable|ion-focused|ion-activated|ion-page.*|ion-color.*|ng-.*|segment-button-.*|button-.*|in-toolbar.*|in-buttons|activated|focused|km-on|km-speaking|can-go-back|.*-hidden|.*-active|.*-checked|.*-disabled|.*-invisible)$/

  private token(el: Element): string {
    const classes = Array.from(el.classList)
      .filter((c) => !ThemePreviewService.IGNORED_CLASS.test(c) && /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(c))
      .slice(0, 2)
    return el.tagName.toLowerCase() + classes.map((c) => `.${c}`).join('')
  }

  private meaningful(token: string): boolean {
    return token.includes('.') || /^(ion|mupi|swiper)-/.test(token)
  }

  private count(selector: string): number {
    try {
      return document.querySelectorAll(selector).length
    } catch {
      return 0
    }
  }

  /** "all like this": the shortest class based selector (up to 4 levels), and "only this one": a path with :nth-child */
  private selectorsFor(el: HTMLElement): { all: { sel: string; count: number }; only: { sel: string; count: number } } {
    const skip = (e: Element | null) => !e || e === document.body || e === document.documentElement
    let sel = this.token(el)
    let cur: Element | null = el.parentElement
    for (let depth = 0; depth < 4 && !skip(cur); depth++) {
      const first = sel.split(' ')[0]
      if (this.meaningful(first) && this.count(sel) <= 40) break
      sel = `${this.token(cur as Element)} ${sel}`
      cur = (cur as Element).parentElement
    }
    const all = { sel, count: this.count(sel) }

    let path = ''
    let node: Element | null = el
    for (let depth = 0; depth < 10 && !skip(node); depth++) {
      const current = node as Element
      const parent: Element | null = current.parentElement
      const index = parent ? Array.from(parent.children).indexOf(current) + 1 : 1
      path = `${this.token(current)}:nth-child(${index})${path ? ` ${path}` : ''}`
      if (this.count(path) === 1) break
      node = parent
    }
    return { all, only: { sel: path, count: this.count(path) } }
  }

  private reportPick(): void {
    const el = this.selected
    if (!el) return
    const cs = getComputedStyle(el)
    const styles: Record<string, string> = {}
    for (const prop of [
      'background-color',
      'color',
      'border-top-left-radius',
      'border-top-width',
      'border-top-color',
      'border-top-style',
      'box-shadow',
      'width',
      'height',
      'font-size',
      'font-weight',
      'opacity',
      'translate',
      'text-align',
    ]) {
      styles[prop] = cs.getPropertyValue(prop)
    }
    const parent = el.parentElement
    this.post({
      type: 'mupibox-theme-picked',
      tag: el.tagName.toLowerCase(),
      label: this.token(el),
      selectors: this.selectorsFor(el),
      canUp: !!parent && parent !== document.body && parent !== document.documentElement,
      canDown: !!this.leaf && this.leaf !== el && el.contains(this.leaf),
      styles,
    })
  }
}
