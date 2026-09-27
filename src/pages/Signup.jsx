import React, { useState, useEffect } from 'react'
import { signup, setSession, getKeepLoggedIn, setKeepLoggedIn, getCaptchaConfig, CAPTCHA_PROMPT, GENDER_OPTIONS, dobProblem } from '../lib/auth.js'
import AuthShell from '../components/AuthShell.jsx'
import GoogleButton from '../components/GoogleButton.jsx'
import Captcha from '../components/Captcha.jsx'
import { preloadCaptcha } from '../lib/recaptcha.js'
import Field from '../components/ui/Field.jsx'
import Button from '../components/ui/Button.jsx'
import Link from '../components/Link.jsx'
import fieldStyles from '../components/ui/Field.module.css'
import styles from './Login.module.css'

// The date picker will not offer a future date; the age floor itself is checked
// in JS (and again on the server) so the visitor sees this app's own wording.
const TODAY = new Date().toISOString().slice(0, 10)

// Its own page (/signup), sharing the auth shell with /login.
//
// `onExists` is the one outcome that is not an error: the address already has an
// account, so there is nothing to create and nothing to explain beyond "sign in
// instead" — the page hands the visitor to /login with the address carried over,
// which is exactly where the Google button sends the same case.
export default function Signup({ onLogin, onBack, onExists }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [gender, setGender] = useState('')
  const [dob, setDob] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // Remembered on the device, so the next sign-in starts with the same answer.
  const [keep, setKeep] = useState(() => getKeepLoggedIn())
  // reCAPTCHA, when the deployment has it configured. A token is single-use, so
  // `captchaKey` resets the widget in place after every attempt — it is not a
  // React key, and the widget is never re-rendered into a new element.
  const [captcha, setCaptcha] = useState({ enabled: false, siteKey: null })
  const [captchaToken, setCaptchaToken] = useState(null)
  const [captchaKey, setCaptchaKey] = useState(0)

  useEffect(() => {
    let alive = true
    getCaptchaConfig().then(cfg => {
      if (!alive) return
      setCaptcha(cfg)
      // The signup form is the longer one; warming the script here is what keeps
      // the widget from arriving late on this page in particular.
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
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    if (!gender) {
      setError('Select a gender.')
      return
    }
    const dobIssue = dobProblem(dob)
    if (dobIssue) {
      setError(dobIssue)
      return
    }
    if (captcha.enabled && !captchaToken) {
      setError(CAPTCHA_PROMPT)
      return
    }
    setBusy(true)
    try {
      const mail = await signup(email, password, { keepLoggedIn: keep, captchaToken, gender, dob })
      setSession(mail)
      onLogin(mail)
    } catch (err) {
      if (err.status === 409 && onExists) { onExists(email); return }
      setError(err.message)
    } finally {
      setBusy(false)
      if (captcha.enabled) { setCaptchaToken(null); setCaptchaKey(k => k + 1) }
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="An account is only needed to play — browsing is open to everyone"
      error={error}
      note="Accounts are stored on the app's host machine."
      onBack={onBack}
      footer={(
        <p className={styles.switch}>
          Already have an account? <Link to="/login">Sign in</Link>
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
          autoComplete="new-password"
          hint="At least 8 characters."
          required
          minLength={8}
        />
        <Field
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          minLength={8}
        />
        <div className={styles.row}>
          <Field label="Gender">
            <select
              className={fieldStyles.input}
              value={gender}
              onChange={e => setGender(e.target.value)}
              required
            >
              <option value="">Select…</option>
              {GENDER_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
          <Field
            label="Date of birth"
            type="date"
            value={dob}
            onChange={e => setDob(e.target.value)}
            max={TODAY}
            autoComplete="bday"
            required
          />
        </div>

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
          {busy ? 'Please wait…' : 'Create account'}
        </Button>

        {/* The same round trip as /login, but flagged as a signup: if the address
            already has a password account, the server refuses to link it up and
            sends the visitor to /login to sign in with that password instead. */}
        <GoogleButton label="Sign up with Google" mode="signup" captchaRequired={captcha.enabled} captchaToken={captchaToken} />

        <p className={styles.legal}>
          By creating an account you agree to our <Link to="/terms">Terms of Service</Link> and{' '}
          <Link to="/privacy">Privacy Policy</Link>.
        </p>
      </form>
    </AuthShell>
  )
}
