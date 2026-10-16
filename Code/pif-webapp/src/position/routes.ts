// Paths the simulator can travel, on foot or by any transport. Station coordinates are approximate
// (good to ~100 m), which is fine for a demo: stories have 350 m+ radii.
// Triggering is place-based, so a route is just a path; the pace is picked separately.

export interface RoutePoint {
  name: string
  lat: number
  lng: number
}

export interface Route {
  id: string
  name: string
  points: RoutePoint[]
}

export const routes: Route[] = [
  {
    id: 'walk-bandra-mahim',
    name: 'Walk: Bandra station to Mahim, over the causeway',
    points: [
      { name: 'Bandra station', lat: 19.0544, lng: 72.8402 },
      { name: 'S.V. Road', lat: 19.052, lng: 72.8385 },
      { name: 'Causeway, Bandra end', lat: 19.047, lng: 72.8378 },
      { name: 'Causeway, Mahim end', lat: 19.0425, lng: 72.8385 },
      { name: 'Mahim Dargah', lat: 19.0405, lng: 72.8395 },
    ],
  },
  {
    id: 'western-churchgate-bandra',
    name: 'Train: Churchgate to Bandra (Western line)',
    points: [
      { name: 'Churchgate', lat: 18.9353, lng: 72.8274 },
      { name: 'Marine Lines', lat: 18.9447, lng: 72.8239 },
      { name: 'Charni Road', lat: 18.9518, lng: 72.8187 },
      { name: 'Grant Road', lat: 18.9633, lng: 72.816 },
      { name: 'Mumbai Central', lat: 18.9697, lng: 72.8195 },
      { name: 'Mahalaxmi', lat: 18.9827, lng: 72.824 },
      { name: 'Lower Parel', lat: 18.996, lng: 72.8302 },
      { name: 'Prabhadevi', lat: 19.0083, lng: 72.8358 },
      { name: 'Dadar', lat: 19.0183, lng: 72.8432 },
      { name: 'Matunga Road', lat: 19.0277, lng: 72.8466 },
      { name: 'Mahim', lat: 19.041, lng: 72.84 },
      { name: 'Bandra', lat: 19.0544, lng: 72.8406 },
    ],
  },
  {
    id: 'central-csmt-sion',
    name: 'Train: CSMT to Sion (Central line)',
    points: [
      { name: 'CSMT', lat: 18.9398, lng: 72.8355 },
      { name: 'Masjid', lat: 18.9515, lng: 72.838 },
      { name: 'Sandhurst Road', lat: 18.9613, lng: 72.8394 },
      { name: 'Byculla', lat: 18.9767, lng: 72.8327 },
      { name: 'Chinchpokli', lat: 18.9866, lng: 72.8329 },
      { name: 'Currey Road', lat: 18.9944, lng: 72.8335 },
      { name: 'Parel', lat: 19.009, lng: 72.8378 },
      { name: 'Dadar', lat: 19.0183, lng: 72.8432 },
      { name: 'Matunga', lat: 19.0275, lng: 72.855 },
      { name: 'Sion', lat: 19.047, lng: 72.863 },
    ],
  },
]

/** The /showcase demo ride: Dadar, through Prabhadevi and Worli, ending at the Nehru Centre. */
export const showcaseRoute: Route = {
  id: 'showcase-dadar-nehru',
  name: 'Ride: Dadar to the Nehru Centre, through Worli',
  points: [
    { name: 'Dadar station', lat: 19.0183, lng: 72.8432 },
    { name: 'Ranade Road', lat: 19.02, lng: 72.8395 },
    { name: 'Gokhale Road', lat: 19.0172, lng: 72.835 },
    { name: 'Siddhivinayak Temple', lat: 19.017, lng: 72.8302 },
    { name: 'Prabhadevi', lat: 19.014, lng: 72.8255 },
    { name: 'Worli Naka', lat: 19.0115, lng: 72.8185 },
    { name: 'Annie Besant Road', lat: 19.0035, lng: 72.8168 },
    { name: 'Poonam Chambers', lat: 18.9985, lng: 72.8162 },
    { name: 'Nehru Centre', lat: 18.9881, lng: 72.8156 },
  ],
}
routes.push(showcaseRoute)
