// Bot player: reads the game state and returns ordinary commands, exactly like a human's input.
// Deterministic (no randomness), so headless bot-vs-bot runs are reproducible.
import { ARMOR_MULT_PCT, COLS, ROBOTS, ROBOT_KINDS, ROWS, SEND, TICK_HZ, TOWERS, type Armor, type RobotKind, type TowerKind } from './config.ts'
import {
  INF, buildable, canBuild, canFactory, canLoad, canRelease, canUpgrade, factoryCost, opponent, pathFrom, pathLen,
  readyCount, secs, towerStats, upgradeCost, type Cmd, type Game, type Lane, type Tower,
} from './sim.ts'

export interface Strategy {
  name: string
  delay: number // reaction delay in ticks
  defense: number // share of spending on towers, 0..100; -1 = adaptive
  factories: RobotKind[] // build order for the 4 slots
  burst: number // release when this many robots are ready (1 = trickle)
  counter: boolean // pick towers by incoming armor and sends by the opponent's weak spot
  sends?: RobotKind[] // only send these (default: anything unlocked)
  mazeTowers: number // cheap Gatling walls to build before adding damage towers
}

export const DIFFICULTY: Record<'easy' | 'normal' | 'hard', Strategy> = {
  easy: { name: 'Easy', delay: 60, defense: 80, factories: ['tank'], burst: 1, counter: false, mazeTowers: 6 },
  normal: { name: 'Normal', delay: 30, defense: 60, factories: ['tank', 'drone', 'shield'], burst: 4, counter: true, mazeTowers: 10 },
  hard: { name: 'Hard', delay: 10, defense: -1, factories: ['drone', 'tank', 'splitter', 'breaker'], burst: 8, counter: true, mazeTowers: 12 },
}

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
  const share = st.defense >= 0 ? st.defense : Math.min(90, 45 + recentLeaks * 10 + (L.sealed ? 30 : 0))
  const spent = L.stats.towerGold + L.stats.sendGold
  const wantDefense = L.stats.towerGold * 100 <= share * spent || recentLeaks > 2 || t < SEND.prepS

  // release whatever is ready once the burst size is reached (or the wave is full)
  const ready = readyCount(L)
  if (!canRelease(g, L) && (ready >= st.burst || g.tick - mem.lastRelease > 25 * TICK_HZ)) {
    cmds.push({ p, t: 'release' })
    mem.lastRelease = g.tick
  }

  const c = wantDefense ? defend(L, O, st, mem, t, g.tick, g.sendHpBp / 10000) : null
  const s = c ? [] : send(g, L, O, st)
  const d = c ?? (!s.length && L.gold > 300 ? defend(L, O, st, mem, t, g.tick, g.sendHpBp / 10000) : null) // nothing to send: don't sit on gold
  if (d) cmds.push({ p, ...d } as Cmd)
  cmds.push(...s.map(x => ({ p, ...x }) as Cmd))
  return cmds
}

type C = Cmd extends infer T ? T extends Cmd ? Omit<T, 'p'> : never : never

type Threat = 'light' | 'heavy' | 'shielded' | 'air'
const COUNTER: Record<Threat, TowerKind> = { light: 'gatling', heavy: 'mortar', shielded: 'tesla', air: 'flak' }

// What is coming at us: robots seen so far plus the opponent's factories (full visibility).
function threats(O: Lane, mem: BotMem): Record<Threat, number> {
  const w: Record<Threat, number> = { light: mem.armor.light + 50, heavy: mem.armor.heavy, shielded: mem.armor.shielded, air: mem.air }
  for (const k of ROBOT_KINDS) {
    if (k === 'scout' || !O.factories[k]) continue
    w[ROBOTS[k].air ? 'air' : ROBOTS[k].armor] += 150 * O.factories[k]
  }
  return w
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

function defend(L: Lane, O: Lane, st: Strategy, mem: BotMem, t: number, tick: number, hpScale: number): C | null {
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
    } else {
      kind = (['gatling', 'mortar', 'tesla'] as TowerKind[])[towers.length % 3]
    }
  }

  // upgrade the best-placed tower that fights what's coming, once the maze has some length
  if (towers.length >= st.mazeTowers + 4) {
    const fits = (x: Tower) => {
      const d = TOWERS[x.kind]
      if (need === 'air') return d.air ? 100 : 0
      return d.ground ? ARMOR_MULT_PCT[d.dmg][need] : 0
    }
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
  // factories from the plan, one at a time, after the first minute
  const next = st.factories.find(k => !L.factories[k])
  if (next && t > 50 && !canFactory(L, next)) return [{ t: 'factory', kind: next }]
  if (!next && t > 240) { // plan done: upgrade the factories
    const up = st.factories.find(k => L.factories[k] < 3 && !canFactory(L, k) && L.gold > factoryCost(L, k) * 2)
    if (up) return [{ t: 'factory', kind: up }]
  }
  if (st.factories.includes('colossus') && t >= 300 && !L.factories.colossus && !canFactory(L, 'colossus')) return [{ t: 'factory', kind: 'colossus' }]

  // what does the opponent's defense deal to each robot type? send what survives best per gold
  const opp = O.towers.filter((x): x is Tower => !!x).map(x => ({ def: TOWERS[x.kind], dps: towerStats(x).dps }))
  const value = (k: RobotKind) => {
    const r = ROBOTS[k]
    let dps = 1
    for (const o of opp) if (r.air ? o.def.air : o.def.ground) dps += o.dps * ARMOR_MULT_PCT[o.def.dmg][r.armor] / 100
    return (r.hp * 1e6) / dps / r.sendCost
  }
  const kinds = ROBOT_KINDS.filter(k => !canLoad(g, L, k) && (!st.sends || st.sends.includes(k)))
  if (!kinds.length) return []
  const kind = st.counter ? kinds.sort((a, b) => value(b) - value(a))[0] : kinds[kinds.length - 1]
  return [{ t: 'load', kind }]
}
