import React, { useEffect, useState } from 'react'
import { requestPasswordReset } from '../lib/auth.js'
import AuthShell from '../components/AuthShell.jsx'
import Field from '../components/ui/Field.jsx'
import Button from '../components/ui/Button.jsx'
import Link from '../components/Link.jsx'
import styles from './Login.module.css'

// Mirrors the server's per-address cooldown. Asking again inside it is answered
// the same way but sends nothing new, so a button that kept firing would just
// look broken on a slow inbox.
const RESEND_COOLDOWN_SEC = 60

// Its own page (/forgot). The server answers the same way for every address, so
// this screen never reveals whether an account exists — and now it never turns a
// throttle into an error either: the visitor is told to check their inbox, which
// is where the link from their first request already is.
export default function Forgot({ onBack }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(null)
  const [wait, setWait] = useState(0)

  // Depends on whether a countdown is running, not on its value — otherwise the
  // interval would be torn down and rebuilt every second.
  const counting = wait > 0
  useEffect(() => {
    if (!counting) return undefined
    const id = setInterval(() => setWait(s => (s <= 1 ? 0 : s - 1)), 1000)
    return () => clearInterval(id)
  }, [counting])

  async function send(e) {
    e?.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await requestPasswordReset(email)
      setSent(res?.message || 'If that address has an account, a reset link is on its way.')
      setWait(RESEND_COOLDOWN_SEC)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title={sent ? 'Check your inbox' : 'Forgot your password?'}
      subtitle={sent ? undefined : 'We’ll email you a link to choose a new one'}
      error={error}
      note={sent
        ? 'The link works once and expires in an hour. Nothing sent this? Check your spam folder, then try again.'
        : 'No account yet? Signing up takes a moment.'}
      onBack={onBack}
      footer={(
        <p className={styles.switch}>
          Remembered it? <Link to="/login">Back to sign in</Link>
        </p>
      )}
    >
      {sent ? (
        <div className={styles.form}>
          <p className={styles.sent} role="status">{sent}</p>
          <Button type="button" variant="ghost" size="lg" block disabled={busy || counting} onClick={send}>
            {busy ? 'Sending…' : counting ? `Send again in ${wait}s` : 'Send again'}
          </Button>
        </div>
      ) : (
        <form className={styles.form} onSubmit={send}>
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
          <Button type="submit" size="lg" block disabled={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
    </AuthShell>
  )
}
