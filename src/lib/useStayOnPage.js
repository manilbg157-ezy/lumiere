import { useEffect } from 'react'

// The embed provider's player tries to redirect the whole page to ads. This
// guard makes every such attempt show the browser's native "Leave site?"
// dialog — cancelling it keeps you here with the video still playing.
//
// Only arm it while something is actually playing: an always-on listener makes
// the browser ask "Leave site?" when closing any tab, which is annoying and
// trains people to click through it.

// Module-level flag rather than state: beforeunload fires once, after React's
// last render, so the handler has to read the current value, not one captured
// by a closure from an earlier render. The listener itself lives at module
// level too — added once, cheap, and every Title page shares it.
let armed = false

function guard(e) {
  if (!armed) return
  e.preventDefault()
  e.returnValue = '' // Chrome requires returnValue to be set
}

// One-shot escape hatch for navigations the visitor chose deliberately —
// signing out is the one that matters. The full reload that ends a signed-out
// visit must not trip the guard and show a confusing "Leave site?" dialog over
// the very button that ends the visit. Synchronous and React-independent on
// purpose: the caller needs the disarm to be certain before it reloads, and
// waiting for a re-render would make that a race.
export function allowNextUnload() {
  armed = false
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', guard)
}

export function useStayOnPage(active) {
  useEffect(() => {
    armed = active
    return () => { armed = false }
  }, [active])
}
