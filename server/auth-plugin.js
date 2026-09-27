// Vite dev-server plugin exposing the shared auth core (server/auth-core.js)
// on /api/auth/* during `vite dev` and `vite preview`.
//
// env-auto first, for the same reason server.js does it: auth-core and mail read
// process.env when they are imported.
import './env-auto.js'
import { handleAuth } from './auth-core.js'

function middleware() {
  return async (req, res, next) => {
    try {
      if (!req.url || !req.url.startsWith('/api/auth/')) return next()
      const pathname = req.url.split('?')[0]
      // The dev server is reached directly, so X-Forwarded-For is not trusted
      // when keying the rate limiter.
      await handleAuth(req, res, pathname, { trustProxy: false })
    } catch (err) {
      console.error('[Lumiere] auth error:', err?.stack || err)
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.end(JSON.stringify({ error: 'Server error.' }))
    }
  }
}

export default function authPlugin() {
  return {
    name: 'Lumiere-auth-server',
    configureServer(server) {
      server.middlewares.use(middleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware())
    },
  }
}
