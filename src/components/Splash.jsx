import React, { useEffect, useState } from 'react'
import styles from './Splash.module.css'

// Step (i) of the app flow: when the app is opened it shows the splash logo
// before anything else.
//
// The APK also has a native launch drawable (the Android theme paints it before
// any JavaScript runs), so this picks up exactly where that leaves off and fades
// into the next screen. One component covers both the app and the website: on
// the web it only shows for a first visit in a session, and it always honours
// reduced-motion by fading immediately.
//
// It is deliberately not a gate: it renders over the app while the app boots
// underneath, so the splash can never hold the UI hostage if a timer goes wrong.
export const SPLASH_MS = 1400

export default function Splash({ duration = SPLASH_MS, onDone }) {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), Math.max(0, duration - 400))
    const done = setTimeout(() => onDone?.(), duration)
    return () => { clearTimeout(fade); clearTimeout(done) }
  }, [duration, onDone])

  return (
    <div className={`${styles.splash} ${leaving ? styles.leaving : ''}`} role="status" aria-label="Lumiere is loading">
      <div className={styles.inner}>
        <span className={styles.mark} aria-hidden="true">L</span>
        <span className={styles.wordmark}>Lumiere</span>
        <span className={styles.tagline}>Movies &amp; series</span>
      </div>
      <span className={styles.bar} aria-hidden="true" />
    </div>
  )
}
