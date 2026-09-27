import React from 'react'
import { navigate } from '../lib/router.js'

// Renders a genuine <a href> — crawlers follow it, middle-click and
// "open in new tab" work — but a plain left click is handled in-page so the
// app never does a full reload. Modified clicks are left to the browser.
export default function Link({ to, replace = false, children, onClick, ...rest }) {
  function handleClick(e) {
    onClick?.(e)
    if (e.defaultPrevented) return
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to, { replace })
  }

  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  )
}
