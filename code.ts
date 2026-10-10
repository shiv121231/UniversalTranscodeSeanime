/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Universal Transcode v0.7 — Video.js 10 (neutral skin) web player, all subtitle tracks, subtitle delay
// Runs a small local server (Python + ffmpeg). In Seanime set  Settings -> External player link  to the
// link shown in this tray. Playing a torrent stream then opens the transcoded web player instead of IINA.

function init() {
    $ui.register((ctx) => {
        const tray = ctx.newTray({ tooltipText: "Universal Transcode", iconUrl: "", withContent: true })

        const status = ctx.state<string>("Server stopped")
        const link = ctx.state<string>("")
        const watch = ctx.state<string>("")
        const note = ctx.state<string>("")

        // Persisted settings. The access key is kept in plugin storage AND in a file, so it survives reloads.
        const saved = (k: string, d: string) => { try { return $storage.get<string>("ut." + k) ?? d } catch (e) { return d } }
        const keyFile = $filepath.join($os.tempDir(), "seanime-transcode-key.txt")
        let initialKey = saved("key", "")
        if (!initialKey) { try { initialKey = $toString($os.readFile(keyFile)).trim() } catch (e) { } }
        if (!initialKey) {
            for (let i = 0; i < 24; i++) initialKey += Math.floor(Math.random() * 16).toString(16)
        }
        const keyRef = ctx.fieldRef<string>(initialKey)

        const pythonRef = ctx.fieldRef<string>(saved("python", "/usr/bin/python3"))
        const ffmpegRef = ctx.fieldRef<string>(saved("ffmpeg", "/opt/homebrew/bin/ffmpeg"))
        const portRef = ctx.fieldRef<string>(saved("port", "43299"))
        const publicRef = ctx.fieldRef<string>(saved("public", "")) // e.g. https://hls.example.com
        const seanimeRef = ctx.fieldRef<string>(saved("seanime", "http://127.0.0.1:43211"))
        const encRef = ctx.fieldRef<string>(saved("enc", "libx264"))
        const heightRef = ctx.fieldRef<string>(saved("height", "1080"))
        const crfRef = ctx.fieldRef<string>(saved("crf", "18"))
        const subRef = ctx.fieldRef<string>(saved("sub", "auto")) // default subtitle: auto | none (blank) | track number | language code
        const audioRef = ctx.fieldRef<string>(saved("audio", "0"))
        const iinaRef = ctx.fieldRef<string>(saved("iina", "")) // blank = bridge off; e.g. /tmp/iina_socket

        let server: any = null
        const root = $filepath.join($os.tempDir(), "seanime-transcode")
        const log = (m: string) => console.log("[universal-transcode] " + m)

        const SERVER_PY = `#!/usr/bin/env python3
"""Universal Transcode server.

Seanime's "External player link" setting opens a URL of your choice with the stream URL filled in.
Point it at  http(s)://<this server>/play?key=<KEY>&src={url}  and this server will:
  1. take the stream URL (the path + token), swap the host for the local Seanime server,
  2. list the file's subtitle tracks (ffprobe) and run ffmpeg: H.264/AAC HLS for the picture and sound, plus one
     WebVTT file per text subtitle track with the original cue timestamps,
  3. redirect the browser to a Video.js (neutral skin) player page that offers every subtitle track.
It also serves the HLS files. One transcode runs at a time; starting a new one stops the old one.
"""
import argparse, atexit, base64, hmac, html, http.server, json, os, re, secrets, shutil, socket, subprocess, sys, threading, time, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--root", required=True)
ap.add_argument("--port", type=int, default=43299)
ap.add_argument("--seanime", default="http://127.0.0.1:43211")
ap.add_argument("--ffmpeg", default="ffmpeg")
ap.add_argument("--key", default="")
ap.add_argument("--encoder", default="libx264")
ap.add_argument("--crf", default="18")
ap.add_argument("--height", default="1080")
ap.add_argument("--audio", default="0")
ap.add_argument("--sub", default="auto", help="default subtitle: auto | none | track number | language code (eng)")
ap.add_argument("--ffprobe", default="", help="path to ffprobe (default: next to ffmpeg, else PATH)")
ap.add_argument("--iina-socket", default="", help="bridge mode: IINA/mpv IPC socket, e.g. /tmp/iina_socket")
ap.add_argument("--keep-iina-audio", action="store_true", help="bridge mode: do not mute IINA")
A = ap.parse_args()

os.makedirs(A.root, exist_ok=True)
os.chdir(A.root)
VERSION = "0.7.0"
LOCAL = A.seanime.rstrip("/")
# Shutdown token lives next to (not inside) the served folder, so a newer instance can replace this one
# even if the access key changed. Anything on the web can't read it.
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(A.root)), "seanime-transcode-%d.token" % A.port)
SHUTDOWN_TOKEN = secrets.token_hex(16)
lock = threading.Lock()
current = {"proc": None, "dir": None, "id": None, "ready": None, "state": "idle", "tracks": [], "skipped": [],
           "default": None, "probe_error": ""}

PLAYER_TEMPLATE = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Universal Transcode</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@videojs/cdn@10.0.1/global.css">
<style>
  html, body { margin: 0; height: 100%; background: #000; color: #eee; font-family: system-ui, sans-serif; overflow: hidden; }
  video-player, video-neutral-skin, hlsjs-video { display: block; width: 100vw; height: 100vh; }
  #ut-ui { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; font-size: 14px; }
  #ut-msg { position: absolute; top: 16px; left: 16px; right: 16px; padding: 10px 12px; border-radius: 6px; background: rgba(0,0,0,.72); pointer-events: auto; }
  #ut-btn, #ut-panel { pointer-events: auto; }
  #ut-btn { position: absolute; top: max(12px, env(safe-area-inset-top)); right: 12px; padding: 7px 12px; border: 0; border-radius: 6px;
            background: rgba(0,0,0,.6); color: #fff; font: inherit; cursor: pointer; transition: opacity .3s; }
  #ut-ui.idle #ut-btn:not(.open) { opacity: 0; }
  #ut-panel { position: absolute; top: calc(max(12px, env(safe-area-inset-top)) + 40px); right: 12px; width: min(340px, calc(100vw - 24px));
              max-height: calc(100vh - 80px); overflow: auto; padding: 12px; border-radius: 8px; background: rgba(20,20,20,.94); display: none; }
  #ut-panel.open { display: block; }
  #ut-panel h4 { margin: 10px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #aaa; }
  #ut-panel h4:first-child { margin-top: 0; }
  #ut-panel label.tr { display: flex; gap: 8px; align-items: center; padding: 5px 2px; cursor: pointer; }
  #ut-panel .row { display: flex; gap: 8px; align-items: center; }
  #ut-panel input[type=range] { flex: 1; min-width: 0; }
  #ut-panel button { font: inherit; color: #fff; background: #333; border: 0; border-radius: 5px; padding: 5px 9px; cursor: pointer; }
  #ut-panel .val { min-width: 64px; text-align: right; font-variant-numeric: tabular-nums; }
  #ut-panel .hint { margin-top: 8px; font-size: 12px; color: #999; }
</style>
<script type="module" src="https://cdn.jsdelivr.net/npm/@videojs/cdn@10.0.1/video-neutral.js"></script>
<script type="module" src="https://cdn.jsdelivr.net/npm/@videojs/cdn@10.0.1/media/hlsjs-video.js"></script>
</head>
<body>
<video-player>
  <video-neutral-skin>
    <hlsjs-video id="v" autoplay playsinline preload="auto" crossorigin="anonymous">
__TRACKS__
    </hlsjs-video>
  </video-neutral-skin>
</video-player>

<div id="ut-ui" class="idle">
  <div id="ut-msg" role="status" aria-live="polite">Starting transcode...</div>
  <button id="ut-btn" type="button" aria-haspopup="true" aria-expanded="false">Subtitles</button>
  <div id="ut-panel" role="dialog" aria-label="Subtitles"></div>
</div>

<script id="ut-cfg" type="application/json">__CFG__</script>
<script>
(function () {
  var cfg = JSON.parse(document.getElementById('ut-cfg').textContent);
  var media = document.getElementById('v');
  var ui = document.getElementById('ut-ui');
  var msg = document.getElementById('ut-msg');
  var btn = document.getElementById('ut-btn');
  var panel = document.getElementById('ut-panel');
  var params = new URLSearchParams(location.search);
  var key = params.get('key');
  var sid = location.pathname.split('/')[1];
  var t0 = Date.now();

  function show(t) { msg.textContent = t; msg.style.display = 'block'; }
  function hide() { msg.style.display = 'none'; }

  // ------------------------------------------------------------ subtitle delay
  // Cue times from the server are the ORIGINAL timestamps (same timeline as mpv/IINA).
  // The delay is only ever added on top of those, so 0 = exactly what mpv shows.
  var DELAY_KEY = 'ut.subdelay', delay = 0;
  try { delay = parseFloat(localStorage.getItem(DELAY_KEY)) || 0; } catch (e) {}
  function clamp(d) { return Math.max(-5, Math.min(5, Math.round(d * 100) / 100)); }
  delay = clamp(delay);

  var tracks = cfg.tracks.map(function (t) { return { info: t, tt: null, cues: [], count: 0, busy: false, done: false }; });

  function shiftAll() {
    tracks.forEach(function (t) {
      t.cues.forEach(function (c) {
        var s = Math.max(0, c.__o[0] + delay), e = Math.max(s + 0.001, c.__o[1] + delay);
        c.startTime = s; c.endTime = e;
      });
    });
  }
  function setDelay(d) {
    delay = clamp(d);
    try { localStorage.setItem(DELAY_KEY, String(delay)); } catch (e) {}
    shiftAll(); renderValue();
  }

  // ------------------------------------------------------------ text tracks
  // <track> elements in the markup make the tracks known to the player (and its captions UI).
  // Cues are then fed in progressively from the server while the transcode runs.
  function findTT(t) {
    var list = media.textTracks;
    if (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === t.info.id) return list[i];
      }
      for (var j = 0; j < list.length; j++) {
        if (list[j].label === t.info.label && list[j].language === t.info.lang) return list[j];
      }
    }
    // Fallback: the media element did not pick up our <track> children
    if (Date.now() - t0 > 3000 && media.addTextTrack) {
      var made = media.addTextTrack('subtitles', t.info.label, t.info.lang);
      if (made) return made;
    }
    return null;
  }

  function addCues(t, rows) {
    rows.forEach(function (r) {
      var c = new VTTCue(r[0], r[1], r[2]);
      c.__o = [r[0], r[1]];
      if (delay) { c.startTime = Math.max(0, r[0] + delay); c.endTime = Math.max(c.startTime + 0.001, r[1] + delay); }
      t.tt.addCue(c);
      t.cues.push(c);
    });
    t.count += rows.length;
  }

  var didInit = false;
  function initialSelect() {
    // wait (briefly) until the media element has exposed our tracks, then switch the default one on
    var all = tracks.every(function (t) { if (!t.tt) t.tt = findTT(t); return !!t.tt; });
    if (!all && Date.now() - t0 < 4000) return false;
    didInit = true;
    var idx = -1;
    tracks.forEach(function (t, k) { if (t.info.id === cfg.default) idx = k; });
    if (idx >= 0) selectTrack(idx);
    return true;
  }

  function pump() {
    if (!didInit && !initialSelect()) return;
    tracks.forEach(function (t) {
      if (t.busy || t.done) return;
      if (!t.tt) t.tt = findTT(t);
      if (!t.tt || t.tt.mode === 'disabled') return;   // only feed tracks that are on
      t.busy = true;
      fetch('cues?s=' + t.info.index + '&from=' + t.count, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.cues && j.cues.length) addCues(t, j.cues);
          if (!j.live && t.count >= j.total) t.done = true;
        })
        .catch(function () {})
        .then(function () { t.busy = false; });
    });
  }
  setInterval(pump, 3000);
  if (media.textTracks && media.textTracks.addEventListener) {
    media.textTracks.addEventListener('change', function () { pump(); renderTracks(); });
    media.textTracks.addEventListener('addtrack', function () { setTimeout(pump, 100); });
  }

  function selectTrack(i) {            // i = index into tracks, or -1 for off
    tracks.forEach(function (t, k) {
      if (!t.tt) t.tt = findTT(t);
      if (t.tt) t.tt.mode = (k === i) ? 'showing' : 'disabled';
    });
    pump(); renderTracks();
  }

  // ------------------------------------------------------------ panel (track list + delay)
  var valEl, radios = [];
  function fmt(d) { return (d > 0 ? '+' : d < 0 ? '-' : '') + Math.abs(d).toFixed(2) + ' s'; }
  function renderValue() { if (valEl) valEl.textContent = fmt(delay); var s = panel.querySelector('input[type=range]'); if (s) s.value = delay; }
  function renderTracks() {
    radios.forEach(function (r) {
      var t = r.t;
      r.el.checked = t ? !!(t.tt && t.tt.mode === 'showing') : !tracks.some(function (x) { return x.tt && x.tt.mode === 'showing'; });
    });
  }
  function build() {
    var h = '<h4>Subtitles</h4><div id="ut-list"></div><h4>Delay</h4>' +
      '<div class="row"><button type="button" id="ut-m">-0.1</button><input type="range" min="-5" max="5" step="0.05" value="0" aria-label="Subtitle delay">' +
      '<button type="button" id="ut-p">+0.1</button></div>' +
      '<div class="row" style="margin-top:6px"><span class="val" id="ut-val"></span><button type="button" id="ut-r">Reset</button></div>' +
      '<div class="hint">Keys: z = -0.1 s, x = +0.1 s. 0 means the original timing (same as mpv/IINA). Positive = later.</div>';
    if (cfg.skipped && cfg.skipped.length) {
      h += '<div class="hint">Not available (image-based): ' + cfg.skipped.map(function (s) { return esc(s.label); }).join(', ') + '</div>';
    }
    if (cfg.probe_error) h += '<div class="hint">Could not read the subtitle list: ' + esc(cfg.probe_error) + '</div>';
    panel.innerHTML = h;
    var list = panel.querySelector('#ut-list');
    function row(label, t) {
      var l = document.createElement('label'); l.className = 'tr';
      var r = document.createElement('input'); r.type = 'radio'; r.name = 'ut-sub';
      r.addEventListener('change', function () { selectTrack(t ? tracks.indexOf(t) : -1); });
      l.appendChild(r); l.appendChild(document.createTextNode(label));
      list.appendChild(l); radios.push({ el: r, t: t });
    }
    row('Off', null);
    tracks.forEach(function (t) { row(t.info.label, t); });
    valEl = panel.querySelector('#ut-val');
    var slider = panel.querySelector('input[type=range]');
    slider.addEventListener('input', function () { setDelay(parseFloat(slider.value)); });
    panel.querySelector('#ut-m').onclick = function () { setDelay(delay - 0.1); };
    panel.querySelector('#ut-p').onclick = function () { setDelay(delay + 0.1); };
    panel.querySelector('#ut-r').onclick = function () { setDelay(0); };
    renderValue(); renderTracks();
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  build();
  btn.addEventListener('click', function () {
    var open = panel.classList.toggle('open'); btn.classList.toggle('open', open); btn.setAttribute('aria-expanded', open);
  });
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(tag) && e.target.type !== 'range') return;
    if (e.key === 'z') { setDelay(delay - 0.1); flash('Subtitle delay ' + fmt(delay)); }
    else if (e.key === 'x') { setDelay(delay + 0.1); flash('Subtitle delay ' + fmt(delay)); }
  });
  var flashTimer;
  function flash(t) { show(t); clearTimeout(flashTimer); flashTimer = setTimeout(function () { if (media.currentTime > 0) hide(); }, 1200); }

  // fade the Subtitles button with the controls
  var idleTimer;
  function wake() { ui.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(function () { ui.classList.add('idle'); }, 3000); }
  ['mousemove', 'touchstart', 'keydown'].forEach(function (n) { document.addEventListener(n, wake, { passive: true }); });
  wake();

  // keep the overlay visible in fullscreen when the fullscreen element can host it
  function reparent() {
    var fe = document.fullscreenElement || document.webkitFullscreenElement, host = document.body;
    if (fe && fe.nodeType === 1 && (!fe.shadowRoot || fe.shadowRoot.querySelector('slot'))) host = fe;
    if (ui.parentNode !== host) host.appendChild(ui);
  }
  document.addEventListener('fullscreenchange', reparent);
  document.addEventListener('webkitfullscreenchange', reparent);

  // ------------------------------------------------------------ playback
  function begin() {
    customElements.whenDefined('hlsjs-video').then(function () {
      var url = 'index.m3u8';
      // The playlist grows while ffmpeg works (EVENT type), so hls.js would treat it as live and
      // jump to the end. Start at 0 like a normal episode.
      try { media.source = { src: url, type: 'application/vnd.apple.mpegurl', engine: { hlsJs: { startPosition: 0 } } }; }
      catch (e) { media.src = url; }
      if (!media.src) media.src = url;
    });
  }
  function waitForPlaylist() {
    fetch('index.m3u8', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('not ready');
      return r.text();
    }).then(function (txt) {
      if (txt.indexOf('#EXTINF') < 0) throw new Error('empty');
      begin();
    }).catch(function () {
      fetch('/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
        if (s.state === 'failed' || (s.exited && s.code !== 0)) {
          show('ffmpeg failed (exit code ' + s.code + '). Check ffmpeg.log in the transcode temp folder.');
          return;
        }
        show('Starting transcode...');
        setTimeout(waitForPlaylist, 1500);
      }).catch(function () { setTimeout(waitForPlaylist, 1500); });
    });
  }
  media.addEventListener('playing', hide);
  media.addEventListener('canplay', hide);
  media.addEventListener('error', function () {
    var e = media.error;
    show(e && e.message ? 'Player error: ' + e.message : 'Unable to play this stream.');
  });
  waitForPlaylist();

  // Bridge mode: report position/pause state so IINA (and Seanime's progress tracking) follows this player.
  if (key) setInterval(function () {
    var time = media.currentTime;
    if ((!time || !isFinite(time)) && media.paused) return;
    fetch('/sync?key=' + encodeURIComponent(key) + '&sid=' + encodeURIComponent(sid) +
      '&t=' + (isFinite(time) ? time : 0).toFixed(1) + '&p=' + (media.paused ? 1 : 0), { cache: 'no-store' }).catch(function () {});
  }, 5000);
})();
</script>
</body>
</html>
'''


# ---------------------------------------------------------------- subtitle tracks
# Text subtitle formats ffmpeg can convert to WebVTT. Image-based ones (PGS, VobSub, DVB) cannot be shown.
TEXT_SUB_CODECS = {"ass", "ssa", "subrip", "srt", "webvtt", "mov_text", "text", "microdvd", "subviewer",
                   "subviewer1", "sami", "realtext", "stl", "vplayer", "mpl2", "pjs", "jacosub"}
MAX_SUB_TRACKS = 32
PROBE_TIMEOUT = 25

# ISO 639 code (both 639-2/B and 639-2/T spellings) -> (2-letter code, English name, native name)
LANG = {}
for _row in """eng en English English|jpn ja Japanese 日本語|spa es Spanish Español|por pt Portuguese Português|fre,fra fr French Français|
ger,deu de German Deutsch|ita it Italian Italiano|rus ru Russian Русский|ara ar Arabic العربية|chi,zho zh Chinese 中文|kor ko Korean 한국어|
ind id Indonesian Indonesia|may,msa ms Malay Melayu|vie vi Vietnamese Tiếng Việt|tha th Thai ไทย|tur tr Turkish Türkçe|pol pl Polish Polski|
ukr uk Ukrainian Українська|hin hi Hindi हिन्दी|dut,nld nl Dutch Nederlands|swe sv Swedish Svenska|nor no Norwegian Norsk|dan da Danish Dansk|
fin fi Finnish Suomi|gre,ell el Greek Ελληνικά|heb he Hebrew עברית|cze,ces cs Czech Čeština|hun hu Hungarian Magyar|rum,ron ro Romanian Română|
bul bg Bulgarian Български|hrv hr Croatian Hrvatski|srp sr Serbian Српски|slo,slk sk Slovak Slovenčina|cat ca Catalan Català|fil,tgl tl Filipino Filipino|
ben bn Bengali বাংলা|tam ta Tamil தமிழ்|tel te Telugu తెలుగు|per,fas fa Persian فارسی|urd ur Urdu اردو|lat la Latin Latina""".replace("\\n", "").split("|"):
    _p = _row.strip().split(" ")
    if len(_p) >= 4:
        for _c in _p[0].split(","):
            LANG[_c] = (_p[1], _p[2], " ".join(_p[3:]))
LANG2 = {v[0]: k for k, v in LANG.items()}


def lang3(code):
    code = (code or "").strip().lower()
    return code if code in LANG else LANG2.get(code, code)


def ffprobe_path():
    base = os.path.basename(A.ffmpeg)
    if A.ffprobe:
        return A.ffprobe
    d = os.path.dirname(A.ffmpeg)
    cand = os.path.join(d, base.replace("ffmpeg", "ffprobe")) if d else ""
    return cand if cand and os.path.exists(cand) else "ffprobe"


def probe_streams(src):
    r = subprocess.run([ffprobe_path(), "-v", "error", "-print_format", "json", "-show_streams", "-i", src],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=PROBE_TIMEOUT)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or b"ffprobe failed").decode("utf-8", "replace").strip()[-200:])
    return json.loads(r.stdout.decode("utf-8", "replace")).get("streams", [])


def track_label(lang, title, forced, sdh):
    code = lang3(lang)
    known = LANG.get(code)
    name = known[1] if known else ("" if code in ("", "und", "zxx") else code.upper())
    native = known[2] if known else ""
    title = (title or "").strip()
    generic = title.lower() in ("", "subtitle", "subtitles", "subs", "sub", "track", "default")
    if title and not generic:
        low = title.lower()
        label = title if (name and name.lower() in low) or (native and native.lower() in low) or not name \\
            else "%s (%s)" % (title, name)
    else:
        label = name or "Unknown"
    if forced and "forced" not in label.lower():
        label += " (Forced)"
    if sdh and not re.search(r"sdh|cc|hearing", label, re.I):
        label += " (SDH)"
    return label


def build_tracks(streams):
    """Every subtitle stream, in file order. Text ones become selectable tracks; image-based ones are listed as skipped."""
    tracks, skipped, s_index = [], [], 0
    for st in streams:
        if st.get("codec_type") != "subtitle":
            continue
        tags = {k.lower(): v for k, v in (st.get("tags") or {}).items()}
        disp = st.get("disposition") or {}
        lang = tags.get("language", "")
        label = track_label(lang, tags.get("title", ""), disp.get("forced"), disp.get("hearing_impaired"))
        code = lang3(lang)
        item = {"index": s_index, "codec": st.get("codec_name", ""), "label": label,
                "lang": (LANG[code][0] if code in LANG else (code if code and code != "und" else "und")),
                "lang3": code, "default": bool(disp.get("default")), "forced": bool(disp.get("forced"))}
        if item["codec"] in TEXT_SUB_CODECS and len(tracks) < MAX_SUB_TRACKS:
            tracks.append(item)
        else:
            skipped.append({"index": s_index, "codec": item["codec"], "label": label})
        s_index += 1
    seen = {}
    for t in tracks:                       # labels must be unique for the captions menu
        n = seen.get(t["label"], 0) + 1
        seen[t["label"]] = n
        if n > 1:
            t["label"] += " (%d)" % n
        t["id"] = "sub-%d" % t["index"]
        t["file"] = "sub_%d.vtt" % t["index"]
    return tracks, skipped


def pick_default(tracks, spec):
    """spec: 'none' | 'auto' | a track number | a language code ('eng' / 'en')."""
    spec = (spec or "").strip().lower()
    if spec in ("", "none", "off", "-1") or not tracks:
        return None
    full = [t for t in tracks if not t["forced"]]
    if spec.isdigit():
        return next((t["id"] for t in tracks if t["index"] == int(spec)), None)
    if spec == "auto":
        eng = [t for t in full if t["lang3"] in ("eng",) and not re.search(r"sign|song|karaoke", t["label"], re.I)]
        pool = eng or [t for t in full if t["default"]] or full or tracks
        return pool[0]["id"] if pool else None
    code = lang3(spec)
    pool = [t for t in full if t["lang3"] == code]
    return pool[0]["id"] if pool else None


# ---------------------------------------------------------------- WebVTT -> JSON cues (served progressively to the player)
_TS = re.compile(r"(?:(\\d+):)?(\\d{1,2}):(\\d{2})[.,](\\d{3})")


def parse_ts(s):
    m = _TS.fullmatch(s.strip())
    if not m:
        raise ValueError(s)
    return int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000.0


def read_cues(path, finished):
    """Cues of a (possibly still growing) WebVTT file. While ffmpeg is running a trailing, unfinished block is ignored."""
    try:
        txt = open(path, encoding="utf-8", errors="replace").read().replace("\\r\\n", "\\n")
    except OSError:
        return []
    blocks = txt.split("\\n\\n")
    # ffmpeg flushes whole cues, and the muxer only puts the blank separator in front of the NEXT cue, so a file
    # that ends in a newline holds only complete cues. A file cut off mid-line has an unfinished last block.
    if not finished and blocks and not txt.endswith("\\n"):
        blocks = blocks[:-1]
    cues = []
    for block in blocks:
        lines = block.split("\\n")
        for i, line in enumerate(lines):
            if "-->" in line:
                a, _, rest = line.partition("-->")
                try:
                    start, end = parse_ts(a), parse_ts(rest.strip().split()[0])
                except (ValueError, IndexError):
                    break
                text = "\\n".join(lines[i + 1:]).strip("\\n")
                if text:
                    cues.append([round(start, 3), round(end, 3), text])
                break
    return cues


# ---------------------------------------------------------------- sessions
def stop_current():
    p = current["proc"]
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=5)
        except Exception:
            p.kill()
    if current["dir"]:
        shutil.rmtree(current["dir"], ignore_errors=True)
    ev = current.get("ready")
    current.update(proc=None, dir=None, id=None, ready=None, state="idle", tracks=[], skipped=[], default=None,
                   probe_error="")
    if ev:
        ev.set()                       # release anyone still waiting for the old session's player page


def build_command(src, d, o, tracks):
    height = int(o["height"]) if o["height"].isdigit() else 1080
    audio = int(o["audio"]) if o["audio"].isdigit() else 0
    crf = o["crf"] if o["crf"].isdigit() else "18"
    cmd = [A.ffmpeg, "-hide_banner", "-loglevel", "warning",
           "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
           "-i", src,
           # output 1: video + audio as HLS. -muxdelay/-muxpreload 0 stop the MPEG-TS muxer adding its default
           # ~1.4 s offset, so HLS timestamps stay on the same timeline as the source (= mpv/IINA's time-pos).
           "-map", "0:v:0", "-map", "0:a:%d?" % audio, "-sn",
           "-vf", "scale=-2:'min(ih,%d)',format=yuv420p" % height]
    cmd += encoder_args(o["enc"], crf)
    cmd += ["-c:a", "aac", "-b:a", "192k", "-ac", "2",
            "-muxdelay", "0", "-muxpreload", "0",
            "-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "event",
            "-hls_flags", "independent_segments",
            "-hls_segment_filename", os.path.join(d, "seg_%05d.ts"), os.path.join(d, "index.m3u8")]
    # one extra output per subtitle track: a plain WebVTT file with the ORIGINAL cue times
    # (rebased exactly like mpv does), flushed cue by cue so it can be read while the transcode runs.
    for t in tracks:
        cmd += ["-map", "0:s:%d" % t["index"], "-c:s", "webvtt", "-flush_packets", "1", "-f", "webvtt",
                os.path.join(d, t["file"])]
    return cmd


def launch(sid, d, src, o, ready):
    """Background worker: list the subtitle streams, then start ffmpeg with one output per track."""
    probe_error, streams = "", []
    try:
        streams = probe_streams(src)
    except Exception as e:
        probe_error = str(e)[:200]
    tracks, skipped = build_tracks(streams)
    default = pick_default(tracks, o["sub"])
    with lock:
        if current["id"] != sid:        # a newer session replaced this one while we were probing
            return
        try:
            log = open(os.path.join(d, "ffmpeg.log"), "wb")
            proc = subprocess.Popen(build_command(src, d, o, tracks), stdout=subprocess.DEVNULL, stderr=log)
            state = "running"
        except Exception as e:
            proc, state, probe_error = None, "failed", ("could not start ffmpeg: %s" % e)[:200]
        current.update(proc=proc, state=state, tracks=tracks, skipped=skipped, default=default,
                       probe_error=probe_error)
    try:
        with open(os.path.join(d, "tracks.json"), "w") as f:
            json.dump({"tracks": tracks, "skipped": skipped, "default": default}, f)
    except OSError:
        pass
    ready.set()


def start_transcode(src, o):
    with lock:
        stop_current()
        sid = secrets.token_hex(8)
        d = os.path.join(A.root, sid)
        os.makedirs(d)
        ready = threading.Event()
        current.update(dir=d, id=sid, ready=ready, state="probing")
    threading.Thread(target=launch, args=(sid, d, src, o, ready), daemon=True).start()
    return sid


def render_player():
    """The player page, with every subtitle track declared as a <track> so the player's captions UI sees them."""
    cfg = {"tracks": current["tracks"], "skipped": current["skipped"], "default": current["default"],
           "probe_error": current["probe_error"]}
    tags = "\\n".join('      <track id="%s" kind="subtitles" label="%s" srclang="%s">' % (
        html.escape(t["id"], True), html.escape(t["label"], True), html.escape(t["lang"], True))
        for t in current["tracks"])
    blob = json.dumps(cfg).replace("</", "<\\\\/").replace("<!--", "<\\\\!--")
    return PLAYER_TEMPLATE.replace("__TRACKS__", tags).replace("__CFG__", blob)


def encoder_args(enc, crf):
    if enc == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", crf, "-profile:v", "high", "-level", "4.1"]
    if enc == "h264_qsv":
        return ["-c:v", "h264_qsv", "-global_quality", crf, "-profile:v", "high", "-level", "4.1"]
    if enc == "h264_videotoolbox":
        return ["-c:v", "h264_videotoolbox", "-b:v", "15M"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-tune", "animation",
            "-profile:v", "high", "-level", "4.1"]


def normalize_src(raw):
    """Accept the stream URL in whatever form Seanime hands it over:
    plain, percent-encoded (maybe twice), base64, or wrapped inside another scheme (iina://...?url=http...)."""
    raw = raw.strip()
    isurl = lambda x: x.lower().startswith(("http://", "https://", "/api/"))
    for _ in range(3):
        if isurl(raw):
            break
        d = urllib.parse.unquote(raw)
        if d != raw:
            raw = d
            continue
        try:
            dec = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8")
            if isurl(dec) or "http" in dec[:40]:
                raw = dec
                continue
        except Exception:
            pass
        break
    if not isurl(raw):
        m = re.search(r"https?://\\S+", raw)  # wrapped, e.g. iina://weblink?url=http://...
        if m:
            raw = m.group(0)
            if raw.lower().startswith(("http%3a", "https%3a")):
                raw = urllib.parse.unquote(raw)
    return raw


def local_stream_url(raw):
    """Turn the stream URL into a URL on the local Seanime server (path + token kept)."""
    u = urllib.parse.urlsplit(normalize_src(raw))
    if not u.path.startswith("/api/v1/") or "stream" not in u.path:
        return None
    return LOCAL + u.path + ("?" + u.query if u.query else "")


def describe(raw):
    """Safe description of what we received (no query string, so no token) for error messages."""
    n = normalize_src(raw)
    u = urllib.parse.urlsplit(n)
    return "received (query removed): %s" % ((u.scheme + "://" if u.scheme else "") + u.netloc + u.path)[:200]



# ---------------------------------------------------------------- IINA / mpv bridge
bridge = {"path": None, "sid": None, "gone_since": None}


def ipc(cmd, timeout=2.0):
    """One-shot mpv JSON IPC request. Returns the parsed reply or None."""
    try:
        sk = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sk.settimeout(timeout)
        sk.connect(A.iina_socket)
        sk.sendall((json.dumps({"command": cmd, "request_id": 4242}) + "\\n").encode())
        buf, end = b"", time.time() + timeout
        while time.time() < end:
            chunk = sk.recv(65536)
            if not chunk:
                break
            buf += chunk
            for line in buf.split(b"\\n"):
                try:
                    j = json.loads(line)
                except Exception:
                    continue
                if j.get("request_id") == 4242:
                    sk.close()
                    return j
        sk.close()
    except Exception:
        pass
    return None


def ipc_get(prop):
    r = ipc(["get_property", prop])
    return r.get("data") if r and r.get("error") == "success" else None


def bridge_loop():
    """Watch IINA: when it opens a Seanime stream, transcode it; when it goes away, stop."""
    while True:
        try:
            path = ipc_get("path")
            if isinstance(path, str) and local_stream_url(path):
                bridge["gone_since"] = None
                if path != bridge["path"]:
                    bridge["path"] = path
                    bridge["sid"] = start_transcode(local_stream_url(path), {
                        "sub": A.sub, "audio": A.audio, "height": A.height, "crf": A.crf, "enc": A.encoder})
                    if not A.keep_iina_audio:
                        ipc(["set_property", "mute", True])  # you watch in the browser, not on the Mac
            else:
                if bridge["gone_since"] is None:
                    bridge["gone_since"] = time.time()
                elif bridge["path"] and time.time() - bridge["gone_since"] > 30:
                    with lock:
                        stop_current()
                    bridge.update(path=None, sid=None)
        except Exception as e:
            sys.stderr.write("bridge: %s\\n" % e)
        time.sleep(2)


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".vtt": "text/vtt"}

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a):
        pass

    def list_directory(self, path):
        self.send_error(404)
        return None

    def reply(self, code, body, ctype="text/plain"):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/play":
            return self.play()
        if path == "/status":
            # deliberately minimal: no session id and no log (the log can contain the stream token)
            p = current["proc"]
            return self.reply(200, json.dumps({"version": VERSION, "state": current["state"],
                                               "exited": bool(p and p.poll() is not None),
                                               "code": p.poll() if p else None}), "application/json")
        if path == "/watch" and A.iina_socket:
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            if not hmac.compare_digest(q.get("key", [""])[0], A.key):
                return self.reply(403, "bad key")
            sid = current["id"]
            if sid:
                self.send_response(302)
                self.send_header("Location", "/%s/player.html?key=%s" % (sid, urllib.parse.quote(A.key)))
                return self.end_headers()
            return self.reply(200, "<meta http-equiv='refresh' content='3'><body style='background:#000;color:#ccc;"
                                   "font-family:sans-serif'><p style='padding:12px'>Waiting for IINA to start a Seanime "
                                   "stream... (this page refreshes by itself)</p>", "text/html")
        if path == "/sync" and A.iina_socket:
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            if not hmac.compare_digest(q.get("key", [""])[0], A.key) or q.get("sid", [""])[0] != current["id"]:
                return self.reply(403, "no")
            try:
                t, paused = float(q.get("t", ["0"])[0]), q.get("p", ["0"])[0] == "1"
            except ValueError:
                return self.reply(400, "bad args")
            pos = ipc_get("time-pos")
            if isinstance(pos, (int, float)) and abs(pos - t) > 5:
                ipc(["seek", t, "absolute"])
            if ipc_get("pause") != paused:
                ipc(["set_property", "pause", paused])
            return self.reply(200, "ok")
        if path == "/shutdown":
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            if not hmac.compare_digest(q.get("token", [""])[0], SHUTDOWN_TOKEN):
                return self.reply(403, "bad token")
            self.reply(200, "bye")
            threading.Thread(target=lambda: (time.sleep(0.3), stop_current(), os._exit(0)), daemon=True).start()
            return
        if path == "/":
            return self.reply(200, "Universal Transcode %s is running. Use /play?key=KEY&src=STREAM_URL" % VERSION)
        m = re.fullmatch(r"/([0-9a-f]{16})/(player\\.html|cues)", path)
        if m:
            return self.serve_player(m.group(1)) if m.group(2) == "player.html" else self.serve_cues(m.group(1))
        return super().do_GET()

    def serve_player(self, sid):
        ev = current.get("ready")
        if current["id"] != sid or ev is None:
            return self.reply(404, "no such session")
        ev.wait(PROBE_TIMEOUT + 10)      # the page is built once the subtitle tracks are known
        if current["id"] != sid:
            return self.reply(404, "no such session")
        return self.reply(200, render_player(), "text/html")

    def serve_cues(self, sid):
        q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
        try:
            idx, start = int(q.get("s", [""])[0]), max(0, int(q.get("from", ["0"])[0]))
        except ValueError:
            return self.reply(400, "bad args")
        track = next((t for t in current["tracks"] if t["index"] == idx), None) if current["id"] == sid else None
        if not track:
            return self.reply(404, "no such track")
        p = current["proc"]
        live = bool(p and p.poll() is None)
        cues = read_cues(os.path.join(current["dir"], track["file"]), not live)
        return self.reply(200, json.dumps({"cues": cues[start:], "total": len(cues), "live": live}), "application/json")

    def play(self):
        q = self.path.split("?", 1)[1] if "?" in self.path else ""
        i = q.find("src=")
        if i < 0:
            return self.reply(400, "missing src")
        # src must come last: it may contain its own ?token=... which would otherwise be split off
        params = {k: v[0] for k, v in urllib.parse.parse_qs(q[:i]).items()}
        if A.key and not hmac.compare_digest(params.get("key", ""), A.key):
            return self.reply(403, "bad key: the key in this link does not match the running server.\\n"
                                   "Open the Universal Transcode tray in Seanime, press 'Start / apply settings', "
                                   "copy the link it shows and paste it into Seanime's External player link again.")
        rawsrc = q[i + 4:]
        if rawsrc.strip() in ("", "{url}", "%7Burl%7D"):
            return self.reply(400, "Seanime did not fill in {url}. This link must be opened by Seanime itself "
                                   "(External player link), not typed into the address bar.")
        src = local_stream_url(rawsrc)
        if not src:
            return self.reply(400, "src is not a Seanime stream URL (it must have a path like /api/v1/.../stream...)\\n" + describe(rawsrc))
        o = {"sub": params.get("sub", A.sub), "audio": params.get("audio", A.audio),
             "height": params.get("h", A.height), "crf": params.get("crf", A.crf),
             "enc": params.get("enc", A.encoder)}
        sid = start_transcode(src, o)
        self.send_response(302)
        self.send_header("Location", "/%s/player.html" % sid)
        self.end_headers()


try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("10.255.255.255", 1))
    open(os.path.join(A.root, "ip.txt"), "w").write(s.getsockname()[0])
    s.close()
except Exception:
    pass

atexit.register(lambda: stop_current())

# If an older instance (e.g. left over from a plugin reload) holds the port, ask it to quit first.
try:
    old = open(TOKEN_FILE).read().strip()
    urllib.request.urlopen("http://127.0.0.1:%d/shutdown?token=%s" % (A.port, old), timeout=2).read()
    time.sleep(1)
except Exception:
    pass
try:
    with open(TOKEN_FILE, "w") as f:
        f.write(SHUTDOWN_TOKEN)
    os.chmod(TOKEN_FILE, 0o600)
except Exception:
    pass

if A.iina_socket:
    threading.Thread(target=bridge_loop, daemon=True).start()

httpd = None
for _ in range(10):
    try:
        httpd = http.server.ThreadingHTTPServer(("0.0.0.0", A.port), H)
        break
    except OSError:
        time.sleep(1)
if httpd is None:
    sys.exit("port %d is in use by something that would not quit" % A.port)
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    pass
`

        function persist() {
            const f: Record<string, string> = {
                python: pythonRef.current, ffmpeg: ffmpegRef.current, port: portRef.current, public: publicRef.current,
                seanime: seanimeRef.current, enc: encRef.current, height: heightRef.current, crf: crfRef.current,
                sub: subRef.current, audio: audioRef.current, iina: iinaRef.current,
            }
            for (const k of Object.keys(f)) { try { $storage.set("ut." + k, f[k]) } catch (e) { } }
            try { $storage.set("ut.key", keyRef.current.trim()) } catch (e) { }
            try { $os.mkdirAll($os.tempDir(), 0o755); $os.writeFile(keyFile, $toBytes(keyRef.current.trim()), 0o600) } catch (e) { }
        }

        function stop() {
            if (server) { try { server.getCommand().process.kill() } catch (e) { log("kill failed: " + e) } server = null }
        }

        function start() {
            // never run without a key (an empty key would leave /play open to anyone who can reach it)
            if (!keyRef.current.trim()) {
                let k = ""
                for (let i = 0; i < 24; i++) k += Math.floor(Math.random() * 16).toString(16)
                keyRef.setValue(k)
            }
            persist()
            stop()
            try {
                $os.mkdirAll(root, 0o755)
                const script = $filepath.join(root, "server.py")
                $os.writeFile(script, $toBytes(SERVER_PY), 0o644)
                server = $osExtra.asyncCmd(
                    pythonRef.current.trim() || "python3", script,
                    "--root", root, "--port", portRef.current.trim(),
                    "--seanime", seanimeRef.current.trim(), "--ffmpeg", ffmpegRef.current.trim() || "ffmpeg",
                    "--key", keyRef.current.trim(), "--encoder", encRef.current, "--crf", crfRef.current.trim() || "18",
                    "--height", heightRef.current, "--audio", audioRef.current.trim() || "0", "--sub", subRef.current.trim() || "none",
                    ...(iinaRef.current.trim() ? ["--iina-socket", iinaRef.current.trim()] : []),
                )
            } catch (e) {
                ctx.toast.error("Could not start the server (check the Python path): " + e)
                status.set("Failed to start")
                return
            }
            server.run((data: any, err: any, code: any) => {
                if (err) { log("server: " + $toString(err)); note.set($toString(err).slice(-400)) }
                if (code !== undefined) { status.set("Server stopped (" + code + ")"); server = null }
            })

            // Work out the public base (public URL, else LAN IP written by the server)
            const setLinks = (b: string) => {
                link.set(`${b}/play?key=${keyRef.current.trim()}&src={url}`)
                watch.set(iinaRef.current.trim() ? `${b}/watch?key=${keyRef.current.trim()}` : "")
            }
            const base = publicRef.current.trim().replace(/\/$/, "")
            if (!base) {
                setLinks(`http://localhost:${portRef.current.trim()}`)
                ctx.setTimeout(() => {
                    let host = ""
                    try { host = $toString($os.readFile($filepath.join(root, "ip.txt"))).trim() } catch (e) { }
                    setLinks(`http://${host || "localhost"}:${portRef.current.trim()}`)
                }, 1500)
            } else {
                setLinks(base)
            }
            status.set("Server running")
            ctx.toast.success("Transcode server started")
        }

        const onStart = ctx.eventHandler("ut-start", start)
        const onStop = ctx.eventHandler("ut-stop", () => { stop(); status.set("Server stopped") })

        tray.render(() =>
            tray.stack({
                items: [
                    tray.text("Universal Transcode", { style: { fontWeight: "bold" } }),
                    tray.text("Paste this into Seanime -> Settings -> External player link:"),
                    tray.text(link.get() || "(press Start server)", { style: { wordBreak: "break-all", userSelect: "text", fontSize: "11px" } }),
                    ...(watch.get() ? [
                        tray.text("Bridge mode: bookmark this page. It always shows what IINA is playing:"),
                        tray.text(watch.get(), { style: { wordBreak: "break-all", userSelect: "text", fontSize: "11px" } }),
                    ] : []),
                    tray.flex({ items: [
                        tray.button({ label: "Start / apply settings", onClick: onStart, intent: "primary" }),
                        tray.button({ label: "Stop", onClick: onStop, intent: "alert-subtle" }),
                    ] }),
                    tray.text(status.get()),
                    tray.input({ label: "Default subtitle: auto, a language code (eng), a track number, or blank for none. All tracks stay selectable in the player", fieldRef: subRef }),
                    tray.input({ label: "Audio track (0 = first)", fieldRef: audioRef }),
                    tray.input({ label: "Quality CRF (lower = better, 18)", fieldRef: crfRef }),
                    tray.select({ label: "Max height", fieldRef: heightRef, options: [
                        { label: "1080p", value: "1080" }, { label: "720p", value: "720" }, { label: "480p", value: "480" } ] }),
                    tray.select({ label: "Encoder", fieldRef: encRef, options: [
                        { label: "CPU (libx264) - best quality", value: "libx264" },
                        { label: "Apple (videotoolbox) - fast", value: "h264_videotoolbox" },
                        { label: "NVIDIA (nvenc)", value: "h264_nvenc" },
                        { label: "Intel (qsv)", value: "h264_qsv" } ] }),
                    tray.input({ label: "Public URL (blank = LAN IP), e.g. https://hls.example.com", fieldRef: publicRef }),
                    tray.input({ label: "Port", fieldRef: portRef }),
                    tray.input({ label: "ffmpeg path", fieldRef: ffmpegRef }),
                    tray.input({ label: "python3 path", fieldRef: pythonRef }),
                    tray.input({ label: "Seanime server URL (local)", fieldRef: seanimeRef }),
                    tray.input({ label: "IINA bridge socket (blank = off, usually /tmp/iina_socket)", fieldRef: iinaRef }),
                    tray.input({ label: "Access key (part of the link; changing it means re-pasting the link in Seanime)", fieldRef: keyRef }),
                    ...(note.get() ? [tray.text(note.get(), { style: { fontSize: "10px", wordBreak: "break-all", userSelect: "text" } })] : []),
                ],
            }),
        )

        // Start automatically when Seanime starts
        start()
    })
}
