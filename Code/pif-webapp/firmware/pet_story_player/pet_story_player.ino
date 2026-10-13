// Pet story player: Bluetooth + display + real audio from the SD card.
//
// The app sends a story id (docs/PET-PROTOCOL.md); the pet plays /stories/<id>.wav from
// its SD card through the speaker (or earphones), shows the place and title on the
// screen with a progress bar, and reports playback back to the app. If the file isn't on
// the card it says "missing file" and the app plays the story on the phone instead.
// The app's "Show my location on the pet" switch also still works: coordinates appear
// as the place line. (Test only; in the product the pet gets place names, never positions.)
//
// ---------- Display: pick one ----------
// 0 = ST7789 2.4" colour TFT, sharing the SD card's SPI bus: SCK -> MTMS (14), SDI -> MTDO (15),
//     CS 5, DC 22, RESET -> board EN/RST, LED + VCC 3.3 V. Frees 18 and 23 for I2C.
// 1 = SH1106 1.3" 128x64 OLED on I2C (test): SDA IO18, SCL IO23, VCC 3.3 V, GND.
#ifndef PET_SCREEN_OLED
#define PET_SCREEN_OLED 0
#endif
//
// ---------- Other wiring (ESP32-A1S, docs/FEATURES.md section 7) ----------
//   Speaker: the board's speaker terminals. Earphones: the headphone jack.
//   SD card: the board's slot, DIP switches DATA3 and CMD ON.
//            Files: /stories/<story id>.wav, 16-bit PCM WAV (mono 22050 Hz is plenty for speech).
//
// Libraries: NimBLE-Arduino 2.x, arduino-audio-tools and arduino-audio-driver
//            (HARDWARE.md section 5), plus for the TFT "Adafruit ST7735 and ST7789
//            Library" (+ Adafruit GFX), or for the OLED "U8g2".
// Board:     ESP32 Wrover Module, Partition Scheme "Huge APP (3MB No OTA/1MB SPIFFS)".
// Serial:    115200, line ending Newline. Commands:
//              play <id>   stop   pause   resume   ls (list /stories)   vol <0.0-1.0>
//              screen (restart the display if it went white or blank)
//              p (pat)   d (double-pat)   s (status)

#include <Arduino.h>
#include <SPI.h>
#include <SD.h>
#include <NimBLEDevice.h>
#include "AudioTools.h"
#include "AudioTools/AudioLibs/AudioBoardStream.h"

#include "pet_screen.h"

#define SERIAL_BAUD 921600  // the pet screen lab can move it faster at runtime ("lab baud")

// ---------- Audio ----------
AudioBoardStream kit(AudioKitEs8388V1);  // V1, not V2: V2 is silent on our board
EncodedAudioStream decoder(&kit, new WAVDecoder());
StreamCopy copier;
File audioFile;
float volume = 0.9;  // 0.9 = 0 dB on this codec: loudest without clipping

// ---------- Protocol (keep in sync with src/pet/protocol.ts) ----------
#define SERVICE_UUID     "f4040001-a91e-4923-a44e-340a15cd58e5"
#define PLAY_UUID        "f4040002-a91e-4923-a44e-340a15cd58e5"
#define TRANSPORT_UUID   "f4040003-a91e-4923-a44e-340a15cd58e5"
#define NOW_SHOWING_UUID "f4040004-a91e-4923-a44e-340a15cd58e5"
#define PLAYBACK_UUID    "f4040005-a91e-4923-a44e-340a15cd58e5"
#define HAPTIC_UUID      "f4040006-a91e-4923-a44e-340a15cd58e5"
#define INPUT_UUID       "f4040007-a91e-4923-a44e-340a15cd58e5"

enum PlaybackState : uint8_t { STATE_IDLE = 0, STATE_PLAYING = 1, STATE_PAUSED = 2, STATE_MISSING_FILE = 3 };
enum TransportCmd : uint8_t { CMD_RESUME = 0, CMD_PAUSE = 1, CMD_STOP = 2, CMD_VOLUME = 3 };
enum InputEvent : uint8_t { INPUT_PAT = 1, INPUT_DOUBLE_PAT = 2 };

#define PET_NAME "Jam Pet"

NimBLECharacteristic* playbackChr = nullptr;
NimBLECharacteristic* inputChr = nullptr;
volatile bool connected = false;

// ---------- Shared state ----------
// Bluetooth callbacks and the Serial Monitor only post requests; the audio task owns the
// SD card and the codec; loop() owns the display. That keeps SD reads and screen drawing
// from stepping on each other and from starving the audio.
SemaphoreHandle_t requestLock;
String requestedId = "";          // guarded by requestLock
String lastStoryId = "";          // for "replay" on the pet's keys
volatile bool playRequested = false;
volatile int transportRequested = -1;

volatile PlaybackState state = STATE_IDLE;
volatile uint32_t bytesPlayed = 0;
volatile uint32_t byteRate = 0;   // bytes per second of the current file
volatile uint32_t durationS = 0;
volatile bool playbackChanged = true;  // notify the app + redraw the progress bar

String shownPlace = "";
String shownTitle = "";
volatile bool textDirty = true;
volatile bool statusDirty = true;
// Set when the screen should be started again from scratch: the TFT can lose its setup
// (goes white) after a power dip or a corrupted command, and a re-init brings it back.
volatile bool screenReinit = false;
String serialLine = "";

// ---------- The pet's mood ----------
// Which face to show comes from what's happening (docs/FEATURES.md, the pet as a character):
//   playing a story -> Normal, blinking now and then
//   arriving somewhere (the app's buzz) or a pat -> Heart_Eyes for a few seconds
//   phone disconnects, story missing from the card -> Sad for a few seconds
//   nothing happening -> Normal, then Bored, then Sleepy, then the screen turns off
#define BORED_AFTER_MS  120000
#define SLEEPY_AFTER_MS 240000
#define SCREEN_OFF_MS   360000
#define FRAME_MS        140

volatile uint32_t lastActivity = 0;
volatile int moodOverride = -1;
volatile uint32_t overrideUntil = 0;

void poke() { lastActivity = millis(); }  // anything happened: stay awake
void react(int mood, uint32_t ms) {
  moodOverride = mood;
  overrideUntil = millis() + ms;
  poke();
}

uint16_t positionS() { return byteRate ? bytesPlayed / byteRate : 0; }

#include "pet_lab.h"  // clips from the pet screen lab (needs kit, volume, tft above)
#include "pet_media.h"  // videos + sound from the SD card's /media folder

// ---------- Audio task ----------
uint32_t readU32(File& f, uint32_t offset) {
  uint8_t b[4] = { 0 };
  f.seek(offset);
  f.read(b, 4);
  return b[0] | (b[1] << 8) | (b[2] << 16) | ((uint32_t)b[3] << 24);
}

// Mounts the card, falling back to slower speeds if it won't read at the default 4 MHz
// (long or loose wiring on the card's lines can do that).
bool mountSd() {
  // A mount can "succeed" while reads still come back garbled, so a speed only counts if
  // the card's top folder can actually be read at it. Fast first: video needs the speed.
  const uint32_t speeds[] = { 20000000, 10000000, 4000000, 1000000 };
  for (uint32_t hz : speeds) {
    if (SD.begin(PIN_AUDIO_KIT_SD_CARD_CS, SPI, hz)) {
      File root = SD.open("/");
      bool readable = root && root.isDirectory();
      if (root) root.close();
      if (readable) {
        Serial.printf("SD card mounted at %lu kHz\n", (unsigned long)(hz / 1000));
        return true;
      }
      Serial.printf("SD card mounted at %lu kHz but can't be read, slowing down\n", (unsigned long)(hz / 1000));
    }
    SD.end();
    delay(100);
  }
  Serial.println("No SD card answered at any speed: is it pushed all the way in (it clicks)?");
  return false;
}

void startStory(const String& id) {
  if (audioFile) audioFile.close();
  String path = "/stories/" + id + ".wav";
  audioFile = SD.open(path);
  if (!audioFile) {
    // The mount goes stale if the card was reseated, or after a glitch on the bus it
    // shares with the display. Remount once and try again before giving up.
    Serial.printf("Couldn't open %s, remounting the SD card...\n", path.c_str());
    SD.end();
    delay(50);
    if (mountSd()) audioFile = SD.open(path);
  }
  if (!audioFile) {
    Serial.printf("No file %s -> missing file, the app will play it on the phone\n", path.c_str());
    state = STATE_MISSING_FILE;
    bytesPlayed = 0;
    playbackChanged = true;
    react(MOOD_SAD, 2500);
    return;
  }
  // Check the WAV header and say exactly what's wrong if it isn't a playable file.
  uint8_t magic[12] = { 0 };
  audioFile.read(magic, 12);
  Serial.printf("%s: %u bytes\n", path.c_str(), (unsigned)audioFile.size());
  if (memcmp(magic, "RIFF", 4) != 0 || memcmp(magic + 8, "WAVE", 4) != 0) {
    Serial.printf("Not a WAV file (starts with \"%.4s\"). An MP3 renamed to .wav won't play:\n"
                  "convert it, e.g. ffmpeg -i in.mp3 -ac 1 -ar 22050 -c:a pcm_s16le out.wav\n", magic);
    audioFile.close();
    state = STATE_MISSING_FILE;  // let the app play it on the phone instead
    playbackChanged = true;
    react(MOOD_SAD, 2500);
    return;
  }
  // Walk the chunks: apps like FL Studio add extra ones (metadata, markers), so "fmt " and
  // "data" aren't always at the textbook offsets.
  uint16_t format = 0, channels = 0, bits = 0;
  uint32_t rate = 0, dataSize = 0;
  byteRate = 0;
  uint32_t pos = 12;
  while (pos + 8 <= audioFile.size()) {
    char id[4];
    audioFile.seek(pos);
    audioFile.read((uint8_t*)id, 4);
    uint32_t size = readU32(audioFile, pos + 4);
    if (memcmp(id, "fmt ", 4) == 0) {
      format = readU32(audioFile, pos + 8) & 0xffff;
      channels = readU32(audioFile, pos + 10) & 0xffff;
      rate = readU32(audioFile, pos + 12);
      byteRate = readU32(audioFile, pos + 16);
      bits = readU32(audioFile, pos + 22) & 0xffff;
    } else if (memcmp(id, "data", 4) == 0) {
      dataSize = size;
      break;
    } else {
      Serial.printf("  (skipping a \"%.4s\" chunk)\n", id);
    }
    pos += 8 + size + (size & 1);  // chunks are padded to an even length
  }
  Serial.printf("WAV: format %u, %u channel(s), %u Hz, %u-bit, %u s of audio\n", format, channels, rate, bits,
                byteRate ? dataSize / byteRate : 0);
  if (format != 1 || bits != 16) {
    // 24-bit and 32-bit float are common export defaults; the decoder here only plays 16-bit PCM.
    Serial.printf("Can't play this: it's %s. Re-export as WAV, 16-bit (not 24-bit or 32-bit float).\n",
                  format == 3 ? "32-bit float" : bits == 24 ? "24-bit" : "not 16-bit PCM");
    audioFile.close();
    state = STATE_MISSING_FILE;  // let the app play it on the phone instead
    playbackChanged = true;
    react(MOOD_SAD, 2500);
    return;
  }
  durationS = byteRate ? dataSize / byteRate : 0;
  audioFile.seek(0);
  decoder.begin();
  copier.begin(decoder, audioFile);
  bytesPlayed = 0;
  state = STATE_PLAYING;
  playbackChanged = true;
  screenReinit = true;  // a fresh start per story, in case the screen dropped out
  lastStoryId = id;
  Serial.printf("Playing %s (%u s)\n", path.c_str(), durationS);
}

void stopStory() {
  if (audioFile) audioFile.close();
  state = STATE_IDLE;
  bytesPlayed = 0;
  playbackChanged = true;
}

void audioTask(void*) {
  uint32_t lastSecond = 0;
  uint32_t clipPos = 0;
  for (;;) {
    // A video from /media has the codec while it plays (pet_media.h).
    if (mediaAudioOn) {
      mediaAudioBusy = true;
      if (state == STATE_PLAYING || state == STATE_PAUSED) stopStory();
      if (mediaAudioRestart) {
        mediaAudioRestart = false;
        kit.setAudioInfo(AudioInfo(mediaWavRate, mediaWavChannels, 16));
        mediaWav.seek(mediaWavData + mediaAudioFrom);
        mediaAudioPlayed = 0;
      }
      uint32_t used = mediaAudioFrom + mediaAudioPlayed;
      uint32_t left = mediaWavLen > used ? mediaWavLen - used : 0;
      if (!left && !media.playing) {  // a sound on its own (the startup sound) has finished
        mediaAudioOn = false;
        mediaAudioBusy = false;
        continue;
      }
      if ((int32_t)(millis() - mediaAudioStartAt) >= 0 && left) {
        static uint8_t mbuf[2048];
        int r = mediaWav.read(mbuf, left < sizeof(mbuf) ? left : sizeof(mbuf));
        if (r > 0) {
          kit.write(mbuf, r);  // blocks while the codec's buffer is full: keeps time
          mediaAudioPlayed += r;
        } else {
          mediaAudioPlayed = mediaWavLen;  // end of file
        }
        mediaAudioBusy = false;
      } else {
        mediaAudioBusy = false;
        vTaskDelay(pdMS_TO_TICKS(2));
      }
      continue;
    }
    // A clip from the lab has the codec while it plays (pet_lab.h).
    if (clipAudioOn) {
      clipAudioBusy = true;
      if (state == STATE_PLAYING || state == STATE_PAUSED) stopStory();
      if (clipAudioRestart) {
        clipAudioRestart = false;
        clipPos = clipAudioFrom;
        kit.setAudioInfo(AudioInfo(clip.audioRate, 1, 16));
      }
      bool due = (int32_t)(millis() - clipAudioStartAt) >= 0;
      if (due && clipPos < clip.audioLen) {
        uint32_t n = clip.audioLen - clipPos;
        if (n > 1024) n = 1024;
        kit.write(clip.audio + clipPos, n);  // blocks while the codec's buffer is full: keeps time
        clipPos += n;
        clipAudioBusy = false;
      } else {
        clipAudioBusy = false;
        vTaskDelay(pdMS_TO_TICKS(2));
      }
      continue;
    }
    if (playRequested) {
      xSemaphoreTake(requestLock, portMAX_DELAY);
      String id = requestedId;
      playRequested = false;
      xSemaphoreGive(requestLock);
      startStory(id);
      lastSecond = 0;
    }
    int cmd = transportRequested;
    if (cmd >= 0) {
      transportRequested = -1;
      if (cmd == CMD_PAUSE && state == STATE_PLAYING) { state = STATE_PAUSED; playbackChanged = true; }
      else if (cmd == CMD_RESUME && state == STATE_PAUSED) { state = STATE_PLAYING; playbackChanged = true; }
      else if (cmd == CMD_STOP) stopStory();
    }

    if (state == STATE_PLAYING) {
      size_t n = copier.copy();
      bytesPlayed += n;
      if (n == 0 && audioFile.available() == 0) {
        Serial.println("Story finished");
        stopStory();  // idle tells the app to move on
      } else if (positionS() != lastSecond) {
        lastSecond = positionS();
        playbackChanged = true;  // about once a second
      }
    } else {
      vTaskDelay(pdMS_TO_TICKS(10));
    }
  }
}

// ---------- Bluetooth ----------
void notifyPlayback() {
  uint16_t pos = positionS();
  uint8_t buf[3] = { (uint8_t)state, (uint8_t)(pos & 0xff), (uint8_t)(pos >> 8) };
  playbackChr->setValue(buf, sizeof(buf));
  if (connected) playbackChr->notify();
}

void notifyInput(InputEvent event) {
  uint8_t buf[2] = { event, 0 };
  inputChr->setValue(buf, sizeof(buf));
  if (connected) inputChr->notify();
  if (event == INPUT_PAT) react(MOOD_HEART_EYES, 2000);  // a pat makes it happy
  Serial.printf("-> input %s\n", event == INPUT_PAT ? "pat" : "double-pat");
}

void requestPlay(const String& id) {
  xSemaphoreTake(requestLock, portMAX_DELAY);
  requestedId = id;
  playRequested = true;
  xSemaphoreGive(requestLock);
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo&) override {
    connected = true;
    statusDirty = true;
    poke();
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    connected = false;
    statusDirty = true;
    react(MOOD_SAD, 3000);
    NimBLEDevice::startAdvertising();
  }
};

class PlayCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* chr, NimBLEConnInfo&) override {
    NimBLEAttValue v = chr->getValue();
    if (v.length() < 3 || v.length() > 34) return;
    requestPlay(String((const char*)(v.data() + 2), v.length() - 2));  // offset ignored for now
    poke();
  }
};

class TransportCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* chr, NimBLEConnInfo&) override {
    NimBLEAttValue v = chr->getValue();
    if (v.length() < 2) return;
    poke();
    if (v.data()[0] == CMD_VOLUME) {
      volume = v.data()[1] / 100.0f;
      kit.setVolume(volume);
    } else if (v.data()[0] <= CMD_STOP) {
      transportRequested = v.data()[0];
    }
  }
};

class NowShowingCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* chr, NimBLEConnInfo&) override {
    NimBLEAttValue v = chr->getValue();
    if (v.length() < 1) return;
    String text = String((const char*)(v.data() + 1), v.length() - 1);
    int nl = text.indexOf('\n');
    shownPlace = nl >= 0 ? text.substring(0, nl) : text;
    shownTitle = nl >= 0 ? text.substring(nl + 1) : "";
    textDirty = true;
    poke();
  }
};

// The app buzzes when you arrive at a new place: no motor yet, so the face reacts instead.
class HapticCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic*, NimBLEConnInfo&) override { react(MOOD_HEART_EYES, 3000); }
};

ServerCallbacks serverCallbacks;
PlayCallbacks playCallbacks;
TransportCallbacks transportCallbacks;
NowShowingCallbacks nowShowingCallbacks;
HapticCallbacks hapticCallbacks;

// ---------- Setup ----------
void setup() {
  // 921600 baud (not 115200) so the pet screen lab can send whole screens quickly. Set the
  // Serial Monitor to 921600 too. A big receive buffer holds a lab frame while it's drawn.
  Serial.setRxBufferSize(8192);
  Serial.begin(SERIAL_BAUD);
  delay(300);
  Serial.println("\nJam pet story player");
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) Serial.println("Woke up (KEY1)");
  AudioToolsLogger.begin(Serial, AudioToolsLogLevel::Warning);
  requestLock = xSemaphoreCreateMutex();
  poke();

  // 1. Audio board first: it sets up all of the board's pins (including putting the
  //    onboard-key pins 18, 23, 5 into input mode) and the SD card's SPI bus.
  auto cfg = kit.defaultConfig(TX_MODE);
  cfg.sd_active = true;
  kit.begin(cfg);
  kit.setVolume(volume);
  kit.setSpeakerActive(true);

  if (!mountSd()) {
    Serial.println("SD card FAILED to mount: check the card, and DIP switches DATA3 and CMD = ON");
  }

  // 2. Display after the audio board, so its pins end up as display pins (TFT), or so
  //    the codec's I2C bus is already running (OLED).
  screenBegin();
  keysBegin();

  // 3. Bluetooth.
  NimBLEDevice::init(PET_NAME);
  NimBLEDevice::setMTU(185);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(&serverCallbacks);
  NimBLEService* service = server->createService(SERVICE_UUID);
  service->createCharacteristic(PLAY_UUID, NIMBLE_PROPERTY::WRITE)->setCallbacks(&playCallbacks);
  service->createCharacteristic(TRANSPORT_UUID, NIMBLE_PROPERTY::WRITE)->setCallbacks(&transportCallbacks);
  service->createCharacteristic(NOW_SHOWING_UUID, NIMBLE_PROPERTY::WRITE)->setCallbacks(&nowShowingCallbacks);
  service->createCharacteristic(HAPTIC_UUID, NIMBLE_PROPERTY::WRITE)->setCallbacks(&hapticCallbacks);
  playbackChr = service->createCharacteristic(PLAYBACK_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  inputChr = service->createCharacteristic(INPUT_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  service->start();
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setName(PET_NAME);
  adv->enableScanResponse(true);
  adv->start();

  // 4. Audio on its own task, above loop()'s priority, so screen drawing can't starve it.
  xTaskCreatePinnedToCore(audioTask, "audio", 8192, nullptr, 3, nullptr, 1);

  // 5. Startup: the startup video with its sound (/media/startup.mjpeg + .wav), or if the card
  //    has no video, just the startup sound (/sounds/startup.wav).
  if (!mediaStartup()) mediaPlaySound("/sounds/startup.wav");

  // 6. Then a dark screen, the name (under a second), and the white fades in to the pet's screen.
  screenSplash("JAM", 700);
  screenFadeIn();
  screenRedrawAll();

  Serial.println("Ready. Type help for the commands.");
}

// ---------- Loop: Serial commands + display + notifications ----------
static void listFolder(const char* path) {
  File dir = SD.open(path);
  if (!dir || !dir.isDirectory()) {
    Serial.printf("%s: not on the card\n", path);
    if (dir) dir.close();
    return;
  }
  Serial.printf("%s:\n", path);
  int n = 0;
  for (File f = dir.openNextFile(); f; f = dir.openNextFile(), n++) {
    Serial.printf("  %-28s %6u KB\n", f.name(), (unsigned)(f.size() / 1024));
    f.close();
  }
  if (!n) Serial.println("  (empty)");
  dir.close();
}

// "ls": everything the pet uses on the card. Stories play with "play <name>", videos with
// "media play <name>" (names without the .wav / .mjpeg).
void listStories() {
  File root = SD.open("/");
  if (!root) {
    Serial.println("Can't read the SD card, remounting it...");
    SD.end();
    if (!mountSd()) {
      Serial.println("No SD card: is it pushed all the way in?");
      return;
    }
  } else {
    root.close();
  }
  listFolder("/stories");
  listFolder("/media");
  Serial.printf("Card: %llu MB used of %llu MB\n", SD.usedBytes() / 1048576ULL, SD.totalBytes() / 1048576ULL);
}

void printHelp() {
  Serial.println(
    "\nCommands (type one, then Enter; Serial Monitor at 921600 baud, line ending Newline):\n"
    "  help                 this list\n"
    "  ls                   what's on the SD card (stories and videos)\n"
    "\nStories (/stories/<name>.wav):\n"
    "  play <name>          e.g. play mahim-causeway-01\n"
    "  pause | resume | stop\n"
    "\nVideos (/media/<name>.mjpeg, + .wav sound, + .cfg settings):\n"
    "  media play <name>    e.g. media play sky\n"
    "  media stop\n"
    "  media loop on|off    repeat or not\n"
    "  media fps <n>        speed while playing, e.g. media fps 10\n"
    "  media offset <ms>    sound sync, + = sound later, e.g. media offset 120\n"
    "  media rotate <0-3>   turn the picture: 0 or 2 upright, 1 or 3 sideways\n"
    "  media fit <mode>     original (actual size) | fit (whole picture, bars) |\n"
    "                       cover (fills the screen, edges cut off) | stretch (fills, shape changes)\n"
    "  media top <text>     text above the picture (| starts a new line; nothing after = clear)\n"
    "  media bottom <text>  text below the picture\n"
    "  media rm <file>      delete, e.g. media rm sky.mjpeg\n"
    "  (while a video plays, MEDIASTAT lines say how long a frame takes and how many were skipped)\n"
    "\nSound:\n"
    "  + | -                volume up / down a step\n"
    "  vol <0-1>            e.g. vol 0.9 (0.9 is the loudest without distortion)\n"
    "\nScreen and pet:\n"
    "  mood <0-6>           show a face for 5 s: 0 Angry 1 Annoyed 2 Bored 3 Heart_Eyes 4 Normal 5 Sad 6 Sleepy\n"
    "  screen               restart the screen (if it goes white)\n"
    "  screen invert on|off colours look like a negative (white shows black)? flip this; remembered\n"
    "  lab spi <hz>         display speed, e.g. lab spi 40000000 (back to 20 MHz on restart)\n"
    "  s                    status: phone connected, playing, position\n"
    "  p | d                pretend a pat / double-pat (sent to the phone)\n");
}

// ---------- The board's keys ----------
// Three buttons, one job each. Two are onboard keys (pins checked with key_check,
// 2026-10-05); the others are taken: KEY2 (13) is the SD card's CS, KEY4 (23) and KEY5 (18)
// the display's data and clock, KEY6 (5) the display's CS. External buttons can be
// soldered across KEY1 and KEY3.
//
//   KEY1 (36)   power      hold 2 s: sleep. Press: wake up (the board restarts).
//   KEY3 (19)   story      tap: pause / play. Double-tap: skip. Hold: replay the last story.
//   MTDI (12)   volume     tap: up. Hold: down, repeating while held.
//
// KEY1 is the power key because 36 can wake the chip from deep sleep and 19 can't. Sleep
// isn't off: the codec, amplifier and display backlight stay powered, so a real switch on
// the battery is still the way to store the pet.
//
// MTDI is wired to 3.3 V rather than ground: GPIO 12 must be LOW at power-on or the board
// won't boot, so it's pulled down and reads HIGH when pressed. Don't hold it while powering
// on or pressing RST.
//
// With the phone connected, KEY3's tap and double-tap go to the app as a pat / double-pat,
// so the app stays in charge of the journey; without it the pet does them itself.
#define HOLD_MS 700
#define SLEEP_HOLD_MS 2000
#define DOUBLE_TAP_MS 350
#define REPEAT_MS 400
#define DEBOUNCE_MS 30
#define KEY_COUNT 3
enum { KEY_POWER, KEY_STORY, KEY_VOLUME };

struct PetKey {
  const char* name;
  uint8_t pin;
  bool activeHigh;  // MTDI: pressed = HIGH
  uint32_t holdMs;
  bool down;
  bool held;        // the hold already fired (or the key was down at boot): no tap on release
  uint32_t changedAt;
  uint32_t repeatAt;
  uint32_t tapAt;   // a first tap waiting to see if a second follows (0 = none)
};
PetKey petKeys[KEY_COUNT] = {
  { "KEY1", 36, false, SLEEP_HOLD_MS },
  { "KEY3", 19, false, HOLD_MS },
  { "MTDI", 12, true, HOLD_MS },
};
bool speakerOn = true;

bool keyIsDown(int i) {
  const PetKey& k = petKeys[i];
  return digitalRead(k.pin) == (k.activeHigh ? HIGH : LOW);
}

// Called in setup(): a key that's already down (KEY1, still held from waking the pet up)
// must not count as a press, or the wake-up press would put it straight back to sleep.
void keysBegin() {
  pinMode(12, INPUT_PULLDOWN);
  for (PetKey& k : petKeys) {
    k.down = keyIsDown(&k - petKeys);
    k.held = k.down;
  }
}

void stepVolume(float step) {
  volume = constrain(volume + step, 0.0f, 1.0f);
  kit.setVolume(volume);
  kit.setSpeakerActive(speakerOn);
  Serial.printf("Volume %.1f, speaker %s\n", volume, speakerOn ? "on" : "off");
}

void goToSleep() {
  Serial.println("Going to sleep. Press KEY1 to wake up.");
  transportRequested = CMD_STOP;
  delay(200);  // let the audio task stop the story
  kit.setSpeakerActive(false);
  screenSleep(true);
  while (keyIsDown(KEY_POWER)) delay(10);  // a held key would wake it at once
  delay(50);
  esp_sleep_enable_ext0_wakeup(GPIO_NUM_36, 0);  // KEY1 pulls 36 low
  esp_deep_sleep_start();
}

void storyTap(bool doubleTap) {
  bool playing = state == STATE_PLAYING || state == STATE_PAUSED;
  if (doubleTap) {
    if (connected) notifyInput(INPUT_DOUBLE_PAT);
    else if (playing) transportRequested = CMD_STOP;
  } else {
    if (connected) notifyInput(INPUT_PAT);
    else if (playing) transportRequested = state == STATE_PLAYING ? CMD_PAUSE : CMD_RESUME;
    react(MOOD_HEART_EYES, 1500);
  }
}

void keyTap(int i, uint32_t now) {
  poke();
  if (i == KEY_STORY) {
    PetKey& k = petKeys[i];
    if (k.tapAt) {  // second tap in time: skip
      k.tapAt = 0;
      storyTap(true);
    } else {
      k.tapAt = now;  // wait to see if a second tap follows
    }
  } else if (i == KEY_VOLUME) {
    stepVolume(0.1f);
  }
  // KEY1 tap does nothing while awake (pressing it only matters to wake the pet).
}

void keyHold(int i) {
  poke();
  if (i == KEY_POWER) {
    goToSleep();
  } else if (i == KEY_STORY && lastStoryId.length()) {
    Serial.printf("Replay %s\n", lastStoryId.c_str());
    requestPlay(lastStoryId);
  } else if (i == KEY_VOLUME) {
    stepVolume(-0.1f);
  }
}

void readKeys(uint32_t now) {
  // KEY1 + KEY3 held together for 3 s: restart, like the RST button (which a case hides).
  // While both are down, neither key's own tap or hold counts.
  static uint32_t comboAt = 0;
  if (keyIsDown(KEY_POWER) && keyIsDown(KEY_STORY)) {
    if (!comboAt) comboAt = now;
    petKeys[KEY_POWER].held = petKeys[KEY_STORY].held = true;
    petKeys[KEY_STORY].tapAt = 0;
    if (now - comboAt > 3000) {
      Serial.println("Restarting (KEY1 + KEY3)");
      delay(50);
      ESP.restart();
    }
  } else {
    comboAt = 0;
  }
  for (int i = 0; i < KEY_COUNT; i++) {
    PetKey& k = petKeys[i];
    bool down = keyIsDown(i);
    if (down != k.down && now - k.changedAt > DEBOUNCE_MS) {
      k.down = down;
      k.changedAt = now;
      if (down) {
        k.held = false;
      } else if (!k.held) {
        keyTap(i, now);  // released before it counted as a hold
      }
    } else if (k.down && !k.held && now - k.changedAt > k.holdMs) {
      k.held = true;
      k.tapAt = 0;
      k.repeatAt = now + REPEAT_MS;
      keyHold(i);
    } else if (i == KEY_VOLUME && k.down && k.held && now >= k.repeatAt) {
      k.repeatAt = now + REPEAT_MS;  // volume keeps going down while MTDI is held
      keyHold(i);
    }
    if (k.tapAt && !k.down && now - k.tapAt > DOUBLE_TAP_MS) {
      k.tapAt = 0;  // no second tap came: it was a single tap
      storyTap(false);
    }
  }
}

void runCommand(String line) {
  line.trim();
  poke();
  if (line.startsWith("play ")) requestPlay(line.substring(5));
  else if (line == "stop") transportRequested = CMD_STOP;
  else if (line == "pause") transportRequested = CMD_PAUSE;
  else if (line == "resume") transportRequested = CMD_RESUME;
  else if (line == "ls") listStories();
  else if (line.startsWith("vol ")) {
    volume = constrain(line.substring(4).toFloat(), 0.0f, 1.0f);
    kit.setVolume(volume);
    Serial.printf("Volume %.1f\n", volume);
  } else if (line == "+" || line == "-") {
    // Same as bt_speaker_test: one step of 0.1 (also switches the speaker amp back on).
    stepVolume(line == "+" ? 0.1f : -0.1f);
  } else if (line == "p") notifyInput(INPUT_PAT);
  else if (line == "d") notifyInput(INPUT_DOUBLE_PAT);
  else if (line == "screen") screenReinit = true;
  else if (line == "screen invert on" || line == "screen invert off") {
    screenSetInvert(line.endsWith("on"));
    screenRedrawAll();  // the next draw clears the screen and draws everything, face included
    Serial.printf("Colour inversion %s (remembered)\n", line.endsWith("on") ? "on" : "off");
  }
  else if (line.startsWith("mood ")) {
    // Try a face for 5 s: 0 Angry, 1 Annoyed, 2 Bored, 3 Heart_Eyes, 4 Normal, 5 Sad, 6 Sleepy
    int mood = constrain(line.substring(5).toInt(), 0, FACE_ANIMATION_COUNT - 1);
    react(mood, 5000);
    Serial.printf("Mood: %s\n", FACE_ANIMATIONS[mood].name);
  }
  else if (line == "s") Serial.printf("connected=%d state=%u position=%us / %us\n", connected, state, positionS(), durationS);
  else if (line == "help" || line == "?") printHelp();
  else Serial.printf("Unknown command: %s (type help)\n", line.c_str());
}

// ---------- Face animation ----------
int faceMood = MOOD_NORMAL;
uint8_t faceFrame = 0;
uint32_t frameAt = 0;
uint32_t nextBlink = 0;
bool blinking = false;
bool screenAsleep = false;
const uint8_t* shownFace = nullptr;

int currentMood(uint32_t now) {
  int o = moodOverride;
  if (o >= 0 && (int32_t)(overrideUntil - now) > 0) return o;
  moodOverride = -1;
  if (state == STATE_PLAYING || state == STATE_PAUSED) return MOOD_NORMAL;
  uint32_t idle = now - lastActivity;
  if (idle > SLEEPY_AFTER_MS) return MOOD_SLEEPY;
  if (idle > BORED_AFTER_MS) return MOOD_BORED;
  return MOOD_NORMAL;
}

// Returns the frame to show now. Normal holds its first frame and blinks every few
// seconds (cheap while audio plays); every other mood loops its frames.
const uint8_t* faceFrameNow(uint32_t now) {
  int mood = currentMood(now);
  const FaceAnimation& anim = FACE_ANIMATIONS[mood];
  if (mood != faceMood) {
    faceMood = mood;
    faceFrame = 0;
    frameAt = now;
    blinking = false;
    nextBlink = now + 2500;
  }
  if (mood == MOOD_NORMAL) {
    if (!blinking && (int32_t)(now - nextBlink) >= 0) {
      blinking = true;
      faceFrame = 0;
      frameAt = now;
    }
    if (blinking && now - frameAt >= FRAME_MS) {
      frameAt = now;
      if (++faceFrame >= anim.frameCount) {
        faceFrame = 0;
        blinking = false;
        nextBlink = now + 3000 + random(3000);
      }
    }
  } else if (now - frameAt >= FRAME_MS * 2) {
    frameAt = now;
    faceFrame = (faceFrame + 1) % anim.frameCount;
  }
  return anim.frames[faceFrame];
}

// Lab mode: while the pet screen lab (/lab) is sending, its frames own the screen. It ends
// with "lab off" from the lab, or by itself 15 s after the last frame.
#define LAB_IDLE_MS 15000
bool labActive = false;
uint32_t labLastAt = 0;

// The lab can move the link to a faster baud rate. If it doesn't say hello at the new rate
// within 3 s (its port couldn't follow), the pet goes back to the default.
uint32_t serialBaud = SERIAL_BAUD;
bool labBaudConfirmed = true;
uint32_t labBaudDeadline = 0;
void labBaud(uint32_t baud) {
  if (baud < 9600 || baud > 5000000) return;
  Serial.printf("LABBAUD %lu\n", (unsigned long)baud);
  Serial.flush();
  delay(20);
  Serial.updateBaudRate(baud);
  serialBaud = baud;
  labBaudConfirmed = baud == SERIAL_BAUD;
  labBaudDeadline = millis() + 3000;
}

void labEnd() {
  if (!labActive) return;
  labActive = false;
  clipFree();
  screenLabEnd();
  shownFace = nullptr;  // so the face is drawn again
  Serial.println("Lab mode off");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialLine.endsWith("lab hello")) {
        labBaudConfirmed = true;
        Serial.printf("LABHELLO %s psram=%lu baud=%lu\n", PET_SCREEN_OLED ? "oled" : "tft",
                      (unsigned long)(psramFound() ? ESP.getFreePsram() : 0), (unsigned long)serialBaud);
      } else if (serialLine.endsWith("lab off")) labEnd();
      else if (serialLine == "lab ping") labLastAt = millis();
      else if (serialLine.startsWith("lab baud ")) labBaud(serialLine.substring(9).toInt());
      else if (serialLine.startsWith("lab ") && labCommand(serialLine)) labLastAt = millis();
      else if (serialLine.startsWith("media ") && mediaCommand(serialLine)) poke();
      else if (serialLine.length()) runCommand(serialLine);
      serialLine = "";
    } else {
      serialLine += c;
      if (serialLine.length() > 200) serialLine.remove(0, serialLine.length() - 8);  // junk, not a command
      // A frame from the lab: the rest is binary. endsWith, not ==, so a stray byte before it
      // (boot noise, the tail of a broken frame) can't make the pet miss every frame after.
      if (serialLine.endsWith("PIFL")) {
        serialLine = "";
        if (!labActive) Serial.println("Lab mode on");
        labActive = true;
        if (screenAsleep) {
          screenSleep(false);
          screenAsleep = false;
        }
        clipStop();  // a live frame takes over from a playing clip (which stays loaded)
        screenLabFrame();
        labLastAt = millis();
        poke();
      } else if (serialLine.endsWith("PIFF")) {  // a file for the SD card's /media folder
        serialLine = "";
        mediaReceive();
        poke();
      } else if (serialLine.endsWith("PIFC")) {  // a whole clip to keep and play
        serialLine = "";
        if (!labActive) Serial.println("Lab mode on");
        labActive = true;
        if (screenAsleep) {
          screenSleep(false);
          screenAsleep = false;
        }
        labClipReceive();
        labLastAt = millis();
        poke();
      }
    }
  }

  readKeys(millis());

  static bool mediaShown = false;
  if (media.playing) {
    mediaShown = true;
    mediaTick();
    poke();
    delay(1);
    return;
  }
  if (mediaShown) {
    mediaShown = false;
    mediaFree();
    if (!labActive) {
      screenLabEnd();
      shownFace = nullptr;  // so the face is drawn again
    }
  }

  if (labActive) {
    clipTick();
    // A playing clip keeps lab mode on; otherwise it ends 15 s after the lab goes quiet.
    if (!clip.playing && millis() - labLastAt > LAB_IDLE_MS) labEnd();
    if (!labBaudConfirmed && millis() > labBaudDeadline) labBaud(SERIAL_BAUD);  // lab didn't follow: go back
    poke();
    delay(1);
    return;
  }

  uint8_t parts = 0;
  if (playbackChanged) {
    playbackChanged = false;
    notifyPlayback();
    parts |= PART_PROGRESS;
  }
  if (statusDirty) {
    statusDirty = false;
    parts |= PART_STATUS;
  }
  if (textDirty) {
    textDirty = false;
    parts |= PART_TEXT;
  }
  uint32_t now = millis();
  bool playing = state == STATE_PLAYING || state == STATE_PAUSED;
  // Long idle: screen off. Any activity (a write from the app, a command) wakes it.
  if (!screenAsleep && !playing && now - lastActivity > SCREEN_OFF_MS) {
    screenSleep(true);
    screenAsleep = true;
  } else if (screenAsleep && now - lastActivity < SCREEN_OFF_MS) {
    screenSleep(false);
    screenAsleep = false;
    parts = PART_ALL;
  }
  if (screenAsleep) {
    delay(20);
    return;
  }

  const uint8_t* face = faceFrameNow(now);
  if (face != shownFace) {
    shownFace = face;
    parts |= PART_FACE;
  }
  if (screenReinit) {
    screenReinit = false;
    screenBegin();
    parts = PART_ALL;
  }
  if (parts) {
    ScreenModel m = { connected, shownPlace, shownTitle, (uint8_t)state, positionS(), durationS, shownFace, (uint8_t)faceMood };
    screenDraw(m, parts);
  }
  delay(10);
}
