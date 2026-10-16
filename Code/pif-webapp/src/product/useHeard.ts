import { useEffect, useState } from 'react'
import type { NowPlaying } from '../journey/useJourney'

// Your heard collection: every story you've listened to, with when you first heard it.
// On the real app it's saved on this phone (no account, it never leaves the device), so it
// builds up across journeys. On /showcase it lasts for the page only, so each visitor starts
// fresh on a shared demo phone. Heard stories can be replayed anywhere.

export interface HeardEntry {
  id: string
  /** When you first heard it (ms since 1970). Replays don't change it. */
  at: number
}

const KEY = 'pif.heard.v1'

function load(persist: boolean): HeardEntry[] {
  if (!persist) return []
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((e) => typeof e?.id === 'string' && typeof e?.at === 'number') : []
  } catch {
    return []
  }
}

export function useHeard(playing: NowPlaying | null, persist: boolean): HeardEntry[] {
  const [entries, setEntries] = useState<HeardEntry[]>(() => load(persist))
  // A story counts as heard when it starts playing (updated during render, React's pattern
  // for state that follows a prop).
  const [lastPlaying, setLastPlaying] = useState(playing)
  if (playing !== lastPlaying) {
    setLastPlaying(playing)
    if (playing && !entries.some((e) => e.id === playing.story.id)) {
      setEntries([...entries, { id: playing.story.id, at: playing.startedAt }])
    }
  }

  useEffect(() => {
    if (!persist || entries.length === 0) return
    try {
      localStorage.setItem(KEY, JSON.stringify(entries))
    } catch {
      // storage full or blocked: the collection just won't be remembered
    }
  }, [entries, persist])

  return entries
}
