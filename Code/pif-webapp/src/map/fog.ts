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

export class FogLayer extends L.Layer {
  private canvas: HTMLCanvasElement | null = null
  private points: [number, number][] = []
  private clearings: FogClearing[] = []
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
    const dpr = window.devicePixelRatio || 1
    const topLeft = map.containerPointToLayerPoint([0, 0])
    L.DomUtil.setPosition(canvas, topLeft)
    this.drawnBounds = map.getBounds()
    canvas.style.width = `${size.x}px`
    canvas.style.height = `${size.y}px`
    canvas.width = Math.round(size.x * dpr)
    canvas.height = Math.round(size.y * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    // Clouds, anchored to the map: offset by the view's absolute pixel position.
    this.pattern ??= ctx.createPattern(cloudTile(this.fog.rgb), 'repeat')
    const origin = topLeft.add(map.getPixelOrigin())
    if (this.pattern) {
      this.pattern.setTransform(new DOMMatrix().translate(-mod(origin.x, TILE), -mod(origin.y, TILE)))
      ctx.fillStyle = this.pattern
    } else {
      ctx.fillStyle = `rgba(${this.fog.rgb.join(',')},0.9)`
    }
    ctx.fillRect(0, 0, size.x, size.y)

    ctx.globalCompositeOperation = 'destination-out'
    const r = this.metresToPx(map, this.fog.radiusM)
    for (const [lat, lng] of this.points) this.clear(ctx, map.latLngToContainerPoint([lat, lng]), r, 0.45, size)
    // Inside a story you've entered: clear right to its edge, with only a thin soft rim.
    for (const [lat, lng, radiusM] of this.clearings) {
      this.clear(ctx, map.latLngToContainerPoint([lat, lng]), this.metresToPx(map, radiusM), 0.9, size)
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  private clear(ctx: CanvasRenderingContext2D, p: L.Point, r: number, solid: number, size: L.Point) {
    if (r <= 0 || p.x < -r || p.y < -r || p.x > size.x + r || p.y > size.y + r) return
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
