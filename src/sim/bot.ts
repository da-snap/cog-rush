// Bot player: reads the game state and returns ordinary commands, exactly like a human's input.
// Deterministic (no randomness), so headless bot-vs-bot runs are reproducible.
import { ARMOR_MULT_PCT, COLS, MAX_LEVEL, ROBOTS, ROWS, SEND, TICK_HZ, TOWERS, type Armor, type RobotKind, type TowerKind } from './config.ts'
import {
  INF, SPAWN, buildable, canBuild, maxLevel, canFactory, canLoad, canRelease, canUpgrade, factoryCost, factoryLevel, factoryOf, opponent, pathFrom, pathLen,
  readyCount, secs, sellValue, towerStats, upgradeCost, type Cmd, type Game, type Lane, type Tower,
} from './sim.ts'

export interface Strategy {
  name: string
  delay: number // reaction delay in ticks
  defense: number // share of spending on towers, 0..100; -1 = adaptive
  factories: RobotKind[] // build order for the 3 free slots (slot 1 is the Scout factory)
  burst: number // release when this many robots are ready (1 = trickle)
  counter: boolean // pick towers by incoming armor and sends by the opponent's weak spot
  sends?: RobotKind[] // only send these (default: anything unlocked)
  maze: Maze // how it shapes its lane with Walls (mazing pass 2026-11-16)
  wallPct?: number // at most this share of tower gold goes into Walls (default 30)
  saveAt?: number // from this second on, stop sending to save up for the next planned factory (default 120, the sweet spot in run.ts sweeps)
  upgradeAt?: number // seconds before factory upgrades start (default 240)
}

// open: no Walls, guns where they cover the most path (what mazing has to beat).
// greedy: adapts to the lane: the next Wall row (any height, gap anywhere) that adds the most path per Wall.
// serpent: full-width Wall rows with alternating gaps, guns built on the rows so they cover two corridors.
// killbox: a few anchor guns in mid-lane pushed to L4, Wall rows where the path stays longest in their range.
export type Maze = 'open' | 'greedy' | 'serpent' | 'killbox'

export const DIFFICULTY: Record<'easy' | 'normal' | 'hard', Strategy> = {
  easy: { name: 'Easy', delay: 60, defense: 80, factories: ['tank'], burst: 1, counter: false, maze: 'open', saveAt: INF },
  normal: { name: 'Normal', delay: 30, defense: 45, factories: ['tank', 'drone', 'shield'], burst: 4, counter: true, maze: 'serpent' },
  hard: { name: 'Hard', delay: 10, defense: -1, factories: ['tank', 'drone', 'splitter'], burst: 8, counter: true, maze: 'greedy' },
}

// Bot ladder: named rivals, each one a strategy with a clear counter, ordered from easy to hard.
export const RIVALS: { name: string; blurb: string; st: Strategy }[] = [
  { name: 'Sprocket', blurb: 'Trickles Tanks one by one. Learn to maze.', st: DIFFICULTY.easy },
  { name: 'Ironside', blurb: 'Turtles behind a thick wall. Out-send it.', st: { name: 'Ironside', delay: 40, defense: 85, factories: ['tank', 'shield'], burst: 3, counter: true, maze: 'serpent', wallPct: 40 } },
  { name: 'Bolt', blurb: 'Floods you with Scouts. Kinetic beats Light.', st: { name: 'Bolt', delay: 35, defense: 55, factories: [], sends: ['scout'], burst: 12, counter: true, maze: 'serpent' } },
  { name: 'Skyhook', blurb: 'Drones fly over your maze. Build Flak.', st: { name: 'Skyhook', delay: 30, defense: 55, factories: ['drone'], sends: ['drone', 'scout'], burst: 6, counter: true, maze: 'killbox' } },
  { name: 'Hive', blurb: 'Splitters with Shield and Repair escorts. EMP jams them.', st: { name: 'Hive', delay: 25, defense: 55, factories: ['splitter', 'shield', 'repair'], sends: ['splitter', 'shield', 'repair', 'scout'], burst: 8, counter: true, maze: 'greedy' } },
  { name: 'Crusher', blurb: 'Tanks, Breakers, then a Colossus. Explosive beats Heavy.', st: { name: 'Crusher', delay: 20, defense: 55, factories: ['tank', 'breaker', 'colossus'], sends: ['tank', 'breaker', 'colossus', 'scout'], burst: 5, counter: true, maze: 'killbox' } },
  { name: 'Blitz', blurb: 'All-in sender with a thin maze. Punish it, then race it.', st: { name: 'Blitz', delay: 15, defense: 35, factories: ['tank'], burst: 6, counter: true, maze: 'greedy', wallPct: 15 } },
  { name: 'Overmind', blurb: 'Reads your defense and hits the weakest spot.', st: { ...DIFFICULTY.hard, name: 'Overmind' } },
]

export interface BotMem { seen: Map<number, RobotKind>; armor: Record<Armor, number>; air: number; leaksAt: number[]; leaks: { at: number; kind: RobotKind }[]; lastRelease: number; plan: number[] }
export const newMem = (): BotMem => ({ seen: new Map(), armor: { light: 0, heavy: 0, shielded: 0 }, air: 0, leaksAt: [], leaks: [], lastRelease: 0, plan: [] })

export function botThink(g: Game, p: number, st: Strategy, mem: BotMem): Cmd[] {
  const L = g.lanes[p], O = g.lanes[opponent(g, p)]
  // memory: what has come at us, sent or neutral (counted once per robot)
  for (const r of L.robots) {
    if (mem.seen.has(r.id)) continue
    mem.seen.set(r.id, r.kind)
    const w = ROBOTS[r.kind].sendCost
    if (ROBOTS[r.kind].air) mem.air += w
    else mem.armor[ROBOTS[r.kind].armor] += w
  }
  for (const e of g.events) if (e.t === 'leak' && e.p === p) { mem.leaksAt.push(g.tick); mem.leaks.push({ at: g.tick, kind: mem.seen.get(e.robot) ?? 'scout' }) }
  if (g.tick % st.delay !== p % st.delay || L.lives <= 0) return []

  const cmds: Cmd[] = []
  const t = secs(g)
  const recentLeaks = mem.leaksAt.filter(x => x > g.tick - 30 * TICK_HZ).length
  const share = st.defense >= 0 ? st.defense : Math.min(85, 25 + recentLeaks * 8 + (L.sealed ? 30 : 0)) // fun plan: sending pays, so Hard leans on offense
  const spent = L.stats.towerGold + L.stats.sendGold
  // saving up for the next planned factory: towers only when leaking (else the defense share eats the savings)
  const plan = st.factories.find(k => !factoryOf(L, k) && (k !== 'colossus' || t >= 300 - FACTORY_LEAD_S))
  const saving = !!plan && L.slots.includes(null) && t > 50 && t >= (st.saveAt ?? 120) * (L.slots.filter(f => f && f.kind !== 'scout').length + 1) && L.gold < ROBOTS[plan].factoryCost
  const wantDefense = (L.stats.towerGold * 100 <= share * spent && !saving) || recentLeaks > 2 || t < SEND.prepS

  // release whatever is ready once the burst size is reached (or the wave is full)
  const ready = readyCount(L)
  const full = L.slots.every((f, i) => !f || canLoad(g, L, i) !== null && canLoad(g, L, i) !== 'Not enough gold') // nothing more fits in any queue
  if (!canRelease(g, L) && (ready >= st.burst || full || g.tick - mem.lastRelease > 25 * TICK_HZ)) {
    cmds.push({ p, t: 'release' })
    mem.lastRelease = g.tick
  }

  const c = wantDefense ? defend(L, O, st, mem, t, g.tick, g.sendHpBp / 10000) : null
  const s = c ? [] : send(g, L, O, st)
  const d = c ?? (!s.length && !saving && L.gold > 300 ? defend(L, O, st, mem, t, g.tick, g.sendHpBp / 10000) : null) // nothing to send: don't sit on gold
  for (const x of d ? [d].flat() : []) cmds.push({ p, ...x } as Cmd)
  cmds.push(...s.map(x => ({ p, ...x }) as Cmd))
  return cmds
}

type C = Cmd extends infer T ? T extends Cmd ? Omit<T, 'p'> : never : never

export type Threat = 'light' | 'heavy' | 'shielded' | 'air'
const COUNTER: Record<Threat, TowerKind> = { light: 'gatling', heavy: 'mortar', shielded: 'tesla', air: 'flak' }

// What is coming at us: robots seen so far plus the opponent's factories (full visibility).
function threats(O: Lane, mem: BotMem): Record<Threat, number> {
  const w: Record<Threat, number> = { light: mem.armor.light + 50, heavy: mem.armor.heavy, shielded: mem.armor.shielded, air: mem.air }
  for (const f of O.slots) if (f && f.kind !== 'scout') w[ROBOTS[f.kind].air ? 'air' : ROBOTS[f.kind].armor] += 150 * f.level
  return w
}

// Threat radar for the HUD: the lane's damage against each threat, 0..100 relative to its strongest one.
export function radar(L: Lane): Record<Threat, number> {
  const c = coverageByThreat(L.towers.filter((x): x is Tower => !!x), new Set(pathFrom(L.openDist, L.towers)))
  const max = Math.max(c.light, c.heavy, c.shielded, c.air, 2)
  return { light: Math.round(100 * (c.light - 1) / max), heavy: Math.round(100 * (c.heavy - 1) / max), shielded: Math.round(100 * (c.shielded - 1) / max), air: Math.round(100 * (c.air - 1) / max) }
}

// Our damage against each threat: dps times how many cells of that threat's route each tower reaches.
const AIR_PATH = new Set(Array.from({ length: ROWS }, (_, y) => y * COLS + (COLS - 1) / 2)) // Drones fly straight down
function coverageByThreat(towers: Tower[], ground: Set<number>): Record<Threat, number> {
  const c: Record<Threat, number> = { light: 1, heavy: 1, shielded: 1, air: 1 }
  for (const x of towers) {
    const d = TOWERS[x.kind], st = towerStats(x)
    if (d.ground) {
      const n = coverage(x.x, x.y, st.rangeMc, ground)
      for (const a of ['light', 'heavy', 'shielded'] as const) c[a] += st.dps * n * ARMOR_MULT_PCT[d.dmg][a] / 100
    }
    if (d.air) c.air += st.dps * coverage(x.x, x.y, st.rangeMc, AIR_PATH) * ARMOR_MULT_PCT[d.dmg].light / 100
  }
  return c
}

function defend(L: Lane, O: Lane, st: Strategy, mem: BotMem, t: number, tick: number, hpScale: number): C | C[] | null {
  if (L.gold < TOWERS.wall.cost) return null
  const towers = L.towers.filter((x): x is Tower => !!x)
  const guns = towers.filter(x => x.kind !== 'wall'), walls = towers.length - guns.length
  const cur = pathLen(L.towers)
  const pathSet = new Set(pathFrom(L.openDist, L.towers))

  // which threat is least covered relative to how big it is
  // what leaked lately decides; otherwise match our damage mix to the threat mix
  const leaked: Record<Threat, number> = { light: 0, heavy: 0, shielded: 0, air: 0 }
  for (const l of mem.leaks) if (l.at > tick - 45 * TICK_HZ) leaked[ROBOTS[l.kind].air ? 'air' : ROBOTS[l.kind].armor]++
  // how well each threat is covered: damage one robot takes crossing our lane vs. the HP of a small wave of it
  const th = threats(O, mem), cov = coverageByThreat(towers, pathSet)
  const scale = hpScale * SEND.hpPct / 100
  const TYPICAL: Record<Threat, { hp: number; speed: number }> = { light: { hp: 70, speed: 2 }, heavy: { hp: 400, speed: 0.8 }, shielded: { hp: 220, speed: 1 }, air: { hp: 120, speed: 1.4 } }
  const ratio = (x: Threat) => th[x] < 100 ? INF : cov[x] / TYPICAL[x].speed / (TYPICAL[x].hp * 1000 * scale * 4)
  const need = (['light', 'heavy', 'shielded', 'air'] as Threat[]).sort((a, b) => (ratio(a) - leaked[a] * 1e6) - (ratio(b) - leaked[b] * 1e6))[0]

  // maze first: Walls as soon as two guns stand, up to 150 g or the Wall share (air leaks: guns, Walls don't stop Drones)
  const wallGold = walls * TOWERS.wall.cost
  const c = st.maze !== 'open' && guns.length >= 2 && need !== 'air' && (wallGold < 150 || wallGold * 100 <= (st.wallPct ?? 30) * L.stats.towerGold) ? nextWall(L, st.maze, guns, mem) : -1
  if (c >= 0) return { t: 'build', x: c % COLS, y: (c / COLS) | 0, kind: 'wall' }

  let kind: TowerKind
  if (st.counter) {
    kind = COUNTER[need]
    if (need === 'light' && t > 300 && guns.filter(x => x.kind === 'laser').length < 2) kind = 'laser'
    if (need === 'shielded' && guns.filter(x => x.kind === 'tesla').length > 3) kind = 'laser'
    if (guns.length > 12 && !guns.some(x => x.kind === 'emp')) kind = 'emp'
    // aura swarm coming: EMP jams Repair/Shield bots and strips shields
    const auras = factoryLevel(O, 'repair') + factoryLevel(O, 'shield')
    if (auras && guns.filter(x => x.kind === 'emp').length < 1 + (auras >> 1)) kind = 'emp'
  } else {
    kind = (['gatling', 'mortar', 'tesla'] as TowerKind[])[guns.length % 3]
  }
  if (guns.length < 2) kind = need === 'air' ? 'flak' : 'gatling' // cheap start, the first neutral waves are Scouts

  // upgrade the best-placed gun that fights what's coming; a killbox pours everything into its anchors
  const fits = (x: Tower) => {
    const d = TOWERS[x.kind]
    if (need === 'air') return d.air ? 100 : 0
    return d.ground ? ARMOR_MULT_PCT[d.dmg][need] : 0
  }
  const upFrom = st.maze === 'killbox' ? ANCHORS.length : 5
  if (guns.length >= upFrom) {
    const best = guns
      .filter(x => x.level < maxLevel(x.kind))
      .map(x => ({ x, score: coverage(x.x, x.y, towerStats(x).rangeMc, need === 'air' ? AIR_PATH : pathSet) * fits(x) * (st.maze === 'killbox' && isAnchor(x) ? 3 : 50 / upgradeCost(x)) })) // per gold, except a killbox's anchors
      .sort((a, b) => b.score - a.score || a.x.id - b.x.id)[0]
    if (best && best.score > 300) {
      const branch = pickBranch(best.x.kind, need)
      if (!canUpgrade(L, best.x.x, best.x.y, branch)) return { t: 'upgrade', x: best.x.x, y: best.x.y, branch }
      if (L.gold < upgradeCost(best.x) && guns.length >= upFrom + 4) return null // save up for it
    }
  }

  // place a gun: a killbox fills its anchor cells first, a serpent only builds on its Wall rows
  const range = TOWERS[kind].rangeMc
  const route = kind === 'flak' ? AIR_PATH : pathSet
  const anchor = st.maze === 'killbox' && need !== 'air' ? ANCHORS.find(([x, y]) => !canBuild(L, x, y, kind) && (L.towers[y * COLS + x] || !seals(L, y * COLS + x))) : undefined // empty or a Wall
  if (anchor) return { t: 'build', x: anchor[0], y: anchor[1], kind }
  let bestCell = -1, bestScore = -INF
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (!buildable(x, y) || canBuild(L, x, y, kind)) continue
    const i = y * COLS + x
    const onWall = !!L.towers[i]
    if (st.maze === 'serpent' && !onWall && !SERPENT_SET.has(i)) continue
    let gain = 0
    if (!onWall) {
      L.towers[i] = { id: 0 } as Tower
      const len = pathLen(L.towers)
      L.towers[i] = null
      if (len >= INF) continue // never seal
      gain = len - cur
    }
    const cover = coverage(x, y, range, route)
    const score = st.maze === 'open' ? cover * 10 : cover * 10 + gain * 20 + (onWall ? 5 : 0)
    if (score > bestScore) { bestScore = score; bestCell = i }
  }
  // lane full: swap a level-1 gun that's weak against what's coming for one that counters it (same cell, maze unchanged)
  if (bestCell < 0 && st.counter) {
    const swap = guns
      .filter(x => x.level === 1 && x.kind !== kind && fits(x) <= 50)
      .sort((a, b) => coverage(b.x, b.y, range, route) - coverage(a.x, a.y, range, route) || a.id - b.id)[0]
    if (swap && L.gold + sellValue(swap) >= TOWERS[kind].cost) return [{ t: 'sell', x: swap.x, y: swap.y }, { t: 'build', x: swap.x, y: swap.y, kind }]
  }
  if (bestCell < 0) return null
  return { t: 'build', x: bestCell % COLS, y: (bestCell / COLS) | 0, kind }
}

// --- mazing ----------------------------------------------------------------

const ANCHORS = [[5, 7], [5, 12], [2, 10], [8, 10]]
const isAnchor = (t: Tower) => ANCHORS.some(([x, y]) => t.x === x && t.y === y)
// serpent rows: Walls across the lane every third row, the gap alternating sides, so the path runs ~5 full widths
const SERPENT: number[] = [4, 7, 10, 13, 16].flatMap((y, k) => Array.from({ length: COLS - 1 }, (_, j) => y * COLS + (k % 2 ? COLS - 1 - j : j)))
const SERPENT_SET = new Set(SERPENT)

const seals = (L: Lane, i: number) => { L.towers[i] = { id: 0 } as Tower; const s = pathLen(L.towers) >= INF; L.towers[i] = null; return s }

// Shortest 4-way route spawn → exit (null if sealed), the same metric as pathLen.
function route(towers: (Tower | null)[]): number[] | null {
  const from = new Int16Array(COLS * ROWS).fill(-1)
  const q = [SPAWN]
  from[SPAWN] = SPAWN
  for (let h = 0; h < q.length; h++) {
    const c = q[h], x = c % COLS, y = (c / COLS) | 0
    if (y === ROWS - 1) { const out = [c]; for (let k = c; k !== SPAWN; k = from[k]) out.push(from[k]); return out }
    for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
      const nx = x + dx, ny = y + dy, n = ny * COLS + nx
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS || from[n] >= 0 || towers[n]) continue
      from[n] = c
      q.push(n)
    }
  }
  return null
}

// The next Wall for this maze style, -1 when the maze is done (or nothing helps).
function nextWall(L: Lane, maze: Maze, guns: Tower[], mem: BotMem): number {
  const free = (i: number) => buildable(i % COLS, (i / COLS) | 0) && !canBuild(L, i % COLS, (i / COLS) | 0, 'wall')
  if (maze === 'serpent') {
    for (const i of SERPENT) if (free(i) && !seals(L, i)) return i
    return -1
  }
  // finish the segment we started, unless the lane changed under it
  while (mem.plan.length) { const i = mem.plan.shift()!; if (free(i) && !seals(L, i)) return i }
  // value of a route: its length, plus (killbox) the steps it spends inside our guns' range
  const w = new Float64Array(COLS * ROWS).fill(1)
  if (maze === 'killbox') for (const g of guns) {
    const r = towerStats(g).rangeMc
    for (let i = 0; i < w.length; i++) {
      const dx = ((i % COLS) - g.x) * 1000, dy = (((i / COLS) | 0) - g.y) * 1000
      if (dx * dx + dy * dy <= r * r) w[i] += isAnchor(g) ? 2 * g.level : 0.5
    }
  }
  const value = (p: number[] | null) => { if (!p) return -INF; let v = 0; for (const i of p) v += w[i]; return v }
  const base = route(L.towers)!, cur = value(base)
  // one Wall rarely lengthens a path, a barrier does: try a Wall row across the lane at every height with the gap
  // at every column, built around whatever already stands there; best gain per new Wall wins.
  let best: number[] = [], bestV = 0
  for (let y = 2; y < ROWS - 2; y++) for (let gap = 0; gap < COLS; gap++) {
    const seg: number[] = []
    for (let x = 0; x < COLS; x++) if (x !== gap && !L.towers[y * COLS + x]) seg.push(y * COLS + x)
    if (!seg.length || L.towers[y * COLS + gap] || seg.some(i => !free(i))) continue
    for (const i of seg) L.towers[i] = { id: 0 } as Tower
    const v = (value(route(L.towers)) - cur) / seg.length
    for (const i of seg) L.towers[i] = null
    if (v > bestV + 0.01) { bestV = v; best = seg.sort((a, b) => Math.abs((b % COLS) - gap) - Math.abs((a % COLS) - gap)) } // far end first
  }
  mem.plan = best.slice(1)
  return best.length ? best[0] : -1
}

const coverage = (x: number, y: number, rangeMc: number, path: Set<number>) => {
  let n = 0
  for (const c of path) {
    const dx = ((c % COLS) - x) * 1000, dy = (((c / COLS) | 0) - y) * 1000
    if (dx * dx + dy * dy <= rangeMc * rangeMc) n++
  }
  return n
}

function pickBranch(kind: TowerKind, need: Threat): string {
  switch (kind) {
    case 'wall': return ''
    case 'gatling': return need === 'light' || need === 'air' ? 'overdrive' : 'pierce'
    case 'flak': return 'shrapnel'
    case 'mortar': return need === 'heavy' ? 'burn' : 'cluster'
    case 'tesla': return need === 'light' ? 'chain5' : 'arcFocus'
    case 'laser': return need === 'heavy' ? 'melt' : 'wide'
    case 'emp': return 'overload'
  }
}

function send(g: Game, L: Lane, O: Lane, st: Strategy): C[] {
  const t = secs(g)
  // factories from the plan into the free slots, one at a time. No saving up: gold piles up once the
  // factories we have can't turn it into robots fast enough, and that is the moment a new factory pays off.
  const free = L.slots.indexOf(null)
  const next = st.factories.find(k => !factoryOf(L, k) && (k !== 'colossus' || t >= 300 - FACTORY_LEAD_S))
  if (next && free >= 0 && t > 50) {
    if (!canFactory(L, free, next)) return [{ t: 'factory', slot: free, kind: next }]
    const built = L.slots.filter(f => f && f.kind !== 'scout').length
    if (t >= (st.saveAt ?? 120) * (built + 1)) return [] // first at 2:00, then 4:00, 6:00
  }
  if (!next && t > (st.upgradeAt ?? 240)) { // plan done: upgrade plan factories in order, the Scout factory last
    const up = L.slots.map((f, i) => ({ f, i })).filter(({ f, i }) => f && !canFactory(L, i) && L.gold > factoryCost(L, i) * 1.5 && (f.kind !== 'scout' || !st.sends || st.sends.includes('scout')))
      .sort((a, b) => Number(a.f!.kind === 'scout') - Number(b.f!.kind === 'scout') || a.i - b.i)[0]
    if (up) return [{ t: 'factory', slot: up.i }]
  }

  // what does the opponent's defense deal to each robot type? send what survives best per gold
  const opp = O.towers.filter((x): x is Tower => !!x).map(x => ({ def: TOWERS[x.kind], dps: towerStats(x).dps }))
  const value = (k: RobotKind) => {
    const r = ROBOTS[k]
    let dps = 1
    for (const o of opp) if (r.air ? o.def.air : o.def.ground) dps += o.dps * ARMOR_MULT_PCT[o.def.dmg][r.armor] / 100
    return (r.hp * 1e6) / dps / r.sendCost
  }
  const slots = L.slots.map((f, i) => ({ k: f?.kind, i })).filter(x => !canLoad(g, L, x.i) && (!st.sends || st.sends.includes(x.k!)))
  if (!slots.length) return []
  const pick = st.counter ? slots.sort((a, b) => value(b.k!) - value(a.k!) || a.i - b.i)[0] : slots[slots.length - 1]
  return [{ t: 'load', slot: pick.i }]
}
const FACTORY_LEAD_S = 30 // start the Colossus factory so it is ready when the 5:00 gate opens
