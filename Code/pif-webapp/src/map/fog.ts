import L from 'leaflet'

// Fog over the map, cleared in soft circles around the places you have actually been.
// Drawn on one canvas the size of the map view, in its own pane above the story circles and
// below your marker and the labels. Revealed points are plain lat/lngs; where they come from
// (and whether they are saved) is the caller's business.

export interface FogOptions {
  color: string
  /** How far around each revealed point the fog clears, in metres. */
  radiusM: number
}

export class FogLayer extends L.Layer {
  private canvas: HTMLCanvasElement | null = null
  private points: [number, number][] = []
  private readonly fog: FogOptions

  constructor(fog: FogOptions) {
    super()
    this.fog = fog
  }

  setPoints(points: [number, number][]) {
    this.points = points
    this.draw()
    return this
  }

  onAdd(map: L.Map) {
    const pane = map.getPane('fog') ?? map.createPane('fog')
    pane.style.zIndex = '450'
    pane.style.pointerEvents = 'none'
    // leaflet-zoom-hide: Leaflet hides it during the zoom animation, then we redraw.
    this.canvas = L.DomUtil.create('canvas', 'pif-fog leaflet-zoom-hide', pane)
    map.on('move zoomend resize viewreset', this.draw, this)
    this.draw()
    return this
  }

  onRemove(map: L.Map) {
    map.off('move zoomend resize viewreset', this.draw, this)
    this.canvas?.remove()
    this.canvas = null
    return this
  }

  private draw() {
    const map = this._map
    const canvas = this.canvas
    if (!map || !canvas) return
    const size = map.getSize()
    const dpr = window.devicePixelRatio || 1
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
    canvas.style.width = `${size.x}px`
    canvas.style.height = `${size.y}px`
    canvas.width = Math.round(size.x * dpr)
    canvas.height = Math.round(size.y * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.fillStyle = this.fog.color
    ctx.fillRect(0, 0, size.x, size.y)

    // Metres to pixels at this zoom, measured at the map's centre (good enough for a city).
    const c = map.getCenter()
    const north = L.latLng(c.lat + this.fog.radiusM / 111_320, c.lng)
    const r = Math.abs(map.latLngToContainerPoint(c).y - map.latLngToContainerPoint(north).y)

    ctx.globalCompositeOperation = 'destination-out'
    for (const [lat, lng] of this.points) {
      const p = map.latLngToContainerPoint([lat, lng])
      if (p.x < -r || p.y < -r || p.x > size.x + r || p.y > size.y + r) continue
      const g = ctx.createRadialGradient(p.x, p.y, r * 0.55, p.x, p.y, r)
      g.addColorStop(0, 'rgba(0,0,0,1)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }
}
