import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Story } from '../data/types'
import type { Fix } from '../position/types'
import { distanceToStory } from '../trigger/trigger'

// Plain Leaflet driven from effects: one map instance, layers updated in place.

/** Colours for what the map draws. The debug tool uses the defaults; the product passes its theme. */
export interface MapPalette {
  heard: string
  playing: string
  /** A story's circle you're standing in, before it plays. */
  here: string
  unheard: string
  me: string
  path: string
}
const DEFAULT_PALETTE: MapPalette = {
  heard: '#1c1917',
  playing: '#b45309',
  here: '#db2777',
  unheard: '#78716c',
  me: '#2563eb',
  path: '#1c1917',
}
// Street level by default; showcase places tens of metres apart need a closer view.
const ZOOM = 15
const CLOSE_ZOOM = 18

interface Props {
  fix: Fix | null
  path: [number, number][]
  stories: readonly Story[]
  revealed: ReadonlySet<string>
  heardIds: ReadonlySet<string>
  playingId: string | null
  /** Where to look before the first fix arrives. */
  fallbackCenter: [number, number]
  /** Zoom in close when stories are small and near each other (an office showcase). */
  close?: boolean
  /** Fill the parent instead of being a rounded card (the product's full-screen map). */
  fill?: boolean
  palette?: MapPalette
  /** Space at the bottom (px) kept clear of the follow position, e.g. under a bottom sheet. */
  bottomInset?: number
  /** A picture for your position (the product's mascot) instead of the plain dot. */
  meIcon?: string
  children?: ReactNode
}

export function MapView({ fix, path, stories, revealed, heardIds, playingId, fallbackCenter, close = false, fill = false, palette = DEFAULT_PALETTE, bottomInset = 0, meIcon, children }: Props) {
  const paletteRef = useRef(palette)
  useEffect(() => {
    paletteRef.current = palette
  }, [palette])
  const meIconRef = useRef(meIcon)
  const zoom = close ? CLOSE_ZOOM : ZOOM
  const zoomRef = useRef(zoom)
  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layersRef = useRef<{
    path: L.Polyline
    accuracy: L.Circle
    me: L.CircleMarker | L.Marker
    stories: L.LayerGroup
  } | null>(null)
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)
  const fallbackRef = useRef(fallbackCenter)

  useEffect(() => {
    if (!elRef.current) return
    const map = L.map(elRef.current, { zoomControl: false, attributionControl: true }).setView(
      fallbackRef.current,
      zoomRef.current,
    )
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map)
    layersRef.current = {
      path: L.polyline([], { color: paletteRef.current.path, weight: 4, opacity: 0.55 }).addTo(map),
      stories: L.layerGroup().addTo(map),
      accuracy: L.circle([0, 0], { radius: 0, stroke: false, fillColor: paletteRef.current.me, fillOpacity: 0.14 }),
      me: meIconRef.current
        ? L.marker([0, 0], {
            icon: L.icon({ iconUrl: meIconRef.current, iconSize: [46, 44], iconAnchor: [23, 22], className: 'pif-me-icon' }),
            interactive: false,
            keyboard: false,
            zIndexOffset: 1000,
          })
        : L.circleMarker([0, 0], {
            radius: 8,
            color: '#ffffff',
            weight: 3,
            fillColor: paletteRef.current.me,
            fillOpacity: 1,
          }),
    }
    // Panning by hand stops the map following you until you tap Recenter.
    map.on('dragstart', () => {
      followingRef.current = false
      setFollowing(false)
    })
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      layersRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layers = layersRef.current
    if (!map || !layers || !fix) return
    const ll: L.LatLngTuple = [fix.lat, fix.lng]
    layers.me.setLatLng(ll).addTo(map)
    layers.accuracy.setLatLng(ll).setRadius(fix.accuracy).addTo(map)
    if (followingRef.current) {
      // Keep your dot centred in the visible area above any bottom sheet.
      const target = bottomInset ? map.unproject(map.project(ll).add([0, bottomInset / 2])) : L.latLng(ll)
      map.panTo(target, { animate: true })
    }
  }, [fix, bottomInset])

  // Theme changes recolour the path and your dot.
  useEffect(() => {
    const layers = layersRef.current
    if (!layers) return
    layers.path.setStyle({ color: palette.path })
    layers.accuracy.setStyle({ fillColor: palette.me })
    if (layers.me instanceof L.CircleMarker) layers.me.setStyle({ fillColor: palette.me })
  }, [palette])

  useEffect(() => {
    layersRef.current?.path.setLatLngs(path)
  }, [path])

  // Which story circles you're standing in. Keyed as a string so the circles are only redrawn
  // when you cross a boundary, not on every fix (that would restart the arrival animation).
  const insideKey = useMemo(
    () => (fix ? stories.filter((st) => distanceToStory(fix, st) <= st.radius_m).map((st) => st.id).join('|') : ''),
    [fix, stories],
  )
  const wasInsideRef = useRef<ReadonlySet<string>>(new Set())

  useEffect(() => {
    const inside = new Set(insideKey ? insideKey.split('|') : [])
    // Arriving in a circle plays once: its outline spins while a faint wash grows out from the
    // centre to fill it, then both settle. Later redraws (a story starting, say) don't replay it.
    const arrived = new Set([...inside].filter((id) => !wasInsideRef.current.has(id)))
    wasInsideRef.current = inside
    const group = layersRef.current?.stories
    if (!group) return
    group.clearLayers()
    for (const story of stories) {
      if (!revealed.has(story.id)) continue
      const playing = story.id === playingId
      const heard = heardIds.has(story.id)
      const here = inside.has(story.id)
      // Standing in a story you haven't heard tints it with the "here" colour, like the wash;
      // it turns the playing colour once the story plays.
      const color = playing ? palette.playing : here && !heard ? palette.here : heard ? palette.heard : palette.unheard
      if (arrived.has(story.id)) {
        L.circle([story.lat, story.lng], {
          radius: story.radius_m,
          stroke: false,
          fillColor: palette.here,
          fillOpacity: 0.14,
          interactive: false,
          className: 'pif-story-wash',
        }).addTo(group)
      }
      L.circle([story.lat, story.lng], {
        radius: story.radius_m,
        color,
        weight: here ? 2.5 : 1.5,
        dashArray: heard || playing || here ? undefined : '4 4',
        fillColor: color,
        fillOpacity: playing ? 0.2 : heard ? 0.12 : arrived.has(story.id) ? 0 : here ? 0.14 : 0.05,
        className: arrived.has(story.id) ? 'pif-story-arrive' : undefined,
      })
        .bindTooltip(story.title, { permanent: true, direction: 'center', className: 'pif-story-label' })
        .addTo(group)
    }
  }, [stories, revealed, heardIds, playingId, palette, insideKey])

  const recenter = () => {
    followingRef.current = true
    setFollowing(true)
    if (fix) mapRef.current?.setView([fix.lat, fix.lng], zoom)
  }

  return (
    <div className={fill ? 'relative h-full w-full' : 'relative overflow-hidden rounded-2xl border border-stone-200'}>
      <div ref={elRef} className={fill ? 'pif-map h-full w-full' : 'pif-map h-[46dvh] min-h-64 w-full bg-stone-200'} aria-label="Map" />
      {/* Overlay sits above Leaflet's panes (z-index up to 1000). */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[1000] p-3">{children}</div>
      {!following && (
        <button
          type="button"
          onClick={recenter}
          className="absolute right-3 z-[1000] rounded-full bg-white px-4 py-3 text-base font-medium text-stone-900 shadow-md active:bg-stone-100"
          style={{ bottom: bottomInset + 24 }}
        >
          Recenter
        </button>
      )}
    </div>
  )
}
