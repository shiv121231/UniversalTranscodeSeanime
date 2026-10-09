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
        const subRef = ctx.fieldRef<string>(saved("sub", "0")) // blank = no subtitles
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
ap.add_argument("--iina-socket", default="", help="bridge mode: IINA/mpv IPC socket, e.g. /tmp/iina_socket")
ap.add_argument("--keep-iina-audio", action="store_true", help="bridge mode: do not mute IINA")
A = ap.parse_args()

os.makedirs(A.root, exist_ok=True)
os.chdir(A.root)
VERSION = "0.5.0"
LOCAL = A.seanime.rstrip("/")
# Shutdown token lives next to (not inside) the served folder, so a newer instance can replace this one
# even if the access key changed. Anything on the web can't read it.
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(A.root)), "seanime-transcode-%d.token" % A.port)
SHUTDOWN_TOKEN = secrets.token_hex(16)
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
// Bridge mode: report position/pause state so IINA (and so Seanime's progress tracking) follows this player.
var qk = new URLSearchParams(location.search).get('key'), sid = location.pathname.split('/')[1];
if (qk) setInterval(function () {
  if (!v.currentTime && v.paused) return;
  fetch('/sync?key=' + encodeURIComponent(qk) + '&sid=' + sid + '&t=' + v.currentTime.toFixed(1) + '&p=' + (v.paused ? 1 : 0)).catch(function () {});
}, 5000);
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
            return self.reply(200, json.dumps({"version": VERSION, "exited": bool(p and p.poll() is not None),
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
        return super().do_GET()

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
