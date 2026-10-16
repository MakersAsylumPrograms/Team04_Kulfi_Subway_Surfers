import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ProductApp } from './product/ProductApp.tsx'
import { LazyPetLab } from './lab/LazyPetLab.tsx'
import { LazyMediaDashboard } from './lab/LazyMediaDashboard.tsx'

// Faces of one app, no router library: /debug is the testing tool (simulation, showcase
// marking, pet test panel), /lab is the pet screen lab (try pictures and videos on the
// pet's display), /media is the pet media dashboard (videos on its SD card), /showcase is the
// visitor app on a simulated ride (for demos), and everything else is what visitors see.
const path = window.location.pathname.replace(/\/+$/, '')
const isDebug = path.endsWith('/debug')
const isLab = path.endsWith('/lab')
const isMedia = path.endsWith('/media')
const isShowcase = path.endsWith('/showcase')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isMedia ? (
      <Suspense fallback={null}>
        <LazyMediaDashboard />
      </Suspense>
    ) : isLab ? (
      <Suspense fallback={null}>
        <LazyPetLab />
      </Suspense>
    ) : isDebug ? (
      <App />
    ) : (
      <ProductApp showcase={isShowcase} />
    )}
  </StrictMode>,
)
