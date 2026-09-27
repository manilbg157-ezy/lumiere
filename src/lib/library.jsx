import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  myList as myListApi,
  likes as likesApi,
  saved as savedApi,
  readOfflineSaved,
  writeOfflineSaved,
} from './personal.js'

// My List, liked titles and the Saved list, in one place.
//
// Every card in the app can offer the same three actions, so the state lives in
// a context rather than being threaded through rows. Updates are optimistic —
// the button flips immediately and the server is told afterwards — because a
// half-second delay on a heart is far more noticeable than a rare rollback.
//
// The three collections share one item shape:
//   { type: 'movie'|'tv', id, name, year, posterPath, season?, episode? }
const LibraryContext = createContext(null)

const EMPTY = { myList: [], likes: [], saved: [], ready: false }

export function LibraryProvider({ user, onRequireAuth, children }) {
  const [state, setState] = useState(EMPTY)

  // The Saved list mirrors to the device, so the app can show it before the
  // network answers (and while offline).
  useEffect(() => {
    const local = readOfflineSaved()
    if (local.length) setState(prev => ({ ...prev, saved: local }))
  }, [])

  useEffect(() => {
    if (!user) {
      setState({ ...EMPTY, saved: readOfflineSaved() })
      return undefined
    }
    let alive = true
    Promise.all([myListApi.list(), likesApi.list(), savedApi.list()])
      .then(([myList, likes, saved]) => {
        if (!alive) return
        if (saved.length) writeOfflineSaved(saved)
        setState({
          myList,
          likes,
          saved: saved.length ? saved : readOfflineSaved(),
          ready: true,
        })
      })
      .catch(() => { if (alive) setState(prev => ({ ...prev, ready: true })) })
    return () => { alive = false }
  }, [user])

  const has = (list, type, id) => list.some(entry => entry.type === type && Number(entry.id) === Number(id))

  // Normalises whatever a page hands us (a TMDB row, a history entry, an item
  // from the feed) into the one stored shape.
  const toItem = useCallback((input, fallbackType = 'movie') => {
    const type = input?.type === 'tv' || input?.type === 'movie'
      ? input.type
      : (fallbackType === 'tv' ? 'tv' : 'movie')
    const name = input?.name || (type === 'tv' ? input?.name : input?.title) || 'Untitled'
    const item = {
      type,
      id: Number(input?.id),
      name,
      year: input?.year || String(input?.release_date || input?.first_air_date || '').slice(0, 4) || null,
      posterPath: input?.posterPath || input?.poster_path || null,
    }
    if (type === 'tv' && input?.season) {
      item.season = Number(input.season)
      if (input.episode) item.episode = Number(input.episode)
    }
    return item
  }, [])

  const requireSignIn = useCallback(() => {
    onRequireAuth?.()
    return false
  }, [onRequireAuth])

  const toggle = useCallback(async (field, api, input, fallbackType) => {
    if (!user) return requireSignIn()
    const item = toItem(input, fallbackType)
    if (!Number.isInteger(item.id) || item.id <= 0) return false

    // Flip locally first.
    setState(prev => {
      const list = prev[field]
      const present = list.some(entry => entry.type === item.type && Number(entry.id) === item.id)
      return {
        ...prev,
        [field]: present
          ? list.filter(entry => !(entry.type === item.type && Number(entry.id) === item.id))
          : [item, ...list],
      }
    })

    try {
      await api.toggle(item)
    } catch {
      // Put it back the way the server still sees it.
      setState(prev => {
        const list = prev[field]
        const present = list.some(entry => entry.type === item.type && Number(entry.id) === item.id)
        return {
          ...prev,
          [field]: present
            ? list.filter(entry => !(entry.type === item.type && Number(entry.id) === item.id))
            : [item, ...list],
        }
      })
    }
    return true
  }, [user, requireSignIn, toItem])

  const toggleMyList = useCallback((input, fallbackType) => toggle('myList', myListApi, input, fallbackType), [toggle])
  const toggleLike = useCallback((input, fallbackType) => toggle('likes', likesApi, input, fallbackType), [toggle])

  // Saved titles only ever add: pressing the button again does not un-save a
  // title, which is why removal lives on the Saved screen.
  const addSaved = useCallback(async (input, fallbackType) => {
    if (!user) return requireSignIn()
    const item = toItem(input, fallbackType)
    if (!Number.isInteger(item.id) || item.id <= 0) return false
    setState(prev => {
      if (prev.saved.some(entry => entry.type === item.type && Number(entry.id) === item.id)) return prev
      const next = [item, ...prev.saved]
      writeOfflineSaved(next)
      return { ...prev, saved: next }
    })
    try { await savedApi.toggle(item) } catch {}
    return true
  }, [user, requireSignIn, toItem])

  const removeSaved = useCallback(async (type, id) => {
    setState(prev => {
      const next = prev.saved.filter(entry => !(entry.type === type && Number(entry.id) === Number(id)))
      writeOfflineSaved(next)
      return { ...prev, saved: next }
    })
    if (user) { try { await savedApi.remove(type, id) } catch {} }
    return true
  }, [user])

  const clearSaved = useCallback(async () => {
    setState(prev => {
      writeOfflineSaved([])
      return { ...prev, saved: [] }
    })
    if (user) { try { await savedApi.clear() } catch {} }
  }, [user])

  const value = useMemo(() => ({
    ...state,
    toggleMyList,
    toggleLike,
    addSaved,
    removeSaved,
    clearSaved,
    inMyList: (type, id) => has(state.myList, type, id),
    isLiked: (type, id) => has(state.likes, type, id),
    isSaved: (type, id) => has(state.saved, type, id),
  }), [state, toggleMyList, toggleLike, addSaved, removeSaved, clearSaved])

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
}

// Safe outside a provider (a stray story or a test): every action becomes a
// no-op and every list is empty, rather than throwing during render.
const FALLBACK = {
  ...EMPTY,
  toggleMyList: async () => false,
  toggleLike: async () => false,
  addSaved: async () => false,
  removeSaved: async () => true,
  clearSaved: async () => true,
  inMyList: () => false,
  isLiked: () => false,
  isSaved: () => false,
}

export function useLibrary() {
  return useContext(LibraryContext) || FALLBACK
}
