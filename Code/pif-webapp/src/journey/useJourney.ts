import { useCallback, useEffect, useRef, useState } from 'react'
import { StoryPlayer, type StoryOutput } from '../audio/player.ts'
import type { PetLink } from '../pet/link.ts'
import { PetOutput } from '../pet/petOutput.ts'
import { InputEvent } from '../pet/protocol.ts'
import { holdScreenAwake } from './wakeLock.ts'
import type { Story } from '../data/types.ts'
import { GpsSource } from '../position/gps.ts'
import type { Route } from '../position/routes.ts'
import { SimulatedSource, type SimProgress } from '../position/simulate.ts'
import type { Fix, PositionSource } from '../position/types.ts'
import {
  createTriggerState,
  distanceToStory,
  evaluateFix,
  haversineM,
  nearestUnfired,
  placeAt,
  type PlaceAt,
  type TriggerState,
} from '../trigger/trigger.ts'

export type SourceKind = 'simulate' | 'gps'

export interface JourneySettings {
  source: SourceKind
  route: Route
  speed: number
  noise: boolean
}

export interface NowPlaying {
  story: Story
  startedAt: number
}

export type JourneyStatus = 'idle' | 'listening' | 'playing'

export interface JourneyOptions {
  /**
   * Ask before playing (the visitor app). Arriving at a place offers its story with a
   * pop-up instead of playing it; stories you pass while one plays, or put off with
   * Later, wait in a queue that plays on by itself once you've listened to one.
   */
  askFirst?: boolean
}

const INPUT_NAMES: Record<number, string> = {
  [InputEvent.pat]: 'pat',
  [InputEvent.doublePat]: 'double-pat',
  [InputEvent.shake]: 'shake',
  [InputEvent.holdStart]: 'hold start',
  [InputEvent.holdEnd]: 'hold end',
}

/** A story's marker appears on the map once you have been this close to it. */
const REVEAL_M = 2000
/** Skip path points closer than this to the last one, to keep the line light. Showcase
 * places tens of metres apart need a much finer line. */
const PATH_STEP_M = 25
const PATH_STEP_CLOSE_M = 3

export function useJourney(stories: readonly Story[], pet: PetLink | null, options: JourneyOptions = {}) {
  const askFirst = !!options.askFirst
  const [status, setStatus] = useState<JourneyStatus>('idle')
  const [settings, setSettings] = useState<JourneySettings | null>(null)
  const [fix, setFix] = useState<Fix | null>(null)
  const [progress, setProgress] = useState<SimProgress | null>(null)
  const [routeEnded, setRouteEnded] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null)
  const [queued, setQueued] = useState<Story | null>(null)
  const [heard, setHeard] = useState<Story[]>([])
  const [error, setError] = useState<string | null>(null)
  const [next, setNext] = useState<{ story: Story; distance: number } | null>(null)
  const [here, setHere] = useState<PlaceAt | null>(null)
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set())
  const [path, setPath] = useState<[number, number][]>([])
  // Ask-first mode: the story being offered right now, and the ones waiting.
  const [offer, setOffer] = useState<Story | null>(null)
  const [queue, setQueueState] = useState<Story[]>([])
  const offerRef = useRef<Story | null>(null)
  const queueRef = useRef<Story[]>([])

  const sourceRef = useRef<PositionSource | null>(null)
  const releaseWakeRef = useRef<(() => void) | null>(null)
  const triggerRef = useRef<TriggerState>(createTriggerState())
  const lastFixRef = useRef<Fix | null>(null)
  const nowPlayingRef = useRef<NowPlaying | null>(null)
  const queuedRef = useRef<Story | null>(null)
  const placesRef = useRef<Route['points']>([])
  const playerRef = useRef<StoryPlayer | null>(null)
  const finishRef = useRef<() => void>(() => {})
  const [paused, setPaused] = useState(false)

  const player = useCallback(() => (playerRef.current ??= new StoryPlayer()), [])
  const petOutputRef = useRef<PetOutput | null>(null)
  /** The pet when one is connected, otherwise the phone. */
  const output = useCallback((): StoryOutput => petOutputRef.current ?? player(), [player])

  const setQueue = useCallback((q: Story[]) => {
    queueRef.current = q
    setQueueState(q)
  }, [])
  const setOfferNow = useCallback((st: Story | null) => {
    offerRef.current = st
    setOffer(st)
  }, [])
  const enqueue = useCallback(
    (st: Story) => {
      if (!queueRef.current.some((q) => q.id === st.id)) setQueue([...queueRef.current, st])
    },
    [setQueue],
  )

  const play = useCallback(
    (story: Story) => {
      const np = { story, startedAt: Date.now() }
      nowPlayingRef.current = np
      setNowPlaying(np)
      setPaused(false)
      setHeard((h) => [...h, story])
      setStatus('playing')
      // A missing or unplayable file falls back to a duration_s timer inside the player.
      output().play(story, () => finishRef.current())
    },
    [output],
  )

  const handleFix = useCallback(
    (f: Fix) => {
      lastFixRef.current = f
      setFix(f)
      const story = evaluateFix(triggerRef.current, f, stories)
      setNext(nearestUnfired(triggerRef.current, f, stories))
      setHere(placeAt(f, stories, placesRef.current))
      setRevealed((prev) => {
        const add = stories.filter((st) => !prev.has(st.id) && distanceToStory(f, st) <= REVEAL_M)
        return add.length ? new Set([...prev, ...add.map((st) => st.id)]) : prev
      })
      // Wild fixes would zigzag the line; only draw fixes accurate enough to trust.
      if (f.accuracy <= 100) {
        setPath((p) => {
          const last = p[p.length - 1]
          const step = stories.some((st) => st.radius_m <= 50) ? PATH_STEP_CLOSE_M : PATH_STEP_M
          if (last && haversineM(last[0], last[1], f.lat, f.lng) < step) return p
          return [...p, [f.lat, f.lng]]
        })
      }
      if (!story) return
      if (askFirst) {
        navigator.vibrate?.([80, 60, 80])
        if (nowPlayingRef.current) {
          enqueue(story)
        } else {
          // A newer place replaces an unanswered offer; the older one waits in the queue.
          if (offerRef.current) enqueue(offerRef.current)
          setOfferNow(story)
        }
        return
      }
      if (nowPlayingRef.current) {
        // A queue of one: the newest trigger waits for the current story.
        queuedRef.current = story
        setQueued(story)
      } else {
        play(story)
      }
    },
    [stories, play, askFirst, enqueue, setOfferNow],
  )

  /** Ends the current story and plays the queued one if we are still near it. */
  const finishCurrent = useCallback(() => {
    output().stop()
    nowPlayingRef.current = null
    setNowPlaying(null)
    if (askFirst) {
      // The queue plays on by itself: audio was unlocked by the Listen tap.
      const [nextUp, ...rest] = queueRef.current
      if (nextUp) {
        setQueue(rest)
        play(nextUp)
      } else {
        setStatus((s) => (s === 'idle' || !sourceRef.current ? 'idle' : 'listening'))
      }
      return
    }
    const waiting = queuedRef.current
    queuedRef.current = null
    setQueued(null)
    const f = lastFixRef.current
    if (waiting && f && distanceToStory(f, waiting) <= waiting.radius_m) {
      play(waiting)
    } else {
      setStatus((s) => (s === 'idle' || !sourceRef.current ? 'idle' : 'listening'))
    }
  }, [play, output, askFirst, setQueue])

  /** Play a story now, from the pop-up or the queue. Call inside the tap (audio rule). */
  const listen = useCallback(
    (st: Story) => {
      player().unlock()
      if (offerRef.current?.id === st.id) setOfferNow(null)
      setQueue(queueRef.current.filter((q) => q.id !== st.id))
      if (nowPlayingRef.current) output().stop()
      play(st)
    },
    [play, player, output, setOfferNow, setQueue],
  )
  /** Put the offered story off: it waits in the queue. */
  const later = useCallback(() => {
    if (offerRef.current) enqueue(offerRef.current)
    setOfferNow(null)
  }, [enqueue, setOfferNow])
  const listenRef = useRef(listen)
  const laterRef = useRef(later)
  useEffect(() => {
    listenRef.current = listen
    laterRef.current = later
  }, [listen, later])
  const unqueue = useCallback(
    (id: string) => setQueue(queueRef.current.filter((q) => q.id !== id)),
    [setQueue],
  )

  const togglePauseRef = useRef<() => void>(() => {})
  useEffect(() => {
    finishRef.current = finishCurrent
  }, [finishCurrent])

  const togglePause = useCallback(() => {
    const p = output()
    if (!nowPlayingRef.current) return
    if (p.position().paused) {
      p.resume()
      setPaused(false)
    } else {
      p.pause()
      setPaused(true)
    }
  }, [output])

  useEffect(() => {
    togglePauseRef.current = togglePause
  }, [togglePause])

  const position = useCallback(() => (nowPlayingRef.current ? output().position() : null), [output])

  // Test panel: play one story on the current output (pet or phone) without a journey,
  // to check the pet end to end while building the hardware.
  const [testStory, setTestStory] = useState<Story | null>(null)
  const [testPaused, setTestPaused] = useState(false)
  const [petEvents, setPetEvents] = useState<string[]>([])
  const testStoryRef = useRef<Story | null>(null)
  const testTogglePauseRef = useRef<() => void>(() => {})
  const testStopRef = useRef<() => void>(() => {})

  const testPlay = useCallback(
    (story: Story) => {
      testStoryRef.current = story
      setTestStory(story)
      setTestPaused(false)
      output().play(story, () => {
        if (testStoryRef.current === story) {
          testStoryRef.current = null
          setTestStory(null)
        }
      })
    },
    [output],
  )
  const testTogglePause = useCallback(() => {
    if (!testStoryRef.current) return
    const p = output()
    if (p.position().paused) {
      p.resume()
      setTestPaused(false)
    } else {
      p.pause()
      setTestPaused(true)
    }
  }, [output])
  const testStop = useCallback(() => {
    testStoryRef.current = null
    setTestStory(null)
    output().stop()
  }, [output])
  const testPosition = useCallback(() => (testStoryRef.current ? output().position() : null), [output])
  useEffect(() => {
    testTogglePauseRef.current = testTogglePause
    testStopRef.current = testStop
  }, [testTogglePause, testStop])

  // Between stories, the pet's screen says where you are: a place name, never coordinates.
  useEffect(() => {
    const out = petOutputRef.current
    if (!out || status !== 'listening') return
    if (offer) out.showOffer(offer)
    else if (here) out.showIdle(here.inside ? here.name : `near ${here.name}`, here.inside ? 'You are here' : 'Keep walking')
    else out.showIdle('Listening for places', '')
  }, [here, status, pet, offer])

  // Connect a pet: stories go to it from the next one on. A pat pauses or resumes,
  // a double-pat skips.
  useEffect(() => {
    if (!pet) return
    const out = new PetOutput(pet, player())
    out.onInput = (event) => {
      setPetEvents((list) => [INPUT_NAMES[event] ?? `input ${event}`, ...list].slice(0, 5))
      // Outside a journey, touches drive the test panel's story instead.
      if (!nowPlayingRef.current && testStoryRef.current) {
        if (event === InputEvent.pat) testTogglePauseRef.current()
        if (event === InputEvent.doublePat) testStopRef.current()
        return
      }
      // A story on offer (ask-first mode): a pat listens, a double-pat is Later.
      const offered = offerRef.current
      if (!nowPlayingRef.current && offered) {
        if (event === InputEvent.pat) listenRef.current(offered)
        if (event === InputEvent.doublePat) laterRef.current()
        return
      }
      if (event === InputEvent.pat) togglePauseRef.current()
      if (event === InputEvent.doublePat) finishRef.current()
    }
    out.announceArrival = !askFirst
    petOutputRef.current = out
    return () => {
      if (petOutputRef.current === out) petOutputRef.current = null
    }
  }, [pet, player, askFirst])

  const start = useCallback(
    (s: JourneySettings) => {
      // Must run inside the Start journey tap: browsers only allow audio after a gesture.
      if (testStoryRef.current) testStop()
      player().unlock()
      releaseWakeRef.current?.()
      releaseWakeRef.current = holdScreenAwake()
      triggerRef.current = createTriggerState()
      lastFixRef.current = null
      nowPlayingRef.current = null
      queuedRef.current = null
      setNowPlaying(null)
      setQueued(null)
      setHeard([])
      setFix(null)
      setNext(null)
      setHere(null)
      setRevealed(new Set())
      setPath([])
      setProgress(null)
      setRouteEnded(false)
      setError(null)
      setSettings(s)
      setStatus('listening')
      // Named route points help say where you are between stories in simulation.
      placesRef.current = s.source === 'simulate' ? s.route.points : []

      // Rule 4: this is the only place that knows which source is in use.
      const source: PositionSource =
        s.source === 'simulate'
          ? new SimulatedSource(s.route, {
              speed: s.speed,
              noise: s.noise,
              onProgress: setProgress,
              onEnd: () => setRouteEnded(true),
            })
          : new GpsSource()
      sourceRef.current = source
      source.start(handleFix, (e) => setError(e.message))
    },
    [handleFix, player, testStop],
  )

  const stop = useCallback(() => {
    releaseWakeRef.current?.()
    releaseWakeRef.current = null
    output().stop()
    sourceRef.current?.stop()
    sourceRef.current = null
    nowPlayingRef.current = null
    queuedRef.current = null
    setNowPlaying(null)
    setQueued(null)
    if (offerRef.current) enqueue(offerRef.current)
    setOfferNow(null)
    setStatus('idle')
  }, [output, enqueue, setOfferNow])

  const updateSim = useCallback((patch: Partial<Pick<JourneySettings, 'speed' | 'noise'>>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    const source = sourceRef.current
    if (source instanceof SimulatedSource) {
      if (patch.speed !== undefined) source.setSpeed(patch.speed)
      if (patch.noise !== undefined) source.setNoise(patch.noise)
    }
  }, [])

  useEffect(
    () => () => {
      releaseWakeRef.current?.()
      sourceRef.current?.stop()
      petOutputRef.current?.stop()
      playerRef.current?.stop()
    },
    [],
  )

  return {
    test: { story: testStory, paused: testPaused, play: testPlay, togglePause: testTogglePause, stop: testStop, position: testPosition },
    petEvents,
    status,
    settings,
    fix,
    progress,
    routeEnded,
    nowPlaying,
    queued,
    offer,
    queue,
    listen,
    later,
    unqueue,
    heard,
    next,
    here,
    revealed,
    path,
    error,
    start,
    stop,
    skip: finishCurrent,
    paused,
    togglePause,
    position,
    updateSim,
  }
}
