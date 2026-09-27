import React from 'react'
import Link from '../Link.jsx'
import styles from './Button.module.css'

// One button primitive for the whole app, in the three weights the UI actually
// needs. Renders an <a> when given `to` (so navigation keeps its href) and a
// <button> otherwise.
//
//   primary  solid brand — the single main action on a screen
//   light    white, for secondary actions over artwork
//   ghost    outlined, low emphasis
//
// Sizes are md (default) and lg; add `block` for a full-width button. Anything
// passed as `type` lands on the <button>, so a non-submitting button inside a
// form must say type="button".
export default function Button({
  variant = 'primary',
  size = 'md',
  to,
  block = false,
  className = '',
  children,
  ...rest
}) {
  const cls = [
    styles.btn,
    styles[variant] || styles.primary,
    styles[size] || styles.md,
    block ? styles.block : '',
    className,
  ].filter(Boolean).join(' ')

  if (to) return <Link to={to} className={cls} {...rest}>{children}</Link>
  return <button className={cls} {...rest}>{children}</button>
}
