# Pet firmware

Built up one piece at a time. Each sketch proves one thing before the next is added.
**Every wire on the current pet, in one place: [WIRING.md](./WIRING.md).**
Board facts and pin rules: [HARDWARE.md](../HARDWARE.md). Wiring for the parts on hand:
[docs/FEATURES.md section 7](../docs/FEATURES.md). Bluetooth bytes:
[docs/PET-PROTOCOL.md](../docs/PET-PROTOCOL.md).

| Step | Sketch | Proves | Status |
|---|---|---|---|
| 1 | `pet_ble_test/` | Bluetooth protocol, with nRF Connect and the web app | **passed** on the board (2026-10-03) |
| 1b | `speaker_test/` | a tone through the speaker (amp on GPIO 21) | compiles; test on the board |
| 1c | `bt_speaker_test/` | the board as a normal Bluetooth speaker: play anything from a laptop or phone | written; needs the ESP32-A2DP library |
| 1d | `pet_display_test/` | ST7789 display + Bluetooth: shows what the app sends, including your phone's GPS | compiles |
| 1e | `display_check/`, `oled_check/` | smallest screen tests: TFT colour cycle; OLED I2C scan + text | compile |
| 2 | `pet_story_player/` | **Bluetooth + display + WAV from SD, together**: the app's Play plays a real story | **passed** on the board with the OLED (2026-10-04): app → pet audio from SD + display + GPS |
| 2b | faces in `pet_story_player/` | the pet's face and moods on the TFT, alongside story audio | compiles (2026-10-04); test on the board |
| 3 | + touch switch and button | pat and double-pat reach the app | |
| 4 | + WAV from the SD card | real audio, on its own core | |
| 5 | Bluetooth while audio plays | no stutter (the riskiest step) | |

## Step 1: Bluetooth test

**Setup (once):** in the Arduino IDE, install **NimBLE-Arduino** (by h2zero, version 2.x)
from the Library Manager. Board: **ESP32 Wrover Module**. Checked to compile with
NimBLE-Arduino 2.5.1 and ESP32 core 3.3.12.

**Flash** `pet_ble_test/pet_ble_test.ino`, then open the Serial Monitor at **115200**. It
prints `Advertising as "Jam Pet"`.

**Test A, with nRF Connect on your phone:**
1. Scan, find **Jam Pet**, connect.
2. Open the service starting `f4040001`. On `f4040005` (playback), tap the triple-arrow
   to turn on notifications.
3. On `f4040002` (play), write this hex (offset 0, then `mahim-causeway-01`):
   `00006D6168696D2D63617573657761792D3031`
4. Serial shows `<- play "mahim-causeway-01"`, and playback notifications tick up once a
   second, then return to state 0 after 40 s.

**Test B, with the web app:** Web Bluetooth works in Chrome on a laptop too, and
`localhost` counts as secure.
1. `npm run dev` and open http://localhost:5173 in **Chrome**. Disconnect nRF Connect first,
   because the pet takes one connection at a time.
2. Tap **Pair a pet**, choose **Jam Pet**. The **Test the pet** panel appears: tap Play on any
   story to send it straight to the pet, no journey needed. Touches from the pet show up there.
3. Pick the walking route and start the journey. When Mahim fires, the story card says
   "Playing on your pet", Serial shows `now_showing`, `haptic` and `play`, and the card's
   timer follows the pet.
4. In the Serial Monitor, type `p` and press Enter: the story pauses (pat). `d` skips it
   (double-pat).
5. Type `m`, then let a story fire: the pet answers "missing file" and the phone plays it
   instead.

## Step 1b: Speaker test

Flash `speaker_test/speaker_test.ino` with the earphones **unplugged** (plugging them in can
switch the speaker amp off). You should hear a steady tone. Serial Monitor at 115200:
`+` / `-` volume, `s` speaker amp on/off, `n` next note. Checked to compile against
arduino-audio-tools and arduino-audio-driver as installed on this laptop.

If it's silent: check the speaker is on the speaker terminals (not the line-in socket),
try `s` twice, raise the volume, and check the earphones are out.

## Step 1c: Bluetooth speaker test

Makes the board an ordinary Bluetooth speaker called **Jam Pet Speaker**, to test the
speaker and audio path with any sound. This uses Classic Bluetooth audio (like earbuds), not
the app's Bluetooth LE protocol, so the app can't drive it.

1. Install **ESP32-A2DP** (github.com/pschatzmann/ESP32-A2DP): download the ZIP, extract into
   `Documents/Arduino/libraries`, rename the folder to drop `-main`.
2. Tools → Partition Scheme → **Huge APP (3MB No OTA/1MB SPIFFS)**. Classic Bluetooth audio
   is too big for the default partition.
3. Upload `bt_speaker_test/bt_speaker_test.ino`, unplug the earphones.
4. On the laptop: Bluetooth settings → add device → **Jam Pet Speaker**. Pick it as the sound
   output and play anything. Serial Monitor: `+` / `-` volume, `s` speaker amp on/off.

## Step 1d: Display + Bluetooth (phone GPS on the screen)

**Wiring:** SCK 18, MOSI/SDI 23, CS 5, DC 21 for now, RESET 22, LED → 3.3 V, VCC 3.3 V, GND.
**Tested 2026-10-04:** DC on 19 leaves the screen black (onboard KEY3 sits on 19); DC on 21
works. 21 also switches the speaker amp, so before audio is added, move DC to **GPIO 4**
(wire and `#define TFT_DC 4`).

**Libraries:** install **Adafruit ST7735 and ST7789 Library** from the Library Manager (it
asks to install Adafruit GFX too: say yes). NimBLE-Arduino as before.

1. Flash `pet_display_test/pet_display_test.ino`. The screen shows "Jam Pet · waiting...".
2. Open the web app in Chrome (laptop: http://localhost:5173; phone: `npm run dev:phone`), tap
   **Pair a pet** → **Jam Pet**. The screen says "connected".
3. In **Test the pet**, switch on **Show my location on the pet**. Allow location. Your
   coordinates and accuracy appear on the screen, updating about once a second.
4. Tap Play on a story: the place and title replace the coordinates, with a progress bar.

Checked to compile with NimBLE-Arduino 2.5.1, Adafruit ST7735 and ST7789 Library, ESP32 core 3.3.12.

## Step 2: Story player (Bluetooth + display + SD audio)

`pet_story_player/pet_story_player.ino` plays `/stories/<story id>.wav` from the SD card when
the app sends a story, shows place, title and a progress bar, and reports playback to the
app. Missing file → the app plays it on the phone.

**Pick the display** at the top of the sketch: `#define PET_SCREEN_OLED 0` for the ST7789 TFT
(primary), `1` for the 1.3" SH1106 OLED (test). All display code is in `pet_screen.h`.

- **TFT wiring:** the display has its own SPI bus. SCK → **IO18**, SDI → **IO23**, CS → 5, DC → 22,
  RESET → the board's EN/RST pin, LED + VCC 3.3 V, GND. `display_check/` uses the same wiring.
  (On 2026-10-05 it briefly shared the SD card's bus on MTMS/MTDO to free 18/23. The extra wiring
  on the card's lines made the SD card fail to mount or read, so don't do that.)
- **DIP switches:** 1 OFF, 2 ON, 3 ON, 4 OFF, 5 OFF (2 and 3 connect the SD card; 1 puts KEY2 on
  the card's CS line; 4 and 5 run SD lines out to the JTAG header).
- **OLED wiring:** SDA → IO18, SCL → IO23, VCC 3.3 V, GND (second I2C bus; 32/33 aren't on
  this board's headers, and the TFT is unplugged in OLED mode). Run `oled_check/` first: its
  I2C scan should list 0x3C.
- **SD card:** FAT32, DIP switches DATA3 and CMD ON, files in `/stories/` named like the
  MP3s but `.wav` (e.g. `/stories/mahim-causeway-01.wav`), 16-bit PCM. Mono 22050 Hz is
  plenty for speech and keeps files small.
- **Partition Scheme:** Huge APP. **Libraries:** NimBLE-Arduino, arduino-audio-tools,
  arduino-audio-driver, JPEGDEC (by Larry Bank, for video), plus Adafruit ST7789 (TFT) or U8g2 (OLED).
- **Video:** `/media/<name>.mjpeg` + `.wav` + `.cfg` on the card, played by `pet_media.h`; the pet media
  dashboard (`/media` in the web app) makes, sends and plays them. Or: `node scripts/make-media.mjs <video> [name]`
  writes them to `firmware/sd-card/media/` (needs ffmpeg) to copy onto the card. `sync-test` there checks sound sync.
  While one plays: `media fit original|fit|cover|stretch` (size on the screen) and `media rotate 0-3`;
  `fit=` and `rotation=` in the `.cfg` make them the default.
  Text above and below the picture: `top=…` / `bottom=…` in the `.cfg` ("|" starts a new line), or
  `media top <text>` / `media bottom <text>` to try it. Drawn once, so it costs nothing per frame.
- **Startup (2026-10-16):** the startup sound begins on a dark screen; 1 s later (`STARTUP_SOUND_LEAD_MS`) the mascot over "JAM" on teal fades in, stays 1.8 s
  (`STARTUP_HOLD_MS`), then fades to the white pet screen. The picture is in flash
  (`startup_image.h`), made by `node scripts/convert-startup.mjs [picture]` from
  `assets/pet-startup/startup.png` (needs ffmpeg). The startup video is gone.
- **Startup sound:** put a WAV (16-bit PCM) at `/sounds/startup.wav` on the card (or keep the old
  video's `/media/startup.wav`) and the pet plays it with the picture, at power-on and on every wake
  from sleep. No file, no sound.
- **Phone gone (2026-10-16):** the pet asks for a 4 s link timeout on connect and re-checks the link
  every second, so the dot goes grey and the screen goes back to waiting within about 4 s of the phone
  leaving (at once if the app is closed). It keeps playing a story it already started.
- **Story offers (2026-10-16):** when the visitor app pops up a story, the pet shows the place with
  "Story here. Press play to listen", makes heart eyes and chimes (`/sounds/story-here.wav`, a two-note
  chime in `firmware/sd-card/sounds/`; no file, no chime). A tap on KEY3 is Listen, a double-tap is
  Later. With nothing on offer, a tap plays the first story waiting in the app's queue, or the pet
  shows where the nearest story is.
- **Connecting:** the pet greets the phone straight away (heart eyes, "Hello! Connected"), and the
  app sends what it's doing at once ("Start Jam on your phone…", or where you are), not only once a
  story plays.

**Serial is 921600 baud** (since 2026-10-06, for the pet screen lab): set the Serial Monitor to 921600.
The lab at `/lab` can draw on the pet's screen over USB ("Lab mode" in `pet_screen.h`) and send it
whole clips with sound to play from PSRAM (`pet_lab.h`).

**Test without the app:** Serial Monitor (Newline): `ls` lists the card, `play mahim-causeway-01`
plays it, `pause` / `resume` / `stop`, `vol 0.9`, `+` / `-` (volume in steps of 0.1).

**Test with the app:** pair, then tap Play in **Test the pet**: the story plays on the pet's
speaker and the app shows "on the pet". Turn on **Show my location on the pet** to see GPS on
the screen at the same time.

## Step 2b: The pet's face and moods

`pet_story_player` now shows the face from `faces.h` above a two-line caption (place, then title or status), with a progress bar while a story plays and a connection dot in the corner.

**Moods** (same rules in the browser's simulated pet screen in `/debug`):

| Situation | Face |
|---|---|
| Idle or playing | Normal, blinking every 3 to 6 s |
| Arrival (the app's buzz) or a pat | Heart_Eyes for 2 to 3 s |
| Phone disconnects, story missing from the card | Sad for 2.5 to 3 s |
| No activity for 2 min / 4 min / 6 min | Bored / Sleepy / screen off |

Any write from the app or a Serial command wakes it. Serial `mood 0` to `mood 6` shows a face for 5 s (0 Angry, 1 Annoyed, 2 Bored, 3 Heart_Eyes, 4 Normal, 5 Sad, 6 Sleepy).

**Changing the faces:** put the PNGs in `assets/pet-faces/` named like `Normal (1).png`, then run
`node scripts/convert-faces.mjs assets/pet-faces` (needs ffmpeg). It regenerates `faces.h` for the pet and
`src/pet/faces.json` for the browser, so both always show the same frames.

## Step 2c: The board's keys

`key_check/` confirmed all six keys (2026-10-05): KEY1 = 36, KEY2 = 13, KEY3 = 19, KEY4 = 23,
KEY5 = 18, KEY6 = 5. Two are free and wired into `pet_story_player`; the rest are SD and display
pins:

| Button | Job | Tap | Double-tap | Hold |
|---|---|---|---|---|
| KEY1 (36) | power | wake up (while asleep) | | 2 s: sleep |
| KEY3 (19) | story | pause / play | skip | replay the last story |
| MTDI (12) | volume | up | | down, repeating |

KEY1 is the power key because GPIO 36 can wake the chip from deep sleep and 19 can't. Waking
restarts the board; the app reconnects on its own. Sleep is not off (codec, amplifier and display
backlight stay powered), so use a switch on the battery to store the pet.

With the phone connected, KEY3's tap and double-tap go to the app as a pat / double-pat, which
pauses or skips. Without the phone, the pet does it itself. KEY2 (SD card CS), KEY4/KEY5 (display
data and clock) and KEY6 (display CS) stay unused: pressing them would short a line the board is
driving. External buttons can be soldered across KEY1 and KEY3.

**Volume button on MTDI (GPIO 12, JTAG header):** wire it between MTDI and **3.3 V** (not
ground). GPIO 12 must be LOW at power-on or the board will not boot, so the firmware pulls it down
and reads HIGH as pressed. Don't hold it while powering on or pressing RST. `key_check/` tests it
(passed 2026-10-05: LOW at rest, HIGH when pressed).
