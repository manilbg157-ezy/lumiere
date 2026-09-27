import React from 'react'
import Link from './Link.jsx'
import Icon from './Icon.jsx'
import { tmdbImage, formatRating, getYear, tmdbImgFallback } from '../lib/api.js'
import { titlePath, navigate } from '../lib/router.js'
import { useLibrary } from '../lib/library.jsx'
import { IS_APP } from '../lib/apiBase.js'
import styles from './Card.module.css'

// The artwork tile the whole interface is built from, in the two shapes the
// Netflix app uses:
//
//   variant="poster"     the 2:3 poster in a row (optionally with a rank
//                        numeral and/or a corner badge)
//   variant="landscape"  the 16:9 resume tile: a play button over the still,
//                        the title and episode underneath, and a progress bar
//
// Every card is a real link to that title's page — that is how the rows, search
// results and "more like this" all funnel visitors (and crawlers) into
// /movie/:id and /tv/:id.
export default function Card({
  item,
  type = 'movie',
  variant = 'poster',
  rank = null,
  badge = null,
  tag = null,
  progressPct = null,
  subtitle = null,
  showActions = false,
  // Quick actions that appear over the artwork when a pointer hovers the tile
  // (pointer devices only — CSS hides them where there is no hover). Rows set
  // this so "Play" and "Add to My List" are one click from the strip, the way
  // a Netflix tile expands on hover.
  hoverActions = false,
  // The small save-for-offline button on the artwork. The app ships one because
  // its Saved screen is a first-class tab; on the web the same action lives
  // on the title page and in My Home.
  showSave = IS_APP,
}) {
  const library = useLibrary()
  const kind = item.type === 'tv' || item.type === 'movie' ? item.type : type

  const title = item.name || item.title || 'Untitled'
  const year = item.year || getYear(kind === 'movie' ? item.release_date : item.first_air_date)
  const rating = item.rating || formatRating(item.vote_average)
  const posterPath = item.posterPath || item.poster_path
  const backdropPath = item.backdropPath || item.backdrop_path
  const href = titlePath(kind, item.id)

  const liked = library.isLiked(kind, item.id)
  const inList = library.inMyList(kind, item.id)
  const saved = library.isSaved(kind, item.id)

  const label = year ? `${title} (${year})` : title

  const art = variant === 'landscape'
    ? (tmdbImage(backdropPath, 'w780') || tmdbImage(posterPath, 'w500'))
    : tmdbImage(posterPath, 'w300')

  return (
    <div className={`${styles.wrap} ${rank ? styles.ranked : ''}`}>
      {rank && <span className={styles.rank} aria-hidden="true">{rank}</span>}

      <Link className={`${styles.card} ${variant === 'landscape' ? styles.landscape : ''}`} to={href} aria-label={label}>
        <div className={styles.art}>
          {/* object-fit: cover on a 16:9 still needs the poster for titles with
              no backdrop, so both are offered and the browser picks. */}
          {art
            ? <img src={art} alt="" loading="lazy" decoding="async" draggable="false" onError={tmdbImgFallback} />
            : <div className={styles.noArt}><Icon name="film" size={30} /></div>}

          {variant === 'landscape' && (
            <span className={styles.playCircle} aria-hidden="true"><Icon name="play" size={20} /></span>
          )}

          {badge && <span className={styles.badge}>{badge}</span>}
          {tag && <span className={styles.tag}>{tag}</span>}

          {progressPct > 0 && (
            <span className={styles.progressTrack} aria-hidden="true">
              <span className={styles.progressFill} style={{ width: `${Math.min(100, progressPct)}%` }} />
            </span>
          )}
        </div>

        {variant === 'landscape' && (
          <div className={styles.caption}>
            <span className={styles.captionTitle}>{title}</span>
            <span className={styles.captionSub}>{subtitle || (rating ? `★ ${rating}` : year || '')}</span>
          </div>
        )}
      </Link>

      {hoverActions && variant === 'poster' && (
        <div className={styles.hoverBar}>
          <button
            type="button"
            className={styles.hoverBtn}
            onClick={() => navigate(href, { state: { autoplay: true } })}
            aria-label={`Play ${title}`}
            title="Play"
          >
            <Icon name="play" size={15} />
          </button>
          <button
            type="button"
            className={styles.hoverBtn}
            onClick={() => library.toggleMyList(item, kind)}
            aria-pressed={inList}
            aria-label={inList ? `Remove ${title} from My List` : `Add ${title} to My List`}
            title={inList ? 'In My List' : 'Add to My List'}
          >
            <Icon name={inList ? 'check' : 'plus'} size={15} strokeWidth={2.2} />
          </button>
        </div>
      )}

      {showActions && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.actBtn}
            onClick={() => library.toggleLike(item, kind)}
            aria-pressed={liked}
            aria-label={liked ? `Remove ${title} from liked` : `Like ${title}`}
            title={liked ? 'Liked' : 'Like'}
          >
            <Icon name={liked ? 'check' : 'plus'} size={16} />
          </button>
          <button
            type="button"
            className={styles.actBtn}
            onClick={() => (saved ? library.removeSaved(kind, item.id) : library.addSaved(item, kind))}
            aria-pressed={saved}
            aria-label={saved ? `Remove ${title} from Saved` : `Save ${title}`}
            title={saved ? 'Saved' : 'Save'}
          >
            <Icon name={saved ? 'check' : 'bookmark'} size={16} />
          </button>
          <button
            type="button"
            className={styles.actBtn}
            onClick={() => library.toggleMyList(item, kind)}
            aria-pressed={inList}
            aria-label={inList ? `Remove ${title} from My List` : `Add ${title} to My List`}
            title={inList ? 'In My List' : 'Add to My List'}
          >
            <Icon name={inList ? 'check' : 'plus'} size={16} />
          </button>
        </div>
      )}

      {showSave && variant === 'poster' && (
        <button
          type="button"
          className={`${styles.saveBtn} ${saved ? styles.saveOn : ''}`}
          onClick={event => {
            // An overlay on top of a link: the tap must save, not navigate.
            event.preventDefault()
            event.stopPropagation()
            if (saved) library.removeSaved(kind, item.id)
            else library.addSaved(item, kind)
          }}
          aria-label={saved ? `Remove ${title} from Saved` : `Save ${title}`}
          title={saved ? 'Saved' : 'Save'}
        >
          <Icon name={saved ? 'check' : 'bookmark'} size={15} />
        </button>
      )}
    </div>
  )
}
