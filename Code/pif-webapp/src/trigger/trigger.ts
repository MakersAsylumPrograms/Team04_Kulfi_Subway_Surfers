import type { Story } from '../data/types.ts'
import type { Fix } from '../position/types.ts'

// Pure trigger logic: no React, no timers, no knowledge of where fixes come from.

const EARTH_RADIUS_M = 6_371_000

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = Math.PI / 180
  const dLat = (bLat - aLat) * toRad
  const dLng = (bLng - aLng) * toRad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

export function distanceToStory(fix: Fix, story: Story): number {
  return haversineM(fix.lat, fix.lng, story.lat, story.lng)
}

export interface TriggerState {
  /** Stories already fired this journey. Cleared when a journey starts. */
  fired: Set<string>
  /** Unfired stories whose radius contained the previous fix. */
  insideLastFix: Set<string>
}

export function createTriggerState(): TriggerState {
  return { fired: new Set(), insideLastFix: new Set() }
}

/**
 * Feed one fix. Returns the story to fire, or null. Mutates `state`.
 *
 * A story fires when the fix is inside its radius and either the previous fix
 * was inside too, or this fix's accuracy is better than the radius. That stops
 * one bad fix on a moving train from firing a story a kilometre early.
 * If several stories qualify, the nearest wins; the others can fire later.
 */
export function evaluateFix(state: TriggerState, fix: Fix, stories: readonly Story[]): Story | null {
  const inside = new Set<string>()
  let best: { story: Story; distance: number } | null = null

  for (const story of stories) {
    if (state.fired.has(story.id)) continue
    const distance = distanceToStory(fix, story)
    if (distance > story.radius_m) continue
    inside.add(story.id)
    const confirmed = state.insideLastFix.has(story.id) || fix.accuracy < story.radius_m
    if (confirmed && (!best || distance < best.distance)) best = { story, distance }
  }

  state.insideLastFix = inside
  if (!best) return null
  state.fired.add(best.story.id)
  state.insideLastFix.delete(best.story.id)
  return best.story
}

/**
 * Like evaluateFix, but returns every story that qualifies on this fix, nearest first, and
 * marks them all fired. For starting (or standing still) inside several overlapping circles:
 * a phone that isn't moving may send no more fixes, so waiting for the next one to fire the
 * rest would leave them unheard.
 */
export function evaluateFixAll(state: TriggerState, fix: Fix, stories: readonly Story[]): Story[] {
  const inside = new Set<string>()
  const ready: { story: Story; distance: number }[] = []
  for (const story of stories) {
    if (state.fired.has(story.id)) continue
    const distance = distanceToStory(fix, story)
    if (distance > story.radius_m) continue
    inside.add(story.id)
    if (state.insideLastFix.has(story.id) || fix.accuracy < story.radius_m) ready.push({ story, distance })
  }
  for (const { story } of ready) {
    state.fired.add(story.id)
    inside.delete(story.id)
  }
  state.insideLastFix = inside
  return ready.sort((a, b) => a.distance - b.distance).map((r) => r.story)
}

/** The nearest story not yet fired, for the "next story" line on screen. */
export function nearestUnfired(
  state: TriggerState,
  fix: Fix,
  stories: readonly Story[],
): { story: Story; distance: number } | null {
  let best: { story: Story; distance: number } | null = null
  for (const story of stories) {
    if (state.fired.has(story.id)) continue
    const distance = distanceToStory(fix, story)
    if (!best || distance < best.distance) best = { story, distance }
  }
  return best
}

export interface NamedPlace {
  name: string
  lat: number
  lng: number
}

export interface PlaceAt {
  name: string
  /** True when the fix is inside a story's radius, false when merely nearby. */
  inside: boolean
}

const NEAR_M = 1500

/**
 * Where the user is right now, for the line on top of the map. Prefers a story
 * whose radius contains the fix; otherwise the closest known place within 1.5 km.
 */
export function placeAt(
  fix: Fix,
  stories: readonly Story[],
  extraPlaces: readonly NamedPlace[] = [],
): PlaceAt | null {
  let inside: { name: string; distance: number } | null = null
  let near: { name: string; distance: number } | null = null
  for (const story of stories) {
    const distance = distanceToStory(fix, story)
    if (distance <= story.radius_m && (!inside || distance < inside.distance)) {
      inside = { name: story.place, distance }
    }
    if (distance <= NEAR_M && (!near || distance < near.distance)) near = { name: story.place, distance }
  }
  if (inside) return { name: inside.name, inside: true }
  for (const p of extraPlaces) {
    const distance = haversineM(fix.lat, fix.lng, p.lat, p.lng)
    if (distance <= NEAR_M && (!near || distance < near.distance)) near = { name: p.name, distance }
  }
  return near ? { name: near.name, inside: false } : null
}
