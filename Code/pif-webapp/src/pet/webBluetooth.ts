import type { CharName, NotifyName, PetLink } from './link.ts'
import { PET_CHAR, PET_SERVICE } from './protocol.ts'

// Minimal Web Bluetooth typings: the DOM lib doesn't ship them.
interface BtCharacteristic extends EventTarget {
  value?: DataView
  writeValueWithResponse(value: BufferSource): Promise<void>
  startNotifications(): Promise<BtCharacteristic>
}
interface BtService {
  getCharacteristic(uuid: string): Promise<BtCharacteristic>
}
interface BtServer {
  connected: boolean
  connect(): Promise<BtServer>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<BtService>
}
interface BtDevice extends EventTarget {
  name?: string
  gatt?: BtServer
}
interface Bluetooth {
  requestDevice(options: { filters: { services: string[] }[] }): Promise<BtDevice>
}

const CHAR_NAMES = ['play', 'transport', 'nowShowing', 'haptic', 'playback', 'input'] as const
const CONNECT_ATTEMPTS = 4
const RECONNECT_ATTEMPTS = 5
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Connects and fetches every characteristic, retrying: Chrome often reports "GATT Server is
 * disconnected" when the link drops in the first moments after connecting. Characteristics
 * are fetched one at a time, because some platforms (Windows in particular) reject
 * overlapping GATT operations.
 */
async function openGatt(device: BtDevice): Promise<Map<string, BtCharacteristic>> {
  let lastError: unknown
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    try {
      const gatt = device.gatt!
      const server = gatt.connected ? gatt : await gatt.connect()
      const service = await server.getPrimaryService(PET_SERVICE)
      const chars = new Map<string, BtCharacteristic>()
      for (const name of CHAR_NAMES) chars.set(name, await service.getCharacteristic(PET_CHAR[name]))
      return chars
    } catch (e) {
      lastError = e
      await sleep(400 * attempt)
    }
  }
  throw lastError
}

/**
 * Opens the browser's device picker and connects. Must be called from a tap
 * (Web Bluetooth requires a user gesture), never automatically on load.
 * If the link drops later, it reconnects by itself (no picker needed) before giving up.
 */
export async function pairWebBluetoothPet(): Promise<PetLink> {
  const bluetooth = (navigator as Navigator & { bluetooth: Bluetooth }).bluetooth
  const device = await bluetooth.requestDevice({ filters: [{ services: [PET_SERVICE] }] })
  if (!device.gatt) throw new Error('This pet has no Bluetooth services.')

  let chars = await openGatt(device)
  const subscriptions: { name: NotifyName; onValue: (view: DataView) => void }[] = []
  const disconnectHandlers: (() => void)[] = []
  let closing = false
  let reconnecting = false

  // GATT allows one operation at a time; queue every operation so they never overlap.
  let queue = Promise.resolve()
  const enqueue = <T>(op: () => Promise<T>) => {
    const next = queue.then(op)
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  // Chrome may hand back the same characteristic objects after a reconnect, so remember
  // which callbacks are already attached and never attach one twice.
  const attached = new WeakMap<BtCharacteristic, Set<(view: DataView) => void>>()
  const listen = async (name: NotifyName, onValue: (view: DataView) => void) => {
    const c = chars.get(name)!
    const set = attached.get(c) ?? new Set()
    attached.set(c, set)
    if (!set.has(onValue)) {
      set.add(onValue)
      c.addEventListener('characteristicvaluechanged', () => {
        if (c.value) onValue(c.value)
      })
    }
    await c.startNotifications()
  }

  device.addEventListener('gattserverdisconnected', async () => {
    if (closing || reconnecting) return
    reconnecting = true
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS && !closing; attempt++) {
      await sleep(1000 * attempt)
      try {
        chars = await openGatt(device)
        for (const s of subscriptions) await listen(s.name, s.onValue)
        reconnecting = false
        return
      } catch {
        // try again
      }
    }
    reconnecting = false
    disconnectHandlers.forEach((h) => h())
  })

  // Leaving the page (closing the tab, reloading) drops the link at once, so the pet shows it's
  // alone straight away instead of waiting for the link to time out.
  window.addEventListener('pagehide', () => {
    closing = true
    if (device.gatt?.connected) device.gatt.disconnect()
  })

  return {
    name: device.name || 'Pet',
    fake: false,
    write(name: CharName, bytes) {
      return enqueue(async () => {
        if (!device.gatt?.connected) throw new Error('The pet is reconnecting.')
        await chars.get(name)!.writeValueWithResponse(bytes as BufferSource)
      })
    },
    subscribe(name, onValue) {
      subscriptions.push({ name, onValue })
      void enqueue(() => listen(name, onValue)).catch(() => {})
    },
    onDisconnect(handler) {
      disconnectHandlers.push(handler)
    },
    disconnect() {
      closing = true
      if (device.gatt?.connected) device.gatt.disconnect()
      disconnectHandlers.forEach((h) => h())
    },
  }
}
