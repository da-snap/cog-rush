// Deterministic lane sim: fixed 20 Hz tick, integer math, input is a list of commands per tick.
// Engine-independent: no DOM, no Pixi, no Math.random.
import {
  ARMOR_MULT_PCT, BREACH, COLS, EXIT_ROWS, FIRST_WAVE_S, INCOME_EVERY_S, LIVES, MC, ROBOTS, ROWS,
  SELL_REFUND_PCT, SPAWN_GAP_TICKS, SPAWN_ROWS, START_GOLD, START_INCOME, TICK_HZ, TOWERS,
  WAVE_EVERY_S, WAVE_HP_GROWTH_PCT, neutralWave, type RobotKind, type TowerKind,
} from './config.ts'

export const INF = 2 ** 30
export type Cmd = { t: 'build'; x: number; y: number; kind: TowerKind } | { t: 'sell'; x: number; y: number }
export type Ev =
  | { t: 'shot'; tower: number; robot: number }
  | { t: 'kill'; robot: number }
  | { t: 'leak'; robot: number }
  | { t: 'towerHit'; tower: number }
  | { t: 'towerLost'; tower: number }
  | { t: 'wave'; n: number }

export interface Tower { id: number; kind: TowerKind; x: number; y: number; hp: number; maxHp: number; invested: number; target: number }
export interface Robot { id: number; kind: RobotKind; x: number; y: number; cx: number; cy: number; hp: number; maxHp: number }
export interface State {
  tick: number; gold: number; income: number; lives: number
  towers: (Tower | null)[] // by cell index y*COLS+x
  robots: Robot[]
  nextId: number; wave: number; waveHpBp: number; spawnQueue: { kind: RobotKind; hp: number }[]
  openDist: number[]; breachDist: number[]; sealed: boolean
  events: Ev[] // events from the last step only
}

const idx = (x: number, y: number) => y * COLS + x
const inLane = (x: number, y: number) => x >= 0 && x < COLS && y >= 0 && y < ROWS
export const buildable = (x: number, y: number) => x >= 0 && x < COLS && y >= SPAWN_ROWS && y < ROWS - EXIT_ROWS
const center = (c: number) => c * MC + MC / 2
const DIRS = [[0, 1], [-1, 0], [1, 0], [0, -1]] // fixed order = deterministic tie-break, prefers "down"

export function newState(): State {
  const s: State = {
    tick: 0, gold: START_GOLD, income: START_INCOME, lives: LIVES,
    towers: Array(COLS * ROWS).fill(null), robots: [],
    nextId: 1, wave: 0, waveHpBp: 10000, spawnQueue: [],
    openDist: [], breachDist: [], sealed: false, events: [],
  }
  recompute(s)
  return s
}

// Dijkstra from the bottom row. open: towers are walls. breach: towers cost by HP.
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
    const cost = MC + (t ? Math.floor(t.hp / BREACH.hpCostPer) : 0) // cost of stepping INTO `best` from a neighbour
    for (const [dx, dy] of DIRS) {
      const nx = bx + dx, ny = by + dy
      if (!inLane(nx, ny)) continue
      const n = idx(nx, ny)
      if (towers[n] && !breach) continue
      if (t && !breach) continue
      if (dist[best] + cost < dist[n]) dist[n] = dist[best] + cost
    }
  }
}

const SPAWN = idx((COLS - 1) / 2, 0)
const isSealed = (openDist: number[]) => openDist[SPAWN] >= INF

function recompute(s: State) {
  s.openDist = field(s.towers, false)
  s.breachDist = field(s.towers, true)
  s.sealed = isSealed(s.openDist)
}

export function wouldSeal(s: State, x: number, y: number): boolean {
  const t = s.towers.slice()
  t[idx(x, y)] = { id: 0, kind: 'gatling', x, y, hp: 1, maxHp: 1, invested: 0, target: 0 }
  return isSealed(field(t, false))
}

const robotCell = (r: Robot) => idx(Math.floor(r.x / MC), Math.floor(r.y / MC))

export function canBuild(s: State, x: number, y: number, kind: TowerKind): string | null {
  if (!buildable(x, y)) return 'Spawn and exit zones are not buildable'
  if (s.towers[idx(x, y)]) return 'Cell is taken'
  if (s.gold < TOWERS[kind].cost) return 'Not enough gold'
  const i = idx(x, y)
  if (s.robots.some(r => robotCell(r) === i || idx(r.cx, r.cy) === i)) return 'A robot is on this cell'
  return null
}

// Cells a robot would walk from spawn to exit, following the field it would use.
export function pathFrom(dist: number[], towers: (Tower | null)[], start = SPAWN): number[] {
  const out = [start]
  let cur = start
  while (dist[cur] > 0 && out.length < COLS * ROWS) {
    const nxt = stepFrom(dist, cur)
    if (nxt < 0) break
    out.push(nxt)
    if (towers[nxt]) break // path ends at the wall the robots will chew through
    cur = nxt
  }
  return out
}

function stepFrom(dist: number[], cur: number): number {
  const x = cur % COLS, y = (cur / COLS) | 0
  let best = -1
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy
    if (!inLane(nx, ny)) continue
    const n = idx(nx, ny)
    if (dist[n] < dist[cur] && (best < 0 || dist[n] < dist[best])) best = n
  }
  return best
}

export function step(s: State, cmds: Cmd[]): void {
  s.events = []
  for (const c of cmds) apply(s, c)

  // income (frozen while sealed)
  if (s.tick > 0 && s.tick % (INCOME_EVERY_S * TICK_HZ) === 0 && !s.sealed) s.gold += s.income

  // neutral waves
  const t0 = FIRST_WAVE_S * TICK_HZ
  if (s.tick >= t0 && (s.tick - t0) % (WAVE_EVERY_S * TICK_HZ) === 0) {
    if (s.wave > 0) s.waveHpBp = Math.floor(s.waveHpBp * (100 + WAVE_HP_GROWTH_PCT) / 100)
    for (const kind of neutralWave(s.wave)) s.spawnQueue.push({ kind, hp: Math.floor(ROBOTS[kind].hp * MC * s.waveHpBp / 10000) })
    s.events.push({ t: 'wave', n: s.wave })
    s.wave++
  }
  if (s.spawnQueue.length && s.tick % SPAWN_GAP_TICKS === 0) {
    const q = s.spawnQueue.shift()!
    const sx = SPAWN % COLS
    s.robots.push({ id: s.nextId++, kind: q.kind, x: center(sx), y: center(0), cx: sx, cy: 0, hp: q.hp, maxHp: q.hp })
  }

  moveRobots(s)
  fireTowers(s)
  s.tick++
}

function apply(s: State, c: Cmd) {
  const i = idx(c.x, c.y)
  if (c.t === 'build') {
    if (canBuild(s, c.x, c.y, c.kind)) return
    const d = TOWERS[c.kind]
    s.gold -= d.cost
    s.towers[i] = { id: s.nextId++, kind: c.kind, x: c.x, y: c.y, hp: d.hp * MC, maxHp: d.hp * MC, invested: d.cost, target: 0 }
    recompute(s)
  } else {
    const t = s.towers[i]
    if (!t) return
    s.gold += Math.floor(t.invested * SELL_REFUND_PCT / 100)
    s.towers[i] = null
    recompute(s)
  }
}

function moveRobots(s: State) {
  let changed = false
  for (const r of s.robots) {
    if (r.hp <= 0) continue
    const tx = center(r.cx), ty = center(r.cy)
    const speed = Math.floor(ROBOTS[r.kind].speedMcPerS * (s.sealed ? BREACH.speedPct : 100) / 100 / TICK_HZ)
    const dx = tx - r.x, dy = ty - r.y
    const d = Math.abs(dx) + Math.abs(dy) // moves are axis-aligned, so manhattan = euclidean
    if (d > speed) {
      r.x += Math.sign(dx) * Math.min(speed, Math.abs(dx))
      r.y += Math.sign(dy) * Math.min(speed, Math.abs(dy))
      continue
    }
    r.x = tx; r.y = ty
    const cur = idx(r.cx, r.cy)
    if (r.cy === ROWS - 1) { // reached the exit
      r.hp = 0
      s.lives = Math.max(0, s.lives - (s.sealed ? 2 : 1))
      s.events.push({ t: 'leak', robot: r.id })
      continue
    }
    // Open lane: follow the wall-respecting field. Sealed lane, or a robot boxed into a pocket:
    // follow the HP-weighted field and chew through whatever tower is next.
    const trapped = s.openDist[cur] >= INF
    const nxt = stepFrom(trapped ? s.breachDist : s.openDist, cur)
    if (nxt < 0) continue
    const wall = s.towers[nxt]
    if (wall) {
      changed = hitTower(s, wall, s.sealed) || changed
      continue
    }
    r.cx = nxt % COLS; r.cy = (nxt / COLS) | 0
  }
  s.robots = s.robots.filter(r => r.hp > 0)
  if (changed) recompute(s)
}

// returns true if any tower was destroyed
function hitTower(s: State, t: Tower, breach: boolean): boolean {
  const dmg = Math.floor(BREACH.baseTowerDps * MC * (breach ? BREACH.towerDmgMult : 1) / TICK_HZ)
  const hit = breach
    ? s.towers.filter((o): o is Tower => !!o && Math.abs(o.x - t.x) <= 1 && Math.abs(o.y - t.y) <= 1)
    : [t]
  let lost = false
  for (const o of hit) {
    o.hp -= dmg
    s.events.push({ t: 'towerHit', tower: o.id })
    if (o.hp <= 0) { // destroyed in a breach: no refund
      s.towers[idx(o.x, o.y)] = null
      s.events.push({ t: 'towerLost', tower: o.id })
      lost = true
    }
  }
  return lost
}

function fireTowers(s: State) {
  for (const t of s.towers) {
    if (!t) continue
    const d = TOWERS[t.kind]
    const tx = center(t.x), ty = center(t.y)
    const inRange = (r: Robot) => (r.x - tx) ** 2 + (r.y - ty) ** 2 <= d.rangeMc ** 2
    let target = s.robots.find(r => r.id === t.target && r.hp > 0 && inRange(r))
    if (!target) {
      // closest to the exit
      for (const r of s.robots) {
        if (r.hp <= 0 || !inRange(r)) continue
        if (!target || progress(s, r) < progress(s, target)) target = r
      }
    }
    t.target = target ? target.id : 0
    if (!target) continue
    target.hp -= Math.floor(d.dps * MC * ARMOR_MULT_PCT[d.dmg][ROBOTS[target.kind].armor] / 100 / TICK_HZ)
    s.events.push({ t: 'shot', tower: t.id, robot: target.id })
    if (target.hp <= 0) {
      s.gold += Math.floor(ROBOTS[target.kind].sendCost / 4) // bounty: 25% of send cost
      s.events.push({ t: 'kill', robot: target.id })
    }
  }
  s.robots = s.robots.filter(r => r.hp > 0)
}

const progress = (s: State, r: Robot) => {
  const i = idx(r.cx, r.cy)
  return s.openDist[i] < INF ? s.openDist[i] : s.breachDist[i]
}
