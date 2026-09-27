import React, { useState, useEffect, useRef } from 'react'
import Link from '../components/Link.jsx'
import Icon from '../components/Icon.jsx'
import Row from '../components/Row.jsx'
import { getActivity } from '../lib/personal.js'
import { getHistory, displayName, initial, uploadAvatar, removeAvatar, notifyAvatarUpdated } from '../lib/auth.js'
import { apiUrl } from '../lib/apiBase.js'
import { useLibrary } from '../lib/library.jsx'
import { titlePath } from '../lib/router.js'
import { tmdbImage } from '../lib/api.js'
import { setDocumentMeta } from '../lib/seo.js'
import styles from './MyHome.module.css'

// The "My Home" tab: who is signed in, what they are part-way through, what
// they liked, their list, and the way into Saved — the same stack of sections as
// the Netflix profile screen. It was called "My Netflix" until the rename; the
// old /my-netflix URL still lands here (see lib/router.js).
export default function MyHome({ user, avatarUrl, onRequireAuth, onOpenSaved }) {
  const library = useLibrary()
  const [activity, setActivity] = useState(null)
  const [history, setHistory] = useState([])
  const [note, setNote] = useState(null)
  // The profile photo: the server URL (kept in step with the header through the
  // AVATAR_UPDATED event) plus a local preview that shows the instant a file is
  // picked, before the upload has finished.
  const [avatar, setAvatar] = useState(avatarUrl || null)
  const [preview, setPreview] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [photoError, setPhotoError] = useState(null)
  const fileRef = useRef(null)

  useEffect(() => { setAvatar(avatarUrl || null) }, [avatarUrl])

  // An object URL is a live handle; release it when it is replaced (or on
  // unmount) instead of leaking one per pick.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  async function onPick(event) {
    const file = event.target.files?.[0]
    // Clear the input so picking the same file twice still fires a change.
    event.target.value = ''
    if (!file) return
    setPhotoError(null)
    setPreview(URL.createObjectURL(file))
    setUploading(true)
    try {
      const result = await uploadAvatar(file)
      setAvatar(result?.avatarUrl || null)
      notifyAvatarUpdated()
      setNote('Profile photo updated.')
    } catch (err) {
      setPreview(null)
      setPhotoError(err?.message || 'Could not upload that photo.')
    } finally {
      setUploading(false)
    }
  }

  async function onRemovePhoto() {
    setPhotoError(null)
    setPreview(null)
    setUploading(true)
    try {
      await removeAvatar()
      setAvatar(null)
      notifyAvatarUpdated()
      setNote('Profile photo removed.')
    } catch (err) {
      setPhotoError(err?.message || 'Could not remove your photo.')
    } finally {
      setUploading(false)
    }
  }

  useEffect(() => {
    setDocumentMeta({ title: 'My Home', description: 'Your activity, your list and your saved titles — Lumiere', canonical: '/my-home' })
  }, [])

  useEffect(() => {
    if (!user) { setActivity(null); setHistory([]); return undefined }
    let alive = true
    getActivity().then(data => { if (alive) setActivity(data) })
    getHistory().then(items => { if (alive) setHistory(items) })
    return () => { alive = false }
  }, [user])

  // Share a title: the Web Share API where it exists (the app and mobile
  // browsers), a copied link otherwise.
  async function share(item) {
    const type = item.type || 'movie'
    const url = `${window.location.origin}${titlePath(type, item.id)}`
    const title = item.name || 'Watch on Lumiere'
    try {
      if (navigator.share) {
        await navigator.share({ title, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setNote(`Link to ${title} copied.`)
    } catch {
      setNote('Could not share that title on this device.')
    }
  }

  if (!user) {
    return (
      <div className={styles.page}>
        <div className={styles.signedOut}>
          <span className={styles.avatarLarge} aria-hidden="true"><Icon name="profile" size={34} /></span>
          <h1 className={styles.signedOutTitle}>Sign in to make it yours</h1>
          <p className={styles.signedOutText}>
            Sign in to keep your progress, build a list, save titles for offline and get a home
            screen picked for you.
          </p>
          <div className={styles.signedOutActions}>
            <Link className={`${styles.btn} ${styles.btnPrimary}`} to="/signup">Sign up</Link>
            <Link className={`${styles.btn} ${styles.btnGhost}`} to="/login">Sign in</Link>
          </div>
        </div>
      </div>
    )
  }

  const continueWatching = (history.length ? history : activity?.continueWatching || [])
    .map(item => ({
      ...item,
      progressPct: item.durationSec > 0 ? Math.min(100, Math.round((item.positionSec / item.durationSec) * 100)) : 0,
    }))

  const photo = preview || (avatar ? apiUrl(avatar) : null)
  const recentlyWatched = (activity?.recentlyWatched || history).slice(0, 12)
  const liked = library.likes
  const myList = library.myList

  return (
    <div className={styles.page}>
      {/* Profile header — the avatar and name the app puts at the very top. */}
      <header className={styles.profile}>
        {photo
          ? <img className={styles.avatar} src={photo} alt="" />
          : <span className={styles.avatar} aria-hidden="true">{initial(user)}</span>}
        <span className={styles.profileText}>
          <span className={styles.profileName}>{displayName(user)}</span>
          <span className={styles.profileEmail}>{user}</span>
        </span>
        <Link className={styles.profileIcon} to="/notifications" aria-label="Notifications">
          <Icon name="bell" size={21} />
        </Link>
        <button type="button" className={styles.profileIcon} onClick={onOpenSaved} aria-label="Saved">
          <Icon name="bookmark" size={21} />
        </button>
      </header>

      {/* Profile photo — the one part of the profile the visitor owns. JPEG or
          PNG only; the server sniffs the bytes and stores the file. */}
      <div className={styles.photoRow}>
        <button
          type="button"
          className={styles.photoBtn}
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Uploading…' : (photo ? 'Change photo' : 'Upload photo')}
        </button>
        {photo && !uploading && (
          <button type="button" className={styles.photoBtnGhost} onClick={onRemovePhoto}>
            Remove photo
          </button>
        )}
        <input
          ref={fileRef}
          className={styles.fileInput}
          type="file"
          accept="image/png,image/jpeg"
          onChange={onPick}
        />
        <span className={styles.photoHint}>JPEG or PNG, up to 2 MB.</span>
      </div>
      {photoError && <p className={styles.photoError} role="alert">{photoError}</p>}

      {note && <p className={styles.note} role="status">{note}</p>}

      {/* Saved, in the card Netflix puts directly under the profile. */}
      <Link className={styles.savedCard} to="/saved">
        <span className={styles.savedIcon} aria-hidden="true"><Icon name="bookmark" size={20} /></span>
        <span className={styles.savedText}>
          <span className={styles.savedTitle}>Saved</span>
          <span className={styles.savedSub}>
            {library.saved.length
              ? `${library.saved.length} saved title${library.saved.length === 1 ? '' : 's'}`
              : 'Movies and shows you save appear here.'}
          </span>
        </span>
        <Icon name="chevron" size={20} className={styles.chev} />
      </Link>

      {continueWatching.length > 0 && (
        <Row
          title="Continue Watching"
          items={continueWatching}
          variant="landscape"
          seeAllTo="/history"
        />
      )}

      {liked.length > 0 && (
        <section className={styles.section} aria-label="Shows &amp; Movies You Have Liked">
          <h2 className={styles.heading}>Shows &amp; Movies You Have Liked</h2>
          <div className={styles.shareGrid}>
            {liked.slice(0, 12).map(item => (
              <div key={`${item.type}-${item.id}`} className={styles.shareItem}>
                <Link className={styles.shareArt} to={titlePath(item.type, item.id)} aria-label={item.name}>
                  {tmdbImage(item.posterPath, 'w300')
                    ? <img src={tmdbImage(item.posterPath, 'w300')} alt="" loading="lazy" decoding="async" />
                    : <span className={styles.shareEmpty}><Icon name="film" size={22} /></span>}
                </Link>
                <button type="button" className={styles.shareBtn} onClick={() => share(item)}>
                  <Icon name="share" size={15} />
                  Share
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <Row title="My List" items={myList} seeAllTo="/my-list" emptyMessage="Nothing saved yet — press My List on any title." />

      {recentlyWatched.length > 0 && (
        <Row title="Recently Watched" items={recentlyWatched.slice(0, 10)} variant="landscape" />
      )}

      {library.saved.length > 0 && onRequireAuth && (
        <p className={styles.tip}>
          Tip: press the bookmark on any poster to keep a title in Saved.
        </p>
      )}
    </div>
  )
}
