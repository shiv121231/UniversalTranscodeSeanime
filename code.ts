/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Universal Transcode v0.2
// 1. Seanime launches your external player (IINA/mpv/VLC) with a torrent stream URL.
//    "Grab from running player" reads that URL from the process list (macOS/Linux).
// 2. ffmpeg converts it to H.264/AAC HLS.
// 3. A tiny file server hosts the HLS plus a player page (hls.js) you can open on any device.

function init() {
    $ui.register((ctx) => {
        const tray = ctx.newTray({ tooltipText: "Universal Transcode", iconUrl: "", withContent: true })

        // ---------- state ----------
        const status = ctx.state<string>("Idle")
        const outUrl = ctx.state<string>("")
        const debug = ctx.state<string>("")

        const srcRef = ctx.fieldRef<string>("")
        const ffmpegRef = ctx.fieldRef<string>("/opt/homebrew/bin/ffmpeg")
        const pythonRef = ctx.fieldRef<string>("/usr/bin/python3")
        const portRef = ctx.fieldRef<string>("43299")
        const publicRef = ctx.fieldRef<string>("") // e.g. https://hls.example.com  (blank = http://<LAN IP>:<port>)
        const encRef = ctx.fieldRef<string>("libx264")
        const heightRef = ctx.fieldRef<string>("1080")
        const audioRef = ctx.fieldRef<string>("0")
        const subRef = ctx.fieldRef<string>("0") // subtitle track number (0 = first); blank = no subtitles
        const crfRef = ctx.fieldRef<string>("18") // x264 quality: lower = better/larger

        let ffmpeg: any = null
        let server: any = null
        let readyTimer: any = null

        const root = $filepath.join($os.tempDir(), "seanime-transcode")
        const log = (m: string) => console.log("[universal-transcode] " + m)

        // ---------- static files ----------
        const SERVER_PY = `
import http.server, os, socket, sys
root, port = sys.argv[1], int(sys.argv[2])
os.chdir(root)
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("10.255.255.255", 1))
    open(os.path.join(root, "ip.txt"), "w").write(s.getsockname()[0]); s.close()
except Exception:
    pass
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
        ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".vtt": "text/vtt"}
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
`

        // Player page served next to the playlist. Waits until ffmpeg has produced the playlist.
        const PLAYER_HTML = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Universal Transcode</title>
<body style="margin:0;background:#000">
<video id="v" controls autoplay playsinline style="width:100vw;height:100vh"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5/dist/hls.min.js"></script>
<script>
var v = document.getElementById('v'), src = 'index.m3u8';
function begin() {
  if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = src; return; }
  if (window.Hls && Hls.isSupported()) { var h = new Hls(); h.loadSource(src); h.attachMedia(v); }
  else document.body.innerText = 'This browser cannot play HLS.';
}
function wait() {
  fetch(src).then(function (r) { if (!r.ok) throw 0; begin(); })
            .catch(function () { setTimeout(wait, 1500); });
}
wait();
</script>
`

        // ---------- helpers ----------
        function kill(p: any) {
            if (!p) return
            try { p.getCommand().process.kill() } catch (e) { log("kill failed: " + e) }
        }

        function ensureServer() {
            if (server) return
            $os.mkdirAll(root, 0o755)
            const script = $filepath.join(root, "server.py")
            $os.writeFile(script, $toBytes(SERVER_PY), 0o644)
            server = $osExtra.asyncCmd(pythonRef.current.trim() || "python3", script, root, portRef.current)
            server.run((data: any, err: any, code: any) => {
                if (err) log("server: " + $toString(err))
                if (code !== undefined) { log("server exited " + code); server = null }
            })
        }

        function encoderArgs(enc: string): string[] {
            const crf = String(parseInt(crfRef.current) || 18)
            switch (enc) {
                case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", crf, "-profile:v", "high", "-level", "4.1"]
                case "h264_qsv": return ["-c:v", "h264_qsv", "-global_quality", crf, "-profile:v", "high", "-level", "4.1"]
                case "h264_videotoolbox": return ["-c:v", "h264_videotoolbox", "-b:v", "15M"]
                default: return ["-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-tune", "animation", "-profile:v", "high", "-level", "4.1"]
            }
        }

        function randomId(): string {
            let s = ""
            for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16)
            return s
        }

        // ---------- grab the stream URL from the running external player ----------
        // Seanime starts the player as: <player> ... http://127.0.0.1:43211/api/v1/torrentstream/stream/<file>?token=...
        // `ps` lists every process; we keep the matching one that started most recently.
        function grabFromPlayer() {
            const chunks: string[] = []
            let cmd: any
            try {
                cmd = $osExtra.asyncCmd("ps", "-axww", "-o", "etime=,command=")
            } catch (e) {
                ctx.toast.error("Could not run ps (macOS/Linux only): " + e)
                return
            }
            cmd.run((data: any, err: any, code: any) => {
                if (data) chunks.push($toString(data))
                if (code === undefined) return

                const urlRe = /(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|\d+\.\d+\.\d+\.\d+)(?::\d+)?\/api\/v1\/\S*stream\S*)/
                const etimeRe = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.*)$/
                let best = "", bestAge = Infinity
                for (const line of chunks.join("\n").split("\n")) {
                    const m = etimeRe.exec(line)
                    if (!m) continue
                    const u = urlRe.exec(m[5])
                    if (!u) continue
                    // elapsed seconds since the process started: smaller = newer
                    const age = (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4])
                    if (age < bestAge) { bestAge = age; best = u[1] }
                }

                if (best) {
                    srcRef.setValue(best)
                    debug.set("")
                    ctx.toast.success("Grabbed stream from the running player")
                } else {
                    debug.set("No player process with a Seanime stream URL found. Start the episode in your external player first, then press Grab again.")
                    ctx.toast.warning("No running player stream found")
                }
            })
        }

        // ---------- start / stop ----------
        function start() {
            const src = srcRef.current.trim()
            if (!src) { ctx.toast.warning("Press Grab (or paste a source URL) first"); return }
            stop()

            try { ensureServer() } catch (e) {
                ctx.toast.error("Could not start file server (check the Python path): " + e)
                return
            }

            const id = randomId()
            const dir = $filepath.join(root, id)
            $os.mkdirAll(dir, 0o755)
            $os.writeFile($filepath.join(dir, "player.html"), $toBytes(PLAYER_HTML), 0o644)

            const maxH = parseInt(heightRef.current) || 1080
            const filters = [`scale=-2:'min(ih,${maxH})'`, "format=yuv420p"]

            // Subtitles are passed through as soft WebVTT tracks inside the HLS output.
            // (Burning them in would make ffmpeg read the WHOLE file first, which stalls on a partially downloaded torrent.)
            const subTxt = subRef.current.trim()
            const wantSubs = subTxt !== "" && !isNaN(parseInt(subTxt))
            const subIdx = wantSubs ? parseInt(subTxt) : 0

            const args = [
                "-hide_banner", "-loglevel", "warning",
                "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
                "-i", src,
                "-map", "0:v:0", "-map", `0:a:${parseInt(audioRef.current) || 0}?`,
                ...(wantSubs ? ["-map", `0:s:${subIdx}?`] : ["-sn"]),
                "-vf", filters.join(","),
                ...encoderArgs(encRef.current),
                "-c:a", "aac", "-b:a", "192k", "-ac", "2",
                ...(wantSubs ? ["-c:s", "webvtt"] : []),
                "-f", "hls", "-hls_time", "4", "-hls_list_size", "0",
                "-hls_playlist_type", "event",
                "-hls_flags", "independent_segments",
                "-master_pl_name", "index.m3u8",
                "-var_stream_map", wantSubs ? "v:0,a:0,s:0,sgroup:subs,default:yes" : "v:0,a:0",
                "-hls_segment_filename", $filepath.join(dir, "v%v_seg_%05d.ts"),
                $filepath.join(dir, "v%v.m3u8"),
            ]

            try {
                ffmpeg = $osExtra.asyncCmd(ffmpegRef.current.trim() || "ffmpeg", ...args)
            } catch (e) {
                ctx.toast.error("Could not run ffmpeg (check the ffmpeg path): " + e)
                return
            }
            ffmpeg.run((data: any, err: any, code: any) => {
                if (err) {
                    const t = $toString(err)
                    log("ffmpeg: " + t)
                    debug.set(t.slice(-600))
                }
                if (code !== undefined) {
                    status.set(code === 0 ? "Finished" : `ffmpeg exited (${code}) – see the log text below`)
                    ffmpeg = null
                }
            })

            let base = publicRef.current.trim().replace(/\/$/, "")
            if (!base) {
                let host = ""
                try { host = $toString($os.readFile($filepath.join(root, "ip.txt"))).trim() } catch (e) { }
                base = `http://${host || "localhost"}:${portRef.current}`
            }
            outUrl.set(`${base}/${id}/player.html`)
            status.set("Transcoding… (playable after a few seconds)")

            if (readyTimer) readyTimer()
            readyTimer = ctx.setInterval(() => {
                try {
                    $os.stat($filepath.join(dir, "v0_seg_00001.ts"))
                    status.set("Ready – open the link below on any device")
                    if (readyTimer) readyTimer()
                } catch (e) { }
            }, 1000)
        }

        function stop() {
            if (readyTimer) { readyTimer(); readyTimer = null }
            kill(ffmpeg); ffmpeg = null
            status.set("Idle")
        }

        // ---------- UI ----------
        const onGrab = ctx.eventHandler("ut-grab", grabFromPlayer)
        const onStart = ctx.eventHandler("ut-start", start)
        const onStop = ctx.eventHandler("ut-stop", stop)

        tray.render(() =>
            tray.stack({
                items: [
                    tray.text("Universal Transcode", { style: { fontWeight: "bold" } }),
                    tray.text("1) Start the episode in your external player  2) Grab  3) Start"),
                    tray.button({ label: "Grab from running player", onClick: onGrab, intent: "gray-subtle", size: "sm" }),
                    tray.input({ label: "Source URL", fieldRef: srcRef }),
                    tray.select({
                        label: "Encoder", fieldRef: encRef,
                        options: [
                            { label: "CPU (libx264) – best quality", value: "libx264" },
                            { label: "Apple (videotoolbox) – fast, lower quality", value: "h264_videotoolbox" },
                            { label: "NVIDIA (nvenc)", value: "h264_nvenc" },
                            { label: "Intel (qsv)", value: "h264_qsv" },
                        ],
                    }),
                    tray.select({
                        label: "Max height", fieldRef: heightRef,
                        options: [{ label: "1080p", value: "1080" }, { label: "720p", value: "720" }, { label: "480p", value: "480" }],
                    }),
                    tray.input({ label: "Audio track index", fieldRef: audioRef }),
                    tray.input({ label: "Subtitle track number (0 = first, blank = none)", fieldRef: subRef }),
                    tray.input({ label: "Quality CRF (lower = better, 18 default)", fieldRef: crfRef }),
                    tray.input({ label: "ffmpeg path", fieldRef: ffmpegRef }),
                    tray.input({ label: "python3 path", fieldRef: pythonRef }),
                    tray.input({ label: "Output port", fieldRef: portRef }),
                    tray.input({ label: "Public URL (blank = LAN IP), e.g. https://hls.example.com", fieldRef: publicRef }),
                    tray.flex({
                        items: [
                            tray.button({ label: "Start", onClick: onStart, intent: "primary" }),
                            tray.button({ label: "Stop", onClick: onStop, intent: "alert-subtle" }),
                        ],
                    }),
                    tray.text(status.get()),
                    tray.text(outUrl.get() || "", { style: { wordBreak: "break-all", userSelect: "text" } }),
                    ...(debug.get() ? [tray.text(debug.get(), { style: { fontSize: "10px", wordBreak: "break-all", userSelect: "text" } })] : []),
                ],
            }),
        )
    })
}
