import { Application, Graphics } from 'pixi.js'
import {
  COLS, FACTORY, INCOME_EVERY_S, ROBOTS, ROBOT_KINDS, ROWS, SEND, SUDDEN, TICK_HZ, TOWERS, TOWER_KINDS,
  type RobotKind, type TowerKind,
} from './sim/config.ts'
import {
  buildable, canBuild, canFactory, canLoad, canRelease, canUpgrade, factoryCost, newGame, readyCount, secs, sellValue,
  slotsUsed, step, towerStats, upgradeCost, waveCap, wouldSeal, type Cmd, type Game, type Lane, type Tower,
} from './sim/sim.ts'
import { DIFFICULTY, botThink, newMem, type BotMem, type Strategy } from './sim/bot.ts'
import { VIS, drawLane, hex, type Fx, type View } from './render.ts'

const TOWER_ROLE: Record<TowerKind, string> = {
  gatling: 'Cheap single target · Kinetic · ground + air',
  flak: 'Anti-air splash · Explosive · air only',
  emp: 'Slows robots in range by 40% · Energy',
  mortar: 'Splash · Explosive · ground only',
  tesla: 'Chains to 3 targets · Energy',
  laser: 'Beam pierces a line · Energy · ground only',
}
const ROBOT_ROLE: Record<RobotKind, string> = {
  scout: 'Light · fast, cheap rusher',
  drone: 'Light · flies straight to the exit, ignores the maze',
  repair: 'Light · heals robots within 2 cells',
  shield: 'Shielded · gives nearby robots a 50 HP shield',
  tank: 'Heavy · slow damage sponge',
  splitter: 'Shielded · splits into 3 Scouts when destroyed',
  breaker: 'Heavy · damages towers next to its path',
  colossus: 'Heavy · boss, sendable from 5:00',
}
const short = (k: RobotKind) => ROBOTS[k].name.replace(' bot', '')
const DMG_SHORT = { kinetic: 'Kin', explosive: 'Exp', energy: 'Nrg' } as const

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const laneEl = $('lane'), body = $('body'), banner = $('banner'), toastEl = $('toast')

const app = new Application()
await app.init({ resizeTo: laneEl, background: 0x0d1117, antialias: true, resolution: devicePixelRatio, autoDensity: true })
laneEl.prepend(app.canvas)
new ResizeObserver(() => app.resize()).observe(laneEl)
const gfx = new Graphics()
app.stage.addChild(gfx)

const ME = 0, BOT = 1
let g: Game | null = null
let bot: { st: Strategy; mem: BotMem } | null = null
let diff: keyof typeof DIFFICULTY = 'normal'
let pending: Cmd[] = []
let paused = false
let tab: 'build' | 'send' | 'factories' = 'build'
let sel: { x: number; y: number } | null = null
let selFactory: RobotKind = 'scout'
let view = ME // which lane is shown big on a phone
let prev = new Map<number, { x: number; y: number }>()
let fx: Fx[] = []
let drag: { cells: number[]; last: number } | null = null
let rowKind: TowerKind = 'gatling' // what a drag builds
let toastUntil = 0

// --- match flow --------------------------------------------------------------

function start(d: keyof typeof DIFFICULTY) {
  diff = d
  g = newGame()
  bot = { st: DIFFICULTY[d], mem: newMem() }
  pending = []; sel = null; view = ME; paused = false; lastLives = [20, 20]; fx = []; prev.clear(); tab = 'build'
  $('menu').hidden = true
  $('end').hidden = true
  $('pause').textContent = 'II'
  toast('Prep phase: build your maze!', 3000)
  renderPanel(true)
}

function end(game: Game) {
  const won = game.winner === ME, draw = game.winner === -2
  $('endTitle').textContent = draw ? 'Draw' : won ? 'Victory!' : 'Defeat'
  $('endTitle').style.color = draw ? '#e6edf3' : won ? '#3fb950' : '#ff7b72'
  $('endSub').textContent = `${DIFFICULTY[diff].name} bot · ${clock(secs(game))}`
  const [a, b] = game.lanes
  const rows: [string, (L: Lane) => string | number][] = [
    ['Lives left', L => L.lives], ['Robots killed', L => L.stats.kills], ['Robots sent', L => L.stats.sent],
    ['Leaks taken', L => L.stats.leaksTaken], ['Income', L => `+${L.income}`],
    ['Gold on towers', L => L.stats.towerGold], ['Gold on sends', L => L.stats.sendGold],
  ]
  $('endStats').innerHTML = `<tr><td></td><td>You</td><td>Bot</td></tr>` + rows.map(([n, f]) => `<tr><td>${n}</td><td>${f(a)}</td><td>${f(b)}</td></tr>`).join('')
  $('end').hidden = false
}

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-diff]')) b.onclick = () => start(b.dataset.diff as keyof typeof DIFFICULTY)
$('again').onclick = () => start(diff)
$('toMenu').onclick = () => { $('end').hidden = true; $('menu').hidden = false; g = null }
$('pause').onclick = () => togglePause()
function togglePause() {
  if (!g || g.winner !== -1) return
  paused = !paused
  $('pause').textContent = paused ? '▶' : 'II'
  toast(paused ? 'Paused' : 'Resumed', paused ? 1e9 : 800)
}
document.addEventListener('visibilitychange', () => { if (document.hidden && g && !paused && g.winner === -1) togglePause() })

// help overlay pauses the match while it's open
let pausedByHelp = false
function toggleHelp() {
  const el = $('helpScreen'), open = el.hidden
  el.hidden = !open
  if (open && g && !paused && g.winner === -1) { togglePause(); pausedByHelp = true }
  else if (!open && pausedByHelp) { pausedByHelp = false; if (paused) togglePause() }
}
$('help').onclick = toggleHelp
$('helpClose').onclick = toggleHelp

function toast(text: string, ms = 1800) {
  toastEl.textContent = text
  toastEl.hidden = false
  toastUntil = performance.now() + ms
}

// --- layout and input ----------------------------------------------------------

function layout(): { main: View; mini: View | null; side: View | null } {
  const w = app.screen.width, h = app.screen.height
  if (w >= h * 1.1) { // tablet landscape / desktop: both lanes side by side
    const cell = Math.floor(Math.min((w - 24) / (COLS * 2), h / ROWS))
    const x = Math.floor((w - cell * COLS * 2 - 24) / 2)
    return { main: { x, y: 0, cell }, mini: null, side: { x: x + cell * COLS + 24, y: 0, cell } }
  }
  const cell = Math.floor(Math.min((w - 50) / COLS, h / ROWS))
  const x = Math.floor((w - cell * COLS - 50) / 2), mx = x + cell * COLS + 6
  return { main: { x, y: 0, cell }, mini: { x: mx, y: 0, cell: Math.min(6, Math.floor((w - mx) / COLS)) }, side: null }
}

const hit = (v: View, px: number, py: number) => {
  const x = Math.floor((px - v.x) / v.cell), y = Math.floor((py - v.y) / v.cell)
  return x >= 0 && x < COLS && y >= 0 && y < ROWS ? { x, y } : null
}
const localXY = (e: PointerEvent) => { const r = app.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
const mainLane = () => (layout().side ? ME : view)

app.canvas.addEventListener('pointerdown', e => {
  if (!g) return
  const [px, py] = localXY(e)
  const { main, mini, side } = layout()
  if ((mini && hit(mini, px, py)) || (side && hit(side, px, py))) { // tap the other lane: swap views on a phone
    if (mini) { view = 1 - view; sel = null; renderPanel(true) }
    return
  }
  const c = hit(main, px, py)
  if (!c || mainLane() !== ME) return
  const L = g.lanes[ME], i = c.y * COLS + c.x
  if (buildable(c.x, c.y) && !L.towers[i]) {
    drag = { cells: [i], last: i }
    app.canvas.setPointerCapture(e.pointerId)
  } else tap(c)
})

app.canvas.addEventListener('pointermove', e => {
  if (!drag || !g) return
  const [px, py] = localXY(e)
  const c = hit(layout().main, px, py)
  if (!c) return
  const i = c.y * COLS + c.x
  if (i === drag.last) return
  // walk cell by cell from the last cell so fast swipes don't skip
  let x = drag.last % COLS, y = Math.floor(drag.last / COLS)
  while (x !== c.x || y !== c.y) {
    if (x !== c.x) x += Math.sign(c.x - x); else y += Math.sign(c.y - y)
    const j = y * COLS + x
    if (buildable(x, y) && !g.lanes[ME].towers[j] && !drag.cells.includes(j)) drag.cells.push(j)
  }
  drag.last = i
})

app.canvas.addEventListener('pointerup', () => {
  if (!drag || !g) return
  const cells = drag.cells
  drag = null
  if (cells.length === 1) return tap({ x: cells[0] % COLS, y: Math.floor(cells[0] / COLS) })
  // quick row: the picked tower type along the drag, skipping any cell that would seal the lane
  const L = g.lanes[ME], towers = L.towers.slice(), cost = TOWERS[rowKind].cost
  let gold = L.gold, built = 0, skipped = 0
  for (const i of cells) {
    const x = i % COLS, y = Math.floor(i / COLS)
    if (gold < cost) break
    if (canBuild(L, x, y, rowKind) || wouldSeal(L, x, y, towers)) { skipped++; continue }
    towers[i] = { kind: rowKind } as Tower
    gold -= cost
    pending.push({ p: ME, t: 'build', x, y, kind: rowKind })
    built++
  }
  sel = null
  toast(`Row: ${built} ${TOWERS[rowKind].name}${built === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} (would seal or blocked)` : ''}${gold < cost && built < cells.length - skipped ? ', out of gold' : ''}`)
  renderPanel(true)
})

function tap(c: { x: number; y: number }) {
  sel = sel && sel.x === c.x && sel.y === c.y ? null : c
  tab = 'build'
  renderPanel(true)
}

// --- panel -------------------------------------------------------------------

for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) b.onclick = () => { tab = b.dataset.tab as typeof tab; renderPanel(true) }

body.addEventListener('pointerdown', e => {
  const b = (e.target as HTMLElement).closest('button')
  if (!b || b.disabled || !g) return
  e.preventDefault()
  act(b.dataset.act!, b.dataset.arg)
})

function act(a: string, arg?: string) {
  if (!g) return
  const L = g.lanes[ME]
  switch (a) {
    case 'build': if (sel && !canBuild(L, sel.x, sel.y, arg as TowerKind)) pending.push({ p: ME, t: 'build', x: sel.x, y: sel.y, kind: arg as TowerKind }); break
    case 'upgrade': if (sel) pending.push({ p: ME, t: 'upgrade', x: sel.x, y: sel.y, branch: arg }); break
    case 'sell': if (sel) { pending.push({ p: ME, t: 'sell', x: sel.x, y: sel.y }); sel = null } break
    case 'load': pending.push({ p: ME, t: 'load', kind: arg as RobotKind }); break
    case 'release': pending.push({ p: ME, t: 'release' }); break
    case 'pickFactory': selFactory = arg as RobotKind; break
    case 'rowKind': rowKind = arg as TowerKind; break
    case 'factory': pending.push({ p: ME, t: 'factory', kind: selFactory }); break
    case 'demolish': pending.push({ p: ME, t: 'demolish', kind: selFactory }); break
  }
  renderPanel(true)
}

let lastHtml = ''
function renderPanel(force = false) {
  if (!g) return
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab)
  const html = mainLane() !== ME ? opponentHtml(g, g.lanes[view]) : tab === 'build' ? buildHtml(g, g.lanes[ME]) : tab === 'send' ? sendHtml(g, g.lanes[ME]) : factoryHtml(g.lanes[ME])
  if (html !== lastHtml || force) { body.innerHTML = html; lastHtml = html }
}

const btn = (act: string, label: string, opts: { arg?: string; sub?: string; cls?: string; off?: boolean | string | null; icon?: string; color?: string; key?: string } = {}) =>
  `<button data-act="${act}" ${opts.arg ? `data-arg="${opts.arg}"` : ''} class="${opts.cls ?? ''}" ${opts.off ? 'disabled' : ''}${opts.color ? ` style="border-left:3px solid ${opts.color}"` : ''}>` +
  `${opts.icon ? `<span class="ic" style="color:${opts.color}">${opts.icon}</span>` : ''}${label}${opts.key ? `<kbd>${opts.key}</kbd>` : ''}${opts.sub ? `<small>${opts.sub}</small>` : ''}</button>`

function buildHtml(g: Game, L: Lane): string {
  if (!sel) {
    const msg = L.sealed ? '<span class="warn">Lane sealed: Breach mode! Income frozen, leaks cost 2 lives.</span>' : `Tap a cell to build · drag for a row of <b style="color:${hex(VIS.tower[rowKind].color)}">${TOWERS[rowKind].name}</b>`
    return `<div class="info">${msg}</div><div class="grid six">` +
      TOWER_KINDS.map((k, i) => `<button data-act="rowKind" data-arg="${k}" class="pick ${k === rowKind ? 'sel' : ''}"><span class="ic" style="color:${hex(VIS.tower[k].color)}">${VIS.tower[k].icon}</span>${TOWERS[k].name}<br>${TOWERS[k].cost}g<kbd>${i + 1}</kbd></button>`).join('') +
      '</div>' + legend()
  }
  const t = L.towers[sel.y * COLS + sel.x]
  if (!t) {
    const why = canBuild(L, sel.x, sel.y, 'gatling')
    if (why && why !== 'Not enough gold') return `<div class="info warn">${why}</div>`
    const seals = wouldSeal(L, sel.x, sel.y)
    return `<div class="info ${seals ? 'warn' : ''}">${seals ? '⚠ This seals your lane! Robots will breach it.' : 'Pick a tower for this cell.'}</div><div class="grid">` +
      TOWER_KINDS.map((k, i) => btn('build', TOWERS[k].name, { arg: k, key: String(i + 1), sub: `${TOWERS[k].cost} · ${DMG_SHORT[TOWERS[k].dmg]}`, cls: seals ? 'tile danger' : 'tile', off: L.gold < TOWERS[k].cost, icon: VIS.tower[k].icon, color: hex(VIS.tower[k].color) })).join('') + '</div>'
  }
  const st = towerStats(t), d = TOWERS[t.kind]
  const branch = t.branch ? d.branches.find(b => b.key === t.branch)!.name : ''
  const info = `<b style="color:${hex(VIS.tower[t.kind].color)}">${d.name}</b> L${t.level}${branch ? ` · ${branch}` : ''} · HP ${Math.ceil(t.hp / 1000)}/${Math.round(t.maxHp / 1000)} · ${Math.round(st.dps / 1000)} dps · range ${(st.rangeMc / 1000).toFixed(1)}`
  let up: string
  if (t.level === 1) up = btn('upgrade', `Upgrade ${upgradeCost(t)}`, { key: 'U', sub: '+60% dmg, +10% range', off: !!canUpgrade(L, t.x, t.y) })
  else if (t.level === 2) up = d.branches.map((b, i) => btn('upgrade', `${b.name} ${upgradeCost(t)}`, { arg: b.key, key: 'AB'[i], sub: b.desc, off: !!canUpgrade(L, t.x, t.y, b.key) })).join('')
  else up = btn('noop', 'Max level', { cls: 'alt', off: true })
  return `<div class="info">${info}</div><div class="info">${TOWER_ROLE[t.kind]}</div><div class="row">${up}${btn('sell', `Sell +${sellValue(t)}`, { cls: 'alt', key: 'S' })}</div>`
}

const legend = () => `<div class="info" style="font-size:12px">Kinetic beats <b>Light</b> · Explosive beats <b>Heavy</b> · Energy beats <b>Shielded</b></div>`

function sendHtml(g: Game, L: Lane): string {
  const ready = readyCount(L), building = L.queue.length - ready
  const prep = secs(g) < SEND.prepS
  const cur = L.queue.find(q => q.left > 0)
  const build = cur ? ` · building ${ROBOTS[cur.kind].name} ${Math.ceil(cur.left / TICK_HZ)}s${building > 1 ? ` (+${building - 1} queued)` : ''}` : ''
  const info = (prep ? `Release unlocks in ${Math.ceil(SEND.prepS - secs(g))}s` : `<b>${ready}</b> ready to release`) + build
  const tiles = ROBOT_KINDS.map((k, i) => {
    const lvl = L.factories[k], q = L.queue.filter(x => x.kind === k).length
    const why = canLoad(g, L, k)
    return btn('load', short(k), {
      arg: k, cls: 'tile', off: !!why, icon: VIS.robot[k].icon, color: hex(VIS.robot[k].color), key: 'QWERTYUI'[i],
      sub: lvl ? `${ROBOTS[k].sendCost}g · ${q}/${waveCap(k, lvl)}` : 'no factory',
    })
  }).join('')
  return `<div class="info">${info}</div><div class="grid four">${tiles}</div><div class="row" style="margin-top:5px">${btn('release', `Release${ready ? ` ${ready}` : ''}`, { cls: 'go', off: !!canRelease(g, L), key: 'Space' })}</div>`
}

function factoryHtml(L: Lane): string {
  const k = selFactory, lvl = L.factories[k], r = ROBOTS[k]
  const tiles = ROBOT_KINDS.map(x => btn('pickFactory', short(x), {
    arg: x, cls: x === k ? 'tile sel' : 'tile', icon: VIS.robot[x].icon, color: hex(VIS.robot[x].color),
    sub: L.factories[x] ? `Level ${L.factories[x]}` : `${ROBOTS[x].factoryCost}g`,
  })).join('')
  const why = canFactory(L, k)
  const main = lvl >= 3 ? btn('noop', 'Max level', { cls: 'alt', off: true })
    : btn('factory', `${lvl ? 'Upgrade' : 'Build'} ${factoryCost(L, k)}`, { sub: lvl ? '+25% HP, bigger waves' : why === 'No free slot' ? 'no free slot' : 'unlocks this robot', off: !!why })
  const demo = k !== 'scout' && lvl ? btn('demolish', 'Demolish', { cls: 'danger', sub: 'frees the slot, no refund' }) : ''
  return `<div class="info"><b>${r.name}</b>: ${ROBOT_ROLE[k]} · ${Math.round(r.hp * SEND.hpPct / 100)} HP · slots ${slotsUsed(L)}/${FACTORY.slots}</div><div class="grid four">${tiles}</div><div class="row" style="margin-top:5px">${main}${demo}</div>`
}

function opponentHtml(g: Game, L: Lane): string {
  const facts = ROBOT_KINDS.filter(k => L.factories[k]).map(k => `${ROBOTS[k].name} L${L.factories[k]}`).join(', ')
  const towers = L.towers.filter(Boolean).length
  return `<div class="info"><b class="warn">Bot lane</b> · ❤ ${L.lives} · ⚙ ${L.gold} · +${L.income}/${INCOME_EVERY_S}s · ${towers} towers</div>` +
    `<div class="info">Factories: ${facts}</div><div class="info">Queued: ${L.queue.length} robots${L.sealed ? ' · <span class="warn">sealed!</span>' : ''}</div>` +
    `<div class="row">${btn('back', 'Back to my lane', { cls: 'alt' })}</div>`
}
body.addEventListener('pointerdown', e => { if ((e.target as HTMLElement).closest('[data-act="back"]')) { view = ME; renderPanel(true) } })

// --- keyboard ------------------------------------------------------------------

addEventListener('keydown', e => {
  if (!g || e.repeat) return
  const L = g.lanes[ME], k = e.key.toLowerCase()
  const t = sel && L.towers[sel.y * COLS + sel.x]
  if (k === 'h' || k === '?') toggleHelp()
  else if (k >= '1' && k <= '6' && sel && !t) act('build', TOWER_KINDS[+k - 1])
  else if (k >= '1' && k <= '6' && !sel) act('rowKind', TOWER_KINDS[+k - 1])
  else if (k === 'u' && t) act('upgrade')
  else if ((k === 'a' || k === 'b') && t && t.level === 2) act('upgrade', TOWERS[t.kind].branches[k === 'a' ? 0 : 1].key)
  else if (k === 's' && t) act('sell')
  else if ('qwertyui'.includes(k) && k.length === 1) act('load', ROBOT_KINDS['qwertyui'.indexOf(k)])
  else if (k === ' ') { e.preventDefault(); act('release') }
  else if (k === 'escape') { if (!$('helpScreen').hidden) toggleHelp(); else { sel = null; renderPanel(true) } }
  else if (k === 'p') togglePause()
})

// --- loop ----------------------------------------------------------------------

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
let lastLives = [0, 0]
function hud(g: Game) {
  const L = g.lanes[ME], O = g.lanes[BOT], t = secs(g)
  $('lives').textContent = String(L.lives)
  $('gold').textContent = String(L.gold)
  $('income').textContent = `+${L.income}`
  $('incomeSub').textContent = L.sealed ? 'frozen!' : `next in ${Math.ceil(INCOME_EVERY_S - (t % INCOME_EVERY_S))}s`
  $('income').classList.toggle('frozen', L.sealed)
  $('tickFill').style.width = `${(t % INCOME_EVERY_S) / INCOME_EVERY_S * 100}%`
  $('tickFill').style.background = L.sealed ? '#ff6b6b' : '#3fb950'
  $('olives').textContent = String(O.lives)
  $('ogold').textContent = String(O.gold)
  $('oincome').textContent = `+${O.income}`
  g.lanes.forEach((x, i) => {
    const el = $(i === ME ? 'meLives' : 'botLives')
    el.classList.toggle('low', x.lives <= 5)
    if (x.lives < lastLives[i]) { el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit') }
    lastLives[i] = x.lives
  })
  $('clock').textContent = t < SEND.prepS ? `Prep ${Math.ceil(SEND.prepS - t)}` : t >= SUDDEN.fromS ? `⚠ ${clock(t)}` : clock(t)
  const shown = g.lanes[mainLane()], inc = shown.incoming[0]
  if (inc) {
    const counts = new Map<RobotKind, number>()
    for (const r of inc.robots) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1)
    banner.textContent = `${shown.p === ME ? '⚠ Incoming' : 'Your wave lands'} in ${Math.ceil((inc.at - g.tick) / TICK_HZ)}s: ` + [...counts].map(([k, n]) => `${n}× ${ROBOTS[k].name}`).join(', ')
    banner.style.background = shown.p === ME ? '#da3633e6' : '#238636e6'
    banner.hidden = false
  } else banner.hidden = true
}

let acc = 0
const DT = 1000 / TICK_HZ
app.ticker.add(t => {
  const now = performance.now()
  if (toastUntil && now > toastUntil) { toastEl.hidden = true; toastUntil = 0 }
  if (!g) return gfx.clear()
  const running = !paused && g.winner === -1
  if (running) acc = Math.min(acc + t.deltaMS, DT * 10) // don't spiral after a background tab
  let stepped = false
  while (running && acc >= DT) {
    acc -= DT
    prev = new Map(g.lanes.flatMap(L => L.robots.map(r => [r.id, { x: r.x, y: r.y }] as const)))
    const wasSealed = g.lanes[ME].sealed
    step(g, [...pending, ...botThink(g, BOT, bot!.st, bot!.mem)])
    pending = []
    stepped = true
    for (const e of g.events) {
      if (e.t === 'fx') fx.push({ ...e, until: now + (e.k === 'beam' ? 60 : e.k === 'line' ? 90 : 220) })
      if (e.t === 'wave' && e.p === ME) toast(secs(g) >= SUDDEN.fromS ? `Sudden death wave ${e.n + 1}!` : `Neutral wave ${e.n + 1}`)
    }
    if (!wasSealed && g.lanes[ME].sealed) toast('Lane sealed! Breach mode', 2500)
    if (g.tick === SEND.prepS * TICK_HZ) toast('Sending unlocked!')
    if (g.tick === SUDDEN.fromS * TICK_HZ) toast('Sudden death: waves every 15 s', 3000)
    if (g.winner !== -1) { end(g); break }
  }
  if (stepped) { hud(g); renderPanel() }
  fx = fx.filter(f => f.until > now)

  gfx.clear()
  const { main, mini, side } = layout()
  const alpha = running ? acc / DT : 1
  const big = mainLane()
  const drawn = [{ L: g.lanes[big], v: main, mini: false }]
  if (side) drawn.push({ L: g.lanes[1 - big], v: side, mini: false })
  if (mini) drawn.push({ L: g.lanes[1 - big], v: mini, mini: true })
  for (const d of drawn) {
    const mine = d.L.p === ME
    drawLane(gfx, d.L, d.v, {
      alpha, prev, now, mini: d.mini,
      fx: d.mini ? [] : fx.filter(f => f.p === d.L.p),
      sel: mine ? sel : null, preview: mine && sel && !d.L.towers[sel.y * COLS + sel.x] && tab === 'build' ? 'gatling' : null,
      drag: mine && drag && drag.cells.length > 1 ? drag.cells : [], dragKind: rowKind,
    })
  }
  if (mini) gfx.rect(mini.x - 1, mini.y - 1, mini.cell * COLS + 2, mini.cell * ROWS + 2).stroke({ width: 1, color: big === ME ? 0xff7b72 : 0x3fb950 })
})

// ?play=easy|normal|hard skips the menu
const q = new URLSearchParams(location.search).get('play')
if (q && q in DIFFICULTY) start(q as keyof typeof DIFFICULTY)

if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
// dev console hook: game() returns live state
if (import.meta.env.DEV) Object.assign(window, {
  game: () => g, cmd: (c: Cmd) => pending.push(c),
  // ff(seconds, true) fast-forwards with a Normal bot playing for you too
  ff: (s: number, auto = false) => { const me = newMem(); for (let i = 0; i < s * TICK_HZ && g && g.winner === -1; i++) { step(g, [...pending, ...(auto ? botThink(g, ME, DIFFICULTY.normal, me) : []), ...botThink(g, BOT, bot!.st, bot!.mem)]); pending = [] } if (g) { hud(g); renderPanel(true); if (g.winner !== -1) end(g) } },
})
