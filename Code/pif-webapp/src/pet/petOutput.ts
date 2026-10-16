import type { PlaybackPosition, StoryOutput } from '../audio/player.ts'
import type { Story } from '../data/types.ts'
import type { PetLink } from './link.ts'
import {
  decodeInput,
  decodePlayback,
  encodeHaptic,
  encodeNowShowing,
  encodePlay,
  encodeTransport,
  Haptic,
  PlaybackState,
  Transport,
  type InputEventValue,
  type PlaybackStateValue,
} from './protocol.ts'

/** How long the pet shows "You've arrived at …" before the story starts. */
const ARRIVAL_MS = 3000

/**
 * Plays stories on the pet: sends the id, never the audio. The phone stays silent
 * unless the pet is missing the file, a write fails, or the pet disconnects
 * mid-story; then the phone picks the story up from where the pet was.
 */
export class PetOutput implements StoryOutput {
  private readonly link: PetLink
  private readonly phone: StoryOutput
  private mode: 'idle' | 'pet' | 'phone' = 'idle'
  private story: Story | null = null
  private onEnd: (() => void) | null = null
  private state: PlaybackStateValue = PlaybackState.idle
  private positionS = 0
  private connected = true
  /** The pet has reported this story playing; until then, stale idle reports are ignored. */
  private confirmed = false
  /** Set by the journey: what a pat or double-pat on the pet should do. */
  onInput: ((event: InputEventValue) => void) | null = null
  /**
   * Say "You've arrived at …" on the pet for a moment before each story. Off in the visitor
   * app, where the pop-up (and the pet's own "Story here") already announced it and you
   * chose to listen, or are replaying.
   */
  announceArrival = true

  constructor(link: PetLink, phone: StoryOutput) {
    this.link = link
    this.phone = phone
    link.subscribe('playback', (view) => {
      const report = decodePlayback(view)
      if (report) this.handlePlayback(report.state, report.positionS)
    })
    link.subscribe('input', (view) => {
      const event = decodeInput(view)
      if (event !== null) this.onInput?.(event)
    })
    link.onDisconnect(() => {
      this.connected = false
      if (this.mode === 'pet' && this.state !== PlaybackState.idle) this.fallBackToPhone(this.positionS)
    })
  }

  play(story: Story, onEnd: () => void) {
    // A new play replaces whatever the pet is playing; no separate stop needed.
    if (this.mode === 'phone') this.phone.stop()
    this.confirmed = false
    this.lastIdleText = ''
    this.story = story
    this.onEnd = onEnd
    this.state = PlaybackState.playing
    this.positionS = 0
    if (!this.connected) return this.fallBackToPhone(0)
    this.mode = 'pet'
    const send = async () => {
      // Arrival first: the pet announces the new place for a moment before the story,
      // so the audio doesn't start out of nowhere.
      if (this.announceArrival) {
        await this.link.write('nowShowing', encodeNowShowing(story.icon_id, `You've arrived at ${story.place}`, 'A story starts in a moment'))
        await this.link.write('haptic', encodeHaptic(Haptic.short))
        await new Promise((r) => setTimeout(r, ARRIVAL_MS))
        if (this.story !== story || this.mode !== 'pet') return // skipped or stopped meanwhile
      }
      await this.link.write('nowShowing', encodeNowShowing(story.icon_id, story.place, story.title))
      await this.link.write('play', encodePlay(story.id))
    }
    send().catch(() => {
      if (this.story === story && this.mode === 'pet') this.fallBackToPhone(0)
    })
  }

  pause() {
    if (this.mode === 'phone') return this.phone.pause()
    if (this.mode === 'pet') {
      this.state = PlaybackState.paused
      void this.link.write('transport', encodeTransport(Transport.pause)).catch(() => {})
    }
  }

  resume() {
    if (this.mode === 'phone') return this.phone.resume()
    if (this.mode === 'pet') {
      this.state = PlaybackState.playing
      void this.link.write('transport', encodeTransport(Transport.resume)).catch(() => {})
    }
  }

  stop() {
    if (this.mode === 'phone') this.phone.stop()
    if (this.mode === 'pet' && this.connected) {
      void this.link.write('transport', encodeTransport(Transport.stop)).catch(() => {})
    }
    this.mode = 'idle'
    this.story = null
    this.onEnd = null
  }

  /**
   * Between stories: what the pet's screen should say (where you are). Only when nothing
   * is playing, and only when the words change, to keep Bluetooth traffic down.
   */
  private lastIdleText = ''
  showIdle(place: string, line: string) {
    if (this.mode !== 'idle' || !this.connected) return
    const text = `${place}|${line}`
    if (text === this.lastIdleText) return
    this.lastIdleText = text
    void this.link.write('nowShowing', encodeNowShowing(0, place, line)).catch(() => {})
  }

  /**
   * A story is on offer (the app's pop-up): the pet reacts (heart eyes) and says so, and a
   * press of its play button (KEY3, sent as a pat) means Listen. Only between stories; a playing story keeps its own screen.
   */
  showOffer(story: Story) {
    if (this.mode !== 'idle' || !this.connected) return
    const text = `offer|${story.id}`
    if (text === this.lastIdleText) return
    this.lastIdleText = text
    void this.link
      .write('nowShowing', encodeNowShowing(story.icon_id, story.place, 'Story here. Press play to listen'))
      .then(() => this.link.write('haptic', encodeHaptic(Haptic.short)))
      .catch(() => {})
  }

  position(): PlaybackPosition {
    if (this.mode === 'phone') return this.phone.position()
    return {
      currentS: this.positionS,
      durationS: this.story?.duration_s ?? 0,
      paused: this.state === PlaybackState.paused,
      hasAudio: true,
      onPet: true,
    }
  }

  private handlePlayback(state: PlaybackStateValue, positionS: number) {
    if (this.mode !== 'pet') return
    if (state === PlaybackState.missingFile) return this.fallBackToPhone(0)
    if (state === PlaybackState.idle && !this.confirmed) return
    if (state !== PlaybackState.idle) this.confirmed = true
    this.state = state
    this.positionS = positionS
    if (state === PlaybackState.idle) this.finish()
  }

  private fallBackToPhone(offsetS: number) {
    const story = this.story
    if (!story || !this.onEnd) return
    this.mode = 'phone'
    this.phone.play(story, () => this.finish(), offsetS)
  }

  private finish() {
    const done = this.onEnd
    this.mode = 'idle'
    this.story = null
    this.onEnd = null
    this.state = PlaybackState.idle
    done?.()
  }
}
