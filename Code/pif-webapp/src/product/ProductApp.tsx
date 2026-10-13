import { useEffect, useMemo, useState } from 'react'
import type { PlaybackPosition } from '../audio/player'
import { stories as bundledStories } from '../data/stories'
import { useJourney } from '../journey/useJourney'
import { MapView, type MapPalette } from '../map/MapView'
import { hasWebBluetooth } from '../pet/link'
import { usePet } from '../pet/usePet'
import { routes } from '../position/routes'
import type { Fix } from '../position/types'
import { useTheme } from './useTheme'

// What visitors see: a full-screen map with the place you're at on top and one sheet at
// the bottom that changes with the journey (start, listening, now playing). Same engine as
// /debug, but real GPS only, the hard-coded positions in stories.json, no test tools.

const stories = bundledStories
const allIds = new Set(stories.map((s) => s.id))
const SHEET_PX = 260 // roughly how tall the bottom sheet is, to keep your dot visible above it

const LIGHT: MapPalette = { heard: '#00796b', playing: '#00a896', unheard: '#5f6b6a', me: '#00a896', path: '#00796b' }
const DARK: MapPalette = { heard: '#7ff7ea', playing: '#00f0d8', unheard: '#8a9091', me: '#00f0d8', path: '#00f0d8' }

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const distance = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`)

// Before a journey: if this browser already allows location, open the map on where you are
// (with the stories around you) instead of the first story's place. It never asks.
function usePreviewFix(): Fix | null {
  const [fix, setFix] = useState<Fix | null>(null)
  useEffect(() => {
    let cancelled = false
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then((p) => {
        if (cancelled || p.state !== 'granted') return
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            !cancelled &&
            setFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, timestamp: pos.timestamp }),
          () => {},
          { maximumAge: 60000, timeout: 10000 },
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return fix
}

export function ProductApp() {
  const theme = useTheme()
  const pet = usePet(stories)
  const journey = useJourney(stories, pet.pet)
  const previewFix = usePreviewFix()
  // Which story has its text open; a new story starts closed.
  const [readingId, setReadingId] = useState<string | null>(null)
  const heardIds = useMemo(() => new Set(journey.heard.map((s) => s.id)), [journey.heard])
  const active = journey.status !== 'idle'
  const np = journey.nowPlaying
  const here = journey.here

  return (
    <div className={`pif fixed inset-0 overflow-hidden ${theme.dark ? 'dark' : ''}`}>
      {/* The map is the screen. */}
      <div className="absolute inset-0">
        <MapView
          fill
          fix={journey.fix ?? previewFix}
          path={journey.path}
          stories={stories}
          revealed={allIds}
          heardIds={heardIds}
          playingId={np?.story.id ?? null}
          fallbackCenter={[stories[0].lat, stories[0].lng]}
          close={stories.some((s) => s.radius_m <= 50)}
          palette={theme.dark ? DARK : LIGHT}
          bottomInset={SHEET_PX}
        />
      </div>

      {/* Top: where you are, and the small controls. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-[1001] flex items-start justify-between gap-3 p-4">
        <div className="pointer-events-auto max-w-[70%] rounded-2xl bg-[var(--surface)]/95 px-4 py-3 shadow-lg ring-1 ring-[var(--line)] backdrop-blur">
          {active ? (
            <>
              <p className="text-xs font-medium tracking-wide text-[var(--muted)] uppercase">
                {here?.inside ? 'You are at' : here ? 'You are near' : 'You are'}
              </p>
              <p className="font-display text-2xl leading-tight font-bold">
                {here?.name ?? (journey.fix ? 'between places' : 'finding you…')}
              </p>
            </>
          ) : (
            <p className="font-display text-xl leading-tight font-bold">Jam</p>
          )}
        </div>
        <div className="pointer-events-auto flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={theme.cycle}
            aria-label={`Theme: ${theme.choice}`}
            className="grid h-11 w-11 place-items-center rounded-full bg-[var(--surface)]/95 text-lg shadow-lg ring-1 ring-[var(--line)] backdrop-blur active:scale-95"
          >
            {theme.choice === 'auto' ? '◐' : theme.choice === 'light' ? '☼' : '☾'}
          </button>
          {hasWebBluetooth && (
            <button
              type="button"
              onClick={pet.pet ? pet.disconnect : pet.pair}
              disabled={pet.connecting}
              className="flex h-11 items-center gap-2 rounded-full bg-[var(--surface)]/95 px-4 text-sm font-medium shadow-lg ring-1 ring-[var(--line)] backdrop-blur active:scale-95 disabled:opacity-60"
            >
              <span className={`h-2.5 w-2.5 rounded-full ${pet.pet ? 'bg-[var(--accent)]' : 'bg-[var(--muted)]'}`} />
              {pet.connecting ? 'Pairing…' : pet.pet ? pet.pet.name : 'Pair pet'}
            </button>
          )}
        </div>
      </header>

      {/* Bottom sheet: one surface whose content follows the journey. */}
      <section
        className="absolute inset-x-0 bottom-0 z-[1001] mx-auto max-w-md rounded-t-3xl bg-[var(--surface)] px-5 pt-3 pb-6 shadow-[0_-8px_30px_rgba(0,0,0,0.12)] ring-1 ring-[var(--line)]"
        aria-live="polite"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[var(--line)]" />

        {!active && (
          <>
            <p className="text-base leading-snug text-[var(--muted)]">
              We cross paths with hundreds of places every day and know almost nothing about them.
              Walk, and when you reach one with a story, it plays.
            </p>
            <button
              type="button"
              onClick={() => journey.start({ source: 'gps', route: routes[0], speed: 1.4, noise: false })}
              className="font-display mt-5 w-full rounded-2xl bg-[var(--accent)] py-5 text-xl font-bold text-[var(--on-accent)] active:scale-[0.99]"
            >
              Start journey
            </button>
            <p className="mt-3 text-center text-sm text-[var(--muted)]">
              Keep this page open with the screen on, like a music player.
            </p>
            {pet.error && <p className="mt-2 text-center text-sm text-red-500">{pet.error}</p>}
          </>
        )}

        {active && !np && (
          <>
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-[var(--accent)]" />
              </span>
              <p className="font-display text-xl font-bold">Listening for places</p>
            </div>
            <p className="mt-2 text-base text-[var(--muted)]">
              {journey.error
                ? journey.error
                : journey.next
                  ? `Next story: ${journey.next.story.place}, ${distance(journey.next.distance)} away`
                  : 'No more stories nearby.'}
            </p>
            {journey.heard.length > 0 && (
              <p className="mt-1 text-sm text-[var(--muted)]">
                Heard: {journey.heard.map((s) => s.place).join(', ')}
              </p>
            )}
            <button
              type="button"
              onClick={journey.stop}
              className="mt-5 w-full rounded-2xl bg-[var(--surface-2)] py-4 text-lg font-semibold ring-1 ring-[var(--line)] active:scale-[0.99]"
            >
              End journey
            </button>
          </>
        )}

        {active && np && (
          <NowPlaying
            place={np.story.place}
            title={np.story.title}
            text={np.story.text}
            source={np.story.source}
            position={journey.position}
            paused={journey.paused}
            reading={readingId === np.story.id}
            onRead={() => setReadingId((r) => (r === np.story.id ? null : np.story.id))}
            onPause={journey.togglePause}
            onSkip={journey.skip}
          />
        )}
      </section>
    </div>
  )
}

function NowPlaying(props: {
  place: string
  title: string
  text: string
  source: string
  position: () => PlaybackPosition | null
  paused: boolean
  reading: boolean
  onRead: () => void
  onPause: () => void
  onSkip: () => void
}) {
  const [pos, setPos] = useState<PlaybackPosition | null>(() => props.position())
  const { position } = props
  useEffect(() => {
    const t = setInterval(() => setPos(position()), 250)
    return () => clearInterval(t)
  }, [position])
  const total = pos?.durationS || 0
  const elapsed = Math.min(total, pos?.currentS ?? 0)

  return (
    <div>
      <p className="text-xs font-bold tracking-widest text-[var(--accent)] uppercase">
        {props.paused ? 'Paused' : pos?.onPet ? 'Now playing on your pet' : 'Now playing'}
      </p>
      <h2 className="font-display mt-1 text-3xl leading-tight font-bold">{props.place}</h2>
      <p className="mt-1 text-lg leading-snug text-[var(--muted)]">{props.title}</p>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${total ? (elapsed / total) * 100 : 0}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-xs text-[var(--muted)] tabular-nums">
        <span>{clock(elapsed)}</span>
        <span>{total ? clock(total) : ''}</span>
      </div>

      {props.reading && (
        <div className="mt-3 max-h-[30dvh] overflow-y-auto rounded-xl bg-[var(--surface-2)] p-4 text-base leading-relaxed">
          {props.text}
          <a href={props.source} target="_blank" rel="noreferrer" className="mt-2 block text-sm text-[var(--muted)] underline">
            Source
          </a>
        </div>
      )}

      <div className="mt-4 grid grid-cols-[1fr_1fr_auto] gap-2">
        <button
          type="button"
          onClick={props.onPause}
          className="rounded-2xl bg-[var(--accent)] py-4 text-lg font-bold text-[var(--on-accent)] active:scale-[0.99]"
        >
          {props.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={props.onSkip}
          className="rounded-2xl bg-[var(--surface-2)] py-4 text-lg font-semibold ring-1 ring-[var(--line)] active:scale-[0.99]"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={props.onRead}
          aria-pressed={props.reading}
          className="rounded-2xl bg-[var(--surface-2)] px-4 py-4 text-base font-semibold ring-1 ring-[var(--line)] active:scale-[0.99]"
        >
          {props.reading ? 'Hide' : 'Read'}
        </button>
      </div>
    </div>
  )
}
