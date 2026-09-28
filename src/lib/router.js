// Minimal History-API router. No dependency, no route library — every screen is
// a real, shareable, crawlable URL:
//
//   /                Home — the personalised feed
//   /movies          Movies library
//   /tv              TV library
//   /new             New & Popular
//   /my-list         My List
//   /search          Search
//   /my-home         Profile hub (activity, lists, saved)
//                    (/my-netflix still resolves here — that was its name)
//   /settings        Account settings (email, Google, profile, deletion)
//   /saved           Saved — the list of titles kept for later
//                    (/downloads still resolves here: the screen was called
//                    Downloads before, and old links and the first APK's deep
//                    links point at it)
//   /notifications   Notifications
//   /welcome         Onboarding (the app opens here when signed out)
//   /history         Continue watching (kept: old links and app deep links)
//   /movie/:id       one movie  (indexable)
//   /tv/:id          one series (indexable)
//   /terms           Terms of Service   (own page, public, in the sitemap)
//   /privacy         Privacy Policy     (own page, public, in the sitemap)
//   /login           sign in     (own page)
//   /signup          create account (own page)
//   /forgot          ask for a password-reset link
//   /reset/:token    choose a new password (token comes from the emailed link)
//
// pushState does not fire an event, so `navigate` dispatches its own; `useRoute`
// listens to both that and popstate (Back/Forward).
import { useEffect, useState } from 'react'

const NAVIGATE_EVENT = 'lumiere:navigate'

// The two libraries keep their long-standing paths ('/' is Home now, and the
// Movies library moved to /movies), so anything holding an old link still works.
export const LIBRARY_PATH = { movie: '/movies', tv: '/tv' }

// The bottom bar on phones. Netflix lists Home / Clips / Search / My Netflix —
// this app has no clips feature, and its profile hub is called My Home, so it is
// Home / Search / My Home.
export const TAB_ITEMS = [
  { key: 'home', label: 'Home', path: '/', icon: 'home' },
  { key: 'search', label: 'Search', path: '/search', icon: 'search' },
  { key: 'profile', label: 'My Home', path: '/my-home', icon: 'profile' },
]

export function titlePath(type, id) {
  return `/${type === 'tv' ? 'tv' : 'movie'}/${id}`
}

function cleanPath(pathname) {
  const parts = String(pathname || '/').split('?')[0].split('/').filter(Boolean)
  return `/${parts.join('/')}`.toLowerCase()
}

// Parses a URL into something the app can render. Unknown paths fall back to
// Home (the same thing the server's SPA fallback does), so a stale or mistyped
// link still lands somewhere useful.
export function parseRoute(pathname) {
  const raw = String(pathname || '/').split('?')[0]

  // Matched against the raw path, before anything is lower-cased: reset tokens
  // are base64url, so "AbC" and "abc" are different tokens and folding the case
  // here would break every link that contains an upper-case letter.
  const reset = /^\/reset\/([A-Za-z0-9_-]{20,200})\/?$/.exec(raw)
  if (reset) return { name: 'reset', token: reset[1], path: '/reset' }

  const clean = cleanPath(pathname)
  const parts = clean.split('/').filter(Boolean)

  if (!parts.length) return { name: 'home', path: '/' }

  if (parts.length === 1) {
    switch (parts[0]) {
      case 'tv': return { name: 'library', type: 'tv', path: '/tv' }
      case 'movies': return { name: 'library', type: 'movie', path: '/movies' }
      // The very first build linked to /movies from '/' — old links still land
      // on the Movies library, which is what they meant.
      case 'home': return { name: 'home', path: '/' }
      case 'new': return { name: 'new', path: '/new' }
      case 'my-list': return { name: 'myList', path: '/my-list' }
      case 'search': return { name: 'search', path: '/search' }
      case 'my-home': return { name: 'profile', path: '/my-home' }
      // The design-system showcase — every glass surface on one screen, for
      // checking the look without clicking through the whole app. Kept out of
      // the sitemap on purpose; see siteRoutes.js.
      case 'style': return { name: 'style', path: '/style' }
      // The account screen — email, Google, profile, deletion. Its own page, like
      // the legal screens, so a link to it is shareable and the back button works.
      case 'settings': return { name: 'settings', path: '/settings' }
      // The hub was called "My Netflix" before the rename; old links and the
      // APK's existing deep links keep working and the URL is tidied up in the
      // address bar (App.jsx rewrites any route carrying `legacy`).
      case 'my-netflix': return { name: 'profile', path: '/my-home', legacy: true }
      case 'saved': return { name: 'saved', path: '/saved' }
      // The same screen under its previous name. `legacy` tells the app to
      // rewrite the address bar to /saved rather than redirect, so the visitor
      // lands on the screen with no extra history entry.
      case 'downloads': return { name: 'saved', path: '/saved', legacy: true }
      case 'notifications': return { name: 'notifications', path: '/notifications' }
      case 'welcome': return { name: 'welcome', path: '/welcome' }
      // Where a new Google sign-up finishes setting up (see CompleteProfile).
      case 'complete-profile': return { name: 'completeProfile', path: '/complete-profile' }
      case 'history': return { name: 'history', path: '/history' }
      // The legal pages. Public and indexable — reachable signed in or out.
      case 'terms': return { name: 'terms', path: '/terms' }
      case 'privacy': return { name: 'privacy', path: '/privacy' }
      case 'login': return { name: 'login', path: '/login' }
      case 'signup': return { name: 'signup', path: '/signup' }
      case 'forgot': return { name: 'forgot', path: '/forgot' }
      // A token-less /reset can only be a truncated link; the page says so.
      case 'reset': return { name: 'reset', token: null, path: '/reset' }
      default: break
    }
  }

  // Numeric ids only: TMDB ids are integers, and this keeps junk URLs such as
  // /movie/anything from becoming a route (they stay the Home fallback).
  if (parts.length === 2 && (parts[0] === 'movie' || parts[0] === 'tv') && /^\d+$/.test(parts[1])) {
    return { name: 'title', type: parts[0], id: Number(parts[1]), path: clean }
  }

  return { name: 'home', path: '/', unknown: true }
}

export function currentUrl() {
  if (typeof window === 'undefined') return '/'
  return window.location.pathname + window.location.search
}

export function navigate(to, { replace = false, state = {} } = {}) {
  if (typeof window === 'undefined') return
  const from = currentUrl()
  if (from === to) return
  if (replace) window.history.replaceState(state, '', to)
  else window.history.pushState(state, '', to)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

// Whatever `navigate` was given as `state` for the current entry — used to send
// a visitor back to the title page they tried to play from.
export function currentState() {
  if (typeof window === 'undefined') return {}
  return window.history.state || {}
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(typeof window === 'undefined' ? '/' : window.location.pathname))

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', sync)
    window.addEventListener(NAVIGATE_EVENT, sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener(NAVIGATE_EVENT, sync)
    }
  }, [])

  return route
}

// Which top-level nav entry (if any) the current route belongs to — used to mark
// the active chip and tab.
export function activeNavKey(route) {
  if (!route) return null
  if (route.name === 'title' || route.name === 'library') return route.type === 'tv' ? 'tv' : 'movie'
  return route.name
}
