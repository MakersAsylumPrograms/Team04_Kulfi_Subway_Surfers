import { useEffect, useRef, useState } from 'react'
import type { FakePet, FakePetDisplay } from './fakePet'
import faces from './faces.json'
import { InputEvent, PlaybackState } from './protocol'

// A pixel-for-pixel stand-in for the pet's 240x320 screen (upright), so faces, arrivals and story
// screens can be checked in the browser before flashing. Mirrors firmware/pet_story_player
// (pet_screen.h for the layout, the mood rules in pet_story_player.ino). Change both together.

const W = 240
const H = 320
const MARGIN = 16
const FACE_X = Math.floor((W - faces.width) / 2)
const FACE_Y = 46
// The firmware's colours (pet_screen.h): white, near-black, grey, one red.
const BG = '#ffffff'
const INK = '#1c1c1c'
const DIM = '#8a8a8a'
const RED = '#e53935'
const TRACK = '#e6e6e6'
// Colours for character and stories (the firmware's C_* in pet_screen.h).
const C = { red: '#e53935', orange: '#fb8c00', green: '#43a047', teal: '#00897b', blue: '#1e88e5', purple: '#8e24aa', pink: '#d81b60' }
const MOOD_COLOUR: Record<string, string> = {
  Angry: C.red,
  Annoyed: C.orange,
  Bored: C.teal,
  Heart_Eyes: C.pink,
  Normal: C.red,
  Sad: C.blue,
  Sleepy: C.purple,
}
const STORY_COLOURS = [C.red, C.orange, C.green, C.teal, C.blue, C.purple, C.pink]
/** The same hash as the firmware's storyColour(): a place is always the same colour. */
function storyColour(place: string) {
  let h = 5381
  for (const b of new TextEncoder().encode(place)) h = (Math.imul(h, 33) + b) >>> 0
  return STORY_COLOURS[h % STORY_COLOURS.length]
}
// The firmware uses Adafruit's FreeSans fonts; Arial is close in a browser.
const FONT = {
  label: 'bold 13px Arial, Helvetica, sans-serif', // FreeSansBold9pt
  place: 'bold 25px Arial, Helvetica, sans-serif', // FreeSansBold18pt
  title: '17px Arial, Helvetica, sans-serif', // FreeSans12pt
  caption: 'bold 17px Arial, Helvetica, sans-serif', // FreeSansBold12pt
  small: '13px Arial, Helvetica, sans-serif', // FreeSans9pt
}
const BORED_AFTER_MS = 120_000
const SLEEPY_AFTER_MS = 240_000
const SCREEN_OFF_MS = 360_000
const FRAME_MS = 140

type Mood = keyof typeof faces.moods
const MOODS = Object.keys(faces.moods) as Mood[]

function moodNow(d: FakePetDisplay, now: number): Mood | 'off' {
  if (d.reaction && d.reaction.until > now) return d.reaction.mood as Mood
  const playing = d.state === PlaybackState.playing || d.state === PlaybackState.paused
  if (playing) return 'Normal'
  const idle = now - d.lastActivityAt
  if (idle > SCREEN_OFF_MS) return 'off'
  if (idle > SLEEPY_AFTER_MS) return 'Sleepy'
  if (idle > BORED_AFTER_MS) return 'Bored'
  return 'Normal'
}

function drawFace(ctx: CanvasRenderingContext2D, frame: number[], colour: string) {
  let i = 0
  ctx.fillStyle = colour
  for (let y = 0; y < faces.height; y++) {
    let x = 0
    let lit = false
    while (x < faces.width) {
      const len = frame[i++]
      if (lit && len) ctx.fillRect(FACE_X + x, FACE_Y + y, len, 1)
      x += len
      lit = !lit
    }
  }
}

function fitLine(ctx: CanvasRenderingContext2D, t: string, maxW: number) {
  if (ctx.measureText(t).width <= maxW) return t
  while (t.length > 1 && ctx.measureText(t + '...').width > maxW) t = t.slice(0, -1)
  return t + '...'
}

// Same word-wrap as the firmware's wrapped(): at most maxLines, the last one cut with "...".
function wrapped(
  ctx: CanvasRenderingContext2D,
  font: string,
  text: string,
  x: number,
  baseline: number,
  maxW: number,
  lineH: number,
  maxLines: number,
  color: string,
  centre = false,
) {
  ctx.font = font
  ctx.fillStyle = color
  ctx.textBaseline = 'alphabetic'
  const words = text.split(' ')
  let lines = 0
  while (words.length && lines < maxLines) {
    let line = words.shift()!
    while (words.length && ctx.measureText(line + ' ' + words[0]).width <= maxW) line += ' ' + words.shift()
    if (lines === maxLines - 1 && words.length) line = line + ' ' + words.join(' ')
    const shown = fitLine(ctx, line, maxW)
    ctx.fillText(shown, centre ? (W - ctx.measureText(shown).width) / 2 : x, baseline)
    baseline += lineH
    lines++
  }
  return baseline
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function FakePetPanel({ pet }: { pet: FakePet }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const displayRef = useRef<FakePetDisplay | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [mood, setMood] = useState<string>('Normal')

  useEffect(
    () =>
      pet.watch((d) => {
        displayRef.current = d
        setLog(d.log)
      }),
    [pet],
  )

  // Animation loop: same timing as the firmware (Normal blinks every few seconds, other
  // moods loop their frames, long idle turns the screen off).
  useEffect(() => {
    let raf = 0
    let shownMood: string | null = null
    let frame = 0
    let frameAt = 0
    let blinking = false
    let nextBlink = performance.now() + 2500
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      const d = displayRef.current
      const ctx = canvasRef.current?.getContext('2d')
      if (!d || !ctx) return
      const m = moodNow(d, Date.now())
      if (m !== shownMood) {
        shownMood = m
        frame = 0
        frameAt = t
        blinking = false
        nextBlink = t + 2500
        setMood(m)
      }
      ctx.fillStyle = m === 'off' ? '#000' : BG
      ctx.fillRect(0, 0, W, H)
      if (m === 'off') return
      const frames = faces.moods[m]
      if (m === 'Normal') {
        if (!blinking && t >= nextBlink) {
          blinking = true
          frame = 0
          frameAt = t
        }
        if (blinking && t - frameAt >= FRAME_MS) {
          frameAt = t
          if (++frame >= frames.length) {
            frame = 0
            blinking = false
            nextBlink = t + 3000 + Math.random() * 3000
          }
        }
      } else if (t - frameAt >= FRAME_MS * 2) {
        frameAt = t
        frame = (frame + 1) % frames.length
      }
      const story = d.state === PlaybackState.playing || d.state === PlaybackState.paused
      const colour = storyColour(d.place)
      if (!story) {
        // The connection dot (the fake pet always is). The name is shown at startup, not here.
        ctx.fillStyle = C.green
        ctx.beginPath()
        ctx.arc(W - MARGIN - 4, 22, 5, 0, Math.PI * 2)
        ctx.fill()
      }

      if (story) {
        // Story screen: no face.
        const paused = d.state === PlaybackState.paused
        // A band in the story's colour (grey when paused), with the label and the dot.
        ctx.fillStyle = paused ? DIM : colour
        ctx.fillRect(0, 0, W, 46)
        ctx.font = FONT.label
        ctx.fillStyle = BG
        ctx.fillText(paused ? 'PAUSED' : 'NOW PLAYING', MARGIN, 29)
        ctx.beginPath()
        ctx.arc(W - MARGIN - 4, 22, 5, 0, Math.PI * 2)
        ctx.fill()
        const next = wrapped(ctx, FONT.place, d.place, MARGIN, 82, W - 2 * MARGIN, 34, 3, INK)
        wrapped(ctx, FONT.title, d.title, MARGIN, next + 8, W - 2 * MARGIN, 24, 4, DIM)
        const barW = W - 2 * MARGIN
        const w = d.durationS ? Math.min(barW, (barW * d.positionS) / d.durationS) : 0
        ctx.fillStyle = TRACK
        ctx.beginPath()
        ctx.roundRect(MARGIN, 270, barW, 6, 3)
        ctx.fill()
        if (w > 0) {
          ctx.fillStyle = paused ? DIM : colour
          ctx.beginPath()
          ctx.roundRect(MARGIN, 270, Math.max(w, 6), 6, 3)
          ctx.fill()
        }
        ctx.font = FONT.small
        ctx.fillStyle = DIM
        ctx.fillText(clock(d.positionS), MARGIN, 302)
        const total = clock(d.durationS)
        ctx.fillText(total, W - MARGIN - ctx.measureText(total).width, 302)
      } else {
        // Pet screen: the face, then the place and a status line.
        drawFace(ctx, frames[frame], MOOD_COLOUR[m] ?? RED)
        if (!d.place) wrapped(ctx, FONT.title, 'Connected', 0, 248, W - 2 * MARGIN, 26, 2, DIM, true)
        else {
          const next = wrapped(ctx, FONT.caption, d.place, 0, 244, W - 2 * MARGIN, 26, 2, INK, true)
          const line2 = d.state === PlaybackState.missingFile ? 'Not on the SD card: the phone plays it' : d.title
          if (line2) wrapped(ctx, FONT.small, line2, 0, next + 2, W - 2 * MARGIN, 20, 2, DIM, true)
        }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-4" aria-label="Fake pet">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-stone-500">Pet screen (simulated, 240×320)</p>
        <p className="text-xs text-stone-500">{mood === 'off' ? 'screen off' : mood}</p>
      </div>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="mx-auto mt-2 block w-full max-w-[240px] rounded-lg border border-stone-200 bg-white"
        style={{ imageRendering: 'pixelated', aspectRatio: `${W} / ${H}` }}
        aria-label="Simulated pet display"
      />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => {
            pet.react('Heart_Eyes', 2000)
            pet.input(InputEvent.pat)
          }}
          className="rounded-xl border border-stone-300 py-2 text-sm font-medium active:bg-stone-100"
        >
          Pat
        </button>
        <button
          type="button"
          onClick={() => pet.input(InputEvent.doublePat)}
          className="rounded-xl border border-stone-300 py-2 text-sm font-medium active:bg-stone-100"
        >
          Double-pat
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {MOODS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => pet.react(m, 5000)}
            className="rounded-lg border border-stone-300 px-2 py-1 text-xs text-stone-600 active:bg-stone-100"
          >
            {m.replace('_', ' ')}
          </button>
        ))}
      </div>
      {log.length > 0 && (
        <ul className="mt-3 space-y-0.5 font-mono text-xs text-stone-500">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
