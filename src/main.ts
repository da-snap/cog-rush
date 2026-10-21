import { Application, Graphics } from 'pixi.js'
import { COLS, EXIT_ROWS, FIRST_WAVE_S, INCOME_EVERY_S, MC, ROWS, SELL_REFUND_PCT, SPAWN_ROWS, TICK_HZ, TOWERS, WAVE_EVERY_S, type RobotKind, type TowerKind } from './sim/config.ts'
import { INF, canBuild, newState, pathFrom, step, wouldSeal, field, type Cmd, type Tower } from './sim/sim.ts'

// One lookup table from sim type to visual, so placeholder shapes can become sprites later.
const VIS: { tower: Record<TowerKind, number>; robot: Record<RobotKind, { color: number; r: number }> } = {
  tower: { gatling: 0x8b949e },
  robot: { scout: { color: 0xf0b429, r: 0.22 }, tank: { color: 0xe5534b, r: 0.36 } },
}

const $ = (id: string) => document.getElementById(id)!
const laneEl = $('lane'), msg = $('msg'), act = $('act') as HTMLButtonElement

const app = new Application()
await app.init({ resizeTo: laneEl, background: 0x11151c, antialias: true, resolution: devicePixelRatio, autoDensity: true })
laneEl.appendChild(app.canvas)
const g = new Graphics()
app.stage.addChild(g)

let s = newState()
let pending: Cmd[] = []
let sel: { x: number; y: number } | null = null
let prev = new Map<number, { x: number; y: number }>() // robot positions before the last tick, for interpolation
let shots: { x1: number; y1: number; x2: number; y2: number }[] = []

const layout = () => {
  const w = app.screen.width, h = app.screen.height
  const cell = Math.floor(Math.min(w / COLS, h / ROWS))
  return { cell, ox: Math.floor((w - cell * COLS) / 2), oy: Math.floor((h - cell * ROWS) / 2) }
}

app.canvas.addEventListener('pointerdown', e => {
  const { cell, ox, oy } = layout()
  const r = app.canvas.getBoundingClientRect()
  const x = Math.floor((e.clientX - r.left - ox) / cell), y = Math.floor((e.clientY - r.top - oy) / cell)
  sel = x >= 0 && x < COLS && y >= 0 && y < ROWS && !(sel && sel.x === x && sel.y === y) ? { x, y } : null
  updateBar()
})

act.onclick = () => {
  if (!sel) return
  pending.push(s.towers[sel.y * COLS + sel.x] ? { t: 'sell', ...sel } : { t: 'build', ...sel, kind: 'gatling' })
  sel = null
}
$('restart').onclick = () => { s = newState(); sel = null; pending = []; prev.clear() }

function updateBar() {
  msg.className = ''
  act.hidden = true
  act.className = ''
  if (s.lives <= 0) { msg.textContent = 'Lane lost. Restart to try again.'; return }
  if (!sel) { msg.textContent = s.sealed ? 'Lane sealed: Breach mode, income frozen!' : 'Tap a cell to build.'; msg.className = s.sealed ? 'warn' : ''; return }
  const t = s.towers[sel.y * COLS + sel.x]
  if (t) {
    msg.textContent = `Gatling · HP ${Math.ceil(t.hp / MC)}/${t.maxHp / MC}`
    act.hidden = false
    act.textContent = `Sell +${Math.floor(t.invested * SELL_REFUND_PCT / 100)}`
    return
  }
  const why = canBuild(s, sel.x, sel.y, 'gatling')
  const seals = !why && wouldSeal(s, sel.x, sel.y)
  msg.textContent = why ?? (seals ? 'This seals your lane' : 'Gatling: kinetic, range 3')
  msg.className = why || seals ? 'warn' : ''
  act.hidden = !!why && why !== 'Not enough gold'
  act.disabled = !!why
  act.className = seals ? 'danger' : ''
  act.textContent = `Build ${TOWERS.gatling.cost}`
}

function hud() {
  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  const secs = s.tick / TICK_HZ
  const nextIncome = INCOME_EVERY_S - (secs % INCOME_EVERY_S)
  const nextWave = secs < FIRST_WAVE_S ? FIRST_WAVE_S - secs : WAVE_EVERY_S - ((secs - FIRST_WAVE_S) % WAVE_EVERY_S)
  $('lives').textContent = String(s.lives)
  $('gold').textContent = String(s.gold)
  $('income').textContent = s.sealed ? 'frozen' : `+${s.income} in ${Math.ceil(nextIncome)}s`
  $('wave').textContent = `Wave ${s.wave + 1} in ${Math.ceil(nextWave)}s`
  $('clock').textContent = fmt(secs)
}

// fixed 20 Hz sim, render every frame
let acc = 0
const DT = 1000 / TICK_HZ
app.ticker.add(t => {
  if (s.lives > 0) acc += t.deltaMS
  acc = Math.min(acc, DT * 10) // don't spiral after a background tab
  let stepped = false
  while (acc >= DT) {
    acc -= DT
    prev = new Map(s.robots.map(r => [r.id, { x: r.x, y: r.y }]))
    step(s, pending)
    pending = []
    stepped = true
    const byId = new Map<number, Tower>(), rob = new Map(s.robots.map(r => [r.id, r]))
    for (const tw of s.towers) if (tw) byId.set(tw.id, tw)
    shots = s.events.flatMap(e => {
      if (e.t !== 'shot') return []
      const tw = byId.get(e.tower), r = rob.get(e.robot)
      return tw && r ? [{ x1: (tw.x + 0.5) * MC, y1: (tw.y + 0.5) * MC, x2: r.x, y2: r.y }] : []
    })
  }
  if (stepped) { hud(); updateBar() }
  draw(acc / DT)
})

function draw(alpha: number) {
  const { cell, ox, oy } = layout()
  const px = (mc: number) => (mc / MC) * cell
  g.clear()
  // zones
  g.rect(ox, oy, cell * COLS, cell * SPAWN_ROWS).fill(0x1d3b2a)
  g.rect(ox, oy + cell * (ROWS - EXIT_ROWS), cell * COLS, cell * EXIT_ROWS).fill(0x3b1d22)
  for (let x = 0; x <= COLS; x++) g.moveTo(ox + x * cell, oy).lineTo(ox + x * cell, oy + ROWS * cell)
  for (let y = 0; y <= ROWS; y++) g.moveTo(ox, oy + y * cell).lineTo(ox + COLS * cell, oy + y * cell)
  g.stroke({ width: 1, color: 0x232a33 })

  // path: current one, or the preview with the selected tower placed
  let towers = s.towers, color = 0x2f81f7
  if (sel && !s.towers[sel.y * COLS + sel.x] && !canBuild(s, sel.x, sel.y, 'gatling')) {
    towers = s.towers.slice()
    towers[sel.y * COLS + sel.x] = { id: 0, kind: 'gatling', x: sel.x, y: sel.y, hp: TOWERS.gatling.hp * MC, maxHp: 1, invested: 0, target: 0 }
    color = 0x58a6ff
  }
  const preview = towers !== s.towers
  const open = preview ? field(towers, false) : s.openDist
  const sealed = open[(COLS - 1) / 2] >= INF
  const path = pathFrom(sealed ? (preview ? field(towers, true) : s.breachDist) : open, towers)
  if (sealed) color = 0xff6b6b
  path.forEach((c, i) => {
    const cx = ox + (c % COLS + 0.5) * cell, cy = oy + (Math.floor(c / COLS) + 0.5) * cell
    if (i) g.lineTo(cx, cy); else g.moveTo(cx, cy)
  })
  g.stroke({ width: 3, color, alpha: 0.5 })

  // towers
  for (const t of s.towers) {
    if (!t) continue
    const x = ox + t.x * cell, y = oy + t.y * cell
    g.roundRect(x + 2, y + 2, cell - 4, cell - 4, 4).fill(VIS.tower[t.kind])
    g.circle(x + cell / 2, y + cell / 2, cell * 0.18).fill(0x30363d)
    if (t.hp < t.maxHp) g.rect(x + 3, y + cell - 6, (cell - 6) * Math.max(0, t.hp) / t.maxHp, 3).fill(0xf85149)
  }

  // selection + range
  if (sel) {
    const t = s.towers[sel.y * COLS + sel.x]
    const bad = !t && (canBuild(s, sel.x, sel.y, 'gatling') || sealed)
    g.rect(ox + sel.x * cell + 1, oy + sel.y * cell + 1, cell - 2, cell - 2).stroke({ width: 2, color: bad ? 0xff6b6b : 0xffffff })
    g.circle(ox + (sel.x + 0.5) * cell, oy + (sel.y + 0.5) * cell, px(TOWERS.gatling.rangeMc)).stroke({ width: 1, color: 0xffffff, alpha: 0.3 })
  }

  for (const sh of shots) g.moveTo(ox + px(sh.x1), oy + px(sh.y1)).lineTo(ox + px(sh.x2), oy + px(sh.y2))
  g.stroke({ width: 1.5, color: 0xffd866, alpha: 0.8 })

  // robots, interpolated between ticks
  for (const r of s.robots) {
    const p = prev.get(r.id) ?? r
    const x = ox + px(p.x + (r.x - p.x) * alpha), y = oy + px(p.y + (r.y - p.y) * alpha)
    const v = VIS.robot[r.kind]
    g.circle(x, y, cell * v.r).fill(v.color)
    if (r.hp < r.maxHp) g.rect(x - cell * 0.3, y - cell * v.r - 5, cell * 0.6 * r.hp / r.maxHp, 3).fill(0x3fb950)
  }
}

// dev console hook: sim() returns live state, cmd({...}) queues a command
if (import.meta.env.DEV) Object.assign(window, { sim: () => s, cmd: (c: Cmd) => pending.push(c) })
