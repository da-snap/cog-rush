// Draws lanes with PixiJS. Pure view: reads sim state, never changes it.
import { Graphics } from 'pixi.js'
import { COLS, EXIT_ROWS, MC, ROBOTS, ROWS, SPAWN_ROWS, TOWERS, type RobotKind, type TowerKind } from './sim/config.ts'
import { INF, field, pathFrom, towerStats, type FxKind, type Lane, type Tower } from './sim/sim.ts'

// One lookup table from sim type to visual, so placeholder shapes can become sprites later.
export const VIS: { tower: Record<TowerKind, { color: number; icon: string }>; robot: Record<RobotKind, { color: number; r: number; icon: string }> } = {
  tower: {
    gatling: { color: 0x9aa5b1, icon: '⦿' },
    flak: { color: 0x58a6ff, icon: '✈' },
    emp: { color: 0xbc8cff, icon: '◎' },
    mortar: { color: 0xf0883e, icon: '◉' },
    tesla: { color: 0x39d3e8, icon: 'ϟ' },
    laser: { color: 0xff5c8a, icon: '━' },
  },
  robot: {
    scout: { color: 0xf2cc60, r: 0.2, icon: '●' },
    drone: { color: 0x79c0ff, r: 0.24, icon: '▲' },
    repair: { color: 0x56d364, r: 0.26, icon: '✚' },
    shield: { color: 0xbc8cff, r: 0.28, icon: '⬢' },
    tank: { color: 0xff7b72, r: 0.34, icon: '■' },
    splitter: { color: 0xd2a8ff, r: 0.3, icon: '✦' },
    breaker: { color: 0xffa657, r: 0.32, icon: '⬣' },
    colossus: { color: 0xff3b30, r: 0.45, icon: '⬛' },
  },
}
export const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')

export interface Fx { p: number; k: FxKind; tower: TowerKind; x1: number; y1: number; x2: number; y2: number; r: number; until: number }
export interface View { x: number; y: number; cell: number }

export function drawLane(g: Graphics, L: Lane, v: View, o: {
  alpha: number; prev: Map<number, { x: number; y: number }>; fx: Fx[]; now: number
  sel?: { x: number; y: number } | null; preview?: TowerKind | null; drag?: number[]; mini?: boolean
}) {
  const { cell } = v
  const X = (c: number) => v.x + c * cell, Y = (c: number) => v.y + c * cell
  const px = (mc: number) => (mc / MC) * cell

  g.rect(X(0), Y(0), cell * COLS, cell * ROWS).fill(0x161b22)
  g.rect(X(0), Y(0), cell * COLS, cell * SPAWN_ROWS).fill(0x173a26)
  g.rect(X(0), Y(ROWS - EXIT_ROWS), cell * COLS, cell * EXIT_ROWS).fill(0x3d1a20)
  if (!o.mini) {
    for (let x = 0; x <= COLS; x++) g.moveTo(X(x), Y(0)).lineTo(X(x), Y(ROWS))
    for (let y = 0; y <= ROWS; y++) g.moveTo(X(0), Y(y)).lineTo(X(COLS), Y(y))
    g.stroke({ width: 1, color: 0x21262d })
  }
  if (L.sealed) g.rect(X(0), Y(0), cell * COLS, cell * ROWS).stroke({ width: o.mini ? 2 : 4, color: 0xff4d4f })

  // path: current one, or the preview with the selected tower placed
  let towers = L.towers, color = 0x2f81f7
  const s = o.sel
  if (s && o.preview && !L.towers[s.y * COLS + s.x]) {
    towers = L.towers.slice()
    towers[s.y * COLS + s.x] = { kind: o.preview, hp: TOWERS[o.preview].hp * MC } as Tower
    color = 0x58a6ff
  }
  if (o.drag?.length) {
    towers = towers === L.towers ? L.towers.slice() : towers
    for (const i of o.drag) towers[i] = { kind: 'gatling', hp: TOWERS.gatling.hp * MC } as Tower
  }
  const preview = towers !== L.towers
  const open = preview ? field(towers, false) : L.openDist
  const sealed = open[(COLS - 1) / 2] >= INF
  const path = pathFrom(sealed ? (preview ? field(towers, true) : L.breachDist) : open, towers)
  if (sealed) color = 0xff6b6b
  path.forEach((c, i) => {
    const cx = X(c % COLS + 0.5), cy = Y(Math.floor(c / COLS) + 0.5)
    if (i) g.lineTo(cx, cy); else g.moveTo(cx, cy)
  })
  g.stroke({ width: Math.max(2, cell / 10), color, alpha: 0.45 })

  for (const b of L.burns) g.rect(X(b.x), Y(b.y), cell, cell).fill({ color: 0xf0883e, alpha: 0.35 })

  // towers
  for (const t of L.towers) {
    if (!t) continue
    const x = X(t.x), y = Y(t.y), c = VIS.tower[t.kind].color
    g.roundRect(x + 1.5, y + 1.5, cell - 3, cell - 3, cell / 6).fill(0x2d333b).stroke({ width: 1.5, color: c })
    towerGlyph(g, t.kind, x + cell / 2, y + cell / 2, cell * 0.3, c)
    if (!o.mini) {
      for (let l = 1; l < t.level; l++) g.circle(x + cell * (0.2 + 0.15 * (l - 1)), y + cell * 0.18, cell * 0.06).fill(0xffd866)
      if (t.branch) g.circle(x + cell * 0.82, y + cell * 0.18, cell * 0.08).fill(t.branch === TOWERS[t.kind].branches[0].key ? 0x56d364 : 0xff7b72)
    }
    if (t.hp < t.maxHp) g.rect(x + 2, y + cell - 4, (cell - 4) * Math.max(0, t.hp) / t.maxHp, 3).fill(0xf85149)
  }
  for (const i of o.drag ?? []) g.roundRect(X(i % COLS) + 2, Y(Math.floor(i / COLS)) + 2, cell - 4, cell - 4, 4).fill({ color: 0x9aa5b1, alpha: 0.5 })

  // selection + range
  if (s && !o.mini) {
    const t = L.towers[s.y * COLS + s.x]
    g.rect(X(s.x) + 1, Y(s.y) + 1, cell - 2, cell - 2).stroke({ width: 2, color: sealed && !t ? 0xff6b6b : 0xffffff })
    const range = t ? towerStats(t).rangeMc : o.preview ? TOWERS[o.preview].rangeMc : 0
    if (range) g.circle(X(s.x + 0.5), Y(s.y + 0.5), px(range)).fill({ color: 0xffffff, alpha: 0.05 }).stroke({ width: 1, color: 0xffffff, alpha: 0.35 })
  }

  // effects
  for (const f of o.fx) {
    const c = VIS.tower[f.tower].color, a = Math.min(1, (f.until - o.now) / 120)
    if (f.k === 'line') g.moveTo(X(0) + px(f.x1), Y(0) + px(f.y1)).lineTo(X(0) + px(f.x2), Y(0) + px(f.y2)).stroke({ width: 1.5, color: c, alpha: a })
    else if (f.k === 'beam') g.moveTo(X(0) + px(f.x1), Y(0) + px(f.y1)).lineTo(X(0) + px(f.x2), Y(0) + px(f.y2)).stroke({ width: Math.max(2, px(f.r)), color: c, alpha: 0.35 * a })
    else if (f.k === 'boom') g.circle(X(0) + px(f.x2), Y(0) + px(f.y2), px(f.r)).fill({ color: c, alpha: 0.3 * a })
    else g.circle(X(0) + px(f.x2), Y(0) + px(f.y2), px(f.r)).stroke({ width: 2, color: c, alpha: 0.4 * a })
  }

  // robots, interpolated between ticks
  for (const r of L.robots) {
    const p = o.prev.get(r.id) ?? r
    const x = X(0) + px(p.x + (r.x - p.x) * o.alpha), y = Y(0) + px(p.y + (r.y - p.y) * o.alpha)
    const vis = VIS.robot[r.kind], rad = cell * vis.r
    robotGlyph(g, r.kind, x, y, rad, r.owner < 0 ? 0x8b949e : vis.color)
    if (r.shield > 0) g.circle(x, y, rad + 2).stroke({ width: 1.5, color: 0xbc8cff })
    if (r.stun > 0) g.circle(x, y, rad + 3).stroke({ width: 1, color: 0xffffff })
    else if (r.slow > 0) g.circle(x, y, rad + 3).stroke({ width: 1, color: 0xbc8cff, alpha: 0.6 })
    if (!o.mini && r.hp < r.maxHp) {
      g.rect(x - cell * 0.3, y - rad - 5, cell * 0.6, 3).fill(0x30363d)
      g.rect(x - cell * 0.3, y - rad - 5, cell * 0.6 * Math.max(0, r.hp) / r.maxHp, 3).fill(0x3fb950)
    }
  }
}

function towerGlyph(g: Graphics, kind: TowerKind, x: number, y: number, r: number, c: number) {
  switch (kind) {
    case 'gatling': g.circle(x, y, r * 0.7).fill(c); g.rect(x - r * 0.12, y - r * 1.1, r * 0.24, r * 0.6).fill(c); break
    case 'flak': g.poly([x, y - r, x + r, y + r * 0.7, x - r, y + r * 0.7]).fill(c); break
    case 'emp': g.circle(x, y, r * 0.9).stroke({ width: r * 0.3, color: c }); g.circle(x, y, r * 0.25).fill(c); break
    case 'mortar': g.circle(x, y, r).fill(c); g.circle(x, y, r * 0.45).fill(0x2d333b); break
    case 'tesla': g.poly([x - r * 0.2, y - r, x + r * 0.5, y - r * 0.1, x, y, x + r * 0.2, y + r, x - r * 0.5, y + r * 0.1, x, y]).fill(c); break
    case 'laser': g.rect(x - r, y - r * 0.2, r * 2, r * 0.4).fill(c); g.circle(x, y, r * 0.45).fill(c); break
  }
}

function robotGlyph(g: Graphics, kind: RobotKind, x: number, y: number, r: number, c: number) {
  switch (kind) {
    case 'drone': g.poly([x, y + r, x + r, y - r * 0.7, x - r, y - r * 0.7]).fill(c); break
    case 'tank': case 'colossus': g.roundRect(x - r, y - r, r * 2, r * 2, r * 0.3).fill(c); break
    case 'shield': case 'breaker': g.regularPoly(x, y, r, 6).fill(c); break
    case 'splitter': g.star(x, y, 4, r, r * 0.5).fill(c); break
    case 'repair': g.circle(x, y, r).fill(c); g.rect(x - r * 0.6, y - r * 0.15, r * 1.2, r * 0.3).fill(0x161b22); g.rect(x - r * 0.15, y - r * 0.6, r * 0.3, r * 1.2).fill(0x161b22); break
    default: g.circle(x, y, r).fill(c)
  }
}

export const robotColor = (k: RobotKind) => hex(VIS.robot[k].color)
export const robotName = (k: RobotKind) => ROBOTS[k].name
