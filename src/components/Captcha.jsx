import React, { useEffect, useRef, useState } from 'react'
import { loadCaptchaScript, waitForPaint, waitForWidth } from '../lib/recaptcha.js'
import styles from './Captcha.module.css'

// The Google reCAPTCHA v2 checkbox ("I'm not a robot"), rendered explicitly
// rather than through reCAPTCHA's automatic scan of `.g-recaptcha` elements.
//
// Explicit rendering is the documented way to make this work in a single-page
// app, but it comes with rules of its own, and this component exists to keep all
// of them in one place:
//
//   * ONE render per container. `grecaptcha.render()` throws "reCAPTCHA has
//     already been rendered in this element" if it is called twice on the same
//     element, and React will happily hand the same DOM node to a second mount.
//   * Reset, never remount, to get a fresh challenge: `grecaptcha.reset(id)`.
//     Destroying the container while Google's runtime still holds the widget is
//     what leaves the empty box and the token that never arrives — the widget the
//     visitor is looking at stops being the one that calls back. That is why the
//     pages pass a reset signal rather than a React `key`.
//   * Every call is addressed by widget ID. Calls made without one are about the
//     *first* widget on the page, which is how a second CAPTCHA in an app ends up
//     silently answering for the wrong one.
//   * Measure before rendering, and check that something actually painted: see
//     src/lib/recaptcha.js for both, and for the load itself.
//
// A token is single-use, so the page bumps `resetSignal` after every attempt and
// the widget is reset in place — same container, same widget ID.
//
// Only mounted when the server reported a site key, so an unconfigured deployment
// never loads Google's script at all.

export default function Captcha({ siteKey, resetSignal = 0, onToken, onExpire }) {
  const boxRef = useRef(null)
  const widgetRef = useRef(null)
  // Bumped by the retry button. It is a dependency of the render effect on
  // purpose: a retry really does start the widget over from an empty container.
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState('loading')
  // Callbacks are read through refs so a re-render never re-renders the widget.
  const tokenCb = useRef(onToken)
  const expireCb = useRef(onExpire)
  tokenCb.current = onToken
  expireCb.current = onExpire

  useEffect(() => {
    let alive = true
    const box = boxRef.current
    if (!box) return undefined

    // A node React has reused could already host a widget from an earlier mount.
    // render() throws on an occupied element, so always start from empty.
    box.replaceChildren()
    widgetRef.current = null
    setState('loading')

    const fail = () => { if (alive) setState('failed') }

    loadCaptchaScript()
      .then(async grecaptcha => {
        if (!alive) return
        await waitForWidth(box)
        if (!alive) return

        let id
        try {
          id = grecaptcha.render(box, {
            sitekey: siteKey,
            theme: 'dark',
            // The normal widget is ~304px wide and would overflow a narrow
            // phone's auth card; compact (164x144) fits where that would not.
            size: box.getBoundingClientRect().width < 380 ? 'compact' : 'normal',
            callback: token => tokenCb.current?.(token),
            'expired-callback': () => expireCb.current?.(),
            'error-callback': fail,
          })
        } catch {
          // "Already rendered", an unusable key, or a blocked script. The retry
          // button re-runs this effect from a cleaned container.
          fail()
          return
        }

        if (!alive) {
          // Unmounted while rendering: don't leave the widget behind.
          try { grecaptcha.reset(id) } catch { /* ignore */ }
          return
        }
        widgetRef.current = id

        if (await waitForPaint(box)) {
          if (alive) setState('ready')
        } else {
          fail()
        }
      })
      .catch(fail)

    return () => {
      alive = false
      // Never leave a live widget inside a node React is discarding: that orphan
      // is exactly what makes the *next* CAPTCHA in the app answer for nothing.
      const id = widgetRef.current
      widgetRef.current = null
      if (id != null && window.grecaptcha?.reset) {
        try { window.grecaptcha.reset(id) } catch { /* ignore */ }
      }
      try { box.replaceChildren() } catch { /* ignore */ }
    }
  }, [siteKey, attempt])

  // A spent or expired token needs a new challenge, and reCAPTCHA only issues one
  // after a reset. Resetting in place keeps the same container and widget ID; a
  // remount would orphan the widget and leave the form holding no token.
  useEffect(() => {
    if (!resetSignal) return
    const id = widgetRef.current
    if (id == null) return
    try { window.grecaptcha?.reset(id) } catch { /* ignore */ }
  }, [resetSignal])

  return (
    <div className={styles.wrap} data-captcha={state}>
      <div ref={boxRef} />
      {state === 'loading' && <p className={styles.loading}>Loading check…</p>}
      {state === 'failed' && (
        <div className={styles.failed} role="alert">
          <p className={styles.failedText}>Could not load CAPTCHA. Check your connection and try again.</p>
          <button
            type="button"
            className={styles.retry}
            onClick={() => setAttempt(n => n + 1)}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
