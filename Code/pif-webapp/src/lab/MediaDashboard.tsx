import { useEffect, useState } from 'react'
import { type Converted, type ConvertOptions, type Fit, convertPictures, convertVideo, ffmpegCommands, safeName, soundFile } from './convert'
import { LiveSender, hasSerial } from './petSerial'
import { Choice, Field, Num } from './ui'

// The pet media dashboard (/media): what's on the pet's SD card, play it, and add videos.
// Videos become MJPEG + WAV (+ settings) in the browser, then go onto the card over USB, or
// download for a card reader. Pet side: firmware/pet_story_player/pet_media.h.

interface Item {
  name: string
  videoBytes: number
  sound: boolean
  cfg: boolean
}

interface Stat {
  decodeMs: number
  skipped: number
  shown: number
}

const DEFAULT_OPTIONS: ConvertOptions = {
  width: 240,
  fps: 15,
  quality: 0.75,
  start: 0,
  end: 0,
  sound: true,
  rate: 22050,
  rotation: 2,
  fit: 'original',
  top: '',
  bottom: '',
  loop: false,
  y: -1,
}

const kb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${Math.round(n / 1000)} KB`)

function download(name: string, data: Uint8Array | string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data as BlobPart]))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export function MediaDashboard() {
  const [sender] = useState(() => new LiveSender())
  const [live, setLive] = useState<'off' | 'connecting' | 'on'>('off')
  const [status, setStatus] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [psram, setPsram] = useState(0)
  const [playing, setPlaying] = useState<{ name: string; info: string } | null>(null)
  const [stat, setStat] = useState<Stat | null>(null)
  const [loop, setLoop] = useState(false)
  const [fit, setFit] = useState<Fit>('original')
  const [turn, setTurn] = useState(2)
  const [topText, setTopText] = useState('')
  const [bottomText, setBottomText] = useState('')
  const [fps, setFps] = useState(15)
  const [offset, setOffset] = useState(0)
  const [volume, setVolume] = useState(90)
  // Adding media
  const [files, setFiles] = useState<File[]>([])
  const [extraSound, setExtraSound] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [o, setO] = useState<ConvertOptions>(DEFAULT_OPTIONS)
  const setOpt = <K extends keyof ConvertOptions>(k: K, v: ConvertOptions[K]) => setO((x) => ({ ...x, [k]: v }))
  const [result, setResult] = useState<Converted | null>(null)
  const [work, setWork] = useState<{ text: string; frac: number } | null>(null)

  useEffect(() => () => void sender.pet.disconnect(), [sender])

  function onLine(line: string) {
    const st = line.match(/^MEDIASTAT decode=(\d+) skipped=(\d+) shown=(\d+)/)
    if (st) {
      setStat({ decodeMs: Number(st[1]), skipped: Number(st[2]), shown: Number(st[3]) })
      return
    }
    const play = line.match(/^MEDIAPLAY (\S+) (.*)$/)
    if (play) {
      setPlaying({ name: play[1], info: play[2] })
      setFps(Number(play[2].match(/fps=([\d.]+)/)?.[1] ?? 15))
      setLoop(play[2].includes('loop=1'))
      setFit((play[2].match(/fit=(\w+)/)?.[1] as Fit) ?? 'original')
      setTurn(Number(play[2].match(/rotation=(\d)/)?.[1] ?? 2))
      setStat(null)
    }
    if (line.startsWith('MEDIADONE') || line === 'MEDIAOK stopped') setPlaying(null)
    if (line.startsWith('MEDIAERR')) setStatus(line.slice(9))
    if (!line.startsWith('MEDIA ') && !line.startsWith('MEDIARX')) setLog((l) => [...l.slice(-6), line])
  }

  async function refresh() {
    const { files: list, psramFree } = await sender.pet.listMedia()
    setPsram(psramFree)
    const byName = new Map<string, Item>()
    for (const f of list) {
      const m = f.name.match(/^(.*)\.(mjpeg|wav|cfg)$/i)
      if (!m) continue
      const it = byName.get(m[1]) ?? { name: m[1], videoBytes: 0, sound: false, cfg: false }
      const ext = m[2].toLowerCase()
      if (ext === 'mjpeg') it.videoBytes = f.size
      if (ext === 'wav') it.sound = true
      if (ext === 'cfg') it.cfg = true
      byName.set(m[1], it)
    }
    setItems([...byName.values()].filter((i) => i.videoBytes).sort((a, b) => a.name.localeCompare(b.name)))
  }

  async function connect() {
    setLive('connecting')
    sender.listen(onLine, setStatus)
    sender.hold(true) // this page never mirrors frames
    try {
      await sender.pet.connect(setStatus)
      setLive('on')
      setStatus('Connected')
      await refresh()
    } catch (e) {
      await sender.pet.disconnect()
      setLive('off')
      setStatus((e as Error).message)
    }
  }

  const cmd = (line: string) => void sender.pet.text(line).catch((e: Error) => setStatus(e.message))

  async function convert() {
    if (!files.length) return
    setResult(null)
    setWork({ text: 'Starting…', frac: 0 })
    try {
      const onProgress = (text: string, frac: number) => setWork({ text, frac })
      const isVideo = files[0].type.startsWith('video/')
      const r = isVideo ? await convertVideo(files[0], o, onProgress) : await convertPictures(files, o, onProgress)
      if (extraSound) r.wav = await soundFile(extraSound, o, r.seconds)
      setResult(r)
      setWork(null)
    } catch (e) {
      setWork(null)
      setStatus((e as Error).message)
    }
  }

  async function putOnPet() {
    if (!result) return
    const base = safeName(name || files[0]?.name || 'clip')
    const parts: [string, Uint8Array][] = [[`${base}.mjpeg`, result.mjpeg], [`${base}.cfg`, new TextEncoder().encode(result.cfg)]]
    if (result.wav) parts.push([`${base}.wav`, result.wav])
    const total = parts.reduce((n, [, b]) => n + b.length, 0)
    let done = 0
    try {
      for (const [file, bytes] of parts) {
        await sender.pet.sendFile(file, bytes, (n) => setWork({ text: `Sending ${file}…`, frac: (done + n) / total }))
        done += bytes.length
      }
      setWork(null)
      setStatus(`${base} is on the card`)
      await refresh()
      cmd(`media play ${base}`)
    } catch (e) {
      setWork(null)
      setStatus((e as Error).message)
    }
  }

  function chooseFiles(list: FileList | null) {
    const f = list ? [...list] : []
    setFiles(f)
    setResult(null)
    if (f[0]) setName(safeName(f[0].name))
  }

  const base = safeName(name || files[0]?.name || 'clip')
  const btn = 'rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm disabled:opacity-40'
  const primary = 'rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40'
  const keepsUp = stat && stat.decodeMs > 0 ? Math.floor(1000 / stat.decodeMs) : 0

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
        <div>
          <h1 className="text-xl font-semibold">Pet media</h1>
          <p className="text-sm text-neutral-500">
            Videos and animations on the pet’s SD card: play them, and add new ones. For designing screens, use the{' '}
            <a className="underline" href="./lab">
              lab
            </a>
            .
          </p>
        </div>

        <section className="rounded-xl bg-white p-4">
          <h2 className="mb-2 font-medium">The pet</h2>
          {!hasSerial() ? (
            <p className="text-sm text-neutral-500">This needs Chrome or Edge on a computer (Web Serial).</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              {live === 'on' ? (
                <button type="button" className={btn} onClick={() => void sender.pet.disconnect().then(() => setLive('off'))}>
                  Disconnect
                </button>
              ) : (
                <button type="button" className={primary} disabled={live === 'connecting'} onClick={() => void connect()}>
                  {live === 'connecting' ? 'Connecting…' : 'Connect the pet (USB)'}
                </button>
              )}
              <span className={`h-2.5 w-2.5 rounded-full ${live === 'on' ? 'bg-emerald-500' : 'bg-neutral-300'}`} />
              <span className="text-sm text-neutral-600">{status}</span>
            </div>
          )}
          <p className="mt-2 text-xs text-neutral-500">Close the Arduino Serial Monitor first. The SD card needs to be in.</p>
          {log.length > 0 && <pre className="mt-2 max-h-28 overflow-auto rounded bg-neutral-100 p-2 text-xs text-neutral-600">{log.join('\n')}</pre>}
        </section>

        {live === 'on' && (
          <section className="rounded-xl bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-medium">On the card</h2>
              <button type="button" className="text-sm text-neutral-500 underline" onClick={() => void refresh()}>
                Refresh
              </button>
            </div>
            {items.length === 0 ? (
              <p className="text-sm text-neutral-500">Nothing in /media yet. Add a video below.</p>
            ) : (
              <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
                {items.map((it) => (
                  <li key={it.name} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="flex-1 font-medium">{it.name}</span>
                    <span className="text-neutral-500">{kb(it.videoBytes)}</span>
                    <span className="w-16 text-neutral-500">{it.sound ? 'sound' : 'silent'}</span>
                    <button type="button" className={btn} onClick={() => cmd(`media play ${it.name}`)}>
                      ▶ Play
                    </button>
                    <button
                      type="button"
                      className="px-1 text-neutral-400"
                      title="Delete from the card"
                      onClick={() => {
                        if (!confirm(`Delete ${it.name} from the pet's card?`)) return
                        void (async () => {
                          for (const ext of ['mjpeg', 'wav', 'cfg']) await sender.pet.text(`media rm ${it.name}.${ext}`)
                          await refresh()
                        })()
                      }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {psram > 0 && <p className="mt-1 text-xs text-neutral-500">A video plays from memory: up to about {kb(psram - 65536)} each.</p>}
          </section>
        )}

        {live === 'on' && playing && (
          <section className="rounded-xl bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-medium">Playing: {playing.name}</h2>
              <button type="button" className={btn} onClick={() => cmd('media stop')}>
                ■ Stop
              </button>
            </div>
            <p className="text-xs text-neutral-500">{playing.info.replace(/ /g, ' · ')}</p>
            {stat && (
              <p className={`mt-1 text-sm ${stat.skipped ? 'text-red-600' : 'text-emerald-700'}`}>
                Each frame takes {stat.decodeMs} ms to decode and draw (up to ~{keepsUp} fps).{' '}
                {stat.skipped
                  ? `Skipped ${stat.skipped} of ${stat.shown + stat.skipped} frames: lower the fps or the width.`
                  : `Keeping up at ${fps} fps.`}
              </p>
            )}
            <Field label="Size on the screen">
              <Choice
                value={fit}
                options={[
                  ['original', 'Actual'],
                  ['fit', 'Fit'],
                  ['cover', 'Fill (crop)'],
                  ['stretch', 'Stretch'],
                ]}
                onChange={(v) => {
                  setFit(v)
                  cmd(`media fit ${v}`)
                }}
              />
            </Field>
            <Field label="Text above (| = new line; Enter to send)">
              <input
                value={topText}
                onChange={(e) => setTopText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && cmd(`media top ${topText}`)}
                onBlur={() => cmd(`media top ${topText}`)}
                className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-sm"
              />
            </Field>
            <Field label="Text below">
              <input
                value={bottomText}
                onChange={(e) => setBottomText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && cmd(`media bottom ${bottomText}`)}
                onBlur={() => cmd(`media bottom ${bottomText}`)}
                className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-sm"
              />
            </Field>
            <Field label="Turn">
              <Choice
                value={turn}
                options={[
                  [2, 'Upright'],
                  [0, 'Upside down'],
                  [3, 'Sideways'],
                  [1, 'Sideways ↺'],
                ]}
                onChange={(v) => {
                  setTurn(v)
                  cmd(`media rotate ${v}`)
                }}
              />
            </Field>
            <Field label="Loop">
              <input
                type="checkbox"
                checked={loop}
                onChange={(e) => {
                  setLoop(e.target.checked)
                  cmd(`media loop ${e.target.checked ? 'on' : 'off'}`)
                }}
              />
            </Field>
            <Field label="Frames per second (1 = slow motion … real speed is what it was made at)">
              <Num
                value={fps}
                onChange={(v) => {
                  setFps(v)
                  cmd(`media fps ${v}`)
                }}
                min={1}
                max={30}
              />
            </Field>
            <Field label="Sound sync (ms, + = sound later)">
              <Num
                value={offset}
                onChange={(v) => {
                  setOffset(v)
                  cmd(`media offset ${v}`)
                }}
                min={-1000}
                max={1000}
                step={10}
              />
            </Field>
            <Field label="Volume">
              <Num
                value={volume}
                onChange={(v) => {
                  setVolume(v)
                  cmd(`lab vol ${v}`)
                }}
                min={0}
                max={100}
              />
            </Field>
          </section>
        )}

        <section className="rounded-xl bg-white p-4">
          <h2 className="mb-1 font-medium">Add a video or animation</h2>
          <p className="mb-2 text-xs text-neutral-500">
            A video (MP4, MOV, WebM…), or several pictures as the frames of an animation. It’s converted here, in the browser.
          </p>
          <Field label="Video, or pictures">
            <input type="file" accept="video/*,image/*" multiple onChange={(e) => chooseFiles(e.target.files)} className="w-60 text-xs" />
          </Field>
          <Field label="Sound from another file (optional)">
            <input type="file" accept="audio/*,video/*" onChange={(e) => setExtraSound(e.target.files?.[0] ?? null)} className="w-60 text-xs" />
          </Field>
          <Field label="Name on the card">
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-48 rounded border border-neutral-300 px-2 py-0.5 text-sm" />
          </Field>
          <Field label="Width on the screen (px; 240 = full width upright)">
            <Num value={o.width} onChange={(v) => setOpt('width', v)} min={40} max={320} step={8} />
          </Field>
          <Field label="Frames per second">
            <Num value={o.fps} onChange={(v) => setOpt('fps', v)} min={1} max={30} />
          </Field>
          <Field label="Picture quality (smaller file ↔ sharper)">
            <Num value={Math.round(o.quality * 100)} onChange={(v) => setOpt('quality', v / 100)} min={30} max={95} step={5} />
          </Field>
          <Field label="From (s)">
            <Num value={o.start} onChange={(v) => setOpt('start', v)} min={0} max={600} step={0.5} />
          </Field>
          <Field label="To (s, 0 = the end)">
            <Num value={o.end} onChange={(v) => setOpt('end', v)} min={0} max={600} step={0.5} />
          </Field>
          <Field label="Keep the video’s sound">
            <input type="checkbox" checked={o.sound} onChange={(e) => setOpt('sound', e.target.checked)} />
          </Field>
          <Field label="Sound quality">
            <Choice
              value={o.rate}
              options={[
                [11025, '11k'],
                [16000, '16k'],
                [22050, '22k'],
              ]}
              onChange={(v) => setOpt('rate', v)}
            />
          </Field>
          <Field label="Screen">
            <Choice
              value={o.rotation}
              options={[
                [2, 'Upright'],
                [3, 'Sideways'],
              ]}
              onChange={(v) => setOpt('rotation', v)}
            />
          </Field>
          <Field label="Size on the screen">
            <Choice
              value={o.fit}
              options={[
                ['original', 'Actual'],
                ['fit', 'Fit'],
                ['cover', 'Fill (crop)'],
                ['stretch', 'Stretch'],
              ]}
              onChange={(v) => setOpt('fit', v)}
            />
          </Field>
          <Field label="Text above the picture (| = new line)">
            <input value={o.top} onChange={(e) => setOpt('top', e.target.value)} className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-sm" />
          </Field>
          <Field label="Text below the picture">
            <input value={o.bottom} onChange={(e) => setOpt('bottom', e.target.value)} className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-sm" />
          </Field>
          <Field label="Up/down position (px from the top; -1 = centred; Actual size only)">
            <Num value={o.y} onChange={(v) => setOpt('y', v)} min={-1} max={320} />
          </Field>
          <Field label="Loop by default">
            <input type="checkbox" checked={o.loop} onChange={(e) => setOpt('loop', e.target.checked)} />
          </Field>

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btn} disabled={!files.length || !!work} onClick={() => void convert()}>
              Convert
            </button>
            <button type="button" className={primary} disabled={!result || live !== 'on' || !!work} onClick={() => void putOnPet()}>
              Put on the pet and play
            </button>
            <button
              type="button"
              className={btn}
              disabled={!result}
              onClick={() => {
                if (!result) return
                download(`${base}.mjpeg`, result.mjpeg)
                download(`${base}.cfg`, result.cfg)
                if (result.wav) download(`${base}.wav`, result.wav)
              }}
            >
              Download (for a card reader)
            </button>
          </div>
          {work && (
            <div className="mt-2">
              <div className="h-2 overflow-hidden rounded bg-neutral-200">
                <div className="h-full bg-neutral-900" style={{ width: `${Math.round(work.frac * 100)}%` }} />
              </div>
              <p className="mt-1 text-xs text-neutral-500">{work.text}</p>
            </div>
          )}
          {result && (
            <div className="mt-3 flex gap-3">
              {result.firstFrame && <img src={result.firstFrame} alt="" className="h-24 rounded bg-black object-contain" />}
              <p className="text-sm text-neutral-600">
                {result.frames} frames of {result.width}×{result.height} ({result.seconds.toFixed(1)} s): video {kb(result.mjpeg.length)}
                {result.wav ? `, sound ${kb(result.wav.length)}` : ', no sound'}. Sending takes about{' '}
                {Math.ceil(((result.mjpeg.length + (result.wav?.length ?? 0)) * 10) / sender.pet.baud)} s.
                {result.mjpeg.length > psram - 65536 && psram > 0 ? ' Too big to play from memory: shorten it, or lower the width or quality.' : ''}
                {result.note && ` ${result.note}`}
              </p>
            </div>
          )}

          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-neutral-600">With a card reader instead (ffmpeg)</summary>
            <p className="mt-2 text-xs text-neutral-500">
              Make the files with these commands, then copy them into a folder called <code>media</code> on the card:
            </p>
            <pre className="mt-1 overflow-auto rounded bg-neutral-100 p-2 text-xs">
              {ffmpegCommands(files[0]?.name ?? 'your-video.mp4', base, o).join('\n')}
              {`\n# settings (save as ${base}.cfg):\n# fps=${o.fps}  rotation=${o.rotation}  y=${o.y}  loop=${o.loop ? 1 : 0}`}
            </pre>
          </details>
        </section>
      </div>
    </div>
  )
}
