// The reCAPTCHA loader, driven against a fake window/document — no browser, no
// dependencies, same as the rest of the suite.
//
// This is the code that failed in the field: the CAPTCHA was reported as loading
// on one auth page but not the other, and only sometimes. The cause was judging
// the script by its own `onload`, which can fire before api.js has installed
// `grecaptcha.render` — so a load that would have succeeded a moment later was
// reported as a failure, while the next page (with the runtime already warm)
// worked. These cases pin that down, plus the rule that makes a spent token cheap:
// reset the widget in place instead of rendering a new one.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// A fresh copy of the module per case: its state (the cached script promise) is
// module-level on purpose, which is what lets one page's load serve the next.
let caseNo = 0
function freshModule() {
  caseNo += 1
  return import(new URL(`../src/lib/recaptcha.js?case=${caseNo}`, import.meta.url).href)
}

// Just enough DOM to drive the loader: one script tag, and a `window` a test can
// warm up (or deliberately leave cold) to stand in for Google's runtime.
function fakeDom() {
  const head = {
    children: [],
    appendChild(el) { head.children.push(el) },
  }
  const document = {
    head,
    getElementById: id => head.children.find(el => el.id === id) || null,
    createElement: () => ({
      id: null,
      src: '',
      async: false,
      remove() {
        const index = head.children.indexOf(this)
        if (index >= 0) head.children.splice(index, 1)
      },
    }),
  }
  globalThis.document = document
  globalThis.window = {}
  return { window: globalThis.window, scripts: () => head.children.filter(el => el.id) }
}

const runtime = () => ({ render: () => 0, ready: cb => cb() })

test('a runtime that arrives after onload is not treated as a failure', async () => {
  const dom = fakeDom()
  const { loadCaptchaScript } = await freshModule()

  // api.js: the tag is in the document, but nothing usable is on `window` yet.
  // This is the exact window the old code gave up in.
  const loaded = loadCaptchaScript({ timeoutMs: 3000, pollMs: 10 })
  assert.equal(dom.scripts().length, 1, 'the script tag should be added')
  assert.equal(typeof dom.window.grecaptcha, 'undefined')

  setTimeout(() => { dom.window.grecaptcha = runtime() }, 80)

  const grecaptcha = await loaded
  assert.equal(typeof grecaptcha.render, 'function', 'the runtime should be handed back, not rejected')
  assert.equal(dom.scripts().length, 1, 'and still only one script tag')
})

test('concurrent callers share one attempt and one script tag', async () => {
  const dom = fakeDom()
  const { loadCaptchaScript, preloadCaptcha } = await freshModule()

  const first = loadCaptchaScript({ timeoutMs: 3000, pollMs: 10 })
  const second = loadCaptchaScript({ timeoutMs: 3000, pollMs: 10 })
  preloadCaptcha()
  assert.equal(dom.scripts().length, 1, 'a second caller must not add a second api.js')

  setTimeout(() => { dom.window.grecaptcha = runtime() }, 30)
  assert.equal(await first, await second, 'both callers get the same runtime')
  assert.equal(dom.scripts().length, 1)
})

test('a silent script times out, clears its tag, and the retry starts over', async () => {
  const dom = fakeDom()
  const { loadCaptchaScript } = await freshModule()

  await assert.rejects(
    () => loadCaptchaScript({ timeoutMs: 60, pollMs: 10 }),
    /did not load/,
    'a runtime that never appears has to fail, or the widget waits forever',
  )
  assert.equal(dom.scripts().length, 0, 'the dead tag should not be left behind')

  // The visitor's retry: a clean request, and this time the runtime lands.
  const retry = loadCaptchaScript({ timeoutMs: 3000, pollMs: 10 })
  assert.equal(dom.scripts().length, 1, 'the retry should load afresh')
  setTimeout(() => { dom.window.grecaptcha = runtime() }, 20)
  assert.equal(typeof (await retry).render, 'function')
})

test('a runtime that is already warm loads nothing at all', async () => {
  const dom = fakeDom()
  const { loadCaptchaScript } = await freshModule()
  dom.window.grecaptcha = runtime()

  const grecaptcha = await loadCaptchaScript({ timeoutMs: 50, pollMs: 10 })
  assert.equal(typeof grecaptcha.render, 'function')
  assert.equal(dom.scripts().length, 0, 'no second copy of Google\'s script on the page')
})

test('a widget is only "painted" once its iframe is really there', async () => {
  const { waitForPaint, waitForWidth } = await freshModule()
  const box = {
    children: [],
    querySelector: selector => (selector === 'iframe' ? box.children[0] || null : null),
  }

  // The failure this catches: render() answering with an ID while the container
  // stays empty, which is a CAPTCHA nobody can solve.
  assert.equal(
    await waitForPaint(box, { timeoutMs: 60, pollMs: 10 }),
    false,
    'an empty container is not a painted widget',
  )
  setTimeout(() => { box.children.push({ tagName: 'IFRAME' }) }, 20)
  assert.equal(await waitForPaint(box, { timeoutMs: 500, pollMs: 10 }), true)
})

test('rendering waits for a measurable container, but not forever', async () => {
  const { waitForWidth } = await freshModule()

  // The auth card animates in; reCAPTCHA sizes its iframe from the container, so
  // rendering into a zero-width box paints an invisible widget.
  const narrow = { getBoundingClientRect: () => ({ width: 0 }) }
  const startedAt = Date.now()
  await waitForWidth(narrow, { timeoutMs: 80, pollMs: 10 })
  assert.ok(Date.now() - startedAt >= 70, 'it should have waited for the layout to settle')

  const wide = { getBoundingClientRect: () => ({ width: 304 }) }
  const at = Date.now()
  await waitForWidth(wide, { timeoutMs: 5000, pollMs: 10 })
  assert.ok(Date.now() - at < 100, 'a measurable container resolves straight away')
})
