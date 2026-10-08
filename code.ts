/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Universal Transcode
// Takes any HTTP stream Seanime exposes (torrent stream, debrid, local file, online stream),
// pipes it through ffmpeg into H.264/AAC HLS, and serves the result on its own port
// so any device on your network (browser, VLC, Tizen AVPlay, ...) can play it.

function init() {
    $ui.register((ctx) => {
        const tray = ctx.newTray({ tooltipText: "Universal Transcode", iconUrl: "", withContent: true })

        // ---------- state ----------
        const status = ctx.state<string>("Idle")
        const outUrl = ctx.state<string>("")
        const debug = ctx.state<string>("")

        const srcRef = ctx.fieldRef<string>("")
        const baseRef = ctx.fieldRef<string>("http://127.0.0.1:43211")
        const portRef = ctx.fieldRef<string>("43299")
        const hostRef = ctx.fieldRef<string>("") // leave empty to use the auto-detected LAN IP
        const encRef = ctx.fieldRef<string>("libx264")
        const heightRef = ctx.fieldRef<string>("1080")
        const audioRef = ctx.fieldRef<string>("0")
        const burnRef = ctx.fieldRef<boolean>(false)

        let ffmpeg: any = null
        let server: any = null
        let readyTimer: any = null

        const isWin = (($os as any).platform || "") === "windows"
        const root = $filepath.join($os.tempDir(), "seanime-transcode")

        // ---------- helpers ----------
        const log = (m: string) => console.log("[universal-transcode] " + m)

        // Playback info may be a Go-bound object where Object.keys() finds nothing,
        // so serialise it and regex out anything that looks like a stream URL.
        function findUrl(o: any): string {
            let json = ""
            try { json = JSON.stringify(o) || "" } catch (e) { return "" }
            const re = /"((?:https?:\/\/|\/api\/)[^"]+)"/g
            let m: RegExpExecArray | null
            while ((m = re.exec(json))) {
                const u = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/")
                if (/stream|\.m3u8|\.mkv|\.mp4/i.test(u)) return u
            }
            return ""
        }

        function absolute(u: string): string {
            if (/^https?:\/\//.test(u)) return u
            return baseRef.current.replace(/\/$/, "") + (u.startsWith("/") ? u : "/" + u)
        }

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

        function kill(p: any) {
            if (!p) return
            try { p.getCommand().process.kill() } catch (e) { log("kill failed: " + e) }
        }

        function ensureServer() {
            if (server) return
            $os.mkdirAll(root, 0o755)
            const script = $filepath.join(root, "server.py")
            $os.writeFile(script, $toBytes(SERVER_PY), 0o644)
            server = $osExtra.asyncCmd(isWin ? "python" : "python3", script, root, portRef.current)
            server.run((data: any, err: any, code: any) => {
                if (err) log("server: " + $toString(err))
                if (code !== undefined) { log("server exited " + code); server = null }
            })
        }

        function encoderArgs(enc: string): string[] {
            switch (enc) {
                case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23"]
                case "h264_qsv": return ["-c:v", "h264_qsv", "-global_quality", "23"]
                case "h264_videotoolbox": return ["-c:v", "h264_videotoolbox", "-b:v", "6M"]
                default: return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]
            }
        }

        function start() {
            const src = absolute(srcRef.current.trim())
            if (!srcRef.current.trim()) { ctx.toast.warning("Set a source URL first"); return }
            stop()

            try { ensureServer() } catch (e) {
                ctx.toast.error("Could not start file server (is Python 3 installed?): " + e)
                return
            }

            const id = Date.now().toString(36)
            const dir = $filepath.join(root, id)
            $os.mkdirAll(dir, 0o755)

            // Filters: cap height, optionally burn the first subtitle track in.
            // Burn-in is the only way soft subs (ASS/PGS) reach devices that can't render them.
            const maxH = parseInt(heightRef.current) || 1080
            const filters = [`scale=-2:'min(ih,${maxH})'`, "format=yuv420p"]
            if (burnRef.current) filters.unshift(`subtitles=filename='${src}':si=0`)

            const args = [
                "-hide_banner", "-loglevel", "warning",
                "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
                "-i", src,
                "-map", "0:v:0", "-map", `0:a:${parseInt(audioRef.current) || 0}?`,
                "-sn",
                "-vf", filters.join(","),
                ...encoderArgs(encRef.current),
                "-profile:v", "high", "-level", "4.1",
                "-c:a", "aac", "-b:a", "192k", "-ac", "2",
                "-f", "hls", "-hls_time", "4", "-hls_list_size", "0",
                "-hls_playlist_type", "event",
                "-hls_flags", "independent_segments",
                "-hls_segment_filename", $filepath.join(dir, "seg_%05d.ts"),
                $filepath.join(dir, "index.m3u8"),
            ]

            ffmpeg = $osExtra.asyncCmd("ffmpeg", ...args)
            ffmpeg.run((data: any, err: any, code: any) => {
                if (err) log("ffmpeg: " + $toString(err))
                if (code !== undefined) {
                    status.set(code === 0 ? "Finished" : `ffmpeg exited (${code})`)
                    ffmpeg = null
                }
            })

            let host = hostRef.current.trim()
            if (!host) {
                try { host = $toString($os.readFile($filepath.join(root, "ip.txt"))).trim() } catch (e) { }
            }
            if (!host) host = "localhost"
            outUrl.set(`http://${host}:${portRef.current}/${id}/index.m3u8`)
            status.set("Transcoding… (playable after a few seconds)")

            // Flip to "Ready" once the first segment exists.
            if (readyTimer) readyTimer()
            readyTimer = ctx.setInterval(() => {
                try {
                    $os.stat($filepath.join(dir, "seg_00001.ts"))
                    status.set("Ready – open the URL below")
                    if (readyTimer) readyTimer()
                } catch (e) { }
            }, 1000)
        }

        function stop() {
            if (readyTimer) { readyTimer(); readyTimer = null }
            kill(ffmpeg); ffmpeg = null
            status.set("Idle")
        }

        function grab() {
            try {
                const info = (ctx.videoCore as any).getCurrentPlaybackInfo()
                const u = findUrl(info)
                if (u) {
                    srcRef.setValue(absolute(u)); debug.set("")
                    ctx.toast.success("Grabbed current stream")
                } else {
                    // Show what we got so the right field can be identified
                    let raw = ""
                    try { raw = JSON.stringify(info) } catch (e) { raw = String(info) }
                    debug.set((raw || "(empty)").slice(0, 1200))
                    ctx.toast.warning("No stream URL found – see the debug text in the panel")
                }
            } catch (e) {
                debug.set("getCurrentPlaybackInfo threw: " + e)
                ctx.toast.error("Nothing is playing in the built-in player")
            }
        }

        // ---------- UI ----------
        const onGrab = ctx.eventHandler("ut-grab", grab)
        const onStart = ctx.eventHandler("ut-start", start)
        const onStop = ctx.eventHandler("ut-stop", stop)

        tray.render(() =>
            tray.stack({
                items: [
                    tray.text("Universal Transcode", { style: { fontWeight: "bold" } }),
                    tray.input({ label: "Source URL (torrent / debrid / file stream)", fieldRef: srcRef }),
                    tray.button({ label: "Grab from current playback", onClick: onGrab, intent: "gray-subtle", size: "sm" }),
                    tray.input({ label: "Seanime server URL", fieldRef: baseRef }),
                    tray.select({
                        label: "Encoder", fieldRef: encRef,
                        options: [
                            { label: "CPU (libx264)", value: "libx264" },
                            { label: "NVIDIA (nvenc)", value: "h264_nvenc" },
                            { label: "Intel (qsv)", value: "h264_qsv" },
                            { label: "Apple (videotoolbox)", value: "h264_videotoolbox" },
                        ],
                    }),
                    tray.select({
                        label: "Max height", fieldRef: heightRef,
                        options: [{ label: "1080p", value: "1080" }, { label: "720p", value: "720" }, { label: "480p", value: "480" }],
                    }),
                    tray.input({ label: "Audio track index", fieldRef: audioRef }),
                    tray.checkbox({ label: "Burn in subtitles (first track)", fieldRef: burnRef }),
                    tray.input({ label: "Output port", fieldRef: portRef }),
                    tray.input({ label: "Output host/IP (blank = auto)", fieldRef: hostRef }),
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
