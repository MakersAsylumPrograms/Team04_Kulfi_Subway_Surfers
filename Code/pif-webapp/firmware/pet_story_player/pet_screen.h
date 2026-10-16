// The pet's screen, for either display:
//   - ST7789 2.4" colour TFT on SPI (the primary display), or
//   - SH1106 1.3" 128x64 OLED on I2C (the test display),
// chosen by PET_SCREEN_OLED at the top of pet_story_player.ino. The sketch only calls
// screenBegin(), screenDraw() and screenSleep(); everything display-specific lives here.
// The TFT shows the pet's face (faces.h, generated from the PNGs) with a caption under it;
// the OLED is a text-only test display.

#pragma once
#include <Arduino.h>
#include "faces.h"

struct ScreenModel {
  bool connected;
  String place;
  String title;
  uint8_t state;      // PlaybackState from the protocol
  uint16_t positionS;
  uint32_t durationS;
  const uint8_t* face;  // current face frame (faces.h), or nullptr
  uint8_t mood;         // FaceMood (faces.h): each mood has its own colour
};

// Which parts changed, so the TFT can redraw only those (big redraws cause audio clicks).
enum ScreenPart : uint8_t { PART_STATUS = 1, PART_TEXT = 2, PART_PROGRESS = 4, PART_FACE = 8 };
#define PART_ALL (PART_STATUS | PART_TEXT | PART_PROGRESS | PART_FACE)

#if PET_SCREEN_OLED
// ======================= SH1106 OLED (I2C, test display) =======================
// Wiring: VCC 3.3 V, GND, SDA -> IO18, SCL -> IO23. The codec's own I2C pins (32/33) aren't
// on this board's headers, so the OLED gets the ESP32's second I2C bus on two header pins
// the TFT would otherwise use. Library: U8g2.
#define OLED_SDA 18
#define OLED_SCL 23
#include <Wire.h>
#include <U8g2lib.h>

// U8g2's own "2ND_HW_I2C" mode is compiled out on ESP32 (it checks WIRE_INTERFACES_COUNT,
// which the ESP32 core doesn't define), so this small byte driver sends to Wire1 itself,
// leaving Wire (pins 33/32) to the codec.
static uint8_t oledByteWire1(u8x8_t* u8x8, uint8_t msg, uint8_t argInt, void* argPtr) {
  switch (msg) {
    case U8X8_MSG_BYTE_INIT:
    case U8X8_MSG_BYTE_SET_DC:
      break;  // Wire1 is started in screenBegin()
    case U8X8_MSG_BYTE_START_TRANSFER:
      Wire1.beginTransmission(u8x8_GetI2CAddress(u8x8) >> 1);
      break;
    case U8X8_MSG_BYTE_SEND:
      Wire1.write((const uint8_t*)argPtr, argInt);
      break;
    case U8X8_MSG_BYTE_END_TRANSFER:
      Wire1.endTransmission();
      break;
    default:
      return 0;
  }
  return 1;
}

class OledOnWire1 : public U8G2 {
 public:
  OledOnWire1() {
    u8g2_Setup_sh1106_i2c_128x64_noname_f(&u8g2, U8G2_R0, oledByteWire1, u8x8_gpio_and_delay_arduino);
  }
};

OledOnWire1 oled;

void screenBegin() {
  // Called after the audio board starts, which sets 18/23 up as onboard-key inputs;
  // starting Wire1 here takes them over as I2C.
  Wire1.begin(OLED_SDA, OLED_SCL, 400000);
  oled.begin();
  oled.setFont(u8g2_font_6x10_tf);
}

// Prints text wrapped at spaces, up to maxLines lines of 21 characters; returns next y.
static int oledWrapped(const String& text, int y, int maxLines, int lineH) {
  int start = 0, lines = 0;
  const int perLine = 21;
  while (start < (int)text.length() && lines < maxLines) {
    int end = min((int)text.length(), start + perLine);
    if (end < (int)text.length()) {
      int space = text.lastIndexOf(' ', end);
      if (space > start) end = space;
    }
    oled.drawStr(0, y, text.substring(start, end).c_str());
    y += lineH;
    lines++;
    start = end;
    while (start < (int)text.length() && text[start] == ' ') start++;
  }
  return y;
}

void screenDraw(const ScreenModel& m, uint8_t) {
  // 128x64 is small enough to redraw whole: about 1 KB over I2C.
  oled.clearBuffer();
  oled.setFont(u8g2_font_6x10_tf);
  oled.drawStr(0, 9, "Jam Pet");
  oled.drawStr(m.connected ? 74 : 68, 9, m.connected ? "connected" : "waiting..");
  oled.drawHLine(0, 12, 128);
  if (m.place.length() == 0) {
    oled.drawStr(0, 36, "Waiting for the app.");
  } else {
    int y = oledWrapped(m.place, 25, 2, 11);
    oledWrapped(m.title, y + 1, 2, 10);
  }
  if (m.state == 1 || m.state == 2) {  // playing or paused
    int w = m.durationS ? (int)(126L * m.positionS / m.durationS) : 0;
    oled.drawFrame(0, 57, 128, 7);
    oled.drawBox(1, 58, min(w, 126), 5);
  } else if (m.state == 3) {
    oled.drawStr(0, 63, "not on SD: phone plays");
  }
  oled.sendBuffer();
}

void screenSleep(bool sleep) { oled.setPowerSave(sleep ? 1 : 0); }
void screenRedrawAll() {}
void screenStartup() {}
void screenStartupFadeOut() {}
void screenSetInvert(bool) {}
bool screenLabFrame() {  // the lab needs the colour TFT
  Serial.println("LABERR the lab needs the TFT build");
  return false;
}
void screenLabEnd() {}

#else
// ======================= ST7789 TFT (SPI, primary display) =======================
// Wiring: SCK 18, SDI/MOSI 23, CS 5, DC 22, RESET -> 3.3 V, LED 3.3 V, VCC 3.3 V, GND.
// The header only offers 21, 22, 19, 23, 18 (+ IO0, TX, RX): 21 is the speaker amp switch and
// 19 doesn't work (onboard KEY3), so DC takes 22 (the onboard LED pin; it just flickers) and
// RESET is tied high, with the library resetting the screen in software instead.
// Library: Adafruit ST7735 and ST7789 Library (+ Adafruit GFX).
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <Preferences.h>
#include <Fonts/FreeSans9pt7b.h>
#include <Fonts/FreeSans12pt7b.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold24pt7b.h>

// The display has its own SPI bus: clock 18, data 23, CS 5, DC 22. RESET goes to the
// board's EN/RST pin, so the screen resets with the board. (It shared the SD card's bus on
// MTMS/MTDO for a day, 2026-10-05: the extra wiring on the card's lines made the card
// unreadable, so it's back on its own pins. 18 and 23 were onboard KEY5 and KEY4.)
#define TFT_SCK  18
#define TFT_MOSI 23
#define TFT_CS   5
#define TFT_DC   22
#define TFT_RST  -1
// The pet's look: white background, near-black text, grey for secondary text, and one red
// (the face, "NOW PLAYING", the progress bar, the connection dot). Held upright.
#define PET_ROTATION 2   // upright (portrait, 240x320); 0 is upright the other way up
#define BG     0xFFFF    // white
#define INK    0x18E3    // #1C1C1C
#define DIM    0x8C51    // #8A8A8A
#define ACCENT 0xE1C6    // red, #E53935
#define TRACK  0xE73C    // #E6E6E6, the empty part of the progress bar

// Colours, for character and stories (all dark enough to read on white in sunlight).
#define C_RED    0xE1C6  // #E53935
#define C_ORANGE 0xFC60  // #FB8C00
#define C_GREEN  0x4508  // #43A047
#define C_TEAL   0x044F  // #00897B
#define C_BLUE   0x1C5C  // #1E88E5
#define C_PURPLE 0x8935  // #8E24AA
#define C_PINK   0xD8CC  // #D81B60

// Each mood has its own colour (order of FaceMood in faces.h: Angry, Annoyed, Bored,
// Heart_Eyes, Normal, Sad, Sleepy).
static const uint16_t MOOD_COLOUR[] = { C_RED, C_ORANGE, C_TEAL, C_PINK, C_RED, C_BLUE, C_PURPLE };

// Each story gets a colour of its own, picked from its place name, so the same place is always
// the same colour.
static const uint16_t STORY_COLOURS[] = { C_RED, C_ORANGE, C_GREEN, C_TEAL, C_BLUE, C_PURPLE, C_PINK };
static uint16_t storyColour(const String& place) {
  uint32_t h = 5381;
  for (size_t i = 0; i < place.length(); i++) h = h * 33 + (uint8_t)place[i];
  return STORY_COLOURS[h % (sizeof(STORY_COLOURS) / sizeof(STORY_COLOURS[0]))];
}

// HSPI here, because the SD card already uses the default SPI object (on 14, 2, 15).
SPIClass tftSpi(HSPI);
Adafruit_ST7789 tft = Adafruit_ST7789(&tftSpi, TFT_CS, TFT_DC, TFT_RST);

void screenBegin() {
  tftSpi.begin(TFT_SCK, -1, TFT_MOSI, TFT_CS);
  // 20 MHz instead of the library's faster default: jumper wires pick up noise, and one
  // corrupted command can blank the screen (it goes white).
  tft.setSPISpeed(20000000);
  tft.init(240, 320);
  // The library switches colour inversion on (most ST7789 panels need it); ours doesn't,
  // and with it on, black shows white and cyan shows red.
  // Colour inversion: panels differ (with the wrong setting, white shows black and red shows
  // cyan). "screen invert on|off" sets it and the pet remembers it.
  Preferences prefs;
  prefs.begin("pet", true);
  tft.invertDisplay(prefs.getBool("invert", false));
  prefs.end();
  tft.setRotation(PET_ROTATION);
  tft.fillScreen(0x0000);  // black while it starts; screenStartup() fades the picture in
}

void screenSetInvert(bool on) {
  Preferences prefs;
  prefs.begin("pet", false);
  prefs.putBool("invert", on);
  prefs.end();
  tft.invertDisplay(on);
}

// Startup: the mascot over "JAM" on teal (startup_image.h, made by scripts/convert-startup.mjs),
// faded up from black; later it fades to the white of the pet's screen. The backlight is wired
// straight to 3.3 V, so the picture fades rather than the light: each step mixes every pixel
// toward black or white and repaints the whole screen (~60 ms at 20 MHz), so few steps, no pauses.
#include "startup_image.h"

// k: how much of the picture (0..256), the rest black or white.
static void drawStartupMix(uint16_t k, bool towardWhite) {
  static uint16_t row[STARTUP_W];
  const int tr = towardWhite ? 31 : 0, tg = towardWhite ? 63 : 0, tb = towardWhite ? 31 : 0;
  tft.startWrite();
  tft.setAddrWindow(0, 0, STARTUP_W, STARTUP_H);
  for (int y = 0; y < STARTUP_H; y++) {
    for (int x = 0; x < STARTUP_W; x++) {
      uint16_t c = pgm_read_word(&STARTUP_IMAGE[y * STARTUP_W + x]);
      if (k < 256) {
        int r = tr + (((int)(c >> 11) - tr) * k >> 8);
        int g = tg + (((int)((c >> 5) & 63) - tg) * k >> 8);
        int b = tb + (((int)(c & 31) - tb) * k >> 8);
        c = (r << 11) | (g << 5) | b;
      }
      row[x] = c;
    }
    tft.writePixels(row, STARTUP_W);
  }
  tft.endWrite();
}

void screenStartup() {
  tft.setRotation(PET_ROTATION);
  const uint16_t steps[] = { 70, 140, 205, 256 };
  for (uint16_t k : steps) drawStartupMix(k, false);
}

void screenStartupFadeOut() {
  const uint16_t steps[] = { 200, 140, 85, 40, 0 };
  for (uint16_t k : steps) drawStartupMix(k, true);
}

// Two screens, upright 240x320, on white:
//
//   Pet (between stories): "Jam" and the connection dot along the top, the face (198x155) in
//   the middle, and under it the place (bold) and a status or the title (grey).
//
//   Story (while a story plays or is paused): "NOW PLAYING" (red) or "PAUSED" (grey), the place
//   large, the title under it, then a progress bar with elapsed and total time at the bottom.
//
// The dot in the top-right corner is red while the phone is connected, light grey when not.
#define SCREEN_W 240
#define SCREEN_H 320
#define MARGIN 16
#define FACE_X ((SCREEN_W - FACE_W) / 2)
#define FACE_Y 46

static void drawFace(const uint8_t* frame, uint16_t colour) {
  // Rows of run lengths: background, lit, background, lit … (see faces.h). Drawn in slices
  // of 16 rows, letting go of the bus between them so nothing else waits long.
  const uint8_t* p = frame;
  tft.startWrite();
  for (int y = 0; y < FACE_H; y++) {
    if (y && y % 16 == 0) {
      tft.endWrite();
      tft.startWrite();
    }
    int x = 0;
    bool lit = false;
    while (x < FACE_W) {
      uint8_t len = pgm_read_byte(p++);
      if (len) tft.writeFastHLine(FACE_X + x, FACE_Y + y, len, lit ? colour : BG);
      x += len;
      lit = !lit;
    }
  }
  tft.endWrite();
}

static int textWidth(const String& t) {
  int16_t x1, y1;
  uint16_t w, h;
  tft.getTextBounds(t, 0, 0, &x1, &y1, &w, &h);
  return w;
}

// Cuts a line to fit a width, ending in "..." when it had to be cut.
static String fitLine(String t, int maxW) {
  if (textWidth(t) <= maxW) return t;
  while (t.length() > 1 && textWidth(t + "...") > maxW) t.remove(t.length() - 1);
  return t + "...";
}

static void centred(const GFXfont* font, const String& t, int baseline, uint16_t color) {
  tft.setFont(font);
  tft.setTextColor(color);
  String line = fitLine(t, tft.width() - 2 * MARGIN);
  tft.setCursor((tft.width() - textWidth(line)) / 2, baseline);
  tft.print(line);
}

// Word-wraps text into at most maxLines lines; returns the next baseline. centre = each line
// centred on the screen (x is then ignored).
static int wrapped(const GFXfont* font, const String& text, int x, int baseline, int maxW, int lineH,
                   int maxLines, uint16_t color, bool centre = false) {
  tft.setFont(font);
  tft.setTextColor(color);
  int start = 0, lines = 0;
  while (start < (int)text.length() && lines < maxLines) {
    // Take as many words as fit.
    int end = start, best = -1;
    while (end <= (int)text.length()) {
      int next = text.indexOf(' ', end);
      if (next < 0) next = text.length();
      if (textWidth(text.substring(start, next)) > maxW) break;
      best = next;
      if (next >= (int)text.length()) break;
      end = next + 1;
    }
    if (best < 0) best = text.indexOf(' ', start) < 0 ? text.length() : text.indexOf(' ', start);
    String line = text.substring(start, best);
    bool last = lines == maxLines - 1 && best < (int)text.length();
    String shown = last ? fitLine(line + " " + text.substring(best + 1), maxW) : fitLine(line, maxW);
    tft.setCursor(centre ? (tft.width() - textWidth(shown)) / 2 : x, baseline);
    tft.print(shown);
    baseline += lineH;
    lines++;
    start = best + 1;
  }
  return baseline;
}

static String clock(uint32_t s) {
  char buf[8];
  snprintf(buf, sizeof(buf), "%u:%02u", (unsigned)(s / 60), (unsigned)(s % 60));
  return String(buf);
}

static int lastStory = -1;  // -1: next draw clears the screen and draws everything

void screenRedrawAll() { lastStory = -1; }

// The top bar: "Jam" on the left, the connection dot on the right.
static void drawTopBar(bool connected, bool wordmark, uint16_t dotOn = C_GREEN, uint16_t dotOff = TRACK) {
  if (wordmark) {
    // "Jam", one colour per letter: the object's name, not just its face.
    static const uint16_t letters[] = { C_RED, C_ORANGE, C_BLUE };
    tft.setFont(&FreeSansBold18pt7b);
    tft.setCursor(MARGIN, 36);
    const char* word = "Jam";
    for (int i = 0; i < 3; i++) {
      tft.setTextColor(letters[i]);
      tft.print(word[i]);
    }
  }
  tft.fillCircle(SCREEN_W - MARGIN - 4, 22, 5, connected ? dotOn : dotOff);
}

void screenDraw(const ScreenModel& m, uint8_t parts) {
  bool story = m.state == 1 || m.state == 2;  // playing or paused
  bool paused = m.state == 2;
  if ((int)story != lastStory) {
    lastStory = story;
    tft.fillScreen(BG);
    parts = PART_ALL;
  }

  uint16_t colour = storyColour(m.place);
  if (story) {
    if (parts & (PART_TEXT | PART_PROGRESS | PART_STATUS)) {
      // A band in the story's colour (grey when paused), with the label and the dot on it.
      uint16_t band = paused ? DIM : colour;
      tft.fillRect(0, 0, SCREEN_W, 46, band);
      tft.setFont(&FreeSansBold9pt7b);
      tft.setTextColor(BG);
      tft.setCursor(MARGIN, 29);
      tft.print(paused ? "PAUSED" : "NOW PLAYING");
      drawTopBar(m.connected, false, BG, band == DIM ? TRACK : DIM);
    }
    if (parts & PART_TEXT) {
      tft.fillRect(0, 46, SCREEN_W, 216, BG);
      int next = wrapped(&FreeSansBold18pt7b, m.place, MARGIN, 82, SCREEN_W - 2 * MARGIN, 34, 3, INK);
      wrapped(&FreeSans12pt7b, m.title, MARGIN, next + 8, SCREEN_W - 2 * MARGIN, 24, 4, DIM);
    }
    if (parts & PART_PROGRESS) {
      int barW = SCREEN_W - 2 * MARGIN;
      int w = m.durationS ? (int)((long)barW * m.positionS / m.durationS) : 0;
      w = min(max(w, 0), barW);
      tft.fillRoundRect(MARGIN, 270, barW, 6, 3, TRACK);
      if (w > 0) tft.fillRoundRect(MARGIN, 270, max(w, 6), 6, 3, paused ? DIM : colour);
      tft.fillRect(0, 282, SCREEN_W, 38, BG);
      tft.setFont(&FreeSans9pt7b);
      tft.setTextColor(DIM);
      tft.setCursor(MARGIN, 302);
      tft.print(clock(m.positionS));
      String total = clock(m.durationS);
      tft.setCursor(SCREEN_W - MARGIN - textWidth(total), 302);
      tft.print(total);
    }
  } else {
    if (parts & PART_STATUS) drawTopBar(m.connected, false);
    if (parts & PART_FACE) {
      if (m.face) drawFace(m.face, MOOD_COLOUR[m.mood < 7 ? m.mood : 4]);
      else tft.fillRect(FACE_X, FACE_Y, FACE_W, FACE_H, BG);
    }
    if (parts & (PART_TEXT | PART_PROGRESS)) {
      int top = FACE_Y + FACE_H + 4;
      tft.fillRect(0, top, SCREEN_W, SCREEN_H - top, BG);
      if (m.place.length() == 0) {
        wrapped(&FreeSans12pt7b, m.connected ? "Connected" : "Waiting for your phone", 0, 248,
                SCREEN_W - 2 * MARGIN, 26, 2, DIM, true);
      } else {
        int next = wrapped(&FreeSansBold12pt7b, m.place, 0, 244, SCREEN_W - 2 * MARGIN, 26, 2, INK, true);
        String line2 = m.state == 3 ? String("Not on the SD card: the phone plays it") : m.title;
        if (line2.length()) wrapped(&FreeSans9pt7b, line2, 0, next + 2, SCREEN_W - 2 * MARGIN, 20, 2, DIM, true);
      }
    }
  }
  tft.setFont(nullptr);
}

// ---------- Lab mode: the pet screen lab (/lab) draws on this screen over USB ----------
// The lab sends a frame as "PIFL" and a binary body; the sketch sees the "PIFL" and calls
// screenLabFrame() to read the rest. All numbers little-endian:
//   u8 rotation (0-3), u8 flags (bit 0: clear the screen first), u16 span count, then per span:
//   u16 x, u16 y, u16 width, u8 mode (0 raw, 1 run-length), u16 byte count, the bytes.
//   raw: width colours as u16 RGB565.  run-length: (u8 count, u16 colour) pairs.
// Spans are pieces of rows that changed since the last frame, so small changes are quick.
// The pet answers "LABOK" after each frame and the lab waits for it before sending the next,
// so the serial buffer never overflows.
#define LAB_MAX_W 320

static bool readExact(uint8_t* buf, size_t n) { return Serial.readBytes(buf, n) == n; }
static uint16_t u16le(const uint8_t* b) { return b[0] | (b[1] << 8); }

bool screenLabFrame() {
  static uint8_t buf[LAB_MAX_W * 3];
  static uint16_t line[LAB_MAX_W];
  Serial.setTimeout(1000);
  uint8_t head[4];
  if (!readExact(head, 4)) { Serial.println("LABERR header"); return false; }
  if (tft.getRotation() != (head[0] & 3)) {
    tft.setRotation(head[0] & 3);
    tft.fillScreen(0x0000);
  }
  if (head[1] & 1) tft.fillScreen(0x0000);
  uint16_t spans = u16le(head + 2);
  for (uint16_t i = 0; i < spans; i++) {
    uint8_t sh[9];
    if (!readExact(sh, 9)) { Serial.println("LABERR span"); return false; }
    uint16_t x = u16le(sh), y = u16le(sh + 2), w = u16le(sh + 4), len = u16le(sh + 7);
    uint8_t mode = sh[6];
    if (w == 0 || w > LAB_MAX_W || len > sizeof(buf) || !readExact(buf, len)) {
      Serial.println("LABERR data");
      return false;
    }
    if (mode == 0) {
      for (uint16_t k = 0; k < w && k * 2 + 1 < len; k++) line[k] = u16le(buf + k * 2);
    } else {
      uint16_t k = 0;
      for (uint16_t j = 0; j + 2 < len && k < w; j += 3)
        for (uint8_t c = 0; c < buf[j] && k < w; c++) line[k++] = u16le(buf + j + 1);
    }
    tft.startWrite();
    tft.setAddrWindow(x, y, w, 1);
    tft.writePixels(line, w);
    tft.endWrite();
  }
  Serial.println("LABOK");
  return true;
}

// Back to the pet's own screens.
void screenLabEnd() {
  tft.setRotation(PET_ROTATION);
  tft.fillScreen(BG);
  lastStory = -1;
}

// Screen off (after long idle) and back on. The backlight is wired straight to 3.3 V, so
// "off" is the panel's own sleep mode plus a black screen.
void screenSleep(bool sleep) {
  if (sleep) {
    tft.fillScreen(0x0000);
    tft.enableSleep(true);
  } else {
    tft.enableSleep(false);
  }
}
#endif
