import React from 'react'
import s from './Style.module.css'

// The design-system showcase — every glass surface the site uses, on one
// screen. Public (the router serves it signed out) but deliberately absent
// from the sitemap; it is a workshop, not a destination. Change a token in
// src/index.css, rebuild, open /style: if this page looks right, every page
// built from the same surfaces looks right.
export default function Style () {
  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.h1}>Lumiere design system</h1>
        <p className={s.sub}>
          Every surface below is built from the same tokens in
          <code> src/index.css</code>. Panels are shaded, near-opaque glass —
          dark fills, a hint of top light, a refracting rim. If something here
          reads as a milky film, a fill went white or too thin.
        </p>
      </header>

      <section className={s.grid}>
        <div className={s.demo}>
          <div className={s.panel}>Panel</div>
          <p className={s.label}><code>--glass-surface</code> — cards, menus, dialogs</p>
        </div>
        <div className={s.demo}>
          <div className={`${s.panel} ${s.strong}`}>Strong panel</div>
          <p className={s.label}><code>--glass-surface-strong</code> — modals, season picker</p>
        </div>
        <div className={s.demo}>
          <div className={`${s.panel} ${s.soft}`}>Soft panel</div>
          <p className={s.label}><code>--glass-surface-soft</code> — inputs, popovers</p>
        </div>
        <div className={s.demo}>
          <div className={s.plain}>Plain surface</div>
          <p className={s.label}><code>--bg-card</code> — list rows, tables</p>
        </div>
      </section>

      <section className={s.grid}>
        <div className={s.demo}>
          <div className={s.controls}>
            <button type="button" className={s.chip}>Chip</button>
            <button type="button" className={s.chipActive}>Active chip</button>
            <button type="button" className={s.ghost}>Ghost button</button>
            <button type="button" className={s.gold}>Gold button</button>
          </div>
          <p className={s.label}>Controls — tint &le; 0.2 white, functional white kept</p>
        </div>
        <div className={s.demo}>
          <div className={s.type}>
            <p className={s.text}>Primary text</p>
            <p className={s.muted}>Muted text</p>
            <p className={s.dim}>Dim text</p>
          </div>
          <p className={s.label}><code>--text</code>, <code>--text-muted</code>, <code>--text-dim</code></p>
        </div>
        <div className={s.demo}>
          <div className={s.palette}>
            <span className={s.goldSwatch} /><span className={s.glassSwatch} /><span className={s.panelSwatch} /><span className={s.darkSwatch} />
          </div>
          <p className={s.label}><code>--accent</code>, <code>--glass</code>, <code>--glass-panel</code>, <code>--bg</code></p>
        </div>
      </section>

      <footer className={s.footer}>
        <p className={s.dim}>
          Guards for these values live in <code>test/style.test.mjs</code> —
          the suite fails if a panel goes milky again.
        </p>
      </footer>
    </div>
  )
}
