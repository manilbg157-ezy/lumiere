// IP → place, network and "is this a VPN?" — the lookups behind the tracing
// store (server/tracing.js) and the VPN gate on sign-in.
//
// Every provider here is a plain JSON HTTP API, called with fetch() and nothing
// else, so the whole module stays dependency-free like the rest of the server.
//
// Providers are tried in order and the first one that answers wins:
//
//   1. ipstack          IPSTACK_API_KEY        geo + network + security
//   2. vpnapi.io        VPNAPI_KEY             security + geo + network
//   3. ip-api.com       (no key)               geo + proxy/hosting flags
//   4. proxycheck.io    PROXYCHECK_KEY         VPN/proxy/Tor flags, and risk
//
// The first two are the ones the sign-in trace is built around; the last two
// exist so VPN detection still works when a key is missing or its allowance is
// spent. ip-api.com is free for non-commercial use only — see GEO_DISABLE_IPAPI
// below, which a commercial deployment is expected to set.
//
// Each provider can also be capped per day (see the *_MAX_PER_DAY variables):
// the free tiers are small (ipstack's is 100 lookups a month), and a ceiling
// that skips the provider is a better failure than a key that answers 429 to
// every sign-in until the month turns over.
//
// Place names come from whichever provider answered. A street-level address is
// the one extra step, and it comes from positionstack (POSITIONSTACK_API_KEY):
// it reverse-geocodes the latitude/longitude the provider returned. Results are
// cached per rounded coordinate, because the address belongs to the place, not
// to the visitor.

const TIMEOUT_MS = intEnv('GEO_TIMEOUT_MS', 4000, 200, 60000)
// How long one IP's answer is reused. Providers change their mind slowly, and a
// returning visitor does not need a second lookup.
const CACHE_TTL_MS = intEnv('GEO_CACHE_MINUTES', 360, 0, 10080) * 60 * 1000
const CACHE_MAX = intEnv('GEO_CACHE_SIZE', 500, 0, 100000)

// ipstack's free plan is HTTP-only; a paid plan supports https. Overridable so
// a paid deployment can move both calls onto TLS.
const IPSTACK_URL = String(process.env.IPSTACK_URL || 'http://api.ipstack.com').replace(/\/+$/, '')
const POSITIONSTACK_URL = String(process.env.POSITIONSTACK_URL || 'http://api.positionstack.com/v1/reverse').replace(/\/+$/, '')
const VPNAPI_URL = String(process.env.VPNAPI_URL || 'https://vpnapi.io/api').replace(/\/+$/, '')
const IPAPI_URL = String(process.env.IPAPI_URL || 'http://ip-api.com/json').replace(/\/+$/, '')
const PROXYCHECK_URL = String(process.env.PROXYCHECK_URL || 'https://proxycheck.io/v2').replace(/\/+$/, '')

const key = name => String(process.env[name] || '').trim()

// ip-api.com's terms are non-commercial only. It is the fallback that makes
// detection work without any key at all, so it is on by default — and a
// deployment that is commercial is expected to turn it off.
const IPAPI_DISABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.GEO_DISABLE_IPAPI ?? '').toLowerCase())

// Loopback addresses have no location and no ISP — except when the whole thing
// is being tested, or when the app really does sit behind a proxy that forwards
// a private address (in which case the operator wants the lookup attempted on
// whatever the header says anyway).
const ALLOW_PRIVATE = ['1', 'true', 'yes', 'on'].includes(String(process.env.GEO_ALLOW_PRIVATE ?? '').toLowerCase())

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// ---- daily ceilings ---------------------------------------------------------

const dayCounters = new Map() // provider -> { day, count }

function dayKey() {
  return new Date().toISOString().slice(0, 10)
}

function allowance(provider, name, fallback) {
  const max = intEnv(name, fallback, 0, 1000000)
  if (max === 0) return { ok: false, max: 0, used: 0 }
  const today = dayKey()
  const entry = dayCounters.get(provider)
  const used = entry && entry.day === today ? entry.count : 0
  return { ok: used < max, max, used }
}

function spent(provider) {
  const today = dayKey()
  const entry = dayCounters.get(provider)
  if (!entry || entry.day !== today) {
    dayCounters.set(provider, { day: today, count: 1 })
    return
  }
  entry.count += 1
}

// ---- small helpers ----------------------------------------------------------

function isPublicIp(ip) {
  if (!ip || typeof ip !== 'string') return false
  // IPv4 only for the providers we call; an IPv6 visitor is traced with the geo
  // block empty rather than with a wrong one.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (m.slice(1).some(part => Number(part) > 255)) return false
  if (a === 10 || a === 127 || a === 0) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 169 && b === 254) return false
  if (a >= 224) return false // multicast and reserved
  return true
}

function num(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(n) ? n : null
}

function str(value) {
  if (value == null) return null
  const s = String(value).trim()
  return s && s !== '-' && s.toLowerCase() !== 'unknown' ? s : null
}

function flag(value) {
  return value === true || value === 1 || value === 'true' || value === 'yes'
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ---- providers --------------------------------------------------------------
// Each returns a partial { geo, network, security } and a source name, or throws
// (the chain treats a throw as "this provider did not answer").

function normalizeGeo({ city, region, country, countryCode, postal, latitude, longitude, timezone } = {}) {
  return {
    city: str(city),
    region: str(region),
    country: str(country),
    countryCode: str(countryCode) ? String(countryCode).toUpperCase() : null,
    postal: str(postal),
    latitude: num(latitude),
    longitude: num(longitude),
    timezone: str(timezone),
  }
}

function normalizeNetwork({ isp, org, asn, type } = {}) {
  return {
    isp: str(isp),
    organization: str(org),
    asn: asn == null ? null : (String(asn).toUpperCase().startsWith('AS') ? String(asn).toUpperCase() : `AS${asn}`),
    connectionType: str(type),
  }
}

const PROVIDERS = [
  {
    name: 'ipstack',
    configured: () => Boolean(key('IPSTACK_API_KEY')),
    maxPerDay: 'IPSTACK_MAX_PER_DAY',
    // The free plan's 100 calls a month is about three a day, so the default
    // ceiling is deliberately tiny: ipstack answers the first few sign-ins of
    // the day (which are the ones worth spending it on) and the fallback does
    // the rest. Raise it if the plan is a paid one.
    defaultMax: 3,
    async fetch(ip) {
      const url = `${IPSTACK_URL}/${encodeURIComponent(ip)}`
        + `?access_key=${encodeURIComponent(key('IPSTACK_API_KEY'))}`
        + '&security=1&hostname=0&language=en'
      const data = await fetchJson(url)
      // ipstack answers 200 with { success:false, error:{...} } for a bad key or
      // an exhausted plan. `security` is absent on plans without that module,
      // which is exactly the case the fallbacks exist for.
      if (data?.success === false || data?.error) throw new Error(data?.error?.info || data?.error?.type || 'ipstack error')
      const security = data.security || null
      return {
        geo: normalizeGeo({
          city: data.city, region: data.region_name, country: data.country_name,
          countryCode: data.country_code, postal: data.zip,
          latitude: data.latitude, longitude: data.longitude, timezone: data.timezone?.id,
        }),
        network: normalizeNetwork({
          isp: data.connection?.isp, org: data.connection?.org,
          asn: data.connection?.asn, type: data.connection?.type,
        }),
        security: security ? {
          vpn: flag(security.vpn),
          proxy: flag(security.proxy),
          tor: flag(security.tor),
          relay: flag(security.relay),
          hosting: flag(security.hosting),
          riskScore: num(security.threat_level ?? security.risk_score),
        } : null,
        note: security ? null : 'no security module on this ipstack plan',
      }
    },
  },
  {
    name: 'vpnapi.io',
    configured: () => Boolean(key('VPNAPI_KEY')),
    maxPerDay: 'VPNAPI_MAX_PER_DAY',
    defaultMax: 30, // the free tier is ~1000 a month
    async fetch(ip) {
      const data = await fetchJson(`${VPNAPI_URL}/${encodeURIComponent(ip)}?key=${encodeURIComponent(key('VPNAPI_KEY'))}`)
      if (data?.error) throw new Error(String(data.error))
      const security = data?.security || {}
      const location = data?.location || {}
      const network = data?.network || {}
      return {
        geo: normalizeGeo({
          city: location.city, region: location.region, country: location.country,
          countryCode: location.country_code, postal: location.postal,
          latitude: location.latitude, longitude: location.longitude, timezone: location.timezone,
        }),
        network: normalizeNetwork({
          isp: network.autonomous_system_organization, org: network.organization,
          asn: network.autonomous_system_number, type: network.connection_type,
        }),
        security: {
          vpn: flag(security.vpn),
          proxy: flag(security.proxy),
          tor: flag(security.tor),
          relay: flag(security.relay),
          hosting: null,
          riskScore: null,
        },
      }
    },
  },
  {
    name: 'ip-api.com',
    configured: () => !IPAPI_DISABLED,
    maxPerDay: 'IPAPI_MAX_PER_DAY',
    defaultMax: 900, // 45 requests a minute, so this is a dampener, not a quota
    async fetch(ip) {
      const fields = 'status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,proxy,hosting,mobile,query'
      const data = await fetchJson(`${IPAPI_URL}/${encodeURIComponent(ip)}?fields=${fields}`)
      if (data?.status !== 'success') throw new Error(String(data?.message || 'ip-api error'))
      return {
        geo: normalizeGeo({
          city: data.city, region: data.regionName, country: data.country,
          countryCode: data.countryCode, postal: data.zip,
          latitude: data.lat, longitude: data.lon, timezone: data.timezone,
        }),
        network: normalizeNetwork({ isp: data.isp, org: data.org, asn: data.as }),
        // No dedicated VPN field here: `proxy` covers VPNs and proxies (this is
        // the field they tell you to use for that), and `hosting` flags the
        // datacenter ranges that most consumer VPNs rent.
        security: {
          vpn: flag(data.proxy),
          proxy: flag(data.proxy),
          tor: null,
          relay: null,
          hosting: flag(data.hosting),
          riskScore: null,
        },
        note: 'proxy/hosting flags only, not a dedicated VPN database',
      }
    },
  },
  {
    name: 'proxycheck.io',
    configured: () => Boolean(key('PROXYCHECK_KEY')),
    maxPerDay: 'PROXYCHECK_MAX_PER_DAY',
    defaultMax: 100,
    async fetch(ip) {
      const url = `${PROXYCHECK_URL}/${encodeURIComponent(ip)}`
        + `?key=${encodeURIComponent(key('PROXYCHECK_KEY'))}&vpn=1&risk=1&asn=1`
      const data = await fetchJson(url)
      if (data?.status && data.status !== 'ok') throw new Error(String(data.message || data.status))
      const row = data?.[ip] || {}
      const type = String(row.type || '').toLowerCase()
      const yes = String(row.proxy || '').toLowerCase() === 'yes'
      return {
        geo: normalizeGeo({
          city: row.city, region: row.region, country: row.country,
          countryCode: row.isocode, latitude: row.latitude, longitude: row.longitude,
        }),
        network: normalizeNetwork({ isp: row.provider, org: row.organisation, asn: row.asn }),
        security: {
          vpn: yes && type.includes('vpn'),
          proxy: yes && !type.includes('vpn'),
          tor: yes && type.includes('tor'),
          relay: null,
          hosting: type.includes('hosting') || type.includes('business'),
          riskScore: num(row.risk),
        },
      }
    },
  },
]

// ---- cache ------------------------------------------------------------------

const cache = new Map() // ip -> { at, value }

function cacheGet(ip) {
  if (CACHE_TTL_MS <= 0) return null
  const hit = cache.get(ip)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(ip)
    return null
  }
  // Refresh recency so the eviction below drops the coldest entry.
  cache.delete(ip)
  cache.set(ip, hit)
  return hit.value
}

function cacheSet(ip, value) {
  if (CACHE_TTL_MS <= 0 || CACHE_MAX <= 0) return
  cache.set(ip, { at: Date.now(), value })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

const reverseCache = new Map() // "lat,lon" rounded -> address

// The most recent failure per provider, for /healthz — a key that stopped
// working should be visible without reading the log.
const lastErrors = new Map()

// ---- the lookups ------------------------------------------------------------

/**
 * Everything known about an address: place, network, and whether it looks like a
 * VPN. Returns null for a private/unroutable address or when no provider could
 * answer — the caller records the IP it saw either way.
 */
export async function lookupGeo(ip) {
  if (!isPublicIp(ip) && !ALLOW_PRIVATE) return null
  const address = String(ip).trim()

  const cached = cacheGet(address)
  if (cached) return cached

  for (const provider of PROVIDERS) {
    if (!provider.configured()) continue
    const quota = allowance(provider.name, provider.maxPerDay, provider.defaultMax)
    if (!quota.ok) continue
    spent(provider.name)
    try {
      const result = await provider.fetch(address)
      const value = {
        source: provider.name,
        ...result,
        security: result.security ? { ...result.security } : null,
      }
      cacheSet(address, value)
      return value
    } catch (err) {
      // A provider that is down, rate-limited or misconfigured must not stop the
      // chain — the next one is exactly why it is there.
      lastErrors.set(provider.name, `${err?.message || err}`)
    }
  }
  return null
}

/**
 * The street address for a coordinate, from positionstack. Cached per 3-decimal
 * place (about 100 m), because the answer describes the coordinate, not the
 * visitor.
 */
export async function reverseGeocode(latitude, longitude) {
  const apiKey = key('POSITIONSTACK_API_KEY')
  const lat = num(latitude)
  const lon = num(longitude)
  if (!apiKey || lat == null || lon == null) return null

  const cell = `${lat.toFixed(3)},${lon.toFixed(3)}`
  if (reverseCache.has(cell)) return reverseCache.get(cell)

  const quota = allowance('positionstack', 'POSITIONSTACK_MAX_PER_DAY', intEnv('POSITIONSTACK_MAX_PER_DAY', 500, 0, 1000000))
  if (!quota.ok) return null

  spent('positionstack')
  try {
    const url = `${POSITIONSTACK_URL}?access_key=${encodeURIComponent(apiKey)}`
      + `&query=${encodeURIComponent(`${lat},${lon}`)}&limit=1&output=json`
    const data = await fetchJson(url)
    if (data?.error) throw new Error(String(data.error?.message || data.error?.code || 'positionstack error'))
    const row = Array.isArray(data?.data) ? data.data[0] : null
    const address = row ? {
      label: str(row.label),
      name: str(row.name),
      street: str(row.street),
      number: str(row.number),
      locality: str(row.locality),
      region: str(row.region),
      country: str(row.country),
      postal: str(row.postal_code),
      countryCode: str(row.country_code) ? String(row.country_code).toUpperCase() : null,
    } : null
    reverseCache.set(cell, address)
    return address
  } catch (err) {
    lastErrors.set('positionstack', `${err?.message || err}`)
    return null
  }
}

/**
 * Whether an address should be treated as coming through a VPN. Tor and proxy
 * count: they are the same evasion with a different name. Datacenter/hosting
 * does not, unless VPN_FLAG_HOSTING is set — cloud ranges hold a lot of ordinary
 * visitors, and blocking them would refuse real customers.
 */
export function looksLikeVpn(geo) {
  const security = geo?.security
  if (!security) return null
  const hosting = ['1', 'true', 'yes', 'on'].includes(String(process.env.VPN_FLAG_HOSTING ?? '').toLowerCase())
  const flagged = Boolean(security.vpn) || Boolean(security.proxy) || Boolean(security.tor) || Boolean(security.relay)
    || (hosting && Boolean(security.hosting))
  return flagged
}

// ---- diagnostics ------------------------------------------------------------

export function geoStatus() {
  const providers = PROVIDERS.map(p => {
    const quota = allowance(p.name, p.maxPerDay, p.defaultMax)
    return {
      name: p.name,
      configured: p.configured(),
      usedToday: quota.used,
      maxPerDay: quota.max,
      lastError: lastErrors.get(p.name) || null,
    }
  })
  return {
    providers,
    reverseGeocoder: {
      provider: 'positionstack',
      configured: Boolean(key('POSITIONSTACK_API_KEY')),
      lastError: lastErrors.get('positionstack') || null,
    },
    cache: { entries: cache.size, ttlMinutes: Math.round(CACHE_TTL_MS / 60000) },
    flagHosting: ['1', 'true', 'yes', 'on'].includes(String(process.env.VPN_FLAG_HOSTING ?? '').toLowerCase()),
  }
}

// True when at least one provider can answer without a key, so the feature works
// on a fresh deployment.
export function vpnDetectionAvailable() {
  return PROVIDERS.some(p => p.configured())
}
