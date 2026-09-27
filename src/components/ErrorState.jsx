import React from 'react'
import styles from './ErrorState.module.css'

// Shared inline failure state so every screen reports problems the same way,
// with an optional one-tap retry instead of a dead end.
export default function ErrorState({ message, onRetry, retryLabel = 'Try again', compact }) {
  return (
    <div className={`${styles.wrap} ${compact ? styles.compact : ''}`} role="alert">
      <span className={styles.message}>{message}</span>
      {onRetry && (
        <button type="button" className={styles.retry} onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  )
}
