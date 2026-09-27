import React, { useRef } from 'react'
import Link from './Link.jsx'
import Icon from './Icon.jsx'
import Card from './Card.jsx'
import styles from './Row.module.css'

// One horizontally scrolling strip with a heading above it — the unit every
// Netflix home screen is made of.
//
//   variant="poster"     the default: 2:3 tiles
//   variant="ranked"     big numerals beside the first ten tiles ("Top 10")
//   variant="landscape"  the wider resume tiles ("Continue Watching")
//
// `seeAllTo` adds the "See All ›" affordance Netflix puts on the right of a
// heading; without it the row is just a strip.
export default function Row({
  title,
  subtitle = null,
  items,
  type = 'movie',
  variant = 'poster',
  seeAllTo = null,
  showSave = undefined,
  emptyMessage = null,
  // Quick actions over a poster on hover (pointer devices only). Posters only:
  // a resume tile already carries its own play affordance.
  hoverActions = true,
}) {
  const scrollerRef = useRef(null)
  if (!items || items.length === 0) {
    return emptyMessage ? (
      <section className={styles.row}>
        <h2 className={styles.heading}>{title}</h2>
        <p className={styles.empty}>{emptyMessage}</p>
      </section>
    ) : null
  }

  const ranked = variant === 'ranked'
  const landscape = variant === 'landscape'

  function scroll(direction) {
    const el = scrollerRef.current
    if (!el) return
    el.scrollBy({ left: direction * el.clientWidth * 0.82, behavior: 'smooth' })
  }

  return (
    <section className={styles.row} aria-label={title}>
      <div className={styles.head}>
        <h2 className={styles.heading}>
          {title}
          {subtitle && <span className={styles.subtitle}> {subtitle}</span>}
        </h2>
        {seeAllTo && (
          <Link className={styles.seeAll} to={seeAllTo}>
            See All <Icon name="chevron" size={15} strokeWidth={2.2} />
          </Link>
        )}
      </div>

      <div className={styles.wrap}>
        <button
          type="button"
          className={`${styles.arrow} ${styles.left}`}
          onClick={() => scroll(-1)}
          aria-label={`Scroll ${title} left`}
        >
          <Icon name="back" size={22} strokeWidth={2.2} />
        </button>

        <div className={`${styles.scroller} ${landscape ? styles.scrollerWide : ''}`} ref={scrollerRef}>
          {items.map((item, index) => (
            <div
              key={`${item.type || type}-${item.id}`}
              className={`${styles.cell} ${landscape ? styles.cellWide : ''} ${ranked ? styles.cellRanked : ''}`}
            >
              <Card
                item={item}
                type={item.type || type}
                variant={landscape ? 'landscape' : 'poster'}
                rank={ranked && index < 10 ? index + 1 : null}
                badge={ranked && index < 10 ? 'TOP 10' : null}
                tag={item.tag || null}
                progressPct={landscape ? (item.progressPct || 0) : null}
                subtitle={landscape ? episodeLabel(item) : null}
                showSave={showSave}
                hoverActions={hoverActions && !landscape}
              />
            </div>
          ))}
        </div>

        <button
          type="button"
          className={`${styles.arrow} ${styles.right}`}
          onClick={() => scroll(1)}
          aria-label={`Scroll ${title} right`}
        >
          <Icon name="chevron" size={22} strokeWidth={2.2} />
        </button>
      </div>
    </section>
  )
}

// "S10:E206 Sakura's Feelings" is what Netflix prints under a resume tile; with
// no episode information the year is the next most useful thing.
function episodeLabel(item) {
  if (item.season) {
    const ep = item.episode ? `:E${item.episode}` : ''
    return `S${item.season}${ep}`
  }
  return item.year || ''
}
