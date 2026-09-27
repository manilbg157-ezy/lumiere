# Lumiere

Minimal movie & TV streaming site built with React + Vite.

## Stack
- **React 18** + **Vite**
- **TMDB API** — movie/show metadata, posters, ratings
- **Embed players** (third-party) — NexStream, VidLink, VidLove, VidSrc, 2Embed
- **hls.js** — direct m3u8 streams, loaded lazily only when needed

## Setup (development)

```bash
npm install
npm run dev
```

## Configuration

Copy `.env.example` to `.env` (gitignored) and fill in your own keys:

```bash
VITE_TMDB_KEY=your_tmdb_api_key
VITE_EMBED_API_KEY=your_embed_api_key
```

Where the app *writes* is a separate question, and it has an answer of its own —
see **Storage** below.

Get a free TMDB key at https://www.themoviedb.org/settings/api.

Both are build-time variables that Vite inlines into the bundle, and both are
optional — **nothing is hardcoded**: without `VITE_TMDB_KEY` the browser calls
TMDB through this app's own `/tmdbapi` proxy, which injects the server's
`TMDB_API_KEY` (see below) so the browser bundle never needs or sees a TMDB
key; and without `VITE_EMBED_API_KEY` the NexStream chip is simply not offered
while the keyless embed servers keep playing. Whatever *is* set here ends up in
the shipped JavaScript (the browser has to send it), so never put a real secret
there; that's exactly why accounts and sessions live on the server instead of in
the bundle.

The same `.env` is also read by the server at startup (see `server/env-auto.js`),
which is where server-only settings such as the SMTP credentials live. Anything
already present in the real environment wins, so on AlwaysData you can set a
value in the panel and the file simply stops mattering for that key.

```bash
# server-side only — never bundled, never served
TMDB_API_KEY=your_tmdb_api_key        # enables the /tmdbapi proxy, title-page meta + sitemap titles
SMTP_HOST=smtp-<account>.alwaysdata.net
SMTP_PORT=465
SMTP_USER=you@alwaysdata.net
SMTP_PASS=your-mailbox-password
SMTP_FROM=you@alwaysdata.net

# where accounts and the sign-in trace are written (AlwaysData: /home/lumiere/lumiere)
LUMIERE_MEDIA_DIR=/home/lumiere/lumiere

# IP → place + "is this a VPN?" (both optional; see "Sign-in trace" below)
IPSTACK_API_KEY=your_ipstack_access_key
POSITIONSTACK_API_KEY=your_positionstack_access_key
```

The file sits **outside `dist/`**, so the static handler can't reach it, and
`WAMPYSU_ENV_FILE=off` disables the whole mechanism.

## Project Structure

```
src/
├── lib/
│   ├── api.js              # TMDB + embed URL helpers, source resolution
│   ├── apiBase.js          # API origin + bearer token: the web/app switch
│   ├── auth.js             # client for the /api/auth/* endpoints
│   ├── personal.js         # client for /androidpushservice (feed, lists, …)
│   ├── library.jsx         # My List / likes / saved context for the cards
│   ├── router.js           # URL → view (History API, no router dependency)
│   ├── seo.js              # keeps <title>/description/canonical/OG/robots in step
│   └── useStayOnPage.js    # beforeunload guard, armed only while playing
├── components/
│   ├── Hero.jsx            # The featured card: artwork, tags, Play/List/More Info
│   ├── Card.jsx            # The artwork tile: poster or landscape resume cards
│   ├── Row.jsx             # One scrolling row; variant=ranked/landscape
│   ├── Splash.jsx          # Launch splash (step (i) of the app flow)
│   ├── Icon.jsx            # The whole inline SVG icon set
│   ├── Link.jsx            # real <a> that navigates in-page
│   ├── AuthShell.jsx       # frame shared by /login and /signup
│   ├── GoogleButton.jsx    # "Continue with Google" (hidden unless configured)
│   ├── Player.jsx          # Server chips + iframe/video playback
│   ├── PasswordDialog.jsx  # Change-password modal
│   ├── SeasonPicker.jsx    # Season tabs + episode grid
│   ├── ErrorState.jsx      # Shared inline error with retry
│   ├── ui/                 # primitives: Button, Field
│   └── *.module.css
├── pages/
│   ├── Home.jsx            # The personalised feed + featured card
│   ├── Browse.jsx          # Movies / TV Shows / New & Popular (one page)
│   ├── Search.jsx          # Netflix list layout, play discs
│   ├── MyHome.jsx          # Profile hub: activity, liked, list, saved
│   ├── Saved.jsx           # Smart Saves + saved titles (was Downloads.jsx)
│   ├── Notifications.jsx   # Derived from real activity
│   ├── Welcome.jsx         # Onboarding: name, description, Sign up / Sign in
│   ├── History.jsx         # Continue Watching, full size
│   ├── Title.jsx           # One movie/series at its own URL
│   ├── Login.jsx           # Sign in (own page)
│   ├── Signup.jsx          # Create account (own page, shares AuthShell)
│   ├── Forgot.jsx          # Ask for a reset link
│   ├── Reset.jsx           # Choose a new password (from the emailed link)
│   └── *.module.css
├── App.jsx                 # Shell (top bar, chips, tab bar) + routing
├── App.module.css
├── main.jsx
└── index.css               # Netflix theme tokens + global reset

server/
├── auth-core.js         # signup/login/session/logout, resets, accounts, history
├── storage.js           # where the media root, accounts/ and tracing/ are
├── geoip.js             # IP → place, network and VPN flag (providers + fallbacks)
├── tracing.js           # the sign-in trace: one JSONL line per sign-in
├── google.js            # Google Sign-In: OAuth code+PKCE flow, ID-token verification
├── mail.js              # dependency-free SMTP client + background send queue
├── captcha.js           # reCAPTCHA v2 verification (no-op when unconfigured)
├── auth-plugin.js       # the same routes as Vite dev middleware
├── tmdb.js              # server-side TMDB (sitemap titles + title-page meta tags)
├── tmdb-lists.js        # the list endpoints the sitemap walks
├── crypt.js             # at-rest encryption for the data stores
├── androidpushservice.js # the /androidpushservice router (mounted by server.js)
├── personalize.js       # watch activity → the personalised feed
└── prefs-store.js       # encrypted My List / likes / saved / devices

test/
├── backend.test.mjs  # auth + proxy + app-backend integration tests (`npm test`)
└── dist.test.mjs     # verifies the built dist/ (skips without a build)

.env.example            # template for the optional build-time + server-side keys
.env                    # your real values (gitignored; the server reads it too)

tools/
├── generate-icons.mjs  # app icons (`npm run icons`)
└── avatar-sync.sh      # mirror the profile photos off-box with rclone

docs/
└── avatar-storage.md   # keeping the photos in sync off the host

public/                 # static extras copied into dist/ as-is
├── icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png
├── apple-touch-icon.png, favicon.ico
└── manifest.webmanifest
```

## Storage — where everything is written

One directory holds everything that is not the build. It is `LUMIERE_MEDIA_DIR`
(the default is `~/media/lumiere`; on AlwaysData set it to `/home/lumiere/lumiere`):

```
~/media/lumiere/
├── accounts/
│   ├── accounts.json         # one row per account (sealed)
│   ├── sessions.json         # live sessions (hashed tokens)
│   ├── resets.json           # pending password resets
│   ├── verify.json           # emailed verification codes
│   ├── history.json          # continue-watching rows
│   └── <accountId>/          # one folder per account
│       ├── record.json       # that account's own row, sealed the same way
│       └── avatar.png|jpg    # their photo, if they have one
└── tracing/
    ├── 2026-09-27.jsonl      # one line per sign-in, whole site
    └── accounts/<id>.jsonl   # the same lines, for one account
```

`<accountId>` is the same HMAC pseudonym the stores are keyed by, so a folder name
identifies an account to the operator without printing an address into a
directory listing, and the folder holds exactly the sealed row the index holds —
a second copy of the ciphertext, not a second copy of the account in the clear.
Deleting an account removes its folder with it.

The app's `prefs.json` (My List, likes, saved titles, devices) and the at-rest
master key stay in `WAMPYSU_DATA_DIR` (`./data` by default) — the key file is
never moved, because a new path is a new key and a new key means every existing
account becomes unreadable.

A store found in the old location (`./data/accounts.json` and friends) is copied
into `accounts/` on the first boot after the move; the old file is left where it
is, so putting the previous version of the code back still finds its data.

## Design system

The look is a Netflix-style OTT dark theme, lit rather than flat: a **black
canvas with an ambient light layer drifting behind every page, liquid-glass
surfaces, white text and one accent — the Lumiere brand gold** (`#f0b429`).
`src/index.css` sets the black background on `html`.

Two things make the glass consistent across pages instead of per component:

- **The surface palette is translucent.** `--bg-2`, `--bg-3`, `--bg-card` and
  `--bg-input` are the fills every panel already used, so turning them into
  translucent colours makes the whole app see-through at once — no component had
  to change.
- **`--glass-surface` bundles the treatment.** A panel adopts the whole thing in
  two lines:

  ```css
  background: var(--glass-surface);   /* sheen + fill + refracting rim */
  border: 1px solid transparent;      /* the rim is the gradient border-box */
  ```

  The gradient rim is painted by `background-clip: border-box` underneath a
  transparent 1px border, which is how a rounded corner gets a lit edge without a
  pseudo-element. On hover, or when a panel needs a coloured ring, use a
  `box-shadow` — setting `border-color` would paint over that rim.

The light behind the pages is one fixed layer (`.ambient` in `src/index.css`),
painted once and animated on the compositor with `transform` only, so it costs
nothing per frame or per scroll. It is what the translucent panels refract; it is
held still under `prefers-reduced-motion: reduce`, and the panels go nearly
opaque under `prefers-contrast: more`, because legibility outranks the effect.

Tokens (all in `:root`) — use these instead of raw colours:

| Token | Use |
|---|---|
| `--bg`, `--bg-2`, `--bg-3`, `--bg-card`, `--bg-input` | the black canvas and its raised surfaces (all translucent except `--bg`) |
| `--glass`, `--glass-2` | plain translucent fills: chips, hover states, input wells |
| `--glass-panel`, `--glass-panel-strong`, `--glass-panel-soft` | the fill inside a glass surface, by how much has to stay legible on it |
| `--glass-surface`, `--glass-surface-strong`, `--glass-surface-soft` | the whole treatment: top sheen + transluent fill + refracting gradient rim |
| `--glass-filter`, `--glass-filter-lg` | the `backdrop-filter` to pair with a surface (blur + saturate + a touch of brightness) |
| `--glass-glow` | the faint inner light that keeps a large panel from looking grey |
| `--light-gold`, `--light-warm`, `--light-cool`, `--light-rose` | the ambient layer's four washes |
| `--glass-border`, `--glass-border-hi`, `--border`, `--border-hover` | hairlines; `-hi`/`-hover` for hover |
| `--text`, `--text-muted`, `--text-dim` | the three text weights |
| `--radius-sm`, `--radius`, `--radius-lg`, `--radius-card`, `--radius-pill` | corner scale |
| `--accent`, `--accent-hover`, `--accent-soft`, `--accent-glow` | the brand gold, with `--accent-ink` for text laid on it |
| `--gold` | the rating-star gold |
| `--focus` | the visible keyboard-focus ring |

Rules of thumb: `--accent` is a light gold, so never lay white text on it — use
`--accent-ink`. The blur steps are `--glass-blur-sm` (12px), `--glass-blur`
(22px) and `--glass-blur-lg` (34px), baked into `--glass-filter*`. Because
`backdrop-filter` only blurs what is *behind* the element, a panel needs a
translucent fill as well as the blur, and any animated transition should be on
`opacity`/`background`/`box-shadow` rather than on `backdrop-filter` itself (it
is expensive to animate). Individual surfaces still set their own blur where the
whole 22px would be too heavy — a search field or a chip, say. Never put text
directly on artwork without a gradient scrim (see `Hero.module.css`). Browsers
without `backdrop-filter` fall back to a translucent fill and no blur (`@supports
not (backdrop-filter: ...)`), which keeps the look at full speed on old GPUs.

The mark is a gold tile with a dark **"L"**, drawn by `tools/generate-icons.mjs`
(which renders and then re-decodes its own output to check the pixels are right),
and the inline glyph appears in `Splash`, `AuthShell`, `Welcome` and the header.

Shared primitives live in `src/components/ui/` (`Button` in primary / light /
ghost, sizes `md` and `lg`, `Field`), and the auth pages share `AuthShell`.

## Features

### Netflix-style interface

The whole UI was restyled to follow the Netflix app screen for screen, from ten
reference screenshots — screen by screen, with what was taken from each, is
screen by screen, from ten reference screenshots (the image files themselves were
reference material and have since been removed). The web app and the Android app
render the same build.

- **Home** (`/`) — the featured card with its genre tag line and the three
  actions the app shows (Play / My List / More Info), then the rows: Continue
  Watching, "Because you watched …", Today's Top Picks for You, Top 10 with the
  big rank numerals, and the popularity rows. **Play** starts the title — it
  navigates with `history.state.autoplay`, which the title screen reads — while
  **More Info** opens the page without playing
- **Scroll-reactive top bar** — transparent while it sits over the featured
  artwork on Home, then cross-fades to opaque black with a shadow once the page
  scrolls. The chips row under it stays black
- **Hover quick actions** — on pointer devices, hovering a poster in a row lifts
  it and overlays **Play** and **Add to My List**, so neither needs a trip to the
  title page. The overlay is absent entirely under `@media (hover: none)`, which
  is what the phone builds get
- **Maturity badge** — the title page prints the certification ("R", "TV-MA") in
  a bordered box beside the year, resolved by `maturityRating()` from TMDB's
  `release_dates` / `content_ratings` (US first, then the first region that has
  one). Rows intentionally omit it: TMDB does not return a certification in list
  responses, so a badge per tile would cost a request per tile
- **Personalised feed** — built from this account's own watch history and likes
  by `server/personalize.js`. Genre affinity is counted across the
  most recent titles (newest weighted highest), then used for a TMDB discover
  query and a "because you watched" row. Signed-out visitors get the plain
  popularity rows, and a visible line on Home says what the feed was built from
- **Chips** under the title (Home / TV Shows / Movies / New & Popular) and a
  floating **bottom tab bar** on phones — Home, Search, My Home. There is
  deliberately no Clips tab. The Categories dropdown that used to sit at the end
  of this row, its 32 `/category/:slug` pages and `src/lib/categories.js` were
  removed; an old `/category/…` link falls back to Home the way any unknown path
  does
- **Search** (`/search`) — the Netflix list layout: wide thumbnail, title, and a
  circular play button that starts playback directly
- **My Home** (`/my-home`) — profile header, the Saved card, Continue
  Watching, "Shows & Movies You Have Liked" with per-title Share, My List, and
  Recently Watched. The "Start saving titles to watch" block is gone: the screen
  shows its real content and nothing more
- **Notifications** (`/notifications`) — derived from real activity (an upcoming
  episode of a series in progress, a recommendation seeded from history),
  never invented
- **Saved** (`/saved`) — Smart Saves and the saved-titles list. The empty state
  ("Start saving titles to watch", its tilted-card illustration and Set up
  button) has been removed; when nothing is saved the screen simply lists
  nothing. See the honest note below about what a WebView can and cannot store
- **Onboarding** (`/welcome`) — splash, then the app name and description with
  **Sign up** / **Sign in** in the lower half and a **Keep me logged in** switch
- Black canvas, flat grey chips, one accent (`--accent`, now the brand gold
  `#f0b429`). Every CSS variable name was kept, so component stylesheets
  survived both the restyle and the rename
- `/login` and `/signup` as separate pages sharing one auth shell, both with the
  **Keep me logged in** switch and — when the server holds Google
  credentials — a **Continue with Google** button

> **On saving, honestly:** every title plays through a third-party embed
> player (VidSrc/2Embed/VidLink…), and a WebView cannot copy a stream out of
> another origin's iframe — so no video file is ever stored. The Saved
> screen keeps the app's own offline list (saved titles, artwork, resume point)
> and says so on screen. Real offline video would need direct streams from the
> `TMDBEA_UPSTREAM`/`CINEPRO_UPSTREAM` backends, which are not configured here.

### Everything else
- `/login` and `/signup` as separate pages sharing one auth shell, with
  **Sign in with Google** alongside the password form (see the section below)
- Trending movies & TV shows on load
- Live search via TMDB
- **Every movie and series has its own page**: `/movie/:id` and `/tv/:id`,
  shareable and linkable, with details, episodes and recommendations
- **Browsing is public** — anyone can read the library and title pages; an account
  is only needed to play
- **Continue watching (History)** — at `/history`, and as the first row of Home.
  Shows what the signed-in account played recently as landscape tiles with
  progress bars, most recent first. Clicking a tile opens the title and starts
  playback where you left off — for series it reopens the same season/episode,
  and for direct streams it seeks to the stored second. Items watched past 95%
  drop out automatically; tiles can be removed (✕). Progress is kept
  server-side per account (`data/history.json`), persisted across restarts, and
  never exposed to other visitors
- **My List, likes and saved titles** — saved per account in `prefs.json`
  (encrypted like the other stores) and offered from every card, the hero, the
  title page and the app, through one shared context (`src/lib/library.jsx`)
- **The sign-in trace** — every sign-in and sign-up is written as one JSON line
  to `tracing/YYYY-MM-DD.jsonl` and to that account's own
  `tracing/accounts/<id>.jsonl`: the address it came from, the place, the
  network, and whether it looked like a VPN, proxy or Tor exit. Off the request,
  never awaited. See **Sign-in trace** below
- **VPN detection, and optional blocking** — `VPN_BLOCK_MODE=block` refuses
  sign-in and sign-up from a flagged address, on the form, the app's sign-in and
  the Google round trip alike. The default (`flag`) records it and lets them in,
  because a false positive locks a real customer out
- **The app backend** — `/androidpushservice` (`server/`): sign-in
  that returns a bearer token, the personalised feed, notifications, My List,
  likes, saved titles and device registration, in one namespace the Android app
  talks to
- **Support button** — sits left of the Sign in pill in the header (signed-out
  visitors) and opens a small glass popover on the same page with the contact
  email and a one-tap **Copy email** button ("Copied ✓" confirmation, with a
  legacy fallback for browsers that block the clipboard API). On narrow screens
  the popover becomes a sheet pinned below the header so it never runs off-screen
- TV: pick season & episode on the show's page, hit Play
- Skeleton loading states, and error states with one-tap retry everywhere
- Hardened accounts server: revocable server-side sessions, per-account login lockout, same-origin enforced auth API, and Google sign-in that verifies the ID token rather than trusting the redirect
- Crawler-ready: `robots.txt` allows everything, `sitemap.xml` lists the libraries
  and every title, and title pages ship real `<title>`/`<meta>`/OG tags in the
  initial HTML — no JavaScript needed to read them
- **Welcome email** — a new account gets one hand-designed message, sent once at
  the moment it is created (a Google signup gets it too, on its first sign-in).
  Dark card, gold wordmark, one link back into the app and no tracking or images,
  so it looks the same in Gmail, Outlook and on a phone. Handed to the same
  background queue as the reset mail, so a slow mailbox never slows a signup
- **User Settings** (`/settings`, from the account menu) — change the email
  address, change or set the password, link or unlink a Google account, change the
  gender and date of birth, or **delete the account permanently**. Every change is
  proved by a **six-digit code mailed to the account**, and moving to a new
  address needs a code from *both* ends — the address it has and the address it is
  moving to — so a typo cannot strand anybody. A move carries the watch history
  and the app's lists with it and signs every other device out; deletion purges
  the account, its sessions, its codes, its history, its avatar and its registered
  devices, then lets the address be registered again. Unlinking Google is refused
  while it is the only way in
- **CAPTCHA on both auth forms** (optional) — with `RECAPTCHA_SITE_KEY` and
  `RECAPTCHA_SECRET` set, sign-in, sign-up and the Google button all need a solved
  reCAPTCHA v2 widget, re-checked on the server so a request without one is
  refused. The widget is rendered explicitly and **reset in place** between
  attempts — never remounted, which is what leaves a blank CAPTCHA and a token
  that never arrives — loaded once and shared by `/login` and `/signup`, and
  backed by **Try again** when the script cannot be fetched. Add every hostname
  to the key's Domains list, or Google refuses to render at all
- **Forgot password** — "Forgot your password?" on the login page emails a
  single-use, one-hour reset link. Finishing the reset signs out every other
  device and lands you back on the site signed in. The request endpoint answers
  identically for every address, so it can't be used to find out who has an
  account
- Change password from the account menu — rotates your session and signs other
  devices out. An account made with Google has none to change, so the same entry
  reads **Set a password** and asks only for the new one
- **Sign out always ends the visit** — the session is revoked server-side and the page
  then fully reloads, so a video that is still playing (embed or direct stream) stops
  immediately and every cached page state is dropped. The reload bypasses the
  player's "Leave site?" guard on purpose (see `allowNextUnload` in
  `src/lib/useStayOnPage.js`)
- Fully responsive (bottom tab bar, safe-area aware, no tap-zoom on inputs)
- Accessible by default: a skip-to-content link past the persistent sidebar, a
  billboard that holds still while you read it (pauses on hover/focus, when the
  tab is hidden, under `prefers-reduced-motion`, and on demand via a pause
  button), WCAG-AA body text contrast, visible keyboard focus everywhere —
  including the row scroll arrows, which only reveal themselves otherwise — and
  a `prefers-contrast: more` mode

## Routes

| URL | Page | Indexed |
|---|---|---|
| `/` | Home — the personalised feed | Yes |
| `/movies` | Movies library (hero + rows) | Yes |
| `/tv` | TV Shows library | Yes |
| `/new` | New & Popular | Yes |
| `/search` | Search | No |
| `/my-list` | My List | No |
| `/my-home` | Profile hub (activity, lists, saved) | No |
| `/my-netflix` | Same screen under its old name (rewrites to `/my-home`) | No |
| `/settings` | User Settings — email, password, Google, profile, deletion | No |
| `/saved` | Saved — titles kept for later | No |
| `/downloads` | Same screen under its old name (rewrites to `/saved`) | No |
| `/notifications` | Notifications | No |
| `/history` | Continue watching | No |
| `/welcome` | Onboarding (the app opens here when signed out) | No |
| `/movie/:id` | One movie — details, play, recommendations | Yes |
| `/tv/:id` | One series — details, seasons/episodes, play, recommendations | Yes |
| `/login` | Sign in (its own page) | No |
| `/signup` | Create an account (its own page) | No |
| `/forgot` | Ask for a password-reset link | No |
| `/reset/:token` | Choose a new password (token from the emailed link) | No |

The account-scoped screens set `noindex, nofollow` themselves (`src/lib/seo.js`),
and `/sitemap.xml` lists `/`, `/movies`, `/tv`, `/new` plus every title — so the
private screens are never advertised. `/movies` used to redirect to `/`; it is a
real route now (the Movies library moved there when Home took over `/`).
Anything unrecognised falls back to Home, exactly like the server's SPA fallback.
- Multi-source playback: five embed servers (NexStream, VidLink, VidLove, VidSrc,
  2Embed) as switchable chips, plus direct streams when the TMDB-Embed-API /
  CinePro backends are configured. A dead direct stream auto-hops to the next server.

## Deploying to AlwaysData (production)

The production build is one Node process that serves the static app, the
auth API, and the TMDB proxies — no separate web server or reverse proxy
config needed.

1. **Build locally** (on your own machine — not on the shared host, where
   `npm ci` is slow and Vite builds can hit the memory limit):
   ```bash
   npm ci
   npm run build
   ```
2. **Upload what the server needs** to e.g. `/home/lumiere/lumiere`:
   `dist/`, `server/`, `server.js`, `package.json`, `index.html`, `src/`,
   `vite.config.js` (source is not required, but keeping it there makes the
   mount usable for edits).
3. In the AlwaysData admin: **Web > Sites > Add a site** → type **Node.js**:
   - **Command:** `node /home/lumiere/lumiere/server.js`
   - **Working directory:** `/home/lumiere/lumiere`
   - The app automatically listens on the **`PORT`/`HOST`** env vars AlwaysData provides.
4. Start the site. **Do not run `npm install` on the server** — the Node process
   has zero runtime dependencies (React/hls.js are bundled into `dist/`, and
   `npm test` uses Node's built-in runner). On AlwaysData `npm ci` also fails
   with `EIO` because the home directory can't create symlinks, so skip it.

Notes:
- Accounts are stored in `data/accounts.json` and sessions in `data/sessions.json` on the server — `data/` is gitignored, so create it there or let the app create it on first signup.
- Sessions are HttpOnly cookies holding an opaque 256-bit token. Only the token's SHA-256 is persisted, sessions survive a restart, and logging out revokes the session server-side.
- The five embed servers need no backend and work on shared hosting as-is. The direct-stream backends (`/tmbea`, `/cinepro`) don't exist there: set `TMDBEA_UPSTREAM` / `CINEPRO_UPSTREAM` if you run TMDB-Embed-API (`:8787`) or CinePro (`:3000`) somewhere reachable, otherwise those routes answer 503 and only the embed chips show.
- `GET /healthz` is a bare liveness probe — `{ ok, uptimeSec }` and nothing else — so it is safe to leave public for an uptime checker. The operator diagnostics (data directory on disk, mailbox host, circuit-breaker state, rate-limit ceilings, the probe's own cookie names) are unlocked by setting `HEALTH_TOKEN`: with it set, the probe must send `x-health-token: <value>` (or `?token=<value>`) and anything else gets 401. `storage.writable` being false is the usual reason signups fail on shared hosting — see **Reliability** below.
- Crawlers are welcome: `robots.txt` allows everything (`User-agent: *` / `Allow: /`) and links the sitemap; `sitemap.xml` lists `/`, `/tv` and every title the site surfaces, all as absolute URLs built from the request's own host, so no domain is hardcoded. Title pages get their own `<title>`, description, canonical and OG tags injected into the HTML server-side, so scrapers that don't run JavaScript see real content. Set **`TMDB_API_KEY`** (see below) so those lookups work; without it the pages still load, they just keep the generic tags. Drop your own `robots.txt` / `sitemap.xml` into `public/` to take over either one.
- If you ever host the `dist/` build as plain static files instead (no Node), the app still works: TMDB calls and images fall back to hitting TMDB directly from the browser.

### Rolling back a UI change

**The project is under version control.** The `backup/` folders are gone, and so
is the throwaway local history that replaced them — the repository is now a
fresh one, synced to GitHub (see **Version control** below):

```bash
git status                 # what changed since the last commit
git diff                   # exactly what changed
git checkout -- src/       # throw away uncommitted edits to the UI
git log --oneline          # every state you have committed
```

To go back to an older *committed* state, check that commit's files out, or
`git revert` the change you want undone. `dist/` (and the app's bundled UI, once
the Android project is recreated — §20) are **build outputs**, deliberately not
tracked: after checking out an older `src/`, run the build again and it
reproduces that state exactly.

Commit before anything large. That is the whole discipline, and it replaces
folder copies with one command.

### Building when `node_modules` is on a shared host

`npm install` needs symlinks, which the AlwaysData home directory (and anything
mounted over SFTP/FUSE) refuses — you'll see `EIO` on `.bin`. Build **elsewhere**
and copy `dist/` up:

```bash
cp -r src public server test index.html package.json package-lock.json \
      vite.config.js server.js /tmp/lumiere-build/
cd /tmp/lumiere-build && npm ci && npm run build
cp -r dist/. /home/lumiere/lumiere/dist/
```

### Environment variables

Everything is optional — the defaults are tuned for AlwaysData.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `5173` / `0.0.0.0` | Set by AlwaysData |
| `TMDBEA_UPSTREAM` / `CINEPRO_UPSTREAM` | unset | Direct-stream backends; unset means those routes answer 503 |
| `LUMIERE_MEDIA_DIR` | `~/media/lumiere` | The media root: `accounts/` and `tracing/` are created inside it. On AlwaysData set it to `/home/lumiere/lumiere`. Falls back to `./data` if the directory cannot be created |
| `LUMIERE_ACCOUNTS_DIR` / `LUMIERE_TRACING_DIR` | inside the media root | Override either directory on its own (e.g. keep the trace on a different volume from the account store) |
| `WAMPYSU_DATA_DIR` | `./data` | The older override. It still holds `prefs.json` and the at-rest master key, and it is also read as the media root when `LUMIERE_MEDIA_DIR` is unset — which is how the test suite keeps everything in one temp directory |
| `WAMPYSU_DIST` | `./dist` | Static build to serve |
| `WAMPYSU_ENV_FILE` | `./.env` | Server-side settings file, loaded before anything reads the environment. Set to `off` to disable. Real environment variables always win |
| `SESSION_DAYS` | `30` | Session lifetime (sliding, renewed at most daily) |
| `SESSION_KEEP_DAYS` | `180` | Lifetime for a session signed in with **Keep me logged in** — the switch on the app's onboarding and sign-in screens |
| `TMDB_API_KEY` | *(none)* | Also powers the app's personalised feed (`/androidpushservice/feed`). Without it the feed returns its popularity rows instead of tailored ones |
| `FEED_SEED_LIMIT` | `5` | How many recent titles are inspected for genre affinity |
| `FEED_MAX_ROWS` | `12` | Cap on the rows one feed response may carry |
| `FEED_CACHE_TTL_MS` | `21600000` | How long the feed's TMDB lookups are cached in memory |
| `FEED_TMDB_TIMEOUT_MS` | `4500` | How long one feed TMDB call may take before that row is skipped |
| `TRUST_PROXY` | `1` | Read the real client IP from `X-Forwarded-For` (set `0` if the app is exposed directly, or all visitors share one rate-limit bucket) |
| `ALLOWED_ORIGINS` | unset | Extra hostnames allowed to POST to the auth API |
| `MAX_LOGIN_FAILURES` | `8` | Failures per account per 15 min before that account is temporarily locked |
| `SIGNUPS_PER_IP_HOUR` / `SIGNUPS_PER_HOST_HOUR` | `10` / `100` | Signup throttles |
| `LOGINS_PER_IP_15MIN` | `30` | Login attempts per IP |
| `TMDB_TIMEOUT_MS` / `STREAM_TIMEOUT_MS` | `20000` / `120000` | Upstream time-to-first-byte, not total duration — a movie may keep streaming for hours |
| `MAX_PROXY_STREAMS` / `PROXY_QUEUE_WAIT_MS` | `128` / `15000` | Concurrent upstream stream slots; beyond that a request queues, then answers 503 + `Retry-After` |
| `REQUEST_TIMEOUT_MS` | `120000` | Time allowed to receive a whole request (headers + body) |
| `STORAGE_PROBE_INTERVAL_MS` | `60000` | How often `/healthz` re-checks that the data dir is still writable |
| `RATE_LIMIT_SWEEP_MS` | `300000` | How often the in-memory rate-limit and failure maps are swept |
| `LOG_DEDUPE_MS` | `60000` | Window in which identical error lines collapse into one |
| `SMTP_HOST` / `SMTP_PORT` | unset / `465` | Mail server for the welcome and password-reset mail. AlwaysData: `smtp-<account>.alwaysdata.net`. Nothing is sent, and the boot log says so, until `SMTP_HOST` **and** `SMTP_FROM` are set |
| `SMTP_USER` / `SMTP_PASS` | unset | Mailbox login — on AlwaysData the full address and its password. Auth is skipped entirely when `SMTP_USER` is empty |
| `SMTP_FROM` / `SMTP_FROM_NAME` | unset / `Lumiere` | The sender both kinds of mail come from |
| `SMTP_SECURE` | from the port | `implicit` (465), `starttls` (587), or `none` for a local relay or the test suite |
| `PUBLIC_ORIGIN` | from the request | Only needed if reset links should use a different hostname than the one the visitor is on — and the value the Google redirect URI is built from when a proxy forwards an unexpected `Host` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Google Sign-In. **Both** are needed; until they are set no Google button is shown and `/api/auth/google/start` answers 501 |
| `GOOGLE_REDIRECT_URI` | derived | Override the callback URL. Only for a deployment behind something that rewrites the origin |
| `GOOGLE_STARTS_PER_IP_HOUR` / `GOOGLE_CALLBACKS_PER_IP_HOUR` | `30` / `60` | Throttles on beginning and completing a Google sign-in |
| `VERIFY_TTL_MINUTES` | `10` | How long an emailed verification code stays valid (the settings screen) |
| `VERIFY_MAX_ATTEMPTS` | `5` | Wrong codes allowed against one code before it is thrown away |
| `VERIFY_CODES_PER_EMAIL_HOUR` / `VERIFY_CODES_PER_IP_HOUR` | `10` / `30` | Code-request throttles, per account and per visitor |
| `EMAIL_CHANGES_PER_IP_HOUR` / `ACCOUNT_DELETES_PER_IP_HOUR` | `10` / `5` | Throttles on moving an account to a new address and on deleting one |
| `RESET_TTL_MINUTES` | `60` | How long a reset link stays valid |
| `RESET_COOLDOWN_SECONDS` | `60` | Minimum gap between reset mails to the same address |
| `RESET_REQUESTS_PER_IP_HOUR` / `RESET_REQUESTS_PER_EMAIL_HOUR` | `5` / `3` | Reset-request throttles — always answered the same way, never with an error |
| `RESETS_PER_IP_HOUR` | `10` | Attempts at actually completing a reset |
| `TMDB_API_KEY` | *(none)* | Server-side TMDB key, never hardcoded. Injected by the `/tmdbapi` proxy into outgoing queries (so the browser bundle needs no TMDB key) and used for title-page meta tags and the per-title sitemap URLs. Unset: proxied TMDB calls fail upstream, title pages keep the generic tags and the sitemap lists just the two libraries |
| `TMDB_API_BASE` | `https://api.themoviedb.org` | Override the TMDB host (used by the test suite) |
| `TMDB_META_TIMEOUT_MS` | `4000` | How long a title page may wait for its meta tags before serving the generic ones |
| `TMDB_META_TTL_MS` / `TMDB_LIST_TTL_MS` | `21600000` (6h) | How long title details / the sitemap's title list are cached in memory |
| `SITEMAP_MAX_TITLES` | `500` | Cap on title URLs in the sitemap (`0` disables them) |
| `WAMPYSU_CSP` | unset | Set to `off` to drop the Content-Security-Policy header |
| `HEALTH_TOKEN` | unset | Unlocks — and guards — the `/healthz` operator diagnostics. Unset, the probe answers `{ ok, uptimeSec }` only; set, probes must send `x-health-token: <value>` (or `?token=<value>`) or get 401 |
| `IPSTACK_API_KEY` | unset | Primary IP → place/network/VPN lookup for the sign-in trace. The free plan is HTTP-only (set `IPSTACK_URL=https://api.ipstack.com` on a paid one) and tiny, so `IPSTACK_MAX_PER_DAY` caps it and the fallbacks answer after that |
| `POSITIONSTACK_API_KEY` | unset | Turns the latitude/longitude into a street address. Cached per ~100 m and capped by `POSITIONSTACK_MAX_PER_DAY` (default 500) |
| `VPNAPI_KEY` / `PROXYCHECK_KEY` | unset | Two more VPN/proxy databases, tried in that order when ipstack cannot answer |
| `GEO_DISABLE_IPAPI` | unset | Set to `1` to stop the suite/deployment calling ip-api.com, which is free **for non-commercial use only** — a commercial deployment should set this |
| `VPNAPI_MAX_PER_DAY` / `PROXYCHECK_MAX_PER_DAY` / `IPAPI_MAX_PER_DAY` | `30` / `100` / `900` | Daily ceilings per provider; `0` disables a provider entirely |
| `VPN_BLOCK_MODE` | `flag` | `flag` records a VPN on the trace and lets the visitor in; `block` refuses sign-in and sign-up from one (`403`, and a redirect for the Google round trip) |
| `VPN_BLOCK_MESSAGE` | a sensible sentence | The wording shown when a VPN is refused |
| `VPN_FLAG_HOSTING` | unset | Set to `1` to also treat datacenter/hosting ranges as VPNs. Off by default: cloud ranges hold plenty of ordinary visitors |
| `TRACING` | `1` | Set to `0` to write no sign-in trace at all |
| `TRACE_KEEP_DAYS` | `180` | How long daily trace files are kept (the per-account file lives as long as the account) |
| `GEO_TIMEOUT_MS` / `GEO_CACHE_MINUTES` | `4000` / `360` | Per-lookup timeout and how long one address's answer is reused |
| `WAMPYSU_MASTER_KEY` | *(none)* | Master key for at-rest encryption. When unset, one is generated once into `data/.wampysu-key` (chmod 600) and reused. Back it up — losing it makes the encrypted stores permanently unreadable |
| `WAMPYSU_ENCRYPT` | `1` | At-rest encryption for the data stores (see **Data at rest** below). Set to `0` to store everything in the old plaintext shapes |

### Security model

- Passwords: salted scrypt (64-byte digest), timing-safe compare, hashed off the event loop; minimum 8 characters.
- Sessions: opaque random tokens, stored hashed, revocable, `HttpOnly` + `SameSite=Lax` + `Secure` on HTTPS (using the `__Host-` prefix there).
- Login timing does not reveal which emails exist (unknown accounts still burn one scrypt).
- Failed logins are counted per account, not just per IP, so one account can't be brute-forced from many addresses — and a shared NAT doesn't lock everyone out. The same counter guards the change-password endpoint, so it can't be used as an easier way to guess a password.
- Changing a password re-hashes it, rotates the current session and revokes every other session for that account. At most 10 sessions per account are kept (oldest first out), and expired ones are pruned on each write.
- Reset links are bearer credentials for an account, so they get session-grade treatment: only the SHA-256 of the token is stored, they expire in an hour, they are single-use, asking again invalidates the previous link, and completing one revokes every session for that account. The request endpoint never reveals whether an address is registered — unknown addresses burn the same scrypt work so the response time matches too.
- Google sign-in trusts nothing the browser sends back. The `state` and the PKCE verifier travel in a signed, `HttpOnly`, ten-minute cookie; the ID token's signature is checked against Google's published keys, and so are the issuer, the audience (our own client id), the lifetime, the nonce and `email_verified`. The client secret, the access token and the ID token never reach the browser, and the access token is not stored at all.
- An account that only ever used Google has no password hash: signing in with a password against it burns the same scrypt work as a wrong password and fails, and the same per-account lockout applies, so Google is not a way around it.
- Reset mail is sent from a background queue, never inside the request, so a slow or dead mail host can't slow the auth API or leak, by timing, which addresses exist. Bodies are base64-encoded, which sidesteps dot-stuffing and 8-bit transport in one go.
- Auth POSTs must be same-origin, responses are `no-store`, and the API only accepts JSON.
- The server sets `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS on HTTPS, and a CSP that blocks inline/eval scripts (loose only where the app genuinely needs it: third-party player iframes and arbitrary media hosts).
- Upgrade note: sessions from before this change (the cookie used to contain the raw email) are ignored, so everyone signs in once more.

### Reliability

The process is built to keep serving through the things that usually take a
single-process app down, and to say why when it can't.

- **A client hang-up is not a crash.** The request and response streams carry
  their own `error` listeners, so a closed tab, a reset connection or a stalled
  crawler is logged (throttled) instead of becoming an uncaught throw.
- **Nothing grows without bound.** The proxy runs at most `MAX_PROXY_STREAMS`
  upstream transfers at once and queues the rest (503 + `Retry-After` past
  `PROXY_QUEUE_WAIT_MS`); the rate-limit and failure maps are swept on write and
  on a timer; the TMDB caches are capped.
- **Upstream trouble is isolated.** Every TMDB and stream call has a
  time-to-first-byte timeout, and TMDB lookups sit behind a circuit breaker, so a
  dead upstream degrades the site instead of hanging it.
- **Fatal errors exit cleanly.** An uncaught exception is logged and routed
  through the same graceful shutdown as `SIGTERM` — stop accepting, close idle
  connections, 10s grace for in-flight streams — so the supervisor restarts a
  clean process. An unhandled rejection is logged and is *not* fatal.
- **Storage failures are named.** If the data dir goes read-only or full, the
  auth API answers 503 + `Retry-After` instead of a bare 500, `/healthz` reports
  `storage.writable: false`, and the change is logged once.
- **Logs can't flood.** Identical errors inside `LOG_DEDUPE_MS` collapse into one
  line with a suppressed count.

`GET /healthz` answers in one of two shapes, and which one you get is the whole
point of `HEALTH_TOKEN`.

**Unset (the default)** it is a liveness probe and nothing more:

```json
{ "ok": true, "uptimeSec": 1146 }
```

That is deliberate. The endpoint has no authentication, so everything it says is
said to the internet — and the diagnostics below name a path on disk, the mailbox
host and its delivery counters, whether the TMDB key is present, which upstream
backends exist, the rate-limit ceilings, and the cookie names a visitor sends. A
scanner or a crawler asking for `/healthz` should learn none of that.

**Set** it, and the same request returns the whole maintenance surface *to the
caller that presents it*: `ok`, `uptimeSec`, `pid`, `node`, `memory`, `backends`,
`storage` (`dir` + `writable`), `crypto`, `proxy` (`active` / `queued` / `max`),
`limits`, `tmdb` (circuit breaker + cache sizes), `mail` (`configured`, host,
queue depth, sent/failed counts), `android`, `google`, and `request` — the shape
of the probe itself (`scheme`, `host`, `forwardedProto`, `cookieNames`). Without
the token that request is answered `401` with `{ error }` and no diagnostics at
all, so there is no half-open state to reason about:

```bash
curl -H 'x-health-token: <value>' https://lumiere.alwaysdata.net/healthz
curl 'https://lumiere.alwaysdata.net/healthz?token=<value>'   # monitors that cannot send headers
```

`request.scheme` is not trivia. It is what decides whether a session cookie is
sent as the Secure `__Host-` form, so a visitor whose browser will not keep a
session can open `/healthz` **on that device** and compare it with the address
bar: if the bar says `http://` and this says `https`, the browser is being handed
a `Secure` cookie it will refuse, and every page load will look signed out until
the site is served over one scheme only (alwaysdata's *Force HTTPS* option does
this at the host, which is the right layer for it). Reading that on the phone
therefore needs the token set — with it unset the probe has no `request` block to
show.

The token-free way to ask the same question is `GET /api/auth/session`, which
reads the caller's own cookie and says whether it resolves. `{"email":"you@…"}`
means the server can see the session, so a page that still looks signed out has a
client-side cause; `{"email":null}` means the request arrived without a cookie
the server recognises — a browser that would not store it, a private window, or a
session that was revoked. That one is safe to leave public precisely because it
reports on the caller's own credentials and says nothing about the host.

## Testing

```bash
npm test
```

Runs the backend integration suite with Node's built-in runner — no test
dependencies. It spawns the real `server.js` with a temporary data dir and a
fake stream backend *and a fake TMDB*, then covers auth, rate limiting, CSRF,
the streaming proxy, Range/206 handling, caching, security headers, traversal
attempts, password changes, session persistence across restarts, `robots.txt`,
the sitemap (including per-title URLs), both shapes of `/healthz` — the bare
liveness probe and the `HEALTH_TOKEN`-guarded diagnostics — and title-page meta
injection — plus the degraded path where TMDB
is unreachable and both still have to work.

`test/dist.test.mjs` additionally loads the real `dist/` build (after
`npm run build`) and checks that every file the shipped page references exists,
that assets/icons carry the right content types and caching, and that a complete
sign-up → session → password change → logout round trip works on it. It skips
itself when there is no build, so a fresh checkout still passes.

## Icons

```bash
npm run icons
```

Regenerates the app icons into `public/` using `tools/generate-icons.mjs` — a
small dependency-free PNG/ICO encoder, so no image tooling is needed. It emits
`favicon.ico` (16/32/48), `icon-192.png`, `icon-512.png`, a full-bleed
`icon-maskable-512.png` for Android's adaptive mask and `apple-touch-icon.png`
(iOS ignores SVG here). To re-theme, edit the two colours at the top of that
file and re-run it; the script decodes every file it writes and asserts the
pixels, so a silent encoder break can't ship.

## Android app

> **The Android project is not in this repository right now** — `android-app/` was
> removed on 24 Sep 2026, to be rebuilt later. The site does not depend on it. The
> Capacitor build scaffolding that used to sit alongside it has since been
> removed too: this repository is the web app and the backend the app talks to.
> The section below describes what the app is and how it is built once it exists
> again.

The app is a **Capacitor shell** (`net.alwaysdata.lumiere.app`) that ships this
project's own UI inside the APK and talks to `https://lumiere.alwaysdata.net` for
everything else. Two build-time variables decide that (see `src/lib/apiBase.js`):

```bash
cd android-app        # after recreating it
npm run build:app     # VITE_APP_MODE=app + VITE_API_BASE=<host>, then installs into www/
npm run sync          # cap sync android
npm run apk           # assembleDebug
```

`build-app.mjs` verifies the finished bundle really carries the API host and the
app client marker before installing it — the classic failure is building without
the variables and shipping an app that 404s against its own local origin.

Why bundled rather than a WebView of the site: the app needs its own splash,
onboarding and offline shell, and a token it can hold (a cross-site cookie can
never be sent from the app's local origin). The cost is that UI changes need a
new APK; the API, feed and content still update instantly. Building needs
JDK 17 + the Android SDK on your own machine, never on the shared host.

## The app backend — `/androidpushservice`

The Android app cannot use the website's session cookie: it runs the bundled UI
from a local origin, so every request it makes is cross-site and a `SameSite=Lax`
cookie is simply never attached. It therefore signs in through this namespace and
gets back a **bearer token** — the same session records `/api/auth/*` writes,
just delivered differently.

| Endpoint | Auth | What it does |
|---|---|---|
| `GET /androidpushservice` | — | Service descriptor: version, endpoints, auth scheme |
| `GET /androidpushservice/config` | — | App name, tagline, description, feature flags, UI strings |
| `GET /androidpushservice/health` | — | Liveness + versions |
| `POST /androidpushservice/session` | — | Sign in → `{ token, email, expiresAt, keepLoggedIn }` |
| `GET /androidpushservice/me` | Bearer | The account and its list counts |
| `GET /androidpushservice/feed` | optional | The personalised home rows (also readable signed out) |
| `GET /androidpushservice/activity` | Bearer | Continue watching, recently watched, liked, list, saved |
| `GET /androidpushservice/notifications` | optional | Notifications derived from real activity |
| `POST /androidpushservice/notifications/seen` | Bearer | Mark as read |
| `GET`/`POST`/`DELETE /androidpushservice/mylist` | Bearer | My List (POST toggles) |
| `GET`/`POST`/`DELETE /androidpushservice/likes` | Bearer | Liked titles (POST toggles) |
| `GET`/`POST`/`DELETE /androidpushservice/downloads` | Bearer | Saved titles (the path keeps its old name; the screen is `/saved`) |
| `POST`/`DELETE /androidpushservice/device` | Bearer | Push-token registration (no provider configured) |

**How it stays safe**

- Sign-in reuses `performLogin()` from `server/auth-core.js`, so the app inherits
  the per-account lockout, the scrypt timing equalisation and the rate limits
  instead of re-implementing (and possibly weakening) them.
- The bearer token is only ever returned to a client that identifies itself with
  `x-wampysu-client: app` — a browser POST never receives one, so nothing
  script-readable appears on a web page.
- CORS is granted to the app's own origins only (`https://localhost`,
  `capacitor://localhost`), for the two API namespaces only, and **never with
  credentials** — the app sends a token, not a cookie, so no cookie-replaying
  (CSRF) door is opened. A foreign origin is not answered at all.
- Every list write is rate-limited per account, and every title is validated
  (known media type, positive integer id, trimmed and capped strings) before it
  is stored. `data/prefs.json` is encrypted exactly like the other stores.
- `/healthz` reports the service, its version, and the prefs counts.

## Sign in with Google

Optional, and off until it is configured. Both `/login` and `/signup` show a
**Continue with Google** button when the server holds credentials; without them
the pages look exactly as they did before and `/api/auth/google/start` answers
501. An account made this way is an ordinary account: same store, same sessions,
same per-account lockout, same rate limits, same encrypted rows.

The two buttons are not quite the same request. The sign-up one marks the round
trip as a registration (`mode=signup`, carried inside the signed flow state,
since both forms start from the same place), so it creates an account or refuses
— it never links, and never enters an account that is already there; see
*Accounts, and linking* below.

### Setting it up

1. In [Google Cloud Console](https://console.cloud.google.com/) create a project
   (or pick one), then **APIs & Services → OAuth consent screen**. Choose
   **External**, fill in the app name and support email, and keep the scopes to
   `openid`, `email`, `profile` — the code asks for nothing else.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Web application.** Under *Authorised redirect URIs* add, exactly:
   ```
   https://lumiere.alwaysdata.net/api/auth/google/callback
   http://localhost:5173/api/auth/google/callback      # for `npm run dev`
   ```
3. Put the client id and secret in the AlwaysData panel (or in `.env`):
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. The secret is a real secret — it
   belongs there, never in the source tree or the client bundle.
4. Restart the site in the panel, then check that it took: the public
   `/api/auth/google/status` should answer `{"configured":true}` and the Sign-in
   button should appear. (`/healthz` reports the same thing under `google`, but
   only once `HEALTH_TOKEN` is set — see **Reliability**.)

> **The consent-screen catch.** While the app sits in **Testing** mode it works
> for up to 100 named test users with no verification, which is plenty for
> personal use. *Publishing* it needs the consent screen's "authorised domains"
> to contain a domain verified in Search Console — and the domain this app lives
> under is `alwaysdata.net`, which belongs to your host, not to you. The redirect
> URI itself is fine either way: Google only requires the TLD (`.net`) to be on
> the public suffix list. To go public, point your own domain at the app first,
> set `PUBLIC_ORIGIN` to it, and register that callback in the console.

### What happens on a sign-in

1. `GET /api/auth/google/start` sets a signed, `HttpOnly`, 10-minute flow cookie
   (state, PKCE verifier, nonce, where to return to) and redirects to Google.
   `returnTo` is forced to a path on this site — never an absolute URL — so the
   callback cannot be turned into an open redirect.
2. Google returns to `/api/auth/google/callback` with a code and the state. The
   state must match the one in the cookie (constant-time compare), and the code
   is redeemed **server-side** together with the PKCE verifier.
3. The ID token is verified: signature against Google's published keys (cached,
   and refetched when an unknown key id appears), issuer, audience (our own
   client id), `exp`/`iat`, the nonce, and `email_verified`. Only then is an
   account found or created.
4. An ordinary session is created and the browser goes back to `returnTo` with
   the usual session cookie. Every failure lands on `/login?google=<reason>` with
   a sentence the form displays: `denied` (cancelled), `state`, `linked`,
   `email`, `throttled`, `failed`.

Neither the client secret, the access token nor the ID token ever reaches the
browser — the access token is not even stored, because nothing here calls Google
on the visitor's behalf afterwards.

### Accounts, and linking

- The **email address is the account key**, and Google has already proved the
  visitor controls it, so a Google sign-in *from the sign-in page* for an address
  that already has a password account **links** to it: afterwards both ways in
  work, and nothing is overwritten.
- **The sign-up page never enters an existing account.** A flow begun there
  carries `mode=signup` in its signed state, and an address that already has an
  account — with a password or with Google — is refused with `?google=exists`:
  nothing is linked and no session is set, because "Create account" must not
  quietly sign somebody into an account they did not make. The sign-in page is
  where it goes instead, and the same Google button waits there, so the rule
  costs one tap and never dead-ends. One address, one account, whichever way
  somebody goes about making a second one — the form answers `409` for the same
  case, and the page hands the visitor to `/login` with the address carried over.
- A new address creates an account with **no password hash**. Signing in with a
  password against it fails exactly like a wrong password (same scrypt work, same
  lockout).
- An account with no password can **set its first one** from the account menu:
  the dialog reads "Set a password", does not ask for a current one, and the
  server takes the live session as proof — asking for a password that never
  existed was a dead end that only a reset link could leave. It only ever *adds* a
  way in, and rotates the session and signs other devices out exactly as a change
  does. `GET /api/auth/session` reports `hasPassword`, which is what tells the
  menu which of the two it is offering. "Forgot your password?" also sets one,
  for somebody signed in nowhere.
- A *different* Google account claiming an address that is already linked is
  refused with `?google=linked` rather than merged — and logged.
- Stored from Google: the stable subject id, the address, and the display
  name/picture. No access token, no refresh token, no contacts.

### In the Android app

Not offered there. The app bundles this UI and runs it from a local origin,
authenticating with a bearer token, so a cookie round trip cannot complete inside
it — the button hides itself in that build (`IS_APP`). Native sign-in would be a
follow-up of its own: Google's Android SDK handing the server an ID token to
verify.

## Names, and what was left alone

The app, the UI copy, the mail, the manifest and the icons are **Lumiere**.
A number of names deliberately did not change, because changing them would have
broken live data or live configuration rather than a label:

| Kept | Why |
|---|---|
| `WAMPYSU_*` environment variables | They are set in the AlwaysData panel; renaming them would silently unconfigure the running site |
| `data/.wampysu-key` | The master encryption key file. A new name means a new key, which means every account becomes unreadable |
| `wampysu:accounts:v1` and friends | HKDF purpose strings — they are part of how the stored rows are decrypted |
| `/api/auth/*`, `/androidpushservice/*`, `x-wampysu-client` | Wire names: stored records and any built APK address them |

The **deployment** moved to `lumiere.alwaysdata.net` (on AlwaysData: the account
`/home/lumiere` and the site folder `/home/lumiere/lumiere`), and the Android app
id to `net.alwaysdata.lumiere.app`. Those are host/config values rather than data
keys — nothing stored depends on them — so they were changed along with the
domain while the rows above were left alone.

The session cookie **did** change name (`wampysu_session` → `lumiere_session`),
so it is read under both: a visitor who was signed in when the rename shipped
stays signed in, keeps using the cookie they already hold, and gets the new one
at their next sign-in. The browser-side keys for the app token, the "keep me
logged in" preference and the offline Saved mirror work the same way — each is
read under its old name once and then written under the new one.

## Data at rest — encrypted user stores

The JSON stores in `data/` (`accounts.json`, `sessions.json`, `resets.json`,
`history.json`, `prefs.json`) are encrypted at rest by default. Passwords were always safe
(salted scrypt) and session/reset tokens were always stored only as SHA-256
hashes; this closes the remaining gap: the plaintext that was left.

- **Map keys that could identify a visitor** (an email address, a token hash)
  become `HMAC-SHA256(masterKey, value)` — opaque, unenumerable, stable across
  restarts.
- **The store locations**: the account store (`accounts.json`, `sessions.json`,
  `resets.json`, `verify.json`, `history.json`) lives in `<media>/accounts/`, and
  each account also has a folder of its own inside it — see **Storage** above.
  The app's `prefs.json` and the master key file stay in `WAMPYSU_DATA_DIR`.
- **Record bodies** become `v1.<iv>.<tag>.<ciphertext>` AES-256-GCM boxes with a
  per-record random IV. The store name is bound as AAD, so ciphertext copied
  into another store or field fails to authenticate instead of decrypting to
  garbage; tampering fails closed.
- **Master key**: `WAMPYSU_MASTER_KEY` from the environment when set (the
  AlwaysData panel wins), otherwise generated once into `data/.wampysu-key`
  (chmod 600) and reused. The key file is the single copy — **back it up**;
  losing it makes every encrypted store permanently unreadable.
- **Migration is automatic**: rows in the old plaintext shape are re-keyed and
  re-encrypted on first boot, and the original file is copied to
  `accounts/legacy-plaintext/` as a safety net — delete that folder once the
  encrypted store is confirmed working. A store still sitting in the old
  location (`<data dir>/accounts.json`) is brought into `<media>/accounts/` on
  the first boot after the move, and the old file is deliberately left where it
  is so putting the previous version back still finds it. The encrypted stores
  are the only copies that matter, which makes backing up the master key the one
  thing that really counts.
- `WAMPYSU_ENCRYPT=0` turns the layer off (plaintext stores, exactly the old
  behaviour), and `/healthz` reports the layer's state under `crypto`.

## Version control, and GitHub

This repository is a fresh one — the throwaway history that used to sit here (two
"backup" commits against a hundred uncommitted files) was removed, because it
tracked nothing useful and everything it held is in the working tree. What is
committed now is the project as it stands, with `.gitignore` deciding what never
goes up: `node_modules/`, `dist/` (a build output — deploy by uploading it),
`.env` and every `.env.*` except the example, `data/`, and the runtime directories
`accounts/` and `tracing/`.

### One-time setup

```bash
git remote add origin https://github.com/<your-account>/lumiere.git
npm run setup:github              # stores your Personal Access Token, once
npm run sync                      # commits everything and pushes
```

`setup:github` asks for a **Personal Access Token** — the password GitHub
needs in place of your account password. Create one at
https://github.com/settings/tokens (`repo` scope, or "Contents: read and
write" on a fine-grained token). The script saves it with git's own
credential helper (`store`, in `~/.git-credentials`), checks it against
GitHub, and then never asks again. The token lives only on this machine;
it never enters the repository, and you can revoke it at any time on the
same GitHub page. (On macOS the helper is `osxkeychain` instead of `store`;
everything else is the same.)

Prefer to do it by hand? `git config --global credential.helper store` and
let the first `npm run sync` prompt you — the script's only job is to make
that prompt happen once, ahead of time, and verify the token.

### Every change after that

```bash
npm run sync                      # commit whatever changed, then push
npm run sync -- "Add the tracing screen"
```

`tools/sync-github.sh` does the three commands in order — `git add -A`, commit
(only if something actually changed), `git push` — and refuses to force-push: if
GitHub has commits this copy does not, it prints the `git pull --rebase` line
instead of overwriting anything. Nothing about this is needed to *deploy*; the
site runs from an uploaded `dist/` (see **Deploying to AlwaysData**).

## Sign-in trace, and VPN detection

Every sign-in and sign-up is written as one JSON line — to the day's file and to
that account's own file (see **Storage**). One line looks like this:

```json
{"at":"2026-09-27T14:22:01.123Z","event":"login","account":"<hmac>","ip":"203.0.113.9",
 "userAgent":"Mozilla/5.0 …","referer":null,"languages":"en-GB,en","edgeCountry":null,
 "detail":{"surface":"web"},"vpn":false,
 "geo":{"city":"Bristol","region":"England","country":"United Kingdom","countryCode":"GB",
   "postal":"BS1","latitude":51.45,"longitude":-2.59,"timezone":"Europe/London"},
 "network":{"isp":"…","organization":"…","asn":"AS5089","connectionType":"…"},
 "security":{"vpn":false,"proxy":false,"tor":false,"relay":false,"hosting":false,"riskScore":0},
 "address":{"label":"…","street":"…","locality":"Bristol","country":"United Kingdom"},
 "source":"ipstack","note":null}
```

- **It never delays a sign-in.** The lookup and the write happen on a promise the
  request never awaits (`server/tracing.js`), and the queue is bounded — if it is
  full the event is dropped and counted, never buffered without limit. Shutdown
  flushes it, the same way the mail queue is flushed.
- **Providers are tried in order**: `ipstack` → `vpnapi.io` → `ip-api.com` →
  `proxycheck.io`, and the first that answers wins. The first two are the ones
  this was built around; the others mean detection still works with no key at
  all. Each has a per-day ceiling (`IPSTACK_MAX_PER_DAY` and friends) so a small
  free tier is *skipped* once it is spent rather than answering errors until the
  month turns over. `positionstack` adds the street address, cached per ~100 m.
- **`ip-api.com` is free for non-commercial use only.** It is on by default so
  that a fresh deployment works; a commercial deployment should set
  `GEO_DISABLE_IPAPI=1`.
- **Blocking is opt-in.** `VPN_BLOCK_MODE=block` refuses sign-up, sign-in (web and
  app), and the Google round trip from a flagged address, with `VPN_BLOCK_MESSAGE`
  as the wording. The default, `flag`, records it and lets the visitor in — a
  false positive costs a real customer their account, and datacenter ranges are
  deliberately *not* treated as VPNs unless `VPN_FLAG_HOSTING=1`.
- The whole feature is one variable away from off: `TRACING=0`.

## Privacy — everything stays on this machine
- Accounts and salted scrypt password hashes: `accounts/accounts.json` under the **media root** on the host machine (gitignored). Sessions live there too, as SHA-256 hashes of random tokens; the browser only holds the HttpOnly cookie
- **The sign-in trace**: the address a sign-in came from, when it happened, roughly where it was, the network it came over, and whether it looked like a VPN. Written to `tracing/` on the same machine, kept 180 days by default (`TRACE_KEEP_DAYS`; `TRACING=0` turns it off). It is answered with two third-party IP databases — ipstack and positionstack, plus the keyless fallbacks — which means the **visitor's IP address leaves this machine** for those lookups, and nothing else about them does. That is why the trace records the account's opaque id rather than its address: the file can be matched to an account by the operator and reveals nothing to anyone reading it. Deleting an account deletes its own trace file; a daily file keeps the line, as a paper log for the day would
- **IP lookups**: two requests per sign-in at most (place + street address), cached per address for `GEO_CACHE_MINUTES` and capped per day, so a provider cannot be called more often than a plan allows; `IPSTACK_URL`/`POSITIONSTACK_URL` can be pointed at HTTPS on a paid plan
- UI state (last search, and where to return after signing in): **sessionStorage**, per tab
- No analytics, no telemetry, no external database — there is nothing to leak
- Outbound requests are limited to: TMDB metadata and posters (proxied through this app's server), Google Fonts, the configured stream backends, and the embed servers that actually get played — `api.codespecters.com`, `vidlink.pro`, `player.vidlove.cc`, `vidsrc.pm`, `www.2embed.cc` (only the selected chip is loaded, never all of them at once)
