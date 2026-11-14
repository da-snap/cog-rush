// Deterministic match sim: fixed 20 Hz tick, integer math, input is a list of commands per tick.
// Engine-independent: no DOM, no Pixi, no Math.random. One Lane per player; sends go to the next lane in the ring.
import {
  ARMOR_MULT_PCT, AURA, BRANCH, BREACH, COLS, EXIT_ROWS, FACTORY, FIRST_WAVE_S, INCOME_EVERY_S, LIVES, MC, ROBOTS, ROWS,
  SELL_REFUND_PCT, SEND, SPAWN_ROWS, START_GOLD, START_INCOME, SUDDEN, TICK_HZ, TOWERS, UPGRADE,
  WAVE_EVERY_S, WAVE_HP_GROWTH_PCT, neutralWave, type DamageType, type RobotKind, type TowerDef, type TowerKind,
} from './config.ts'

export const INF = 2 ** 30
export type Cmd = { p: number } & (
  | { t: 'build'; x: number; y: number; kind: TowerKind }
  | { t: 'sell'; x: number; y: number }
  | { t: 'upgrade'; x: number; y: number; branch?: string }
  | { t: 'load'; kind: RobotKind }
  | { t: 'release' }
  | { t: 'factory'; kind: RobotKind } // build or upgrade
  | { t: 'demolish'; kind: RobotKind }
)
export type FxKind = 'line' | 'boom' | 'pulse' | 'beam'
export type Ev = { p: number } & (
  | { t: 'fx'; k: FxKind; tower: TowerKind; x1: number; y1: number; x2: number; y2: number; r: number }
  | { t: 'kill'; robot: number }
  | { t: 'leak'; robot: number; kind: RobotKind; owner: number; dmg: number }
  | { t: 'towerLost'; tower: number }
  | { t: 'wave'; n: number }
  | { t: 'released'; kinds: RobotKind[] } // p = target lane
)

export interface Tower {
  id: number; kind: TowerKind; x: number; y: number; hp: number; maxHp: number; invested: number
  level: number; branch: string | null
  target: number; cd: number; pulse: number; melt: number
}
export interface Robot {
  id: number; kind: RobotKind; owner: number // -1 = neutral
  x: number; y: number; cx: number; cy: number; hp: number; maxHp: number
  wp: number // cell it steers for, -1 = pick again (maze changed)
  shield: number; gotShield: boolean
  slow: number; stun: number; amp: number; jam: boolean // status, refreshed every tick by EMPs
}
export interface Burn { x: number; y: number; ticks: number; dmg: number }
export interface Spawn { kind: RobotKind; hp: number; owner: number; shield?: number }
export interface Lane {
  p: number; gold: number; income: number; lives: number
  towers: (Tower | null)[] // by cell index y*COLS+x
  robots: Robot[]; burns: Burn[]
  openDist: number[]; breachDist: number[]; sealed: boolean
  factories: Record<RobotKind, number> // level, 0 = not built
  queue: { kind: RobotKind; left: number }[] // build ticks left, 0 = ready to release
  incoming: { at: number; robots: Spawn[] }[] // released at us, visible before they spawn
  spawnQueue: Spawn[]
  released: number // gold of robots released, drives income
  stats: { sent: number; leaksTaken: number; kills: number; towerGold: number; sendGold: number; income: number[] }
}
export interface Game {
  tick: number; lanes: Lane[]; nextId: number
  wave: number; nextWaveTick: number; waveHpBp: number; sendHpBp: number
  winner: number // -1 running, -2 draw, else lane index
  events: Ev[] // events from the last step only
}

const idx = (x: number, y: number) => y * COLS + x
const inLane = (x: number, y: number) => x >= 0 && x < COLS && y >= 0 && y < ROWS
export const buildable = (x: number, y: number) => x >= 0 && x < COLS && y >= SPAWN_ROWS && y < ROWS - EXIT_ROWS
const center = (c: number) => c * MC + MC / 2
const DIRS = [[0, 1], [-1, 0], [1, 0], [0, -1]] // fixed order = deterministic tie-break, prefers "down"
const DIRS8 = [...DIRS, [-1, 1], [1, 1], [-1, -1], [1, -1]]
const DIAG = 1414 // sqrt(2) * MC
// a diagonal step may not cut a tower's corner (so 8-way and 4-way connectivity agree, and wouldSeal stays 4-way)
const diagOk = (towers: (Tower | null)[], x: number, y: number, dx: number, dy: number) => !dx || !dy || (!towers[idx(x + dx, y)] && !towers[idx(x, y + dy)])
const towerCost = (t: Tower | null) => t ? Math.floor(t.hp / BREACH.hpCostPer) : 0
export const opponent = (g: Game, p: number) => (p + 1) % g.lanes.length
export const secs = (g: Game) => g.tick / TICK_HZ

export function newLane(p: number): Lane {
  const L: Lane = {
    p, gold: START_GOLD, income: START_INCOME, lives: LIVES,
    towers: Array(COLS * ROWS).fill(null), robots: [], burns: [],
    openDist: [], breachDist: [], sealed: false,
    factories: { scout: 1, drone: 0, repair: 0, shield: 0, tank: 0, splitter: 0, breaker: 0, colossus: 0 },
    queue: [], incoming: [], spawnQueue: [], released: 0,
    stats: { sent: 0, leaksTaken: 0, kills: 0, towerGold: 0, sendGold: 0, income: [START_INCOME] },
  }
  recompute(L)
  return L
}

export function newGame(players = 2): Game {
  return {
    tick: 0, lanes: Array.from({ length: players }, (_, p) => newLane(p)), nextId: 1,
    wave: 0, nextWaveTick: FIRST_WAVE_S * TICK_HZ, waveHpBp: 10000, sendHpBp: 10000, winner: -1, events: [],
  }
}

// --- towers ----------------------------------------------------------------

const compound = (pct: number, level: number) => { let v = 100; for (let i = 1; i < level; i++) v = Math.floor(v * pct / 100); return v }

export function towerStats(t: Pick<Tower, 'kind' | 'level' | 'branch'>) {
  const d: TowerDef = TOWERS[t.kind]
  const b = t.branch
  let dmgPct = compound(UPGRADE.dmgPct, t.level)
  if (b === 'overdrive') dmgPct = dmgPct * BRANCH.overdrivePct / 100 // ponytail: fire rate folded into damage per shot
  if (b === 'arcFocus') dmgPct = dmgPct * BRANCH.arcFocusDmgPct / 100
  let rangeMc = d.rangeMc * compound(UPGRADE.rangePct, t.level) / 100
  if (b === 'longRange') rangeMc = rangeMc * BRANCH.longRangePct / 100
  return {
    def: d,
    dps: Math.floor(d.dps * dmgPct / 100 * MC), // hp-units per second
    rangeMc: Math.floor(rangeMc),
    splashMc: b === 'shrapnel' ? BRANCH.shrapnelSplashMc : d.splashMc ?? 0,
    chain: b === 'chain5' ? BRANCH.chain5 : b === 'arcFocus' ? 1 : d.chain ?? 1,
    beamMc: b === 'wide' ? BRANCH.wideBeamMc : d.beamMc ?? 0,
    maxHp: Math.floor(d.hp * MC * compound(UPGRADE.hpPct, t.level) / 100),
  }
}

export const upgradeCost = (t: Tower) => TOWERS[t.kind].cost * UPGRADE.costMult[t.level - 1]
export const sellValue = (t: Tower) => Math.floor(t.invested * SELL_REFUND_PCT / 100)

export function newTower(kind: TowerKind, x: number, y: number): Tower {
  const hp = TOWERS[kind].hp * MC
  return { id: 0, kind, x, y, hp, maxHp: hp, invested: TOWERS[kind].cost, level: 1, branch: null, target: 0, cd: 0, pulse: 0, melt: 0 }
}

// --- pathfinding -----------------------------------------------------------

// Dijkstra from the bottom row, 8-way (diagonals cost sqrt 2). open: towers are walls. breach: towers cost by HP.
// ponytail: O(n²) Dijkstra, 220 cells, only runs when the maze changes. Heap if lanes grow a lot.
export function field(towers: (Tower | null)[], breach: boolean): number[] {
  const dist = Array(COLS * ROWS).fill(INF)
  const done = Array(COLS * ROWS).fill(false)
  for (let x = 0; x < COLS; x++) dist[idx(x, ROWS - 1)] = 0
  for (;;) {
    let best = -1
    for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < INF && (best < 0 || dist[i] < dist[best])) best = i
    if (best < 0) return dist
    done[best] = true
    const bx = best % COLS, by = (best / COLS) | 0
    const t = towers[best]
    if (t && !breach) continue
    const cost = towerCost(t) // cost of stepping INTO `best` from a neighbour, on top of the distance
    for (const [dx, dy] of DIRS8) {
      const nx = bx + dx, ny = by + dy
      if (!inLane(nx, ny) || !diagOk(towers, bx, by, dx, dy)) continue
      const n = idx(nx, ny)
      if (towers[n] && !breach) continue
      const d = dist[best] + cost + (dx && dy ? DIAG : MC)
      if (d < dist[n]) dist[n] = d
    }
  }
}

// Plain BFS path length (in steps) from spawn, INF if sealed. Cheap enough for the bot to try every cell.
export function pathLen(towers: (Tower | null)[]): number {
  const dist = Array(COLS * ROWS).fill(-1)
  const q = [SPAWN]
  dist[SPAWN] = 0
  for (let h = 0; h < q.length; h++) {
    const c = q[h], x = c % COLS, y = (c / COLS) | 0
    if (y === ROWS - 1) return dist[c]
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy
      if (!inLane(nx, ny)) continue
      const n = idx(nx, ny)
      if (dist[n] >= 0 || towers[n]) continue
      dist[n] = dist[c] + 1
      q.push(n)
    }
  }
  return INF
}

export const SPAWN = idx((COLS - 1) / 2, 0)
const isSealed = (openDist: number[]) => openDist[SPAWN] >= INF

function recompute(L: Lane) {
  L.openDist = field(L.towers, false)
  L.breachDist = field(L.towers, true)
  L.sealed = isSealed(L.openDist)
  for (const r of L.robots) r.wp = -1
}

export function wouldSeal(L: Lane, x: number, y: number, towers = L.towers): boolean {
  const t = towers.slice()
  t[idx(x, y)] = newTower('gatling', x, y)
  return pathLen(t) >= INF
}

// distance² from a point to tower cell (x, y)'s square
const toCell2 = (px: number, py: number, x: number, y: number) => {
  const qx = Math.min(Math.max(px, x * MC), x * MC + MC), qy = Math.min(Math.max(py, y * MC), y * MC + MC)
  return (px - qx) ** 2 + (py - qy) ** 2
}
const onCell = (r: Robot, x: number, y: number) => !ROBOTS[r.kind].air && toCell2(r.x, r.y, x, y) < ROBOTS[r.kind].radiusMc ** 2

export function canBuild(L: Lane, x: number, y: number, kind: TowerKind): string | null {
  if (!buildable(x, y)) return 'Spawn and exit zones are not buildable'
  if (L.towers[idx(x, y)]) return 'Cell is taken'
  if (L.gold < TOWERS[kind].cost) return 'Not enough gold'
  if (L.robots.some(r => r.hp > 0 && onCell(r, x, y))) return 'A robot is on this cell'
  return null
}

export function canUpgrade(L: Lane, x: number, y: number, branch?: string): string | null {
  const t = L.towers[idx(x, y)]
  if (!t) return 'No tower'
  if (t.level >= 3) return 'Max level'
  if (t.level === 2 && !TOWERS[t.kind].branches.some(b => b.key === branch)) return 'Pick a branch'
  if (L.gold < upgradeCost(t)) return 'Not enough gold'
  return null
}

// Cells a robot would walk from spawn to exit, following the field it would use.
export function pathFrom(dist: number[], towers: (Tower | null)[], start = SPAWN): number[] {
  const out = [start]
  let cur = start
  while (dist[cur] > 0 && out.length < COLS * ROWS) {
    const nxt = stepFrom(dist, towers, cur)
    if (nxt < 0) break
    out.push(nxt)
    if (towers[nxt]) break // path ends at the wall the robots will chew through
    cur = nxt
  }
  return out
}

// Next cell downhill: the neighbour on the cheapest way to the exit.
function stepFrom(dist: number[], towers: (Tower | null)[], cur: number): number {
  const x = cur % COLS, y = (cur / COLS) | 0
  let best = -1, bestD = Infinity
  for (const [dx, dy] of DIRS8) {
    const nx = x + dx, ny = y + dy
    if (!inLane(nx, ny) || !diagOk(towers, x, y, dx, dy)) continue
    const n = idx(nx, ny)
    if (dist[n] >= INF) continue
    const d = dist[n] + towerCost(towers[n]) + (dx && dy ? DIAG : MC)
    if (dist[n] < dist[cur] && d < bestD) { best = n; bestD = d }
  }
  return best
}

// --- factories and sending -------------------------------------------------

export const robotHp = (kind: RobotKind, level: number) => Math.floor(ROBOTS[kind].hp * MC * SEND.hpPct / 100 * (100 + FACTORY.hpPctPerLevel * (level - 1)) / 100)
export const waveCap = (kind: RobotKind, level: number) => Math.floor(ROBOTS[kind].maxWave * (100 + FACTORY.waveCapPctPerLevel * (level - 1)) / 100)
export const slotsUsed = (L: Lane) => Object.entries(L.factories).filter(([k, l]) => k !== 'scout' && l > 0).length
export const factoryCost = (L: Lane, kind: RobotKind) => {
  const lvl = L.factories[kind]
  if (!lvl) return ROBOTS[kind].factoryCost
  return (kind === 'scout' ? FACTORY.scoutUpgradeCost : ROBOTS[kind].factoryCost) * FACTORY.upgradeCostMult[lvl - 1]
}

export function canFactory(L: Lane, kind: RobotKind): string | null {
  const lvl = L.factories[kind]
  if (lvl >= 3) return 'Max level'
  if (!lvl && slotsUsed(L) >= FACTORY.slots) return 'No free slot'
  if (L.gold < factoryCost(L, kind)) return 'Not enough gold'
  return null
}

export function canLoad(g: Game, L: Lane, kind: RobotKind): string | null {
  const lvl = L.factories[kind]
  if (!lvl) return 'Build the factory first'
  if (kind === 'colossus' && secs(g) < SEND.colossusFromS) return 'Available from 5:00'
  if (L.queue.filter(q => q.kind === kind).length >= waveCap(kind, lvl)) return 'Wave is full'
  if (L.gold < ROBOTS[kind].sendCost) return 'Not enough gold'
  return null
}

export const readyCount = (L: Lane) => L.queue.filter(q => q.left === 0).length

export function canRelease(g: Game, L: Lane): string | null {
  if (secs(g) < SEND.prepS) return 'Sending unlocks after the prep phase'
  if (!readyCount(L)) return 'Nothing ready'
  return null
}

// --- tick ------------------------------------------------------------------

export function step(g: Game, cmds: Cmd[]): void {
  g.events = []
  if (g.winner !== -1) return
  for (const c of cmds) apply(g, c)

  if (g.tick > 0 && g.tick % (60 * TICK_HZ) === 0) { // sent robots: +a% per minute plus b% per minute², so offense keeps pace with towers piling up
    const m = g.tick / (60 * TICK_HZ)
    g.sendHpBp = 10000 + SEND.hpGrowthPctPerMin * 100 * m + SEND.hpGrowthPctPerMin2 * 100 * m * m
  }

  // income (frozen while sealed)
  if (g.tick > 0 && g.tick % (INCOME_EVERY_S * TICK_HZ) === 0) for (const L of g.lanes) {
    if (!L.sealed) L.gold += L.income
    L.stats.income.push(L.income)
  }

  // neutral waves, the same in every lane; sudden death from 10:00
  if (g.tick === g.nextWaveTick) {
    const sudden = secs(g) >= SUDDEN.fromS
    if (g.wave > 0) g.waveHpBp = Math.floor(g.waveHpBp * (100 + (sudden ? SUDDEN.hpGrowthPct : WAVE_HP_GROWTH_PCT)) / 100)
    for (const L of g.lanes) {
      for (const kind of neutralWave(g.wave)) L.spawnQueue.push({ kind, hp: Math.floor(ROBOTS[kind].hp * MC * g.waveHpBp / 10000), owner: -1 })
      g.events.push({ t: 'wave', p: L.p, n: g.wave })
    }
    g.wave++
    g.nextWaveTick += (sudden ? SUDDEN.everyS : WAVE_EVERY_S) * TICK_HZ
  }

  for (const L of g.lanes) {
    // every factory builds its own robots, one at a time (fun plan: send throughput grows with factories)
    const busy = new Set<RobotKind>()
    for (const q of L.queue) if (q.left > 0 && !busy.has(q.kind)) { busy.add(q.kind); q.left-- }
    // released waves land after the preview
    while (L.incoming.length && L.incoming[0].at <= g.tick) L.spawnQueue.push(...L.incoming.shift()!.robots)
    if (L.spawnQueue.length) { spawnGroup(g, L, L.spawnQueue); L.spawnQueue = [] }

    applyStatus(L)
    moveRobots(g, L)
    burnGround(g, L)
    fireTowers(g, L)
    L.robots = L.robots.filter(r => r.hp > 0)
  }

  const alive = g.lanes.filter(L => L.lives > 0)
  if (alive.length <= 1) g.winner = alive.length ? alive[0].p : -2
  g.tick++
}

export function spawn(g: Game, L: Lane, s: Spawn, cx = SPAWN % COLS, cy = 0): Robot {
  const r: Robot = {
    id: g.nextId++, kind: s.kind, owner: s.owner, x: center(cx), y: center(cy), cx, cy, wp: -1, hp: s.hp, maxHp: s.hp,
    shield: s.shield ?? 0, gotShield: !!s.shield, slow: 0, stun: 0, amp: 100, jam: false,
  }
  L.robots.push(r)
  return r
}

// A whole release (and a neutral wave) lands at once, packed in shelves across the spawn zone, centred.
// ponytail: shelves past the 2 spawn rows are clamped into them and overlap; the overlap rule in move() lets them spread out.
function spawnGroup(g: Game, L: Lane, group: Spawn[]) {
  const GAP = 40, W = COLS * MC - MC // half a cell of margin each side
  const size = (s: Spawn) => 2 * Math.max(ROBOTS[s.kind].radiusMc, 200) + GAP // drones get a slot too, they fly their own column
  const shelves: Spawn[][] = [[]]
  let used = 0
  for (const s of group) {
    if (used + size(s) > W && shelves[shelves.length - 1].length) { shelves.push([]); used = 0 }
    shelves[shelves.length - 1].push(s)
    used += size(s)
  }
  let y = 0
  for (const sh of shelves) {
    const h = Math.max(...sh.map(size))
    let x = (COLS * MC - sh.reduce((a, s) => a + size(s), 0)) / 2
    for (const s of sh) {
      const r = spawn(g, L, s)
      const rad = ROBOTS[s.kind].radiusMc
      r.x = Math.floor(x + size(s) / 2)
      r.y = Math.min(Math.floor(y + h / 2), SPAWN_ROWS * MC - Math.max(rad, 1))
      r.cx = Math.floor(r.x / MC); r.cy = Math.floor(r.y / MC)
      x += size(s)
    }
    y += h
  }
}

function apply(g: Game, c: Cmd) {
  const L = g.lanes[c.p]
  if (!L || L.lives <= 0) return
  switch (c.t) {
    case 'build': {
      if (canBuild(L, c.x, c.y, c.kind)) return
      L.gold -= TOWERS[c.kind].cost
      L.stats.towerGold += TOWERS[c.kind].cost
      L.towers[idx(c.x, c.y)] = { ...newTower(c.kind, c.x, c.y), id: g.nextId++ }
      return recompute(L)
    }
    case 'upgrade': {
      if (canUpgrade(L, c.x, c.y, c.branch)) return
      const t = L.towers[idx(c.x, c.y)]!
      const cost = upgradeCost(t)
      L.gold -= cost
      L.stats.towerGold += cost
      t.invested += cost
      t.level++
      if (t.level === 3) t.branch = c.branch!
      const maxHp = towerStats(t).maxHp
      t.hp += maxHp - t.maxHp
      t.maxHp = maxHp
      return recompute(L) // HP feeds the breach field
    }
    case 'sell': {
      const t = L.towers[idx(c.x, c.y)]
      if (!t) return
      L.gold += sellValue(t)
      L.towers[idx(c.x, c.y)] = null
      return recompute(L)
    }
    case 'factory': {
      if (canFactory(L, c.kind)) return
      L.gold -= factoryCost(L, c.kind)
      L.factories[c.kind]++
      return
    }
    case 'demolish': {
      if (c.kind === 'scout' || !L.factories[c.kind]) return
      L.factories[c.kind] = 0 // no refund for the factory, queued robots of that type are refunded
      for (const q of L.queue) if (q.kind === c.kind) L.gold += ROBOTS[q.kind].sendCost
      L.queue = L.queue.filter(q => q.kind !== c.kind)
      return
    }
    case 'load': {
      if (canLoad(g, L, c.kind)) return
      L.gold -= ROBOTS[c.kind].sendCost
      L.stats.sendGold += ROBOTS[c.kind].sendCost
      L.queue.push({ kind: c.kind, left: Math.floor(ROBOTS[c.kind].buildS * TICK_HZ * FACTORY.buildPctByLevel[L.factories[c.kind] - 1] / 100) })
      return
    }
    case 'release': {
      if (canRelease(g, L)) return
      const ready = L.queue.filter(q => q.left === 0)
      L.queue = L.queue.filter(q => q.left > 0)
      const target = g.lanes[opponent(g, L.p)]
      const burst = ready.length >= SEND.burstMin
      const robots = ready.map(q => {
        const hp = Math.floor(robotHp(q.kind, L.factories[q.kind] || 1) * g.sendHpBp / 10000)
        return { kind: q.kind, hp, owner: L.p, shield: burst ? Math.floor(hp * SEND.burstShieldPct / 100) : 0 }
      })
      for (const q of ready) L.released += ROBOTS[q.kind].sendCost
      L.income = START_INCOME + Math.floor(L.released / SEND.goldPerIncome)
      L.stats.sent += ready.length
      target.incoming.push({ at: g.tick + SEND.previewS * TICK_HZ, robots })
      g.events.push({ t: 'released', p: target.p, kinds: ready.map(q => q.kind) })
    }
  }
}

const canHit = (def: { ground: boolean; air: boolean }, r: Robot) => r.hp > 0 && (ROBOTS[r.kind].air ? def.air : def.ground)
const dist2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) ** 2 + (ay - by) ** 2
const inRange = (t: Tower, r: Robot, rangeMc: number) => dist2(r.x, r.y, center(t.x), center(t.y)) <= rangeMc ** 2

// Robot auras (repair, shield) and EMP auras (slow, overload, stun pulse). Before movement and firing.
function applyStatus(L: Lane) {
  const healed = new Set<Robot>()
  for (const r of L.robots) { r.slow = 0; r.amp = 100; r.jam = false; if (r.stun > 0) r.stun-- }
  // EMPs first: a robot in an EMP field is jammed (fun plan: EMP is the answer to aura swarms)
  for (const t of L.towers) {
    if (!t || t.kind !== 'emp') continue
    const st = towerStats(t)
    const pulse = t.branch === 'stun' && ++t.pulse >= BRANCH.stunEveryTicks
    if (pulse) t.pulse = 0
    for (const r of L.robots) {
      if (!canHit(st.def, r) || !inRange(t, r, st.rangeMc)) continue
      r.slow = Math.max(r.slow, st.def.slowPct!)
      r.jam = true
      r.shield = 0 // shields fizzle
      if (t.branch === 'overload') r.amp = Math.max(r.amp, BRANCH.overloadPct)
      if (pulse) r.stun = BRANCH.stunTicks
    }
  }
  for (const a of L.robots) {
    if ((a.kind !== 'repair' && a.kind !== 'shield') || a.jam) continue // a jammed aura bot emits nothing
    for (const r of L.robots) {
      if (r.hp <= 0 || r.jam) continue
      // heals don't stack: each robot is healed by at most one Repair bot per tick
      if (a.kind === 'repair' && !healed.has(r) && dist2(a.x, a.y, r.x, r.y) <= AURA.repairMc ** 2) { healed.add(r); r.hp = Math.min(r.maxHp, r.hp + Math.floor(r.maxHp * AURA.repairPctPerS / 100 / TICK_HZ)) }
      // default for an open question: each robot gets one shield, shields don't stack, Repair doesn't heal them
      if (a.kind === 'shield' && r !== a && !r.gotShield && dist2(a.x, a.y, r.x, r.y) <= AURA.shieldMc ** 2) { r.shield = Math.floor(r.maxHp * AURA.shieldPct / 100); r.gotShield = true }
    }
  }
}

// --- crowd movement ------------------------------------------------------
// Robots are circles (ROBOTS[k].radiusMc) on a continuous floor; towers are solid squares.
// Each robot steers for a waypoint cell on its field and pulls it forward while the straight line there is clear
// (any-angle routes). It never moves deeper into another robot, so it queues behind or slips past through a gap.
// Plain IEEE double math (+ - * / sqrt), rounded back to integers every tick: deterministic everywhere.

// Does the segment a→b come within `rad` of a tower (square grown by rad, conservative at the corners)? `skip`: a tower cell to ignore.
function lineClear(L: Lane, ax: number, ay: number, bx: number, by: number, rad: number, skip = -1): boolean {
  const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - rad) / MC)), x1 = Math.min(COLS - 1, Math.floor((Math.max(ax, bx) + rad) / MC))
  const y0 = Math.max(0, Math.floor((Math.min(ay, by) - rad) / MC)), y1 = Math.min(ROWS - 1, Math.floor((Math.max(ay, by) + rad) / MC))
  const dx = bx - ax, dy = by - ay
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = idx(x, y)
    if (i === skip || !L.towers[i]) continue
    // slab test against [x*MC - rad, x*MC + MC + rad] × the same in y; touching the edge is allowed
    let t0 = 0, t1 = 1
    const lo = [x * MC - rad, y * MC - rad], hi = [x * MC + MC + rad, y * MC + MC + rad], p = [ax, ay], d = [dx, dy]
    let hit = true
    for (let k = 0; k < 2 && hit; k++) {
      if (d[k] === 0) { if (p[k] <= lo[k] || p[k] >= hi[k]) hit = false; continue }
      let u = (lo[k] - p[k]) / d[k], v = (hi[k] - p[k]) / d[k]
      if (u > v) [u, v] = [v, u]
      t0 = Math.max(t0, u); t1 = Math.min(t1, v)
      if (t0 >= t1) hit = false
    }
    if (hit) return false
  }
  return true
}

// Push a circle out of the lane edges and any tower square it overlaps (this is what makes robots slide along walls).
function unwall(L: Lane, x: number, y: number, rad: number): [number, number] {
  for (let pass = 0; pass < 2; pass++) {
    x = Math.min(Math.max(x, rad), COLS * MC - rad)
    y = Math.min(Math.max(y, rad), ROWS * MC - 1)
    const cx = Math.floor(x / MC), cy = Math.floor(y / MC)
    for (let ty = cy - 1; ty <= cy + 1; ty++) for (let tx = cx - 1; tx <= cx + 1; tx++) {
      if (!inLane(tx, ty) || !L.towers[idx(tx, ty)]) continue
      const qx = Math.min(Math.max(x, tx * MC), tx * MC + MC), qy = Math.min(Math.max(y, ty * MC), ty * MC + MC)
      const ddx = x - qx, ddy = y - qy, d2 = ddx * ddx + ddy * ddy
      if (d2 >= rad * rad) continue
      if (d2 === 0) { // centre inside the square: out through the nearest side
        const out = [[tx * MC - rad - x, 0], [tx * MC + MC + rad - x, 0], [0, ty * MC - rad - y], [0, ty * MC + MC + rad - y]]
        out.sort((a, b) => Math.abs(a[0] + a[1]) - Math.abs(b[0] + b[1]))
        x += out[0][0]; y += out[0][1]
      } else {
        const d = Math.sqrt(d2)
        x = Math.round(qx + ddx * rad / d); y = Math.round(qy + ddy * rad / d)
      }
    }
  }
  return [x, y]
}

// Would r at (x, y) be deeper inside some other ground robot than it is now? Overlaps that already exist
// (a fresh group, Splitter pieces) may stay or shrink, never grow.
// ponytail: O(n²) per candidate move; bucket robots by cell if lanes get crowded enough to show in a profile.
function bumps(L: Lane, r: Robot, x: number, y: number): boolean {
  const rad = ROBOTS[r.kind].radiusMc
  for (const o of L.robots) {
    if (o === r || o.hp <= 0 || ROBOTS[o.kind].air) continue
    const s = rad + ROBOTS[o.kind].radiusMc
    const dx = x - o.x, dy = y - o.y
    if (dx >= s || -dx >= s || dy >= s || -dy >= s) continue
    const d2 = dx * dx + dy * dy
    if (d2 < s * s && d2 < (r.x - o.x) ** 2 + (r.y - o.y) ** 2) return true
  }
  return false
}

// Straight at the waypoint first, then veering 30° and 60° to either side to slip past whoever is in the way.
const VEER = [[1, 0], [0.8660254037844386, 0.5], [0.8660254037844386, -0.5], [0.5, 0.8660254037844386], [0.5, -0.8660254037844386]]
const TOUCH_MC = 50 // a robot this close to a wall is touching it

function moveRobots(g: Game, L: Lane) {
  let changed = false
  // the robot closest to the exit moves first, so the ones behind see where it went
  const order = L.robots.filter(r => r.hp > 0).sort((a, b) => progress(L, a) - progress(L, b) || a.id - b.id)
  for (const r of order) {
    if (r.stun > 0) continue
    const def = ROBOTS[r.kind]
    const cur = idx(r.cx, r.cy)
    const trapped = !def.air && L.openDist[cur] >= INF

    // Breakers hit a tower next to them even in an open lane
    if (r.kind === 'breaker' && !trapped) {
      for (const [dx, dy] of DIRS) {
        const t = inLane(r.cx + dx, r.cy + dy) && L.towers[idx(r.cx + dx, r.cy + dy)]
        if (t) { changed = hitTower(g, L, t, r, L.sealed) || changed; break }
      }
    }

    const speed = Math.floor(def.speedMcPerS * (L.sealed ? BREACH.speedPct : 100) / 100 * (100 - r.slow) / 100 / TICK_HZ)
    if (def.air) { // Drones fly straight to the exit
      r.y = Math.min(r.y + speed, center(ROWS - 1))
      r.cy = Math.floor(r.y / MC)
      if (r.y >= center(ROWS - 1)) leak(g, L, r)
      continue
    }

    // Open lane: follow the wall-respecting field. Sealed lane, or a robot boxed into a pocket
    // (open design gap 4): follow the HP-weighted field and chew through whatever tower is next,
    // but only while touching it, so the rest of the crowd waits its turn.
    const dist = trapped ? L.breachDist : L.openDist
    const rad = def.radiusMc
    if (r.wp < 0) r.wp = cur
    for (let k = 0; k < 4 && !L.towers[r.wp] && dist[r.wp] > 0; k++) {
      const n = stepFrom(dist, L.towers, r.wp)
      if (n < 0) break
      const reached = (center(r.wp % COLS) - r.x) ** 2 + (center((r.wp / COLS) | 0) - r.y) ** 2 <= speed * speed
      if (!reached && !lineClear(L, r.x, r.y, center(n % COLS), center((n / COLS) | 0), rad, n)) break
      r.wp = n
    }
    const wx = r.wp % COLS, wy = (r.wp / COLS) | 0
    const wall = L.towers[r.wp]
    // breaching: chew the wall it's heading for once it gets there; the crowd behind waits its turn
    if (wall && toCell2(r.x, r.y, wx, wy) <= (rad + TOUCH_MC) ** 2) { changed = hitTower(g, L, wall, r, L.sealed) || changed; continue }

    const dx = center(wx) - r.x, dy = center(wy) - r.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > 0) {
      const vx = dx * Math.min(speed, d) / d, vy = dy * Math.min(speed, d) / d
      for (const [c, sn] of VEER) {
        const [qx, qy] = unwall(L, Math.round(r.x + vx * c - vy * sn), Math.round(r.y + vx * sn + vy * c), rad)
        if ((qx === r.x && qy === r.y) || bumps(L, r, qx, qy)) continue
        r.x = qx; r.y = qy
        break
      }
    }
    r.cx = Math.floor(r.x / MC); r.cy = Math.floor(r.y / MC)
    if (r.cy === ROWS - 1) leak(g, L, r)
  }
  if (changed) recompute(L)
}

function leak(g: Game, L: Lane, r: Robot) {
  r.hp = 0
  const dmg = ROBOTS[r.kind].leak * (L.sealed ? 2 : 1)
  L.lives = Math.max(0, L.lives - dmg)
  L.stats.leaksTaken++
  if (r.owner >= 0) g.lanes[r.owner].gold += Math.floor(ROBOTS[r.kind].sendCost * SEND.leakPct / 100)
  g.events.push({ t: 'leak', p: L.p, robot: r.id, kind: r.kind, owner: r.owner, dmg })
}

// returns true if any tower was destroyed
function hitTower(g: Game, L: Lane, t: Tower, r: Robot, breach: boolean): boolean {
  const dmg = Math.floor(ROBOTS[r.kind].towerDps * MC * (breach ? BREACH.towerDmgMult : 1) / TICK_HZ)
  const hit = breach
    ? L.towers.filter((o): o is Tower => !!o && Math.abs(o.x - t.x) <= 1 && Math.abs(o.y - t.y) <= 1)
    : [t]
  let lost = false
  for (const o of hit) {
    o.hp -= dmg
    if (o.hp <= 0) { // destroyed in a breach: no refund
      L.towers[idx(o.x, o.y)] = null
      g.events.push({ t: 'towerLost', p: L.p, tower: o.id })
      lost = true
    }
  }
  return lost
}

// Every point of damage goes through here: damage triangle, armor-piercing, overload, shields.
export function damage(g: Game, L: Lane, r: Robot, raw: number, type: DamageType, pierce = false, skipShield = false) {
  if (r.hp <= 0) return
  let amt = Math.floor(raw * (pierce ? 100 : ARMOR_MULT_PCT[type][ROBOTS[r.kind].armor]) / 100 * r.amp / 100)
  const absorbed = skipShield ? 0 : Math.min(r.shield, amt)
  r.shield -= absorbed
  amt -= absorbed
  r.hp -= amt
  if (r.hp > 0) return
  L.gold += Math.floor(ROBOTS[r.kind].sendCost * SEND.bountyPct / 100)
  L.stats.kills++
  g.events.push({ t: 'kill', p: L.p, robot: r.id })
  if (r.kind === 'splitter') {
    const hp = Math.floor(ROBOTS.scout.hp * MC * r.maxHp / (ROBOTS.splitter.hp * MC)) // Scouts scale like their parent
    for (let i = 0; i < 3; i++) {
      const s = spawn(g, L, { kind: 'scout', hp, owner: r.owner }, r.cx, r.cy)
      s.x = r.x; s.y = r.y
    }
  }
}

function burnGround(g: Game, L: Lane) {
  for (const b of L.burns) {
    b.ticks--
    for (const r of L.robots) if (!ROBOTS[r.kind].air && r.cx === b.x && r.cy === b.y) damage(g, L, r, b.dmg, 'explosive')
  }
  L.burns = L.burns.filter(b => b.ticks > 0)
}

const progress = (L: Lane, r: Robot) => {
  if (ROBOTS[r.kind].air) return (ROWS - 1 - r.cy) * MC
  const i = idx(r.cx, r.cy)
  return L.openDist[i] < INF ? L.openDist[i] : L.breachDist[i]
}

function fireTowers(g: Game, L: Lane) {
  for (const t of L.towers) {
    if (!t) continue
    if (t.cd > 0) { t.cd--; continue }
    const st = towerStats(t), d = st.def
    const tx = center(t.x), ty = center(t.y)
    const shot = Math.floor(st.dps * d.period / TICK_HZ)
    const fx = (k: FxKind, x2: number, y2: number, r = 0, x1 = tx, y1 = ty) => g.events.push({ t: 'fx', p: L.p, k, tower: t.kind, x1, y1, x2, y2, r })
    const hurt = (r: Robot, amt: number, pierce = false) => damage(g, L, r, amt, d.dmg, pierce, d.attack === 'beam') // Laser beams ignore shields

    if (d.attack === 'aura') {
      const hits = L.robots.filter(r => canHit(d, r) && inRange(t, r, st.rangeMc))
      if (!hits.length) continue
      for (const r of hits) hurt(r, shot)
      fx('pulse', tx, ty, st.rangeMc)
      t.cd = d.period - 1
      continue
    }

    // target: keep the current one while it's valid, else the robot closest to the exit
    let target = L.robots.find(r => r.id === t.target && canHit(d, r) && inRange(t, r, st.rangeMc))
    if (!target) for (const r of L.robots) {
      if (canHit(d, r) && inRange(t, r, st.rangeMc) && (!target || progress(L, r) < progress(L, target))) target = r
    }
    if (target?.id !== t.target) t.melt = 0
    t.target = target ? target.id : 0
    if (!target) continue
    t.cd = d.period - 1

    if (d.attack === 'single') {
      hurt(target, shot, t.branch === 'pierce')
      fx('line', target.x, target.y)
    } else if (d.attack === 'splash') {
      const cluster = t.branch === 'cluster'
      const offsets = cluster ? BRANCH.clusterOffsetsMc : [[0, 0]]
      const radius = cluster ? BRANCH.clusterSplashMc : st.splashMc
      const dmg = cluster ? Math.floor(shot * BRANCH.clusterDmgPct / 100) : shot
      const tx2 = target.x, ty2 = target.y
      for (const [ox, oy] of offsets) {
        for (const r of L.robots) if (canHit(d, r) && dist2(r.x, r.y, tx2 + ox, ty2 + oy) <= radius ** 2) hurt(r, dmg)
        fx('boom', tx2 + ox, ty2 + oy, radius)
      }
      if (t.branch === 'burn') L.burns.push({ x: target.cx, y: target.cy, ticks: BRANCH.burnTicks, dmg: Math.floor(st.dps * BRANCH.burnDpsPct / 100 / TICK_HZ) })
    } else if (d.attack === 'chain') {
      const hit: Robot[] = [target]
      while (hit.length < st.chain) {
        const last = hit[hit.length - 1]
        let next: Robot | undefined
        for (const r of L.robots) {
          if (!canHit(d, r) || hit.includes(r) || dist2(r.x, r.y, last.x, last.y) > d.chainMc! ** 2) continue
          if (!next || dist2(r.x, r.y, last.x, last.y) < dist2(next.x, next.y, last.x, last.y)) next = r
        }
        if (!next) break
        hit.push(next)
      }
      hit.forEach((r, i) => { fx('line', r.x, r.y, 0, i ? hit[i - 1].x : tx, i ? hit[i - 1].y : ty); hurt(r, shot) })
    } else { // beam: everything on the line from the tower through the target, out to full range
      const dx = target.x - tx, dy = target.y - ty
      const len = Math.max(1, Math.floor(Math.sqrt(dx * dx + dy * dy)))
      let dmg = shot
      if (t.branch === 'melt') {
        t.melt++
        dmg = Math.floor(shot * Math.min(100 + BRANCH.meltRampPctPerS * t.melt / TICK_HZ, BRANCH.meltMaxPct) / 100)
      }
      for (const r of L.robots) {
        if (!canHit(d, r)) continue
        const px = r.x - tx, py = r.y - ty
        const along = px * dx + py * dy, across = Math.abs(px * dy - py * dx)
        if (along >= 0 && along <= st.rangeMc * len && across * 2 <= st.beamMc * len) hurt(r, dmg)
      }
      fx('beam', tx + Math.floor(dx * st.rangeMc / len), ty + Math.floor(dy * st.rangeMc / len), st.beamMc)
    }
  }
}
