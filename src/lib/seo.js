// Keeps <title>, the description, the canonical link and the social preview
// tags in step with whatever the router is showing.
//
// The server injects the same tags into the HTML for /movie/:id and /tv/:id
// (see injectTitleMeta in server.js), so a crawler that does not run JavaScript
// still gets real content; this keeps them correct after client-side navigation.

// The site's name, exactly as it should appear in a search result. It is the
// full brand on purpose: "Lumiere" alone is a busy word (a film-festival
// database, a Berkeley media library, a VOD directory), so the plain name was
// being read as "some Lumiere" rather than as this service.
export const SITE_NAME = 'Lumiere Streaming Service'
export const DEFAULT_DESCRIPTION =
  'Watch thousands of movies and TV series online on Lumiere Streaming Service — trending picks, personal lists, and resume on any device.'

function upsert(attr, key, value) {
  const existing = document.head.querySelector(`meta[${attr}="${key}"]`)
  if (value == null) {
    if (existing) existing.remove()
    return
  }
  const el = existing || document.createElement('meta')
  el.setAttribute(attr, key)
  el.setAttribute('content', value)
  if (!existing) document.head.appendChild(el)
}

function upsertLink(rel, href) {
  const existing = document.head.querySelector(`link[rel="${rel}"]`)
  if (!href) {
    if (existing) existing.remove()
    return
  }
  const el = existing || document.createElement('link')
  el.setAttribute('rel', rel)
  el.setAttribute('href', href)
  if (!existing) document.head.appendChild(el)
}

export function setDocumentMeta({ title, description, image, canonical, noindex, absolute } = {}) {
  if (typeof document === 'undefined') return
  // `absolute` keeps the title exactly as given — for the front door, whose
  // title should be the brand itself rather than "<page> — <brand>".
  const full = title ? (absolute ? title : `${title} — ${SITE_NAME}`) : SITE_NAME
  document.title = full

  // Account-scoped screens (My Home, Saved, Continue Watching, the
  // onboarding page) have nothing to offer a crawler and everything to lose from
  // being indexed, so they opt out here. Cleared on the next public page.
  upsert('name', 'robots', noindex ? 'noindex, nofollow' : null)

  upsert('name', 'description', description || DEFAULT_DESCRIPTION)
  upsert('property', 'og:title', full)
  upsert('property', 'og:description', description || null)
  upsert('property', 'og:image', image || null)
  upsert('property', 'og:type', 'video.other')
  // Every page names the site itself, so a shared link is attributed to the
  // service and never to whichever title happened to be on screen.
  upsert('property', 'og:site_name', SITE_NAME)
  upsert('name', 'application-name', SITE_NAME)
  upsert('name', 'twitter:card', image ? 'summary_large_image' : null)

  if (canonical && typeof window !== 'undefined') {
    upsertLink('canonical', new URL(canonical, window.location.origin).href)
  } else {
    upsertLink('canonical', null)
  }
}
