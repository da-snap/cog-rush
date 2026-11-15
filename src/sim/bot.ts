// Bot player: reads the game state and returns ordinary commands, exactly like a human's input.
// Deterministic (no randomness), so headless bot-vs-bot runs are reproducible.
import { ARMOR_MULT_PCT, COLS, ROBOTS, ROWS, SEND, TICK_HZ, TOWERS, type Armor, type RobotKind, type TowerKind } from './config.ts'
import {
  INF, buildable, canBuild, canFactory, canLoad, canRelease, canUpgrade, factoryCost, factoryLevel, factoryOf, opponent, pathFrom, pathLen,
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
  mazeTowers: number // cheap Gatling walls to build before adding damage towers
  saveAt?: number // from this second on, stop sending to save up for the next planned factory (default 120, the sweet spot in run.ts sweeps)
  upgradeAt?: number // seconds before factory upgrades start (default 240)
}

export const DIFFICULTY: Record<'easy' | 'normal' | 'hard', Strategy> = {
  easy: { name: 'Easy', delay: 60, defense: 80, factories: ['tank'], burst: 1, counter: false, mazeTowers: 6, saveAt: INF },
  normal: { name: 'Normal', delay: 30, defense: 45, factories: ['tank', 'drone', 'shield'], burst: 4, counter: true, mazeTowers: 10 },
  hard: { name: 'Hard', delay: 10, defense: -1, factories: ['tank', 'drone', 'splitter'], burst: 8, counter: true, mazeTowers: 12 },
}

// Bot ladder: named rivals, each one a strategy with a clear counter, ordered from easy to hard.
export const RIVALS: { name: string; blurb: string; st: Strategy }[] = [
  { name: 'Sprocket', blurb: 'Trickles Tanks one by one. Learn to maze.', st: DIFFICULTY.easy },
  { name: 'Ironside', blurb: 'Turtles behind a thick wall. Out-send it.', st: { name: 'Ironside', delay: 40, defense: 85, factories: ['tank', 'shield'], burst: 3, counter: true, mazeTowers: 12 } },
  { name: 'Bolt', blurb: 'Floods you with Scouts. Kinetic beats Light.', st: { name: 'Bolt', delay: 35, defense: 55, factories: [], sends: ['scout'], burst: 12, counter: true, mazeTowers: 10 } },
  { name: 'Skyhook', blurb: 'Drones fly over your maze. Build Flak.', st: { name: 'Skyhook', delay: 30, defense: 55, factories: ['drone'], sends: ['drone', 'scout'], burst: 6, counter: true, mazeTowers: 10 } },
  { name: 'Hive', blurb: 'Splitters with Shield and Repair escorts. EMP jams them.', st: { name: 'Hive', delay: 25, defense: 55, factories: ['splitter', 'shield', 'repair'], sends: ['splitter', 'shield', 'repair', 'scout'], burst: 8, counter: true, mazeTowers: 10 } },
  { name: 'Crusher', blurb: 'Tanks, Breakers, then a Colossus. Explosive beats Heavy.', st: { name: 'Crusher', delay: 20, defense: 55, factories: ['tank', 'breaker', 'colossus'], sends: ['tank', 'breaker', 'colossus'], burst: 5, counter: true, mazeTowers: 10 } },
  { name: 'Blitz', blurb: 'All-in sender with a thin maze. Punish it, then race it.', st: { name: 'Blitz', delay: 15, defense: 35, factories: ['tank'], burst: 6, counter: true, mazeTowers: 6 } },
  { name: 'Overmind', blurb: 'Reads your defense and hits the weakest spot.', st: { ...DIFFICULTY.hard, name: 'Overmind' } },
]

export interface BotMem { seen: Map<number, RobotKind>; armor: Record<Armor, number>; air: number; leaksAt: number[]; leaks: { at: number; kind: RobotKind }[]; lastRelease: number }
export const newMem = (): BotMem => ({ seen: new Map(), armor: { light: 0, heavy: 0, shielded: 0 }, air: 0, leaksAt: [], leaks: [], lastRelease: 0 })

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
  const wantDefense = L.stats.towerGold * 100 <= share * spent || recentLeaks > 2 || t < SEND.prepS

  // release whatever is ready once the burst size is reached (or the wave is full)
  const ready = readyCount(L)
  const full = L.slots.every((f, i) => !f || canLoad(g, L, i) !== null && canLoad(g, L, i) !== 'Not enough gold') // nothing more fits in any queue
  if (!canRelease(g, L) && (ready >= st.burst || full || g.tick - mem.lastRelease > 25 * TICK_HZ)) {
    cmds.push({ p, t: 'release' })
    mem.lastRelease = g.tick
  }

  const c = wantDefense ? defend(L, O, st, mem, t, g.tick, g.sendHpBp / 10000) : null
  const s = c ? [] : send(g, L, O, st)
  const d = c ?? (!s.length && L.gold > 300 ? defend(L, O, st, mem, t, g.tick, g.sendHpBp / 10000) : null) // nothing to send: don't sit on gold
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
  const towers = L.towers.filter((x): x is Tower => !!x)
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

  let kind: TowerKind = 'gatling'
  const walls = towers.filter(x => x.kind === 'gatling').length
  if (walls >= st.mazeTowers) {
    if (st.counter) {
      kind = COUNTER[need]
      if (need === 'light' && t > 300 && towers.filter(x => x.kind === 'laser').length < 2) kind = 'laser'
      if (need === 'shielded' && towers.filter(x => x.kind === 'tesla').length > 3) kind = 'laser'
      if (towers.length > 18 && !towers.some(x => x.kind === 'emp')) kind = 'emp'
      // aura swarm coming: EMP jams Repair/Shield bots and strips shields
      const auras = factoryLevel(O, 'repair') + factoryLevel(O, 'shield')
      if (auras && towers.filter(x => x.kind === 'emp').length < 1 + (auras >> 1)) kind = 'emp'
    } else {
      kind = (['gatling', 'mortar', 'tesla'] as TowerKind[])[towers.length % 3]
    }
  }

  // upgrade the best-placed tower that fights what's coming, once the maze has some length
  const fits = (x: Tower) => {
    const d = TOWERS[x.kind]
    if (need === 'air') return d.air ? 100 : 0
    return d.ground ? ARMOR_MULT_PCT[d.dmg][need] : 0
  }
  if (towers.length >= st.mazeTowers + 4) {
    const best = towers
      .filter(x => x.level < 3 && (x.kind !== 'gatling' || towers.length > 20))
      .map(x => ({ x, score: coverage(x.x, x.y, towerStats(x).rangeMc, need === 'air' ? AIR_PATH : pathSet) * fits(x) }))
      .sort((a, b) => b.score - a.score || a.x.id - b.x.id)[0]
    if (best && best.score > 300) {
      const branch = pickBranch(best.x.kind, need)
      if (!canUpgrade(L, best.x.x, best.x.y, branch)) return { t: 'upgrade', x: best.x.x, y: best.x.y, branch }
      if (L.gold < upgradeCost(best.x) && towers.length >= st.mazeTowers + 8) return null // save up for it
    }
  }

  // place: prefer cells that lengthen the path, then cells that cover lots of path
  const range = TOWERS[kind].rangeMc
  const route = kind === 'flak' ? AIR_PATH : pathSet
  let bestCell = -1, bestScore = -INF
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (!buildable(x, y) || canBuild(L, x, y, kind)) continue
    const i = y * COLS + x
    L.towers[i] = { id: 0 } as Tower
    const len = pathLen(L.towers)
    L.towers[i] = null
    if (len >= INF) continue // never seal
    const gain = len - cur
    const score = kind === 'gatling' ? gain * 100 + coverage(x, y, range, pathSet) - (pathSet.has(i) ? 0 : 5) : coverage(x, y, range, route) * 10 + gain * 20
    if (score > bestScore) { bestScore = score; bestCell = i }
  }
  // lane full: swap a level-1 tower that's weak against what's coming for one that counters it (same cell, maze unchanged)
  if (bestCell < 0 && st.counter && kind !== 'gatling') {
    const swap = towers
      .filter(x => x.level === 1 && x.kind !== kind && fits(x) <= 50)
      .sort((a, b) => coverage(b.x, b.y, TOWERS[kind].rangeMc, route) - coverage(a.x, a.y, TOWERS[kind].rangeMc, route) || a.id - b.id)[0]
    if (swap && L.gold + sellValue(swap) >= TOWERS[kind].cost) return [{ t: 'sell', x: swap.x, y: swap.y }, { t: 'build', x: swap.x, y: swap.y, kind }]
  }
  if (bestCell < 0) return null
  return { t: 'build', x: bestCell % COLS, y: (bestCell / COLS) | 0, kind }
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
