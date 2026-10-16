// Mirrors the stories.json contract in AGENTS.md.
export interface Story {
  id: string
  place: string
  title: string
  lat: number
  lng: number
  radius_m: number
  /** Optional grouping, e.g. a corridor. Triggering never uses it. */
  segment?: string
  text: string
  audio: string
  image?: string
  icon_id: number
  duration_s: number
  source: string
  approved: boolean
  /** false keeps a story off the /showcase ride (it still plays on the real app). */
  showcase?: boolean
}
