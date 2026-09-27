import React, { useState } from 'react'
import { resetPassword } from '../lib/auth.js'
import AuthShell from '../components/AuthShell.jsx'
import Field from '../components/ui/Field.jsx'
import Button from '../components/ui/Button.jsx'
import Link from '../components/Link.jsx'
import styles from './Login.module.css'

// Its own page (/reset/<token>), reached from the emailed link. The token is a
// bearer credential for the account, so it is single-use and short-lived — and
// completing the reset signs out every other device, which is the whole point of
// using this flow after a compromise.
export default function Reset({ token, onLogin, onBack }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    setBusy(true)
    try {
      const res = await resetPassword(token, password)
      // The server already set a fresh session cookie, so this lands the visitor
      // back on the site signed in.
      onLogin(res?.email)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="This signs out every other device"
      error={error}
      note={token ? 'The link works once and then stops working.' : undefined}
      onBack={onBack}
      footer={(
        <p className={styles.switch}>
          Need a new link? <Link to="/forgot">Request another</Link>
        </p>
      )}
    >
      {token ? (
        <form className={styles.form} onSubmit={submit}>
          <Field
            label="New password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="new-password"
            hint="At least 8 characters."
            autoFocus
            required
            minLength={8}
          />
          <Field
            label="Confirm new password"
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
          <Button type="submit" size="lg" block disabled={busy}>
            {busy ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
      ) : (
        <p className={styles.sent} role="alert">
          This link is incomplete — part of it is missing. Request a new one and open it from
          your inbox.
        </p>
      )}
    </AuthShell>
  )
}
