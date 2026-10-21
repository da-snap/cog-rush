// Run: npm test (node strips the types). Plain asserts, no framework.
import assert from 'node:assert/strict'
import { COLS } from './config.ts'
import { INF, newState, step, wouldSeal, type Cmd, type State } from './sim.ts'

const run = (cmdsAt: Record<number, Cmd[]>, ticks: number): State => {
  const s = newState()
  for (let i = 0; i < ticks; i++) step(s, cmdsAt[i] ?? [])
  return s
}

// 1. A row of towers with one gap is open; filling the gap seals the lane.
{
  const s = newState()
  s.gold = 10_000
  const row: Cmd[] = []
  for (let x = 0; x < COLS - 1; x++) row.push({ t: 'build', x, y: 8, kind: 'gatling' })
  step(s, row)
  assert.equal(s.sealed, false)
  assert.ok(s.openDist[5] < INF)
  assert.equal(wouldSeal(s, COLS - 1, 8), true)
  assert.equal(wouldSeal(s, 3, 12), false)
  step(s, [{ t: 'build', x: COLS - 1, y: 8, kind: 'gatling' }])
  assert.equal(s.sealed, true)
}

// 2. Spawn/exit zones are not buildable.
{
  const s = newState()
  step(s, [{ t: 'build', x: 3, y: 1, kind: 'gatling' }, { t: 'build', x: 3, y: 18, kind: 'gatling' }])
  assert.equal(s.towers.filter(Boolean).length, 0)
}

// 3. Undefended lane: the first wave leaks and costs lives.
{
  const s = run({}, 20 * 60)
  assert.ok(s.lives < 20, `lives ${s.lives}`)
}

// 4. Sealed lane: robots breach the wall, open it again and leaks cost 2 lives.
{
  const s = newState()
  s.gold = 10_000
  const wall: Cmd[] = []
  for (let x = 0; x < COLS; x++) wall.push({ t: 'build', x, y: 15, kind: 'gatling' })
  step(s, wall)
  assert.equal(s.sealed, true)
  let lost = 0
  for (let i = 0; i < 20 * 120; i++) { step(s, []); lost += s.events.filter(e => e.t === 'towerLost').length }
  assert.ok(lost >= 1, 'breach destroyed towers')
  assert.equal(s.sealed, false, 'lane reopened')
}

// 5. Determinism: same commands, same state.
{
  const cmds: Record<number, Cmd[]> = { 5: [{ t: 'build', x: 4, y: 6, kind: 'gatling' }, { t: 'build', x: 6, y: 9, kind: 'gatling' }], 900: [{ t: 'sell', x: 4, y: 6 }] }
  const a = JSON.stringify(run(cmds, 20 * 200)), b = JSON.stringify(run(cmds, 20 * 200))
  assert.equal(a, b)
}

console.log('sim ok')
