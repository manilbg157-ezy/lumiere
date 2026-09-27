import React, { useEffect } from 'react'
import Link from './Link.jsx'
import Icon from './Icon.jsx'
import { navigate } from '../lib/router.js'
import { setDocumentMeta } from '../lib/seo.js'
import styles from './LegalPage.module.css'

// Shared frame for /terms and /privacy. Both are the same shape — a heading, the
// effective date, prose, and a link across to the other one — so the layout
// lives here once. Public pages: no account is needed to read them, and both are
// in sitemap.xml.
export default function LegalPage({ title, description, canonical, updated, children }) {
  useEffect(() => {
    setDocumentMeta({ title, description, canonical })
  }, [title, description, canonical])

  return (
    <article className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={() => navigate('/')} aria-label="Back">
          <Icon name="back" size={22} strokeWidth={2.2} />
        </button>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.updated}>Last updated {updated}</p>
      </header>

      <div className={styles.prose}>{children}</div>

      <footer className={styles.footer}>
        <Link to="/terms">Terms of Service</Link>
        <span className={styles.dot} aria-hidden="true">·</span>
        <Link to="/privacy">Privacy Policy</Link>
      </footer>
    </article>
  )
}
