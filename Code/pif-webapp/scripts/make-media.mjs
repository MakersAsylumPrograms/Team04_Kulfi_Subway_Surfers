// Turns a video into what the pet plays from its SD card's /media folder:
//   firmware/sd-card/media/<name>.mjpeg   the pictures (JPEGs back to back)
//   firmware/sd-card/media/<name>.wav     the sound (only if the video has one)
//   firmware/sd-card/media/<name>.cfg     settings the pet reads (fps, rotation, loop …)
// Copy the three files into a folder called "media" on the card, then on the pet:
// "media play <name>" in the Serial Monitor, or Play in the dashboard (/media).
//
// Usage:  node scripts/make-media.mjs <video> [name] [options]
//   --fps 15        frames per second (lower: smaller and easier to play)
//   --width 240     width on the screen; 240 is full width upright
//   --fill          fill the upright 240x320 screen, cutting off the sides
//   --quality 7     2 (best, biggest) … 31 (worst, smallest)
//   --from 2 --to 8 use only seconds 2 to 8
//   --loop          repeat by default
//   --sideways      for the screen turned sideways (320 wide)
//   --rotation 1    which sideways (1 or 3; default 3), or upright (0 or 2; default 2)
//   --top "Text"    text above the picture, --bottom "Text" below ("|" starts a new line)
//   --fit cover     how the pet sizes it on the screen: original (actual size), fit (whole
//                   picture, bars), cover (fills, edges cut off), stretch (fills, shape changes)
// Needs ffmpeg (set FFMPEG=path\to\ffmpeg.exe if it isn't on PATH).

import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const args = process.argv.slice(2)
const flag = (k) => args.includes(`--${k}`)
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : d
}
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['fill', 'loop', 'sideways'].includes(args[i - 1].slice(2))))
const fit = opt('fit', 'original')
if (!['original', 'fit', 'cover', 'stretch'].includes(fit)) {
  console.error('--fit is one of: original, fit, cover, stretch')
  process.exit(1)
}
const input = positional[0]
if (!input) {
  console.error('usage: node scripts/make-media.mjs <video> [name] [--fps 15] [--width 240] [--fill] [--quality 7] [--from s] [--to s] [--loop] [--sideways]')
  process.exit(1)
}
const name = (positional[1] || basename(input).replace(/\.[^.]+$/, ''))
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 24)
const fps = Number(opt('fps', 15))
const sideways = flag('sideways')
const width = Number(opt('width', sideways ? 320 : 240))
const quality = opt('quality', '7')
const trim = [...(opt('from') ? ['-ss', opt('from')] : []), ...(opt('to') ? ['-to', opt('to')] : [])]
const ffmpeg = process.env.FFMPEG || 'ffmpeg'
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')

const out = 'firmware/sd-card/media'
mkdirSync(out, { recursive: true })
// --fill: scale up until both sides cover the screen, then cut the middle out (works for any shape).
const [SW, SH] = sideways ? [320, 240] : [240, 320]
const scale = flag('fill') ? `scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH}` : `scale=${width}:-2`

execFileSync(ffmpeg, ['-v', 'error', '-y', ...trim, '-i', input, '-an', '-vf', `fps=${fps},${scale}`, '-pix_fmt', 'yuvj420p', '-q:v', quality, '-f', 'mjpeg', join(out, `${name}.mjpeg`)], { stdio: 'inherit' })

const hasSound = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', input]).toString().trim() !== ''
if (hasSound)
  execFileSync(ffmpeg, ['-v', 'error', '-y', ...trim, '-i', input, '-vn', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', join(out, `${name}.wav`)], { stdio: 'inherit' })

writeFileSync(join(out, `${name}.cfg`), `fps=${fps}\nrotation=${opt('rotation', sideways ? 3 : 2)}\nfit=${fit}\nx=-1\ny=-1\nloop=${flag('loop') ? 1 : 0}\noffset=0\n${opt('top') ? `top=${opt('top')}\n` : ''}${opt('bottom') ? `bottom=${opt('bottom')}\n` : ''}`)

const kb = (f) => `${Math.round(statSync(join(out, f)).size / 1000)} KB`
console.log(`${name}: ${name}.mjpeg ${kb(`${name}.mjpeg`)}${hasSound ? `, ${name}.wav ${kb(`${name}.wav`)}` : ' (no sound in the video)'}, ${name}.cfg -> ${out}`)
