import React from 'react'
import styles from './Field.module.css'

// Labelled input with a glass surface. Kept deliberately thin: all the input
// behaviour (type, autocomplete, validation) is passed straight through.
export default function Field({ label, hint, children, ...rest }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children || <input className={styles.input} {...rest} />}
      {hint && <span className={styles.hint}>{hint}</span>}
    </label>
  )
}
