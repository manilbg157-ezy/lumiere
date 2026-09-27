// Every static page the app serves, in one list — the single source of truth for
// sitemap.xml. This file deliberately imports nothing, so the server (which has
// no runtime dependencies) can read it directly, exactly the way the removed
// categories list used to be shared. The dynamic pages — /movie/:id and
// /tv/:id — are appended to the sitemap separately, from the TMDB rows the UI
// actually displays (see sitemapTitlePaths in server/tmdb.js).
//
// Why an account page is listed at all: this site's robots.txt allows every
// crawler everywhere and disallows nothing (asserted in test/backend.test.mjs),
// which is a deliberate choice to be fully crawlable. Given that, a page that
// appears in no sitemap is simply undiscoverable, so every stable URL is here
// and `priority` does the ranking work instead:
//
//   1.0  the front door
//   0.8  the two libraries
//   0.7  New & Popular
//   0.5  Search and onboarding — real pages, no unique content of their own
//   0.3  the public legal pages, the auth screens, and the account screens
//        (which render a sign-in prompt or an empty state when signed out)
//
// /reset/:token is absent on purpose: it only works with a token from the email
// that was sent, so there is no stable URL to advertise.
export const SITE_ROUTES = [
  { path: '/', priority: '1.0', changefreq: 'daily' },
  { path: '/movies', priority: '0.8', changefreq: 'daily' },
  { path: '/tv', priority: '0.8', changefreq: 'daily' },
  { path: '/new', priority: '0.7', changefreq: 'daily' },
  { path: '/search', priority: '0.5', changefreq: 'weekly' },
  { path: '/welcome', priority: '0.5', changefreq: 'monthly' },
  { path: '/terms', priority: '0.3', changefreq: 'yearly' },
  { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
  { path: '/login', priority: '0.3', changefreq: 'yearly' },
  { path: '/signup', priority: '0.3', changefreq: 'yearly' },
  { path: '/forgot', priority: '0.2', changefreq: 'yearly' },
  { path: '/my-list', priority: '0.3', changefreq: 'weekly' },
  { path: '/my-home', priority: '0.3', changefreq: 'weekly' },
  { path: '/settings', priority: '0.3', changefreq: 'weekly' },
  { path: '/saved', priority: '0.3', changefreq: 'weekly' },
  { path: '/history', priority: '0.3', changefreq: 'weekly' },
  { path: '/notifications', priority: '0.2', changefreq: 'weekly' },
]

// Every path in the list, for tests and for anything that needs to check a URL
// against it without caring about the metadata.
export const SITE_PATHS = SITE_ROUTES.map(route => route.path)
