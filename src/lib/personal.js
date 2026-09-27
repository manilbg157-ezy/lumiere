// Client for the app backend, /androidpushservice (see
// server/androidpushservice.js).
//
// The website can reach these endpoints too — the request only needs a session,
// not a phone — so the personal rows, My List, likes and saved titles behave
// identically in both builds. Where the app differs is that it authenticates
// with a bearer token instead of a cookie; apiFetch handles that.
import { apiFetch } from './apiBase.js'

const BASE = '/androidpushservice'

// ---- the personalised home feed ----------------------------------------------

/**
 * Home rows for the signed-in account, or the baseline popularity rows when
 * signed out. Never throws: a broken feed falls back to `null` so the home page
 * can render its own TMDB rows instead of an error.
 */
export async function getFeed() {
  try {
    const data = await apiFetch(`${BASE}/feed`, { timeoutMs: 15000 })
    return Array.isArray(data?.rows) ? data : null
  } catch {
    return null
  }
}

export async function getActivity() {
  try {
    return await apiFetch(`${BASE}/activity`)
  } catch {
    return null
  }
}

// ---- notifications ------------------------------------------------------------

export async function getNotifications() {
  try {
    const data = await apiFetch(`${BASE}/notifications`, { timeoutMs: 15000 })
    return Array.isArray(data?.notifications) ? data.notifications : []
  } catch {
    return []
  }
}

// Fired when the Notifications screen is opened, so the header badge can drop to
// the count the server now reports instead of staying lit until a reload.
export const NOTIFICATIONS_SEEN = 'lumiere:notifications-seen'

// The badge number: how many notifications the server considers genuinely new.
// Distinct from getNotifications().length — the list always carries the
// evergreen rows (a pick, a rewatch, the welcome note), which are not "unseen".
export async function getUnseenCount() {
  try {
    const data = await apiFetch(`${BASE}/notifications`, { timeoutMs: 15000 })
    return Number.isFinite(data?.unseen) ? data.unseen : 0
  } catch {
    return 0
  }
}

export function markNotificationsSeen() {
  return apiFetch(`${BASE}/notifications/seen`, { method: 'POST' })
    .then(result => {
      try { window.dispatchEvent(new Event(NOTIFICATIONS_SEEN)) } catch {}
      return result
    })
    .catch(() => null)
}

// ---- My List / likes / saved -------------------------------------------------
//
// All three are the same idea over the same endpoint shape, so they share one
// implementation and differ only in the path.

function collection(path) {
  const url = `${BASE}/${path}`
  return {
    list: () => apiFetch(url).then(d => (Array.isArray(d?.items) ? d.items : [])).catch(() => []),
    // POST toggles myList and likes; saved titles always add (pressing the button
    // again does not un-save — removal lives on the Saved screen).
    toggle: item => apiFetch(url, { method: 'POST', body: item }),
    remove: (type, id) => apiFetch(`${url}?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
    clear: () => apiFetch(`${url}?all=1`, { method: 'DELETE' }),
  }
}

export const myList = collection('mylist')
export const likes = collection('likes')
// The wire path is still /downloads — hundreds of stored records and every built
// APK address it that way, and the name a screen shows is not worth a migration.
// Only the name changed: on screen and in code it is "Saved".
export const saved = collection('downloads')

// Note: `/config`, `/health`, `/me` and the `/device` registration endpoints exist
// on the server (server/androidpushservice.js) but have no client
// wrapper here — nothing calls them until a real push provider is wired up, and
// unused wrappers are just code that rots.

// ---- offline mirror (the app's Saved screen) ----------------------------------
//
// Nothing here downloads a video file: the titles are served from third-party
// embed players, which a WebView cannot copy. What it does is keep the app's own
// list of saved titles on the device so the Saved screen, the badges on cards
// and the profile counts survive being offline — which is what the screen is
// for. The server's copy stays the source of truth and wins on conflict.
const OFFLINE_KEY = 'lumiere:saved'
// Two earlier keys for this same list: the brand rename (wampysu:saved) and, before
// that, the screen still being called Downloads. Both are read once so a device
// that saved titles under either name does not lose them.
const LEGACY_OFFLINE_KEYS = ['wampysu:saved', 'wampysu:downloads']

export function readOfflineSaved() {
  try {
    const raw = localStorage.getItem(OFFLINE_KEY)
      ?? LEGACY_OFFLINE_KEYS.map(key => localStorage.getItem(key)).find(value => value !== null)
      ?? null
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function writeOfflineSaved(items) {
  try {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(Array.isArray(items) ? items : []))
    for (const key of LEGACY_OFFLINE_KEYS) localStorage.removeItem(key)
  } catch {}
}

export function isSaved(type, id) {
  return readOfflineSaved().some(item => item.type === type && Number(item.id) === Number(id))
}
