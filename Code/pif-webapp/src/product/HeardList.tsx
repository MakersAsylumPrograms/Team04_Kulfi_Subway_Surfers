import { useEffect, useState } from 'react'
import type { Story } from '../data/types'
import type { HeardEntry } from './useHeard'

// The heard collection as a sheet over the map: newest first, each with Play again and the
// full text to read. Replaying works anywhere; you don't need to be at the place.

function when(at: number) {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export function HeardList(props: {
  entries: HeardEntry[]
  stories: readonly Story[]
  playingId: string | null
  onPlay: (story: Story) => void
  onClose: () => void
}) {
  const { onClose } = props
  const [readingId, setReadingId] = useState<string | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const byId = new Map(props.stories.map((s) => [s.id, s]))
  const items = [...props.entries]
    .reverse()
    .flatMap((e) => {
      const story = byId.get(e.id)
      return story ? [{ story, at: e.at }] : []
    })

  return (
    <div className="fixed inset-0 z-[1050] flex items-end bg-black/30" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="heard-title"
        onClick={(e) => e.stopPropagation()}
        className="jam-pop mx-auto flex max-h-[80dvh] w-full max-w-md flex-col rounded-t-3xl bg-[var(--surface)] shadow-[0_-8px_30px_rgba(0,0,0,0.18)]"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 id="heard-title" className="font-display text-xl font-bold">
            Heard <span className="text-[var(--muted)]">· {items.length}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-11 w-11 place-items-center rounded-full text-2xl text-[var(--muted)] active:scale-95"
          >
            ×
          </button>
        </div>

        {items.length === 0 ? (
          <p className="px-5 pb-8 text-base leading-relaxed text-[var(--muted)]">
            Stories you listen to collect here, so you can play them again anywhere.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--line)] overflow-y-auto px-5 pb-6">
            {items.map(({ story, at }) => {
              const playing = story.id === props.playingId
              const reading = readingId === story.id
              return (
                <li key={story.id} className="py-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{story.place}</p>
                      <p className="truncate text-sm text-[var(--muted)]">{story.title}</p>
                      <p className="mt-0.5 text-xs text-[var(--muted)]">{when(at)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReadingId(reading ? null : story.id)}
                      aria-pressed={reading}
                      className="h-11 shrink-0 rounded-xl px-3 text-sm font-semibold text-[var(--muted)] active:scale-95"
                    >
                      {reading ? 'Hide' : 'Read'}
                    </button>
                    <button
                      type="button"
                      onClick={() => props.onPlay(story)}
                      disabled={playing}
                      className="h-11 shrink-0 rounded-xl bg-[var(--accent)] px-4 text-sm font-bold text-[var(--on-accent)] active:scale-95 disabled:opacity-60"
                    >
                      {playing ? 'Playing' : 'Play again'}
                    </button>
                  </div>
                  {reading && (
                    <div className="mt-2 rounded-xl bg-[var(--surface-2)] p-3 text-sm leading-relaxed">
                      {story.text}
                      {story.source && (
                        <a
                          href={story.source}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 block text-xs text-[var(--muted)] underline"
                        >
                          Source
                        </a>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
