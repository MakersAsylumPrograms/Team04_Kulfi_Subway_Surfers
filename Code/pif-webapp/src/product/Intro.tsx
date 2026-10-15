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
      {/* One column on phones; on wide screens the story on the left, how-to on the right. */}
      <div className="mx-auto grid min-h-full max-w-md content-center gap-x-16 px-5 pt-10 pb-8 sm:max-w-xl sm:px-8 sm:pt-16 lg:max-w-6xl lg:grid-cols-[1.15fr_1fr] lg:px-12 lg:py-16">
        <div>
          <h1 id="intro-title" className="jam-headline jam-title">
            You're only here because <span className="text-[var(--accent)]">the traffic isn't moving.</span>
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
          <h2 className="jam-headline mt-10 text-3xl sm:text-4xl lg:mt-0">How it works</h2>
          <ol className="mt-3 space-y-3 text-base leading-relaxed sm:text-lg">
            <Step n={1}>Put your earphones in and tap Start journey.</Step>
            <Step n={2}>
              Keep this page open with the screen on, like a music player. Phones stop sharing location when the
              screen sleeps, so Jam keeps it awake for you.
            </Step>
            <Step n={3}>When you pass a place with a story, it plays. About 40 seconds, once per journey.</Step>
          </ol>

          <h2 className="jam-headline mt-9 text-3xl sm:text-4xl">The pet</h2>
          <p className="mt-3 text-base leading-relaxed sm:text-lg">
            Jam has a small companion you can carry. It plays the stories through its own headphone jack and shows
            where you are on its screen.{' '}
            {hasWebBluetooth
              ? 'If you have one, tap Pair pet on the map.'
              : 'Pairing it needs Chrome on Android or a computer, so it isn’t available in this browser.'}{' '}
            You don't need one: the app works fully on its own.
          </p>

          <p className="mt-7 text-sm leading-relaxed text-[var(--muted)]">
            No sign-up. Your location never leaves your phone.
          </p>

          <button
            type="button"
            onClick={onClose}
            className="font-display mt-6 w-full rounded-2xl bg-[var(--accent)] py-5 text-xl font-bold text-[var(--on-accent)] active:scale-[0.99]"
          >
            Let the city talk
          </button>
        </div>
      </div>
    </div>
  )
}

function Step(props: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="jam-headline w-5 shrink-0 text-2xl leading-7 text-[var(--accent)] sm:leading-8">{props.n}</span>
      <span>{props.children}</span>
    </li>
  )
}
