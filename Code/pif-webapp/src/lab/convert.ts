// Turns a video (or a set of pictures) into what the pet plays from its SD card's /media
// folder: <name>.mjpeg (baseline JPEGs back to back), <name>.wav (16-bit PCM) and <name>.cfg.
// Same files ffmpeg would make (see ffmpegCommands), done in the browser so nothing needs
// installing. Pet side: firmware/pet_story_player/pet_media.h.
import { decodeSound, prepareSound } from './audio'

export type Fit = 'original' | 'fit' | 'cover' | 'stretch'

export interface ConvertOptions {
  width: number // on the pet's screen, px (height follows the picture's shape)
  fps: number
  quality: number // JPEG quality 0.3 to 0.95
  start: number // s
  end: number // s; 0 = to the end
  sound: boolean
  rate: number // sound sample rate
  rotation: number // the pet's setRotation(): 2 portrait, 3 landscape
  loop: boolean
  y: number // -1 = centred
  fit: Fit // how the frame sits on the screen (the pet scales it while playing)
  top: string // text above the picture ("|" = new line); drawn once by the pet
  bottom: string // text below the picture
}

export interface Converted {
  mjpeg: Uint8Array
  wav: Uint8Array | null
  cfg: string
  width: number
  height: number
  frames: number
  seconds: number
  note: string
  firstFrame: string // data URL, for a preview
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

async function jpegBytes(c: HTMLCanvasElement, q: number) {
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('JPEG failed'))), 'image/jpeg', q))
  return new Uint8Array(await blob.arrayBuffer())
}

function join(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function wavBytes(pcm: Int16Array, rate: number) {
  const b = new ArrayBuffer(44 + pcm.byteLength)
  const v = new DataView(b)
  const s = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  s(0, 'RIFF')
  v.setUint32(4, 36 + pcm.byteLength, true)
  s(8, 'WAVE')
  s(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  s(36, 'data')
  v.setUint32(40, pcm.byteLength, true)
  new Int16Array(b, 44).set(pcm)
  return new Uint8Array(b)
}

export function cfgText(o: ConvertOptions) {
  return `fps=${o.fps}\nrotation=${o.rotation}\nfit=${o.fit}\nx=-1\ny=${o.y}\nloop=${o.loop ? 1 : 0}\noffset=0\n${o.top ? `top=${o.top}\n` : ''}${o.bottom ? `bottom=${o.bottom}\n` : ''}`
}

/** A name the pet's card and commands are happy with. */
export function safeName(name: string) {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'clip'
  )
}

export async function convertVideo(file: File, o: ConvertOptions, onProgress: (text: string, frac: number) => void): Promise<Converted> {
  const url = URL.createObjectURL(file)
  try {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.src = url
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res()
      v.onerror = () => rej(new Error(`The browser can't read ${file.name} as a video`))
    })
    const start = Math.max(0, Math.min(o.start, v.duration))
    const end = o.end > start ? Math.min(o.end, v.duration) : v.duration
    const w = even(o.width)
    const h = even((v.videoHeight * w) / v.videoWidth)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    const parts: Uint8Array[] = []
    const total = Math.max(1, Math.floor((end - start) * o.fps))
    for (let i = 0; i < total; i++) {
      v.currentTime = start + i / o.fps
      await new Promise<void>((res) => (v.onseeked = () => res()))
      ctx.drawImage(v, 0, 0, w, h)
      parts.push(await jpegBytes(c, o.quality))
      if (i % 5 === 0) onProgress(`Pictures: ${i + 1} of ${total}`, (i + 1) / total)
    }
    const firstFrame = parts.length ? URL.createObjectURL(new Blob([parts[0] as BlobPart], { type: 'image/jpeg' })) : ''
    let wav: Uint8Array | null = null
    let note = ''
    if (o.sound) {
      onProgress('Sound…', 1)
      try {
        const snd = await decodeSound(file.name, await file.arrayBuffer())
        wav = wavBytes(await prepareSound(snd, start, end, o.rate), o.rate)
      } catch {
        note = 'This video has no sound, so there’s no .wav.'
      }
    }
    return { mjpeg: join(parts), wav, cfg: cfgText(o), width: w, height: h, frames: parts.length, seconds: end - start, note, firstFrame }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Pictures in name order become the frames (an animation without a video). */
export async function convertPictures(files: File[], o: ConvertOptions, onProgress: (text: string, frac: number) => void): Promise<Converted> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const parts: Uint8Array[] = []
  let w = even(o.width)
  let h = 0
  for (let i = 0; i < sorted.length; i++) {
    const bmp = await createImageBitmap(sorted[i])
    if (!h) h = even((bmp.height * w) / bmp.width)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, w, h)
    parts.push(await jpegBytes(c, o.quality))
    onProgress(`Pictures: ${i + 1} of ${sorted.length}`, (i + 1) / sorted.length)
  }
  w = even(o.width)
  const firstFrame = parts.length ? URL.createObjectURL(new Blob([parts[0] as BlobPart], { type: 'image/jpeg' })) : ''
  return { mjpeg: join(parts), wav: null, cfg: cfgText(o), width: w, height: h, frames: parts.length, seconds: parts.length / o.fps, note: '', firstFrame }
}

/** A separate sound file for a picture animation (or to replace a video's own sound). */
export async function soundFile(file: File, o: ConvertOptions, seconds: number) {
  const snd = await decodeSound(file.name, await file.arrayBuffer())
  return wavBytes(await prepareSound(snd, 0, seconds || snd.buffer.duration, o.rate), o.rate)
}

/** The same conversion with ffmpeg, for copying onto the card with a card reader. */
export function ffmpegCommands(input: string, name: string, o: ConvertOptions) {
  const trim = `${o.start ? `-ss ${o.start} ` : ''}${o.end ? `-to ${o.end} ` : ''}`
  const q = Math.round(2 + (1 - o.quality) * 20) // ffmpeg -q:v: 2 best … 31 worst
  return [
    `ffmpeg ${trim}-i "${input}" -an -vf "fps=${o.fps},scale=${even(o.width)}:-2" -pix_fmt yuvj420p -q:v ${q} -f mjpeg ${name}.mjpeg`,
    `ffmpeg ${trim}-i "${input}" -vn -ac 1 -ar ${o.rate} -c:a pcm_s16le ${name}.wav`,
  ]
}
