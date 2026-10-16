import { useEffect, useState, type ReactNode } from 'react'
import { hasWebBluetooth } from '../pet/link'
import mascot from './assets/jam-mascot.svg'
import wordmark from './assets/jam-wordmark.svg'

// The first thing a new visitor sees: a splash with the mascot and the JAM wordmark, which
// fades by itself after a moment (or on a tap) into what Jam is, how to use it, and what the pet is. Shown once per device (see
// useIntro); the "?" button on the map opens it again, straight on the second part.

const SPLASH_MS = 2000 // how long the splash stays before fading
const FADE_MS = 800 // keep in step with .jam-fade in index.css

export function Intro(props: { onClose: () => void; splash?: boolean }) {
  const { onClose } = props
  // 'splash' -> 'fading' (both drawn, splash fading out) -> 'about'
  const [stage, setStage] = useState<'splash' | 'fading' | 'about'>(props.splash ? 'splash' : 'about')
  useEffect(() => {
    if (stage === 'about') return
    const t = setTimeout(() => setStage(stage === 'splash' ? 'fading' : 'about'), stage === 'splash' ? SPLASH_MS : FADE_MS)
    return () => clearTimeout(t)
  }, [stage])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="intro-title"
      className="jam-intro fixed inset-0 z-[1100] overflow-y-auto"
    >
      {stage !== 'about' && <Splash fading={stage === 'fading'} onStart={() => setStage('fading')} />}

      {/* One column on phones; on wide screens the story on the left, how-to on the right. */}
      <div
        aria-hidden={stage === 'splash'}
        className={`jam-fade mx-auto grid min-h-full max-w-md content-center gap-x-16 px-5 pt-10 pb-8 sm:max-w-xl sm:px-8 sm:pt-16 lg:max-w-6xl lg:grid-cols-[1.15fr_1fr] lg:px-12 lg:py-16 ${stage === 'splash' ? 'opacity-0' : 'opacity-100'}`}
      >
        <div>
          <h1 id="intro-title" className="jam-headline jam-title text-[var(--intro-pink)]">
            You're only here because the traffic isn't moving.
          </h1>
          <div className="mt-6 space-y-5 text-lg leading-relaxed sm:text-xl">
            <p>
              And that's okay. The signal at Mahim has been red for six minutes, your local is “arriving shortly”, and
              there's only so much scrolling one thumb can take.
            </p>
            <p>
              So here's a thought. While you're stuck anyway, let the city talk. Every lane you crawl past has a story:
              a mill that became a mall, a film shot on this very bridge, a vada pav stall older than your parents. We
              play it the moment you're near it.
            </p>
          </div>
        </div>

        <div className="lg:self-end">
          <h2 className="jam-headline mt-10 text-3xl text-[var(--intro-pink)] sm:text-4xl lg:mt-0">How it works</h2>
          <ol className="mt-3 space-y-3 text-base leading-relaxed sm:text-lg">
            <Step n={1}>Put your earphones in and let Jam see your location.</Step>
            <Step n={2}>
              Keep this page open with the screen on, like a music player. Phones stop sharing location when the
              screen sleeps, so Jam keeps it awake for you.
            </Step>
            <Step n={3}>
              When you reach a place with a story, it pops up. Tap Listen, or Later to keep it in your queue. Places
              you pass while listening play next on their own.
            </Step>
          </ol>

          <h2 className="jam-headline mt-9 text-3xl text-[var(--intro-pink)] sm:text-4xl">The pet</h2>
          <p className="mt-3 text-base leading-relaxed sm:text-lg">
            Jam has a small companion you can carry. It plays the stories through its own headphone jack and shows
            where you are on its screen.{' '}
            {hasWebBluetooth
              ? 'If you have one, tap Pair pet on the map.'
              : 'Pairing it needs Chrome on Android or a computer, so it isn’t available in this browser.'}{' '}
            You don't need one: the app works fully on its own.
          </p>

          {/* <p className="mt-7 text-sm leading-relaxed text-[var(--muted)]">
            No sign-up. Your location never leaves your phone.
          </p> */}

          <button
            type="button"
            onClick={onClose}
            className="jam-cta mt-8 h-16 w-full rounded-full text-lg font-semibold active:scale-[0.99]"
          >
            Let the city talk
          </button>
        </div>
      </div>
    </div>
  )
}

/** Mascot, wordmark and tagline. Fades into the rest of the intro by itself; a tap skips ahead. */
function Splash(props: { fading: boolean; onStart: () => void }) {
  return (
    <div
      onClick={props.onStart}
      className={`jam-fade fixed inset-0 z-10 flex flex-col items-center justify-center overflow-y-auto bg-[var(--intro-bg)] px-6 py-10 text-center ${props.fading ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
    >
      <img src={mascot} alt="" draggable={false} className="jam-bob w-[clamp(170px,52vw,280px)] select-none" />
      <img
        src={wordmark}
        alt="Jam"
        draggable={false}
        className="mt-6 h-[clamp(84px,20vw,128px)] w-auto select-none"
      />
      <p className="mt-6 text-[clamp(2rem,9vw,2.75rem)] leading-[1.1] font-bold tracking-tight">
        Real stories
        <br />
        on the Go.
      </p>
      <p className="mt-3 text-base opacity-90 sm:text-lg">Curated ideas, stories &amp; perspectives</p>
    </div>
  )
}

function Step(props: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="jam-headline w-5 shrink-0 text-2xl leading-7 text-[var(--intro-pink)] sm:leading-8">
        {props.n}
      </span>
      <span>{props.children}</span>
    </li>
  )
}
