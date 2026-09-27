import React, { useState, useEffect, useRef } from 'react'
import { changePassword, startVerification } from '../lib/auth.js'
import styles from './PasswordDialog.module.css'

// Small modal for the account password, in the one shape the account allows.
//
// An account with a password changes it. An account made with Google has none to
// change, so it sets its first one instead — asking for a "current password"
// there was a dead end: there was nothing to type, and the only way out was a
// reset link. The server agrees (it takes a live session as proof for that first
// one) and reports `set` so the wording can tell the two apart.
//
// Either way the server rotates the session on success, so the browser's cookie
// is replaced automatically — the only thing we report is how many other devices
// got signed out.
//
// `onPasswordChanged` tells the shell that the account has a password now. The
// account menu is rendered from a flag read once when the session loaded, so
// without it a Google-only account that had just set its first password kept
// offering to "Set a password" — and reopening the dialog showed the
// set-a-first-one form, with no current-password field, for an account that had
// one. Only a page reload put it right.
export default function PasswordDialog({ onClose, hasPassword = true, onPasswordChanged }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)
  const [busy, setBusy] = useState(false)
  // Setting the first password on an account that has none is a new way in, so
  // the server wants a mailed code as well as the session. Changing an existing
  // password does not: the current password is the stronger proof, and asking
  // for a code on top of it would be friction with nothing behind it.
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState(null)
  const firstField = useRef(null)

  useEffect(() => { firstField.current?.focus() }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function sendCode() {
    setError(null)
    setSending(true)
    try {
      const res = await startVerification('password')
      setCodeSent(true)
      setNotice(`Code sent to ${(res?.sentTo || ['your email']).join(', ')}.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (next !== confirm) {
      setError("New passwords don't match.")
      return
    }
    if (!hasPassword && code.length !== 6) {
      setError('Ask for a code and enter the six digits from the email.')
      return
    }
    setBusy(true)
    try {
      // No current password to send for an account that has none — the code
      // stands in for it there.
      const res = await changePassword(hasPassword ? current : '', next, hasPassword ? undefined : code)
      const revoked = res?.otherSessionsRevoked || 0
      const what = res?.set === true || !hasPassword ? 'Password set.' : 'Password updated.'
      // Set for the first time or changed, the account has one now. Reporting it
      // here rather than re-asking the server keeps the one source of truth: the
      // response we just acted on.
      onPasswordChanged()
      setDone(
        revoked > 0
          ? `${what} ${revoked} other ${revoked === 1 ? 'device was' : 'devices were'} signed out.`
          : what,
      )
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-dialog-title"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className={styles.head}>
          <h2 id="password-dialog-title" className={styles.title}>
            {hasPassword ? 'Change password' : 'Set a password'}
          </h2>
          <button className={styles.close} onClick={onClose} aria-label="Close">✕</button>
        </div>

        {done ? (
          <>
            <p className={styles.done} role="status">{done}</p>
            <button className={styles.btn} onClick={onClose}>Done</button>
          </>
        ) : (
          <form onSubmit={submit}>
            {hasPassword && (
              <label className={styles.label}>
                Current password
                <input
                  ref={firstField}
                  className={styles.input}
                  type="password"
                  value={current}
                  onChange={e => setCurrent(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
            )}
            <label className={styles.label}>
              New password
              <input
                ref={hasPassword ? undefined : firstField}
                className={styles.input}
                type="password"
                value={next}
                onChange={e => setNext(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <label className={styles.label}>
              Confirm new password
              <input
                className={styles.input}
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>

            {/* The first password on a Google-only account: the session is not
                proof enough to add a way in, so a code is mailed first. */}
            {!hasPassword && (
              codeSent ? (
                <label className={styles.label}>
                  Code from the email
                  <input
                    className={styles.input}
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="123456"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                  />
                </label>
              ) : (
                <button type="button" className={styles.codeBtn} onClick={sendCode} disabled={sending}>
                  {sending ? 'Sending…' : 'Email me a code'}
                </button>
              )
            )}
            {notice && <p className={styles.notice} role="status">{notice}</p>}

            {error && <p className={styles.error} role="alert">{error}</p>}

            <button className={styles.btn} type="submit" disabled={busy || (!hasPassword && !codeSent)}>
              {hasPassword
                ? (busy ? 'Updating…' : 'Update password')
                : (busy ? 'Saving…' : 'Set password')}
            </button>
            <p className={styles.note}>
              {hasPassword
                ? 'Changing your password signs out every other device.'
                : 'A password lets you sign in without Google as well. It signs out every other device.'}
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
