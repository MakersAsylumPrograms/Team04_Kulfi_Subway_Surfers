import { useState } from 'react'

// Whether the first-visit intro is open. Opens until the visitor closes it once on this device.
const KEY = 'pif.intro.v1'

export function useIntro() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== 'seen'
    } catch {
      return true
    }
  })
  const close = () => {
    setOpen(false)
    try {
      localStorage.setItem(KEY, 'seen')
    } catch {
      // no storage: it shows again next visit, which is fine
    }
  }
  return { open, show: () => setOpen(true), close }
}
