// LAN server: serves the built game (dist/) and runs a tiny lockstep relay over WebSocket.
// Run: npm run lan  → open the printed address on both devices.
// No dependencies: the WebSocket protocol (RFC 6455) is implemented below, text frames only.
//
// Netcode: the server is the metronome. Every 50 ms (the sim's 20 Hz) it broadcasts
// { t: 'tick', n, cmds } with all commands players sent since the last tick. Both clients step
// the same deterministic sim with the same commands, so the lanes stay identical.
import { createServer, type IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize } from 'node:path'
import type { Socket } from 'node:net'

const PORT = Number(process.env.PORT ?? 8787)
const DIST = join(import.meta.dirname, '..', 'dist')
const TICK_MS = 50
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
}

// --- static files --------------------------------------------------------------

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = normalize(join(DIST, decodeURIComponent(url.pathname)))
  if (!path.startsWith(DIST)) { res.writeHead(403).end(); return }
  try {
    const file = (await stat(path)).isDirectory() ? join(path, 'index.html') : path
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(await readFile(file))
  } catch {
    res.writeHead(404).end('not found (did you run "npm run build"?)')
  }
})

// --- minimal WebSocket -------------------------------------------------------------

class Ws {
  private buf = Buffer.alloc(0)
  onText: (s: string) => void = () => {}
  onClose: () => void = () => {}
  closed = false
  private sock: Socket
  constructor(sock: Socket) {
    this.sock = sock
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse() })
    sock.on('close', () => this.close())
    sock.on('error', () => this.close())
  }
  private parse() {
    for (;;) {
      if (this.buf.length < 2) return
      const op = this.buf[0] & 0x0f, masked = (this.buf[1] & 0x80) !== 0
      let len = this.buf[1] & 0x7f, off = 2
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10 }
      if (len > 1 << 20) return this.close() // nobody needs a 1 MB command
      const need = off + (masked ? 4 : 0) + len
      if (this.buf.length < need) return
      const mask = masked ? this.buf.subarray(off, off + 4) : null
      const data = Buffer.from(this.buf.subarray(off + (masked ? 4 : 0), need))
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
      this.buf = this.buf.subarray(need)
      if (op === 0x1) this.onText(data.toString('utf8'))
      else if (op === 0x8) return this.close()
      else if (op === 0x9) this.frame(0xa, data) // ping -> pong
    }
  }
  private frame(op: number, data: Buffer) {
    if (this.closed) return
    const head = data.length < 126 ? Buffer.from([0x80 | op, data.length])
      : data.length < 65536 ? Buffer.from([0x80 | op, 126, data.length >> 8, data.length & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(data.length), 2); return h })()
    this.sock.write(Buffer.concat([head, data]))
  }
  send(o: unknown) { this.frame(0x1, Buffer.from(JSON.stringify(o))) }
  close() {
    if (this.closed) return
    this.closed = true
    try { this.sock.end(Buffer.from([0x88, 0])) } catch { /* already gone */ }
    this.onClose()
  }
}

http.on('upgrade', (req: IncomingMessage, sock: Socket) => {
  const key = req.headers['sec-websocket-key']
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws' || typeof key !== 'string') { sock.destroy(); return }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  sock.setNoDelay(true)
  join2(new Ws(sock))
})

// --- one room, two seats -------------------------------------------------------------

const seats: (Ws | null)[] = [null, null]
const ready = [false, false]
let tick = 0, timer: NodeJS.Timeout | null = null, inbox: unknown[] = []

function join2(ws: Ws) {
  const seat = seats.indexOf(null)
  if (seat < 0) { ws.send({ t: 'full' }); ws.close(); return }
  seats[seat] = ws
  ready[seat] = true
  ws.send({ t: 'seat', seat })
  log(`player ${seat + 1} joined`)
  ws.onText = s => {
    let m: { t?: string; cmds?: unknown[] }
    try { m = JSON.parse(s) } catch { return }
    // commands are stamped with the sender's seat here, so nobody can play the other lane
    if (m.t === 'cmds' && Array.isArray(m.cmds) && timer) for (const c of m.cmds.slice(0, 50)) if (c && typeof c === 'object') inbox.push({ ...c, p: seat })
    if (m.t === 'rematch') { ready[seat] = true; maybeStart() }
  }
  ws.onClose = () => {
    seats[seat] = null
    ready[seat] = false
    log(`player ${seat + 1} left`)
    stop()
    for (const o of seats) o?.send({ t: 'left' })
  }
  maybeStart()
}

function maybeStart() {
  if (timer || !seats[0] || !seats[1] || !ready[0] || !ready[1]) {
    for (const o of seats) o?.send({ t: 'waiting', players: seats.filter(Boolean).length })
    return
  }
  ready[0] = ready[1] = false
  tick = 0; inbox = []
  for (const o of seats) o?.send({ t: 'start' })
  log('match started')
  timer = setInterval(() => {
    const cmds = inbox; inbox = []
    for (const o of seats) o?.send({ t: 'tick', n: tick, cmds })
    tick++
  }, TICK_MS)
}
function stop() { if (timer) clearInterval(timer); timer = null }

const log = (s: string) => console.log(`[${new Date().toLocaleTimeString()}] ${s}`)

http.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i!.address)
  console.log(`CogRush LAN server on port ${PORT}. Open on both devices:`)
  for (const ip of ips.length ? ips : ['localhost']) console.log(`  http://${ip}:${PORT}`)
})
