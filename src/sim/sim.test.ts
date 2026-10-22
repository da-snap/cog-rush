// Run: npm test (node strips the types). Plain asserts, no framework.
import assert from 'node:assert/strict'
import { AURA, COLS, MC, ROBOTS, TICK_HZ, type RobotKind, type TowerKind } from './config.ts'
import { INF, damage, newGame, spawn, step, towerStats, wouldSeal, type Cmd, type Game, type Lane } from './sim.ts'

type C = Cmd extends infer T ? T extends Cmd ? Omit<T, 'p'> : never : never
const at = (p: number, cs: C[]) => cs.map(c => ({ ...c, p }) as Cmd)
const game = () => { const g = newGame(); return { g, L: g.lanes[0] } }
// step without waves or income: pins the clock just after prep
const quiet = (g: Game, cmds: Cmd[] = []) => { g.tick = 21 * TICK_HZ + 1; step(g, cmds) }
const put = (g: Game, L: Lane, kind: RobotKind, x: number, y: number, hp = 100 * MC) => {
  const r = spawn(g, L, { kind, hp, owner: -1 }, Math.floor(x), y)
  r.x = x * MC + 500; r.y = y * MC + 500
  return r
}

// 1. A row of towers with one gap is open; filling the gap seals the lane.
{
  const { g, L } = game()
  L.gold = 10_000
  const row: C[] = []
  for (let x = 0; x < COLS - 1; x++) row.push({ t: 'build', x, y: 8, kind: 'gatling' })
  step(g, at(0, row))
  assert.equal(L.sealed, false)
  assert.ok(L.openDist[5] < INF)
  assert.equal(wouldSeal(L, COLS - 1, 8), true)
  assert.equal(wouldSeal(L, 3, 12), false)
  step(g, at(0, [{ t: 'build', x: COLS - 1, y: 8, kind: 'gatling' }]))
  assert.equal(L.sealed, true)
}

// 2. Spawn/exit zones are not buildable.
{
  const { g, L } = game()
  step(g, at(0, [{ t: 'build', x: 3, y: 1, kind: 'gatling' }, { t: 'build', x: 3, y: 18, kind: 'gatling' }]))
  assert.equal(L.towers.filter(Boolean).length, 0)
}

// 3. Undefended lanes: the first neutral wave leaks in both.
{
  const { g } = game()
  for (let i = 0; i < 20 * 60; i++) step(g, [])
  assert.ok(g.lanes.every(L => L.lives < 20))
}

// 4. Sealed lane: robots breach the wall, open it again and leaks cost 2 lives.
{
  const { g, L } = game()
  L.gold = 10_000
  const wall: C[] = []
  for (let x = 0; x < COLS; x++) wall.push({ t: 'build', x, y: 15, kind: 'gatling' })
  step(g, at(0, wall))
  assert.equal(L.sealed, true)
  for (let i = 0; i < 5; i++) spawn(g, L, { kind: 'tank', hp: 1e9, owner: -1 }, 5, i)
  let lost = 0
  for (let i = 0; i < 20 * 120; i++) { step(g, []); lost += g.events.filter(e => e.t === 'towerLost').length }
  assert.ok(lost >= 1, 'breach destroyed towers')
  assert.equal(L.sealed, false, 'lane reopened')
}

// 5. Determinism: same commands, same state.
{
  const cmds: Record<number, Cmd[]> = {
    5: at(0, [{ t: 'build', x: 4, y: 6, kind: 'gatling' }, { t: 'build', x: 6, y: 9, kind: 'mortar' }]),
    6: at(1, [{ t: 'load', kind: 'scout' }, { t: 'load', kind: 'scout' }]),
    500: at(1, [{ t: 'release' }]), 900: at(0, [{ t: 'sell', x: 4, y: 6 }]),
  }
  const run = () => { const g = newGame(); for (let i = 0; i < 20 * 200; i++) step(g, cmds[i] ?? []); return JSON.stringify(g) }
  assert.equal(run(), run())
}

// 6. Damage triangle, armor-piercing, overload, shields.
{
  const { g, L } = game()
  const lost = (kind: RobotKind, type: 'kinetic' | 'explosive' | 'energy', pierce = false, amp = 100, shield = 0) => {
    const r = put(g, L, kind, 5, 5, 10_000); r.amp = amp; r.shield = shield
    damage(g, L, r, 1000, type, pierce)
    return 10_000 - r.hp
  }
  assert.equal(lost('scout', 'kinetic'), 1500)
  assert.equal(lost('shield', 'kinetic'), 500)
  assert.equal(lost('tank', 'explosive'), 1500)
  assert.equal(lost('shield', 'energy'), 1500)
  assert.equal(lost('tank', 'energy'), 500)
  assert.equal(lost('shield', 'kinetic', true), 1000)
  assert.equal(lost('scout', 'energy', false, 125), 1250)
  assert.equal(lost('scout', 'energy', false, 100, 400), 600)
}

// 7. Upgrades: cost 1x then 2x base, L3 needs a branch, stats compound, sell refunds upgrades too.
{
  const { g, L } = game()
  L.gold = 1000
  step(g, at(0, [{ t: 'build', x: 3, y: 5, kind: 'gatling' }, { t: 'upgrade', x: 3, y: 5 }, { t: 'upgrade', x: 3, y: 5 }]))
  const t = L.towers[5 * COLS + 3]!
  assert.equal(t.level, 2, 'L3 without a branch is rejected')
  step(g, at(0, [{ t: 'upgrade', x: 3, y: 5, branch: 'overdrive' }]))
  assert.equal(t.level, 3)
  assert.equal(t.invested, 25 + 25 + 50)
  assert.equal(t.maxHp, 390 * MC)
  const st = towerStats(t)
  assert.equal(st.rangeMc, 3630)
  assert.equal(st.dps, Math.floor(15 * 256 / 100 * 180 / 100 * MC))
  const gold = L.gold
  step(g, at(0, [{ t: 'sell', x: 3, y: 5 }]))
  assert.equal(L.gold - gold, 75)
}

// 8. Each attack type, with stunned robots parked next to a tower.
{
  const near = (kind: TowerKind, branch: string | null, robots: [RobotKind, number, number][], ty = 10) => {
    const { g, L } = game()
    L.gold = 10_000
    step(g, at(0, [{ t: 'build', x: 5, y: ty, kind }]))
    const t = L.towers[ty * COLS + 5]!
    if (branch) { t.level = 3; t.branch = branch }
    const rs = robots.map(([k, x, y]) => put(g, L, k, x, y))
    for (const r of rs) r.stun = 1000 // hold still
    for (let i = 0; i < 20; i++) quiet(g)
    return rs.map(r => r.hp < 100 * MC)
  }
  const column: [RobotKind, number, number][] = [['scout', 5, 8], ['scout', 5, 7], ['scout', 5, 6], ['scout', 5, 5]]
  assert.deepEqual(near('gatling', null, [['scout', 5, 8], ['scout', 0, 3]]), [true, false], 'single target in range only')
  assert.deepEqual(near('flak', null, [['scout', 5, 8], ['drone', 6, 8]]), [false, true], 'flak hits air only')
  assert.deepEqual(near('mortar', null, [['scout', 5, 7], ['tank', 5, 8], ['drone', 5, 7]]), [true, true, false], 'mortar splash, ground only')
  assert.deepEqual(near('emp', null, [['scout', 5, 8], ['drone', 6, 9], ['tank', 5, 4]]), [true, true, false], 'emp aura')
  assert.equal(near('tesla', null, column).filter(Boolean).length, 3, 'tesla chains to 3')
  assert.equal(near('tesla', 'chain5', column).filter(Boolean).length, 4, 'chain 5')
  // laser at (5,4) aims at the robot closest to the exit, (5,8), and pierces through (5,6)
  const beam: [RobotKind, number, number][] = [['scout', 5, 8], ['scout', 5, 6], ['scout', 7, 6], ['scout', 5.4, 7]]
  assert.deepEqual(near('laser', null, beam, 4), [true, true, false, false], 'laser pierces a line')
  assert.deepEqual(near('laser', 'wide', beam, 4), [true, true, false, true], 'wide beam')
}

// 9. EMP slows; stun pulse stops robots.
{
  const { g, L } = game()
  L.gold = 10_000
  step(g, at(0, [{ t: 'build', x: 4, y: 8, kind: 'emp' }]))
  const r = put(g, L, 'tank', 5, 8, 10_000 * MC)
  quiet(g)
  assert.equal(r.slow, 40)
  const t = L.towers[8 * COLS + 4]!
  t.level = 3; t.branch = 'stun'
  for (let i = 0; i < 100; i++) quiet(g)
  assert.ok(r.stun > 0, 'stunned')
}

// 10. GDD: "two level-3 towers of one type beat four mixed level-1 towers" against their matching armor.
{
  const trial = (towers: [TowerKind, number, string?][], robot: RobotKind) => {
    const { g, L } = game()
    L.gold = 1e6
    const spots = [[4, 8], [6, 8], [4, 11], [6, 11]] // beside the straight path down column 5
    const cmds: C[] = []
    towers.forEach(([kind, lvl, branch], i) => {
      const [x, y] = spots[i]
      cmds.push({ t: 'build', x, y, kind })
      for (let l = 1; l < lvl; l++) cmds.push({ t: 'upgrade', x, y, branch })
    })
    step(g, at(0, cmds))
    let leaks = 0
    for (let i = 0; i < 800; i++) {
      if (i % 10 === 0 && i < 200) spawn(g, L, { kind: robot, hp: 300 * MC, owner: -1 })
      quiet(g)
      leaks += g.events.filter(e => e.t === 'leak' && e.p === 0).length
    }
    return leaks
  }
  const mixed: [TowerKind, number][] = [['gatling', 1], ['mortar', 1], ['tesla', 1], ['laser', 1]]
  for (const [kind, branch, robot] of [['gatling', 'overdrive', 'scout'], ['mortar', 'burn', 'tank'], ['tesla', 'chain5', 'shield'], ['laser', 'wide', 'shield']] as const) {
    const vs = trial(mixed, robot), spec = trial([[kind, 3, branch], [kind, 3, branch]], robot)
    assert.ok(spec < vs, `${kind}/${branch} vs ${robot}: ${spec} leaks, mixed ${vs}`)
  }
}

// 11. Sending: factories, queue build time, prep lock, preview, income, leak gold, bounty.
{
  const { g, L } = game()
  const R = g.lanes[1]
  L.gold = 10_000
  step(g, at(0, [{ t: 'factory', kind: 'tank' }, { t: 'load', kind: 'tank' }, { t: 'load', kind: 'scout' }]))
  assert.equal(L.factories.tank, 1)
  assert.equal(L.queue.length, 2)
  step(g, at(0, [{ t: 'release' }]))
  assert.equal(L.queue.length, 2, 'nothing ready and still in prep')
  while (g.tick < 21 * TICK_HZ) step(g, [])
  assert.equal(L.queue.filter(q => q.left === 0).length, 2, 'both built after 6 s')
  const income = L.income
  step(g, at(0, [{ t: 'release' }]))
  assert.equal(L.income, income + ROBOTS.tank.income + ROBOTS.scout.income)
  assert.equal(R.incoming.length, 1)
  for (let i = 0; i < 4 * TICK_HZ + 1; i++) step(g, [])
  assert.equal(R.incoming.length, 0, 'landed after the 4 s preview')
  assert.ok(R.robots.some(r => r.owner === 0 && r.kind === 'tank'))
  const gold = L.gold
  const before = R.lives
  for (let i = 0; i < 40 * TICK_HZ && R.lives === before; i++) step(g, [])
  assert.ok(L.gold - gold >= Math.floor(ROBOTS.scout.sendCost / 2), 'leak pays the sender')
}

// 12. Factory slots, demolish, wave cap, colossus gate.
{
  const { g, L } = game()
  L.gold = 100_000
  step(g, at(0, (['drone', 'repair', 'shield', 'tank', 'splitter'] as RobotKind[]).map(kind => ({ t: 'factory', kind }) as C)))
  assert.equal(L.factories.splitter, 0, 'only 4 slots')
  step(g, at(0, [{ t: 'demolish', kind: 'drone' }, { t: 'factory', kind: 'splitter' }, { t: 'factory', kind: 'splitter' }]))
  assert.equal(L.factories.drone, 0)
  assert.equal(L.factories.splitter, 2)
  step(g, at(0, Array.from({ length: 10 }, () => ({ t: 'load', kind: 'splitter' }) as C)))
  assert.equal(L.queue.length, 4, 'L2 wave cap is 3 * 1.5')
  step(g, at(0, [{ t: 'demolish', kind: 'tank' }, { t: 'factory', kind: 'colossus' }, { t: 'load', kind: 'colossus' }]))
  assert.equal(L.queue.length, 4, 'colossus locked before 5:00')
}

// 13. Splitter splits into 3 Scouts; Shield bot shields; Repair heals.
{
  const { g, L } = game()
  const sp = put(g, L, 'splitter', 5, 5)
  damage(g, L, sp, 1e9, 'energy')
  assert.equal(L.robots.filter(r => r.kind === 'scout' && r.hp > 0).length, 3)
  const { g: g2, L: L2 } = game()
  put(g2, L2, 'shield', 5, 5)
  const a = put(g2, L2, 'tank', 5, 6, 100 * MC)
  put(g2, L2, 'repair', 6, 6)
  a.hp = 50 * MC
  quiet(g2)
  assert.equal(a.shield, Math.floor(a.maxHp * AURA.shieldPct / 100))
  assert.ok(a.hp > 50 * MC)
}

// 14. A match ends when a lane runs out of lives.
{
  const { g } = game()
  g.lanes[1].lives = 1
  for (let i = 0; i < 60 * TICK_HZ && g.winner === -1; i++) step(g, [])
  assert.notEqual(g.winner, -1)
}

console.log('sim ok')
