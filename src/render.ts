// Draws lanes with PixiJS. Pure view: reads sim state, never changes it.
// Look: CogRush Design System (industrial drone warfare: chamfers, hazard amber, mono type, stroke icons).
import { Graphics, GraphicsPath } from 'pixi.js'
import { COLS, EXIT_ROWS, MC, ROBOTS, ROWS, SPAWN_ROWS, TOWERS, type Armor, type DamageType, type RobotKind, type TowerKind } from './sim/config.ts'
import { INF, field, pathFrom, towerStats, type FxKind, type Lane, type Tower } from './sim/sim.ts'

// Design-system tokens
export const C = {
  void: 0x0b0d10, hull: 0x14171c, plate: 0x1c2027, seam: 0x2a3038, seam2: 0x3a424d, groove: 0x20252c,
  dust: 0x9ba3ae, white: 0xeceef1, hazard: 0xffc42e, hazardDeep: 0xd99a00, rogue: 0xff5468, online: 0x8ce66b,
  gold: 0xf2d58a, offline: 0x4a525e, board: 0x12151a, drop: 0x10161a, core: 0x1a1014,
}
export const DMG_COLOR: Record<DamageType, number> = { kinetic: 0xd9dee5, explosive: 0xff6b2c, energy: 0x3be3cf }
export const ARMOR_COLOR: Record<Armor, number> = { light: 0xd9dee5, heavy: 0xff6b2c, shielded: 0x3be3cf }

// 24px stroke icons from the design system: towers have a round core, robots wear their armor silhouette.
export const TOWER_ICON: Record<TowerKind, string> = {
  gatling: 'M7 14a5 5 0 1 0 10 0a5 5 0 1 0 -10 0M10 9V3M14 9V3',
  flak: 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3 3M19 5l-3 3',
  emp: 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M4.5 7.5a9 9 0 0 1 15 0M4.5 16.5a9 9 0 0 0 15 0',
  mortar: 'M6 19a6 6 0 0 1 12 0zM12 13l5-8M15 3l4 2.5',
  tesla: 'M8 21a4 4 0 0 1 8 0zM12 17v-5M14 2l-4 6h4l-2 4',
  laser: 'M3 14a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M11 14h10M17 10v8',
}
export const ROBOT_ICON: Record<RobotKind, string> = {
  scout: 'M12 4 21 20H3zM12 13v2',
  drone: 'M12 7 19 19H5zM3 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M17 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  repair: 'M12 4 21 20H3zM12 11v6M9 14h6',
  shield: 'M12 2 21 7v10l-9 5-9-5V7zM8 11a5 5 0 0 1 8 0',
  tank: 'M4 6h16v12H4zM4 10h16M8 14h8',
  splitter: 'M12 2 21 7v10l-9 5-9-5V7zM12 2v20',
  breaker: 'M4 4h16v16H4zM8 8l8 4-8 4z',
  colossus: 'M4 4h16v16H4zM8 8h8v8H8z',
}
const SIZE: Record<RobotKind, number> = { scout: 0.5, drone: 0.55, repair: 0.55, shield: 0.6, tank: 0.62, splitter: 0.6, breaker: 0.62, colossus: 0.9 }
const PATHS = new Map<string, GraphicsPath>()
const iconPath = (d: string) => { let p = PATHS.get(d); if (!p) PATHS.set(d, p = new GraphicsPath(d)); return p }

export const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
export const towerColor = (k: TowerKind) => DMG_COLOR[TOWERS[k].dmg]
export const robotColor = (k: RobotKind) => ARMOR_COLOR[ROBOTS[k].armor]
/** Inline SVG for HTML panels, same icons as the board. */
export const svgIcon = (d: string, color: number, size = 22) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${hex(color)}" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="${d}"/></svg>`

export interface Fx { p: number; k: FxKind; tower: TowerKind; x1: number; y1: number; x2: number; y2: number; r: number; until: number }
export interface View { x: number; y: number; cell: number }

// --- small drawing helpers -----------------------------------------------------

function icon(g: Graphics, d: string, cx: number, cy: number, size: number, color: number, alpha = 1, fill?: number) {
  const s = size / 24
  g.save().setTransform(s, 0, 0, s, cx - size / 2, cy - size / 2)
  g.path(iconPath(d))
  if (fill !== undefined) g.fill(fill)
  g.stroke({ width: 2.4, color, alpha, cap: 'square', join: 'miter' })
  g.restore()
}

/** Chamfered plate: top-left and bottom-right corners cut. */
const chamfer = (g: Graphics, x: number, y: number, w: number, h: number, c: number) =>
  g.poly([x + c, y, x + w, y, x + w, y + h - c, x + w - c, y + h, x, y + h, x, y + c])

/** 135° hatching clipped to a rect. */
function hatch(g: Graphics, x0: number, y0: number, w: number, h: number, color: number, alpha: number) {
  for (let cx = x0; cx < x0 + w + h; cx += 14) {
    const s0 = Math.max(0, cx - (x0 + w)), s1 = Math.min(h, cx - x0)
    if (s1 > s0) g.moveTo(cx - s0, y0 + s0).lineTo(cx - s1, y0 + s1)
  }
  g.stroke({ width: 4, color, alpha })
}

/** Dashed polyline. */
function dashed(g: Graphics, pts: [number, number][], dash: number, gap: number) {
  let on = true, left = dash
  for (let i = 1; i < pts.length; i++) {
    let [x, y] = pts[i - 1]
    const [x2, y2] = pts[i]
    let seg = Math.hypot(x2 - x, y2 - y)
    const ux = (x2 - x) / (seg || 1), uy = (y2 - y) / (seg || 1)
    while (seg > 0) {
      const step = Math.min(left, seg)
      if (on) g.moveTo(x, y).lineTo(x + ux * step, y + uy * step)
      x += ux * step; y += uy * step; seg -= step; left -= step
      if (left <= 0) { on = !on; left = on ? dash : gap }
    }
  }
}

// --- lane --------------------------------------------------------------------

export function drawLane(g: Graphics, L: Lane, v: View, o: {
  alpha: number; prev: Map<number, { x: number; y: number }>; fx: Fx[]; now: number; me: number
  sel?: { x: number; y: number } | null; preview?: TowerKind | null; drag?: number[]; dragKind?: TowerKind; mini?: boolean
}) {
  const { cell } = v
  const X = (c: number) => v.x + c * cell, Y = (c: number) => v.y + c * cell
  const px = (mc: number) => (mc / MC) * cell
  const W = cell * COLS

  // board: build grid, drop zone (lime hatch) on top, core zone (crimson hatch) at the bottom
  g.rect(X(0), Y(0), W, cell * ROWS).fill(C.board)
  g.rect(X(0), Y(0), W, cell * SPAWN_ROWS).fill(C.drop)
  g.rect(X(0), Y(ROWS - EXIT_ROWS), W, cell * EXIT_ROWS).fill(C.core)
  if (!o.mini) {
    hatch(g, X(0), Y(0), W, cell * SPAWN_ROWS, C.online, 0.16)
    hatch(g, X(0), Y(ROWS - EXIT_ROWS), W, cell * EXIT_ROWS, C.rogue, 0.18)
    for (let x = 0; x <= COLS; x++) g.moveTo(X(x), Y(0)).lineTo(X(x), Y(ROWS))
    for (let y = 0; y <= ROWS; y++) g.moveTo(X(0), Y(y)).lineTo(X(COLS), Y(y))
    g.stroke({ width: 1, color: C.groove })
  }
  g.rect(X(0), Y(0), W, cell * ROWS).stroke({ width: L.sealed ? (o.mini ? 2 : 3) : 1, color: L.sealed ? C.rogue : C.seam })

  // route: current one, or the preview with the selected tower / dragged row placed
  let towers = L.towers
  const s = o.sel
  if (s && o.preview && !L.towers[s.y * COLS + s.x]) {
    towers = L.towers.slice()
    towers[s.y * COLS + s.x] = { kind: o.preview, hp: TOWERS[o.preview].hp * MC } as Tower
  }
  if (o.drag?.length) {
    towers = towers === L.towers ? L.towers.slice() : towers
    for (const i of o.drag) towers[i] = { kind: o.dragKind ?? 'gatling', hp: TOWERS.gatling.hp * MC } as Tower
  }
  const preview = towers !== L.towers
  const open = preview ? field(towers, false) : L.openDist
  const sealed = open[(COLS - 1) / 2] >= INF
  const path = pathFrom(sealed ? (preview ? field(towers, true) : L.breachDist) : open, towers)
  const pts = path.map(c => [X(c % COLS + 0.5), Y(Math.floor(c / COLS) + 0.5)] as [number, number])
  if (o.mini) { pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke({ width: 1, color: sealed ? C.rogue : C.hazard, alpha: 0.7 }) }
  else { dashed(g, pts, cell * 0.36, cell * 0.22); g.stroke({ width: Math.max(2, cell / 11), color: sealed ? C.rogue : C.hazard, alpha: 0.7 }) }

  for (const b of L.burns) g.rect(X(b.x), Y(b.y), cell, cell).fill({ color: DMG_COLOR.explosive, alpha: 0.3 })

  // towers: 1-cell chamfered plate, glyph tinted by damage type, level pips in hazard amber
  for (const t of L.towers) {
    if (!t) continue
    const x = X(t.x), y = Y(t.y)
    chamfer(g, x + 1, y + 1, cell - 2, cell - 2, Math.max(2, cell / 8)).fill(C.plate).stroke({ width: 1, color: C.seam2 })
    if (o.mini) continue
    icon(g, TOWER_ICON[t.kind], x + cell / 2, y + cell / 2, cell * 0.66, towerColor(t.kind))
    for (let l = 1; l < t.level; l++) g.rect(x + cell * (0.12 + 0.14 * (l - 1)), y + cell * 0.1, cell * 0.1, cell * 0.1).fill(C.hazard)
    if (t.branch) g.rect(x + cell * 0.78, y + cell * 0.1, cell * 0.12, cell * 0.12).fill(t.branch === TOWERS[t.kind].branches[0].key ? C.hazard : C.online)
    if (t.hp < t.maxHp) {
      g.rect(x + 2, y + cell - 4, cell - 4, 2).fill(C.seam)
      g.rect(x + 2, y + cell - 4, (cell - 4) * Math.max(0, t.hp) / t.maxHp, 2).fill(C.rogue)
    }
  }
  // dragged row: amber dashed ghosts
  for (const i of o.drag ?? []) ghost(g, X(i % COLS), Y(Math.floor(i / COLS)), cell, sealed, o.dragKind ?? 'gatling')

  // selection: placement ghost or tower ring, plus range
  if (s && !o.mini) {
    const t = L.towers[s.y * COLS + s.x]
    if (t) chamfer(g, X(s.x) + 1, Y(s.y) + 1, cell - 2, cell - 2, Math.max(2, cell / 8)).stroke({ width: 2, color: C.hazard })
    else ghost(g, X(s.x), Y(s.y), cell, sealed, o.preview ?? null)
    const range = t ? towerStats(t).rangeMc : o.preview ? TOWERS[o.preview].rangeMc : 0
    const rc = sealed && !t ? C.rogue : C.hazard
    if (range) g.circle(X(s.x + 0.5), Y(s.y + 0.5), px(range)).fill({ color: rc, alpha: 0.05 }).stroke({ width: 1, color: rc, alpha: 0.35 })
  }

  // shots, tinted by damage type
  for (const f of o.fx) {
    const c = towerColor(f.tower), a = Math.min(1, (f.until - o.now) / 120)
    const x1 = X(0) + px(f.x1), y1 = Y(0) + px(f.y1), x2 = X(0) + px(f.x2), y2 = Y(0) + px(f.y2)
    if (f.k === 'line') g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: 1.5, color: c, alpha: a })
    else if (f.k === 'beam') g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: Math.max(2, px(f.r)), color: c, alpha: 0.35 * a })
    else if (f.k === 'boom') g.circle(x2, y2, px(f.r)).fill({ color: c, alpha: 0.25 * a }).stroke({ width: 1, color: c, alpha: 0.6 * a })
    else g.circle(x2, y2, px(f.r)).stroke({ width: 2, color: c, alpha: 0.4 * a })
  }

  // robots: armor silhouette; color = side (enemy rogue, yours hazard, neutral dust)
  for (const r of L.robots) {
    const p = o.prev.get(r.id) ?? r
    const x = X(0) + px(p.x + (r.x - p.x) * o.alpha), y = Y(0) + px(p.y + (r.y - p.y) * o.alpha)
    const side = r.owner < 0 ? C.dust : r.owner === o.me ? C.hazard : C.rogue
    const size = cell * SIZE[r.kind]
    if (o.mini) { g.circle(x, y, Math.max(1.5, size / 4)).fill(side); continue }
    icon(g, ROBOT_ICON[r.kind], x, y, size, side, 1, C.void)
    if (r.shield > 0) g.circle(x, y, size * 0.62).stroke({ width: 1.5, color: ARMOR_COLOR.shielded })
    if (r.stun > 0) g.circle(x, y, size * 0.7).stroke({ width: 1, color: C.white })
    else if (r.slow > 0) g.circle(x, y, size * 0.7).stroke({ width: 1, color: DMG_COLOR.energy, alpha: 0.6 })
    if (r.hp < r.maxHp) {
      g.rect(x - cell * 0.3, y - size / 2 - 5, cell * 0.6, 3).fill(C.seam)
      g.rect(x - cell * 0.3, y - size / 2 - 5, cell * 0.6 * Math.max(0, r.hp) / r.maxHp, 3).fill(side === C.dust ? C.white : side)
    }
  }
}

function ghost(g: Graphics, x: number, y: number, cell: number, sealed: boolean, kind: TowerKind | null) {
  const c = sealed ? C.rogue : C.hazard
  g.rect(x + 1, y + 1, cell - 2, cell - 2).fill({ color: c, alpha: 0.12 })
  dashed(g, [[x + 1, y + 1], [x + cell - 1, y + 1], [x + cell - 1, y + cell - 1], [x + 1, y + cell - 1], [x + 1, y + 1]], 4, 3)
  g.stroke({ width: 2, color: c })
  if (kind) icon(g, TOWER_ICON[kind], x + cell / 2, y + cell / 2, cell * 0.6, towerColor(kind), 0.6)
}
