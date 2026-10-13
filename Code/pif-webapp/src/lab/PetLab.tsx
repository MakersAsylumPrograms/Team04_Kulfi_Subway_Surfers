import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type Frames,
  MOODS,
  craneFrames,
  faceFrames,
  imageFrames,
  nearest,
  palette16,
  removeWhite,
  sheetFrames,
  videoFrames,
} from './media'
import { centred } from './gfxText'
import { Choice, Field, Num } from './ui'
import { DEFAULT_MODEL, SCREENS, type ScreenModel } from './screens'
import { crane as craneData, skyUrl } from './optionalAssets'
import { DEFAULT_BAUD, LiveSender, type PetInfo, hasSerial, toRgb565 } from './petSerial'
import { type ClipFormat, type ClipMode, type ClipStats, buildClip } from './clip'
import { type Sound, audioContext, decodeSound, prepareSound, toBuffer } from './audio'
import { FONT_NAMES, type Layer, bounds, drawLayers, hitTest, newId } from './layers'
import { ACCENT, DIM, INK } from './screens'

// The pet screen lab (/lab): try pictures, frame animations, videos and whole screen designs
// on an exact stand-in for the pet's 2.4" ST7789 (240x320, 16-bit colour), and send them live
// to the real pet over USB. Placement, scale, rotation, colour mode and timing are all live,
// and the panel estimates what a choice would cost on the board (flash space, drawing time).

const SPI_HZ = 20_000_000 // pet_screen.h's display speed
const FLASH_FREE = 2_000_000 // roughly what's left in the Huge APP partition

type Source = 'screens' | 'crane' | 'face' | 'sky' | 'images' | 'sheet' | 'video'
type ColourMode = 'full' | 'palette16' | 'mono'
type Fit = 'original' | 'fit' | 'fill' | 'custom'
type Align = 'start' | 'centre' | 'end'

interface Settings {
  portrait: boolean
  zoom: number
  fit: Fit
  scalePct: number
  alignX: Align
  alignY: Align
  offsetX: number
  offsetY: number
  rotate: 0 | 90 | 180 | 270
  smooth: boolean
  colour: ColourMode
  monoThreshold: number
  monoInvert: boolean
  monoColour: string
  background: string
  fps: number
  showName: boolean
  nameY: number
}

const DEFAULTS: Settings = {
  portrait: true,
  zoom: 2,
  fit: 'original',
  scalePct: 100,
  alignX: 'centre',
  alignY: 'centre',
  offsetX: 0,
  offsetY: -20,
  rotate: 0,
  smooth: true,
  colour: 'full',
  monoThreshold: 128,
  monoInvert: false,
  monoColour: '#e53935', // the pet's red (0xE1C6)
  background: '#ffffff', // the pet's screens are on white
  fps: 14,
  showName: true,
  nameY: 250,
}

function hexRgb(h: string) {
  return [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16))
}

/** Where a frame lands on the screen, after rotation and scaling. */
function placement(frame: HTMLCanvasElement, s: Settings, W: number, H: number) {
  const turned = s.rotate === 90 || s.rotate === 270
  const fw = turned ? frame.height : frame.width
  const fh = turned ? frame.width : frame.height
  const scale =
    s.fit === 'fit' ? Math.min(W / fw, H / fh) : s.fit === 'fill' ? Math.max(W / fw, H / fh) : s.fit === 'custom' ? s.scalePct / 100 : 1
  const w = Math.round(fw * scale)
  const h = Math.round(fh * scale)
  const ax = s.alignX === 'start' ? 0 : s.alignX === 'end' ? W - w : (W - w) / 2
  const ay = s.alignY === 'start' ? 0 : s.alignY === 'end' ? H - h : (H - h) / 2
  return { x: Math.round(ax + s.offsetX), y: Math.round(ay + s.offsetY), w, h, scale }
}

interface Design {
  draw: (typeof SCREENS)[number]['draw']
  model: ScreenModel
  tick: number
}

function drawScreen(
  ctx: CanvasRenderingContext2D,
  frame: HTMLCanvasElement | undefined,
  s: Settings,
  pal: number[][],
  design: Design | undefined,
  layers: Layer[],
  tick: number,
) {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  ctx.fillStyle = s.background
  ctx.fillRect(0, 0, W, H)
  if (design) {
    design.draw(ctx, W, H, design.model, design.tick)
  } else if (frame) {
    const p = placement(frame, s, W, H)
    ctx.save()
    ctx.imageSmoothingEnabled = s.smooth
    ctx.translate(p.x + p.w / 2, p.y + p.h / 2)
    ctx.rotate((s.rotate * Math.PI) / 180)
    const sw = frame.width * p.scale
    const sh = frame.height * p.scale
    ctx.drawImage(frame, -sw / 2, -sh / 2, sw, sh)
    ctx.restore()
  }
  if (s.showName && !design) centred(ctx, 'FreeSansBold12pt7b', 'Jam', s.nameY, '#ffffff', W)
  drawLayers(ctx, layers, tick, s.smooth)
  // What the panel can actually show.
  const img = ctx.getImageData(0, 0, W, H)
  const d = img.data
  const bg = hexRgb(s.background)
  const ink = hexRgb(s.monoColour)
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i]
    let g = d[i + 1]
    let b = d[i + 2]
    if (s.colour === 'palette16') {
      ;[r, g, b] = pal[nearest([r, g, b], pal)]
    } else if (s.colour === 'mono') {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      const lit = s.monoInvert ? lum < s.monoThreshold : lum >= s.monoThreshold
      ;[r, g, b] = lit ? ink : bg
    }
    // 16-bit colour (RGB565): 5 bits red, 6 green, 5 blue.
    d[i] = (r & 0xf8) | (r >> 5)
    d[i + 1] = (g & 0xfc) | (g >> 6)
    d[i + 2] = (b & 0xf8) | (b >> 5)
  }
  ctx.putImageData(img, 0, 0)
}

export function PetLab() {
  const [s, setS] = useState<Settings>(DEFAULTS)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((o) => ({ ...o, [k]: v }))
  const [source, setSource] = useState<Source>('screens')
  const [mood, setMood] = useState<(typeof MOODS)[number]>('Normal')
  const [pictures, setPictures] = useState<{ name: string; frames: Frames }>({ name: '', frames: [] })
  const [sheet, setSheet] = useState<{ name: string; canvas: HTMLCanvasElement } | null>(null)
  const [grid, setGrid] = useState({ cols: 3, rows: 3, count: 9 })
  const [video, setVideo] = useState<{ name: string; url: string } | null>(null)
  const [videoFps, setVideoFps] = useState(12)
  // Sampled video frames, tagged with what they were sampled from, so stale ones are ignored.
  const [sampled, setSampled] = useState<{ key: string; frames: Frames; error?: string }>({ key: '', frames: [] })
  const [noWhite, setNoWhite] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [frameIdx, setFrameIdx] = useState(0)
  const [copied, setCopied] = useState(false)
  const screenRef = useRef<HTMLCanvasElement>(null)
  // Screen designs
  const [screenId, setScreenId] = useState(SCREENS[0].id)
  const [model, setModel] = useState<ScreenModel>(DEFAULT_MODEL)
  const setM = <K extends keyof ScreenModel>(k: K, v: ScreenModel[K]) => setModel((o) => ({ ...o, [k]: v }))
  // Live on the pet (USB)
  const [sender] = useState(() => new LiveSender())
  const [live, setLive] = useState<'off' | 'connecting' | 'on'>('off')
  const [liveInfo, setLiveInfo] = useState('')
  const [petLog, setPetLog] = useState<string[]>([])
  const [flip, setFlip] = useState(false)
  // Layers: your own pictures and text on top of whatever is showing
  const [layers, setLayers] = useState<Layer[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [layerNoWhite, setLayerNoWhite] = useState(true)
  const selected = layers.find((l) => l.id === selectedId) ?? null
  const updateLayer = (id: number, patch: Partial<Layer>) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)))
  const drag = useRef<{ id: number; px: number; py: number; x: number; y: number; centre: boolean } | null>(null)
  // Clip: a stretch of the timeline (and sound) sent once and played by the pet itself
  const [clipIn, setClipIn] = useState(0)
  const [clipOut, setClipOut] = useState<number | null>(null) // null: to the end
  const [clipMode, setClipMode] = useState<ClipMode>('loop')
  const [clipFormat, setClipFormat] = useState<ClipFormat>('pal256')
  const [sound, setSound] = useState<Sound | null>(null)
  const [soundIn, setSoundIn] = useState(0)
  const [soundOut, setSoundOut] = useState(0)
  const [offsetMs, setOffsetMs] = useState(0)
  const [rate, setRate] = useState(16000)
  const [petVolume, setPetVolume] = useState(90)
  const [clipStatus, setClipStatus] = useState('')
  const [clipProgress, setClipProgress] = useState<number | null>(null)
  const [clipStats, setClipStats] = useState<ClipStats | null>(null)
  const [onPet, setOnPet] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const previewStop = useRef<(() => void) | null>(null)
  const [petInfo, setPetInfo] = useState<PetInfo | null>(null)
  const [petStat, setPetStat] = useState<{ drawMs: number; skipped: number; shown: number } | null>(null)
  const [linkBaud, setLinkBaud] = useState(DEFAULT_BAUD)
  const [spiHz, setSpiHz] = useState(20_000_000)

  const W = s.portrait ? 240 : 320
  const H = s.portrait ? 320 : 240
  // The pet's setRotation(): 2 is portrait the way we plan to hold it, 3 is today's landscape.
  const rotation = s.portrait ? (flip ? 0 : 2) : flip ? 1 : 3

  const videoUrl = source === 'sky' ? (skyUrl ?? undefined) : source === 'video' ? video?.url : undefined
  const videoKey = videoUrl ? `${videoUrl}@${videoFps}` : ''

  // Videos are sampled at the chosen rate; re-sampled when it changes.
  useEffect(() => {
    if (!videoUrl) return
    let stale = false
    videoFrames(videoUrl, videoFps)
      .then((frames) => !stale && setSampled({ key: `${videoUrl}@${videoFps}`, frames }))
      .catch((e: Error) => !stale && setSampled({ key: `${videoUrl}@${videoFps}`, frames: [], error: e.message }))
    return () => {
      stale = true
    }
  }, [videoUrl, videoFps])

  const crane = useMemo(() => craneFrames(), [])
  const face = useMemo(() => faceFrames(mood), [mood])
  const cut = useMemo(() => (sheet ? sheetFrames(sheet.canvas, grid.cols, grid.rows, grid.count) : []), [sheet, grid])

  const raw = useMemo<Frames>(
    () =>
      source === 'crane' ? crane
      : source === 'face' ? face
      : source === 'sheet' ? cut
      : source === 'images' ? pictures.frames
      : sampled.key === videoKey ? sampled.frames
      : [],
    [source, crane, face, cut, pictures, sampled, videoKey],
  )
  const sourceName =
    source === 'crane' ? 'Crane (startup)'
    : source === 'face' ? `Face: ${mood}`
    : source === 'sheet' ? `Sheet: ${sheet?.name}`
    : source === 'images' ? pictures.name
    : source === 'sky' ? 'Video: up in the sky'
    : `Video: ${video?.name}`
  const busy = videoUrl && sampled.key !== videoKey ? 'Reading the video…' : sampled.key === videoKey ? (sampled.error ?? '') : ''

  const frames = useMemo(() => (noWhite ? removeWhite(raw) : raw), [raw, noWhite])
  const pal = useMemo(() => palette16(frames), [frames])
  const designing = source === 'screens'
  const current = !designing && frames.length ? frames[frameIdx % frames.length] : undefined
  const animatedLayer = layers.some((l) => l.kind === 'image' && l.frames.length > 1)
  const loopLength = designing || animatedLayer ? 720 * Math.max(1, frames.length) : frames.length
  const design = useMemo<Design | undefined>(
    () => (designing ? { draw: SCREENS.find((d) => d.id === screenId)!.draw, model, tick: frameIdx } : undefined),
    [designing, screenId, model, frameIdx],
  )

  // Playback clock
  useEffect(() => {
    if (!playing || loopLength < 2) return
    const t = setInterval(() => setFrameIdx((i) => (i + 1) % loopLength), 1000 / s.fps)
    return () => clearInterval(t)
  }, [playing, loopLength, s.fps])

  // Draw, and mirror to the pet when it's connected.
  useEffect(() => {
    const ctx = screenRef.current?.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    drawScreen(ctx, current, s, pal, design, layers, frameIdx)
    sender.push(ctx, rotation)
  }, [current, s, pal, design, layers, frameIdx, W, H, sender, rotation])

  // The pet leaves lab mode 15 s after the last frame; a still screen sends nothing, so nudge it.
  useEffect(() => {
    if (live !== 'on') return
    const t = setInterval(() => sender.keepAlive(), 5000)
    return () => clearInterval(t)
  }, [live, sender])

  useEffect(() => () => void sender.pet.disconnect(), [sender])

  async function connectPet() {
    setLive('connecting')
    setLiveInfo('Pick the pet’s port (the board’s USB) in the box Chrome opens…')
    sender.listen((line) => {
      const stat = line.match(/^LABSTAT draw=(\d+) skipped=(\d+) shown=(\d+)/)
      if (stat) {
        setPetStat({ drawMs: Number(stat[1]), skipped: Number(stat[2]), shown: Number(stat[3]) })
        return
      }
      setPetLog((log) => [...log.slice(-7), line])
    }, setLiveInfo)
    try {
      await sender.pet.connect(setLiveInfo)
      setPetInfo(sender.pet.info)
      setLinkBaud(sender.pet.baud)
      setLive('on')
      setLiveInfo('Connected')
      const ctx = screenRef.current?.getContext('2d', { willReadFrequently: true })
      if (ctx) sender.push(ctx, rotation)
    } catch (e) {
      await sender.pet.disconnect()
      setLive('off')
      setLiveInfo((e as Error).message)
    }
  }

  // ---- Clip
  const lastTick = Math.max(0, (designing || animatedLayer ? 720 : frames.length) - 1)
  const cIn = Math.min(clipIn, lastTick)
  const cOut = Math.max(cIn, Math.min(clipOut ?? lastTick, lastTick))
  const clipFrames = cOut - cIn + 1
  const soundEnd = soundOut || sound?.buffer.duration || 0
  const isVideo = source === 'sky' || source === 'video'

  /** Every frame of the clip, drawn exactly as the preview draws it, as RGB565 screens. */
  function renderClip() {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const octx = c.getContext('2d', { willReadFrequently: true })!
    const draw = SCREENS.find((d) => d.id === screenId)!.draw
    const out: Uint16Array[] = []
    for (let k = cIn; k <= cOut; k++) {
      const fr = !designing && frames.length ? frames[k % frames.length] : undefined
      drawScreen(octx, fr, s, pal, designing ? { draw, model, tick: k } : undefined, layers, k)
      out.push(toRgb565(octx))
    }
    return out
  }

  async function makeClip() {
    const pcm = sound ? await prepareSound(sound, soundIn, soundEnd, rate) : null
    return buildClip(renderClip(), W, H, rotation, {
      format: clipFormat,
      fps: s.fps,
      mode: clipMode,
      volume: petVolume,
      audio: pcm ? { pcm, rate, offsetMs } : null,
    })
  }

  async function checkClip() {
    setClipStatus('Working it out…')
    const { stats } = await makeClip()
    setClipStats(stats)
    setClipStatus('')
  }

  async function sendClip() {
    if (clipFrames > 600) {
      setClipStatus('That’s more than 600 frames: shorten the clip.')
      return
    }
    stopPreview()
    setClipStatus('Preparing…')
    const { bytes, stats } = await makeClip()
    setClipStats(stats)
    const free = sender.pet.info?.psramFree ?? 0
    if (free && bytes.length > free - 32768) {
      setClipStatus(`Too big for the pet’s memory: ${(bytes.length / 1e6).toFixed(2)} MB, ${(free / 1e6).toFixed(2)} MB free.`)
      return
    }
    sender.hold(true)
    setClipProgress(0)
    setClipStatus(`Sending ${(bytes.length / 1000).toFixed(0)} KB…`)
    const t0 = performance.now()
    try {
      await sender.pet.sendClip(bytes, (n) => setClipProgress(n / bytes.length))
      setOnPet(true)
      setClipStatus(`Playing on the pet (sent in ${((performance.now() - t0) / 1000).toFixed(1)} s)`)
    } catch (e) {
      sender.hold(false)
      setClipStatus((e as Error).message)
    } finally {
      setClipProgress(null)
    }
  }

  async function stopOnPet() {
    await sender.pet.text('lab stop').catch(() => {})
    setOnPet(false)
    sender.hold(false)
    setClipStatus('Stopped: the pet mirrors the lab again')
    const ctx = screenRef.current?.getContext('2d', { willReadFrequently: true })
    if (ctx) sender.push(ctx, rotation)
  }

  /** Changes that the pet can take while it plays, without sending the clip again. */
  function tellPet(line: string) {
    if (onPet) void sender.pet.text(line).catch(() => {})
  }

  function stopPreview() {
    previewStop.current?.()
    previewStop.current = null
    setPreviewing(false)
  }

  /** Plays the clip here with its sound, timed the way the pet times it. */
  async function preview() {
    stopPreview()
    setPlaying(false)
    const ac = audioContext()
    void ac.resume() // starts on a real click; without one the frames still run (below)
    const pcm = sound ? await prepareSound(sound, soundIn, soundEnd, rate) : null
    const buf = pcm ? toBuffer(pcm, rate) : null
    const n = clipFrames
    const fps = s.fps
    const periodFrames = clipMode === 'pingpong' && n > 1 ? 2 * (n - 1) : n
    const t0 = ac.currentTime + 0.15
    // The sound's clock keeps frames and sound together; if the browser won't start audio,
    // the frames still run on the page's own clock.
    const wall0 = performance.now() / 1000 + 0.15
    const now = () => (ac.state === 'running' ? ac.currentTime - t0 : performance.now() / 1000 - wall0)
    let node: AudioBufferSourceNode | null = null
    let cycle = -1
    let raf = 0
    const cue = (at: number) => {
      node?.stop()
      node = null
      if (!buf) return
      node = ac.createBufferSource()
      node.buffer = buf
      node.connect(ac.destination)
      const off = offsetMs / 1000
      if (off >= 0) node.start(at + off)
      else node.start(at, Math.min(buf.duration, -off))
    }
    const tick = () => {
      const el = now()
      if (el >= 0) {
        const k = Math.floor(el * fps)
        let idx: number
        let cyc: number
        if (clipMode === 'once') {
          idx = Math.min(k, n - 1)
          cyc = 0
        } else if (clipMode === 'pingpong' && n > 1) {
          const m = k % periodFrames
          idx = m < n ? m : periodFrames - m
          cyc = Math.floor(k / periodFrames)
        } else {
          idx = k % n
          cyc = Math.floor(k / n)
        }
        if (cyc !== cycle) {
          cycle = cyc
          cue(t0 + (cyc * periodFrames) / fps)
        }
        setFrameIdx(cIn + idx)
      }
      raf = window.setTimeout(tick, 8)
    }
    raf = window.setTimeout(tick, 8)
    previewStop.current = () => {
      clearTimeout(raf)
      node?.stop()
    }
    setPreviewing(true)
  }

  async function loadSound(name: string, data: ArrayBuffer) {
    setClipStatus(`Reading the sound in ${name}…`)
    try {
      const snd = await decodeSound(name, data)
      setSound(snd)
      setSoundIn(0)
      setSoundOut(snd.buffer.duration)
      setClipStatus('')
    } catch (e) {
      setClipStatus((e as Error).message)
    }
  }

  /** For a video: frames and sound from the same stretch of it, in step. */
  function matchVideo() {
    set('fps', videoFps)
    setSoundIn(cIn / videoFps)
    setSoundOut((cOut + 1) / videoFps)
    setOffsetMs(0)
  }

  async function changeBaud(b: number) {
    setLiveInfo(`Moving the link to ${b.toLocaleString()} baud…`)
    try {
      await sender.pet.setBaud(b)
      setLiveInfo(`Link at ${b.toLocaleString()} baud`)
    } catch (e) {
      setLiveInfo((e as Error).message)
    }
    setLinkBaud(sender.pet.baud)
  }

  // ---- Layers
  async function addImageLayer(list: FileList | null) {
    if (!list?.length) return
    const files = [...list]
    const raw = await imageFrames(files)
    const frames = layerNoWhite ? removeWhite(raw) : raw
    const f = frames[0]
    const scalePct = Math.min(100, Math.floor(Math.min(W / f.width, H / f.height) * 100))
    const l: Layer = {
      id: newId(),
      kind: 'image',
      name: files.length > 1 ? `${files.length} pictures` : files[0].name,
      frames,
      scalePct,
      x: Math.round((W - (f.width * scalePct) / 100) / 2),
      y: Math.round((H - (f.height * scalePct) / 100) / 2),
      visible: true,
    }
    setLayers((ls) => [...ls, l])
    setSelectedId(l.id)
  }

  function addTextLayer() {
    const l: Layer = {
      id: newId(),
      kind: 'text',
      name: 'Text',
      text: 'Your text',
      font: 'FreeSansBold12pt7b',
      colour: INK,
      centre: true,
      x: 16,
      y: Math.round(H / 2),
      visible: true,
    }
    setLayers((ls) => [...ls, l])
    setSelectedId(l.id)
  }

  function moveLayer(id: number, dir: -1 | 1) {
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= ls.length) return ls
      const out = [...ls]
      ;[out[i], out[j]] = [out[j], out[i]]
      return out
    })
  }

  function screenPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = screenPoint(e)
    const hit = hitTest(layers, p.x, p.y, W)
    setSelectedId(hit?.id ?? null)
    if (!hit) return
    const b = bounds(hit, W)
    const centre = hit.kind === 'text' && hit.centre
    drag.current = { id: hit.id, px: p.x, py: p.y, x: centre ? b.x : hit.x, y: hit.y, centre }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = drag.current
    if (!d) return
    const p = screenPoint(e)
    const dx = p.x - d.px
    const dy = p.y - d.py
    // Centred text only moves up and down, until it's pulled sideways on purpose.
    const keepCentre = d.centre && Math.abs(dx) < 6
    updateLayer(d.id, { x: Math.round(d.x + (keepCentre ? 0 : dx)), y: Math.round(d.y + dy), ...(d.centre ? { centre: keepCentre } : {}) })
  }

  // Arrow keys nudge the selected layer (Shift: 10 px); Delete removes it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (selectedId == null) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const step = e.shiftKey ? 10 : 1
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (moves[e.key]) {
        e.preventDefault()
        setLayers((ls) =>
          ls.map((l) =>
            l.id === selectedId
              ? ({ ...l, x: l.x + moves[e.key][0], y: l.y + moves[e.key][1], ...(l.kind === 'text' && moves[e.key][0] ? { centre: false } : {}) } as Layer)
              : l,
          ),
        )
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        setLayers((ls) => ls.filter((l) => l.id !== selectedId))
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId])

  async function disconnectPet() {
    await sender.pet.disconnect()
    setLive('off')
    setLiveInfo('Disconnected: the pet is back to its own screens')
  }

  async function onFiles(kind: 'images' | 'sheet' | 'video', list: FileList | null) {
    if (!list?.length) return
    const files = [...list]
    setFrameIdx(0)
    if (kind === 'video') {
      setVideo({ name: files[0].name, url: URL.createObjectURL(files[0]) })
      setSource('video')
      return
    }
    const f = await imageFrames(files)
    if (kind === 'sheet') {
      setSheet({ name: files[0].name, canvas: f[0] })
      setSource('sheet')
    } else {
      setPictures({ name: files.length > 1 ? `${files.length} pictures` : `Picture: ${files[0].name}`, frames: f })
      setSource('images')
    }
  }

  // What it would cost on the pet
  const box = current ? placement(current, s, W, H) : null
  const visW = box ? Math.max(0, Math.min(W, box.x + box.w) - Math.max(0, box.x)) : 0
  const visH = box ? Math.max(0, Math.min(H, box.y + box.h) - Math.max(0, box.y)) : 0
  const bitsPerPixel = s.colour === 'full' ? 16 : s.colour === 'palette16' ? 4 : 1
  const flashBytes = Math.ceil((visW * visH * bitsPerPixel) / 8) * frames.length
  const drawMs = (visW * visH * 16) / SPI_HZ * 1000 * 1.3 // pixels go out as 16 bits; ~30% overhead
  const maxFps = drawMs ? Math.floor(1000 / drawMs) : 0
  const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(2)} MB` : `${Math.round(n / 1000)} KB`)

  const settingsJson = JSON.stringify(
    {
      source: sourceName,
      screen: designing ? screenId : undefined,
      model: designing ? model : undefined,
      frames: frames.length,
      box: { x: box?.x, y: box?.y, w: box?.w, h: box?.h },
      removeWhite: noWhite,
      videoFps,
      rotation,
      layers: layers.map(({ frames: lf, ...l }: Layer & { frames?: Frames }) => ({ ...l, frameCount: lf?.length, size: lf ? `${lf[0].width}x${lf[0].height}` : undefined })),
      ...s,
    },
    null,
    2,
  )

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:flex-row md:items-start">
        <div className="flex flex-col items-center gap-3 md:sticky md:top-4">
          <div className="rounded-[18px] bg-neutral-800 p-3">
            <div className="relative">
              <canvas
                ref={screenRef}
                width={W}
                height={H}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={() => (drag.current = null)}
                style={{
                  width: W * s.zoom,
                  height: H * s.zoom,
                  imageRendering: 'pixelated',
                  display: 'block',
                  touchAction: 'none',
                  cursor: layers.length ? 'move' : 'default',
                }}
              />
              {selected?.visible &&
                (() => {
                  const b = bounds(selected, W)
                  return (
                    <div
                      className="pointer-events-none absolute border border-dashed border-amber-400"
                      style={{ left: b.x * s.zoom - 2, top: b.y * s.zoom - 2, width: b.w * s.zoom + 4, height: b.h * s.zoom + 4 }}
                    />
                  )
                })()}
            </div>
          </div>
          {layers.length > 0 && <p className="text-xs text-neutral-500">Drag a layer to move it. Arrow keys nudge (Shift: 10 px).</p>}
          <div className="flex items-center gap-2 text-sm">
            <button type="button" className="rounded-md border border-neutral-300 bg-white px-3 py-1" onClick={() => setPlaying((p) => !p)}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" className="rounded-md border border-neutral-300 bg-white px-3 py-1" onClick={() => setFrameIdx((i) => (i + loopLength - 1) % Math.max(1, loopLength))}>
              ◀
            </button>
            <span className="w-20 text-center tabular-nums text-neutral-600">
              {designing ? `tick ${frameIdx}` : `${frames.length ? (frameIdx % frames.length) + 1 : 0} / ${frames.length}`}
            </span>
            <button type="button" className="rounded-md border border-neutral-300 bg-white px-3 py-1" onClick={() => setFrameIdx((i) => (i + 1) % Math.max(1, loopLength))}>
              ▶
            </button>
          </div>
          {busy && <p className="text-sm text-neutral-500">{busy}</p>}
        </div>

        <div className="flex flex-1 flex-col gap-4">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <h1 className="text-xl font-semibold">Pet screen lab</h1>
              <a className="text-sm underline" href="./media">
                Videos on the SD card →
              </a>
            </div>
            <p className="text-sm text-neutral-500">
              The pet's 2.4" screen, pixel for pixel, in its 16-bit colour and its own fonts. Connect the pet by USB to
              see it live on the real screen.
            </p>
          </div>

          <section className="rounded-xl bg-white p-4">
            <h2 className="mb-2 font-medium">Live on the pet</h2>
            {!hasSerial() ? (
              <p className="text-sm text-neutral-500">This needs Chrome or Edge on a computer (Web Serial).</p>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  {live === 'on' ? (
                    <button type="button" className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm" onClick={() => void disconnectPet()}>
                      Disconnect
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={live === 'connecting'}
                      className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                      onClick={() => void connectPet()}
                    >
                      {live === 'connecting' ? 'Connecting…' : 'Connect the pet (USB)'}
                    </button>
                  )}
                  <span className={`h-2.5 w-2.5 rounded-full ${live === 'on' ? 'bg-emerald-500' : 'bg-neutral-300'}`} />
                  <span className="text-sm text-neutral-600">{liveInfo}</span>
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  Close the Arduino Serial Monitor first (only one program can use the port). Connecting may restart the
                  pet; the lab waits for it. Everything you change here shows on the pet within a second.
                </p>
                {petLog.length > 0 && (
                  <pre className="mt-2 max-h-32 overflow-auto rounded bg-neutral-100 p-2 text-xs text-neutral-600">{petLog.join('\n')}</pre>
                )}
              </>
            )}
          </section>

          <section className="rounded-xl bg-white p-4">
            <h2 className="mb-1 font-medium">Clip: play it on the pet</h2>
            <p className="mb-2 text-xs text-neutral-500">
              For anything that moves. The frames (whatever the preview shows, layers included) and the sound go to the
              pet once; then it plays them itself at full speed. Grey settings change while it plays.
            </p>

            <h3 className="mt-2 text-sm font-medium text-neutral-700">Timeline</h3>
            <Field label={`From frame (of ${lastTick + 1})`}>
              <Num value={cIn} onChange={(v) => setClipIn(Math.max(0, Math.min(v, lastTick)))} min={0} max={lastTick} />
            </Field>
            <Field label="To frame">
              <Num value={cOut} onChange={(v) => setClipOut(Math.max(0, Math.min(v, lastTick)))} min={0} max={lastTick} />
            </Field>
            <Field label={`Scrub (${clipFrames} frames, ${(clipFrames / s.fps).toFixed(1)} s)`}>
              <input
                type="range"
                min={cIn}
                max={cOut}
                value={Math.min(Math.max(frameIdx, cIn), cOut)}
                onChange={(e) => {
                  stopPreview()
                  setPlaying(false)
                  setFrameIdx(Number(e.target.value))
                }}
                className="w-44"
              />
              <span className="w-12 text-right text-xs tabular-nums text-neutral-500">{((frameIdx - cIn) / s.fps).toFixed(2)} s</span>
            </Field>
            <Field label="Frames per second">
              <Num
                value={s.fps}
                onChange={(v) => {
                  set('fps', v)
                  tellPet(`lab fps ${v}`)
                }}
                min={1}
                max={30}
              />
            </Field>
            {isVideo && s.fps !== videoFps && (
              <p className="flex items-center gap-2 py-1 text-xs text-amber-700">
                The video’s frames were taken at {videoFps} fps; playing at {s.fps} fps runs it at {(s.fps / videoFps).toFixed(2)}× speed.
                <button
                  type="button"
                  className="rounded border border-amber-300 px-2 py-0.5"
                  onClick={() => {
                    set('fps', videoFps)
                    tellPet(`lab fps ${videoFps}`)
                  }}
                >
                  Real speed
                </button>
              </p>
            )}
            <Field label="Play">
              <Choice
                value={clipMode}
                options={[
                  ['loop', 'Loop'],
                  ['once', 'Once'],
                  ['pingpong', 'Back and forth'],
                ]}
                onChange={(v) => {
                  setClipMode(v)
                  tellPet(`lab mode ${v}`)
                }}
              />
            </Field>

            <h3 className="mt-3 text-sm font-medium text-neutral-700">Sound</h3>
            <div className="flex flex-wrap items-center gap-2 py-1">
              <label className="cursor-pointer rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm">
                Choose a sound (or a video with sound)
                <input
                  type="file"
                  accept="audio/*,video/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void file.arrayBuffer().then((d) => loadSound(file.name, d))
                    e.target.value = ''
                  }}
                />
              </label>
              {isVideo && videoUrl && (
                <button
                  type="button"
                  className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm"
                  onClick={() => void fetch(videoUrl).then((r) => r.arrayBuffer()).then((d) => loadSound(sourceName, d))}
                >
                  Use this video’s sound
                </button>
              )}
              {sound && (
                <button type="button" className="px-2 text-sm text-neutral-500" onClick={() => setSound(null)}>
                  Remove sound
                </button>
              )}
            </div>
            {sound && (
              <>
                <p className="text-xs text-neutral-500">
                  {sound.name}: {sound.buffer.duration.toFixed(2)} s
                </p>
                <Field label="Sound from (s)">
                  <Num value={Number(soundIn.toFixed(2))} onChange={(v) => setSoundIn(Math.max(0, v))} min={0} max={sound.buffer.duration} step={0.05} />
                </Field>
                <Field label="Sound to (s)">
                  <Num value={Number(soundEnd.toFixed(2))} onChange={(v) => setSoundOut(v)} min={0} max={sound.buffer.duration} step={0.05} />
                </Field>
                <Field label="Sound offset (ms, + starts later)">
                  <Num
                    value={offsetMs}
                    onChange={(v) => {
                      setOffsetMs(v)
                      tellPet(`lab offset ${v}`)
                    }}
                    min={-3000}
                    max={3000}
                    step={10}
                  />
                </Field>
                <Field label="Sample rate (sent with the clip)">
                  <Choice
                    value={rate}
                    options={[
                      [8000, '8k'],
                      [11025, '11k'],
                      [16000, '16k'],
                      [22050, '22k'],
                    ]}
                    onChange={setRate}
                  />
                </Field>
                {isVideo && (
                  <button type="button" className="mb-1 rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs" onClick={matchVideo}>
                    Line the sound up with these video frames
                  </button>
                )}
              </>
            )}
            <Field label="Volume on the pet">
              <Num
                value={petVolume}
                onChange={(v) => {
                  setPetVolume(v)
                  tellPet(`lab vol ${v}`)
                }}
                min={0}
                max={100}
              />
            </Field>

            <h3 className="mt-3 text-sm font-medium text-neutral-700">How it’s stored</h3>
            <Field label="Colours">
              <Choice
                value={clipFormat}
                options={[
                  ['rgb565', 'All (16-bit)'],
                  ['pal256', '256'],
                  ['pal64', '64'],
                  ['pal16', '16'],
                ]}
                onChange={setClipFormat}
              />
            </Field>

            <div className="mt-3 flex flex-wrap gap-2">
              {previewing ? (
                <button type="button" className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm" onClick={stopPreview}>
                  Stop preview
                </button>
              ) : (
                <button type="button" className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm" onClick={() => void preview()}>
                  Preview here{sound ? ' with sound' : ''}
                </button>
              )}
              <button type="button" className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm" onClick={() => void checkClip()}>
                Check size
              </button>
              <button
                type="button"
                disabled={live !== 'on' || clipProgress !== null}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                onClick={() => void sendClip()}
              >
                Send &amp; play on the pet
              </button>
              {onPet && (
                <>
                  <button type="button" className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm" onClick={() => void sender.pet.text('lab play')}>
                    Play again
                  </button>
                  <button type="button" className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm" onClick={() => void stopOnPet()}>
                    Stop, back to live
                  </button>
                </>
              )}
            </div>
            {live !== 'on' && <p className="mt-1 text-xs text-neutral-500">Connect the pet (above) to send.</p>}
            {clipProgress !== null && (
              <div className="mt-2 h-2 overflow-hidden rounded bg-neutral-200">
                <div className="h-full bg-neutral-900" style={{ width: `${Math.round(clipProgress * 100)}%` }} />
              </div>
            )}
            {clipStatus && <p className="mt-2 text-sm text-neutral-600">{clipStatus}</p>}
            {onPet && petStat && (
              <p className={`mt-1 text-sm ${petStat.skipped ? 'text-red-600' : 'text-emerald-700'}`}>
                On the pet: each frame takes {petStat.drawMs} ms to draw, so it can show up to ~
                {Math.floor(1000 / Math.max(1, petStat.drawMs))} fps.{' '}
                {petStat.skipped
                  ? `It skipped ${petStat.skipped} of the last ${petStat.shown + petStat.skipped} frames: lower the fps, make the moving part smaller, or raise the display SPI speed.`
                  : `Keeping up at ${s.fps} fps.`}
              </p>
            )}
            {clipStats && (
              <p className="mt-1 text-xs text-neutral-500">
                {clipStats.frames} frames of {clipStats.region.w}×{clipStats.region.h} at ({clipStats.region.x}, {clipStats.region.y})
                {clipStats.paletteSize ? `, ${clipStats.paletteSize} colours` : ''}: {(clipStats.totalBytes / 1000).toFixed(0)} KB (frames{' '}
                {(clipStats.frameBytes / 1000).toFixed(0)}, background {(clipStats.baseBytes / 1000).toFixed(0)}, sound{' '}
                {(clipStats.audioBytes / 1000).toFixed(0)}). Sending takes about {((clipStats.totalBytes * 10) / linkBaud).toFixed(1)} s at{' '}
                {linkBaud.toLocaleString()} baud
                {petInfo?.psramFree ? `; the pet has ${(petInfo.psramFree / 1e6).toFixed(1)} MB free` : ''}.
              </p>
            )}

            <h3 className="mt-3 text-sm font-medium text-neutral-700">Link and display</h3>
            <Field label="USB speed (baud)">
              <select
                value={linkBaud}
                disabled={live !== 'on'}
                onChange={(e) => void changeBaud(Number(e.target.value))}
                className="rounded border border-neutral-300 px-1 text-sm"
              >
                {[921600, 1500000, 2000000, 3000000].map((b) => (
                  <option key={b} value={b}>
                    {b.toLocaleString()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Display SPI speed">
              <select
                value={spiHz}
                disabled={live !== 'on'}
                onChange={(e) => {
                  const hz = Number(e.target.value)
                  setSpiHz(hz)
                  void sender.pet.text(`lab spi ${hz}`)
                }}
                className="rounded border border-neutral-300 px-1 text-sm"
              >
                {[10, 20, 27, 40, 80].map((m) => (
                  <option key={m} value={m * 1_000_000}>
                    {m} MHz
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-xs text-neutral-500">
              Faster USB sends clips sooner (if the board’s USB chip keeps up; it falls back by itself if not). Faster SPI
              draws frames sooner; if the screen glitches or goes white, step it back. Both reset when the pet restarts.
            </p>
          </section>

          <section className="rounded-xl bg-white p-4">
            <h2 className="mb-1 font-medium">Layers: your pictures and text</h2>
            <p className="mb-2 text-xs text-neutral-500">
              On top of whatever is showing (a screen design, the crane, a video). Pick several pictures at once to make
              an animated layer. Use the Blank screen to start from nothing.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="cursor-pointer rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white">
                + Picture
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void addImageLayer(e.target.files)
                    e.target.value = ''
                  }}
                />
              </label>
              <button type="button" className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm" onClick={addTextLayer}>
                + Text
              </button>
              <label className="flex items-center gap-1.5 text-xs text-neutral-600">
                <input type="checkbox" checked={layerNoWhite} onChange={(e) => setLayerNoWhite(e.target.checked)} />
                Remove white background from new pictures
              </label>
            </div>
            {layers.length > 0 && (
              <ul className="mt-3 divide-y divide-neutral-100 rounded-md border border-neutral-200">
                {[...layers].reverse().map((l) => (
                  <li
                    key={l.id}
                    className={`flex items-center gap-2 px-2 py-1.5 text-sm ${l.id === selectedId ? 'bg-amber-50' : ''}`}
                    onClick={() => setSelectedId(l.id)}
                  >
                    <input
                      type="checkbox"
                      title="Show"
                      checked={l.visible}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updateLayer(l.id, { visible: e.target.checked })}
                    />
                    <span className="flex-1 truncate">
                      {l.kind === 'image' ? '🖼 ' : 'T '}
                      {l.kind === 'text' ? l.text : l.name}
                    </span>
                    <button type="button" title="Bring forward" className="px-1 text-neutral-500" onClick={() => moveLayer(l.id, 1)}>
                      ↑
                    </button>
                    <button type="button" title="Send back" className="px-1 text-neutral-500" onClick={() => moveLayer(l.id, -1)}>
                      ↓
                    </button>
                    <button
                      type="button"
                      title="Remove"
                      className="px-1 text-neutral-500"
                      onClick={(e) => {
                        e.stopPropagation()
                        setLayers((ls) => ls.filter((x) => x.id !== l.id))
                        if (selectedId === l.id) setSelectedId(null)
                      }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selected && (
              <div className="mt-3 border-t border-neutral-100 pt-2">
                <Field label="x">
                  <Num value={selected.x} onChange={(v) => updateLayer(selected.id, { x: v, ...(selected.kind === 'text' ? { centre: false } : {}) })} min={-W} max={W} />
                </Field>
                <Field label={selected.kind === 'text' ? 'y (baseline)' : 'y'}>
                  <Num value={selected.y} onChange={(v) => updateLayer(selected.id, { y: v })} min={-H} max={H * 2} />
                </Field>
                {selected.kind === 'image' ? (
                  <Field label={`Size % (picture is ${selected.frames[0].width}×${selected.frames[0].height})`}>
                    <Num value={selected.scalePct} onChange={(v) => updateLayer(selected.id, { scalePct: Math.max(1, v) })} min={5} max={400} />
                  </Field>
                ) : (
                  <>
                    <Field label="Text">
                      <input
                        value={selected.text}
                        onChange={(e) => updateLayer(selected.id, { text: e.target.value })}
                        className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-sm"
                      />
                    </Field>
                    <Field label="Font (the pet's own)">
                      <select
                        value={selected.font}
                        onChange={(e) => updateLayer(selected.id, { font: e.target.value as typeof selected.font })}
                        className="rounded border border-neutral-300 px-1 text-sm"
                      >
                        {FONT_NAMES.map((f) => (
                          <option key={f} value={f}>
                            {f.replace('pt7b', ' pt').replace('FreeSans', 'Sans ').replace('Bold', 'Bold ')}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Colour">
                      <Choice
                        value={[INK, DIM, ACCENT].includes(selected.colour) ? selected.colour : 'custom'}
                        options={[
                          [INK, 'White'],
                          [DIM, 'Grey'],
                          [ACCENT, 'Cyan'],
                          ['custom', 'Other'],
                        ]}
                        onChange={(v) => v !== 'custom' && updateLayer(selected.id, { colour: v })}
                      />
                      <input type="color" value={selected.colour} onChange={(e) => updateLayer(selected.id, { colour: e.target.value })} />
                    </Field>
                    <Field label="Centred across the screen">
                      <input type="checkbox" checked={selected.centre} onChange={(e) => updateLayer(selected.id, { centre: e.target.checked })} />
                    </Field>
                  </>
                )}
              </div>
            )}
          </section>

          {designing && (
            <section className="rounded-xl bg-white p-4">
              <h2 className="mb-2 font-medium">Screen design</h2>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {SCREENS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setScreenId(d.id)}
                    className={`rounded-md border px-2.5 py-1 text-xs ${d.id === screenId ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 bg-white'}`}
                  >
                    {d.name}
                  </button>
                ))}
              </div>
              <Field label="Place">
                <input value={model.place} onChange={(e) => setM('place', e.target.value)} className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-sm" />
              </Field>
              <Field label="Title">
                <input value={model.title} onChange={(e) => setM('title', e.target.value)} className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-sm" />
              </Field>
              <Field label="Status line (idle)">
                <input value={model.status} onChange={(e) => setM('status', e.target.value)} className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-sm" />
              </Field>
              <Field label="Face (idle)">
                <select value={model.mood} onChange={(e) => setM('mood', e.target.value as ScreenModel['mood'])} className="rounded border border-neutral-300 px-1 text-sm">
                  {MOODS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
              <Field label="Progress %">
                <Num value={Math.round(model.progress * 100)} onChange={(v) => setM('progress', v / 100)} min={0} max={100} />
              </Field>
              <Field label="Story length (s)">
                <Num value={model.durationS} onChange={(v) => setM('durationS', v)} min={10} max={600} />
              </Field>
              <Field label="Volume">
                <Num value={model.volume} onChange={(v) => setM('volume', v)} min={0} max={10} />
              </Field>
              <Field label="Phone connected">
                <input type="checkbox" checked={model.connected} onChange={(e) => setM('connected', e.target.checked)} />
              </Field>
              <p className="mt-1 text-xs text-neutral-500">
                These are drafts: once you pick the ones you like, they get ported to the pet's firmware.
              </p>
            </section>
          )}

          <section className="rounded-xl bg-white p-4">
            <h2 className="mb-2 font-medium">What to show</h2>
            <Field label="Source">
              <Choice
                value={source}
                options={[
                  ['screens', 'Screens'],
                  ...(craneData ? ([['crane', 'Crane']] as [Source, string][]) : []),
                  ...(skyUrl ? ([['sky', 'Sky video']] as [Source, string][]) : []),
                  ['face', 'Face'],
                ]}
                onChange={(v) => {
                  setFrameIdx(0)
                  setSource(v)
                }}
              />
            </Field>
            {source === 'face' && (
              <Field label="Mood">
                <select value={mood} onChange={(e) => setMood(e.target.value as typeof mood)} className="rounded border border-neutral-300 px-1 text-sm">
                  {MOODS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Your pictures (one, or several as frames)">
              <input type="file" accept="image/*" multiple onChange={(e) => onFiles('images', e.target.files)} className="w-56 text-xs" />
            </Field>
            <Field label="Sprite sheet">
              <input type="file" accept="image/*" onChange={(e) => onFiles('sheet', e.target.files)} className="w-56 text-xs" />
            </Field>
            {source === 'sheet' && (
              <Field label="Grid: columns, rows, frames">
                {(['cols', 'rows', 'count'] as const).map((k) => (
                  <input
                    key={k}
                    type="number"
                    min={1}
                    max={k === 'count' ? 100 : 12}
                    value={grid[k]}
                    onChange={(e) => setGrid((g) => ({ ...g, [k]: Math.max(1, Number(e.target.value)) }))}
                    className="w-14 rounded border border-neutral-300 px-1 text-right text-xs"
                  />
                ))}
              </Field>
            )}
            <Field label="Video">
              <input type="file" accept="video/*" onChange={(e) => onFiles('video', e.target.files)} className="w-56 text-xs" />
            </Field>
            {(source === 'sky' || source === 'video') && (
              <Field label="Video: frames taken per second">
                <Num
                  value={videoFps}
                  onChange={(v) => {
                    setVideoFps(v)
                    set('fps', v) // play at the rate they were taken: real speed
                  }}
                  min={2}
                  max={30}
                />
              </Field>
            )}
            <Field label="Remove white background">
              <input type="checkbox" checked={noWhite} onChange={(e) => setNoWhite(e.target.checked)} />
            </Field>
            <p className="mt-1 text-xs text-neutral-500">Showing: {sourceName}</p>
          </section>

          <section className="rounded-xl bg-white p-4">
            <h2 className="mb-2 font-medium">Screen</h2>
            <Field label="Orientation">
              <Choice
                value={s.portrait ? 'p' : 'l'}
                options={[
                  ['p', 'Portrait 240×320'],
                  ['l', 'Landscape 320×240'],
                ]}
                onChange={(v) => set('portrait', v === 'p')}
              />
            </Field>
            <Field label="Zoom">
              <Choice value={s.zoom} options={[[1, '1×'], [2, '2×'], [3, '3×']]} onChange={(v) => set('zoom', v)} />
            </Field>
            <Field label="Upside down on the pet? Flip it">
              <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} />
            </Field>
            <Field label="Background">
              <input type="color" value={s.background} onChange={(e) => set('background', e.target.value)} />
            </Field>
          </section>

          <section className={`rounded-xl bg-white p-4 ${designing ? 'hidden' : ''}`}>
            <h2 className="mb-2 font-medium">Placement</h2>
            <Field label="Size">
              <Choice
                value={s.fit}
                options={[
                  ['original', 'Original'],
                  ['fit', 'Fit'],
                  ['fill', 'Fill'],
                  ['custom', '%'],
                ]}
                onChange={(v) => set('fit', v)}
              />
            </Field>
            {s.fit === 'custom' && (
              <Field label="Scale %">
                <Num value={s.scalePct} onChange={(v) => set('scalePct', v)} min={10} max={400} />
              </Field>
            )}
            <Field label="Horizontal">
              <Choice
                value={s.alignX}
                options={[
                  ['start', 'Left'],
                  ['centre', 'Centre'],
                  ['end', 'Right'],
                ]}
                onChange={(v) => set('alignX', v)}
              />
            </Field>
            <Field label="Vertical">
              <Choice
                value={s.alignY}
                options={[
                  ['start', 'Top'],
                  ['centre', 'Middle'],
                  ['end', 'Bottom'],
                ]}
                onChange={(v) => set('alignY', v)}
              />
            </Field>
            <Field label="Nudge x">
              <Num value={s.offsetX} onChange={(v) => set('offsetX', v)} min={-160} max={160} />
            </Field>
            <Field label="Nudge y">
              <Num value={s.offsetY} onChange={(v) => set('offsetY', v)} min={-160} max={160} />
            </Field>
            <Field label="Rotate">
              <Choice
                value={s.rotate}
                options={[
                  [0, '0°'],
                  [90, '90°'],
                  [180, '180°'],
                  [270, '270°'],
                ]}
                onChange={(v) => set('rotate', v)}
              />
            </Field>
            <Field label="Smooth when scaling">
              <input type="checkbox" checked={s.smooth} onChange={(e) => set('smooth', e.target.checked)} />
            </Field>
          </section>

          <section className="rounded-xl bg-white p-4">
            <h2 className="mb-2 font-medium">Colour and timing</h2>
            <Field label="Colour">
              <Choice
                value={s.colour}
                options={[
                  ['full', 'Full (16-bit)'],
                  ['palette16', '16 colours'],
                  ['mono', 'One colour'],
                ]}
                onChange={(v) => set('colour', v)}
              />
            </Field>
            {s.colour === 'mono' && (
              <>
                <Field label="Light threshold">
                  <Num value={s.monoThreshold} onChange={(v) => set('monoThreshold', v)} min={1} max={254} />
                </Field>
                <Field label="Light the dark parts (line drawings)">
                  <input type="checkbox" checked={s.monoInvert} onChange={(e) => set('monoInvert', e.target.checked)} />
                </Field>
                <Field label="Colour">
                  <span className="flex gap-1">
                    {['#e53935', '#1c1c1c', '#00f3de', '#ffffff', '#ffcc00', '#34c759', '#0a84ff', '#ff2d92', '#ff9500'].map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={c}
                        onClick={() => set('monoColour', c)}
                        className={`h-5 w-5 rounded-full border ${s.monoColour === c ? 'border-neutral-900 ring-2 ring-neutral-400' : 'border-neutral-300'}`}
                        style={{ background: c }}
                      />
                    ))}
                  </span>
                  <input type="color" value={s.monoColour} onChange={(e) => set('monoColour', e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Frames per second">
              <Num value={s.fps} onChange={(v) => set('fps', v)} min={1} max={30} />
            </Field>
            <Field label='"Jam" under it'>
              <input type="checkbox" checked={s.showName} onChange={(e) => set('showName', e.target.checked)} />
            </Field>
            {s.showName && (
              <Field label="Name baseline y">
                <Num value={s.nameY} onChange={(v) => set('nameY', v)} min={20} max={H - 4} />
              </Field>
            )}
          </section>

          <section className={`rounded-xl bg-white p-4 ${designing ? 'hidden' : ''}`}>
            <h2 className="mb-2 font-medium">On the pet</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-neutral-500">Picture on screen</dt>
              <dd>
                {visW}×{visH} px at ({box?.x ?? 0}, {box?.y ?? 0}), {frames.length} frame{frames.length === 1 ? '' : 's'}
              </dd>
              <dt className="text-neutral-500">Flash space</dt>
              <dd className={flashBytes > FLASH_FREE ? 'text-red-600' : ''}>
                {kb(flashBytes)} {flashBytes > FLASH_FREE ? '(too big: about 2 MB is free)' : `of about 2 MB free`}
              </dd>
              <dt className="text-neutral-500">Drawing time</dt>
              <dd className={maxFps < s.fps ? 'text-red-600' : ''}>
                ~{drawMs.toFixed(0)} ms per frame, so at most ~{maxFps} fps{maxFps < s.fps ? ` (you've set ${s.fps})` : ''}
              </dd>
            </dl>
            <p className="mt-2 text-xs text-neutral-500">
              Estimates, uncompressed. Full colour is how the pet draws today; 16 colours is the crane's format; one colour
              is the faces' format.
            </p>
            <button
              type="button"
              className="mt-3 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white"
              onClick={() => {
                void navigator.clipboard.writeText(settingsJson).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {copied ? 'Copied' : 'Copy these settings'}
            </button>
            <span className="ml-2 text-xs text-neutral-500">Paste them to Claude to put this on the pet.</span>
          </section>
        </div>
      </div>
    </div>
  )
}
