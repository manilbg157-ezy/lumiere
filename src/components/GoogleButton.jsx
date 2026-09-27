import React, { useEffect, useState } from 'react'
import { googleAvailable, startGoogleSignIn, CAPTCHA_PROMPT } from '../lib/auth.js'
import { IS_APP } from '../lib/apiBase.js'
import styles from './GoogleButton.module.css'

// "Continue with Google" — the only sign-in button that leaves the page.
//
// It is a plain navigation to the server's /api/auth/google/start, which is what
// keeps the credential out of JavaScript: Google hands the server an ID token,
// the server verifies it and sets its own HttpOnly session cookie. A popup or a
// JavaScript ID token would put a credential somewhere script could read it.
//
// Rendered only when the server says it has Google credentials — an unconfigured
// deployment shows the ordinary form and nothing else, rather than a button that
// leads to a 501.

function GoogleGlyph() {
  // Google's four-colour mark. Its brand colours are deliberately not themed to
  // Lumiere's palette: the mark identifies Google, and recolouring it is both
  // confusing and against their branding rules.
  return (
    <svg className={styles.glyph} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

// `mode` is passed straight through to the server's flow: 'signup' marks the
// round trip as a request to make an account, so an email that already has a
// password account is refused (and sent to the sign-in form) instead of being
// linked up and entered. Defaults to an ordinary sign-in.
export default function GoogleButton({ label = 'Continue with Google', mode = 'login', captchaRequired = false, captchaToken = null }) {
  const [available, setAvailable] = useState(false)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    let alive = true
    googleAvailable().then(ok => { if (alive) setAvailable(ok) })
    return () => { alive = false }
  }, [])

  // The in-app build runs from a local origin and authenticates with a bearer
  // token, not a cookie, so this round trip could not complete inside it. The
  // button is hidden there rather than broken.
  if (IS_APP || !available) return null

  // Google leaves the page as a navigation, so it cannot be gated by disabling
  // the submit button — the token has to be verified before the redirect. When
  // the CAPTCHA is on and unresolved, clicking here says so instead of leaving.
  function go() {
    if (captchaRequired && !captchaToken) {
      setNotice(CAPTCHA_PROMPT)
      return
    }
    setNotice(null)
    startGoogleSignIn(undefined, mode, captchaToken)
  }

  return (
    <>
      <p className={styles.or}><span>or</span></p>
      <button type="button" className={styles.google} onClick={go}>
        <GoogleGlyph />
        <span>{label}</span>
      </button>
      {notice && <p className={styles.notice} role="alert">{notice}</p>}
    </>
  )
}
