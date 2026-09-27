import React, { useState } from 'react'
import { completeProfile, GENDER_OPTIONS, dobProblem, displayName } from '../lib/auth.js'
import AuthShell from '../components/AuthShell.jsx'
import Field from '../components/ui/Field.jsx'
import Button from '../components/ui/Button.jsx'
import fieldStyles from '../components/ui/Field.module.css'
import styles from './Login.module.css'

// The screen a brand-new Google sign-up lands on instead of the app: Google has
// proved the address, but there is no password, gender or date of birth yet.
// It has no back button on purpose — the account is not usable until it is done.
//
// The age floor is the server's rule; it is re-checked there, so this only saves
// the visitor a round trip.
const TODAY = new Date().toISOString().slice(0, 10)

export default function CompleteProfile({ email, onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [gender, setGender] = useState('')
  const [dob, setDob] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

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
    setBusy(true)
    try {
      await completeProfile({ password, gender, dob })
      onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Finish setting up"
      subtitle={`Almost there, ${displayName(email)}. Choose a password and tell us about you.`}
      error={error}
      note="Google verified your email. This password is how you sign in next time."
    >
      <form className={styles.form} onSubmit={submit}>
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="new-password"
          hint="At least 8 characters."
          required
          minLength={8}
          autoFocus
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

        <Button type="submit" size="lg" block disabled={busy}>
          {busy ? 'Please wait…' : 'Finish and continue'}
        </Button>
      </form>
    </AuthShell>
  )
}
