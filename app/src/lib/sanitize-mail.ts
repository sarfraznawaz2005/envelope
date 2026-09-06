/**
 * Turns raw HTML email into something safe to show: strips scripts/forms/
 * event handlers, optionally strips <style>, blocks remote images unless
 * allowed, and forces every link to open in a new tab.
 */
import DOMPurify from 'dompurify'

export interface SanitizeOptions {
  allowStyleTags: boolean
  allowImages: boolean
}

export interface SanitizeResult {
  html: string
  hadBlockedImages: boolean
}

const REMOTE_SRC = /^(https?:)?\/\//i
// Matches a CSS url(...) pointing at http(s) or a protocol-relative address — used to catch
// tracking pixels hidden in `style="background:url(...)"` or a `<style>` block's `@import`/
// `background` rules, which "block remote images" would otherwise miss entirely.
const CSS_URL_REMOTE = /url\(\s*['"]?(?:https?:)?\/\//i

/** Blocked attributes are stashed under this prefix so "Load images" can restore them later. */
const BLOCKED_ATTR_PREFIX = 'data-blocked-'

export function sanitizeMailHtml(rawHtml: string, opts: SanitizeOptions): SanitizeResult {
  let hadBlockedImages = false

  const blockAttrIfRemote = (node: Element, attr: string) => {
    const val = node.getAttribute(attr)
    if (val && REMOTE_SRC.test(val.trim())) {
      node.setAttribute(BLOCKED_ATTR_PREFIX + attr, val)
      node.removeAttribute(attr)
      hadBlockedImages = true
    }
  }

  const hook = (node: Element) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (opts.allowImages) return

    // <img>/<source> can load remotely via src OR srcset; <video poster> and any element's
    // CSS `background` attribute are the same trick under a different name.
    if (node.tagName === 'IMG' || node.tagName === 'SOURCE') {
      blockAttrIfRemote(node, 'src')
      blockAttrIfRemote(node, 'srcset')
    }
    if (node.tagName === 'VIDEO') blockAttrIfRemote(node, 'poster')
    blockAttrIfRemote(node, 'background')

    const style = node.getAttribute('style')
    if (style && CSS_URL_REMOTE.test(style)) {
      node.setAttribute(BLOCKED_ATTR_PREFIX + 'style', style)
      node.removeAttribute('style')
      hadBlockedImages = true
    }

    if (node.tagName === 'STYLE' && node.textContent && CSS_URL_REMOTE.test(node.textContent)) {
      node.setAttribute(BLOCKED_ATTR_PREFIX + 'css', node.textContent)
      node.textContent = ''
      hadBlockedImages = true
    }
  }
  DOMPurify.addHook('afterSanitizeAttributes', hook)

  const FORBID_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link']
  if (!opts.allowStyleTags) FORBID_TAGS.push('style')

  let html: string
  try {
    html = DOMPurify.sanitize(rawHtml, { FORBID_TAGS, ALLOW_DATA_ATTR: true })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
  return { html, hadBlockedImages }
}

/** Re-enable everything this sanitize pass had blocked (used by "Load images"). */
export function unblockImages(container: HTMLElement) {
  for (const el of container.querySelectorAll<HTMLElement>('[data-blocked-src]')) {
    el.setAttribute('src', el.getAttribute('data-blocked-src') ?? '')
    el.removeAttribute('data-blocked-src')
  }
  for (const el of container.querySelectorAll<HTMLElement>('[data-blocked-srcset]')) {
    el.setAttribute('srcset', el.getAttribute('data-blocked-srcset') ?? '')
    el.removeAttribute('data-blocked-srcset')
  }
  for (const el of container.querySelectorAll<HTMLElement>('[data-blocked-poster]')) {
    el.setAttribute('poster', el.getAttribute('data-blocked-poster') ?? '')
    el.removeAttribute('data-blocked-poster')
  }
  for (const el of container.querySelectorAll<HTMLElement>('[data-blocked-background]')) {
    el.setAttribute('background', el.getAttribute('data-blocked-background') ?? '')
    el.removeAttribute('data-blocked-background')
  }
  for (const el of container.querySelectorAll<HTMLElement>('[data-blocked-style]')) {
    el.setAttribute('style', el.getAttribute('data-blocked-style') ?? '')
    el.removeAttribute('data-blocked-style')
  }
  for (const el of container.querySelectorAll<HTMLElement>('[data-blocked-css]')) {
    el.textContent = el.getAttribute('data-blocked-css') ?? ''
    el.removeAttribute('data-blocked-css')
  }
}
