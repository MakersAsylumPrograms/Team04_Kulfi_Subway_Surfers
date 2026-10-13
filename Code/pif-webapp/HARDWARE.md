# Hardware findings — ESP32-A1S Audio Kit ("the pet")

> Technical reference for coding agents working on firmware. Everything here was either
> **verified on our actual board** or **taken from docs and not yet tested** — the
> distinction is marked throughout, because this board has multiple revisions that look
> identical and most online advice applies to a different one than yours.

---

## 1. Board identity — VERIFIED

Ai-Thinker ESP32-A1S Audio Kit v2.2, bought from Probots (₹2,499).

| | |
|---|---|
| Chip | ESP32-D0WD-V3, rev 3.1, dual core, 240MHz |
| Flash | 4MB |
| PSRAM | Present, works (see section 3) |
| **Codec** | **ES8388** — responds at I2C **`0x10`** |
| **I2C pins** | **SDA 33, SCL 32** — the swapped order returns nothing |
| USB-serial | Onboard CP2102 |
| MAC | e0:8c:fe:64:1a:20 |

**There are at least four boards sold as "ESP32 Audio Kit."** Some ship an AC101 codec
(end-of-life, answers at `0x1A`), newer ones an ES8388, and there are multiple ES8388
revisions with *different I2S pin assignments*. Two of the best references online
disagree with each other on whether word-select is GPIO25 or GPIO26 — neither is wrong,
they describe different boards. **Never trust a pinout you find online without checking
it against this file.**

To re-verify on another board: I2C scan on 33/32. `0x10` or `0x11` → ES8388. `0x1A` → AC101.

---

## 2. Arduino settings

Two known-good configurations:

| Setting | Bring-up / debugging | Normal use |
|---|---|---|
| Board | ESP32 Dev Module | **ESP32 Wrover Module** |
| PSRAM | **Disabled** | Enabled (default on Wrover) |
| Flash size | 4MB | 4MB |
| Partition | Huge APP (3MB No OTA) | Huge APP |
| Upload speed | 921600 | 921600 |
| Monitor baud | 115200 | 115200 for the test sketches; **921600 for `pet_story_player`** (since 2026-10-06) |

There is **no "ESP32-A1S" entry in the board manager** and there never will be.

A wrong flash size causes boot loops on this board — the library maintainer warns about
this specifically. Keep it at 4MB.

---

## 3. PSRAM — VERIFIED, and it bit us

- **ESP32 Dev Module + PSRAM "Enabled" → the sketch hangs before `setup()` runs.** The
  symptom is the full bootloader log ending at `entry 0x400805b4` and then absolute
  silence. No panic, no reset loop, no output at all. Easy to misdiagnose as a broken
  serial monitor.
- **ESP32 Dev Module + PSRAM "Disabled" → works.**
- **ESP32 Wrover Module → works with PSRAM active.** This is the profile to use, because
  it knows where PSRAM lives on a WROVER-class module.

Audio playback was verified working on the Wrover profile, so PSRAM and the codec
coexist fine.

**You need PSRAM.** It is what buffers audio so SD card reads never starve the I2S feed.
Don't leave it disabled past bring-up.

---

## 4. The audio path — VERIFIED, and this is the headline finding

Getting sound out of this board requires **two** things that are easy to miss, and
missing either produces *identical* symptoms: a perfectly healthy log and total silence.

```cpp
#include "AudioTools.h"
#include "AudioTools/AudioLibs/AudioBoardStream.h"

AudioInfo info(32000, 2, 16);
SineGenerator<int16_t> sineWave(16000);
GeneratedSoundStream<int16_t> sound(sineWave);
AudioBoardStream out(AudioKitEs8388V1);     // (1) V1, NOT V2
StreamCopy copier(out, sound);

void setup() {
  Serial.begin(115200);
  AudioToolsLogger.begin(Serial, AudioToolsLogLevel::Info);

  auto config = out.defaultConfig(TX_MODE);
  config.copyFrom(info);
  out.begin(config);

  out.setVolume(0.5);                       // (2) THE EXAMPLE OMITS THIS

  sineWave.begin(info, N_B4);
}

void loop() { copier.copy(); }
```

**(1) `AudioKitEs8388V1`, not V2.** The library's bundled example
`streams-generator-audiokit` defaults to **V2**, which is silent on our board. V1 and V2
differ in I2S pin assignment — wrong pins means samples stream into unconnected GPIOs
while `StreamCopy` logs happily.

**(2) `setVolume()` is mandatory and the example never calls it.** The ES8388 comes up
attenuated. Without this line you get a correct-looking
`StreamCopy::copy 1024 -> 1024 -> 1024` log forever and hear nothing.

### Debugging silence

`StreamCopy` logging normally means the ESP32 half works and the problem is the codec.
Check in this order: V1 vs V2 → `setVolume` present → right jack (the board has **two**
3.5mm sockets, one is **line in**) → raise log level and read the lines between reset and
the first `StreamCopy` spam, which is where codec init reports.

### Two buses, two jobs

**I2C (33/32) carries control** — power the codec up, set routing, set volume.
**I2S carries the samples.** Get I2S right but never initialise the codec over I2C and
you get perfect silence with no error. This is what `arduino-audio-driver` exists to
handle.

---

## 5. Libraries

Both by Phil Schatzmann. Neither is in the Arduino Library Manager — download the repo
ZIP, extract into `Documents/Arduino/libraries/`, and **rename the folders to drop the
`-main` suffix** (Arduino is fussy about folder names).

- `arduino-audio-tools` — the audio framework
- `arduino-audio-driver` — codec drivers including ES8388. Replaces the older
  `arduino-audiokit` project, which is what most stale tutorials point at.

For BLE use **NimBLE-Arduino**, not the stock ESP32 BLE stack — much smaller, and flash
is tight next to an audio pipeline.

From the Library Manager: **NimBLE-Arduino**, **Adafruit ST7735 and ST7789 Library** (+ Adafruit
GFX), **JPEGDEC** by Larry Bank (video), and **U8g2** (only for the OLED test build).

**Prefer the library's bundled examples over hand-written sketches.** They are
version-matched to whatever you installed, which kills a whole class of API-drift
compile errors. Adapt them; don't write from scratch.

---

## 6. Pin map

The wiring as built, wire by wire: **[firmware/WIRING.md](./firmware/WIRING.md)**.

| Function | Pins | Status |
|---|---|---|
| I2C — codec control | SDA **33**, SCL **32** | **VERIFIED** |
| I2S — audio | MCLK **0**, BCK **27**, WS **25**, DOUT **26**, DIN **35** | From maintainer, consistent with working audio |
| SD card | CS **13**, MISO **2**, MOSI **15**, CLK **14**; DIP switches 2 and 3 ON | **VERIFIED** (mounts at up to 20 MHz on its own bus) |
| PA enable (speaker amp) | **21** | **VERIFIED** (speaker on ROUT) |
| Onboard LED | **22** | Now the display's DC line; the LED just flickers |
| Headphone detect | **39** | From the arduino-audio-driver V1 pin file |
| Onboard keys KEY1 to KEY6 | 36, 13, 19, 23, 18, 5 | **VERIFIED** with `firmware/key_check` (2026-10-05) |
| Display (ST7789 TFT, own SPI bus) | SCK **18**, MOSI **23**, CS **5**, DC **22**, RST → EN | **VERIFIED** |
| Extra button | MTDI (**12**) to 3.3 V, internal pull-down | **VERIFIED** (strapping pin: must be LOW at boot) |
| Input-only, cannot drive anything | 34, 35, 36, 39 | ESP32 hardware fact |

### Consequences

- **GPIO0 is the codec master clock AND the boot strap pin.** It is permanently gone,
  and it is why uploads sometimes need the BOOT key held (see section 8).
- **GPIO13 is shared between the SD card and KEY2.** You get the card or that button
  (DIP switch 1 OFF keeps the key off the card's line).
- **The display can't share the SD card's bus.** Tried on 2026-10-05 (display on MTMS/MTDO,
  i.e. the card's clock and command lines): the extra wiring made the card fail to mount or
  read. It's back on its own pins, which costs KEY4 (23) and KEY5 (18).
- **Only two onboard keys are free** (KEY1, KEY3); a third button lives on MTDI (12), wired
  to 3.3 V, because GPIO 12 sets the flash voltage at boot and must read LOW then.
- **No free analog (ADC) pin is broken out**, so a potentiometer for volume isn't possible
  without an external ADC; volume is a button (tap up, hold down).
- **Capacitive touch is unavailable**: every touch-capable pin that's broken out is taken.
- **The IMU can share the codec's I2C bus** — different address, zero extra pins (not on the
  headers, though).

---

## 7. Known board faults — from docs, UNTESTED on ours

- **Onboard mics dead from the factory on some units** — two capacitors missing or
  misplaced. Silence from the mic is a soldering fix, not a code fix.
- **The ADC button peripheral doesn't work** on most units; the resistor network isn't
  populated. Read the six buttons as plain GPIO.
- **DIP switches gate the SD card.** DATA3 and CMD must be ON or the card won't mount.
  Most "my SD is broken" reports are this.

---

## 8. Connection and upload — all VERIFIED the hard way

**The CP2102 is a separate chip from the ESP32**, powered off USB 5V. It enumerates on
its own, so if no COM port appears at all, the problem is upstream of the ESP32 entirely.

Failure ladder, in the order they actually happened to us:

1. **Charge-only USB cable.** Powers the board fine (green LED on D1), produces no port
   ever. This was our first blocker. Test: plug/unplug with Device Manager open — if the
   tree doesn't flicker, it's the cable.
2. **Missing CP210x driver.** Device appears under *Other devices* with a yellow triangle
   and Code 28. Fix: Silicon Labs CP210x VCP driver, or Windows Update → Optional updates
   → Driver updates.
3. **Port busy.** `Access is denied` on upload = Serial Monitor still holding the port.
   Close it (the X on the tab, not just switching away).

Note: Windows **hides the "Ports (COM & LPT)" category entirely** when no serial device
exists, so its absence is itself the diagnosis.

**If uploads fail with `Timed out waiting for packet header`:** hold the BOOT key, start
the upload, release once "Connecting…" becomes writing. GPIO0 doubles as the codec clock
line, which makes auto-reset unreliable here. Dropping upload speed to 115200 also helps.

**Serial output appears ~1.5s after reset and then stops** if your sketch only prints in
`setup()`. The monitor attaches after upload and misses it. Print in `loop()` during
bring-up, or press RST with the monitor already open.

---

## 9. Audio formats

- **Pet plays WAV** off its own SD card — 16-bit PCM, no decoder, just bytes to I2S.
  40 seconds at 16kHz mono ≈ 1.3MB, so 30 stories ≈ 40MB. The card doesn't care.
- **Web app uses MP3** — same recordings, different export. Shipping WAVs to a browser
  wastes tens of megabytes for no benefit.
- Convert: `ffmpeg -i in.mp3 -ac 1 -ar 22050 -c:a pcm_s16le out.wav` (mono 22050 Hz is plenty for
  speech; 24-bit and 32-bit float WAVs, common export defaults, won't play)
- For the prototype, **copy files to the SD with a card reader.** Don't build wifi sync.

---

## 10. Firmware architecture

### Audio + display + SD + BLE simultaneously

I2S needs an uninterrupted sample feed. A blocking SD read or screen redraw starves the
buffer and you hear clicks. Three mitigations, all required:

1. **Read ahead into PSRAM** — buffer several seconds. This is what the 4–8MB is for.
   `arduino-audio-tools` has buffered stream classes.
2. **Split the cores.** Audio task pinned to one, display and BLE on the other. Standard
   ESP32 pattern and the thing that makes the combination viable.
3. **No full-screen redraws during playback.** A 240×240 RGB565 frame is ~115KB, roughly
   23ms over SPI. Update only the progress arc and changed text.

**UNTESTED and important: BLE radio + I2S audio running together.** This is the one
remaining integration risk on this board. Test it early — advertise and connect while a
tone plays, and listen for stutter.

### Display

The display is a rectangular **2.4" 240×320 colour TFT driven as an ST7789** (the product page
claims ILI9341; the ST7789 driver is what works), on its own SPI bus at 20 MHz, through the
**Adafruit ST7789 + GFX** libraries. (The original plan was a round GC9A01; the parts changed on
2026-10-03.) **Avoid LVGL**: heavy, a memory hog next to an audio pipeline, and a face wants
drawing primitives, not widgets.

Colour inversion: `pet_screen.h` turns it **off** (`invertDisplay(false)`). The team's
`Code/Local_Host` bridge notes that its panel needs it **on**; if colours look like a negative
(black shows white, cyan shows red), flip that one line.

What the screen shows (`pet_screen.h`):

| State | Display | Entered by |
|---|---|---|
| Idle | The face (7 moods, blinking), the place and a status line under it | Boot, and when a story ends |
| Story | "NOW PLAYING" / "PAUSED", place, title, progress bar, times | BLE `play` from the browser |
| Lab / media | Whatever the pet screen lab or a `/media` video draws | USB from the lab or dashboard |

Look (since 2026-10-07): upright 240×320 (`PET_ROTATION 2`), white background, near-black text and
grey secondary text, plus colour: a three-colour **Jam** wordmark between stories (the object is Jam,
the face is its character), a colour per mood (Normal and Angry red, Annoyed orange, Bored teal,
Heart_Eyes pink, Sad blue, Sleepy purple), and a colour per story (from its place name) for the
band at the top and the progress bar. No face during a story. At power-on the screen is black, then
fades up to white. Colour inversion is set with `screen invert on|off` and remembered. `/debug`'s
simulated screen mirrors all of it.

Moods: Normal (blinks), Heart_Eyes on arrival or a pat, Sad on disconnect or a missing file,
Bored after 2 min, Sleepy after 4, screen off after 6. 

### BLE — pet is the peripheral

| Characteristic | Direction | Size | Payload |
|---|---|---|---|
| `play` | write | 3–34 B | start offset + `story_id` as text — play `/stories/<id>.wav` off your own SD |
| `transport` | write | 2 B | play / pause / stop / volume, output (jack or speaker) |
| `now_showing` | write | ~80 B | place, title, `icon_id` — what the dial draws |
| `playback` | notify | 3 B | state + position, to keep the app's UI in sync |
| `haptic` | write | 1 B | buzz pattern index |
| `input` | notify | 2 B | pat / double-pat / shake / hold-start / hold-end |
| `peer_seen` | notify | 8 B | story id picked up from another pet |

Exact UUIDs and byte layouts: **[docs/PET-PROTOCOL.md](./docs/PET-PROTOCOL.md)** (code: `src/pet/protocol.ts`).

**Audio never crosses the link** — the files are already on the SD card, we send an id.
**Coordinates never cross the link** — the pet makes no decision based on position. Send
the conclusion, not the input.

**Peer-to-peer carries 4 bytes in the advertising packet** — a service UUID plus the last
story id. No connection, no pairing, no handshake. Both devices scan at low duty, buzz
when RSSI crosses a threshold, and each tells its own browser which id it received; the
content was already on both sides. Write this module now, behind a flag, so a second pet
is a switch rather than a retrofit.

### Audio routing

**Headphone jack carries speech. Speaker carries everything that isn't words.** A Mumbai
carriage runs 80–90dB and a small driver loses that fight for intelligibility. Chirps,
pat acknowledgements and the peer encounter work on the speaker precisely because they
don't need to be understood, only noticed.

---

## 11. Still unverified — do these before relying on them

- [x] SD card mounts, and the DIP switch positions that make it work (1 OFF, 2 ON, 3 ON, 4 OFF, 5 OFF)
- [x] WAV playback from SD without dropouts (16-bit PCM, mono 22050 Hz)
- [x] BLE advertising and GATT while audio is playing (`pet_story_player`, 2026-10-04)
- [x] Which GPIOs are physically broken out on the headers, for the display (see section 6)
- [x] Whether capacitive touch has any pin left (no)
- [ ] Onboard mics (check for the capacitor fault) — not needed so far
- [x] Speaker output via the PA pin (4 Ω 3 W speaker on ROUT; 0.9 volume = 0 dB, louder distorts)
- [ ] Battery operation and runtime (3.7 V 950 mAh cell on hand, not wired yet)
- [ ] MJPEG video from `/media` with sound on the real board (code builds; not yet run)
- [ ] Colour inversion on/off for our panel, confirmed by eye

---

## 12. Build order for firmware

1. ~~Identify the board~~ — **done**, ES8388 @ 0x10
2. ~~Tone out of the headphone jack~~ — **done**, V1 + setVolume
3. ~~PSRAM on~~ — **done**, Wrover profile
4. ~~Display shows anything at all~~ — **done**, ST7789 on its own SPI bus
5. ~~The face — idle state~~ — **done**, 7 moods from the group's PNGs
6. ~~Buttons~~ — **done**: KEY1 power/sleep, KEY3 story, MTDI volume (no motor yet)
7. ~~WAV off the SD card, audio on its own core~~ — **done**
8. ~~BLE peripheral~~ — **done**, tested with nRF Connect first
9. ~~BLE while audio plays~~ — **done**
10. ~~Browser drives it end to end~~ — **done** (app → pet plays the story, shows place and progress)
11. Video from the SD card with sound (`pet_media.h`) — built, to be tried on the board
12. Battery and a power switch
13. Portrait screen designs from the lab, ported to `pet_screen.h`
14. Peer module, stubbed, enabled if a second pet exists
