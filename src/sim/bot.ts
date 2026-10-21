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

export interface BotMem { seen: Set<number>; armor: Record<Armor, number>; air: number; leaksAt: number[]; lastRelease: number }
export const newMem = (): BotMem => ({ seen: new Set(), armor: { light: 0, heavy: 0, shielded: 0 }, air: 0, leaksAt: [], lastRelease: 0 })

const COUNTER: Record<Armor, TowerKind> = { light: 'gatling', heavy: 'mortar', shielded: 'tesla' }

export function botThink(g: Game, p: number, st: Strategy, mem: BotMem): Cmd[] {
  const L = g.lanes[p], O = g.lanes[opponent(g, p)]
  // memory: what has been sent at us (counted once per robot)
  for (const r of L.robots) {
    if (r.owner < 0 || mem.seen.has(r.id)) continue
    mem.seen.add(r.id)
    const w = ROBOTS[r.kind].sendCost
    if (ROBOTS[r.kind].air) mem.air += w
    else mem.armor[ROBOTS[r.kind].armor] += w
  }
  for (const e of g.events) if (e.t === 'leak' && e.p === p) mem.leaksAt.push(g.tick)
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

  const c = wantDefense ? defend(L, st, mem, t) : null
  if (c) cmds.push({ p, ...c } as Cmd)
  else cmds.push(...send(g, L, O, st).map(c => ({ p, ...c }) as Cmd))
  return cmds
}

type C = Cmd extends infer T ? T extends Cmd ? Omit<T, 'p'> : never : never

function defend(L: Lane, st: Strategy, mem: BotMem, t: number): C | null {
  const towers = L.towers.filter((x): x is Tower => !!x)
  const cur = pathLen(L.towers)
  const path = pathFrom(L.openDist, L.towers)
  const pathSet = new Set(path)

  // which tower to add next
  let kind: TowerKind = 'gatling'
  const walls = towers.filter(x => x.kind === 'gatling').length
  if (walls >= st.mazeTowers) {
    if (st.counter) {
      const air = mem.air, top = (Object.entries(mem.armor) as [Armor, number][]).sort((a, b) => b[1] - a[1])[0]
      const airDps = towers.filter(x => TOWERS[x.kind].air).reduce((a, x) => a + towerStats(x).dps, 0)
      kind = air > 0 && airDps < air * 2_000 ? 'flak' : top[1] > 0 ? COUNTER[top[0]] : 'gatling'
      if (towers.length > 16 && !towers.some(x => x.kind === 'emp')) kind = 'emp'
      if (t > 360 && towers.filter(x => x.kind === 'laser').length < 2) kind = 'laser'
    } else {
      kind = (['gatling', 'mortar', 'tesla'] as TowerKind[])[towers.length % 3]
    }
  }

  // upgrade the best-placed damage tower once the maze is long enough and the lane is full-ish
  if (towers.length >= st.mazeTowers + 4) {
    const best = towers
      .filter(x => x.level < 3 && (x.kind !== 'gatling' || towers.length > 20))
      .map(x => ({ x, cover: coverage(x.x, x.y, towerStats(x).rangeMc, pathSet) }))
      .sort((a, b) => b.cover - a.cover || a.x.id - b.x.id)[0]
    if (best && best.cover > 3) {
      const branch = pickBranch(best.x.kind, mem)
      if (!canUpgrade(L, best.x.x, best.x.y, branch)) return { t: 'upgrade', x: best.x.x, y: best.x.y, branch }
      if (L.gold < upgradeCost(best.x) && towers.length >= st.mazeTowers + 8) return null // save up for it
    }
  }

  // place: prefer cells that lengthen the path, then cells that cover lots of path
  const range = TOWERS[kind].rangeMc
  let bestCell = -1, bestScore = -INF
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (!buildable(x, y) || canBuild(L, x, y, kind)) continue
    const i = y * COLS + x
    L.towers[i] = { id: 0 } as Tower
    const len = pathLen(L.towers)
    L.towers[i] = null
    if (len >= INF) continue // never seal
    const gain = len - cur
    const score = kind === 'gatling' ? gain * 100 + coverage(x, y, range, pathSet) - (pathSet.has(i) ? 0 : 5) : coverage(x, y, range, pathSet) * 10 + gain * 20
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

function pickBranch(kind: TowerKind, mem: BotMem): string {
  const top = (Object.entries(mem.armor) as [Armor, number][]).sort((a, b) => b[1] - a[1])[0][0]
  const b = TOWERS[kind].branches
  switch (kind) {
    case 'gatling': return top === 'light' ? 'overdrive' : 'pierce'
    case 'mortar': return top === 'heavy' ? 'burn' : 'cluster'
    case 'tesla': return top === 'light' ? 'chain5' : 'arcFocus'
    case 'laser': return top === 'heavy' ? 'melt' : 'wide'
    case 'emp': return 'overload'
    default: return b[1].key
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
