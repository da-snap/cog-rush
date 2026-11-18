// LAN + online server: serves the built game (dist/) and runs a tiny lockstep relay over WebSocket.
// LAN: npm run lan  → open the printed address on both devices.
// Online relay: PORT=8787 ORIGINS=https://<user>.github.io node server/lan.ts, behind a TLS reverse proxy (see server/HOSTING.md).
// No dependencies: the WebSocket protocol (RFC 6455) is implemented below, text frames only.
//
// Netcode: the server is the metronome. Every 50 ms (the sim's 20 Hz) it broadcasts
// { t: 'tick', n, cmds } with all commands players sent since the last tick. Both clients step
// the same deterministic sim with the same commands, so the lanes stay identical.
import { createServer, type IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
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
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }).end(`ok ${rooms.size} rooms`); return }
  const path = normalize(join(DIST, decodeURIComponent(url.pathname)))
  if (path !== DIST && !path.startsWith(DIST + sep)) { res.writeHead(403).end(); return } // not ../dist-other either
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
  private since = 0
  private chunks = 0
  private sock: Socket
  constructor(sock: Socket) {
    this.sock = sock
    sock.on('data', d => {
      // flood guard: more than 60 chunks a second (the game sends ~20) closes the connection
      const now = Date.now()
      if (now - this.since > 1000) { this.since = now; this.chunks = 0 }
      if (++this.chunks > 60 || this.buf.length > 32_768) return this.close()
      this.buf = Buffer.concat([this.buf, d]); this.parse()
    })
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
      if (len > 16_384) return this.close() // real messages are < 2 KB
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
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname !== '/ws' || typeof key !== 'string') { sock.destroy(); return }
  if (ORIGINS.length && !ORIGINS.includes(req.headers.origin ?? '')) { sock.destroy(); return }
  // behind a reverse proxy every socket comes from the proxy; TRUST_PROXY=1 reads the real client IP
  const ip = (process.env.TRUST_PROXY && String(req.headers['x-real-ip'] ?? '')) || sock.remoteAddress || '?'
  if ((perIp.get(ip) ?? 0) >= MAX_PER_IP) { sock.destroy(); return }
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
  sock.on('close', () => { const n = (perIp.get(ip) ?? 1) - 1; if (n) perIp.set(ip, n); else perIp.delete(ip) })
  sock.setKeepAlive(true, 30_000) // a phone that vanished without closing frees its seat
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  sock.setNoDelay(true)
  joinRoom(new Ws(sock), url.searchParams)
})

// --- rooms ---------------------------------------------------------------------------
// LAN: everyone lands in room "LAN". Online: ?room=new creates a 4-letter code, ?room=ABCD joins it,
// ?room=quick pairs the first two waiting players. ?v= is the client build; only equal builds play together.
// A seat keeps its token, so a dropped player can rejoin with ?token= and catch up from the tick log.

const FORFEIT_MS = 30_000
const MAX_ROOMS = 500 // ponytail: global cap; per-IP limits if someone actually floods it
const ORIGINS = (process.env.ORIGINS ?? '').split(',').filter(Boolean) // empty = allow all (LAN)
const MAX_PER_IP = 6 // open sockets per client IP
const perIp = new Map<string, number>()
// only plain command fields are forwarded to the rival, never whatever else a modified client packs in
const clean = (c: Record<string, unknown>, p: number) => {
  const o: Record<string, unknown> = { p }
  for (const k of ['t', 'kind', 'branch']) if (typeof c[k] === 'string' && (c[k] as string).length <= 16) o[k] = c[k]
  for (const k of ['x', 'y', 'slot']) if (Number.isInteger(c[k])) o[k] = c[k]
  return typeof o.t === 'string' ? o : null
}

interface Seat { ws: Ws | null; token: string; name: string; ready: boolean; goneAt: number }
interface Room {
  code: string; build: string; quick: boolean
  seats: (Seat | null)[]
  tick: number; timer: NodeJS.Timeout | null; inbox: unknown[]; log: { n: number; cmds: unknown[] }[]
  hashes: Map<number, number>
}
const rooms = new Map<string, Room>()
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O, they read as 1/0
const newCode = () => { let c; do c = Array.from({ length: 4 }, () => LETTERS[Math.random() * LETTERS.length | 0]).join(''); while (rooms.has(c)); return c }
const newRoom = (code: string, build: string, quick = false): Room =>
  ({ code, build, quick, seats: [null, null], tick: 0, timer: null, inbox: [], log: [], hashes: new Map() })
const others = (r: Room, seat: number) => r.seats[1 - seat]?.ws

function joinRoom(ws: Ws, q: URLSearchParams) {
  const build = (q.get('v') ?? '').slice(0, 40), name = (q.get('name') ?? '').replace(/[<>&"]/g, '').trim().slice(0, 16) || 'Player'
  let want = (q.get('room') ?? 'LAN').toUpperCase().slice(0, 8)
  if (want === 'NEW' || want === 'QUICK') {
    const open = want === 'QUICK' && [...rooms.values()].find(r => r.quick && r.build === build && r.seats.includes(null) && !r.timer)
    if (open) want = open.code
    else {
      if (rooms.size >= MAX_ROOMS) { ws.send({ t: 'error', text: 'The server is full. Try again in a minute.' }); return ws.close() }
      const code = newCode()
      rooms.set(code, newRoom(code, build, want === 'QUICK'))
      want = code
    }
  }
  let r = rooms.get(want)
  if (!r && want === 'LAN') rooms.set('LAN', r = newRoom('LAN', build))
  if (!r) { ws.send({ t: 'error', text: `No game with code ${want}.` }); return ws.close() }
  if (r.build !== build) {
    if (r.code !== 'LAN' || r.seats.some(Boolean)) { ws.send({ t: 'old', text: 'Your rival runs a different version of the game.' }); return ws.close() }
    r.build = build // an empty LAN room follows whoever comes first
  }
  // rejoin by token, else the first free seat
  const token = q.get('token')
  let seat = token ? r.seats.findIndex(s => s && s.token === token && !s.ws) : -1
  if (seat < 0) {
    seat = r.seats.indexOf(null)
    if (seat < 0) { ws.send({ t: 'full' }); return ws.close() }
    r.seats[seat] = { ws: null, token: createHash('sha1').update(Math.random() + ':' + Date.now()).digest('hex').slice(0, 16), name, ready: true, goneAt: 0 }
  }
  const me = r.seats[seat]!
  const room = r
  me.ws = ws; me.goneAt = 0
  ws.send({ t: 'seat', seat, code: r.code, token: me.token, name: me.name })
  log(`${r.code}: ${me.name} took seat ${seat + 1}`)
  if (r.timer) { // rejoin mid-match: replay everything so far, then live ticks follow
    ws.send({ t: 'resume', opp: r.seats[1 - seat]?.name ?? '', ticks: r.log })
    others(r, seat)?.send({ t: 'back' })
  } else maybeStart(r)
  ws.onText = s => {
    let m: { t?: string; cmds?: unknown[]; n?: number; h?: number }
    try { m = JSON.parse(s) } catch { return }
    // commands are stamped with the sender's seat here, so nobody can play the other lane
    if (m.t === 'cmds' && Array.isArray(m.cmds) && room.timer) for (const c of m.cmds.slice(0, 20)) {
      const ok = c && typeof c === 'object' && clean(c, seat)
      // per seat, so a spamming rival can't crowd out your own commands
      if (ok && room.inbox.filter(x => (x as { p: number }).p === seat).length < 20) room.inbox.push(ok)
    }
    if (m.t === 'rematch') { me.ready = true; maybeStart(room) }
    if (m.t === 'over') stop(room)
    if (m.t === 'hash' && typeof m.n === 'number' && typeof m.h === 'number') {
      const h = room.hashes.get(m.n)
      if (h === undefined) { if (m.n % 100 === 0 && Math.abs(m.n - room.tick) < 2000 && room.hashes.size < 50) room.hashes.set(m.n, m.h) }
      else { room.hashes.delete(m.n); if (h !== m.h) { log(`${room.code}: DESYNC at tick ${m.n}`); for (const o of room.seats) o?.ws?.send({ t: 'desync', n: m.n }) } }
    }
  }
  ws.onClose = () => {
    if (me.ws !== ws) return
    me.ws = null
    log(`${room.code}: ${me.name} left`)
    if (!room.timer) { room.seats[seat] = null; others(room, seat)?.send({ t: 'left' }) } // lobby / after the match: free the seat
    else { me.goneAt = Date.now(); others(room, seat)?.send({ t: 'gone', ms: FORFEIT_MS }) } // mid-match: hold it for a rejoin
    if (!room.seats.some(s => s?.ws)) { stop(room); rooms.delete(room.code) }
  }
}

function maybeStart(r: Room) {
  const [a, b] = r.seats
  if (r.timer || !a?.ws || !b?.ws || !a.ready || !b.ready) {
    for (const o of r.seats) o?.ws?.send({ t: 'waiting', players: r.seats.filter(s => s?.ws).length, code: r.code })
    return
  }
  a.ready = b.ready = false
  r.tick = 0; r.inbox = []; r.log = []; r.hashes.clear()
  r.seats.forEach((o, i) => o?.ws?.send({ t: 'start', opp: r.seats[1 - i]!.name }))
  log(`${r.code}: match started`)
  r.timer = setInterval(() => {
    const cmds = r.inbox; r.inbox = []
    const pkt = { n: r.tick, cmds }
    r.log.push(pkt)
    for (const o of r.seats) o?.ws?.send({ t: 'tick', ...pkt })
    r.tick++
    if (r.tick % 20) return
    r.seats.forEach((o, i) => { // a seat empty for 30 s forfeits
      if (!o || o.ws || !o.goneAt || Date.now() - o.goneAt < FORFEIT_MS) return
      log(`${r.code}: ${o.name} forfeits`)
      stop(r)
      r.seats[1 - i]?.ws?.send({ t: 'forfeit' })
      r.seats[i] = null
    })
  }, TICK_MS)
}
function stop(r: Room) { if (r.timer) clearInterval(r.timer); r.timer = null; r.seats.forEach((s, i) => { if (s && !s.ws) r.seats[i] = null }) }

const log = (s: string) => console.log(`[${new Date().toLocaleTimeString()}] ${s}`)

http.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i!.address)
  console.log(`CogRush LAN server on port ${PORT}. Open on both devices:`)
  for (const ip of ips.length ? ips : ['localhost']) console.log(`  http://${ip}:${PORT}`)
})
