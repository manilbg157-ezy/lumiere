import React, { useState, useEffect, useRef, useCallback } from 'react'
import Home from './pages/Home.jsx'
import Browse from './pages/Browse.jsx'
import Search from './pages/Search.jsx'
import MyHome from './pages/MyHome.jsx'
import Notifications from './pages/Notifications.jsx'
import Saved from './pages/Saved.jsx'
import Welcome from './pages/Welcome.jsx'
import Login from './pages/Login.jsx'
import Signup from './pages/Signup.jsx'
import Forgot from './pages/Forgot.jsx'
import Reset from './pages/Reset.jsx'
import Title from './pages/Title.jsx'
import History from './pages/History.jsx'
import Terms from './pages/Terms.jsx'
import Privacy from './pages/Privacy.jsx'
import Style from './pages/Style.jsx'
import CompleteProfile from './pages/CompleteProfile.jsx'
import Settings from './pages/Settings.jsx'
import Link from './components/Link.jsx'
import Icon from './components/Icon.jsx'
import Splash from './components/Splash.jsx'
import Row from './components/Row.jsx'
import { LibraryProvider, useLibrary } from './lib/library.jsx'
import { getSession, clearSession, displayName, initial, AVATAR_UPDATED, ACCOUNT_UPDATED } from './lib/auth.js'
import { getUnseenCount, NOTIFICATIONS_SEEN } from './lib/personal.js'
import { IS_APP, apiUrl } from './lib/apiBase.js'
import { allowNextUnload } from './lib/useStayOnPage.js'
import { useRoute, navigate, currentUrl, LIBRARY_PATH, TAB_ITEMS, activeNavKey } from './lib/router.js'
import { setDocumentMeta } from './lib/seo.js'
import styles from './App.module.css'

// The chips across the top of the browse screens, in the order the app shows
// them.
const CHIPS = [
  { key: 'home', label: 'Home', path: '/' },
  { key: 'tv', label: 'TV Shows', path: '/tv' },
  { key: 'movie', label: 'Movies', path: '/movies' },
  { key: 'new', label: 'New & Popular', path: '/new' },
]

// Pages that show the chip row — the browse screens, not the account ones.
const CHIP_ROUTES = new Set(['home', 'library', 'new', 'myList'])

// Which screen's name the top bar prints, per route.
const SECTION_TITLE = {
  home: 'Home',
  new: 'New & Popular',
  myList: 'My List',
  search: 'Search',
  profile: 'My Home',
  settings: 'User Settings',
  saved: 'Saved',
  notifications: 'Notifications',
  history: 'Continue Watching',
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
}

const AUTH_TITLE = {
  login: 'Sign in',
  signup: 'Create account',
  forgot: 'Forgot password',
  reset: 'Choose a new password',
}

// A description for each auth screen. Without one these pages shared the
// shell's generic sentence, and a page whose <title> says nothing distinctive
// is exactly the page a search engine titles from its first heading instead.
const AUTH_DESCRIPTION = {
  login: 'Sign in to Lumiere Streaming Service to keep your watch history, your list and your recommendations.',
  signup: 'Create a free Lumiere Streaming Service account — watch thousands of movies and TV series online.',
  forgot: 'Reset the password on your Lumiere Streaming Service account.',
  reset: 'Choose a new password for your Lumiere Streaming Service account.',
}

const AUTH_PATH = { login: '/login', signup: '/signup', forgot: '/forgot' }

const SUPPORT_EMAIL = 'manilbg157@gmail.com'

export default function App() {
  const route = useRoute()
  const [user, setUser] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [splash, setSplash] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  // The account's avatar URL, or null when they have not uploaded one.
  const [avatar, setAvatar] = useState(null)
  // True for an account that signed in but never finished setting up (a fresh
  // Google sign-up). Nothing else renders until it is done.
  const [needsProfile, setNeedsProfile] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [unseen, setUnseen] = useState(0)
  // Whether the page has scrolled far enough for the top bar to turn solid.
  const [scrolled, setScrolled] = useState(false)
  // Step (ii): the app opens on the welcome screen until the visitor signs in or
  // chooses to browse. The choice is per session, so a normal launch shows it
  // again but a reload mid-browse does not.
  const [browsing, setBrowsing] = useState(() => {
    try { return sessionStorage.getItem('lumiere:browsing') === '1' } catch { return false }
  })
  const userRef = useRef(null)
  const supportRef = useRef(null)

  // Step (i): the splash. It plays over the app while the app boots, and only
  // once per session — a soft navigation back to Home must not replay it.
  useEffect(() => {
    try {
      if (sessionStorage.getItem('lumiere:splashed') === '1') { setSplash(false); return }
      sessionStorage.setItem('lumiere:splashed', '1')
    } catch {}
    const timer = setTimeout(() => setSplash(false), 1400)
    return () => clearTimeout(timer)
  }, [])

  // The Netflix bar: see-through while it sits over the featured artwork, solid
  // black with a shadow once the page scrolls. Passive listener, and it only
  // flips one boolean, so it stays cheap on a scrolling phone.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const copyEmail = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = SUPPORT_EMAIL
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch {}
      ta.remove()
    }
    setCopied(true)
  }, [])

  // Who we are lives in an HttpOnly cookie (web) or the app's bearer token.
  // Rendering does not wait on this: the catalogue is public, so the page paints
  // immediately and the chrome fills in when the answer arrives.
  const applySession = useCallback(session => {
    setUser(session ? session.email : null)
    setAvatar(session ? session.avatarUrl : null)
    setNeedsProfile(session ? session.needsProfile === true : false)
  }, [])

  useEffect(() => {
    let alive = true
    getSession().then(session => {
      if (!alive) return
      applySession(session)
      setAuthReady(true)
    })
    return () => { alive = false }
  }, [applySession])

  // Settings changes the account itself — most visibly its address — so the
  // header (and anything else reading the session) re-reads it rather than
  // showing the old one until the next reload. See notifyAccountUpdated.
  useEffect(() => {
    const sync = () => getSession().then(applySession)
    window.addEventListener(ACCOUNT_UPDATED, sync)
    return () => window.removeEventListener(ACCOUNT_UPDATED, sync)
  }, [applySession])

  // The profile screen changes the avatar; refresh it here so the header avatar
  // and My Home never disagree (see notifyAvatarUpdated in lib/auth.js).
  useEffect(() => {
    const sync = () => getSession().then(session => setAvatar(session ? session.avatarUrl : null))
    window.addEventListener(AVATAR_UPDATED, sync)
    return () => window.removeEventListener(AVATAR_UPDATED, sync)
  }, [])

  // The bell badge — the count the server reports as genuinely unseen, not the
  // length of the list (which always carries evergreen rows). It refreshes when
  // the Notifications screen marks them read.
  useEffect(() => {
    if (!user) { setUnseen(0); return undefined }
    let alive = true
    const refresh = () => getUnseenCount().then(count => { if (alive) setUnseen(count) })
    refresh()
    window.addEventListener(NOTIFICATIONS_SEEN, refresh)
    return () => { alive = false; window.removeEventListener(NOTIFICATIONS_SEEN, refresh) }
  }, [user])

  // Close the dropdowns on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen && !supportOpen) return undefined
    function onDocClick(e) {
      if (userRef.current && !userRef.current.contains(e.target)) setMenuOpen(false)
      if (supportRef.current && !supportRef.current.contains(e.target)) setSupportOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') { setMenuOpen(false); setSupportOpen(false) }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, supportOpen])

  const isAuthRoute = ['login', 'signup', 'forgot', 'reset'].includes(route.name)
  const navKey = activeNavKey(route)

  // Head tags for the screens that are one URL each. Title pages and the auth
  // pages set their own (pages/Title.jsx, the AUTH_TITLE map below).
  useEffect(() => {
    if (route.name === 'library') {
      const movies = route.type === 'movie'
      setDocumentMeta({
        title: movies ? 'Movies' : 'TV Shows',
        description: movies
          ? 'Browse trending, popular and top-rated movies on Lumiere Streaming Service.'
          : 'Browse trending, popular and top-rated TV series on Lumiere Streaming Service.',
        canonical: LIBRARY_PATH[route.type],
      })
      return
    }
    if (AUTH_TITLE[route.name]) {
      setDocumentMeta({
        title: AUTH_TITLE[route.name],
        description: AUTH_DESCRIPTION[route.name],
        canonical: AUTH_PATH[route.name],
      })
    }
  }, [route.name, route.type])

  // Private screens stay out of search engines; the browse pages above do not.
  useEffect(() => {
    const privateRoute = ['profile', 'settings', 'saved', 'notifications', 'welcome', 'myList', 'history', 'completeProfile'].includes(route.name)
    setDocumentMeta({ noindex: privateRoute })
  }, [route.name])

  // A screen that moved to a new path renders under the old one too, then tidies
  // the address bar. replace (not push) so Back leaves the app rather than
  // bouncing between /downloads and /saved.
  useEffect(() => {
    if (route.legacy && route.path && route.path !== currentUrl()) navigate(route.path, { replace: true })
  }, [route.legacy, route.path])

  // A finished visitor has no business on the completion screen — send them home
  // rather than rendering the app at a URL that means nothing to them.
  useEffect(() => {
    if (route.name === 'completeProfile' && authReady && !needsProfile) navigate('/', { replace: true })
  }, [route.name, authReady, needsProfile])

  function requireAuth(returnTo) {
    try { sessionStorage.setItem('lumiere:returnTo', returnTo || currentUrl()) } catch {}
    navigate('/login', { state: { from: returnTo || currentUrl() } })
  }

  function afterLogin(email) {
    setUser(email)
    // Both ways in from here — a created account, or a sign-in — mean a profile
    // that is complete.
    setNeedsProfile(false)
    try { sessionStorage.setItem('lumiere:browsing', '1') } catch {}
    setBrowsing(true)
    const state = typeof window === 'undefined' ? {} : window.history.state || {}
    let back = state.from
    try {
      back = back || sessionStorage.getItem('lumiere:returnTo')
      sessionStorage.removeItem('lumiere:returnTo')
    } catch {}
    navigate(back || '/', { replace: true })
  }

  async function signOut() {
    await clearSession()
    // A player keeps playing across a normal SPA sign-out, so the signed-out
    // visit ends with a real reload — which unmounts it and clears every page's
    // cached state with it.
    allowNextUnload()
    window.location.reload()
  }

  // The signup form refused an address that already has an account. Carry it to
  // the sign-in page, which is where it has to go next either way.
  function signupExists(email) {
    navigate('/login', { state: { email, notice: 'exists' } })
  }

  function browseWithoutAccount() {
    try { sessionStorage.setItem('lumiere:browsing', '1') } catch {}
    setBrowsing(true)
    if (route.name === 'welcome') navigate('/', { replace: true })
  }

  // The account screens are their own full pages, with no app chrome.
  if (isAuthRoute) {
    const back = () => navigate('/')
    if (route.name === 'forgot') return <Forgot onBack={back} />
    if (route.name === 'reset') return <Reset token={route.token} onLogin={afterLogin} onBack={back} />
    const AuthPage = route.name === 'login' ? Login : Signup
    // `onExists` belongs to Signup: an address that already has an account is
    // not an error to show on the form, it is a trip to the sign-in page — the
    // same place a Google signup on that address lands.
    return <AuthPage onLogin={afterLogin} onBack={back} onExists={signupExists} />
  }

  // A Google sign-up is signed in but not set up: the completion screen takes
  // over the whole app until it is finished. It sits above the chrome on purpose
  // — there is no way to browse past it, which is what makes the age check real.
  if (authReady && user && needsProfile) {
    return (
      <CompleteProfile
        email={user}
        onDone={() => {
          setNeedsProfile(false)

          // The Google flow carries the page the visitor was heading for.
          let back = '/'
          try {
            const to = new URLSearchParams(window.location.search).get('returnTo')
            if (to && to.startsWith('/')) back = to
          } catch {}
          navigate(back, { replace: true })
        }}
      />
    )
  }

  // Step (ii): the app's own entry screen. It is skipped by a signed-in visitor,
  // by anyone who already chose to browse, and by a deep link straight to a
  // page (a shared title URL should open that title, not an onboarding wall).
  const showWelcome = (route.name === 'welcome' || (IS_APP && !browsing))
    && authReady && !user && !splash

  const content = () => {
    switch (route.name) {
      case 'home': return <Home user={user} />
      case 'library': return <Browse catalog={route.type === 'tv' ? 'tv' : 'movie'} />
      case 'new': return <Browse catalog="new" />
      case 'myList': return <MyListPage />
      case 'search': return <Search />
      case 'profile': return <MyHome user={user} avatarUrl={avatar} onRequireAuth={() => requireAuth('/my-home')} onOpenSaved={() => navigate('/saved')} />
      case 'settings': return (
        <Settings
          user={user}
          onRequireAuth={requireAuth}
          onSignedOut={signOut}
        />
      )
      case 'saved': return <Saved user={user} />
      case 'notifications': return <Notifications user={user} />
      case 'history': return <History user={user} />
      // Public legal pages — readable signed in or out.
      case 'terms': return <Terms />
      case 'privacy': return <Privacy />
      // The design-system showcase (public, but not in the sitemap).
      case 'style': return <Style />
      case 'title': return (
        <Title
          key={`${route.type}-${route.id}`}
          type={route.type}
          id={route.id}
          user={user}
          onRequireAuth={requireAuth}
        />
      )
      default: return <Home user={user} />
    }
  }

  return (
    <LibraryProvider user={user} onRequireAuth={() => requireAuth(currentUrl())}>
      {splash && <Splash onDone={() => setSplash(false)} />}

      {showWelcome ? (
        <Welcome onContinue={browseWithoutAccount} />
      ) : (
        <div className={styles.app}>
          {/* The lighting every page inside the shell is lit by. One fixed layer
              (see .ambient in src/index.css), painted once and animated on the
              compositor, so it costs nothing per scroll and nothing per frame.
              Panels are translucent, so this is what shows through them — and
              what their backdrop-filter has to work with. */}
          <div className="ambient" aria-hidden="true" />

          {/* First in the tab order, so keyboard visitors can jump past the nav. */}
          <a className={styles.skip} href="#main">Skip to content</a>

          <header
            className={`${styles.topbar} ${scrolled ? styles.topbarScrolled : ''} ${route.name === 'home' && !scrolled ? styles.topbarOverHero : ''}`}
          >
            <Link className={styles.wordmark} to="/" aria-label="Lumiere Streaming Service — home">
              <span className={styles.mark} aria-hidden="true">L</span>
              <span className={styles.wordtext}>
                Lumiere
                <span className={styles.wordSub}>Streaming Service</span>
              </span>
            </Link>

            <h1 className={styles.pageTitle}>
              {route.name === 'library'
                ? (route.type === 'tv' ? 'TV Shows' : 'Movies')
                : (SECTION_TITLE[route.name] || 'Home')}
            </h1>

            <div className={styles.topActions}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => navigate('/saved')}
                aria-label="Saved"
              >
                <Icon name="bookmark" size={22} />
              </button>

              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => navigate('/notifications')}
                aria-label={unseen ? `Notifications, ${unseen} new` : 'Notifications'}
              >
                <Icon name="bell" size={22} />
                {unseen > 0 && <span className={styles.badge}>{unseen > 9 ? '9+' : unseen}</span>}
              </button>

              {/* Support is for everyone, signed in or not — so it sits beside
                  the account controls rather than inside the signed-out branch. */}
              <span className={styles.supportWrap} ref={supportRef}>
                <button
                  type="button"
                  className={styles.supportBtn}
                  onClick={() => setSupportOpen(o => !o)}
                  aria-haspopup="dialog"
                  aria-expanded={supportOpen}
                >
                  Support
                </button>
                {supportOpen && (
                  <div className={styles.supportPop} role="dialog" aria-label="Support">
                    <div className={styles.supportHead}>
                      <span className={styles.supportTitle}>Support</span>
                      <button
                        type="button"
                        className={styles.supportClose}
                        onClick={() => { setSupportOpen(false); setCopied(false) }}
                        aria-label="Close support"
                      >
                        <Icon name="close" size={13} strokeWidth={2.4} />
                      </button>
                    </div>
                    <p className={styles.supportText}>
                      Contact on this email:{' '}
                      <a className={styles.supportMail} href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
                    </p>
                    <button
                      type="button"
                      className={`${styles.copyBtn} ${copied ? styles.copyDone : ''}`}
                      onClick={copyEmail}
                    >
                      {copied ? 'Copied ✓' : 'Copy email'}
                    </button>
                    {/* The legal pages, reachable from here as well as from the
                        account menu. */}
                    <p className={styles.supportLinks}>
                      <Link to="/terms" onClick={() => setSupportOpen(false)}>Terms</Link>
                      <span aria-hidden="true">·</span>
                      <Link to="/privacy" onClick={() => setSupportOpen(false)}>Privacy</Link>
                    </p>
                  </div>
                )}
              </span>

              <div className={styles.user} ref={userRef}>
                {authReady && (user ? (
                  <>
                    <button
                      type="button"
                      className={styles.avatar}
                      onClick={() => setMenuOpen(o => !o)}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      title="Account"
                    >
                      {avatar
                        ? <img className={styles.avatarImg} src={apiUrl(avatar)} alt="" />
                        : initial(user)}
                    </button>
                    {menuOpen && (
                      <div className={styles.menu} role="menu">
                        <div className={styles.menuHead}>
                          <span className={styles.menuName}>{displayName(user)}</span>
                          <span className={styles.menuEmail}>{user}</span>
                        </div>
                        <Link className={styles.menuItem} to="/my-home" role="menuitem" onClick={() => setMenuOpen(false)}>
                          My Home
                        </Link>
                        <Link className={styles.menuItem} to="/my-list" role="menuitem" onClick={() => setMenuOpen(false)}>
                          My List
                        </Link>
                        <Link className={styles.menuItem} to="/saved" role="menuitem" onClick={() => setMenuOpen(false)}>
                          Saved
                        </Link>
                        <Link className={styles.menuItem} to="/history" role="menuitem" onClick={() => setMenuOpen(false)}>
                          Continue Watching
                        </Link>
                        <Link className={styles.menuItem} to="/terms" role="menuitem" onClick={() => setMenuOpen(false)}>
                          Terms of Service
                        </Link>
                        <Link className={styles.menuItem} to="/privacy" role="menuitem" onClick={() => setMenuOpen(false)}>
                          Privacy Policy
                        </Link>
                        <Link className={styles.menuItem} to="/settings" role="menuitem" onClick={() => setMenuOpen(false)}>
                          User Settings
                        </Link>
                        <button className={styles.menuItem} onClick={signOut} role="menuitem">
                          Sign out
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <span className={styles.authLinks}>
                    <Link className={styles.signInGhost} to="/login">Sign in</Link>
                    <Link className={styles.signIn} to="/signup">Sign up</Link>
                  </span>
                ))}
              </div>
            </div>
          </header>

          {/* The pill row under the title on the browse screens. */}
          {CHIP_ROUTES.has(route.name) && (
            <nav className={styles.chips} aria-label="Browse">
              <div className="chipRow">
                {CHIPS.map(chip => (
                  <Link
                    key={chip.key}
                    className={`${styles.chip} ${navKey === chip.key ? styles.chipActive : ''}`}
                    to={chip.path}
                    aria-current={navKey === chip.key ? 'page' : undefined}
                  >
                    {chip.label}
                  </Link>
                ))}
              </div>
            </nav>
          )}

          <main className={styles.main} id="main" tabIndex={-1}>
            {content()}
          </main>

          {/* The floating tab bar. Netflix lists Home / Clips / Search / My
              Netflix — this app has no clips feature, so three tabs. */}
          <nav className={styles.tabbar} aria-label="Main">
            {TAB_ITEMS.map(tab => {
              const active = tab.key === 'home'
                ? navKey === 'home'
                : navKey === tab.key
              return (
                <Link
                  key={tab.key}
                  className={`${styles.tab} ${active ? styles.tabActive : ''}`}
                  to={tab.path}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon name={tab.icon} size={22} strokeWidth={active ? 2.2 : 1.8} />
                  <span>{tab.label}</span>
                </Link>
              )
            })}
          </nav>

        </div>
      )}
    </LibraryProvider>
  )
}

// My List is a page of its own — the same tiles as everywhere else, read from
// the shared library context so it is never a stale second copy.
function MyListPage() {
  const { myList } = useLibrary()

  if (!myList.length) {
    return (
      <p className={styles.emptyState}>
        Your list is empty. Press <strong>My List</strong> on any title to save it for later, then find it here.
      </p>
    )
  }

  return <Row title="My List" items={myList} />
}
