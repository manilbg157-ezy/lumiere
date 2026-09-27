// Loads .env for its side effect, and is imported *first* by server.js and
// server/auth-plugin.js.
//
// The ordering is the whole point: ES modules evaluate in import order, and
// server/mail.js, server/tmdb.js and server/auth-core.js all read process.env at
// module scope. A call written inside server.js's body would run long after
// those modules had already captured an empty environment.
//
// Set WAMPYSU_ENV_FILE=off to disable, or point it at a different file.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from './env.js'

const here = path.dirname(fileURLToPath(import.meta.url))

if (String(process.env.WAMPYSU_ENV_FILE || '').toLowerCase() !== 'off') {
  const file = process.env.WAMPYSU_ENV_FILE || path.join(here, '..', '.env')
  const result = loadEnvFile(file)

  // Only the file and the variable *names* are ever logged — never a value.
  if (result.error) {
    console.error(`[Lumiere] could not read ${result.file}: ${result.error}`)
  } else if (result.found && result.applied.length) {
    console.log(`[Lumiere] loaded ${result.applied.length} setting(s) from ${result.file} (${result.applied.join(', ')})`)
    if (result.skipped.length) {
      console.log(`[Lumiere]   environment already set, so the file was ignored for: ${result.skipped.join(', ')}`)
    }
  }
}
