import React, { useState, useEffect, useRef } from 'react'
import ErrorState from './ErrorState.jsx'
import styles from './Player.module.css'

// Plays one direct stream URL. mp4/webm play natively; m3u8 playlists (or
// native failures) fall back to hls.js which loads lazily on first use.
// Reports failures upward so the parent can try the next source, and playback
// progress upward so continue-watching can resume where the viewer left off.
function StreamVideo({ url, streamType, onFail, onReady, resumeAt, onProgress }) {
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const notifiedRef = useRef(false)
  const lastReportRef = useRef(0)
  const isHls = url.includes('.m3u8') || streamType === 'hls'
  const [mode, setMode] = useState(isHls ? 'hls' : 'native')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setMode(url.includes('.m3u8') || streamType === 'hls' ? 'hls' : 'native')
    setLoading(true)
    notifiedRef.current = false
    lastReportRef.current = 0
  }, [url, streamType])

  // Continue-watching: jump to where the viewer left off. Only when the
  // position is meaningful (past the intro, before the end) and the metadata
  // has the real duration to compare against.
  function onLoadedMetadata(e) {
    const video = e.currentTarget
    if (resumeAt > 5 && video.duration && resumeAt < video.duration - 15) {
      video.currentTime = resumeAt
    }
  }

  // Progress goes to the history store at most every 15s, plus immediately on
  // pause — enough to resume within a few seconds of where playback stopped,
  // without flooding the server during a binge.
  function report(video, force = false) {
    if (!onProgress || !video || !video.duration) return
    const now = Date.now()
    if (!force && now - lastReportRef.current < 15000) return
    lastReportRef.current = now
    onProgress(Math.floor(video.currentTime), Math.floor(video.duration))
  }

  // Only report the first failure per url — hls.js emits error storms.
  function fail() {
    if (notifiedRef.current) return
    notifiedRef.current = true
    onFail?.()
  }

  useEffect(() => {
    if (mode !== 'hls') return
    let cancelled = false
    async function attach() {
      const video = videoRef.current
      if (!video) return
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url
        return
      }
      try {
        const { default: Hls } = await import('hls.js')
        if (cancelled || !videoRef.current) return
        if (!Hls.isSupported()) {
          fail()
          return
        }
        const hls = new Hls({ maxBufferLength: 30 })
        hlsRef.current = hls
        hls.loadSource(url)
        hls.attachMedia(videoRef.current)
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            hls.destroy()
            fail()
          }
        })
      } catch {
        fail()
      }
    }
    attach()
    return () => {
      cancelled = true
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [mode, url])

  return (
    <>
      {loading && <div className={styles.playerLoading}>Loading…</div>}
      <video
        ref={videoRef}
        src={mode === 'native' ? url : undefined}
        controls
        autoPlay
        playsInline
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={e => report(e.currentTarget)}
        onPause={e => report(e.currentTarget, true)}
        onError={() => {
          if (mode === 'native') setMode('hls')
          else fail()
        }}
        onCanPlay={() => { setLoading(false); onReady?.() }}
      />
    </>
  )
}

export default function Player({ sources, src, loadingSources, title, year, rating, overview, badge, resumeAt, onProgress, onClose }) {
  // Legacy sessions only carry a bare NexStream embed URL
  const list = Array.isArray(sources) && sources.length
    ? sources
    : [{ kind: 'embed', name: 'NexStream', url: src }]
  const [idx, setIdx] = useState(0)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  // Fallback "fill the viewport" mode for browsers with no element-level
  // Fullscreen API (iPhone Safari) — the only way to get a big landscape view.
  const [expanded, setExpanded] = useState(false)
  const boxRef = useRef(null)

  useEffect(() => {
    setIdx(0)
    setNotice(null)
  }, [list[0]?.url])

  const active = list[Math.min(idx, list.length - 1)]

  // Reset failure state whenever we switch source
  useEffect(() => {
    setFailed(false)
  }, [active?.url, reloadKey])

  function pick(i) {
    setNotice(null)
    setIdx(i)
  }

  // A dead source shouldn't be a dead end: hop to the next one automatically.
  function handleSourceFail() {
    const next = idx + 1
    if (next < list.length) {
      setNotice(`“${list[idx].name}” didn't load — trying “${list[next].name}”.`)
      setFailed(false) // don't flash the error while hopping to the next source
      setIdx(next)
    } else {
      setFailed(true)
    }
  }

  useEffect(() => {
    if (!onClose) return
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Track the browser's own fullscreen state (Esc / back gesture included).
  useEffect(() => {
    function onChange() {
      const active = Boolean(document.fullscreenElement)
      setFullscreen(active)
      if (active) setExpanded(false)
      else { try { screen.orientation?.unlock?.() } catch {} }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Phones commonly ship with rotation locked, and a web page cannot turn that
  // setting off. Going fullscreen and asking for landscape is the one lever we
  // have: Chromium/Android honours it, elsewhere the device decides.
  function requestLandscape() {
    try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}) } catch {}
  }

  async function enterFullscreen() {
    const box = boxRef.current
    if (!box) return
    const video = box.querySelector('video')

    // iPhone Safari: no element fullscreen, but the native video player has its
    // own — and that one rotates with the device.
    if (!document.fullscreenEnabled && video?.webkitEnterFullscreen) {
      try { video.webkitEnterFullscreen(); requestLandscape(); return } catch {}
    }

    if (!box.requestFullscreen) { setExpanded(true); return }

    try {
      await box.requestFullscreen({ navigationUI: 'hide' })
      requestLandscape()
    } catch {
      setExpanded(true)
    }
  }

  async function exitFullscreen() {
    setExpanded(false)
    try { screen.orientation?.unlock?.() } catch {}
    if (document.fullscreenElement) {
      try { await document.exitFullscreen() } catch {}
    }
  }

  function toggleFullscreen() {
    if (fullscreen || expanded) exitFullscreen()
    else enterFullscreen()
  }

  if (!active?.url) return null

  return (
    <div className={styles.wrap}>
      <div className={styles.meta}>
        <div className={styles.metaTop}>
          <h2 className={styles.title}>{title}</h2>
          {onClose && (
            <button className={styles.closeBtn} onClick={onClose} aria-label="Close player">✕</button>
          )}
        </div>
        <div className={styles.pills}>
          {year && <span className={styles.pill}>{year}</span>}
          {rating && <span className={`${styles.pill} ${styles.gold}`}>★ {rating}</span>}
          {badge && <span className={`${styles.pill} ${styles.badge}`}>{badge}</span>}
        </div>
        {overview && <p className={styles.overview}>{overview}</p>}
      </div>

      {/* Always list the available servers — never hide them, even when the
          embed is the only one that resolved. */}
      {(list.length > 0 || loadingSources) && (
        <div className={styles.sourceRow}>
          {list.map((s, i) => (
            <button
              key={`${s.name}-${s.url}`}
              className={`${styles.sourceChip} ${i === idx ? styles.sourceActive : ''}`}
              onClick={() => pick(i)}
              aria-pressed={i === idx}
              title={s.kind === 'embed' ? 'Embedded player' : 'Direct stream in the built-in player'}
            >
              {s.name}
            </button>
          ))}
          {loadingSources && <span className={styles.sourcePending}>Loading servers…</span>}
          <button
            type="button"
            className={styles.fsBtn}
            onClick={toggleFullscreen}
            aria-pressed={fullscreen || expanded}
            title="Fullscreen — asks for landscape where the browser allows it"
          >
            {fullscreen || expanded ? '⤡ Exit fullscreen' : '⤢ Fullscreen'}
          </button>
        </div>
      )}

      {notice && <p className={styles.notice}>{notice}</p>}

      <div className={`${styles.playerBox} ${expanded ? styles.expanded : ''}`} ref={boxRef}>
        {expanded && (
          <button className={styles.exitBtn} onClick={exitFullscreen} aria-label="Exit fullscreen">✕</button>
        )}
        {failed && active.kind !== 'embed' ? (
          <div className={styles.errorBox}>
            <ErrorState
              compact
              message="This stream didn't load. Try another server, or retry this one."
              retryLabel="Retry source"
              onRetry={() => setReloadKey(k => k + 1)}
            />
          </div>
        ) : active.kind === 'embed' ? (
          <iframe
            key={active.url}
            src={active.url}
            allowFullScreen
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            title={title}
          />
        ) : (
          <StreamVideo
            key={`${active.url}:${reloadKey}`}
            url={active.url}
            streamType={active.streamType}
            onFail={handleSourceFail}
            onReady={() => setNotice(null)}
            resumeAt={resumeAt || 0}
            onProgress={onProgress}
          />
        )}
      </div>
    </div>
  )
}
