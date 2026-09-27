import React from 'react'
import Button from './ui/Button.jsx'
import styles from './AuthShell.module.css'

// Shared frame for the two auth pages. Login and Signup are separate URLs but
// they are the same screen twice, so the layout lives here once and each page
// only supplies its own form.
export default function AuthShell({ title, subtitle, error, note, footer, onBack, children }) {
  return (
    <div className={styles.page}>
      <div className={styles.aura} aria-hidden="true" />
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">L</span>
          <span className={styles.wordmark}>
            Lumiere
            <span className={styles.wordSub}>Streaming Service</span>
          </span>
        </div>

        <h1 className={styles.title}>{title}</h1>
        {subtitle && <p className={styles.sub}>{subtitle}</p>}

        {error && <p className={styles.error} role="alert">{error}</p>}

        {children}
        {footer}
        {note && <p className={styles.note}>{note}</p>}

        {/* Browsing is public, so nobody should ever be stuck on this page. */}
        {onBack && (
          <Button variant="ghost" block className={styles.back} onClick={onBack}>
            ‹ Back to browsing
          </Button>
        )}
      </div>
    </div>
  )
}
