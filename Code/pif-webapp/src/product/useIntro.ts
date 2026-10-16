import { useState } from 'react'

// Whether the first-visit intro is open. Opens until the visitor closes it once on this device.
// firstVisit: opened by itself on load (starts on the splash), not from the "?" button.
const KEY = 'pif.intro.v1'

export function useIntro() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== 'seen'
    } catch {
      return true
    }
  })
  const [firstVisit, setFirstVisit] = useState(open)
  const close = () => {
    setOpen(false)
    setFirstVisit(false)
    try {
      localStorage.setItem(KEY, 'seen')
    } catch {
      // no storage: it shows again next visit, which is fine
    }
  }
  return { open, firstVisit, show: () => setOpen(true), close }
}
