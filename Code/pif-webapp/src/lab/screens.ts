// The pet's screens, designed in the lab. Each one draws a whole screen from a small model
// (place, title, progress …) with the pet's own fonts and colours, so what you see here (and
// send to the pet) is what the firmware will draw once a design is chosen and ported to
// pet_screen.h. Portrait 240x320 first; they also lay out at 320x240.
import { crane } from './optionalAssets'
import faces from '../pet/faces.json'
import { centred, drawText, textWidth, wrapped } from './gfxText'

// The firmware's colours (RGB565), as the panel shows them.
export const INK = '#1c1c1c' // 0x18E3
export const DIM = '#8a8a8a' // 0x8C51
export const ACCENT = '#e53935' // 0xE1C6, the pet's red
export const TRACK = '#e6e6e6' // 0xE73C

export type Mood = keyof typeof faces.moods

export interface ScreenModel {
  place: string
  title: string
  status: string
  progress: number // 0 to 1
  durationS: number
  volume: number // 0 to 10
  connected: boolean
  mood: Mood
}

export const DEFAULT_MODEL: ScreenModel = {
  place: 'Mahim Causeway',
  title: 'The road a widow paid for',
  status: 'Connected',
  progress: 0.38,
  durationS: 172,
  volume: 9,
  connected: true,
  mood: 'Normal',
}

type Draw = (ctx: CanvasRenderingContext2D, W: number, H: number, m: ScreenModel, tick: number) => void

function face(ctx: CanvasRenderingContext2D, mood: Mood, tick: number, x: number, y: number) {
  const frames = faces.moods[mood]
  const runs = frames[Math.floor(tick / 2) % frames.length] // faces run at half the lab's rate
  ctx.fillStyle = ACCENT
  let i = 0
  for (let yy = 0; yy < faces.height; yy++) {
    let xx = 0
    let lit = false
    while (xx < faces.width) {
      const len = runs[i++]
      if (lit && len) ctx.fillRect(x + xx, y + yy, len, 1)
      xx += len
      lit = !lit
    }
  }
}

function statusDot(ctx: CanvasRenderingContext2D, W: number, m: ScreenModel) {
  ctx.fillStyle = m.connected ? ACCENT : DIM
  ctx.beginPath()
  ctx.arc(W - 12, 12, 4, 0, Math.PI * 2)
  ctx.fill()
}

function clock(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

function progressBar(ctx: CanvasRenderingContext2D, W: number, y: number, m: ScreenModel, colour: string) {
  const x = 16
  const w = W - 32
  ctx.fillStyle = TRACK
  ctx.fillRect(x, y, w, 4)
  ctx.fillStyle = colour
  ctx.fillRect(x, y, Math.round(w * m.progress), 4)
  drawText(ctx, 'FreeSans9pt7b', clock(m.progress * m.durationS), x, y + 24, DIM)
  const total = clock(m.durationS)
  drawText(ctx, 'FreeSans9pt7b', total, W - x - textWidth('FreeSans9pt7b', total), y + 24, DIM)
}

const faceX = (W: number) => Math.floor((W - faces.width) / 2)

const idle: Draw = (ctx, W, H, m, tick) => {
  statusDot(ctx, W, m)
  face(ctx, m.mood, tick, faceX(W), H > W ? 36 : 4)
  const y = H > W ? 236 : 190
  centred(ctx, 'FreeSansBold12pt7b', m.place, y, INK, W)
  centred(ctx, 'FreeSans9pt7b', m.status, y + 26, DIM, W)
}

const waiting: Draw = (ctx, W, H, m, tick) => {
  statusDot(ctx, W, { ...m, connected: false })
  face(ctx, 'Normal', tick, faceX(W), H > W ? 50 : 4)
  wrapped(ctx, 'FreeSans12pt7b', 'Waiting for your phone', 0, H > W ? 250 : 200, W - 24, 26, 2, DIM, 'centre', W)
}

const arrival: Draw = (ctx, W, H, m, tick) => {
  statusDot(ctx, W, m)
  const portrait = H > W
  face(ctx, 'Heart_Eyes', tick, faceX(W), portrait ? 16 : 4)
  const top = portrait ? 200 : 178
  centred(ctx, 'FreeSansBold9pt7b', "YOU'VE ARRIVED AT", top, ACCENT, W)
  wrapped(ctx, 'FreeSansBold18pt7b', m.place, 0, top + 34, W - 24, 32, portrait ? 2 : 1, INK, 'centre', W)
  if (portrait) centred(ctx, 'FreeSans9pt7b', 'A story starts in a moment', H - 14, DIM, W)
}

function storyScreen(paused: boolean): Draw {
  return (ctx, W, H, m) => {
    statusDot(ctx, W, m)
    const portrait = H > W
    const x = 16
    drawText(ctx, 'FreeSansBold9pt7b', paused ? 'PAUSED' : 'NOW PLAYING', x, 30, paused ? DIM : ACCENT)
    if (paused) {
      ctx.fillStyle = DIM
      ctx.fillRect(W - 36, 18, 4, 14)
      ctx.fillRect(W - 28, 18, 4, 14)
    }
    const next = wrapped(ctx, 'FreeSansBold18pt7b', m.place, x, 74, W - 2 * x, 34, portrait ? 3 : 2, paused ? DIM : INK)
    wrapped(ctx, 'FreeSans12pt7b', m.title, x, next + 6, W - 2 * x, 24, portrait ? 4 : 2, DIM)
    progressBar(ctx, W, H - 44, m, paused ? DIM : ACCENT)
  }
}

const volume: Draw = (ctx, W, H, m) => {
  statusDot(ctx, W, m)
  const mid = Math.floor(H / 2)
  centred(ctx, 'FreeSansBold9pt7b', 'VOLUME', mid - 50, ACCENT, W)
  centred(ctx, 'FreeSansBold24pt7b', String(m.volume), mid + 4, INK, W)
  const seg = 12
  const gap = 6
  const total = 10 * seg + 9 * gap
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = i < m.volume ? ACCENT : TRACK
    ctx.fillRect(Math.floor((W - total) / 2) + i * (seg + gap), mid + 24, seg, 24)
  }
}

const sleeping: Draw = (ctx, W, H, _m, tick) => {
  face(ctx, 'Sleepy', tick, faceX(W), H > W ? 50 : 4)
  centred(ctx, 'FreeSansBold12pt7b', 'Sleeping', H > W ? 248 : 196, INK, W)
  centred(ctx, 'FreeSans9pt7b', 'Press KEY1 to wake', H > W ? 274 : 222, DIM, W)
}

const missing: Draw = (ctx, W, H, m, tick) => {
  statusDot(ctx, W, m)
  face(ctx, 'Sad', tick, faceX(W), H > W ? 36 : 4)
  const y = H > W ? 236 : 190
  centred(ctx, 'FreeSansBold12pt7b', m.place, y, INK, W)
  wrapped(ctx, 'FreeSans9pt7b', 'Not on the SD card: the phone plays it', 0, y + 26, W - 24, 20, 2, DIM, 'centre', W)
}

const startup: Draw = (ctx, W, H, _m, tick) => {
  if (!crane) {
    // The crane sprite isn't in the public repository (see optionalAssets.ts).
    centred(ctx, 'FreeSansBold12pt7b', 'Jam', Math.floor(H / 2), INK, W)
    return
  }
  const rowBytes = Math.ceil(crane.width / 2)
  const f = crane.frames[tick % crane.frames.length]
  const x0 = Math.floor((W - crane.width) / 2)
  const y0 = Math.max(0, Math.floor((H - crane.height - 34) / 2))
  for (let y = 0; y < crane.height; y++)
    for (let x = 0; x < crane.width; x++) {
      const i = y * rowBytes + (x >> 1)
      const v = parseInt(f.slice(i * 2, i * 2 + 2), 16)
      const idx = x & 1 ? v & 15 : v >> 4
      if (!idx) continue
      ctx.fillStyle = crane.palette[idx]
      ctx.fillRect(x0 + x, y0 + y, 1, 1)
    }
  centred(ctx, 'FreeSansBold12pt7b', 'Jam', Math.min(H - 8, y0 + crane.height + 26), INK, W)
}

export const SCREENS: { id: string; name: string; draw: Draw }[] = [
  { id: 'blank', name: 'Blank', draw: () => {} }, // compose your own with layers
  { id: 'startup', name: 'Startup', draw: startup },
  { id: 'waiting', name: 'Waiting', draw: waiting },
  { id: 'idle', name: 'Idle', draw: idle },
  { id: 'arrival', name: 'Arrival', draw: arrival },
  { id: 'playing', name: 'Now playing', draw: storyScreen(false) },
  { id: 'paused', name: 'Paused', draw: storyScreen(true) },
  { id: 'volume', name: 'Volume', draw: volume },
  { id: 'missing', name: 'Not on card', draw: missing },
  { id: 'sleeping', name: 'Sleeping', draw: sleeping },
]
