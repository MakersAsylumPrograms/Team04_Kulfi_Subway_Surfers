import { useEffect, useState } from 'react'
import type { Fix } from '../position/types'

// Fog-of-war experiment (2026-10-16): the map reveals only around where you've been. Each
// accurate fix marks a grid cell (~200 m) as visited; the cells' centres are the clear spots.
// On the real app they're saved on this phone and never leave it. On /showcase they last
// for the page only, so every visitor starts fogged. Turn it off with ?fog=0 to compare.

export const FOG_ENABLED = new URLSearchParams(window.location.search).get('fog') !== '0'
/** How far around each visited cell the fog clears (FEATURES.md section 2: about 500 m). */
export const FOG_REVEAL_M = 500

const KEY = 'pif.fog.v1'
const CELL_DEG = 0.002 // about 200 m
const MAX_CELLS = 5000

function load(persist: boolean): [number, number][] {
  if (!persist) return []
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(saved) ? saved : []
  } catch {
    return []
  }
}

function cellOf(fix: Fix | null): [number, number] | null {
  if (!FOG_ENABLED || !fix || fix.accuracy > 100) return null
  return [Math.round(fix.lat / CELL_DEG) * CELL_DEG, Math.round(fix.lng / CELL_DEG) * CELL_DEG]
}

export function useFog(fix: Fix | null, persist: boolean): [number, number][] {
  const [points, setPoints] = useState<[number, number][]>(() => load(persist))
  // A new fix in a cell not seen before adds it (updated during render, React's pattern for
  // state that follows a prop).
  const [lastFix, setLastFix] = useState(fix)
  if (fix !== lastFix) {
    setLastFix(fix)
    const cell = cellOf(fix)
    if (cell && !points.some(([a, b]) => Math.abs(a - cell[0]) < 1e-9 && Math.abs(b - cell[1]) < 1e-9)) {
      setPoints([...points, cell].slice(-MAX_CELLS))
    }
  }

  useEffect(() => {
    if (!persist || points.length === 0) return
    try {
      localStorage.setItem(KEY, JSON.stringify(points))
    } catch {
      // storage full or blocked: the fog just won't be remembered
    }
  }, [points, persist])

  return points
}
