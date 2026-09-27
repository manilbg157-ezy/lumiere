import React, { useState, useEffect } from 'react'
import { login, setSession, getKeepLoggedIn, setKeepLoggedIn, takeGoogleError, ACCOUNT_EXISTS_NOTICE, getCaptchaConfig, CAPTCHA_PROMPT } from '../lib/auth.js'
import { currentState } from '../lib/router.js'
import AuthShell from '../components/AuthShell.jsx'
import GoogleButton from '../components/GoogleButton.jsx'
import Captcha from '../components/Captcha.jsx'
import { preloadCaptcha } from '../lib/recaptcha.js'
import Field from '../components/ui/Field.jsx'
import Button from '../components/ui/Button.jsx'
import Link from '../components/Link.jsx'
import styles from './Login.module.css'

// Its own page (/login). Signing up lives at /signup — they are separate URLs
// that link to each other rather than one page with a mode toggle.
export default function Login({ onLogin, onBack }) {
  // Set when the signup form met an address that already has an account and sent
  // the visitor here: the address comes with them so it does not have to be
  // typed again, and the reason is spelled out rather than left as a blank form.
  const [sentFromSignup] = useState(() => {
    const state = currentState()
    if (state?.notice !== 'exists') return null
    return {
      email: typeof state.email === 'string' ? state.email : '',
      notice: ACCOUNT_EXISTS_NOTICE,
    }
  })
  const [email, setEmail] = useState(() => sentFromSignup?.email || '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // Remembered on the device, so the next sign-in starts with the same answer.
  const [keep, setKeep] = useState(() => getKeepLoggedIn())
  // Set when a Google round trip came back with a problem (?google=…). Read once,
  // and read out of the URL, so a refresh does not show it again.
  const [googleError] = useState(() => takeGoogleError())
  // reCAPTCHA, when the deployment has it configured. `captchaKey` is bumped
  // after every attempt and resets the existing widget in place, because a token
  // is single-use — the widget is never torn down and re-rendered.
  const [captcha, setCaptcha] = useState({ enabled: false, siteKey: null })
  const [captchaToken, setCaptchaToken] = useState(null)
  const [captchaKey, setCaptchaKey] = useState(0)

  useEffect(() => {
    let alive = true
    getCaptchaConfig().then(cfg => {
      if (!alive) return
      setCaptcha(cfg)
      // Start Google's script on the way in, so the widget is painted by the
      // time the visitor looks at it rather than racing the first render.
      if (cfg.enabled) preloadCaptcha()
    })
    return () => { alive = false }
  }, [])

  function toggleKeep(value) {
    setKeep(value)
    setKeepLoggedIn(value)
  }

  async function submit(e) {
    e.preventDefault()
    setError(null)
    // The token comes from a widget the visitor has to touch; refuse here, and
    // say why, rather than sending a request the server will reject anyway.
    if (captcha.enabled && !captchaToken) {
      setError(CAPTCHA_PROMPT)
      return
    }
    setBusy(true)
    try {
      const mail = await login(email, password, { keepLoggedIn: keep, captchaToken })
      setSession(mail)
      onLogin(mail)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
      // A token is spent by the attempt, pass or fail — fetch a fresh challenge
      // so the next press is not refused for a stale one.
      if (captcha.enabled) { setCaptchaToken(null); setCaptchaKey(k => k + 1) }
    }
  }

  return (
    <AuthShell
      title="Sign in to Lumiere"
      subtitle="Start streaming in seconds"
      error={error || googleError || sentFromSignup?.notice}
      note="Accounts are stored on the app's host machine."
      onBack={onBack}
      footer={(
        <p className={styles.switch}>
          New to Lumiere? <Link to="/signup">Create an account</Link>
        </p>
      )}
    >
      <form className={styles.form} onSubmit={submit}>
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          inputMode="email"
          autoFocus
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          minLength={8}
        />
        <label className={styles.keep}>
          <input
            type="checkbox"
            checked={keep}
            onChange={event => toggleKeep(event.target.checked)}
          />
          <span>Keep me logged in</span>
        </label>

        {captcha.enabled && captcha.siteKey && (
          <Captcha
            siteKey={captcha.siteKey}
            resetSignal={captchaKey}
            onToken={setCaptchaToken}
            onExpire={() => setCaptchaToken(null)}
          />
        )}

        <Button type="submit" size="lg" block disabled={busy}>
          {busy ? 'Please wait…' : 'Sign in'}
        </Button>

        <GoogleButton captchaRequired={captcha.enabled} captchaToken={captchaToken} />

        <p className={styles.forgot}>
          <Link to="/forgot">Forgot your password?</Link>
        </p>

        <p className={styles.legal}>
          By signing in you agree to our <Link to="/terms">Terms of Service</Link> and{' '}
          <Link to="/privacy">Privacy Policy</Link>.
        </p>
      </form>
    </AuthShell>
  )
}
