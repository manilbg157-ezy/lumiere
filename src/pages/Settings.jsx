import React, { useCallback, useEffect, useState } from 'react'
import {
  getSettings, startVerification, changeEmail, unlinkGoogle, startGoogleLink,
  updateProfileFields, deleteAccount, notifyAccountUpdated,
  GENDER_OPTIONS, dobProblem,
} from '../lib/auth.js'
import PasswordDialog from '../components/PasswordDialog.jsx'
import Field from '../components/ui/Field.jsx'
import Button from '../components/ui/Button.jsx'
import fieldStyles from '../components/ui/Field.module.css'
import { navigate } from '../lib/router.js'
import styles from './Settings.module.css'

// The account screen: the address, the ways in, the profile, and the way out.
//
// Every change here is one shape — ask for a code, then send it with the change —
// because the server accepts nothing else. A code goes to the address the account
// already has, and an email change proves the new address too, so a mistyped one
// cannot strand anybody. The wording below is what a visitor reads, so it says
// what is happening and what to do, never "invalid request".
//
// The card rows expand one at a time: the same screen is used on a phone and on a
// desktop, and one open form at a time keeps it readable on both.

const TODAY = new Date().toISOString().slice(0, 10)

// What a `?google=` landing from the linking round trip means. Read once and
// tidied out of the address bar, like the sign-in form does with its own.
const GOOGLE_NOTICES = {
  linked: 'Google is linked to this account now.',
  taken: 'That Google account is already linked to a different Lumiere account.',
  'other-google': 'Unlink the Google account already on this account before linking another.',
  code: 'That code was not right, so nothing was linked.',
  signin: 'Sign in again to change the Google account.',
  email: 'That Google account has no usable email address.',
  denied: 'The Google sign-in was cancelled.',
  failed: 'Google could not be reached. Try again.',
}

function takeGoogleNotice() {
  if (typeof window === 'undefined') return null
  const reason = new URLSearchParams(window.location.search).get('google')
  if (!reason) return null
  return GOOGLE_NOTICES[reason] || GOOGLE_NOTICES.failed
}

const mask = value => {
  const at = String(value || '').lastIndexOf('@')
  return at > 0 ? `${value[0]}***${value.slice(at)}` : '***'
}

// The stored value is the wire value ('non-binary'); the row shows the label the
// visitor picked on the signup form.
const genderLabel = value => GENDER_OPTIONS.find(option => option.value === value)?.label || value || 'Not set'

// The two steps every section shares, so no section has to invent them again:
// send a code (the server says where it went), then type it back.
function useCode(purpose) {
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState(null)
  const [error, setError] = useState(null)

  function reset() {
    setSent(false)
    setCode('')
    setNotice(null)
    setError(null)
  }

  async function send(extra) {
    setError(null)
    setSending(true)
    try {
      const res = await startVerification(purpose, extra)
      const where = (res?.sentTo || []).map(mask)
      setSent(true)
      setNotice(where.length ? `Code sent to ${where.join(' and ')}.` : 'Code sent.')
    } catch (err) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  return { sent, code, setCode, sending, notice, error, setError, send, reset }
}

// One row of the screen. The value line always shows what is there now, so the
// visitor never has to open a form to find out what they are changing.
// `children` makes the row expandable; `onAction` alone makes its button do
// something directly (the password row opens a dialog instead).
function Row({ title, value, hint, danger, open, onToggle, onAction, action, children }) {
  const expanded = Boolean(children) && Boolean(open)
  return (
    <section className={`${styles.row} ${danger ? styles.rowDanger : ''} ${expanded ? styles.rowOpen : ''}`}>
      <div className={styles.rowHead}>
        <div className={styles.rowText}>
          <h2 className={styles.rowTitle}>{title}</h2>
          {value && <p className={styles.rowValue}>{value}</p>}
          {hint && <p className={styles.rowHint}>{hint}</p>}
        </div>
        {(children || onAction) && (
          <button
            type="button"
            className={styles.rowBtn}
            onClick={onAction || onToggle}
            aria-expanded={children ? expanded : undefined}
          >
            {expanded ? 'Cancel' : (action || 'Change')}
          </button>
        )}
      </div>
      {expanded && <div className={styles.form}>{children}</div>}
    </section>
  )
}

function Notice({ children, tone = 'info' }) {
  if (!children) return null
  return <p className={tone === 'error' ? styles.error : styles.notice} role={tone === 'error' ? 'alert' : 'status'}>{children}</p>
}

function CodeFields({ state, purpose, extra, extraFields }) {
  return (
    <>
      {!state.sent ? (
        <>
          {extraFields}
          <Button type="button" onClick={() => state.send(extra)} disabled={state.sending}>
            {state.sending ? 'Sending…' : 'Send code to my email'}
          </Button>
          <p className={styles.small}>
            A six-digit code is mailed to the address on the account
            {purpose === 'email' ? ', and to the new address as well' : ''}.
          </p>
        </>
      ) : (
        <>
          {extraFields}
          <Field label="Code from the email">
            <input
              className={fieldStyles.input}
              value={state.code}
              onChange={e => state.setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </Field>
          <Button type="button" variant="ghost" onClick={() => state.send(extra)} disabled={state.sending}>
            {state.sending ? 'Sending…' : 'Send a new code'}
          </Button>
        </>
      )}
      <Notice>{state.notice}</Notice>
      <Notice tone="error">{state.error}</Notice>
    </>
  )
}

// ---- moving the account to another address ------------------------------------

function EmailForm({ settings, onDone }) {
  const [next, setNext] = useState('')
  const [newCode, setNewCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const state = useCode('email')

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (!state.code || !newCode) {
      setError('Enter both codes from the two emails.')
      return
    }
    setBusy(true)
    try {
      const res = await changeEmail(next, state.code, newCode)
      onDone(`Your account now signs in as ${res.email}.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <Notice>{state.sent ? `Two codes are on their way — one to ${mask(settings.email)}, one to ${mask(next)}.` : null}</Notice>
      <CodeFields state={state} purpose="email" extra={{ newEmail: next }} extraFields={(
        <Field label="New email address">
          <input
            className={fieldStyles.input}
            type="email"
            value={next}
            onChange={e => {
              setNext(e.target.value)
              // A code is bound to the address it was sent to, so editing the
              // address invalidates it: start the step over rather than let the
              // visitor press send with a code the server will refuse.
              if (state.sent) { state.reset(); setNewCode('') }
            }}
            placeholder="you@example.com"
            inputMode="email"
            autoComplete="email"
            required
          />
        </Field>
      )} />
      {state.sent && (
        <Field label="Code sent to the new address">
          <input
            className={fieldStyles.input}
            value={newCode}
            onChange={e => setNewCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
        </Field>
      )}
      <Notice tone="error">{error}</Notice>
      <Button type="submit" size="lg" block disabled={busy || !state.sent}>
        {busy ? 'Moving…' : 'Move my account'}
      </Button>
      <p className={styles.small}>
        Your watch history and your list move with it. Every other device is signed out.
      </p>
    </form>
  )
}

// ---- Google -------------------------------------------------------------------

function GooglePanel({ settings, onDone }) {
  const link = useCode('google')
  const unlink = useCode('google')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const linked = settings.googleLinked

  async function attach(e) {
    e.preventDefault()
    setError(null)
    if (!link.code) {
      setError('Enter the code from the email.')
      return
    }
    // Leaves the page for Google; the server checks the session and this code
    // before it lets the round trip start.
    startGoogleLink(link.code)
  }

  async function detach(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await unlinkGoogle(unlink.code)
      onDone('Google is no longer linked to this account.')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!settings.googleAvailable) {
    return <p className={styles.small}>Google sign-in is not configured on this server.</p>
  }

  if (linked) {
    return (
      <form onSubmit={detach}>
        {!settings.hasPassword && (
          <Notice tone="error">
            Set a password first — with Google unlinked it would be the only way in.
          </Notice>
        )}
        <CodeFields state={unlink} purpose="google" />
        <Notice tone="error">{error}</Notice>
        <Button type="submit" block disabled={busy || !unlink.sent || !settings.hasPassword}>
          {busy ? 'Unlinking…' : 'Unlink Google'}
        </Button>
      </form>
    )
  }

  return (
    <form onSubmit={attach}>
      <CodeFields state={link} purpose="google" />
      <Notice tone="error">{error}</Notice>
      <Button type="submit" size="lg" block disabled={!link.sent || !link.code}>
        Continue to Google
      </Button>
      <p className={styles.small}>
        Google then asks you to pick the account to attach. Nothing about it is stored beyond the link itself.
      </p>
    </form>
  )
}

// ---- gender and date of birth -------------------------------------------------

function ProfileForm({ settings, onDone }) {
  const [gender, setGender] = useState(settings.gender || '')
  const [dob, setDob] = useState(settings.dob || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const state = useCode('profile')

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (!gender) { setError('Select a gender.'); return }
    const dobIssue = dobProblem(dob)
    if (dobIssue) { setError(dobIssue); return }
    setBusy(true)
    try {
      await updateProfileFields({ gender, dob, code: state.code })
      onDone('Your profile is updated.')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <CodeFields state={state} purpose="profile" extraFields={(
        <>
          <Field label="Gender">
            <select className={fieldStyles.input} value={gender} onChange={e => setGender(e.target.value)} required>
              <option value="">Select…</option>
              {GENDER_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Date of birth">
            <input
              className={fieldStyles.input}
              type="date"
              value={dob}
              onChange={e => setDob(e.target.value)}
              max={TODAY}
              autoComplete="bday"
              required
            />
          </Field>
        </>
      )} />
      <Notice tone="error">{error}</Notice>
      <Button type="submit" size="lg" block disabled={busy || !state.sent}>
        {busy ? 'Saving…' : 'Save profile'}
      </Button>
    </form>
  )
}

// ---- deleting the account -----------------------------------------------------

function DeleteForm({ onDone }) {
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const state = useCode('delete')
  const ready = state.sent && confirm.trim().toUpperCase() === 'DELETE'

  async function submit(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await deleteAccount(state.code)
      onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <p className={styles.warn}>
        This deletes the account and everything in it — your watch history, your list and likes,
        your photo, and the devices registered for notifications. It cannot be undone, and the
        address can be registered again by anyone afterwards.
      </p>
      <CodeFields state={state} purpose="delete" />
      {state.sent && (
        <Field label="Type DELETE to confirm">
          <input
            className={fieldStyles.input}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            placeholder="DELETE"
            autoComplete="off"
            required
          />
        </Field>
      )}
      <Notice tone="error">{error}</Notice>
      <Button type="submit" variant="ghost" className={styles.dangerBtn} size="lg" block disabled={busy || !ready}>
        {busy ? 'Deleting…' : 'Delete my account permanently'}
      </Button>
    </form>
  )
}

// ---- the screen ---------------------------------------------------------------

export default function Settings({ user, onRequireAuth, onSignedOut }) {
  const [settings, setSettings] = useState(null)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null)
  const [open, setOpen] = useState(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [googleNotice, setGoogleNotice] = useState(null)

  const load = useCallback(() => {
    setError(null)
    getSettings().then(setSettings).catch(err => setError(err.message))
  }, [])

  useEffect(() => { if (user) load() }, [user, load])

  // A link round trip lands here with ?google=… — read it once, then take it out
  // of the address bar so a reload does not repeat the news.
  useEffect(() => {
    const notice = takeGoogleNotice()
    if (!notice) return
    setGoogleNotice(notice)
    navigate('/settings', { replace: true })
  }, [])

  // One place that every section reports success to: tell the shell the account
  // changed (the header shows the address), re-read what this page describes, and
  // close the form that was open.
  const changed = useCallback(message => {
    notifyAccountUpdated()
    setOpen(null)
    setFlash(message)
    load()
  }, [load])

  if (!user) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.title}>User settings</h1>
          <p className={styles.sub}>Sign in to manage your email, Google account, profile and more.</p>
          <Button size="lg" block onClick={() => onRequireAuth?.('/settings')}>Sign in</Button>
        </div>
      </div>
    )
  }

  const toggle = id => setOpen(current => (current === id ? null : id))

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>User settings</h1>
        <p className={styles.sub}>
          {settings ? settings.email : user} — every change is confirmed with a code sent to your email.
        </p>
      </header>

      <Notice>{googleNotice}</Notice>
      <Notice>{flash}</Notice>
      <Notice tone="error">{error}</Notice>

      {!settings && !error && <p className={styles.small}>Loading your account…</p>}

      {settings && (
        <>
          {/* A code has to be mailed for every change below, so a deployment with
              no mailbox configured says so once rather than offering buttons that
              cannot work. Changing an existing password is the exception: the
              current password is the proof there, so it stays available. */}
          {!settings.codesAvailable && (
            <Notice tone="error">
              This server cannot send verification codes yet, so these changes are unavailable.
              Changing an existing password still works.
            </Notice>
          )}

          <Row
            title="Email address"
            value={settings.email}
            hint="Where sign-in, reset links and every code goes."
            open={open === 'email'}
            onToggle={() => toggle('email')}
          >
            {settings.codesAvailable ? <EmailForm settings={settings} onDone={changed} /> : null}
          </Row>

          <Row
            title="Password"
            value={settings.hasPassword ? 'Set — one is required to sign in' : 'Not set (you sign in with Google)'}
            hint={settings.hasPassword
              ? 'Changing it signs out every other device.'
              : 'Setting one means you can sign in without Google as well, and it takes a code.'}
            action={settings.hasPassword ? 'Change' : 'Set a password'}
            onAction={settings.hasPassword || settings.codesAvailable ? () => setPwOpen(true) : undefined}
          />

          <Row
            title="Google account"
            value={settings.googleLinked ? 'Linked' : 'Not linked'}
            hint="Linking adds a way in. Unlinking removes it."
            action={settings.googleLinked ? 'Manage' : 'Link'}
            open={open === 'google'}
            onToggle={() => toggle('google')}
          >
            {settings.codesAvailable ? <GooglePanel settings={settings} onDone={changed} /> : null}
          </Row>

          <Row
            title="Gender and date of birth"
            value={`${genderLabel(settings.gender)} · ${settings.dob || 'Not set'}`}
            hint="Used for the under-13 gate and nothing else."
            open={open === 'profile'}
            onToggle={() => toggle('profile')}
          >
            {settings.codesAvailable ? <ProfileForm settings={settings} onDone={changed} /> : null}
          </Row>

          <Row
            title="Delete account"
            value="Permanent"
            hint="Everything in the account goes with it."
            action="Delete"
            danger
            open={open === 'delete'}
            onToggle={() => toggle('delete')}
          >
            {settings.codesAvailable ? <DeleteForm onDone={() => {
              // No re-read of the account here: it is gone. Just say so and hand
              // the shell the job of ending the visit.
              setOpen(null)
              setFlash('Your account has been deleted.')
              onSignedOut?.()
            }} /> : null}
          </Row>
        </>
      )}

      {pwOpen && (
        <PasswordDialog
          hasPassword={settings ? settings.hasPassword : true}
          onClose={() => setPwOpen(false)}
          onPasswordChanged={() => {
            setPwOpen(false)
            notifyAccountUpdated()
            changed(settings?.hasPassword ? 'Password updated.' : 'Password set.')
          }}
        />
      )}
    </div>
  )
}
