import { useEffect, type ReactNode } from 'react'
import { hasWebBluetooth } from '../pet/link'

// The first thing a new visitor sees: what Jam is, how to use it, and what the pet is.
// Shown once per device (see useIntro), and again from the "?" button on the map.

export function Intro(props: { onClose: () => void }) {
  const { onClose } = props
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
      <div className="mx-auto flex min-h-full max-w-md flex-col px-6 pt-12 pb-8">
        <h1 id="intro-title" className="jam-headline text-[3.4rem] leading-[0.95]">
          You're only here because the traffic isn't moving.
        </h1>

        <div className="mt-7 space-y-5 text-lg leading-relaxed">
          <p>
            And that's okay. The signal at Mahim has been red for six minutes, your local is “arriving shortly”, and
            there's only so much scrolling one thumb can take.
          </p>
          <p>
            So here's a thought. While you're stuck anyway, let the city talk. Every lane you crawl past has a story: a
            mill that became a mall, a film shot on this very bridge, a vada pav stall older than your parents. We play
            it the moment you're near it.
          </p>
        </div>

        <h2 className="jam-headline mt-10 text-3xl">How it works</h2>
        <ol className="mt-3 space-y-3 text-base leading-relaxed">
          <Step n={1}>Put your earphones in and tap Start journey.</Step>
          <Step n={2}>
            Keep this page open with the screen on, like a music player. Phones stop sharing location when the screen
            sleeps, so Jam keeps it awake for you.
          </Step>
          <Step n={3}>When you pass a place with a story, it plays. About 40 seconds, once per journey.</Step>
        </ol>

        <h2 className="jam-headline mt-10 text-3xl">The pet</h2>
        <p className="mt-3 text-base leading-relaxed">
          Jam has a small companion you can carry. It plays the stories through its own headphone jack and shows where
          you are on its screen.{' '}
          {hasWebBluetooth
            ? 'If you have one, tap Pair pet on the map.'
            : 'Pairing it needs Chrome on Android or a computer, so it isn’t available in this browser.'}{' '}
          You don't need one: the app works fully on its own.
        </p>

        <p className="jam-muted mt-8 text-sm leading-relaxed">
          No sign-up. Your location never leaves your phone.
        </p>

        <button
          type="button"
          onClick={onClose}
          className="jam-cta jam-headline mt-8 w-full rounded-2xl py-4 text-3xl active:scale-[0.99]"
        >
          Let the city talk
        </button>
      </div>
    </div>
  )
}

function Step(props: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="jam-headline jam-pink w-5 shrink-0 text-2xl leading-7">{props.n}</span>
      <span>{props.children}</span>
    </li>
  )
}
