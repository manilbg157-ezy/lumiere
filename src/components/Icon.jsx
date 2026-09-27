import React from 'react'

// One inline SVG set for the whole app — the Netflix chrome needs a dozen small
// glyphs and a sprite sheet would be a second request for no benefit. Every icon
// inherits `currentColor` and sizes from the `size` prop, so a chip, a tab and a
// card button can all use the same shape at different weights.
const PATHS = {
  home: <path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </>
  ),
  profile: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.5 19c1.2-2.4 3.2-3.6 5.5-3.6s4.3 1.2 5.5 3.6" />
    </>
  ),
  // The Saved button. It used to be a download arrow, which promised a file that
  // a cross-origin embed can never hand over; a bookmark says "kept for later".
  bookmark: (
    <>
      <path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-3.9L5.5 20.5v-16a1 1 0 0 1 1-1z" />
    </>
  ),
  bell: (
    <>
      <path d="M18 16V11a6 6 0 1 0-12 0v5l-1.5 2.5h15z" />
      <path d="M10 21h4" />
    </>
  ),
  play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none" />,
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  share: (
    <>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <line x1="8.2" y1="10.9" x2="15.8" y2="7.1" />
      <line x1="8.2" y1="13.1" x2="15.8" y2="16.9" />
    </>
  ),
  back: (
    <>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="11 6 5 12 11 18" />
    </>
  ),
  chevron: <polyline points="9 5 16 12 9 19" />,
  close: (
    <>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z" />
    </>
  ),
  // The hero's "More Info" action. The zero-length line with a round cap is the
  // dot of the i, so the whole glyph stays one stroke.
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="8" y1="4" x2="8" y2="20" />
      <line x1="16" y1="4" x2="16" y2="20" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
    </>
  ),
}

export default function Icon({ name, size = 22, strokeWidth = 1.8, className = '', ...rest }) {
  const path = PATHS[name]
  if (!path) return null
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {path}
    </svg>
  )
}

export const ICON_NAMES = Object.keys(PATHS)
