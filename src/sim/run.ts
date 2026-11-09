// Headless bot-vs-bot runner for balancing: node src/sim/run.ts [minutes]
import { LIVES, SUDDEN, TICK_HZ, TOWER_KINDS } from './config.ts'
import { DIFFICULTY, botThink, newMem, type Strategy } from './bot.ts'
import { newGame, step, type Tower } from './sim.ts'

export const STRATEGIES: Strategy[] = [
  DIFFICULTY.easy, DIFFICULTY.normal, DIFFICULTY.hard,
  { name: 'Turtle', delay: 10, defense: 85, factories: ['tank', 'shield'], burst: 3, counter: true, mazeTowers: 12 },
  { name: 'Rush', delay: 10, defense: 35, factories: ['tank'], burst: 6, counter: true, mazeTowers: 6 },
  { name: 'Air', delay: 10, defense: 55, factories: ['drone'], sends: ['drone', 'scout'], burst: 6, counter: true, mazeTowers: 10 },
  { name: 'Heavy', delay: 10, defense: 55, factories: ['tank', 'breaker', 'colossus'], sends: ['tank', 'breaker', 'colossus'], burst: 5, counter: true, mazeTowers: 10 },
  { name: 'Swarm', delay: 10, defense: 55, factories: ['splitter', 'shield', 'repair'], sends: ['splitter', 'shield', 'repair', 'scout'], burst: 8, counter: true, mazeTowers: 10 },
  { name: 'Scouts', delay: 10, defense: 55, factories: [], sends: ['scout'], burst: 12, counter: true, mazeTowers: 10 },
]

// fun metrics (see the plan doc): when the first life is lost, how often the lead in lives changes hands
export function match(a: Strategy, b: Strategy, maxMin = 20) {
  const g = newGame()
  const mems = [newMem(), newMem()], st = [a, b]
  let firstLoss = -1, leader = 0, swaps = 0
  while (g.winner === -1 && g.tick < maxMin * 60 * TICK_HZ) {
    step(g, [0, 1].flatMap(p => botThink(g, p, st[p], mems[p])))
    const [x, y] = g.lanes.map(L => L.lives)
    if (firstLoss < 0 && (x < LIVES || y < LIVES)) firstLoss = g.tick
    const lead = Math.sign(x - y)
    if (lead && leader && lead !== leader) swaps++
    if (lead) leader = lead
  }
  return Object.assign(g, { fun: { firstLoss, swaps } })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const wins = new Map<string, number>(), games = new Map<string, number>(), lens: number[] = []
  const towerUse = new Map<string, number>()
  const firsts: number[] = [], swaps: number[] = [], incomes: number[] = []
  let early = 0
  const rows: string[] = []
  // each pairing plays 3 times with slightly different reaction delays, so one lucky timing doesn't decide it
  for (const a0 of STRATEGIES) for (const b0 of STRATEGIES) for (const j of [0, 3, 7]) {
    if (a0 === b0) continue
    const a = { ...a0, delay: a0.delay + j }, b = { ...b0, delay: b0.delay + (j ? 10 - j : 0) }
    const g = match(a, b, Number(process.argv[2] ?? 20))
    const w = g.winner === 0 ? a.name : g.winner === 1 ? b.name : 'draw'
    for (const s of [a, b]) games.set(s.name, (games.get(s.name) ?? 0) + 1)
    wins.set(w, (wins.get(w) ?? 0) + 1)
    lens.push(g.tick / TICK_HZ / 60)
    firsts.push(g.fun.firstLoss < 0 ? Infinity : g.fun.firstLoss / TICK_HZ / 60); swaps.push(g.fun.swaps)
    incomes.push(Math.max(...g.lanes.map(L => L.income)))
    if (g.winner >= 0 && g.tick < SUDDEN.fromS * TICK_HZ) early++
    for (const L of g.lanes) for (const t of L.towers.filter((x): x is Tower => !!x)) towerUse.set(t.kind, (towerUse.get(t.kind) ?? 0) + t.invested)
    if (!j) rows.push(`${a.name.padEnd(7)} vs ${b.name.padEnd(7)} → ${w.padEnd(7)} ${(g.tick / TICK_HZ / 60).toFixed(1)} min, lives ${g.lanes[0].lives}:${g.lanes[1].lives}, sent ${g.lanes[0].stats.sent}:${g.lanes[1].stats.sent}, income ${g.lanes[0].income}:${g.lanes[1].income}`)
  }
  console.log(rows.join('\n'))
  console.log('\nwin rate:', STRATEGIES.map(s => `${s.name} ${Math.round(100 * (wins.get(s.name) ?? 0) / games.get(s.name)!)}%`).join(', '), `draws ${wins.get('draw') ?? 0}`)
  lens.sort((x, y) => x - y)
  console.log('match length median', lens[lens.length >> 1].toFixed(1), 'min, range', lens[0].toFixed(1), '-', lens[lens.length - 1].toFixed(1))
  const total = [...towerUse.values()].reduce((x, y) => x + y, 0)
  console.log('tower share of gold:', TOWER_KINDS.map(k => `${k} ${Math.round(100 * (towerUse.get(k) ?? 0) / total)}%`).join(', '))
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]
  const mmss = (m: number) => `${Math.floor(m)}:${String(Math.round((m % 1) * 60)).padStart(2, '0')}`
  console.log(`fun: first life lost median ${mmss(med(firsts))}, decided before sudden death ${Math.round(100 * early / lens.length)}%, lead changes avg ${(swaps.reduce((x, y) => x + y, 0) / swaps.length).toFixed(1)}, end income median +${med(incomes)}`)
}
