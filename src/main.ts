import { Scene3D, type UiState } from './scene3d.ts'
import * as sfx from './audio.ts'
import {
  ARMOR_MULT_PCT, COLS, FACTORY, INCOME_EVERY_S, LIVES, ROBOTS, ROBOT_KINDS, ROWS, SEND, SUDDEN, TICK_HZ, TOWERS, TOWER_KINDS,
  type RobotKind, type TowerKind,
} from './sim/config.ts'
import {
  buildable, canBuild, canFactory, canLoad, canRelease, canUpgrade, factoryCost, newGame, readyCount, secs, sellValue,
  slotsUsed, step, towerStats, upgradeCost, waveCap, wouldSeal, type Cmd, type Game, type Lane, type Tower,
} from './sim/sim.ts'
import { DIFFICULTY, RIVALS, botThink, newMem, radar, type BotMem, type Strategy, type Threat } from './sim/bot.ts'
import { C, ROBOT_ICON, TOWER_ICON, hex, robotColor, svgIcon, towerColor } from './ui.ts'

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
const DMG_SHORT = { kinetic: 'KIN', explosive: 'EXP', energy: 'NRG' } as const
const dmgTag = (k: TowerKind) => `<b style="color:${hex(towerColor(k))}">${DMG_SHORT[TOWERS[k].dmg]}${TOWERS[k].air && !TOWERS[k].ground ? '·AIR' : ''}</b>`
const PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>'
const PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M7 4v16l12-8z"/></svg>'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const laneEl = $('lane'), body = $('body'), banner = $('banner'), toastEl = $('toast')

const canvas = $<HTMLCanvasElement>('world')
const world = new Scene3D(canvas)
const size = () => { world.resize(innerWidth, innerHeight) }
addEventListener('resize', size); size()

let ME = 0, OPP = 1 // lane indices; on LAN the server assigns the seat
let g: Game | null = null
let bot: { st: Strategy; mem: BotMem } | null = null
// LAN match: the server sends one { n, cmds } packet per sim tick; we step exactly on those
let net: { ws: WebSocket; queue: { n: number; cmds: Cmd[] }[]; lastAt: number } | null = null
const rival = () => (net ? 'Rival' : 'Bot')
let diff: keyof typeof DIFFICULTY = 'normal'
let pending: Cmd[] = []
let paused = false
let tab: 'build' | 'send' | 'factories' = 'build'
let sel: { x: number; y: number } | null = null
let selFactory: RobotKind = 'scout'
let view = ME // which lane is shown big on a phone
let prev = new Map<number, { x: number; y: number }>()
let drag: { cells: number[]; last: number } | null = null
let buildKind: TowerKind | null = null // build mode: picked tower, stays picked until cancelled
let hover: { x: number; y: number } | null = null // cell under the mouse, for the build preview
let sealArmed = -1 // a cell that would seal the lane needs a second click
let toastUntil = 0

// --- match flow --------------------------------------------------------------

// what kind of local match is running: a plain bot, a ladder rival, or today's challenge
type Mode = { kind: 'bot' } | { kind: 'ladder'; i: number } | { kind: 'daily'; day: number; i: number; mod: number }
let mode: Mode = { kind: 'bot' }
const store = { get: (k: string) => { try { return localStorage.getItem('cogrush.' + k) } catch { return null } }, set: (k: string, v: string) => { try { localStorage.setItem('cogrush.' + k, v) } catch { /* private mode */ } } }
const ladderBeaten = () => Number(store.get('ladder') ?? -1)

// daily challenge: same rival and rule for everyone on a given day
const MODS: { name: string; desc: string; apply: (g: Game) => void }[] = [
  { name: 'Gold rush', desc: 'Both start with 500 gold', apply: g => { for (const L of g.lanes) L.gold = 500 } },
  { name: 'Glass core', desc: 'Both cores have only 40 HP', apply: g => { for (const L of g.lanes) L.lives = 40 } },
  { name: 'Drone day', desc: 'Both start with a Drone factory', apply: g => { for (const L of g.lanes) L.factories.drone = 1 } },
  { name: 'Underdog', desc: 'You start with 300 gold, the rival with +10 income', apply: g => { g.lanes[ME].gold = 300; g.lanes[OPP].income += 10 } },
]
const today = () => Math.floor(Date.now() / 86_400_000)
const daily = (day: number) => ({ day, i: 2 + (day * 5) % (RIVALS.length - 2), mod: day % MODS.length })

function start(d: keyof typeof DIFFICULTY) {
  diff = d
  play(DIFFICULTY[d], { kind: 'bot' })
}
function play(st: Strategy, m: Mode) {
  closeNet()
  ME = 0; OPP = 1
  mode = m
  bot = { st, mem: newMem() }
  replay = null
  begin()
  if (m.kind === 'daily') { MODS[m.mod].apply(g!); toast(`Daily: ${MODS[m.mod].name}. ${MODS[m.mod].desc}`, 4000) }
}

// recording: every command by tick (replays), plus lives and income every 5 s (post-match graph)
let rec = { log: new Map<number, Cmd[]>(), lives: [[] as number[], [] as number[]], income: [[] as number[], [] as number[]], lost: [new Map<RobotKind, number>(), new Map<RobotKind, number>()] }
let replay: { log: Map<number, Cmd[]> } | null = null
function startReplay() {
  const log = rec.log
  replay = { log }
  const st = bot?.st
  begin()
  if (mode.kind === 'daily') MODS[mode.mod].apply(g!)
  replay = { log }
  bot = st ? { st, mem: newMem() } : null
  toast('Replay at 4x speed. Esc or Menu to leave', 3000)
}

function begin() {
  g = newGame()
  for (const id of ['botTag', 'oppView']) { const el = document.getElementById(id); if (el) el.textContent = rival().toUpperCase() }
  $('pause').hidden = !!net
  if (!replay) rec = { log: new Map(), lives: [[LIVES], [LIVES]], income: [[0], [0]], lost: [new Map(), new Map()] }
  pending = []; sel = null; view = ME; paused = false; lastLives = [LIVES, LIVES]; prev.clear(); tab = 'build'; buildKind = null; demo = null
  sfx.unlockAudio(); sfx.setIntense(false); sfx.startMusic(); sfx.horn()
  $('menu').hidden = true
  document.body.classList.remove('menu')
  $('end').hidden = true
  $('pause').innerHTML = PAUSE
  toast('Prep phase: build your maze!', 3000)
  if (!replay && !net && !store.get('hinted')) { hints = true; store.set('hinted', '1') }
  renderPanel(true)
}

function end(game: Game) {
  const won = game.winner === ME, draw = game.winner === -2
  $('endTitle').textContent = draw ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT'
  $('endTitle').style.color = hex(draw ? C.white : won ? C.hazard : C.rogue)
  const who = net ? 'LAN match' : mode.kind === 'ladder' ? `Ladder: ${RIVALS[mode.i].name}` : mode.kind === 'daily' ? `Daily: ${MODS[mode.mod].name} vs ${RIVALS[mode.i].name}` : DIFFICULTY[diff].name + ' bot'
  $('endSub').textContent = `${replay ? 'Replay · ' : ''}${who} · ${clock(secs(game))}`
  $('endReport').innerHTML = replay ? '' : report(game, won) + livesChart()
  if (!replay && won && mode.kind === 'ladder' && mode.i > ladderBeaten()) {
    store.set('ladder', String(mode.i))
    $('endReport').innerHTML += `<p class="amber">${mode.i + 1 < RIVALS.length ? `Next rival unlocked: <b>${RIVALS[mode.i + 1].name}</b>` : 'You beat the whole ladder!'}</p>`
  }
  if (!replay && won && mode.kind === 'daily') {
    const best = Number(store.get('daily' + mode.day) ?? 1e9), t = Math.floor(secs(game))
    if (t < best) store.set('daily' + mode.day, String(t))
    $('endReport').innerHTML += `<p class="amber">${t < best ? 'New best for today' : `Today's best: ${clock(best)}`}</p>`
  }
  $('next').hidden = !(won && mode.kind === 'ladder' && mode.i + 1 < RIVALS.length) || !!net
  $('watch').hidden = !!net
  const a = game.lanes[ME], b = game.lanes[OPP]
  const rows: [string, (L: Lane) => string | number][] = [
    ['Core HP left', L => L.lives], ['Robots killed', L => L.stats.kills], ['Robots sent', L => L.stats.sent],
    ['Leaks taken', L => L.stats.leaksTaken], ['Income', L => `+${L.income}`],
    ['Gold on towers', L => L.stats.towerGold], ['Gold on sends', L => L.stats.sendGold],
  ]
  $('endStats').innerHTML = `<tr><td></td><td>You</td><td>${rival()}</td></tr>` + rows.map(([n, f]) => `<tr><td>${n}</td><td>${f(a)}</td><td>${f(b)}</td></tr>`).join('')
  $('end').hidden = false
  replay = null
  sfx.stopMusic(); sfx.stinger(won)
  world.shake(won ? 0.2 : 0.6)
}

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-diff]')) b.onclick = () => start(b.dataset.diff as keyof typeof DIFFICULTY)
$('again').onclick = () => {
  if (!net) return mode.kind === 'bot' ? start(diff) : play(bot!.st, mode)
  net.ws.send(JSON.stringify({ t: 'rematch' }))
  lobby('Waiting for your rival to accept the rematch…')
}

// --- LAN match -------------------------------------------------------------------

function lobby(text: string, showCancel = true) {
  $('lobbyText').textContent = text
  $('lobbyCancel').hidden = !showCancel
  $('menu').hidden = true; $('end').hidden = true; $('lobby').hidden = false
}
function closeNet() {
  if (!net) return
  const ws = net.ws
  net = null
  ws.onclose = null
  ws.close()
}
function toMenu() {
  closeNet()
  replay = null
  $('end').hidden = true; $('lobby').hidden = true; $('ladder').hidden = true; $('menu').hidden = false
  document.body.classList.add('menu'); g = null; startDemo(); sfx.stopMusic()
}
$('lanBtn').onclick = () => {
  sfx.unlockAudio()
  closeNet()
  let ws: WebSocket
  try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`) } catch { return lobby('Could not connect.') }
  net = { ws, queue: [], lastAt: performance.now() }
  lobby('Connecting to the LAN server…')
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (!net || net.ws !== ws) return
    if (m.t === 'seat') { ME = m.seat; OPP = 1 - m.seat }
    else if (m.t === 'waiting') lobby(m.players < 2 ? `You are player ${ME + 1}. Waiting for a second player to open ${location.host}…` : 'Waiting for your rival…')
    else if (m.t === 'full') { closeNet(); lobby('This LAN match already has two players.') }
    else if (m.t === 'start') { $('lobby').hidden = true; net.queue = []; begin(); toast(`LAN match: you are player ${ME + 1}`, 3000) }
    else if (m.t === 'tick') { net.queue.push({ n: m.n, cmds: m.cmds }); net.lastAt = performance.now() }
    else if (m.t === 'left') { sfx.stopMusic(); g = null; lobby('Your rival left the match. Waiting for them to come back…') }
  }
  ws.onclose = () => { if (net?.ws === ws) { net = null; g = null; lobby('No LAN server here. Start one with "npm run lan" on one computer and open the address it prints on both devices.') } }
}
if (import.meta.env.VITE_NO_LAN) $('lanBtn').remove() // static hosting (GitHub Pages) has no relay server
$('lobbyCancel').onclick = toMenu
$('watch').onclick = () => { $('end').hidden = true; startReplay() }
$('next').onclick = () => { if (mode.kind === 'ladder') play(RIVALS[mode.i + 1].st, { kind: 'ladder', i: mode.i + 1 }) }
$('ladderBtn').onclick = () => { renderLadder(); $('menu').hidden = true; $('ladder').hidden = false }
$('ladderBack').onclick = () => { $('ladder').hidden = true; $('menu').hidden = false }
function renderLadder() {
  const beaten = ladderBeaten(), d = daily(today()), best = store.get('daily' + d.day)
  $('rivals').innerHTML = RIVALS.map((r, i) => `<button data-rival="${i}" class="${i <= beaten ? 'alt' : ''}" ${i > beaten + 1 ? 'disabled' : ''}>${i + 1}. ${r.name}${i <= beaten ? ' ✓' : ''}<small>${i > beaten + 1 ? 'locked' : r.blurb}</small></button>`).join('') +
    `<p class="label" style="margin-top:14px">Daily challenge</p><button id="dailyBtn">${MODS[d.mod].name} vs ${RIVALS[d.i].name}<small>${MODS[d.mod].desc}${best ? ` · your best ${clock(+best)}` : ''}</small></button>`
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-rival]')) b.onclick = () => { $('ladder').hidden = true; const i = +b.dataset.rival!; play(RIVALS[i].st, { kind: 'ladder', i }) }
  $('dailyBtn').onclick = () => { $('ladder').hidden = true; play(RIVALS[d.i].st, { kind: 'daily', ...d }) }
}
$('toMenu').onclick = toMenu
$('pause').onclick = () => togglePause()
const MUTE = (m: boolean) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/>${m ? '<path d="M17 9l5 6M22 9l-5 6"/>' : '<path d="M17 8a5 5 0 0 1 0 8M19.5 5.5a9 9 0 0 1 0 13"/>'}</svg>`
for (const id of ['mute', 'menuMute']) {
  const b = $(id)
  b.innerHTML = MUTE(sfx.isMuted())
  b.onclick = () => { sfx.unlockAudio(); const m = sfx.toggleMute(); for (const x of ['mute', 'menuMute']) $(x).innerHTML = MUTE(m) }
}

// attract mode: two bots play behind the title screen
let demo: { g: Game; mems: BotMem[] } | null = null
function startDemo() { demo = { g: newGame(), mems: [newMem(), newMem()] } }
startDemo()
function togglePause() {
  if (!g || g.winner !== -1 || net) return
  paused = !paused
  $('pause').innerHTML = paused ? PLAY : PAUSE
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

const wide = () => innerWidth >= innerHeight * 1.1 // tablet landscape / desktop: both lanes side by side
const mainLane = () => (wide() ? ME : view)
const demoUi = (): UiState => ({ me: -1, focus: 0, layout: 'both', free: { x: 0, y: 0, w: innerWidth, h: innerHeight }, mini: null, sel: null, hover: null, buildKind: null, drag: [] })
function uiState(): UiState {
  const r = laneEl.getBoundingClientRect()
  const mw = Math.round(Math.min(90, r.width * 0.17)), mh = Math.round(mw * 20 / 11.6)
  // phone: the other lane is a mini-map in the top-right corner, where the far end of the board leaves room
  const free = { x: r.left, y: r.top, w: r.width, h: r.height }
  return {
    me: ME, focus: mainLane(), layout: wide() ? 'both' : 'single', free,
    mini: wide() ? null : { x: Math.round(r.right - mw - 2), y: Math.round(r.top + 8), w: mw, h: mh },
    sel, hover: buildKind && !sel ? hover : null, buildKind: sel ? null : buildKind, drag: drag ? drag.cells : [],
  }
}
/** pointer -> cell of my lane (null elsewhere) */
const cellAt = (e: PointerEvent) => {
  const c = world.pick(e.clientX, e.clientY, innerWidth, innerHeight)
  return c && c.lane === ME && mainLane() === ME ? { x: c.x, y: c.y } : null
}

laneEl.addEventListener('pointerdown', e => {
  sfx.unlockAudio()
  if (!g || e.button === 2) return
  if (world.inMini(e.clientX, e.clientY, uiState())) { view = 1 - view; sel = null; sfx.click(); renderPanel(true); return }
  const c = cellAt(e)
  if (!c) return
  const L = g.lanes[ME], i = c.y * COLS + c.x
  hover = c
  if (L.towers[i]) { // an existing tower: select it for upgrade / sell
    sel = sel && sel.x === c.x && sel.y === c.y ? null : c
    tab = 'build'
    sfx.click()
    return renderPanel(true)
  }
  sel = null
  if (!buildKind) { toast('Pick a tower first (1–6)'); sfx.deny(); tab = 'build'; return renderPanel(true) }
  if (!buildable(c.x, c.y)) { toast('Spawn and exit rows are not buildable'); sfx.deny(); return renderPanel(true) }
  drag = { cells: [i], last: i }
  laneEl.setPointerCapture(e.pointerId)
  renderPanel(true)
})

laneEl.addEventListener('pointermove', e => {
  if (!g) return
  const c = cellAt(e)
  hover = c && mainLane() === ME ? c : null
  if (!drag || !c) return
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
laneEl.addEventListener('pointerleave', () => { if (!drag) hover = null })
// right click leaves build mode on desktop
laneEl.addEventListener('contextmenu', e => { e.preventDefault(); if (drag) cancelDrag(); else stopBuilding() })

laneEl.addEventListener('pointerup', () => {
  if (!drag || !g || !buildKind) return
  const cells = drag.cells, kind = buildKind
  drag = null
  const L = g.lanes[ME], cost = TOWERS[kind].cost
  if (cells.length === 1) { // one click = one tower; sealing the lane needs a second click on the same cell
    const i = cells[0], x = i % COLS, y = Math.floor(i / COLS)
    const why = canBuild(L, x, y, kind)
    if (why) { toast(why); sfx.deny(); sealArmed = -1; return }
    if (wouldSeal(L, x, y) && sealArmed !== i) { sealArmed = i; toast('This seals your lane! Click again to build anyway', 2500); return }
    sealArmed = -1
    pending.push({ p: ME, t: 'build', x, y, kind })
    return
  }
  // a row: the picked tower along the drag, skipping any cell that would seal the lane
  const towers = L.towers.slice()
  let gold = L.gold, built = 0, skipped = 0
  for (const i of cells) {
    const x = i % COLS, y = Math.floor(i / COLS)
    if (gold < cost) break
    if (canBuild(L, x, y, kind) || wouldSeal(L, x, y, towers)) { skipped++; continue }
    towers[i] = { kind } as Tower
    gold -= cost
    pending.push({ p: ME, t: 'build', x, y, kind })
    built++
  }
  toast(`Row: ${built} ${TOWERS[kind].name}${built === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} (would seal or blocked)` : ''}${gold < cost && built < cells.length - skipped ? ', out of gold' : ''}`)
})

function cancelDrag() {
  if (!drag) return
  const n = drag.cells.length
  drag = null
  if (n > 1) toast(`Row cancelled (${n} towers)`)
}
function pickTower(k: TowerKind, toggle = true) {
  buildKind = toggle && buildKind === k ? null : k
  sel = null; sealArmed = -1; tab = 'build'; view = ME
  renderPanel(true)
}
function stopBuilding() {
  buildKind = null; sealArmed = -1
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
    case 'upgrade': if (sel) { const ok = !canUpgrade(L, sel.x, sel.y, arg); if (ok) { pending.push({ p: ME, t: 'upgrade', x: sel.x, y: sel.y, branch: arg }); sfx.upgrade() } else sfx.deny() } break
    case 'sell': if (sel) { pending.push({ p: ME, t: 'sell', x: sel.x, y: sel.y }); sel = null; sfx.sell() } break
    case 'load': if (canLoad(g, L, arg as RobotKind)) sfx.deny(); else { pending.push({ p: ME, t: 'load', kind: arg as RobotKind }); sfx.click() } break
    case 'release': if (canRelease(g, L)) sfx.deny(); else { pending.push({ p: ME, t: 'release' }); sfx.release() } break
    case 'pickFactory': selFactory = arg as RobotKind; sfx.click(); break
    case 'pick': return pickTower(arg as TowerKind)
    case 'stop': return stopBuilding()
    case 'factory': if (canFactory(L, selFactory)) sfx.deny(); else { pending.push({ p: ME, t: 'factory', kind: selFactory }); sfx.upgrade() } break
    case 'demolish': pending.push({ p: ME, t: 'demolish', kind: selFactory }); break
  }
  renderPanel(true)
}

let lastHtml = ''
function renderPanel(force = false) {
  if (!g) return
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab)
  const ready = readyCount(g.lanes[ME])
  const sendTab = document.querySelector<HTMLButtonElement>('[data-tab=send]')!, badge = ready ? `SEND <span class="badge">${ready}</span>` : 'SEND'
  if (sendTab.innerHTML !== badge) sendTab.innerHTML = badge
  const html = mainLane() !== ME ? opponentHtml(g, g.lanes[view]) : tab === 'build' ? buildHtml(g, g.lanes[ME]) : tab === 'send' ? sendHtml(g, g.lanes[ME]) : factoryHtml(g.lanes[ME])
  if (html !== lastHtml || force) { body.innerHTML = html; lastHtml = html }
}

const btn = (act: string, label: string, opts: { arg?: string; sub?: string; cls?: string; off?: boolean | string | null; icon?: string; color?: string; key?: string } = {}) =>
  `<button data-act="${act}" ${opts.arg ? `data-arg="${opts.arg}"` : ''} class="${opts.cls ?? ''}" ${opts.off ? 'disabled' : ''}>` +
  `${opts.icon ? `<span class="ic">${opts.icon}</span>` : ''}${label}${opts.key ? `<kbd>${opts.key}</kbd>` : ''}${opts.sub ? `<small>${opts.sub}</small>` : ''}</button>`

function buildHtml(g: Game, L: Lane): string {
  const t = sel && L.towers[sel.y * COLS + sel.x]
  if (!t) {
    const k = buildKind
    const msg = L.sealed ? '<span class="warn">Lane sealed: Breach mode! Income frozen, leaks cost double.</span>'
      : k ? `Building <b style="color:${hex(towerColor(k))}">${TOWERS[k].name}</b> · click for one, drag for a row`
      : 'Pick a tower to build · click a placed tower to upgrade or sell'
    return `<div class="info">${msg}</div><div class="grid six">` +
      TOWER_KINDS.map((x, i) => `<button data-act="pick" data-arg="${x}" class="pick ${x === k ? 'sel' : ''}" ${L.gold < TOWERS[x].cost && x !== k ? 'style="opacity:.45"' : ''}><span class="ic">${svgIcon(TOWER_ICON[x], towerColor(x), 20)}</span>${TOWERS[x].name}<span class="cost">${TOWERS[x].cost}g</span><kbd>${i + 1}</kbd></button>`).join('') +
      '</div>' + (k ? `<div class="row" style="margin-top:6px">${btn('stop', 'Stop building', { cls: 'alt', key: 'Esc' })}</div>` : radarHtml(L, 'Your defense'))
  }
  const st = towerStats(t), d = TOWERS[t.kind]
  const branch = t.branch ? d.branches.find(b => b.key === t.branch)!.name : ''
  const info = `<b style="color:${hex(towerColor(t.kind))}">${d.name}</b> L${t.level}${branch ? ` · ${branch}` : ''} · HP ${Math.ceil(t.hp / 1000)}/${Math.round(t.maxHp / 1000)} · ${Math.round(st.dps / 1000)} dps · range ${(st.rangeMc / 1000).toFixed(1)}`
  let up: string
  if (t.level === 1) up = btn('upgrade', `Upgrade ${upgradeCost(t)}`, { key: 'U', sub: '+60% dmg, +10% range', off: !!canUpgrade(L, t.x, t.y) })
  else if (t.level === 2) up = d.branches.map((b, i) => btn('upgrade', `${b.name} ${upgradeCost(t)}`, { arg: b.key, key: 'AB'[i], sub: b.desc, off: !!canUpgrade(L, t.x, t.y, b.key) })).join('')
  else up = btn('noop', 'Max level', { cls: 'alt', off: true })
  return `<div class="info">${info}</div><div class="info">${TOWER_ROLE[t.kind]}</div><div class="row">${up}${btn('sell', `Sell +${sellValue(t)}`, { cls: 'alt', key: 'S' })}</div>`
}

// threat radar: how much damage this lane does to each armor type, so a hole shows before it's punished
const THREATS: [Threat, string][] = [['light', 'LIGHT'], ['heavy', 'HEAVY'], ['shielded', 'SHIELD'], ['air', 'AIR']]
const BEST: Record<Threat, string> = { light: 'Kinetic', heavy: 'Explosive', shielded: 'Energy', air: 'Flak' }
function radarHtml(L: Lane, title: string) {
  const r = radar(L), weak = THREATS.map(([k]) => k).sort((a, b) => r[a] - r[b])[0]
  const any = r.light + r.heavy + r.shielded + r.air > 0
  return `<div class="radar"><span>${title}</span>` + THREATS.map(([k, n]) => `<i class="${any && k === weak ? 'weak' : ''}" title="${BEST[k]} beats ${n.toLowerCase()}"><b style="width:${Math.max(4, r[k])}%"></b>${n}</i>`).join('') + '</div>'
}

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
      arg: k, cls: 'tile', off: !!why, icon: svgIcon(ROBOT_ICON[k], robotColor(k), 18), key: 'QWERTYUI'[i],
      sub: lvl ? `${ROBOTS[k].sendCost}g · ${q}/${waveCap(k, lvl)}` : 'locked',
    })
  }).join('')
  return `<div class="info">${info}</div><div class="grid four">${tiles}</div><div class="row" style="margin-top:5px">${btn('release', `Release${ready ? ` ${ready}` : ''}`, { cls: 'go', off: !!canRelease(g, L), key: 'Space' })}</div>`
}

function factoryHtml(L: Lane): string {
  const k = selFactory, lvl = L.factories[k], r = ROBOTS[k]
  const tiles = ROBOT_KINDS.map(x => btn('pickFactory', short(x), {
    arg: x, cls: x === k ? 'tile sel' : 'tile', icon: svgIcon(ROBOT_ICON[x], robotColor(x), 18),
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
  return `<div class="info"><b class="warn">${rival().toUpperCase()} LANE</b> · ${L.lives} HP · <span class="cost">${L.gold}g</span> · <span class="inc">+${L.income}</span>/${INCOME_EVERY_S}s · ${towers} towers</div>` +
    radarHtml(L, 'Their defense') + `<div class="info">Factories: ${facts}</div><div class="info">Queued: ${L.queue.length} robots${L.sealed ? ' · <span class="warn">sealed!</span>' : ''}</div>` +
    `<div class="row">${btn('back', 'Back to my lane', { cls: 'alt' })}</div>`
}
body.addEventListener('pointerdown', e => { if ((e.target as HTMLElement).closest('[data-act="back"]')) { view = ME; renderPanel(true) } })

// --- keyboard ------------------------------------------------------------------

addEventListener('keydown', e => {
  if (!g || e.repeat) return
  const L = g.lanes[ME], k = e.key.toLowerCase()
  const t = sel && L.towers[sel.y * COLS + sel.x]
  // a direct shortcut also jumps to its tab, so you see what it did
  const tabFor = k >= '1' && k <= '6' || ((k === 'u' || k === 'a' || k === 'b' || k === 's') && t) ? 'build' : 'qwertyui '.includes(k) && k.length === 1 ? 'send' : k === 'f' ? 'factories' : null
  if (tabFor && tabFor !== tab) { tab = tabFor; view = ME; renderPanel(true) }
  if (k === 'h' || k === '?') toggleHelp()
  else if (k >= '1' && k <= '6') pickTower(TOWER_KINDS[+k - 1], false)
  else if (k === 'u' && t) act('upgrade')
  else if ((k === 'a' || k === 'b') && t && t.level === 2) act('upgrade', TOWERS[t.kind].branches[k === 'a' ? 0 : 1].key)
  else if (k === 's' && t) act('sell')
  else if ('qwertyui'.includes(k) && k.length === 1) act('load', ROBOT_KINDS['qwertyui'.indexOf(k)])
  else if (k === ' ') { e.preventDefault(); act('release') }
  else if (k === 'escape') {
    // one layer per press: help, then a row being dragged, then a selected tower, then build mode
    if (replay) toMenu()
    else if (!$('helpScreen').hidden) toggleHelp()
    else if (drag) cancelDrag()
    else if (sel) { sel = null; renderPanel(true) }
    else stopBuilding()
  }
  else if (k === 'p') togglePause()
})

// --- post-match report -----------------------------------------------------------

/** step the sim and record it (commands for replays, damage and 5 s samples for the report) */
function recStep(game: Game, cmds: Cmd[]) {
  if (replay) return step(game, cmds)
  if (cmds.length) rec.log.set(game.tick, cmds)
  step(game, cmds)
  for (const e of game.events) if (e.t === 'leak') rec.lost[e.p].set(e.kind, (rec.lost[e.p].get(e.kind) ?? 0) + e.dmg)
  if (game.tick % (INCOME_EVERY_S * TICK_HZ) === 0) game.lanes.forEach((L, i) => { rec.lives[i].push(L.lives); rec.income[i].push(L.income) })
}

function report(game: Game, won: boolean): string {
  const lost = (p: number) => [...rec.lost[p]].sort((a, b) => b[1] - a[1])
  const mine = lost(ME), theirs = lost(OPP)
  const big = won ? theirs[0] : mine[0]
  let head = ''
  if (big) {
    const k = big[0], a: Threat = ROBOTS[k].air ? 'air' : ROBOTS[k].armor
    head = won ? `Your ${ROBOTS[k].name}s did the most damage: ${big[1]} HP.`
      : `You lost ${big[1]} HP to ${ROBOTS[k].name}s (${a}). ${BEST[a]} beats them${radar(game.lanes[ME])[a] < 40 ? ', and you had little of it' : ''}.`
  }
  const row = (m: [RobotKind, number][]) => m.length ? m.map(([k, n]) => `${short(k)} ${n}`).join(' · ') : 'nothing'
  return `${head ? `<p><b>${head}</b></p>` : ''}<p class="small">Damage taken · you: ${row(mine)}<br>${rival()}: ${row(theirs)}</p>`
}

// lives (solid) and income (dashed) for both players over the match, from the 5 s samples
function livesChart(): string {
  const w = 300, h = 90, n = Math.max(2, rec.lives[0].length), maxInc = Math.max(1, ...rec.income.flat())
  const line = (v: number[], max: number) => v.map((y, i) => `${(i / (n - 1) * w).toFixed(1)},${(h - y / max * h).toFixed(1)}`).join(' ')
  const col = [hex(C.hazard), hex(C.rogue)]
  return `<svg viewBox="-2 -2 ${w + 4} ${h + 4}" class="chart" role="img" aria-label="Core HP and income over the match">` +
    [ME, OPP].map(p => `<polyline points="${line(rec.income[p], maxInc)}" fill="none" stroke="${col[p === ME ? 0 : 1]}" stroke-width="1" stroke-dasharray="3 3" opacity=".6"/><polyline points="${line(rec.lives[p], LIVES)}" fill="none" stroke="${col[p === ME ? 0 : 1]}" stroke-width="2"/>`).join('') +
    `</svg><p class="small"><span class="amber">You</span> vs <span class="warn">${rival()}</span> · solid: core HP · dashed: income</p>`
}

// --- loop ----------------------------------------------------------------------

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
let lastLives = [0, 0]
let hints = false
function hud(g: Game) {
  const L = g.lanes[ME], O = g.lanes[OPP], t = secs(g)
  $('lives').textContent = String(L.lives)
  $('gold').textContent = String(L.gold)
  $('income').textContent = `+${L.income}`
  const nextPay = Math.ceil(INCOME_EVERY_S - (t % INCOME_EVERY_S))
  $('incomeSub').textContent = L.sealed ? 'frozen!' : `in ${nextPay}s`
  $('incomeSub').dataset.s = L.sealed ? 'frozen' : `${nextPay}s`
  $('income').classList.toggle('frozen', L.sealed)
  $('tickFill').style.width = `${(t % INCOME_EVERY_S) / INCOME_EVERY_S * 100}%`
  $('tick').classList.toggle('frozen', L.sealed)
  $('olives').textContent = String(O.lives)
  $('ogold').textContent = String(O.gold)
  $('oincome').textContent = `+${O.income}`
  g.lanes.forEach((x, i) => {
    const el = $(i === ME ? 'meLives' : 'botLives')
    el.classList.toggle('low', x.lives <= LIVES / 4)
    if (x.lives < lastLives[i]) { el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit') }
    lastLives[i] = x.lives
  })
  $('clock').innerHTML = t < SEND.prepS ? `PREP <span class="amber">${Math.ceil(SEND.prepS - t)}</span>` : t >= SUDDEN.fromS ? `<span class="warn">SD</span> ${clock(t)}` : clock(t)
  const shown = g.lanes[mainLane()], inc = shown.incoming[0]
  if (inc) {
    const counts = new Map<RobotKind, number>()
    for (const r of inc.robots) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1)
    // counter hint: what beats most of this wave
    const by = new Map<string, number>()
    for (const r of inc.robots) { const a = ROBOTS[r.kind].air ? 'air' : ROBOTS[r.kind].armor; by.set(a, (by.get(a) ?? 0) + ROBOTS[r.kind].sendCost) }
    const main = [...by].sort((a, b) => b[1] - a[1])[0][0] as Threat
    const burst = inc.robots.length >= SEND.burstMin ? ' · OVERDRIVE' : ''
    banner.textContent = `${shown.p === ME ? 'INCOMING' : 'YOUR WAVE LANDS'} in ${Math.ceil((inc.at - g.tick) / TICK_HZ)}s: ` + [...counts].map(([k, n]) => `${n}× ${ROBOTS[k].name}`).join(', ') + burst + (shown.p === ME ? ` · ${BEST[main]} beats ${main === 'air' ? 'Drones' : main}` : '')
    banner.className = shown.p === ME ? '' : 'ours'
    banner.hidden = false
  } else banner.hidden = true
}

let acc = 0, lastFrame = performance.now()
const DT = 1000 / TICK_HZ
function frame(now: number) {
  requestAnimationFrame(frame)
  const dtMs = Math.min(100, now - lastFrame)
  lastFrame = now
  if (toastUntil && now > toastUntil) { toastEl.hidden = true; toastUntil = 0 }
  if (!g) {
    if (!demo) return world.renderer.clear()
    acc = Math.min(acc + dtMs, DT * 10)
    while (acc >= DT) {
      acc -= DT
      const d = demo.g
      prev = new Map(d.lanes.flatMap(L => L.robots.map(r => [r.id, { x: r.x, y: r.y }] as const)))
      step(d, [0, 1].flatMap(p => botThink(d, p, DIFFICULTY.hard, demo!.mems[p])))
      world.onStep(d, demoUi(), true)
      if (d.winner !== -1 || d.tick > 9 * 60 * TICK_HZ) startDemo()
    }
    world.render(demo.g, demoUi(), acc / DT, prev, dtMs / 1000, innerWidth, innerHeight)
    return
  }
  const ui = uiState()
  const running = !paused && g.winner === -1
  let stepped = false
  const one = (cmds: Cmd[]) => {
    const game = g!
    prev = new Map(game.lanes.flatMap(L => L.robots.map(r => [r.id, { x: r.x, y: r.y }] as const)))
    const wasSealed = game.lanes[ME].sealed
    recStep(game, cmds)
    stepped = true
    if (import.meta.env.DEV && game.tick % 100 === 0) ((window as unknown as { __h: Record<number, number> }).__h ??= {})[game.tick] = [...JSON.stringify(game.lanes)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)
    world.onStep(game, ui)
    after(game, wasSealed)
  }
  let alpha = 1
  if (net) {
    // LAN: send our commands, step on every tick packet (catch up if a few arrived at once)
    if (pending.length && net.ws.readyState === WebSocket.OPEN) net.ws.send(JSON.stringify({ t: 'cmds', cmds: pending }))
    pending = []
    for (let k = 0; k < 20 && net.queue.length && g.winner === -1; k++) one(net.queue.shift()!.cmds)
    alpha = Math.min(1, (now - net.lastAt) / DT)
  } else {
    if (running) acc = Math.min(acc + dtMs * (replay ? 4 : 1), DT * 40) // don't spiral after a background tab
    while (running && acc >= DT && g.winner === -1) {
      acc -= DT
      if (replay) { pending = []; one(replay.log.get(g.tick) ?? []) }
      else { one([...pending, ...botThink(g, OPP, bot!.st, bot!.mem)]); pending = [] }
    }
    alpha = running ? acc / DT : 1
  }
  if (stepped) { hud(g); renderPanel() }
  world.render(g, ui, alpha, prev, dtMs / 1000, innerWidth, innerHeight)
  adapt(dtMs)
}

/** toasts and sounds after one sim step */
function after(g: Game, wasSealed: boolean) {
  {
    for (const e of g.events) if (e.t === 'wave' && e.p === ME) toast(secs(g) >= SUDDEN.fromS ? `Sudden death wave ${e.n + 1}!` : `Neutral wave ${e.n + 1}`)
    if (!wasSealed && g.lanes[ME].sealed) { toast('Lane sealed! Breach mode', 2500); sfx.alarm() }
    if (g.tick === SEND.prepS * TICK_HZ) toast(hints ? 'Sending unlocked! Open SEND, load Scouts, press Release. Every robot you send raises your income.' : 'Sending unlocked!', hints ? 6000 : 1800)
    if (hints && g.tick === 3 * TICK_HZ) toast('Pick a tower, then tap cells: robots take the shortest path, so make it long', 6000)
    if (hints && g.tick === 70 * TICK_HZ) { toast('Watch the bars under BUILD: red is your weak armor type, and the bot will hit it', 6000); hints = false }
    if (g.tick === SUDDEN.fromS * TICK_HZ) { toast('Sudden death: waves every 15 s', 3000); sfx.setIntense(true) }
    if (g.winner !== -1) end(g)
  }
}

// slow device? drop the render resolution step by step (never below 1x CSS pixels)
let slowFrames = 0
function adapt(dtMs: number) {
  slowFrames = dtMs > 28 ? slowFrames + 1 : Math.max(0, slowFrames - 1)
  const pr = world.renderer.getPixelRatio()
  if (slowFrames > 90 && pr > 1) { world.renderer.setPixelRatio(Math.max(1, pr - 0.5)); size(); slowFrames = 0 }
}
requestAnimationFrame(frame)

// ?play=easy|normal|hard skips the menu
const q = new URLSearchParams(location.search).get('play')
if (q && q in DIFFICULTY) start(q as keyof typeof DIFFICULTY)

if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js')
// dev console hook: game() returns live state
if (import.meta.env.DEV) Object.assign(window, {
  game: () => g, cmd: (c: Cmd) => pending.push(c), world,
  // ff(seconds, true) fast-forwards with a Normal bot playing for you too
  ff: (s: number, auto = false) => { const me = newMem(); for (let i = 0; i < s * TICK_HZ && g && g.winner === -1; i++) { recStep(g, [...pending, ...(auto ? botThink(g, ME, DIFFICULTY.normal, me) : []), ...botThink(g, OPP, bot!.st, bot!.mem)]); pending = [] } if (g) { hud(g); renderPanel(true); if (g.winner !== -1) end(g) } },
})
