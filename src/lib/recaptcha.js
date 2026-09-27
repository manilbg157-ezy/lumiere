// Loading Google's reCAPTCHA runtime, and the two measurements the widget needs
// before it can be rendered.
//
// This is deliberately not a component: it is the part that failed in the field,
// it is plain DOM code, and it can therefore be driven by a test without a
// browser (see test/recaptcha.test.mjs).
//
// The load is not judged by the script tag's own `onload`. api.js defines a
// `grecaptcha` stub first and installs `render` only once its runtime has
// arrived, so an `onload` that fires in between is a false start — and treating
// it as a failure is what left the first page of a visit showing "could not load
// CAPTCHA" while a later page worked, because by then the runtime was warm.
// Waiting for the runtime itself, with a deadline, is what removes the coin flip.

export const SCRIPT_SRC = 'https://www.google.com/recaptcha/api.js?render=explicit'

const SCRIPT_ID = 'lumiere-recaptcha'
const SCRIPT_TIMEOUT_MS = 15000
const PAINT_TIMEOUT_MS = 8000
const POLL_MS = 120

let scriptPromise = null

function waitForRuntime(deadline, pollMs) {
  return new Promise(resolve => {
    const tick = () => {
      if (window.grecaptcha?.render) { resolve(true); return }
      if (Date.now() > deadline) { resolve(false); return }
      setTimeout(tick, pollMs)
    }
    tick()
  })
}

/**
 * Resolves with `window.grecaptcha` once its widget API is usable.
 *
 * The script tag is added at most once, concurrent callers share one attempt, and
 * a failed attempt is never remembered — so the caller's retry starts a fresh
 * request rather than replaying a dead one.
 */
export async function loadCaptchaScript({ timeoutMs = SCRIPT_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
  if (typeof window === 'undefined') throw new Error('no window')
  if (window.grecaptcha?.render) return window.grecaptcha

  if (!scriptPromise) {
    scriptPromise = (async () => {
      const deadline = Date.now() + timeoutMs
      let el = document.getElementById(SCRIPT_ID)
      if (!el) {
        el = document.createElement('script')
        el.id = SCRIPT_ID
        el.src = SCRIPT_SRC
        el.async = true
        document.head.appendChild(el)
      }

      if (!(await waitForRuntime(deadline, pollMs))) {
        // Drop the tag, so a retry starts a clean request instead of waiting on
        // one that may already be dead in the network stack.
        try { el.remove() } catch { /* ignore */ }
        throw new Error('CAPTCHA did not load')
      }

      // `ready` is the documented "the widget API is usable now" signal, capped so
      // a silent runtime cannot hang the form either.
      await Promise.race([
        new Promise(resolve => window.grecaptcha.ready(resolve)),
        new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
      ])
      if (!window.grecaptcha?.render) throw new Error('CAPTCHA did not load')
      return window.grecaptcha
    })()
  }

  try {
    return await scriptPromise
  } catch (err) {
    scriptPromise = null
    throw err
  }
}

/** Warm the script without caring about the outcome (a page that knows one is coming). */
export function preloadCaptcha() {
  return loadCaptchaScript().catch(() => null)
}

/**
 * reCAPTCHA measures the container to size its iframe, so an element with no
 * width yet (mid-animation, or inside a hidden ancestor) renders nothing visible.
 * Resolves either way: this is a best effort, not a gate.
 */
export function waitForWidth(el, { timeoutMs = 1000, pollMs = 60 } = {}) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      let width = 0
      try { width = el.getBoundingClientRect().width } catch { /* ignore */ }
      if (width > 0 || Date.now() > deadline) { resolve(); return }
      // A timer rather than rAF: this has to settle in a tab that is not painting.
      setTimeout(tick, pollMs)
    }
    tick()
  })
}

/**
 * A widget ID is not proof that anything was painted. If `render` fails quietly
 * the container stays empty and no callback ever fires — which the visitor sees
 * as a CAPTCHA that "does not load". Watch for the iframe instead of trusting it.
 */
export function waitForPaint(el, { timeoutMs = PAINT_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (el.querySelector('iframe')) { resolve(true); return }
      if (Date.now() > deadline) { resolve(false); return }
      setTimeout(tick, pollMs)
    }
    tick()
  })
}
