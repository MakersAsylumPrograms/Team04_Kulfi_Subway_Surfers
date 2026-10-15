# Feature list

> What the product does, screen by screen, with status. The *why* lives in
> [AGENTS.md](../AGENTS.md), the *how* in [ARCHITECTURE.md](./ARCHITECTURE.md), and the pet's
> bytes in [PET-PROTOCOL.md](./PET-PROTOCOL.md). Status: ✅ built · 🟡 partly · ⬜ not yet.
> Items marked **DECIDE** need a call from the team before building.

Last updated: 2026-10-03.

---

## 1. The idea in one line

You hear a 40-second story when you are physically near a place, however you got there,
and your map slowly fills in with the places you have actually been.

---

## 2. The unlock model (DECIDE)

The question: *if I'm in Mumbai, can I listen to the whole city?* Three layers answer it.
Each has its own radius.

| Layer | What it controls | Radius | Recommended rule |
|---|---|---|---|
| **Hear** | When a story plays for the first time | the story's own `radius_m` (about 350 m) | Only when you are physically there. Never remotely. This is the product. |
| **Reveal** | Which parts of the map lose their fog | about **500 m** either side of your path | Fog clears along where you have actually travelled, in small map cells, saved on your phone. |
| **Collect** | What you can replay later | none, it's your history | A story you have heard is yours: replay it anywhere, any time. |

So the answer is **no, you can't listen to the whole city.** You hear what you pass, you
see what's around where you've been, and you keep what you've heard.

**What the map shows inside revealed areas:**
- Stories you've heard: solid pins. Tap to replay and read.
- Stories you haven't heard yet: visible but locked pins ("go there to hear it"). This
  gives a reason to take a different road home, without points or streaks.
- Outside revealed areas: fog, no pins. Nothing is spoiled.

**Alternatives considered:**
- *Whole city open:* turns it into an audio guide you browse from your sofa. Loses the point.
- *Hear only, no map memory:* simplest, but nothing accumulates, so there's little reason to open the app again.
- *Reveal radius tied to the story radius:* too small (350 m) to feel like exploring on a map.

**Open sub-questions:** should locked pins show the title, or only that *something* is
there? (Recommended: place name only, title after hearing.) Should fog be per person
only? (Yes, it never leaves the phone. No accounts, per AGENTS.md.)

---

## 2b. Showcase mode (built 2026-10-04)

For the showcase, three spots in the venue become the three story places.

- **Showcase places** on the Start screen: stand at a spot, tap **Mark here**. The app listens to GPS for 8 seconds, averages the most accurate fixes, and saves that as the story's position with a 10, 15, 25 or 40 m radius. Saved on the device (`src/data/places.ts`, `usePlaces.ts`, `ShowcaseSetup.tsx`). Overrides `stories.json` coordinates only on that device.
- Warns when two places' circles overlap, or when a mark was less accurate than its radius.
- Once two or more are marked, the simulator gets a **Walk: through the showcase places** route to rehearse indoors.
- The map zooms to street level (zoom 18) when any story radius is 50 m or less.
- **Limit:** phone GPS indoors is often only good to 10 to 50 m. Spots should be 50 m or more apart, ideally outdoors or near windows.

## 2c. Visitor version at / (built 2026-10-04)

`src/product/`. Full-screen map with the current place in a card at the top, theme and pet buttons top right, and one bottom sheet that follows the journey: Start journey, then Listening (next story and distance, End journey), then Now playing (place, title, progress, Pause, Skip, Read for the full text and source). Real GPS only, positions from `stories.json`.

- **Themes:** light keeps the OpenStreetMap colours; dark turns the same tiles into a charcoal sketch with a CSS filter. Follows the phone by default; the top-right button cycles auto, light, dark (remembered). One accent: the pet's cyan (deeper teal on light for sunlight).
- **Type:** Space Grotesk (Google Fonts) for place names and buttons.
- `/debug` keeps the full testing tool.
- **First-visit intro** (2026-10-15, `src/product/Intro.tsx`): the team's "You're only here because the traffic isn't moving" copy in teal, pink and Bebas Neue, then how it works, what the pet is (with the Android Chrome note where Bluetooth is missing) and a privacy line. Shown once per device (`pif.intro.v1`), reopened from the **?** button on the map.

## 2d. Pet screen lab at /lab (built 2026-10-06)

A page for trying pictures, frame animations, sprite sheets and videos on an exact stand-in
for the pet's 240x320 screen. It covers portrait and landscape, size, alignment, nudge,
rotation, the white-background removal, colour mode (full 16-bit, 16 colours, cyan only), fps
and the "Jam" name. It estimates flash space and drawing time on the board, and
"Copy these settings" hands the exact choice to whoever converts it for the firmware. Code:
`src/lab/` (loaded only on /lab).

**Screens** (`src/lab/screens.ts`): draft portrait designs for every pet screen (startup,
waiting, idle, arrival, now playing, paused, volume, not on card, sleeping), drawn with the
pet's own Adafruit fonts (`src/lab/gfxFonts.json`, from `scripts/convert-gfx-fonts.mjs`) so
they match the firmware pixel for pixel. Chosen designs get ported to `pet_screen.h`.

**Layers** (`src/lab/layers.ts`): your own pictures (several at once = an animated layer, white
background removable) and text in the pet's fonts, on top of any screen or media; drag on the
preview to move, arrow keys to nudge, order/hide/delete in the list. A Blank screen starts from
nothing.

**Clips: play on the pet** (`src/lab/clip.ts`, `src/lab/audio.ts`, firmware `pet_lab.h`): a stretch of
the lab's timeline (frames in/out, scrubber, fps, loop/once/back-and-forth), whatever the preview
shows including layers, plus optional sound (any audio file, or a video's own track; trim, offset
in ms, sample rate, volume), sent once over USB into the pet's PSRAM and played by the pet at full
speed with the sound in sync. Only the part of the screen that changes is stored per frame
(16-bit, or a 256/64/16-colour palette, run-length coded when smaller). fps, play mode, sound
offset and volume change on the pet while it plays ("lab fps|mode|offset|vol"); USB speed
("lab baud", falls back by itself) and display SPI speed ("lab spi") are set from the lab too.
"Preview here" plays the same timing and the same resampled sound in the browser.

**Live on the pet** (`src/lab/petSerial.ts`): with the pet on USB, Chrome/Edge send the lab's
screen to the real panel over Web Serial at 921600 baud. Only changed row pieces are sent, run-
length coded when smaller; each frame waits for the pet's "LABOK". The pet's side is "Lab mode" in
`pet_screen.h`; it ends with "lab off" or 15 s after the last frame. On connect the lab restarts the
pet (RTS pulse), waits for "Ready", then sends "lab hello" and expects "LABHELLO tft"; no answer
means old firmware or a wrong baud rate, and the lab says so.

Startup animation: tried with a crane sprite (2026-10-06), then taken out of the firmware;
`scripts/convert-crane.mjs` and `src/pet/crane.json` stay for the lab's Crane source and Startup design.

## 2e. Pet media dashboard at /media (built 2026-10-06)

The simple way to play video and animation on the pet. Format: **MJPEG + WAV on the SD card**
(`/media/<name>.mjpeg`, `.wav`, `.cfg`), the usual choice for ESP32 screens: full colour, small
files (the sky video is 144 KB at 240 wide, 15 fps), decoded by the JPEGDEC library. The video
loads into PSRAM, the sound streams from the card, and the sound is the clock (late frames are
skipped, so picture and sound stay together). GIF was considered: 256 colours, slower to decode,
no sound.

The dashboard lists what's on the card, plays/stops it, and changes loop, fps, sound sync,
volume, size on the screen (actual, fit, fill/crop, stretch: the pet scales each frame as it draws
it) and which way up while it plays, with the pet's own report of decode time and skipped frames. "Add a video
or animation" converts a video (or a set of pictures) in the browser (width, fps, JPEG quality,
trim, sound on/off and rate, upright/sideways, position, loop) and sends it over USB, or
downloads the files for a card reader; the matching ffmpeg commands are shown too. Code:
`src/lab/MediaDashboard.tsx`, `src/lab/convert.ts`; pet side `pet_media.h`.

## 3. Screens

### 3.1 Home (map-first): proposed, replaces today's Start screen

| Feature | Status |
|---|---|
| **"You are at / near …"** card, above the map | 🟡 on the journey screen only; move to home |
| **Map** centred on you | 🟡 journey screen only |
| **Fog** over unvisited areas, clearing as you travel (section 2) | ⬜ |
| **Pins** for stories in revealed areas: heard (replayable) and locked | 🟡 circles appear within 2 km during a journey; no persistence yet |
| **Start journey** button, big, bottom of the screen | ✅ (on Start screen) |
| Pet status chip (connected / not) | 🟡 a card on the Start screen |
| Settings tucked behind one button: simulation, route, pace, noisy GPS, fake pet | 🟡 they're on the Start screen today |

### 3.2 Journey (travel mode, switched on)

| Feature | Status |
|---|---|
| Current place on top of the map | ✅ |
| Your path drawn on the map | ✅ |
| Now-playing card: place, title, progress, text, source | ✅ |
| Pause / Resume, Skip | ✅ |
| Screen kept awake during a journey | ✅ |
| "Simulated" badge, live pace and noise controls | ✅ |
| Queue of one when stories overlap | ✅ |
| Clear messages when location is denied or weak | ⬜ |
| Fog clears live as you move | ⬜ |

### 3.3 Heard (your collection)

| Feature | Status |
|---|---|
| Every story you've heard, across journeys, saved on the phone | ⬜ |
| Replay, read the text, open the source | ⬜ |
| Tapping a heard pin on the map opens it | ⬜ |

---

## 4. Story playback

| Feature | Status |
|---|---|
| Place-based trigger, any transport | ✅ |
| Fire once per journey, two-fix noise rule | ✅ |
| Start journey unlocks audio (browser rule) | ✅ |
| MP3 playback, text-only fallback if the file is missing | ✅ |
| Lock-screen title and place (Media Session) | ✅ |
| Real voice recordings | ⬜ placeholders now |
| Hide drafts (`approved: false`) in the public build | ⬜ |
| Story checker script for `stories.json` | ⬜ |

---

## 5. The pet

| Feature | Status |
|---|---|
| Bluetooth protocol defined | ✅ [PET-PROTOCOL.md](./PET-PROTOCOL.md) |
| Pair button (hidden on iPhone) | ✅ |
| Stories play on the pet, phone stays silent | ✅ app side |
| Phone takes over if the pet lacks the file or disconnects | ✅ |
| Pat = pause/resume, double-pat = skip | ✅ app side |
| Fake pet for testing without hardware | ✅ |
| **Test the pet** panel: play any story on the pet without a journey, pause/stop, see touches | ✅ |
| Firmware: display, face, SD playback, BLE | ⬜ see section 7 and HARDWARE.md build order |
| Pet-to-pet greeting | ⬜ later, behind a flag |

---

## 6. Connections: who talks to whom, and over what

```
            internet (only to load the app and map tiles)
                 |
   [ phone ] ----+
     | GPS  (phone's own; the pet has no GPS)
     | Bluetooth LE  (story id, transport, display text  ->  pet;  playback, touches  <-  pet)
     v
   [ pet: ESP32-A1S ]
     | I2S         -> ES8388 codec -> headphone jack (speech) / speaker amp (chirps)
     | I2C 33/32   -> codec control
     | SPI 18/23/5/19 -> 2.4" ST7789 colour display
     | SD          -> WAV files, copied with a card reader
     | GPIO 34/36  -> capacitive touch switch (pat), button (onboard KEY1)
     | power       -> USB, or the 3.7 V Li-ion battery
```

| Link | Used for | Notes |
|---|---|---|
| **GPS** | Where you are | The **phone's** GPS, read by the web app. The pet has none and never gets coordinates. |
| **Bluetooth LE** | Phone ↔ pet | Ids and small messages only, never audio. Later also pet ↔ pet greeting via advertising. |
| **Wi-Fi** | Nothing on the pet | Keep it off: it competes with Bluetooth for the same radio and can cause audio clicks. Files go onto the SD card with a card reader. The phone uses mobile data or Wi-Fi only to load the app and the map. |
| **Mobile data** | Loading the app, map tiles | Stories and audio are bundled, so a journey keeps working with patchy signal once loaded. |
| **I2S** | ESP32 → codec audio | Verified working. |
| **I2C** | Codec (an IMU could join later) | SDA 33, SCL 32. Verified for the codec. |
| **SPI** | ESP32 → display | Second SPI bus, pins 18, 23, 5, 19. See section 7. |

---

## 7. Assembling the pet from the parts you have

**Parts in the box (2026-10-03):**

| Part | What it is | Notes |
|---|---|---|
| ESP32-A1S Audio Kit v2.2 | the brain, codec, headphone jack, speaker amp, SD slot | see HARDWARE.md |
| [2.4" 240×320 TFT](https://probots.co.in/2-4-inch-240320-tft-lcd-colour-display-module-with-touch-spi-interface.html) | colour display over SPI, resistive touch, its own SD slot. The product page says ILI9341, but the group's working face code drives it as an **ST7789**, so treat it as ST7789 | replaces the round GC9A01 in HARDWARE.md and the 1.3" OLED |
| [3.7 V 950 mAh Li-ion](https://probots.co.in/lithium-ion-rechargeable-battery-3-7v-950mah-yb-503450.html) | flat cell, 50×34×5 mm, protection built in | 3-pin connector, see Power below |
| [4 Ω 3 W speaker (4070)](https://probots.co.in/rectangular-speaker-4070-4-ohm-3w-audio-driver.html) | for chirps and acknowledgements | speech still goes to the headphone jack |
| Capacitive touch switch | the "pat" pad; a self-contained module with a digital output | no ESP32 touch pin needed |
| Tactile buttons | extra inputs | |
| microSD card, wired earphones | | |

**Before soldering anything:** check which pins are actually brought out to the board's
headers (HARDWARE.md section 11 lists this as unverified). Everything below assumes the
pin is reachable.

### Display: ST7789 on the second SPI bus

The A1S already uses its first SPI-style pins for the SD card (2, 13, 14, 15). The display
goes on the ESP32's other SPI bus (VSPI), whose default pins are 18, 19, 23 and 5.

| Display pin | Wire to | Notes |
|---|---|---|
| VCC | 3.3 V | The module also takes 5 V. On battery, 3.3 V is what you have. |
| GND | GND | |
| SCK | GPIO **18** | |
| SDI (MOSI) | GPIO **23** | |
| CS | GPIO **5** | |
| DC (sometimes "RS") | GPIO **4** (planned) | **Tested 2026-10-04: DC on 19 does not work** (onboard KEY3's circuit sits on 19). 21 works but is the speaker amp enable, so it clashes once audio runs. Move DC to 4 before adding audio. |
| RESET | GPIO **22** (what the group wired), or the board's **EN** pin | 22 is the onboard LED pin; using it for reset is harmless (the LED blinks at boot). EN saves the pin. |
| LED (backlight) | 3.3 V | Always on to start. Later, a free pin with PWM can dim it to save battery. |
| SDO (MISO), all T_* touch pins, SD_* pins | **leave unconnected** | See below. |

- **Skip the display's resistive touch.** It needs a firm press (it's made for a stylus),
  costs two or three more pins, and the pet already has a pat pad and buttons. Skip the
  display's SD slot too; the board has its own.
- **Cost:** the common A1S docs put onboard keys KEY3 to KEY6 on 18, 19, 23 and 5. Using
  them for the display means **don't press those four onboard keys** (they would short a
  display line to ground). KEY1 (GPIO 36) stays usable. Verify on your board.
- **Firmware:** the group's face sketch uses **Adafruit_GFX + Adafruit_ST7789** and works, so keep that. Still
  avoid LVGL next to the audio pipeline. A full 240×320 frame is about 150 KB and takes
  roughly 30 ms over SPI, so during playback redraw only what changed (the progress bar,
  the text), as HARDWARE.md section 10 says.
- **Design change:** the screen is a rectangle now, not round. Use a progress bar or an arc
  instead of a progress ring around the rim. The fake pet in the app still draws a circle;
  update it when the face is designed.

### Inputs

| Part | Wire to | Notes |
|---|---|---|
| Capacitive touch switch VCC / GND | 3.3 V / GND | |
| Capacitive touch switch OUT | GPIO **34** | The module drives its own output, so an input-only pin is fine. This is the **pat** (and double-pat). |
| Tactile button | onboard **KEY1** (GPIO 36), or an external button wired across KEY1's contacts | GPIO 4 now goes to the display's DC. **Not 39:** the audio library uses 39 to detect headphones. 36 is input-only and KEY1 has its own pull-up. |
| Onboard KEY1 | already on GPIO 36 | A free extra button, no wiring. |

### Sound

| Part | Wire to | Notes |
|---|---|---|
| Speaker (4 Ω 3 W) | the board's speaker terminals | Onboard amp, enabled on GPIO 21 (untested). For chirps, not speech. |
| Earphones | the board's headphone jack | Speech. A train carriage is too loud for a small speaker. |
| microSD | the board's slot | Set DIP switches **DATA3 and CMD to ON** or the card won't mount. Files go in `/stories/<id>.wav`. |

### Power

- **Check whether your board has a battery connector** (usually a small 2-pin socket
  marked BAT near the USB port) and whether it charges from USB. Unverified on ours.
- **The battery's plug won't fit as-is.** It has a 3-pin connector (the third wire is
  usually a temperature sensor). Find + and − with a multimeter before connecting
  anything. **A reversed Li-ion cell can destroy the board.** Re-crimp or use an adapter so
  only + and − reach the board.
- **If the board has no charger,** add a TP4056 charging module with protection between
  the battery and the board.
- **Rough runtime:** the ESP32 with Bluetooth and audio plus the display backlight draws
  very roughly 150 to 250 mA, so 950 mAh gives about **3 to 5 hours**. That's an estimate;
  measure it. A dimmer backlight is the easiest saving.

### Pin budget after all of this

| Pins | Used by |
|---|---|
| 0, 25, 26, 27, 35 | audio (I2S) |
| 32, 33 | I2C to the codec |
| 2, 13, 14, 15 | SD card |
| 18, 23, 5, 4 | display (SCK, MOSI, CS, DC) |
| 19 | unusable for the display (KEY3 circuit); leave it |
| 34 | capacitive touch switch |
| 36 | button (onboard KEY1) |
| 39 | headphone detect (switches the speaker amp off when earphones go in) |
| 12 | line-in detect, and a boot strap pin |
| 36 | onboard KEY1 |
| 21 | speaker amp enable |
| 22 | onboard LED, shared with display RESET |
| 6 to 11, 16, 17 | flash and PSRAM, never usable |
| none | **No general-purpose pins left.** If you need one more, give up an onboard key you don't use (KEY1 on 36 is input-only). |

### Build and test in this order

Each step proves one thing before adding the next.
1. The display shows text and a colour fill, while the codec still answers at `0x10`.
2. Touch switch and button presses show up on the serial monitor.
3. A WAV plays from the SD card to the earphones.
4. The pet advertises over Bluetooth and nRF Connect can write `play` (PET-PROTOCOL.md).
5. Bluetooth and audio at the same time, with no stutter. This is the riskiest step.
6. The display updates during playback without clicks in the audio.
7. The web app drives it end to end.
8. Battery power, then the enclosure.
