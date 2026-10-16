import L from 'leaflet'

// Fog over the map, cleared in soft circles around the places you have actually been, and
// fully inside any story circle you've entered. Drawn on one canvas the size of the map view,
// in its own pane above the story circles and below your marker and the labels. The fog is a
// cloud texture (made once, in the browser) that moves with the map as you pan.

export interface FogOptions {
  /** The fog's base colour as r, g, b (0-255); the clouds vary its brightness and density. */
  rgb: [number, number, number]
  /** How far around each revealed point the fog clears, in metres. */
  radiusM: number
}

/** A circle to clear completely: [lat, lng, radius in metres]. */
export type FogClearing = [number, number, number]

const TILE = 512
/** Extra fog drawn beyond each side of the view, as a share of its size, so zooming out
 * (which shrinks the last drawing until the redraw) never shows a bare edge. */
const PAD = 0.75
/** A story clearing opens out from its centre over this long. */
const OPEN_MS = 1400

export class FogLayer extends L.Layer {
  private canvas: HTMLCanvasElement | null = null
  private points: [number, number][] = []
  private clearings: FogClearing[] = []
  /** When each clearing (keyed by lat,lng) first appeared, for the opening animation. */
  private readonly opened = new Map<string, number>()
  private frame = 0
  private pattern: CanvasPattern | null = null
  private drawnBounds: L.LatLngBounds | null = null
  private readonly fog: FogOptions

  constructor(fog: FogOptions) {
    super()
    this.fog = fog
  }

  setPoints(points: [number, number][], clearings: FogClearing[]) {
    this.points = points
    this.clearings = clearings
    // Clearings there from the start (saved ones) are already open; new ones animate.
    const now = this.opened.size || this.points.length ? performance.now() : -OPEN_MS
    for (const [lat, lng] of clearings) {
      const key = `${lat},${lng}`
      if (!this.opened.has(key)) this.opened.set(key, now)
    }
    this.draw()
    return this
  }

  onAdd(map: L.Map) {
    const pane = map.getPane('fog') ?? map.createPane('fog')
    pane.style.zIndex = '450'
    pane.style.pointerEvents = 'none'
    // leaflet-zoom-animated: scaled along with the map during zoom animations (see onZoomAnim).
    this.canvas = L.DomUtil.create('canvas', 'pif-fog leaflet-zoom-animated', pane)
    map.on('move zoom zoomend resize viewreset', this.draw, this)
    map.on('zoomanim', this.onZoomAnim, this)
    this.draw()
    return this
  }

  onRemove(map: L.Map) {
    map.off('move zoom zoomend resize viewreset', this.draw, this)
    map.off('zoomanim', this.onZoomAnim, this)
    cancelAnimationFrame(this.frame)
    this.canvas?.remove()
    this.canvas = null
    return this
  }

  /** Stretch the last drawing to where the map is zooming to, like Leaflet's image overlays. */
  private onZoomAnim(e: L.ZoomAnimEvent) {
    const map = this._map as L.Map & {
      _latLngBoundsToNewLayerBounds(b: L.LatLngBounds, zoom: number, center: L.LatLng): L.Bounds
    }
    if (!this.canvas || !this.drawnBounds) return
    const scale = map.getZoomScale(e.zoom)
    const offset = map._latLngBoundsToNewLayerBounds(this.drawnBounds, e.zoom, e.center).min
    if (offset) L.DomUtil.setTransform(this.canvas, offset, scale)
  }

  private draw() {
    const map = this._map
    const canvas = this.canvas
    if (!map || !canvas) return
    const size = map.getSize()
    const pad = L.point(Math.round(size.x * PAD), Math.round(size.y * PAD))
    const full = size.add(pad.multiplyBy(2))
    // The fog is soft, so one canvas pixel per CSS pixel is plenty (and keeps it light).
    const topLeft = map.containerPointToLayerPoint(pad.multiplyBy(-1))
    L.DomUtil.setPosition(canvas, topLeft)
    this.drawnBounds = L.latLngBounds(
      map.containerPointToLatLng(pad.multiplyBy(-1)),
      map.containerPointToLatLng(size.add(pad)),
    )
    canvas.style.width = `${full.x}px`
    canvas.style.height = `${full.y}px`
    canvas.width = full.x
    canvas.height = full.y
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Clouds, anchored to the map: offset by the canvas's absolute pixel position.
    this.pattern ??= ctx.createPattern(cloudTile(this.fog.rgb), 'repeat')
    const origin = topLeft.add(map.getPixelOrigin())
    if (this.pattern) {
      this.pattern.setTransform(new DOMMatrix().translate(-mod(origin.x, TILE), -mod(origin.y, TILE)))
      ctx.fillStyle = this.pattern
    } else {
      ctx.fillStyle = `rgba(${this.fog.rgb.join(',')},0.9)`
    }
    ctx.fillRect(0, 0, full.x, full.y)

    // From here on, draw in the map's container coordinates.
    ctx.translate(pad.x, pad.y)
    const area = L.bounds(pad.multiplyBy(-1), size.add(pad))
    ctx.globalCompositeOperation = 'destination-out'
    const r = this.metresToPx(map, this.fog.radiusM)
    for (const [lat, lng] of this.points) this.clear(ctx, map.latLngToContainerPoint([lat, lng]), r, 0.45, area)
    // Inside a story you've entered: clear right to its edge, with only a thin soft rim. A new
    // clearing opens out from the centre, easing to a stop.
    const now = performance.now()
    let opening = false
    for (const [lat, lng, radiusM] of this.clearings) {
      const t = Math.min(1, (now - (this.opened.get(`${lat},${lng}`) ?? 0)) / OPEN_MS)
      if (t < 1) opening = true
      const eased = 1 - (1 - t) ** 3
      this.clear(ctx, map.latLngToContainerPoint([lat, lng]), this.metresToPx(map, radiusM) * eased, 0.9 - 0.5 * (1 - t), area)
    }
    ctx.globalCompositeOperation = 'source-over'
    cancelAnimationFrame(this.frame)
    if (opening) this.frame = requestAnimationFrame(() => this.draw())
  }

  private clear(ctx: CanvasRenderingContext2D, p: L.Point, r: number, solid: number, area: L.Bounds) {
    const { min, max } = area
    if (r <= 0 || !min || !max || p.x < min.x - r || p.y < min.y - r || p.x > max.x + r || p.y > max.y + r) return
    const g = ctx.createRadialGradient(p.x, p.y, r * solid, p.x, p.y, r)
    g.addColorStop(0, 'rgba(0,0,0,1)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  /** Metres to pixels at this zoom, measured at the map's centre (good enough for a city). */
  private metresToPx(map: L.Map, m: number) {
    const c = map.getCenter()
    const north = L.latLng(c.lat + m / 111_320, c.lng)
    return Math.abs(map.latLngToContainerPoint(c).y - map.latLngToContainerPoint(north).y)
  }
}

const mod = (a: number, n: number) => ((a % n) + n) % n

/** A seamless cloud tile: fractal value noise that wraps at the edges, as fog colour + alpha. */
function cloudTile([r, g, b]: [number, number, number]): HTMLCanvasElement {
  const tile = document.createElement('canvas')
  tile.width = TILE
  tile.height = TILE
  const ctx = tile.getContext('2d')
  if (!ctx) return tile
  const img = ctx.createImageData(TILE, TILE)

  // Fixed seed so the clouds look the same on every visit.
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const octaves = [4, 8, 16, 32, 64].map((cells) => ({ cells, grid: Array.from({ length: cells * cells }, rand) }))
  const smooth = (t: number) => t * t * (3 - 2 * t)

  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let v = 0
      let amp = 0.5
      let total = 0
      for (const { cells, grid } of octaves) {
        const fx = (x / TILE) * cells
        const fy = (y / TILE) * cells
        const x0 = Math.floor(fx)
        const y0 = Math.floor(fy)
        const x1 = (x0 + 1) % cells
        const y1 = (y0 + 1) % cells
        const tx = smooth(fx - x0)
        const ty = smooth(fy - y0)
        const top = grid[y0 * cells + x0] * (1 - tx) + grid[y0 * cells + x1] * tx
        const bottom = grid[y1 * cells + x0] * (1 - tx) + grid[y1 * cells + x1] * tx
        v += (top * (1 - ty) + bottom * ty) * amp
        total += amp
        amp *= 0.55
      }
      v /= total // 0..1, mostly 0.3..0.7
      const k = Math.min(1, Math.max(0, (v - 0.25) / 0.5))
      const i = (y * TILE + x) * 4
      // Brighter, denser billows over a slightly darker, thinner haze.
      const shade = 0.9 + 0.14 * k
      img.data[i] = Math.min(255, r * shade)
      img.data[i + 1] = Math.min(255, g * shade)
      img.data[i + 2] = Math.min(255, b * shade)
      img.data[i + 3] = Math.round(255 * (0.78 + 0.2 * k))
    }
  }
  ctx.putImageData(img, 0, 0)
  return tile
}
