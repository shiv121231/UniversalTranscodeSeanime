/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Universal Transcode v1.0 — Video.js 10 (neutral skin) web player, subtitle controls, skip opening/ending, lower RAM, cool mode
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
        const memRef = ctx.fieldRef<string>(saved("mem", "balanced")) // ffmpeg memory profile: low | balanced | full
        const heatRef = ctx.fieldRef<string>(saved("heat", "cool")) // cool | balanced | full
        const skipRef = ctx.fieldRef<string>(saved("skiplookup", "on")) // look up opening/ending times online (AniList + AniSkip)
        const bitrateRef = ctx.fieldRef<string>(saved("bitrate", "8")) // Mbps at 1080p for the hardware encoder
        const idleRef = ctx.fieldRef<string>(saved("idle", "10")) // minutes without a viewer before ffmpeg is stopped (0 = never)

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
import argparse, atexit, base64, hmac, html, http.server, json, os, re, secrets, shutil, socket, subprocess, sys, threading, time, urllib.error, urllib.parse, urllib.request

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
ap.add_argument("--memory", default="balanced", choices=["low", "balanced", "full"],
                help="ffmpeg memory profile: low (~half the RAM of full), balanced, full (auto threads, old behaviour)")
ap.add_argument("--heat", default="cool", choices=["cool", "balanced", "full"],
                help="cool: hardware encoder + paced transcode (fanless laptops); balanced; full: as fast as possible (hottest)")
ap.add_argument("--bitrate", type=float, default=8.0, help="video bitrate in Mbps at 1080p for the hardware encoder")
ap.add_argument("--keep-iina-video", action="store_true", help="bridge mode: do not switch IINA's video off while you watch in the browser")
ap.add_argument("--no-skip-lookup", action="store_true",
                help="do not look up opening/ending times online (chapters inside the file are still used)")
ap.add_argument("--anilist-url", default="https://graphql.anilist.co", help=argparse.SUPPRESS)
ap.add_argument("--aniskip-url", default="https://api.aniskip.com/v2", help=argparse.SUPPRESS)
ap.add_argument("--idle-stop", type=int, default=600,
                help="stop the transcode and delete its files after this many seconds with no viewer (0 = never)")
ap.add_argument("--ffprobe", default="", help="path to ffprobe (default: next to ffmpeg, else PATH)")
ap.add_argument("--iina-socket", default="", help="bridge mode: IINA/mpv IPC socket, e.g. /tmp/iina_socket")
ap.add_argument("--keep-iina-audio", action="store_true", help="bridge mode: do not mute IINA")
A = ap.parse_args()

os.makedirs(A.root, exist_ok=True)
os.chdir(A.root)
VERSION = "1.0.0"
LOCAL = A.seanime.rstrip("/")
# Shutdown token lives next to (not inside) the served folder, so a newer instance can replace this one
# even if the access key changed. Anything on the web can't read it.
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(A.root)), "seanime-transcode-%d.token" % A.port)
SHUTDOWN_TOKEN = secrets.token_hex(16)
lock = threading.Lock()
current = {"proc": None, "dir": None, "id": None, "ready": None, "state": "idle", "tracks": [], "skipped": [],
           "default": None, "probe_error": "", "src": None, "last": 0.0,
           "skip": {"state": "pending", "segments": []}}

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
  #ut-msg { position: fixed; top: 16px; left: 16px; right: 16px; z-index: 2147483000; padding: 10px 12px; border-radius: 6px;
            background: rgba(0,0,0,.72); font-size: 14px; pointer-events: none; }

  /* subtitle overlay (drawn by us so every style option works the same in every browser) */
  #ut-subs { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 5; }
  #ut-subs .ut-box { position: absolute; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: .12em;
                     transition: bottom .18s ease; }
  #ut-subs .ut-t { white-space: pre-wrap; }
  #ut-skip { position: absolute; right: 3%; bottom: 12%; z-index: 7; pointer-events: auto; display: none; padding: .55em 1em; border-radius: 6px;
             border: 1px solid rgba(255,255,255,.55); background: rgba(0,0,0,.6); color: #fff; font: 600 15px system-ui, sans-serif; cursor: pointer;
             transition: bottom .18s ease, background .15s; }
  #ut-skip:hover { background: rgba(255,255,255,.22); }
  #ut-toast { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 6; padding: 6px 12px; border-radius: 6px;
              background: rgba(0,0,0,.7); color: #fff; font: 14px system-ui, sans-serif; pointer-events: none; opacity: 0; transition: opacity .2s; }
  #ut-toast.on { opacity: 1; }

  #ut-fab { position: fixed; top: max(12px, env(safe-area-inset-top)); right: 12px; z-index: 2147483000; padding: 7px 12px; border: 0; border-radius: 6px;
            background: rgba(0,0,0,.6); color: #fff; font: 14px system-ui, sans-serif; cursor: pointer; display: none; transition: opacity .25s; }
  #ut-card { position: fixed; top: calc(max(12px, env(safe-area-inset-top)) + 40px); right: 12px; z-index: 2147483000; width: min(360px, calc(100vw - 24px));
             border-radius: 8px; background: rgba(20,20,20,.95); color: #eee; display: none; }
  #ut-card.open { display: block; }
</style>
<style id="ut-ctl-style">
  /* controls injected into Video.js's Captions menu (or the fallback card) */
  .ut-ctl { box-sizing: border-box; padding: 8px 12px 10px; font-size: 12px; line-height: 1.35; color: inherit; text-align: left;
            border-top: 1px solid rgba(255,255,255,.14); max-height: 52vh; overflow-y: auto; accent-color: var(--media-accent-color, #fff); }
  .ut-ctl * { box-sizing: border-box; }
  .ut-ctl h5 { margin: 8px 0 4px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; opacity: .65; }
  .ut-ctl h5:first-child { margin-top: 0; }
  .ut-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; min-height: 24px; }
  .ut-row > label { flex: 0 0 76px; opacity: .85; }
  .ut-row input[type=range] { flex: 1; min-width: 0; margin: 0; }
  .ut-row input[type=text] { flex: 1; min-width: 0; padding: 3px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.08); color: inherit; font: inherit; }
  .ut-val { flex: 0 0 52px; text-align: right; font-variant-numeric: tabular-nums; opacity: .9; }
  .ut-ctl button { font: inherit; color: inherit; background: rgba(255,255,255,.12); border: 0; border-radius: 4px; padding: 3px 8px; cursor: pointer; }
  .ut-ctl button:hover { background: rgba(255,255,255,.2); }
  .ut-ctl button.on { background: var(--media-accent-color, #fff); color: var(--media-accent-text-color, #000); }
  .ut-seg { display: flex; flex-wrap: wrap; gap: 3px; flex: 1; }
  .ut-sw { width: 20px; height: 20px; padding: 0 !important; border-radius: 50% !important; border: 2px solid rgba(255,255,255,.35) !important; }
  .ut-sw.on { border-color: #fff !important; outline: 2px solid var(--media-accent-color, #fff); }
  .ut-ctl details { margin: 6px 0; border-top: 1px solid rgba(255,255,255,.1); padding-top: 4px; }
  .ut-ctl summary { cursor: pointer; padding: 3px 0; font-weight: 600; }
  .ut-note { margin-top: 6px; opacity: .6; font-size: 11px; }
</style>
<script type="module" src="https://cdn.jsdelivr.net/npm/@videojs/cdn@10.0.1/video-neutral.js"></script>
<script type="module" src="https://cdn.jsdelivr.net/npm/@videojs/cdn@10.0.1/media/hlsjs-video.js"></script>
</head>
<body>
<video-player>
  <video-neutral-skin>
    <hlsjs-video id="v" autoplay playsinline preload="auto" crossorigin="anonymous" stream-type="on-demand">
__TRACKS__
    </hlsjs-video>
  </video-neutral-skin>
</video-player>

<div id="ut-msg" role="status" aria-live="polite">Starting transcode...</div>
<button id="ut-fab" type="button">Subtitles</button>
<div id="ut-card"></div>

<script id="ut-cfg" type="application/json">__CFG__</script>
<script>
(function () {
  'use strict';
  var cfg = JSON.parse(document.getElementById('ut-cfg').textContent);
  var media = document.getElementById('v');
  var msg = document.getElementById('ut-msg');
  var params = new URLSearchParams(location.search);
  var key = params.get('key');
  var sid = location.pathname.split('/')[1];
  var t0 = Date.now();

  function show(t) { msg.textContent = t; msg.style.display = 'block'; }
  function hide() { msg.style.display = 'none'; }
  function load(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // ================================================================ subtitle model
  var FONTS = {
    sans:   { label: 'Sans',       css: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Hiragino Sans", "Noto Sans CJK JP", "Yu Gothic", "Microsoft YaHei", sans-serif' },
    serif:  { label: 'Serif',      css: 'Georgia, "Times New Roman", "Hiragino Mincho ProN", "Noto Serif CJK JP", serif' },
    mono:   { label: 'Mono',       css: 'ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace' },
    rounded:{ label: 'Rounded',    css: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", "Arial Rounded MT Bold", system-ui, sans-serif' },
    casual: { label: 'Casual',     css: '"Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive' },
    caps:   { label: 'Small caps', css: 'Georgia, "Times New Roman", serif', variant: 'small-caps' }
  };
  var DEFAULTS = {
    font: 'sans', fontCustom: '', size: 4.6, bold: false, italic: false, upper: false,
    color: '#ffffff', opacity: 100, lineHeight: 1.25, spacing: 0,
    bg: '#000000', bgOpacity: 0, pad: 0.25, radius: 0.15,
    edge: 'outline', edgeColor: '#000000', edgeWidth: 4,
    bottom: 7, lift: 7, width: 82, align: 'center'
  };
  var PRESETS = {
    'Default':       {},
    'Classic':       { color: '#ffe84a', edge: 'outline', edgeColor: '#000000', bold: true },
    'Cinema':        { edge: 'none', bgOpacity: 62, pad: 0.3, radius: 0.2, size: 4.4 },
    'High contrast': { bold: true, bgOpacity: 100, edge: 'none', size: 5.2, pad: 0.3, radius: 0 },
    'Large print':   { size: 6.8, bold: true, edge: 'outline', edgeWidth: 5 },
    'Soft shadow':   { edge: 'shadow', edgeColor: '#000000', edgeWidth: 4, bold: true }
  };
  var SWATCHES = ['#ffffff', '#ffe84a', '#7fe3ff', '#8dff8d', '#ff9ad5', '#ff6b6b', '#c9c9c9', '#000000'];

  var style = {};
  (function () {
    var stored = {};
    try { stored = JSON.parse(load('ut.sub.style', '{}')) || {}; } catch (e) {}
    for (var k in DEFAULTS) style[k] = (stored[k] !== undefined && typeof stored[k] === typeof DEFAULTS[k]) ? stored[k] : DEFAULTS[k];
  })();
  var styleVer = 1;
  function setStyle(patch) { for (var k in patch) style[k] = patch[k]; styleVer++; save('ut.sub.style', JSON.stringify(style)); preview(); }

  // Subtitle delay. Cue times stay the ORIGINAL timestamps (same timeline as mpv/IINA); the delay is added on lookup only.
  var delay = parseFloat(load('ut.subdelay', '0')) || 0;
  function clampDelay(d) { return Math.max(-5, Math.min(5, Math.round(d * 100) / 100)); }
  delay = clampDelay(delay);
  function setDelay(d) { delay = clampDelay(d); save('ut.subdelay', String(delay)); styleVer++; refreshControls(); }
  function fmtDelay(d) { return (d > 0 ? '+' : d < 0 ? '-' : '') + Math.abs(d).toFixed(2) + ' s'; }

  // ---------------------------------------------------------------- pure helpers (also exposed as window.__ut for debugging)
  function hexRgba(hex, pct) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    var n = m ? parseInt(m[1], 16) : 0xffffff;
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + (Math.max(0, Math.min(100, pct)) / 100) + ')';
  }
  function ring(w, color) {                          // outline from text-shadows: works in every browser
    var s = [], steps = 16;
    for (var i = 0; i < steps; i++) {
      var a = i / steps * Math.PI * 2;
      s.push((Math.cos(a) * w).toFixed(2) + 'px ' + (Math.sin(a) * w).toFixed(2) + 'px 0 ' + color);
    }
    return s.join(',');
  }
  function edgeShadow(S, px) {
    var w = Math.max(0.5, px * S.edgeWidth / 100), c = S.edgeColor;
    switch (S.edge) {
      case 'outline':   return S.edgeWidth > 0 ? ring(w, c) : 'none';
      case 'shadow':    return (w * 0.9).toFixed(2) + 'px ' + (w * 0.9).toFixed(2) + 'px ' + (w * 1.6).toFixed(2) + 'px ' + c + ',0 0 ' + (w * 2).toFixed(2) + 'px ' + c;
      case 'raised':    return (-w * 0.6).toFixed(2) + 'px ' + (-w * 0.6).toFixed(2) + 'px 0 rgba(255,255,255,.55),' + (w * 0.8).toFixed(2) + 'px ' + (w * 0.8).toFixed(2) + 'px 0 ' + c;
      case 'depressed': return (w * 0.6).toFixed(2) + 'px ' + (w * 0.6).toFixed(2) + 'px 0 rgba(255,255,255,.55),' + (-w * 0.8).toFixed(2) + 'px ' + (-w * 0.8).toFixed(2) + 'px 0 ' + c;
      default:          return 'none';
    }
  }
  function cueCss(S, boxH) {                         // -> CSS properties for the text spans
    var px = Math.max(8, boxH * S.size / 100);
    var f = FONTS[S.font] || FONTS.sans;
    var family = (S.font === 'custom' && S.fontCustom) ? '"' + S.fontCustom.replace(/["\\\\;{}]/g, '') + '", ' + FONTS.sans.css : f.css;
    return {
      fontFamily: family, fontSize: px.toFixed(1) + 'px', fontWeight: S.bold ? '700' : '400', fontStyle: S.italic ? 'italic' : 'normal',
      fontVariant: f.variant || 'normal', textTransform: S.upper ? 'uppercase' : 'none',
      color: hexRgba(S.color, S.opacity), lineHeight: String(S.lineHeight), letterSpacing: S.spacing + 'em',
      background: S.bgOpacity > 0 ? hexRgba(S.bg, S.bgOpacity) : 'transparent',
      padding: S.bgOpacity > 0 ? '0.05em ' + S.pad + 'em' : '0', borderRadius: S.radius + 'em',
      textShadow: edgeShadow(S, px)
    };
  }
  // cue text -> safe HTML (VTT text: allow <i><b><u>, keep &amp; &lt; &gt; &nbsp; entities, drop every other tag)
  function fmt(text) {
    var s = String(text)
      .replace(/<(\\/?)([ibu])>/gi, '\\u0001$1$2\\u0002')
      .replace(/<[^>]*>/g, '')
      .replace(/[<>]/g, function (c) { return c === '<' ? '&lt;' : '&gt;'; })
      .replace(/&(?!(?:amp|lt|gt|nbsp|lrm|rlm);)/g, '&amp;');
    var stack = [];                                    // keep <i>/<b>/<u> balanced so nothing leaks into the next line
    s = s.replace(/\\u0001(\\/?)([ibu])\\u0002/g, function (m, close, tag) {
      if (!close) { stack.push(tag); return '<' + tag + '>'; }
      var i = stack.lastIndexOf(tag);
      if (i < 0) return '';
      var out = '';
      while (stack.length - 1 > i) out += '</' + stack.pop() + '>';
      stack.pop();
      return out + '</' + tag + '>';
    });
    while (stack.length) s += '</' + stack.pop() + '>';
    return s.replace(/[\\u0001\\u0002]/g, '').replace(/\\n/g, '<br>');
  }
  // cues sorted by start time; returns those showing at time t (with the delay applied)
  function activeAt(list, t, d, maxDur) {
    var lo = 0, hi = list.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (list[mid][0] + d <= t) lo = mid + 1; else hi = mid; }
    var out = [];
    for (var i = lo - 1; i >= 0; i--) {
      var c = list[i];
      if (c[0] + d < t - maxDur) break;
      if (c[1] + d > t) out.push(c);
    }
    return out.reverse();
  }

  // ================================================================ cue store (compact arrays, selected track only)
  var tracks = cfg.tracks.map(function (t) { return { info: t, tt: null, list: [], maxDur: 0, off: 0, busy: false, done: false }; });
  var selected = null;                                // the track object that is showing
  var didInit = false;

  function findTT(t) {
    var list = media.textTracks;
    if (list) {
      for (var i = 0; i < list.length; i++) if (list[i].id === t.info.id) return list[i];
      for (var j = 0; j < list.length; j++) if (list[j].label === t.info.label && list[j].language === t.info.lang) return list[j];
    }
    if (Date.now() - t0 > 3000 && media.addTextTrack) { var made = media.addTextTrack('subtitles', t.info.label, t.info.lang); if (made) return made; }
    return null;
  }
  function release(t) { t.list = []; t.maxDur = 0; t.off = 0; t.done = false; }   // free memory of tracks that are not showing
  function readSelection() {
    var now = null;
    tracks.forEach(function (t) {
      if (!t.tt) t.tt = findTT(t);
      if (t.tt && t.tt.mode === 'showing' && !now) now = t;
    });
    if (now !== selected) { if (selected) release(selected); selected = now; styleVer++; renderTrackButtons(); }
  }
  function setTrack(t) {                               // t = track object or null (off)
    tracks.forEach(function (x) { if (!x.tt) x.tt = findTT(x); if (x.tt) x.tt.mode = (x === t) ? 'showing' : 'disabled'; });
    readSelection();
  }
  function initialSelect() {
    var all = tracks.every(function (t) { if (!t.tt) t.tt = findTT(t); return !!t.tt; });
    if (!all && Date.now() - t0 < 4000) return false;
    didInit = true;
    var d = null;
    tracks.forEach(function (t) { if (t.info.id === cfg.default) d = t; });
    if (d) setTrack(d); else readSelection();
    return true;
  }
  function pump() {
    if (!tracks.length) return;
    if (!didInit && !initialSelect()) return;
    readSelection();
    var t = selected;
    if (!t || t.busy || t.done) return;
    t.busy = true;
    fetch('cues?s=' + t.info.index + '&off=' + t.off, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (t !== selected) return;                    // switched away meanwhile
        if (j.cues && j.cues.length) {
          var needSort = false;
          j.cues.forEach(function (c) {
            if (t.list.length && c[0] < t.list[t.list.length - 1][0]) needSort = true;
            t.list.push(c);
            if (c[1] - c[0] > t.maxDur) t.maxDur = c[1] - c[0];
          });
          if (needSort) t.list.sort(function (a, b) { return a[0] - b[0]; });
          styleVer++;
        }
        t.off = j.off; t.done = !!j.done;
      })
      .catch(function () {})
      .then(function () { t.busy = false; });
  }
  setInterval(pump, 2000);
  if (media.textTracks && media.textTracks.addEventListener) {
    media.textTracks.addEventListener('change', function () { readSelection(); pump(); });
    media.textTracks.addEventListener('addtrack', function () { setTimeout(pump, 100); });
  }

  // ================================================================ skip opening / ending
  var LABELS = { op: 'Opening', ed: 'Ending', recap: 'Recap', preview: 'Preview' };
  var skip = { segs: [], state: 'pending' }, skipDone = {};
  var autoSkip = { op: false, ed: false, recap: false, preview: false };
  try { var as = JSON.parse(load('ut.autoskip', '{}')) || {}; for (var ak in autoSkip) if (as[ak] === true) autoSkip[ak] = true; } catch (e) {}
  function segKey(s) { return s.type + '@' + s.start; }
  function mmss(x) { x = Math.max(0, Math.round(x)); return Math.floor(x / 60) + ':' + ('0' + (x % 60)).slice(-2); }
  function loadSkip(n) {
    fetch('skip', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      skip.state = j.state; skip.segs = j.segments || [];
      if (j.state === 'pending' && n < 60) setTimeout(function () { loadSkip(n + 1); }, 2000);
      refreshControls();
    }).catch(function () { if (n < 60) setTimeout(function () { loadSkip(n + 1); }, 3000); });
  }
  function activeSeg(t) {
    for (var i = 0; i < skip.segs.length; i++) {
      var s = skip.segs[i];
      if (t >= s.start - 0.3 && t < s.end - 1) return s;
    }
    return null;
  }
  function seekableEnd() {
    try { var r = media.seekable; return (r && r.length) ? r.end(r.length - 1) : Infinity; } catch (e) { return Infinity; }
  }
  function doSkip(seg) {                                // never seek past what has been transcoded so far
    var target = Math.min(seg.end, seekableEnd() - 0.3);
    if (!(target > (media.currentTime || 0) + 0.5)) return false;
    media.currentTime = target;
    toast('Skipped ' + (LABELS[seg.type] || seg.type).toLowerCase());
    return true;
  }
  function updateSkipUi(t) {
    var seg = activeSeg(t);
    if (seg && autoSkip[seg.type] && !skipDone[segKey(seg)] && !media.paused) {
      skipDone[segKey(seg)] = true;                     // once per segment, so rewinding into it works normally
      if (doSkip(seg)) seg = null;
    }
    skipSeg = seg;
    if (!skipEl) return;
    if (!seg) { skipEl.style.display = 'none'; return; }
    skipEl.textContent = 'Skip ' + (LABELS[seg.type] || seg.type) + ' \\u25B6';
    skipEl.style.bottom = (controlsVisible() ? 17 : 10) + '%';
    skipEl.style.display = 'block';
  }

  // ================================================================ overlay renderer
  var host = null, overlay = null, box = null, toastEl = null, skipEl = null, skipSeg = null, lastSig = '', previewUntil = 0, lastActivity = Date.now();
  function findHost() {
    return document.querySelector('media-container') || document.querySelector('video-neutral-skin') ||
           document.querySelector('video-player') || document.body;
  }
  function ensureOverlay() {
    var h = findHost();
    if (!overlay) {
      overlay = document.createElement('div'); overlay.id = 'ut-subs';
      box = document.createElement('div'); box.className = 'ut-box'; overlay.appendChild(box);
      toastEl = document.createElement('div'); toastEl.id = 'ut-toast';
      skipEl = document.createElement('button'); skipEl.id = 'ut-skip'; skipEl.type = 'button';
      // clicks on our button must not reach the player (a click on the video toggles play, a double click goes fullscreen)
      ['click', 'dblclick', 'pointerdown', 'mousedown', 'touchstart'].forEach(function (n) { skipEl.addEventListener(n, function (e) { e.stopPropagation(); }); });
      skipEl.addEventListener('click', function () { if (skipSeg) { skipDone[segKey(skipSeg)] = true; doSkip(skipSeg); } });
    }
    if (overlay.parentNode !== h) {
      if (h !== document.body && h.style && getComputedStyle(h).position === 'static') h.style.position = 'relative';
      h.appendChild(overlay); h.appendChild(toastEl); h.appendChild(skipEl); host = h; lastSig = '';
    }
  }
  function preview() { previewUntil = Date.now() + 2500; }
  var toastTimer;
  function toast(t) { ensureOverlay(); toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 1100); }

  function controlsVisible() { return media.paused || Date.now() - lastActivity < 3000; }
  function frame() {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    ensureOverlay();
    if (!attached && fab.style.display === 'block') {          // fallback button only: show it with the player controls
      var showFab = controlsVisible() || card.classList.contains('open');
      fab.style.opacity = showFab ? '1' : '0';
      fab.style.pointerEvents = showFab ? 'auto' : 'none';
    }
    var t = media.currentTime || 0;
    updateSkipUi(t);
    var act = (selected && selected.list.length) ? activeAt(selected.list, t, delay, selected.maxDur) : [];
    var sample = !act.length && Date.now() < previewUntil;
    var h = overlay.clientHeight || 0;
    var lift = controlsVisible() ? style.lift : 0;
    var sig = [styleVer, Math.round(h), lift, sample ? 's' : '', act.map(function (c) { return c[0] + '|' + c[1]; }).join(',')].join('#');
    if (sig === lastSig) return;
    lastSig = sig;
    var css = cueCss(style, h || 720);
    box.style.bottom = (style.bottom + lift) + '%';
    box.style.width = style.width + '%';
    box.style.alignItems = style.align === 'left' ? 'flex-start' : style.align === 'right' ? 'flex-end' : 'center';
    box.style.textAlign = style.align;
    var rows = act.length ? act.map(function (c) { return fmt(c[2]); }) : (sample ? ['Sample subtitle text<br>second line'] : []);
    box.innerHTML = rows.map(function (r) { return '<div><span class="ut-t">' + r + '</span></div>'; }).join('');
    var spans = box.querySelectorAll('.ut-t');
    for (var i = 0; i < spans.length; i++) {
      for (var p in css) spans[i].style[p] = css[p];
      spans[i].style.webkitBoxDecorationBreak = 'clone'; spans[i].style.boxDecorationBreak = 'clone';
    }
  }

  // ================================================================ controls (built once, mounted in Video.js's Captions menu)
  var ctl = document.createElement('div'); ctl.className = 'ut-ctl';
  var updaters = [], trackBtns = [];
  function refreshControls() { updaters.forEach(function (u) { u(); }); }
  function renderTrackButtons() { trackBtns.forEach(function (u) { u(); }); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function row(label, parent) { var r = el('div', 'ut-row'); if (label) r.appendChild(el('label', '', label)); parent.appendChild(r); return r; }
  function slider(parent, label, k, min, max, step, f) {
    var r = row(label, parent), inp = el('input'), val = el('span', 'ut-val');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step;
    inp.addEventListener('input', function () { var p = {}; p[k] = parseFloat(inp.value); setStyle(p); val.textContent = f(style[k]); });
    r.appendChild(inp); r.appendChild(val);
    updaters.push(function () { inp.value = style[k]; val.textContent = f(style[k]); });
  }
  function seg(parent, label, k, opts) {
    var r = row(label, parent), g = el('div', 'ut-seg'); r.appendChild(g); var bs = [];
    opts.forEach(function (o) {
      var b = el('button', '', o[1]); b.type = 'button';
      b.addEventListener('click', function () { var p = {}; p[k] = o[0]; setStyle(p); refreshControls(); });
      g.appendChild(b); bs.push([o[0], b]);
    });
    updaters.push(function () { bs.forEach(function (x) { x[1].classList.toggle('on', style[k] === x[0]); }); });
    return g;
  }
  function toggle(parent, label, k) {
    var r = row(label, parent), b = el('button'); b.type = 'button';
    b.addEventListener('click', function () { var p = {}; p[k] = !style[k]; setStyle(p); refreshControls(); });
    r.appendChild(b); updaters.push(function () { b.textContent = style[k] ? 'On' : 'Off'; b.classList.toggle('on', !!style[k]); });
  }
  function colour(parent, label, k) {
    var r = row(label, parent), g = el('div', 'ut-seg'), sws = [], hex = el('input'); r.appendChild(g);
    SWATCHES.forEach(function (c) {
      var b = el('button', 'ut-sw'); b.type = 'button'; b.style.background = c; b.title = c;
      b.addEventListener('click', function () { var p = {}; p[k] = c; setStyle(p); refreshControls(); });
      g.appendChild(b); sws.push([c, b]);
    });
    hex.type = 'text'; hex.maxLength = 7; hex.style.flex = '0 0 66px'; hex.placeholder = '#rrggbb';
    hex.addEventListener('change', function () { if (/^#[0-9a-f]{6}$/i.test(hex.value)) { var p = {}; p[k] = hex.value.toLowerCase(); setStyle(p); refreshControls(); } });
    r.appendChild(hex);
    updaters.push(function () { hex.value = style[k]; sws.forEach(function (x) { x[1].classList.toggle('on', x[0] === style[k]); }); });
  }
  function section(title, open) { var d = el('details'); if (open) d.open = true; d.appendChild(el('summary', '', title)); ctl.appendChild(d); return d; }
  var P = function (n) { return n + '%'; };

  (function buildControls() {
    // ---- tracks (a second way to pick a track; Video.js's own list above stays the main one)
    if (tracks.length) {
      ctl.appendChild(el('h5', '', 'Subtitle track'));
      var tr = el('div', 'ut-row'); var tg = el('div', 'ut-seg'); tr.appendChild(tg); ctl.appendChild(tr);
      var off = el('button', '', 'Off'); off.type = 'button'; off.addEventListener('click', function () { setTrack(null); }); tg.appendChild(off);
      trackBtns.push(function () { off.classList.toggle('on', !selected); });
      tracks.forEach(function (t) {
        var b = el('button', '', t.info.label); b.type = 'button'; b.addEventListener('click', function () { setTrack(t); });
        tg.appendChild(b); trackBtns.push(function () { b.classList.toggle('on', selected === t); });
      });
    }
    // ---- timing
    ctl.appendChild(el('h5', '', 'Subtitle timing'));
    var dr = row('Delay', ctl), dm = el('button', '', '-0.1'), dp = el('button', '', '+0.1'), ds = el('input'), dv = el('span', 'ut-val');
    dm.type = dp.type = 'button'; ds.type = 'range'; ds.min = -5; ds.max = 5; ds.step = 0.05;
    dm.addEventListener('click', function () { setDelay(delay - 0.1); });
    dp.addEventListener('click', function () { setDelay(delay + 0.1); });
    ds.addEventListener('input', function () { setDelay(parseFloat(ds.value)); });
    dr.appendChild(dm); dr.appendChild(ds); dr.appendChild(dp);
    var dr2 = row('', ctl), dz = el('button', '', 'Reset'); dz.type = 'button'; dz.addEventListener('click', function () { setDelay(0); });
    dr2.appendChild(el('span', '', '0 = original timing (same as mpv/IINA).')); dr2.appendChild(dv); dr2.appendChild(dz);
    updaters.push(function () { ds.value = delay; dv.textContent = fmtDelay(delay); });

    // ---- skip opening / ending
    ctl.appendChild(el('h5', '', 'Skip opening / ending'));
    ['op', 'ed', 'recap', 'preview'].forEach(function (k) {
      var r = row('Auto-skip ' + LABELS[k].toLowerCase(), ctl), b = el('button'); b.type = 'button';
      b.addEventListener('click', function () { autoSkip[k] = !autoSkip[k]; save('ut.autoskip', JSON.stringify(autoSkip)); refreshControls(); });
      r.appendChild(b); updaters.push(function () { b.textContent = autoSkip[k] ? 'On' : 'Off'; b.classList.toggle('on', !!autoSkip[k]); });
    });
    var sinfo = el('div', 'ut-note'); ctl.appendChild(sinfo);
    updaters.push(function () {
      sinfo.textContent = skip.state === 'pending' ? 'Looking for opening/ending times...' :
        skip.segs.length ? 'Found: ' + skip.segs.map(function (s) { return (LABELS[s.type] || s.type) + ' ' + mmss(s.start) + '-' + mmss(s.end) + ' (' + (s.source === 'chapters' ? 'file chapters' : s.approx ? 'AniSkip, approximate' : 'AniSkip') + ')'; }).join(', ')
                         : 'No opening/ending data for this file.';
    });

    // ---- text
    var tx = section('Text', true);
    var fg = seg(tx, 'Font', 'font', Object.keys(FONTS).map(function (k) { return [k, FONTS[k].label]; }).concat([['custom', 'Custom']]));
    var cr = row('', tx), cf = el('input'); cf.type = 'text'; cf.placeholder = 'Custom font name (e.g. Helvetica Neue)';
    cf.addEventListener('change', function () { setStyle({ fontCustom: cf.value.trim(), font: cf.value.trim() ? 'custom' : style.font }); refreshControls(); });
    cr.appendChild(cf); updaters.push(function () { cf.value = style.fontCustom; });
    slider(tx, 'Size', 'size', 2, 10, 0.1, function (v) { return v.toFixed(1) + '%'; });
    toggle(tx, 'Bold', 'bold'); toggle(tx, 'Italic', 'italic'); toggle(tx, 'UPPERCASE', 'upper');
    colour(tx, 'Colour', 'color');
    slider(tx, 'Opacity', 'opacity', 10, 100, 5, P);
    slider(tx, 'Line height', 'lineHeight', 1, 2, 0.05, function (v) { return v.toFixed(2); });
    slider(tx, 'Spacing', 'spacing', -0.05, 0.3, 0.01, function (v) { return v.toFixed(2); });

    // ---- background & edge
    var bg = section('Background & edge', false);
    colour(bg, 'Box colour', 'bg');
    slider(bg, 'Box opacity', 'bgOpacity', 0, 100, 5, P);
    slider(bg, 'Box padding', 'pad', 0, 1, 0.05, function (v) { return v.toFixed(2); });
    slider(bg, 'Corners', 'radius', 0, 0.6, 0.05, function (v) { return v.toFixed(2); });
    seg(bg, 'Edge', 'edge', [['none', 'None'], ['outline', 'Outline'], ['shadow', 'Shadow'], ['raised', 'Raised'], ['depressed', 'Depressed']]);
    colour(bg, 'Edge colour', 'edgeColor');
    slider(bg, 'Edge width', 'edgeWidth', 0, 10, 0.5, P);

    // ---- position
    var ps = section('Position', false);
    slider(ps, 'From bottom', 'bottom', 0, 40, 1, P);
    slider(ps, 'Lift for bar', 'lift', 0, 20, 1, P);
    slider(ps, 'Max width', 'width', 30, 100, 1, P);
    seg(ps, 'Align', 'align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]);

    // ---- presets
    var pr = section('Presets', false), prow = row('', pr), pg = el('div', 'ut-seg'); prow.appendChild(pg);
    Object.keys(PRESETS).forEach(function (n) {
      var b = el('button', '', n); b.type = 'button';
      b.addEventListener('click', function () { var p = {}; for (var k in DEFAULTS) p[k] = DEFAULTS[k]; for (var q in PRESETS[n]) p[q] = PRESETS[n][q]; setStyle(p); refreshControls(); });
      pg.appendChild(b);
    });
    var rr = row('', pr), rb = el('button', '', 'Reset all style'); rb.type = 'button';
    rb.addEventListener('click', function () { var p = {}; for (var k in DEFAULTS) p[k] = DEFAULTS[k]; setStyle(p); setDelay(0); refreshControls(); });
    rr.appendChild(rb);
    ctl.appendChild(el('div', 'ut-note', 'Keys: z = -0.1 s, x = +0.1 s, s = skip opening/ending. Settings are remembered in this browser.'));
    refreshControls(); renderTrackButtons();
  })();
  // keep Video.js's menu and hotkeys from reacting to keys/clicks typed into our controls
  ['keydown', 'keyup', 'keypress', 'click'].forEach(function (n) { ctl.addEventListener(n, function (e) { e.stopPropagation(); }); });

  // ---------------------------------------------------------------- mounting: Video.js's Captions menu, else a small fallback card
  var attached = false, fab = document.getElementById('ut-fab'), card = document.getElementById('ut-card');
  var observed = [], mo = null;

  // find an element in the page, also looking inside open shadow roots (in case the skin uses them)
  function deepFind(sel, root) {
    root = root || document;
    var hit = root.querySelector ? root.querySelector(sel) : null;
    if (hit) return hit;
    var els = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < els.length; i++) {
      var sr = els[i].shadowRoot;
      if (sr) { watchRoot(sr); var r = deepFind(sel, sr); if (r) return r; }
    }
    return null;
  }
  function watchRoot(r) {
    if (!mo || observed.indexOf(r) >= 0) return;
    observed.push(r); mo.observe(r, { childList: true, subtree: true });
  }
  function ensureStyleIn(node) {                       // our control CSS must also exist inside a shadow root
    var rootNode = node.getRootNode ? node.getRootNode() : document;
    if (!rootNode || rootNode === document || !rootNode.appendChild) return;
    if (rootNode.querySelector && rootNode.querySelector('style[data-ut]')) return;
    var st = document.getElementById('ut-ctl-style').cloneNode(true);
    st.removeAttribute('id'); st.setAttribute('data-ut', '1'); rootNode.appendChild(st);
  }
  function tryAttach() {
    var g = deepFind('media-captions-radio-group');
    if (!g || !g.parentNode) return false;
    ensureStyleIn(g);
    if (ctl.previousSibling !== g || ctl.parentNode !== g.parentNode) g.parentNode.insertBefore(ctl, g.nextSibling);
    if (!attached) {
      attached = true; fab.style.display = 'none'; card.classList.remove('open');
      try { console.log('[universal-transcode] subtitle controls added to the Captions menu'); } catch (e) {}
    }
    return true;
  }
  if (tracks.length) {
    var pending = false;
    mo = new MutationObserver(function () {
      if (pending) return; pending = true;
      requestAnimationFrame(function () { pending = false; tryAttach(); });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    tryAttach();
    setTimeout(function () {
      if (attached) return;
      try { console.warn('[universal-transcode] Captions menu not found yet; showing the fallback button (it appears with the player controls). Run __ut.debug() in the console to see why.'); } catch (e) {}
      card.appendChild(ctl); ensureStyleIn(card); fab.style.display = 'block'; fab.style.opacity = '0';
      fab.addEventListener('click', function () { card.classList.toggle('open'); });
    }, 6000);
  }
  // for troubleshooting: lists custom elements that look related to menus/captions and where they live
  function debug() {
    var tags = {}, hosts = [];
    (function walk(root) {
      var els = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (var i = 0; i < els.length; i++) {
        var n = els[i].tagName.toLowerCase();
        if (n.indexOf('-') > 0) tags[n] = (tags[n] || 0) + 1;
        if (els[i].shadowRoot) { hosts.push(n); walk(els[i].shadowRoot); }
      }
    })(document);
    return { attached: attached, lightDom: !!document.querySelector('media-captions-radio-group'),
             anywhere: !!deepFind('media-captions-radio-group'), shadowHosts: hosts,
             related: Object.keys(tags).filter(function (n) { return /menu|caption|settings|popover/.test(n); }), allTags: tags };
  }

  // hotkeys: z / x nudge the delay by 0.1 s (same keys as mpv)
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (e.ctrlKey || e.metaKey || e.altKey || (/INPUT|TEXTAREA|SELECT/.test(tag) && e.target.type !== 'range')) return;
    if (e.key === 's' && skipSeg) { skipDone[segKey(skipSeg)] = true; doSkip(skipSeg); return; }
    if (e.key === 'z') { setDelay(delay - 0.1); toast('Subtitle delay ' + fmtDelay(delay)); }
    else if (e.key === 'x') { setDelay(delay + 0.1); toast('Subtitle delay ' + fmtDelay(delay)); }
  });
  ['mousemove', 'touchstart', 'keydown', 'pointerdown'].forEach(function (n) { document.addEventListener(n, function () { lastActivity = Date.now(); }, { passive: true }); });

  // ================================================================ playback
  function tuneEngine() {
    // hls.js keeps ALL played video in memory by default (backBufferLength = Infinity). Keep a short window instead.
    var tries = 0, iv = setInterval(function () {
      var eng = media.engine;
      if (eng && eng.config) {
        var c = eng.config;
        c.backBufferLength = 30; c.maxBufferLength = 30; c.maxMaxBufferLength = 60; c.maxBufferSize = 48 * 1000 * 1000;
        c.startPosition = 0;                          // the playlist grows while ffmpeg works; do not jump to the "live" end
        clearInterval(iv);
      } else if (++tries > 60) clearInterval(iv);
    }, 100);
  }
  function begin() {
    customElements.whenDefined('hlsjs-video').then(function () {
      var url = 'index.m3u8';
      try { media.source = { src: url, type: 'application/vnd.apple.mpegurl' }; } catch (e) { media.src = url; }
      if (!media.src) media.src = url;
      tuneEngine();
      // if hls.js still started near the live edge, go back to the start once
      var fixed = false;
      media.addEventListener('loadedmetadata', function () { if (!fixed && media.currentTime > 3) { fixed = true; media.currentTime = 0; } });
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
      fetch('/status?sid=' + encodeURIComponent(sid), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
        if (s.stale) { show('This session ended.'); return; }
        if (s.state === 'failed' || (s.exited && s.code !== 0)) { show('ffmpeg failed (exit code ' + s.code + '). Check ffmpeg.log in the transcode temp folder.'); return; }
        show('Starting transcode...');
        setTimeout(waitForPlaylist, 1500);
      }).catch(function () { setTimeout(waitForPlaylist, 1500); });
    });
  }
  media.addEventListener('playing', hide);
  media.addEventListener('canplay', hide);
  media.addEventListener('error', function () { var e = media.error; show(e && e.message ? 'Player error: ' + e.message : 'Unable to play this stream.'); });

  // bridge mode: if IINA moved on to another episode, follow it
  setInterval(function () {
    fetch('/status?sid=' + encodeURIComponent(sid), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
      if (s.stale && key) location.href = '/watch?key=' + encodeURIComponent(key);
    }).catch(function () {});
  }, 8000);

  // bridge mode: report position/pause state so IINA (and Seanime's progress tracking) follows this player
  if (key) setInterval(function () {
    var time = media.currentTime;
    if ((!time || !isFinite(time)) && media.paused) return;
    fetch('/sync?key=' + encodeURIComponent(key) + '&sid=' + encodeURIComponent(sid) +
      '&t=' + (isFinite(time) ? time : 0).toFixed(1) + '&p=' + (media.paused ? 1 : 0), { cache: 'no-store' }).catch(function () {});
  }, 5000);

  window.__ut = { style: style, cueCss: cueCss, fmt: fmt, activeAt: activeAt, hexRgba: hexRgba, edgeShadow: edgeShadow,
                  debug: debug, deepFind: deepFind, activeSeg: activeSeg,
                  state: function () { return { delay: delay, selected: selected && selected.info.label, cues: selected ? selected.list.length : 0, attached: attached, autoSkip: autoSkip, skip: skip.state, segments: skip.segs.length }; } };
  requestAnimationFrame(frame);
  loadSkip(0);
  waitForPlaylist();
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


def probe_info(src):
    """Streams, chapters and duration of the source (one ffprobe call; only reads the start of the file)."""
    r = subprocess.run([ffprobe_path(), "-v", "error", "-print_format", "json", "-show_streams", "-show_chapters",
                        "-show_format", "-i", src], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=PROBE_TIMEOUT)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or b"ffprobe failed").decode("utf-8", "replace").strip()[-200:])
    j = json.loads(r.stdout.decode("utf-8", "replace"))
    try:
        fmt = j.get("format") or {}
        duration = float(fmt.get("duration") or 0)
        start = float(fmt.get("start_time") or 0)
        if start >= 1.0 and duration > start:
            duration -= start             # container whose timestamps start late: the episode length is what is left
    except (TypeError, ValueError):
        duration = 0.0
    return {"streams": j.get("streams", []), "chapters": j.get("chapters", []), "duration": duration}


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


def read_cues_from(path, off, finished, limit=262144):
    """Read the cues that start at byte offset \`off\` of a (possibly still growing) WebVTT file.
    Returns (cues, new_offset). New offsets always point at the start of an unread block, so the caller can just keep
    asking from where it stopped; nothing is kept on the server between calls."""
    try:
        with open(path, "rb") as f:
            f.seek(off)
            raw = f.read(limit)
    except OSError:
        return [], off
    n, pos, cues = len(raw), 0, []
    at_eof = n < limit
    while pos < n:
        while pos < n and raw[pos:pos + 1] == b"\\n":          # blank separator lines
            pos += 1
        if pos >= n:
            break
        end = raw.find(b"\\n\\n", pos)
        if end == -1:
            # last block. ffmpeg flushes whole cues and puts the blank line in front of the NEXT cue, so a block that ends
            # in a newline (and was read up to the end of the file) is complete.
            if not (finished or (at_eof and raw.endswith(b"\\n"))):
                break
            block, nxt = raw[pos:], n
        else:
            block, nxt = raw[pos:end], end + 2
        lines = block.decode("utf-8", "replace").split("\\n")
        for i, line in enumerate(lines):
            if "-->" in line:
                a_, _, rest = line.partition("-->")
                try:
                    start, stop = parse_ts(a_), parse_ts(rest.strip().split()[0])
                except (ValueError, IndexError):
                    break
                text = "\\n".join(lines[i + 1:]).strip("\\n")
                if text:
                    cues.append([round(start, 3), round(stop, 3), text])
                break
        pos = nxt
    return cues, off + pos


# ---------------------------------------------------------------- opening / ending ("skip intro") data
SKIP_LABELS = {"op": "Opening", "ed": "Ending", "recap": "Recap", "preview": "Preview"}
_CHAPTER_RULES = [("recap", re.compile(r"\\b(recap|previously|summary)\\b", re.I)),
                  ("op", re.compile(r"\\b(op|opening|intro|introduction)\\b|\\bop ?\\d+\\b", re.I)),
                  ("ed", re.compile(r"\\b(ed|ending|outro|credits)\\b|\\bed ?\\d+\\b", re.I)),
                  ("preview", re.compile(r"\\b(preview|next episode|next ep|trailer)\\b", re.I))]


def classify_chapter(title):
    for kind, rx in _CHAPTER_RULES:
        if rx.search(title or ""):
            return kind
    return None


def chapter_segments(chapters, duration):
    """Opening/ending/recap/preview taken from the file's own chapters (exact for this very file)."""
    segs = []
    for c in chapters or []:
        title = (c.get("tags") or {}).get("title", "") or (c.get("tags") or {}).get("TITLE", "")
        kind = classify_chapter(title)
        try:
            start, end = float(c["start_time"]), float(c["end_time"])
        except (KeyError, TypeError, ValueError):
            continue
        if duration:
            end = min(end, duration)
        if kind and end - start >= 5:
            segs.append({"type": kind, "start": round(start, 3), "end": round(end, 3), "source": "chapters", "approx": False})
    return segs


_SEASON_RX = re.compile(r"\\s*[:\\-]?\\s*(\\d+(st|nd|rd|th)\\s+season|season\\s*\\d+|s\\d+|part\\s*\\d+|cour\\s*\\d+|final season)\\s*$", re.I)


def parse_filename(name):
    """('Title', episode) from a release name such as '[Group] Title - 05 [1080p][..].mkv' (None, None if unsure)."""
    base = urllib.parse.unquote(name.rsplit("/", 1)[-1].split("?")[0])
    base = re.sub(r"\\.(mkv|mp4|avi|webm|m4v|ts)$", "", base, flags=re.I)
    base = re.sub(r"\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}", " ", base)
    base = re.sub(r"[_.]+", " ", base)
    base = re.sub(r"\\s+", " ", base).strip(" -")
    m = (re.search(r"^(?P<t>.+?)\\s+-\\s+(?P<e>\\d{1,4})(?:v\\d+)?(?:\\s+-\\s+.*)?$", base) or
         re.search(r"^(?P<t>.+?)\\s+S\\d{1,2}E(?P<e>\\d{1,4})\\b", base, re.I) or
         re.search(r"^(?P<t>.+?)\\s+(?:EP?|Episode)\\s*(?P<e>\\d{1,4})\\b", base, re.I))
    if not m:
        return None, None
    return m.group("t").strip(" -"), int(m.group("e"))


def _http_json(url, data=None, timeout=8):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "universal-transcode/1.0",
                                                          "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def anilist_mal_id(title):
    q = "query($s:String){Media(search:$s,type:ANIME){id idMal title{romaji english} episodes}}"
    try:
        j = _http_json(A.anilist_url, json.dumps({"query": q, "variables": {"s": title}}).encode())
        return (j.get("data") or {}).get("Media") or None
    except Exception:
        return None


def aniskip_segments(mal_id, episode, duration):
    """AniSkip v2. First with the real episode length (exact matches), then without (approximate, flagged)."""
    out = []
    attempts = [(duration, False), (0, True)] if duration else [(0, True)]
    for length, approx in attempts:
        qs = "&".join("types=" + t for t in ("op", "ed", "mixed-op", "mixed-ed", "recap")) + "&episodeLength=%.3f" % (length or 0)
        try:
            j = _http_json("%s/skip-times/%d/%d?%s" % (A.aniskip_url, mal_id, episode, qs))
        except urllib.error.HTTPError:
            j = {}
        except Exception:
            return out
        for r in (j.get("results") or []):
            kind = {"op": "op", "mixed-op": "op", "ed": "ed", "mixed-ed": "ed", "recap": "recap"}.get(r.get("skipType"))
            iv = r.get("interval") or {}
            try:
                start, end = float(iv["startTime"]), float(iv["endTime"])
            except (KeyError, TypeError, ValueError):
                continue
            if not kind or end - start < 5:
                continue
            if approx:
                theirs = float(r.get("episodeLength") or 0)
                if theirs and duration and abs(theirs - duration) > 90:     # a very different cut: the times would not line up
                    continue
            if any(x["type"] == kind for x in out):
                continue
            out.append({"type": kind, "start": round(start, 3), "end": round(min(end, duration) if duration else end, 3),
                        "source": "aniskip", "approx": approx})
        if out:
            break                                              # exact matches found: do not mix in approximate ones
    return out


_skip_cache = {}


def resolve_online(src, duration):
    """Guess the show from the release file name (title + episode), find its MAL id on AniList, ask AniSkip."""
    title, ep = parse_filename(urllib.parse.urlsplit(src).path)
    if not title or ep is None:
        return []
    key = (title.lower(), ep, round(duration))
    if key in _skip_cache:
        return _skip_cache[key]
    variants = [title]
    trimmed = _SEASON_RX.sub("", title).strip()
    if trimmed and trimmed != title:
        variants.append(trimmed)
    segs = []
    for v in variants:
        media = anilist_mal_id(v)
        mal = (media or {}).get("idMal")
        if not mal:
            continue
        total = media.get("episodes")
        if total and ep > total:
            continue                                            # that episode number cannot belong to this entry
        segs = aniskip_segments(int(mal), ep, duration)
        if segs:
            break
    _skip_cache[key] = segs
    return segs


def build_skip(info, src):
    """Chapters win over the online database for the same kind of segment."""
    duration = info.get("duration") or 0.0
    segs = chapter_segments(info.get("chapters"), duration)
    have = {s["type"] for s in segs}
    if not A.no_skip_lookup and not ({"op", "ed"} <= have):
        try:
            for s in resolve_online(src, duration):
                if s["type"] not in have:
                    segs.append(s)
        except Exception as e:
            sys.stderr.write("skip lookup: %s\\n" % e)
    segs.sort(key=lambda x: x["start"])
    return {"state": "ready" if segs else "none", "segments": segs}


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
                   probe_error="", src=None, skip={"state": "pending", "segments": []})
    if ev:
        ev.set()                       # release anyone still waiting for the old session's player page


_caps = {}


def ff_caps():
    """What this ffmpeg build can do (checked once): version, hardware encoders, hardware decoders, input pacing."""
    if _caps:
        return _caps
    caps = {"readrate": True, "videotoolbox_enc": False, "videotoolbox_dec": False}
    try:
        v = subprocess.run([A.ffmpeg, "-hide_banner", "-version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=10).stdout.decode("utf-8", "replace")
        m = re.search(r"ffmpeg version n?(\\d+)\\.(\\d+)", v)
        if m and (int(m.group(1)), int(m.group(2))) < (5, 0):
            caps["readrate"] = False                      # -readrate arrived in ffmpeg 5.0
        enc = subprocess.run([A.ffmpeg, "-hide_banner", "-encoders"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             timeout=10).stdout.decode("utf-8", "replace")
        caps["videotoolbox_enc"] = "h264_videotoolbox" in enc
        hw = subprocess.run([A.ffmpeg, "-hide_banner", "-hwaccels"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=10).stdout.decode("utf-8", "replace")
        caps["videotoolbox_dec"] = "videotoolbox" in hw
    except Exception:
        pass
    _caps.update(caps)
    return _caps


def kbps_for(height, mbps_1080):
    """Hardware encoder bitrate for the chosen output height (kbit/s)."""
    return int(max(1000, mbps_1080 * 1000 * (min(height, 1080) / 1080.0) ** 1.2))


def plan(o, height, caps=None, platform=None):
    """Turn the heat/memory settings into concrete ffmpeg choices.
    cool     = hardware encode + hardware decode (Mac) + paced reading + few threads  -> for fanless laptops
    balanced = the encoder you picked, paced a little, hardware decode where available
    full     = as fast as possible, automatic threads (old behaviour)"""
    caps = caps or ff_caps()
    platform = platform or sys.platform
    heat = o.get("heat") or A.heat
    mem = o.get("mem") or A.memory
    enc = o["enc"]
    mac = platform == "darwin"
    if heat == "cool":
        if mac and caps["videotoolbox_enc"] and enc in ("libx264", "h264_videotoolbox"):
            enc = "h264_videotoolbox"
        mem = "low"
    p = {"enc": enc, "mem": mem, "readrate": None, "hwdecode": False, "kbps": kbps_for(height, A.bitrate)}
    if heat == "cool":
        p["readrate"] = 2.0
    elif heat == "balanced":
        p["readrate"] = 3.0
    if heat != "full" and mac and caps["videotoolbox_dec"]:
        p["hwdecode"] = True
    if p["readrate"] and not caps["readrate"]:
        p["readrate"] = None
    return p


def memory_profile(mode):
    """(decoder threads, encoder threads, extra x264 params). ffmpeg's automatic thread count is 1.5 x CPU cores for x264,
    and every extra frame thread keeps whole 1080p frames in flight, so RAM grows with the core count."""
    cores = os.cpu_count() or 2
    if mode == "low":
        return 2, 2, "rc-lookahead=5:ref=1:sync-lookahead=0"
    if mode == "full":
        return 0, 0, ""
    return min(4, cores), min(4, cores), ""


def build_command(src, d, o, tracks):
    height = int(o["height"]) if o["height"].isdigit() else 1080
    audio = int(o["audio"]) if o["audio"].isdigit() else 0
    crf = o["crf"] if o["crf"].isdigit() else "18"
    pl = plan(o, height)
    dec, enc_threads, x264 = memory_profile(pl["mem"])
    cmd = [A.ffmpeg, "-hide_banner", "-nostats", "-loglevel", "warning",
           "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
    if pl["readrate"]:
        cmd += ["-readrate", "%g" % pl["readrate"]]   # read the source at N x real time: smooth, lower sustained CPU load
    if pl["hwdecode"]:
        cmd += ["-hwaccel", "videotoolbox"]           # decode on the Mac's media engine (falls back to software by itself)
    if dec and pl["enc"] == "libx264":
        cmd += ["-threads", str(dec)]                 # decoder threads (input option)
    cmd += ["-i", src,
            # output 1: video + audio as HLS. -muxdelay/-muxpreload 0 stop the MPEG-TS muxer adding its default
            # ~1.4 s offset, so HLS timestamps stay on the same timeline as the source (= mpv/IINA's time-pos).
            "-map", "0:v:0", "-map", "0:a:%d?" % audio, "-sn",
            "-vf", "scale=-2:'min(ih,%d)',format=yuv420p" % height]
    cmd += encoder_args(pl["enc"], crf, pl["kbps"])
    if enc_threads and pl["enc"] == "libx264":
        cmd += ["-threads", str(enc_threads)]
    if x264 and pl["enc"] == "libx264":
        cmd += ["-x264-params", x264]
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
    probe_error, info = "", {"streams": [], "chapters": [], "duration": 0.0}
    try:
        info = probe_info(src)
    except Exception as e:
        probe_error = str(e)[:200]
    tracks, skipped = build_tracks(info["streams"])
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
                       probe_error=probe_error, src=src, last=time.time())
    try:
        with open(os.path.join(d, "tracks.json"), "w") as f:
            json.dump({"tracks": tracks, "skipped": skipped, "default": default}, f)
    except OSError:
        pass
    ready.set()
    # opening/ending times can take a few seconds (network), so they are resolved after the player page is released
    result = build_skip(info, src)
    with lock:
        if current["id"] == sid:
            current["skip"] = result


def start_transcode(src, o):
    with lock:
        stop_current()
        sid = secrets.token_hex(8)
        d = os.path.join(A.root, sid)
        os.makedirs(d)
        ready = threading.Event()
        current.update(dir=d, id=sid, ready=ready, state="probing", src=src, last=time.time())
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


def encoder_args(enc, crf, kbps=None):
    if enc == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", crf, "-profile:v", "high", "-level", "4.1"]
    if enc == "h264_qsv":
        return ["-c:v", "h264_qsv", "-global_quality", crf, "-profile:v", "high", "-level", "4.1"]
    if enc == "h264_videotoolbox":
        k = kbps or 8000
        return ["-c:v", "h264_videotoolbox", "-b:v", "%dk" % k, "-maxrate", "%dk" % int(k * 1.5), "-bufsize", "%dk" % (k * 2),
                "-profile:v", "high"]
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
bridge = {"path": None, "gone_since": None, "muted": False, "vid_off": False}
bridge_lock = threading.Lock()


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


def unmute_iina():
    if bridge["muted"]:
        ipc(["set_property", "mute", False])
        bridge["muted"] = False
    if bridge["vid_off"]:
        ipc(["set_property", "vid", "auto"])
        bridge["vid_off"] = False


def bridge_start():
    """Start (or reuse) the transcode for whatever IINA is playing. Only called when a web viewer asks for it."""
    with bridge_lock:
        src = local_stream_url(bridge["path"]) if bridge["path"] else None
        if not src:
            return None
        if current["id"] and current["src"] == src:
            return current["id"]
        sid = start_transcode(src, {"sub": A.sub, "audio": A.audio, "height": A.height, "crf": A.crf,
                                    "enc": A.encoder, "mem": A.memory, "heat": A.heat})
        if not A.keep_iina_audio:
            ipc(["set_property", "mute", True])      # you watch in the browser, not on the Mac
            bridge["muted"] = True
        if not A.keep_iina_video:
            # IINA would otherwise keep decoding and drawing 1080p video nobody looks at (heat). Time and
            # pause state keep working, so Seanime's progress tracking is unaffected.
            ipc(["set_property", "vid", "no"])
            bridge["vid_off"] = True
        return sid


def bridge_loop():
    """Watch IINA. It only REMEMBERS what is playing; the transcode (CPU + RAM) starts when a web viewer asks for it,
    follows IINA to the next episode while someone is watching, and stops when IINA goes away."""
    while True:
        try:
            path = ipc_get("path")
            if isinstance(path, str) and local_stream_url(path):
                bridge["gone_since"] = None
                if path != bridge["path"]:
                    had_viewer = bool(current["id"]) and time.time() - current["last"] < 90
                    bridge["path"] = path
                    if had_viewer:
                        bridge_start()
                    else:
                        with lock:
                            stop_current()
                        unmute_iina()
            else:
                if bridge["gone_since"] is None:
                    bridge["gone_since"] = time.time()
                elif bridge["path"] and time.time() - bridge["gone_since"] > 30:
                    with lock:
                        stop_current()
                    bridge.update(path=None)
                    bridge["muted"] = False          # the player is gone, nothing left to unmute
                    bridge["vid_off"] = False
        except Exception as e:
            sys.stderr.write("bridge: %s\\n" % e)
        time.sleep(2)


def idle_loop():
    """Free the RAM: stop ffmpeg and delete its files when nobody has been watching for a while."""
    while True:
        time.sleep(15)
        try:
            if A.idle_stop > 0 and current["id"] and time.time() - current["last"] > A.idle_stop:
                with lock:
                    stop_current()
                if A.iina_socket:
                    unmute_iina()
        except Exception as e:
            sys.stderr.write("idle: %s\\n" % e)


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
        m0 = re.match(r"/([0-9a-f]{16})/", path)
        if m0 and m0.group(1) == current["id"]:
            current["last"] = time.time()                  # a viewer is (still) there
        if path == "/play":
            return self.play()
        if path == "/status":
            # deliberately minimal: no session id and no log (the log can contain the stream token)
            p = current["proc"]
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            mine = q.get("sid", [""])[0]
            if mine and mine == current["id"]:
                current["last"] = time.time()
            if mine and mine != current["id"]:
                return self.reply(200, json.dumps({"version": VERSION, "stale": True}), "application/json")
            return self.reply(200, json.dumps({"version": VERSION, "state": current["state"],
                                               "exited": bool(p and p.poll() is not None),
                                               "code": p.poll() if p else None}), "application/json")
        if path == "/watch" and A.iina_socket:
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            if not hmac.compare_digest(q.get("key", [""])[0], A.key):
                return self.reply(403, "bad key")
            sid = bridge_start() if bridge["path"] else None
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
            current["last"] = time.time()
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
        m = re.fullmatch(r"/([0-9a-f]{16})/(player\\.html|cues|skip)", path)
        if m:
            if m.group(2) == "skip":
                if current["id"] != m.group(1):
                    return self.reply(404, "no such session")
                return self.reply(200, json.dumps(current["skip"]), "application/json")
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
            idx, start = int(q.get("s", [""])[0]), max(0, int(q.get("off", ["0"])[0]))
        except ValueError:
            return self.reply(400, "bad args")
        track = next((t for t in current["tracks"] if t["index"] == idx), None) if current["id"] == sid else None
        if not track:
            return self.reply(404, "no such track")
        p = current["proc"]
        live = bool(p and p.poll() is None)
        path = os.path.join(current["dir"], track["file"])
        cues, new_off = read_cues_from(path, start, not live)
        try:
            eof = new_off >= os.path.getsize(path)
        except OSError:
            eof = True
        return self.reply(200, json.dumps({"cues": cues, "off": new_off, "live": live, "done": (not live) and eof}),
                          "application/json")

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
threading.Thread(target=idle_loop, daemon=True).start()

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
                sub: subRef.current, audio: audioRef.current, iina: iinaRef.current, mem: memRef.current, idle: idleRef.current, heat: heatRef.current, bitrate: bitrateRef.current, skiplookup: skipRef.current,
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
                    ...(skipRef.current === "off" ? ["--no-skip-lookup"] : []),
                    "--heat", heatRef.current || "cool",
                    "--bitrate", String(parseFloat(bitrateRef.current) || 8),
                    "--memory", memRef.current || "balanced",
                    "--idle-stop", String(Math.max(0, Math.round((parseFloat(idleRef.current) || 0) * 60))),
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
                    tray.select({ label: "Opening/ending times from the internet (AniList + AniSkip)", fieldRef: skipRef, options: [
                        { label: "On (chapters in the file are always used)", value: "on" },
                        { label: "Off (file chapters only)", value: "off" } ] }),
                    tray.select({ label: "Heat / power", fieldRef: heatRef, options: [
                        { label: "Cool - hardware encoder, paced (fanless Macs)", value: "cool" },
                        { label: "Balanced - your encoder, lightly paced", value: "balanced" },
                        { label: "Full speed - fastest, hottest", value: "full" } ] }),
                    tray.input({ label: "Hardware encoder bitrate, Mbps at 1080p (cool mode)", fieldRef: bitrateRef }),
                    tray.select({ label: "Memory use (ffmpeg)", fieldRef: memRef, options: [
                        { label: "Low (about half the RAM, slightly slower)", value: "low" },
                        { label: "Balanced", value: "balanced" },
                        { label: "Full speed (most RAM)", value: "full" } ] }),
                    tray.input({ label: "Stop transcoding after N idle minutes (0 = never)", fieldRef: idleRef }),
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
