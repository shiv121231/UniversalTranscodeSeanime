/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Universal Transcode v0.4
// Runs a small local server (Python + ffmpeg). In Seanime set  Settings -> External player link  to the
// link shown in this tray. Playing a torrent stream then opens the transcoded web player instead of IINA.

function init() {
    $ui.register((ctx) => {
        const tray = ctx.newTray({ tooltipText: "Universal Transcode", iconUrl: "", withContent: true })

        const status = ctx.state<string>("Server stopped")
        const link = ctx.state<string>("")
        const note = ctx.state<string>("")

        // Persisted settings (the key is generated once and kept)
        const saved = (k: string, d: string) => { try { return $storage.get<string>("ut." + k) ?? d } catch (e) { return d } }
        let key = saved("key", "")
        if (!key) {
            for (let i = 0; i < 24; i++) key += Math.floor(Math.random() * 16).toString(16)
            try { $storage.set("ut.key", key) } catch (e) { }
        }

        const pythonRef = ctx.fieldRef<string>(saved("python", "/usr/bin/python3"))
        const ffmpegRef = ctx.fieldRef<string>(saved("ffmpeg", "/opt/homebrew/bin/ffmpeg"))
        const portRef = ctx.fieldRef<string>(saved("port", "43299"))
        const publicRef = ctx.fieldRef<string>(saved("public", "")) // e.g. https://hls.example.com
        const seanimeRef = ctx.fieldRef<string>(saved("seanime", "http://127.0.0.1:43211"))
        const encRef = ctx.fieldRef<string>(saved("enc", "libx264"))
        const heightRef = ctx.fieldRef<string>(saved("height", "1080"))
        const crfRef = ctx.fieldRef<string>(saved("crf", "18"))
        const subRef = ctx.fieldRef<string>(saved("sub", "0")) // blank = no subtitles
        const audioRef = ctx.fieldRef<string>(saved("audio", "0"))

        let server: any = null
        const root = $filepath.join($os.tempDir(), "seanime-transcode")
        const log = (m: string) => console.log("[universal-transcode] " + m)

        const SERVER_PY = `#!/usr/bin/env python3
"""Universal Transcode server.

Seanime's "External player link" setting opens a URL of your choice with the stream URL filled in.
Point it at  http(s)://<this server>/play?key=<KEY>&src={url}  and this server will:
  1. take the stream URL (the path + token), swap the host for the local Seanime server,
  2. run ffmpeg to produce H.264/AAC HLS with soft WebVTT subtitles,
  3. redirect the browser to a small hls.js player page.
It also serves the HLS files. One transcode runs at a time; starting a new one stops the old one.
"""
import argparse, atexit, base64, hmac, http.server, json, os, re, secrets, shutil, socket, subprocess, sys, threading, time, urllib.parse, urllib.request

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
ap.add_argument("--sub", default="0")  # "" = no subtitles
A = ap.parse_args()

os.makedirs(A.root, exist_ok=True)
os.chdir(A.root)
LOCAL = A.seanime.rstrip("/")
lock = threading.Lock()
current = {"proc": None, "dir": None, "id": None}

PLAYER = """<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Universal Transcode</title>
<body style="margin:0;background:#000;color:#ccc;font-family:sans-serif">
<video id="v" controls autoplay playsinline style="width:100vw;height:100vh"></video>
<div id="m" style="position:fixed;top:12px;left:12px;font-size:14px">Starting transcode...</div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5/dist/hls.min.js"></script>
<script>
var v = document.getElementById('v'), m = document.getElementById('m'), src = 'index.m3u8';
function begin() {
  m.style.display = 'none';
  if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = src; return; }
  if (window.Hls && Hls.isSupported()) { var h = new Hls(); h.loadSource(src); h.attachMedia(v); }
  else m.style.display = 'block', m.textContent = 'This browser cannot play HLS.';
}
function wait() {
  fetch(src).then(function (r) { if (!r.ok) throw 0; begin(); })
    .catch(function () {
      fetch('/status').then(function (r) { return r.json(); }).then(function (s) {
        if (s.exited && s.code !== 0) { m.textContent = 'ffmpeg failed (exit code ' + s.code + '). Check ffmpeg.log in the transcode temp folder.'; return; }
        setTimeout(wait, 1500);
      }).catch(function () { setTimeout(wait, 1500); });
    });
}
wait();
</script>
"""


def encoder_args(enc, crf):
    if enc == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", crf, "-profile:v", "high", "-level", "4.1"]
    if enc == "h264_qsv":
        return ["-c:v", "h264_qsv", "-global_quality", crf, "-profile:v", "high", "-level", "4.1"]
    if enc == "h264_videotoolbox":
        return ["-c:v", "h264_videotoolbox", "-b:v", "15M"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-tune", "animation",
            "-profile:v", "high", "-level", "4.1"]


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
    current.update(proc=None, dir=None, id=None)


def start_transcode(src, o):
    with lock:
        stop_current()
        sid = secrets.token_hex(8)
        d = os.path.join(A.root, sid)
        os.makedirs(d)
        with open(os.path.join(d, "player.html"), "w") as f:
            f.write(PLAYER)
        sub = o["sub"].strip()
        want_subs = sub.lstrip("-").isdigit() and int(sub) >= 0
        height = int(o["height"]) if o["height"].isdigit() else 1080
        audio = int(o["audio"]) if o["audio"].isdigit() else 0
        crf = o["crf"] if o["crf"].isdigit() else "18"
        cmd = [A.ffmpeg, "-hide_banner", "-loglevel", "warning",
               "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
               "-i", src, "-map", "0:v:0", "-map", "0:a:%d?" % audio]
        cmd += ["-map", "0:s:%d?" % int(sub)] if want_subs else ["-sn"]
        cmd += ["-vf", "scale=-2:'min(ih,%d)',format=yuv420p" % height]
        cmd += encoder_args(o["enc"], crf)
        cmd += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
        if want_subs:
            cmd += ["-c:s", "webvtt"]
        cmd += ["-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "event",
                "-hls_flags", "independent_segments", "-master_pl_name", "index.m3u8",
                "-var_stream_map", "v:0,a:0,s:0,sgroup:subs,default:yes" if want_subs else "v:0,a:0",
                "-hls_segment_filename", os.path.join(d, "v%v_seg_%05d.ts"), os.path.join(d, "v%v.m3u8")]
        log = open(os.path.join(d, "ffmpeg.log"), "wb")
        current.update(proc=subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=log), dir=d, id=sid)
        return sid


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
            return self.reply(200, json.dumps({"exited": bool(p and p.poll() is not None),
                                               "code": p.poll() if p else None}), "application/json")
        if path == "/shutdown":
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            if not A.key or not hmac.compare_digest(q.get("key", [""])[0], A.key):
                return self.reply(403, "bad key")
            self.reply(200, "bye")
            threading.Thread(target=lambda: (time.sleep(0.3), stop_current(), os._exit(0)), daemon=True).start()
            return
        if path == "/":
            return self.reply(200, "Universal Transcode is running. Use /play?key=KEY&src=STREAM_URL")
        return super().do_GET()

    def play(self):
        q = self.path.split("?", 1)[1] if "?" in self.path else ""
        i = q.find("src=")
        if i < 0:
            return self.reply(400, "missing src")
        # src must come last: it may contain its own ?token=... which would otherwise be split off
        params = {k: v[0] for k, v in urllib.parse.parse_qs(q[:i]).items()}
        if A.key and not hmac.compare_digest(params.get("key", ""), A.key):
            return self.reply(403, "bad key")
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
    urllib.request.urlopen("http://127.0.0.1:%d/shutdown?key=%s" % (A.port, urllib.parse.quote(A.key)), timeout=2).read()
    time.sleep(1)
except Exception:
    pass

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
                sub: subRef.current, audio: audioRef.current,
            }
            for (const k of Object.keys(f)) { try { $storage.set("ut." + k, f[k]) } catch (e) { } }
        }

        function stop() {
            if (server) { try { server.getCommand().process.kill() } catch (e) { log("kill failed: " + e) } server = null }
        }

        function start() {
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
                    "--key", key, "--encoder", encRef.current, "--crf", crfRef.current.trim() || "18",
                    "--height", heightRef.current, "--audio", audioRef.current.trim() || "0", "--sub", subRef.current.trim() || "none",
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
            let base = publicRef.current.trim().replace(/\/$/, "")
            if (!base) {
                let host = ""
                ctx.setTimeout(() => {
                    try { host = $toString($os.readFile($filepath.join(root, "ip.txt"))).trim() } catch (e) { }
                    const b = `http://${host || "localhost"}:${portRef.current.trim()}`
                    link.set(`${b}/play?key=${key}&src={url}`)
                }, 1500)
                link.set(`http://localhost:${portRef.current.trim()}/play?key=${key}&src={url}`)
            } else {
                link.set(`${base}/play?key=${key}&src={url}`)
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
                    tray.flex({ items: [
                        tray.button({ label: "Start / apply settings", onClick: onStart, intent: "primary" }),
                        tray.button({ label: "Stop", onClick: onStop, intent: "alert-subtle" }),
                    ] }),
                    tray.text(status.get()),
                    tray.input({ label: "Subtitle track (0 = first, blank = none)", fieldRef: subRef }),
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
                    ...(note.get() ? [tray.text(note.get(), { style: { fontSize: "10px", wordBreak: "break-all", userSelect: "text" } })] : []),
                ],
            }),
        )

        // Start automatically when Seanime starts
        start()
    })
}
