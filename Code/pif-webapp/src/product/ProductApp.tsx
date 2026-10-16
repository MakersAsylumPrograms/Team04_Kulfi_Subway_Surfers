import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlaybackPosition } from '../audio/player'
import type { Story } from '../data/types'
import { stories as bundledStories } from '../data/stories'
import { useJourney } from '../journey/useJourney'
import { MapView, type MapPalette } from '../map/MapView'
import { hasWebBluetooth } from '../pet/link'
import { usePet } from '../pet/usePet'
import { routes } from '../position/routes'
import { haversineM } from '../trigger/trigger'
import type { Fix } from '../position/types'
import { Intro } from './Intro'
import { JamWordmark } from './JamWordmark'
import mascot from './assets/jam-mascot.png'
import { useIntro } from './useIntro'
import { useTheme } from './useTheme'

// What visitors see: a full-screen map with the place you're at on top and one sheet at
// the bottom. There is no "journey" to start: Jam listens for places as soon as location is
// allowed, offers each story with a pop-up (Listen / Later), and keeps the rest in a queue.
// Same engine as /debug, but real GPS only, the positions in stories.json, no test tools.

const stories = bundledStories
const allIds = new Set(stories.map((s) => s.id))
const SHEET_PX = 170 // roughly how tall the bottom sheet is, to keep your dot visible above it

const LIGHT: MapPalette = { heard: '#00796b', playing: '#00a896', unheard: '#5f6b6a', me: '#00a896', path: '#00796b' }
const DARK: MapPalette = { heard: '#7ff7ea', playing: '#00f0d8', unheard: '#8a9091', me: '#00f0d8', path: '#00f0d8' }

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const OFFER_TIMEOUT_MS = 45_000 // an unanswered pop-up slips into the queue
const GPS_START = { source: 'gps', route: routes[0], speed: 1.4, noise: false } as const
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
  // Light only for now (2026-10-15). Drop lightOnly and restore the theme button below to bring dark back.
  const theme = useTheme({ lightOnly: true })
  const pet = usePet(stories)
  const journey = useJourney(stories, pet.pet, { askFirst: true })
  const previewFix = usePreviewFix()
  const intro = useIntro()
  // Which story has its text open; a new story starts closed.
  const [readingId, setReadingId] = useState<string | null>(null)
  const heardIds = useMemo(() => new Set(journey.heard.map((s) => s.id)), [journey.heard])
  const active = journey.status !== 'idle'
  const np = journey.nowPlaying
  const here = journey.here
  const [queueOpen, setQueueOpen] = useState(false)

  // If this browser already allows location, start listening for places straight away.
  // Otherwise the "Find stories near me" button asks (it never asks by itself).
  const startRef = useRef(journey.start)
  useEffect(() => {
    startRef.current = journey.start
  })
  useEffect(() => {
    let cancelled = false
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then((p) => {
        if (!cancelled && p.state === 'granted') startRef.current({ ...GPS_START })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // An offer nobody answers goes to the queue after a while.
  const laterRef = useRef(journey.later)
  useEffect(() => {
    laterRef.current = journey.later
  })
  const offerId = journey.offer?.id
  useEffect(() => {
    if (!offerId) return
    const t = setTimeout(() => laterRef.current(), OFFER_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [offerId])

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
          meIcon={mascot}
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
            <JamWordmark className="h-7 w-auto" />
          )}
        </div>
        <div className="pointer-events-auto flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={intro.show}
            aria-label="What is Jam?"
            className="font-display grid h-11 w-11 place-items-center rounded-full bg-[var(--surface)]/95 text-lg font-bold shadow-lg ring-1 ring-[var(--line)] backdrop-blur active:scale-95"
          >
            ?
          </button>
          {/* Theme button, hidden while the app is light only:
          <button
            type="button"
            onClick={theme.cycle}
            aria-label={`Theme: ${theme.choice}`}
            className="grid h-11 w-11 place-items-center rounded-full bg-[var(--surface)]/95 text-lg shadow-lg ring-1 ring-[var(--line)] backdrop-blur active:scale-95"
          >
            {theme.choice === 'auto' ? '◐' : theme.choice === 'light' ? '☼' : '☾'}
          </button>
          */}
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

      {/* Bottom: the story offer pops up above one sheet that says what Jam is doing. */}
      <div className="absolute inset-x-0 bottom-0 z-[1001] mx-auto max-w-md">
        {journey.offer && (
          <Offer
            story={journey.offer}
            distance={journey.fix ? distanceTo(journey.fix, journey.offer) : null}
            onListen={() => journey.offer && journey.listen(journey.offer)}
            onLater={journey.later}
          />
        )}

        <section
          className="rounded-t-3xl bg-[var(--surface)] px-5 pt-2 pb-4 shadow-[0_-8px_30px_rgba(0,0,0,0.12)] ring-1 ring-[var(--line)]"
          aria-live="polite"
        >
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--line)]" />

          {!active && (
            <>
              <p className="text-base leading-snug text-[var(--muted)]">
                Stories play when you're near the places they're about. Jam needs your location to know where you are.
              </p>
              <button
                type="button"
                onClick={() => journey.start({ ...GPS_START })}
                className="font-display mt-4 w-full rounded-2xl bg-[var(--accent)] py-4 text-lg font-bold text-[var(--on-accent)] active:scale-[0.99]"
              >
                Find stories near me
              </button>
              <p className="mt-3 text-center text-sm text-[var(--muted)]">Jam keeps your screen on while it listens.</p>
              {pet.error && <p className="mt-2 text-center text-sm text-red-500">{pet.error}</p>}
            </>
          )}

          {active && !np && (
            <div className="flex items-start gap-3">
              <span className="relative mt-2 flex h-3 w-3 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-[var(--accent)]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display text-lg font-bold">Listening for stories</p>
                <p className="mt-0.5 text-sm text-[var(--muted)]">
                  {journey.error
                    ? journey.error
                    : journey.next
                      ? `Nearest: ${journey.next.story.place}, ${distance(journey.next.distance)} away`
                      : journey.fix
                        ? 'No more stories nearby.'
                        : 'Finding you…'}
                </p>
              </div>
              <button
                type="button"
                onClick={journey.stop}
                className="shrink-0 rounded-full bg-[var(--surface-2)] px-4 py-2 text-sm font-semibold ring-1 ring-[var(--line)] active:scale-95"
              >
                Stop
              </button>
            </div>
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

          {journey.queue.length > 0 && (
            <Queue
              stories={journey.queue}
              open={queueOpen}
              onToggle={() => setQueueOpen((o) => !o)}
              onPlay={journey.listen}
              onRemove={journey.unqueue}
              playing={!!np}
            />
          )}
        </section>
      </div>

      {intro.open && <Intro onClose={intro.close} splash={intro.firstVisit} />}
    </div>
  )
}

function distanceTo(fix: { lat: number; lng: number }, story: Story) {
  return haversineM(fix.lat, fix.lng, story.lat, story.lng)
}

/** The pop-up when you reach a place: one compact row, listen now or keep it for later. */
function Offer(props: { story: Story; distance: number | null; onListen: () => void; onLater: () => void }) {
  return (
    <div
      role="alertdialog"
      aria-label={`Story nearby: ${props.story.place}`}
      className="jam-pop mx-3 mb-2 flex items-center gap-2 rounded-2xl bg-[var(--surface)] p-2.5 pl-4 shadow-[0_8px_28px_rgba(0,0,0,0.2)] ring-2 ring-[var(--accent)]"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold tracking-widest text-[var(--accent)] uppercase">
          {props.distance !== null && props.distance > 30 ? `Story · ${distance(props.distance)}` : 'Story here'}
        </p>
        <p className="font-display truncate text-lg leading-tight font-bold">{props.story.place}</p>
        <p className="truncate text-sm text-[var(--muted)]">{props.story.title}</p>
      </div>
      <button
        type="button"
        onClick={props.onLater}
        className="h-11 shrink-0 rounded-xl px-3 text-sm font-semibold text-[var(--muted)] active:scale-95"
      >
        Later
      </button>
      <button
        type="button"
        onClick={props.onListen}
        className="font-display h-11 shrink-0 rounded-xl bg-[var(--accent)] px-4 text-base font-bold text-[var(--on-accent)] active:scale-95"
      >
        Listen
      </button>
    </div>
  )
}

/** Stories you passed and haven't heard yet. They play on by themselves after the current one. */
function Queue(props: {
  stories: Story[]
  open: boolean
  playing: boolean
  onToggle: () => void
  onPlay: (s: Story) => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="mt-3 border-t border-[var(--line)] pt-1">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        className="flex min-h-11 w-full items-center justify-between text-left"
      >
        <span className="text-sm font-semibold">
          {props.playing ? 'Up next' : 'Saved for later'}{' '}
          <span className="text-[var(--muted)]">· {props.stories.length}</span>
        </span>
        <span className="text-sm text-[var(--muted)]">{props.open ? 'Hide' : 'Show'}</span>
      </button>
      {props.open && (
        <ul className="max-h-[22dvh] divide-y divide-[var(--line)] overflow-y-auto">
          {props.stories.map((st) => (
            <li key={st.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => props.onPlay(st)}
                aria-label={`Play ${st.place}: ${st.title}`}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left active:opacity-70"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[11px] text-[var(--on-accent)]">
                  ▶
                </span>
                <span className="min-w-0 truncate text-sm">
                  <span className="font-semibold">{st.place}</span>
                  <span className="text-[var(--muted)]"> · {st.title}</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => props.onRemove(st.id)}
                aria-label={`Remove ${st.place} from the queue`}
                className="grid h-11 w-9 shrink-0 place-items-center text-lg text-[var(--muted)] active:scale-95"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
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
      <p className="text-[11px] font-bold tracking-widest text-[var(--accent)] uppercase">
        {props.paused ? 'Paused' : pos?.onPet ? 'Now playing on your pet' : 'Now playing'}
      </p>
      <h2 className="font-display truncate text-xl leading-tight font-bold">{props.place}</h2>
      <p className="truncate text-sm text-[var(--muted)]">{props.title}</p>

      <div className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)] tabular-nums">
        <span>{clock(elapsed)}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
          <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${total ? (elapsed / total) * 100 : 0}%` }} />
        </div>
        <span>{total ? clock(total) : ''}</span>
      </div>

      {props.reading && (
        <div className="mt-3 max-h-[28dvh] overflow-y-auto rounded-xl bg-[var(--surface-2)] p-3 text-sm leading-relaxed">
          {props.text}
          <a href={props.source} target="_blank" rel="noreferrer" className="mt-2 block text-xs text-[var(--muted)] underline">
            Source
          </a>
        </div>
      )}

      <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2">
        <button
          type="button"
          onClick={props.onPause}
          className="h-11 rounded-xl bg-[var(--accent)] text-base font-bold text-[var(--on-accent)] active:scale-[0.99]"
        >
          {props.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={props.onSkip}
          className="h-11 rounded-xl bg-[var(--surface-2)] text-base font-semibold ring-1 ring-[var(--line)] active:scale-[0.99]"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={props.onRead}
          aria-pressed={props.reading}
          className="h-11 rounded-xl bg-[var(--surface-2)] px-4 text-sm font-semibold ring-1 ring-[var(--line)] active:scale-[0.99]"
        >
          {props.reading ? 'Hide' : 'Read'}
        </button>
      </div>
    </div>
  )
}
