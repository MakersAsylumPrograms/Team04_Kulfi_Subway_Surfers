// Media from the SD card's /media folder: a video as MJPEG (one JPEG after another) with an
// optional WAV soundtrack, played together. The pet media dashboard (/media in the web app)
// lists, plays and adds them over USB; they can also be copied onto the card directly.
//
//   /media/<name>.mjpeg   the video (baseline JPEGs, back to back; ffmpeg -f mjpeg makes them)
//   /media/<name>.wav     its sound, 16-bit PCM, mono or stereo (optional)
//   /media/<name>.cfg     settings, one per line (optional): fps=15  rotation=2  fit=original
//                         x=-1  y=-1  loop=0  offset=0  top=Text above  bottom=Text below
//                         (fit: original | fit | cover | stretch; x/y -1 = centred, used with
//                          fit=original; offset ms, + = sound later; in top/bottom, "|" starts a
//                          new line)
//
// The video is loaded into PSRAM (up to ~3.5 MB) so the card is free to stream the sound.
// The sound is the clock: the frame on screen is the one that belongs at the sound's
// position, and frames that come due while one is still being decoded are skipped.
//
// Serial commands (answers start with MEDIA…):
//   media ls | media play <name> | media stop | media loop on|off | media fps <n>
//   media offset <ms> | media rotate <0-3> | media fit original|fit|cover|stretch | media rm <file>
//   media top <text> | media bottom <text>   (text above / below the picture; empty to clear)
//   "PIFF" + u8 name length + name + u32 size + bytes: save a file into /media
// While playing it reports "MEDIASTAT decode=<ms> skipped=<n> shown=<n>" every 2 s.
#pragma once
#include <JPEGDEC.h>

#define MEDIA_DIR "/media"

struct MediaPlayer {
  uint8_t* video = nullptr;
  uint32_t videoLen = 0;
  uint32_t* frames = nullptr;  // offset of each JPEG; frames[frameCount] = videoLen
  uint16_t frameCount = 0;
  float fps = 15;
  int x = -1, y = -1;
  uint8_t rotation = 2;
  // How a frame sits on the screen: 0 original size, 1 fit (whole frame, bars), 2 cover (fills,
  // edges cut off), 3 stretch (fills, shape changes).
  uint8_t fit = 0;
  int fw = 0, fh = 0;            // frame size
  int32_t sxq = 65536, syq = 65536;  // scale, 16.16 fixed point (dest px per frame px)
  int ox = 0, oy = 0;            // where the frame's top-left lands (can be off-screen for cover)
  bool loop = false;
  int32_t offsetMs = 0;
  String top, bottom;  // text above and below the picture, drawn once (no cost per frame)
  bool playing = false;
  bool hasAudio = false;
  uint32_t t0 = 0;
  int lastIdx = -1;
  String name;
  uint32_t decodeUs = 0, shown = 0, skipped = 0, statAt = 0;
};
MediaPlayer media;
static const char* const FIT_NAMES[] = { "original", "fit", "cover", "stretch" };

// Sound side, run by the audio task (pet_story_player.ino), which owns the codec.
volatile bool mediaAudioOn = false;
volatile bool mediaAudioBusy = false;
volatile bool mediaAudioRestart = false;
volatile uint32_t mediaAudioStartAt = 0;
volatile uint32_t mediaAudioFrom = 0;    // bytes into the sound to start at
volatile uint32_t mediaAudioPlayed = 0;  // bytes handed to the codec this pass
File mediaWav;
uint32_t mediaWavData = 0, mediaWavLen = 0, mediaWavRate = 22050, mediaWavByteRate = 44100;
uint16_t mediaWavChannels = 1;

static void mediaAudioCue(uint32_t t0) {
  if (!media.hasAudio) return;
  int32_t off = media.offsetMs;
  uint32_t align = mediaWavChannels * 2;
  mediaAudioFrom = off < 0 ? ((uint32_t)((uint64_t)(-off) * mediaWavByteRate / 1000) / align) * align : 0;
  mediaAudioStartAt = t0 + (off > 0 ? off : 0);
  mediaAudioRestart = true;
  mediaAudioOn = true;
}

void mediaAudioStop() {
  mediaAudioOn = false;
  while (mediaAudioBusy) delay(1);
}

void mediaStop() {
  media.playing = false;
  mediaAudioStop();
}

void mediaFree() {
  mediaStop();
  if (mediaWav) mediaWav.close();
  free(media.video);
  free(media.frames);
  media.video = nullptr;
  media.frames = nullptr;
  media.frameCount = 0;
}

// Finds the sound in a WAV file (walking its chunks); 16-bit PCM only.
static bool mediaOpenWav(const String& path) {
  if (mediaWav) mediaWav.close();
  mediaWav = SD.open(path);
  if (!mediaWav) return false;
  uint8_t h[12];
  if (mediaWav.read(h, 12) != 12 || memcmp(h, "RIFF", 4) || memcmp(h + 8, "WAVE", 4)) {
    Serial.printf("MEDIAERR %s isn't a WAV file\n", path.c_str());
    mediaWav.close();
    return false;
  }
  uint16_t format = 0, bits = 0;
  uint32_t pos = 12;
  while (pos + 8 <= mediaWav.size()) {
    char id[4];
    uint8_t sz[4];
    mediaWav.seek(pos);
    mediaWav.read((uint8_t*)id, 4);
    mediaWav.read(sz, 4);
    uint32_t size = sz[0] | (sz[1] << 8) | (sz[2] << 16) | ((uint32_t)sz[3] << 24);
    if (!memcmp(id, "fmt ", 4)) {
      uint8_t f[16];
      mediaWav.read(f, 16);
      format = f[0] | (f[1] << 8);
      mediaWavChannels = f[2] | (f[3] << 8);
      mediaWavRate = f[4] | (f[5] << 8) | (f[6] << 16) | ((uint32_t)f[7] << 24);
      mediaWavByteRate = f[8] | (f[9] << 8) | (f[10] << 16) | ((uint32_t)f[11] << 24);
      bits = f[14] | (f[15] << 8);
    } else if (!memcmp(id, "data", 4)) {
      mediaWavData = pos + 8;
      mediaWavLen = size;
      break;
    }
    pos += 8 + size + (size & 1);
  }
  if (format != 1 || bits != 16 || !mediaWavLen || !mediaWavByteRate) {
    Serial.printf("MEDIAERR %s: needs 16-bit PCM WAV\n", path.c_str());
    mediaWav.close();
    return false;
  }
  return true;
}

bool mediaPlay(const String& name);  // below
void mediaTick();

// The startup video: /media/startup.mjpeg (+ startup.wav, startup.cfg) plays once at power-on,
// before anything else. Returns when it's over (10 s at most); false if there isn't one.
bool mediaStartup() {
#if PET_SCREEN_OLED
  return false;
#else
  if (!SD.exists(String(MEDIA_DIR) + "/startup.mjpeg")) return false;
  if (!mediaPlay("startup")) return false;
  media.loop = false;
  uint32_t t0 = millis();
  while (media.playing && millis() - t0 < 10000) {
    mediaTick();
    delay(1);
  }
  mediaFree();
  return true;
#endif
}

// Plays a WAV on its own, with no picture (the startup sound). Quietly does nothing if the
// file isn't on the card. Uses the same path as a video's sound.
void mediaPlaySound(const String& path) {
  if (media.playing || !SD.exists(path)) return;
  if (!mediaOpenWav(path)) return;
  media.hasAudio = true;
  media.offsetMs = 0;
  mediaAudioCue(millis());
  Serial.printf("Playing %s\n", path.c_str());
}

#if PET_SCREEN_OLED
bool mediaPlay(const String&) {
  Serial.println("MEDIAERR video needs the TFT build");
  return false;
}
void mediaTick() {}
#else
JPEGDEC jpeg;

// Text in a band of the screen, centred both ways, word-wrapped; "|" starts a new line.
static void mediaTextBlock(const String& text, int y0, int y1, const GFXfont* font, uint16_t colour, int lineH) {
  if (!text.length() || y1 - y0 < lineH) return;
  tft.setFont(font);
  int maxW = tft.width() - 16;
  int maxLines = min(6, (y1 - y0) / lineH);
  String lines[6];
  int n = 0;
  int start = 0;
  while (start <= (int)text.length() && n < maxLines) {
    int bar = text.indexOf('|', start);
    String para = text.substring(start, bar < 0 ? text.length() : bar);
    para.trim();
    String line = "";
    int w = 0;
    while (w <= (int)para.length() && n < maxLines) {
      int sp = para.indexOf(' ', w);
      String word = para.substring(w, sp < 0 ? para.length() : sp);
      String tryLine = line.length() ? line + " " + word : word;
      if (line.length() && textWidth(tryLine) > maxW) {
        lines[n++] = line;
        line = word;
      } else {
        line = tryLine;
      }
      if (sp < 0) break;
      w = sp + 1;
    }
    if (line.length() && n < maxLines) lines[n++] = line;
    if (bar < 0) break;
    start = bar + 1;
  }
  int top = y0 + ((y1 - y0) - n * lineH) / 2;
  tft.setTextColor(colour);
  for (int i = 0; i < n; i++) {
    tft.setCursor((tft.width() - textWidth(lines[i])) / 2, top + i * lineH + (lineH * 3) / 4);
    tft.print(lines[i]);
  }
  tft.setFont(nullptr);
}

// The text above and below the picture. Only where the picture leaves room (not with cover or
// stretch, which fill the screen).
static void mediaDrawText() {
  if (!media.fw) return;
  int H = tft.height();
  int dh = (int)(((int64_t)media.fh * media.syq) >> 16);
  int videoTop = max(0, media.oy), videoBottom = min(H, media.oy + dh);
  mediaTextBlock(media.top, 4, videoTop - 4, &FreeSansBold12pt7b, INK, 26);
  mediaTextBlock(media.bottom, videoBottom + 4, H - 4, &FreeSans9pt7b, DIM, 20);
}

// JPEGDEC hands over decoded blocks; send each straight to the panel (clipped to it).
// Works out the scale and position for the current frame size, screen size and fit mode.
static void mediaLayout() {
  int W = tft.width(), H = tft.height();
  if (!media.fw || !media.fh) return;
  float sx = 1, sy = 1;
  if (media.fit == 1 || media.fit == 2) {
    float a = (float)W / media.fw, b = (float)H / media.fh;
    sx = sy = media.fit == 1 ? min(a, b) : max(a, b);
  } else if (media.fit == 3) {
    sx = (float)W / media.fw;
    sy = (float)H / media.fh;
  }
  // Rounded up, so a frame scaled to fill the screen reaches its last row and column.
  media.sxq = (int32_t)ceilf(sx * 65536);
  media.syq = (int32_t)ceilf(sy * 65536);
  int dw = (int)(media.fw * sx), dh = (int)(media.fh * sy);
  bool placed = media.fit == 0;
  media.ox = placed && media.x >= 0 ? media.x : (W - dw) / 2;
  media.oy = placed && media.y >= 0 ? media.y : (H - dh) / 2;
}

// JPEGDEC hands over decoded blocks; each goes to the panel scaled and placed by mediaLayout(),
// clipped to the screen.
static int mediaJpegDraw(JPEGDRAW* d) {
  static uint16_t line[320];
  int W = tft.width(), H = tft.height();
  int bw = d->iWidthUsed, bh = d->iHeight;
  // This block's rectangle on the screen.
  int x0 = media.ox + (int)(((int64_t)d->x * media.sxq) >> 16);
  int x1 = media.ox + (int)(((int64_t)(d->x + bw) * media.sxq) >> 16);
  int y0 = media.oy + (int)(((int64_t)d->y * media.syq) >> 16);
  int y1 = media.oy + (int)(((int64_t)(d->y + bh) * media.syq) >> 16);
  int cx0 = max(0, x0), cx1 = min(W, x1), cy0 = max(0, y0), cy1 = min(H, y1);
  if (cx0 >= cx1 || cy0 >= cy1) return 1;
  tft.startWrite();
  tft.setAddrWindow(cx0, cy0, cx1 - cx0, cy1 - cy0);
  if (media.sxq == 65536 && media.syq == 65536) {
    // Actual size: straight copy, row by row.
    for (int yy = cy0; yy < cy1; yy++)
      tft.writePixels(d->pPixels + (yy - y0) * d->iWidth + (cx0 - x0), cx1 - cx0, true, false);
  } else {
    // Scaled: nearest pixel. (dest - origin) / scale = position in the frame.
    for (int yy = cy0; yy < cy1; yy++) {
      int r = (int)((((int64_t)(yy - media.oy)) << 16) / media.syq) - d->y;
      r = constrain(r, 0, bh - 1);
      const uint16_t* src = d->pPixels + r * d->iWidth;
      int n = 0;
      for (int xx = cx0; xx < cx1; xx++) {
        int c = (int)((((int64_t)(xx - media.ox)) << 16) / media.sxq) - d->x;
        line[n++] = src[constrain(c, 0, bw - 1)];
      }
      tft.writePixels(line, n, true, false);
    }
  }
  tft.endWrite();
  return 1;
}

static bool mediaDecode(int idx) {
  uint8_t* p = media.video + media.frames[idx];
  int len = media.frames[idx + 1] - media.frames[idx];
  if (!jpeg.openRAM(p, len, mediaJpegDraw)) return false;
  jpeg.setPixelType(RGB565_LITTLE_ENDIAN);
  bool ok = jpeg.decode(0, 0, 0);  // placement and scaling happen in mediaJpegDraw()
  jpeg.close();
  return ok;
}

static void mediaReadCfg(const String& path) {
  File f = SD.open(path);
  if (!f) return;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    int eq = line.indexOf('=');
    if (eq < 0) continue;
    String k = line.substring(0, eq), v = line.substring(eq + 1);
    if (k == "fps") media.fps = v.toFloat();
    else if (k == "x") media.x = v.toInt();
    else if (k == "y") media.y = v.toInt();
    else if (k == "rotation") media.rotation = v.toInt() & 3;
    else if (k == "loop") media.loop = v.toInt() != 0;
    else if (k == "offset") media.offsetMs = v.toInt();
    else if (k == "top") media.top = v;
    else if (k == "bottom") media.bottom = v;
    else if (k == "fit")
      for (uint8_t i = 0; i < 4; i++)
        if (v == FIT_NAMES[i]) media.fit = i;
  }
  f.close();
  if (media.fps < 0.5f || media.fps > 60) media.fps = 15;
}

bool mediaPlay(const String& name) {
  mediaFree();
  String base = String(MEDIA_DIR) + "/" + name;
  File v = SD.open(base + ".mjpeg");
  if (!v) {
    Serial.printf("MEDIAERR no %s.mjpeg on the card\n", base.c_str());
    return false;
  }
  uint32_t size = v.size();
  if (!psramFound() || size + 65536 > ESP.getFreePsram()) {
    Serial.printf("MEDIAERR %s.mjpeg is %lu bytes; %lu free\n", name.c_str(), (unsigned long)size, (unsigned long)ESP.getFreePsram());
    v.close();
    return false;
  }
  media = MediaPlayer();
  media.name = name;
  media.video = (uint8_t*)ps_malloc(size);
  if (!media.video) {
    v.close();
    Serial.println("MEDIAERR out of memory");
    return false;
  }
  uint32_t got = 0;
  while (got < size) {
    int r = v.read(media.video + got, min((uint32_t)32768, size - got));
    if (r <= 0) break;
    got += r;
  }
  v.close();
  media.videoLen = got;
  // Each JPEG starts FF D8 FF. Count them, then note where each starts.
  uint32_t n = 0;
  for (uint32_t i = 0; i + 2 < got; i++)
    if (media.video[i] == 0xFF && media.video[i + 1] == 0xD8 && media.video[i + 2] == 0xFF) n++;
  if (!n || n > 65000) {
    mediaFree();
    Serial.printf("MEDIAERR %s.mjpeg has no JPEG frames in it\n", name.c_str());
    return false;
  }
  media.frames = (uint32_t*)ps_malloc(sizeof(uint32_t) * (n + 1));
  n = 0;
  for (uint32_t i = 0; i + 2 < got; i++)
    if (media.video[i] == 0xFF && media.video[i + 1] == 0xD8 && media.video[i + 2] == 0xFF) media.frames[n++] = i;
  media.frames[n] = got;
  media.frameCount = n;
  mediaReadCfg(base + ".cfg");
  media.hasAudio = mediaOpenWav(base + ".wav");

  if (tft.getRotation() != media.rotation) tft.setRotation(media.rotation);
  tft.fillScreen(BG);
  jpeg.openRAM(media.video, media.frames[1] - media.frames[0], mediaJpegDraw);
  media.fw = jpeg.getWidth();
  media.fh = jpeg.getHeight();
  jpeg.close();
  mediaLayout();
  mediaDrawText();
  Serial.printf("MEDIAPLAY %s frames=%u size=%dx%d fps=%.2f audio=%d loop=%d fit=%s rotation=%u\n", name.c_str(),
                media.frameCount, media.fw, media.fh, media.fps, media.hasAudio, media.loop, FIT_NAMES[media.fit],
                media.rotation);
  media.t0 = millis();
  media.lastIdx = -1;
  media.statAt = millis();
  media.playing = true;
  mediaAudioCue(media.t0);
  return true;
}

// Called from loop() while media plays: shows the frame that belongs now.
void mediaTick() {
  if (!media.playing) return;
  uint32_t now = millis();
  // The sound is the clock once it's running: media time = sound time + offset.
  // Only while there is sound left: a sound shorter than the video must not freeze the picture
  // (after it ends, the pet's own clock carries on from where the sound left off).
  if (media.hasAudio && mediaAudioOn && mediaAudioPlayed > 0 && mediaAudioFrom + mediaAudioPlayed < mediaWavLen) {
    int64_t t = (int64_t)(mediaAudioFrom + mediaAudioPlayed) * 1000 / mediaWavByteRate + media.offsetMs;
    media.t0 = now - (uint32_t)max((int64_t)0, t);
  }
  uint32_t idx = (uint32_t)((uint64_t)(now - media.t0) * (uint32_t)(media.fps * 100) / 100000);
  if (idx >= media.frameCount) {
    if (media.loop) {
      media.t0 = now;
      media.lastIdx = -1;
      mediaAudioCue(now);
      idx = 0;
    } else {
      idx = media.frameCount - 1;
      bool soundDone = !media.hasAudio || !mediaAudioOn || mediaAudioFrom + mediaAudioPlayed >= mediaWavLen;
      if ((int)idx == media.lastIdx && soundDone) {
        media.playing = false;
        mediaAudioStop();
        Serial.printf("MEDIADONE %s\n", media.name.c_str());
        return;
      }
    }
  }
  if ((int)idx != media.lastIdx) {
    if (media.lastIdx >= 0 && (int)idx > media.lastIdx + 1) media.skipped += idx - media.lastIdx - 1;
    media.lastIdx = idx;
    uint32_t t = micros();
    mediaDecode(idx);
    media.decodeUs += micros() - t;
    media.shown++;
  }
  if (media.shown && now - media.statAt > 2000) {
    Serial.printf("MEDIASTAT decode=%lu skipped=%lu shown=%lu\n", (unsigned long)(media.decodeUs / media.shown / 1000),
                  (unsigned long)media.skipped, (unsigned long)media.shown);
    media.decodeUs = media.shown = media.skipped = 0;
    media.statAt = now;
  }
}
#endif

void mediaList() {
  File dir = SD.open(MEDIA_DIR);
  if (dir && dir.isDirectory()) {
    for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
      if (!f.isDirectory()) Serial.printf("MEDIA %s %lu\n", f.name(), (unsigned long)f.size());
      f.close();
    }
  }
  if (dir) dir.close();
  Serial.printf("MEDIAEND psram=%lu\n", (unsigned long)(psramFound() ? ESP.getFreePsram() : 0));
}

// "PIFF": a file from the dashboard, saved into /media.
bool mediaReceive() {
  mediaFree();
  Serial.setTimeout(3000);
  uint8_t nl = 0;
  if (Serial.readBytes(&nl, 1) != 1 || !nl) {
    Serial.println("MEDIAERR file name");
    return false;
  }
  char nameBuf[256] = { 0 };
  uint8_t sz[4];
  if (Serial.readBytes(nameBuf, nl) != nl || Serial.readBytes(sz, 4) != 4) {
    Serial.println("MEDIAERR file header");
    return false;
  }
  uint32_t size = sz[0] | (sz[1] << 8) | (sz[2] << 16) | ((uint32_t)sz[3] << 24);
  String name = nameBuf;
  if (name.indexOf('/') >= 0 || name.startsWith(".")) {
    Serial.println("MEDIAERR bad file name");
    return false;
  }
  if (!SD.exists(MEDIA_DIR)) SD.mkdir(MEDIA_DIR);
  String path = String(MEDIA_DIR) + "/" + name;
  if (SD.exists(path)) SD.remove(path);
  File f = SD.open(path, FILE_WRITE);
  static uint8_t buf[4096];
  uint32_t got = 0;
  bool ok = true;
  while (got < size) {
    size_t r = Serial.readBytes(buf, min((uint32_t)sizeof(buf), size - got));
    if (r == 0) {
      ok = false;
      break;
    }
    if (f) f.write(buf, r);
    uint32_t before = got;
    got += r;
    if (got / 65536 != before / 65536) Serial.printf("MEDIARX %lu\n", (unsigned long)got);
  }
  if (f) f.close();
  if (!f || !ok) {
    SD.remove(path);
    Serial.printf("MEDIAERR %s\n", !f ? "couldn't write to the SD card (is it in?)" : "the file stopped coming");
    return false;
  }
  Serial.printf("MEDIAOK saved %s %lu\n", name.c_str(), (unsigned long)got);
  return true;
}

// Text commands ("media …"). Returns true if it was one.
bool mediaCommand(const String& line) {
  if (line == "media ls") {
    mediaList();
  } else if (line.startsWith("media play ")) {
    mediaPlay(line.substring(11));
  } else if (line == "media stop") {
    mediaStop();
    Serial.println("MEDIAOK stopped");
  } else if (line.startsWith("media loop ")) {
    media.loop = line.endsWith("on");
  } else if (line.startsWith("media fps ")) {
    float f = line.substring(10).toFloat();
    if (f >= 0.5f && f <= 60) {
      uint32_t now = millis();
      float at = (now - media.t0) * media.fps / 1000.0f;  // keep the current frame
      media.fps = f;
      media.t0 = now - (uint32_t)(at * 1000 / f);
    }
  } else if (line.startsWith("media offset ")) {
    media.offsetMs = line.substring(13).toInt();
    if (media.playing) {
      media.t0 = millis();
      media.lastIdx = -1;
      mediaAudioCue(media.t0);
    }
  } else if (line.startsWith("media rotate ")) {
    // Which way up: 0 upright, 1 sideways, 2 upright the other way up, 3 sideways the other way.
    media.rotation = line.substring(13).toInt() & 3;
#if !PET_SCREEN_OLED
    if (media.playing) {
      tft.setRotation(media.rotation);
      tft.fillScreen(BG);
      mediaLayout();
      mediaDrawText();
      media.lastIdx = -1;  // draw the current frame again, the new way round
    }
#endif
    Serial.printf("MEDIAOK rotation %u (save it: rotation=%u in the video's .cfg)\n", media.rotation, media.rotation);
  } else if (line.startsWith("media fit ")) {
    String v = line.substring(10);
    int found = -1;
    for (uint8_t i = 0; i < 4; i++)
      if (v == FIT_NAMES[i]) found = i;
    if (found < 0) {
      Serial.println("MEDIAERR fit is one of: original, fit, cover, stretch");
      return true;
    }
    media.fit = found;
#if !PET_SCREEN_OLED
    if (media.playing) {
      tft.fillScreen(BG);
      mediaLayout();
      mediaDrawText();
      media.lastIdx = -1;
    }
#endif
    Serial.printf("MEDIAOK fit %s (save it: fit=%s in the video's .cfg)\n", FIT_NAMES[media.fit], FIT_NAMES[media.fit]);
  } else if (line.startsWith("media top") || line.startsWith("media bottom")) {
    bool isTop = line.startsWith("media top");
    String v = line.substring(isTop ? 9 : 12);
    v.trim();
    (isTop ? media.top : media.bottom) = v;
#if !PET_SCREEN_OLED
    if (media.playing) {
      tft.fillScreen(BG);
      mediaDrawText();
      media.lastIdx = -1;
    }
#endif
    Serial.printf("MEDIAOK %s text (save it: %s=%s in the video's .cfg)\n", isTop ? "top" : "bottom", isTop ? "top" : "bottom",
                  v.c_str());
  } else if (line.startsWith("media rm ")) {
    String path = String(MEDIA_DIR) + "/" + line.substring(9);
    Serial.println(SD.remove(path) ? "MEDIAOK removed" : "MEDIAERR couldn't remove it");
  } else {
    return false;
  }
  return true;
}
