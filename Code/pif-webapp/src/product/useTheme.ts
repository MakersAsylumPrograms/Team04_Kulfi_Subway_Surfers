import { useEffect, useState } from 'react'

export type ThemeChoice = 'auto' | 'light' | 'dark'
// v2: everyone starts on light again (the default used to follow the phone).
const KEY = 'pif.theme.v2'

function systemDark() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

/** Light (the default, whatever the phone is set to), dark, or follow the phone. Remembered on this device. */
export function useTheme(options: { lightOnly?: boolean } = {}) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => {
    try {
      const saved = localStorage.getItem(KEY)
      if (saved === 'light' || saved === 'dark' || saved === 'auto') return saved
    } catch {
      // no storage
    }
    return 'light'
  })
  const [sysDark, setSysDark] = useState(systemDark)

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = () => setSysDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // lightOnly pins light whatever was saved; the choice is kept for when the button returns.
  const dark = !options.lightOnly && (choice === 'dark' || (choice === 'auto' && sysDark))

  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a0b0c' : '#f4f3ef')
  }, [dark])

  const setChoice = (c: ThemeChoice) => {
    setChoiceState(c)
    try {
      localStorage.setItem(KEY, c)
    } catch {
      // ignore
    }
  }
  // One button cycles: light, then dark, then follow the phone.
  const cycle = () => setChoice(choice === 'light' ? 'dark' : choice === 'dark' ? 'auto' : 'light')

  return { choice, dark, cycle }
}
