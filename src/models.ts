// Low-poly models built from primitives. Each model is a list of parts; each part hangs off a
// named pivot that the scene animates (turret yaw, leg swing, rotor spin...). Parts are drawn
// with one InstancedMesh per part, so a full lane is a few dozen draw calls, not thousands.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { RobotKind, TowerKind } from './sim/config.ts'

export type Pivot = 'root' | 'turret' | 'spin' | 'legL' | 'legR' | 'armL' | 'armR' | 'rotor' | 'pulse' | 'drill'
/** 'side' = robot owner color, 'dmg' = tower damage color, else a fixed hex */
export type PartColor = number | 'side' | 'dmg'
/** off: where the pivot sits on the model (rotors, drill spin in place around it) */
export interface Part { geo: THREE.BufferGeometry; pivot: Pivot; color: PartColor; glow?: boolean; off?: [number, number, number] }

// palette (CogRush Design System)
export const METAL = 0x2a3038, DARK = 0x1c2027, STEEL = 0x8a929c, HAZARD = 0xffc42e

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z)
const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg)
/** Merge geometries into one (all non-indexed, so mixed primitives combine). */
export const merge = (...g: THREE.BufferGeometry[]) => mergeGeometries(g.map(x => x.index ? x.toNonIndexed() : x))!
/** Part hung at an offset: pulse/rotor/drill pivots then scale or spin it in place. */
const at = (part: Part, x: number, y: number, z: number): Part => ({ ...part, off: [x, y, z] })
const p = (geo: THREE.BufferGeometry, pivot: Pivot, color: PartColor, glow = false): Part => ({ geo, pivot, color, glow })

/** Chamfered base plate shared by all towers. */
const plate = () => {
  const s = new THREE.Shape()
  const a = 0.43, c = 0.1
  s.moveTo(-a + c, -a); s.lineTo(a, -a); s.lineTo(a, a - c); s.lineTo(a - c, a); s.lineTo(-a, a); s.lineTo(-a, -a + c); s.closePath()
  return new THREE.ExtrudeGeometry(s, { depth: 0.22, bevelEnabled: false }).rotateX(-Math.PI / 2)
}

// Towers: pivot 'turret' sits on top of the base (y = 0.22) and yaws toward the target.
export const TOWER_MODELS: Record<TowerKind, Part[]> = {
  gatling: [
    p(plate(), 'root', METAL),
    p(cyl(0.22, 0.26, 0.16, 8).translate(0, 0.08, 0), 'turret', DARK),
    p(box(0.3, 0.2, 0.3, 0, 0.26, 0), 'turret', 'dmg'),
    p(cyl(0.035, 0.035, 0.5, 6).rotateX(Math.PI / 2).translate(0.07, 0, 0.3), 'spin', STEEL),
    p(cyl(0.035, 0.035, 0.5, 6).rotateX(Math.PI / 2).translate(-0.07, 0, 0.3), 'spin', STEEL),
  ],
  flak: [
    p(plate(), 'root', METAL),
    p(cyl(0.24, 0.28, 0.14, 6).translate(0, 0.07, 0), 'turret', DARK),
    p(box(0.34, 0.16, 0.26, 0, 0.22, 0), 'turret', 'dmg'),
    p(cyl(0.05, 0.06, 0.5, 6).rotateX(Math.PI / 2 - 0.7).translate(0.1, 0.42, 0.14), 'turret', STEEL),
    p(cyl(0.05, 0.06, 0.5, 6).rotateX(Math.PI / 2 - 0.7).translate(-0.1, 0.42, 0.14), 'turret', STEEL),
  ],
  emp: [
    p(plate(), 'root', METAL),
    p(cyl(0.08, 0.16, 0.4, 6).translate(0, 0.2, 0), 'turret', DARK),
    p(new THREE.TorusGeometry(0.26, 0.035, 6, 16).rotateX(Math.PI / 2).translate(0, 0.38, 0), 'spin', 'dmg', true),
    p(new THREE.TorusGeometry(0.16, 0.03, 6, 12).rotateX(Math.PI / 2).translate(0, 0.5, 0), 'spin', 'dmg', true),
    at(p(new THREE.IcosahedronGeometry(0.09, 0), 'pulse', 'dmg', true), 0, 0.62, 0),
  ],
  mortar: [
    p(plate(), 'root', METAL),
    p(new THREE.SphereGeometry(0.28, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), 'turret', DARK),
    p(cyl(0.12, 0.14, 0.42, 8).rotateX(Math.PI / 2 - 0.9).translate(0, 0.3, 0.1), 'turret', 'dmg'),
    p(cyl(0.13, 0.13, 0.05, 8).rotateX(Math.PI / 2 - 0.9).translate(0, 0.46, 0.25), 'turret', STEEL),
  ],
  tesla: [
    p(plate(), 'root', METAL),
    p(cyl(0.1, 0.2, 0.55, 6).translate(0, 0.28, 0), 'root', DARK),
    p(new THREE.TorusGeometry(0.16, 0.035, 5, 10).rotateX(Math.PI / 2).translate(0, 0.3, 0), 'root', STEEL),
    p(new THREE.TorusGeometry(0.12, 0.035, 5, 10).rotateX(Math.PI / 2).translate(0, 0.45, 0), 'root', STEEL),
    at(p(new THREE.IcosahedronGeometry(0.14, 1), 'pulse', 'dmg', true), 0, 0.68, 0),
  ],
  laser: [
    p(plate(), 'root', METAL),
    p(box(0.3, 0.16, 0.3, 0, 0.08, 0), 'turret', DARK),
    p(box(0.16, 0.16, 0.62, 0, 0.24, 0.12), 'turret', 'dmg'),
    p(cyl(0.05, 0.05, 0.08, 8).rotateX(Math.PI / 2).translate(0, 0.24, 0.46), 'turret', 'dmg', true),
  ],
}

// Robots face +z. Legs hang from hips (pivot origin at the hip), so a rotation about x swings them.
// Armor reads at a glance: light = thin exposed frame, heavy = steel plates + hazard stripes,
// shielded = cyan energy parts. Parts that share pivot + color are merged into one mesh (see scene3d).
const leg = (x: number, len: number, w = 0.07) => box(w, len, w, x, -len / 2, 0)
const foot = (x: number, len: number, w = 0.08, d = 0.14) => box(w, 0.04, d, x, -len + 0.02, 0.03)
const ball = (r: number, x: number, y: number, z: number, seg = 6) => new THREE.SphereGeometry(r, seg, Math.max(3, seg >> 1)).translate(x, y, z)
const ENERGY = 0x3be3cf, MEDIC = 0x8ce66b, EMBER = 0xff6b2c, EYE = 0xffffff
/** two crossed blades, centered: spun in place by the 'rotor' pivot with an offset */
const blades = () => merge(box(0.26, 0.008, 0.035), box(0.035, 0.008, 0.26))
export const ROBOT_MODELS: Record<RobotKind, Part[]> = {
  // light, fast: arrowhead body, visor, antenna, thin digitigrade legs, rear thruster
  scout: [
    p(new THREE.ConeGeometry(0.17, 0.38, 3).rotateX(Math.PI / 2).translate(0, 0.34, 0.02), 'root', 'side'),
    p(box(0.07, 0.05, 0.3, 0, 0.42, -0.02), 'root', DARK),
    p(box(0.13, 0.035, 0.04, 0, 0.37, 0.2), 'root', EYE, true),
    p(box(0.015, 0.2, 0.015, 0.05, 0.52, -0.1), 'root', STEEL), p(box(0.02, 0.1, 0.12, 0, 0.42, -0.2), 'root', STEEL),
    p(box(0.035, 0.035, 0.035, 0.05, 0.63, -0.1), 'root', 'side', true),
    p(cyl(0.045, 0.06, 0.06, 6).rotateX(Math.PI / 2).translate(0, 0.33, -0.2), 'root', 0xffb347, true),
    p(leg(0.08, 0.22, 0.05), 'legL', DARK), p(leg(-0.08, 0.22, 0.05), 'legR', DARK),
    p(foot(0.08, 0.22, 0.06), 'legL', STEEL), p(foot(-0.08, 0.22, 0.06), 'legR', STEEL),
  ],
  // light, air: quadcopter with X arms, motor pods, spinning blades, skids, camera eye
  drone: [
    p(new THREE.OctahedronGeometry(0.16, 0).scale(1.1, 0.55, 1.35), 'root', 'side'),
    p(box(0.6, 0.03, 0.04).rotateY(Math.PI / 4), 'root', DARK), p(box(0.6, 0.03, 0.04).rotateY(-Math.PI / 4), 'root', DARK),
    ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => p(cyl(0.035, 0.03, 0.06, 6).translate(sx * 0.21, 0.02, sz * 0.21), 'root', STEEL)),
    ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => ({ ...p(blades(), 'rotor', STEEL), off: [sx * 0.21, 0.06, sz * 0.21] as [number, number, number] })),
    p(ball(0.045, 0, -0.06, 0.16), 'root', EYE, true),
    p(box(0.025, 0.025, 0.3, 0.1, -0.13, 0), 'root', DARK), p(box(0.025, 0.025, 0.3, -0.1, -0.13, 0), 'root', DARK),
    p(merge(...[0.1, -0.1].flatMap(x => [0.08, -0.08].map(z => box(0.02, 0.08, 0.02, x, -0.09, z)))), 'root', DARK),
    p(box(0.03, 0.03, 0.03, 0.21, 0.0, 0.21), 'root', 'side', true), p(box(0.03, 0.03, 0.03, -0.21, 0.0, 0.21), 'root', 'side', true),
  ],
  // light, support: medic box with pulsing cross, backpack canister, tool arm, green side lamps
  repair: [
    p(box(0.3, 0.22, 0.28, 0, 0.36, 0), 'root', 'side'),
    p(box(0.32, 0.04, 0.3, 0, 0.25, 0), 'root', DARK),
    at(p(merge(box(0.22, 0.05, 0.06), box(0.06, 0.05, 0.22)), 'pulse', MEDIC, true), 0, 0.49, 0),
    p(cyl(0.07, 0.07, 0.24, 8).translate(0, 0.38, -0.2), 'root', STEEL), p(cyl(0.075, 0.075, 0.03, 8).translate(0, 0.44, -0.2), 'root', MEDIC, true),
    p(box(0.14, 0.05, 0.03, 0, 0.4, 0.15), 'root', EYE, true),
    p(box(0.04, 0.2, 0.04, 0, -0.08, 0.02).translate(0.19, 0, 0), 'armR', DARK), p(box(0.08, 0.04, 0.08, 0.19, -0.2, 0.06), 'armR', STEEL),
    p(box(0.04, 0.04, 0.04, -0.16, 0.44, 0.1), 'root', MEDIC, true),
    p(leg(0.1, 0.22, 0.05), 'legL', DARK), p(leg(-0.1, 0.22, 0.05), 'legR', DARK),
    p(foot(0.1, 0.22), 'legL', STEEL), p(foot(-0.1, 0.22), 'legR', STEEL),
  ],
  // shielded, support: hex drum, pulsing projector dome, tilted orbit ring, front energy plate
  shield: [
    p(cyl(0.2, 0.22, 0.26, 6).translate(0, 0.36, 0), 'root', 'side'),
    p(cyl(0.23, 0.23, 0.04, 6).translate(0, 0.24, 0), 'root', DARK),
    at(p(new THREE.SphereGeometry(0.16, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), 'pulse', ENERGY, true), 0, 0.49, 0),
    p(new THREE.TorusGeometry(0.3, 0.018, 4, 18).rotateX(Math.PI / 2 + 0.35).translate(0, 0.42, 0), 'spin', ENERGY, true),
    p(box(0.24, 0.16, 0.03, 0, 0.38, 0.21), 'root', ENERGY, true),
    p(box(0.04, 0.22, 0.04, 0.2, 0.46, -0.06), 'root', STEEL), p(box(0.04, 0.22, 0.04, -0.2, 0.46, -0.06), 'root', STEEL),
    at(p(box(0.05, 0.05, 0.05), 'pulse', ENERGY, true), 0.2, 0.59, -0.06), at(p(box(0.05, 0.05, 0.05), 'pulse', ENERGY, true), -0.2, 0.59, -0.06),
    p(leg(0.1, 0.22), 'legL', DARK), p(leg(-0.1, 0.22), 'legR', DARK),
    p(foot(0.1, 0.22, 0.1), 'legL', STEEL), p(foot(-0.1, 0.22, 0.1), 'legR', STEEL),
  ],
  // heavy: hull + treads with road wheels, armor skirts, turret with hatch, muzzle brake, exhaust
  tank: [
    p(box(0.42, 0.16, 0.56, 0, 0.21, 0), 'root', 'side'),
    p(box(0.36, 0.05, 0.18).rotateX(0.5).translate(0, 0.26, 0.3), 'root', STEEL),
    p(box(0.12, 0.15, 0.62, 0.27, 0.1, 0), 'root', DARK), p(box(0.12, 0.15, 0.62, -0.27, 0.1, 0), 'root', DARK),
    ...[-0.2, 0, 0.2].flatMap(z => [0.34, -0.34].map(x => p(cyl(0.06, 0.06, 0.03, 8).rotateZ(Math.PI / 2).translate(x, 0.08, z), 'root', STEEL))),
    p(box(0.04, 0.08, 0.5, 0.31, 0.2, 0), 'root', STEEL), p(box(0.04, 0.08, 0.5, -0.31, 0.2, 0), 'root', STEEL),
    p(cyl(0.15, 0.18, 0.13, 8).translate(0, 0.35, -0.04), 'root', 'side'),
    p(cyl(0.06, 0.06, 0.03, 8).translate(-0.05, 0.43, -0.08), 'root', DARK),
    p(cyl(0.035, 0.04, 0.36, 6).rotateX(Math.PI / 2).translate(0, 0.35, 0.24), 'root', STEEL),
    p(cyl(0.055, 0.055, 0.07, 6).rotateX(Math.PI / 2).translate(0, 0.35, 0.42), 'root', DARK),
    p(box(0.3, 0.03, 0.03, 0, 0.3, 0.285), 'root', HAZARD),
    p(cyl(0.03, 0.03, 0.1, 6).translate(0.14, 0.32, -0.26), 'root', DARK), p(box(0.03, 0.03, 0.03, 0.14, 0.375, -0.26), 'root', EMBER, true),
  ],
  // shielded: two armored half-shells around a spinning cyan core, orbiting shards (it splits on death)
  splitter: [
    p(new THREE.SphereGeometry(0.21, 8, 6).scale(0.7, 1, 1).translate(0.12, 0.42, 0), 'root', 'side'),
    p(new THREE.SphereGeometry(0.21, 8, 6).scale(0.7, 1, 1).translate(-0.12, 0.42, 0), 'root', 'side'),
    p(new THREE.TorusGeometry(0.19, 0.022, 4, 16).rotateY(Math.PI / 2).translate(0, 0.42, 0), 'root', ENERGY, true),
    p(new THREE.OctahedronGeometry(0.14, 0).translate(0, 0.42, 0), 'spin', ENERGY, true),
    p(new THREE.TetrahedronGeometry(0.07, 0).translate(0.32, 0.46, 0), 'spin', ENERGY, true),
    p(new THREE.TetrahedronGeometry(0.07, 0).translate(-0.32, 0.38, 0), 'spin', ENERGY, true),
    p(box(0.3, 0.04, 0.3, 0, 0.24, 0), 'root', DARK),
    p(leg(0.09, 0.22), 'legL', DARK), p(leg(-0.09, 0.22), 'legR', DARK),
    p(foot(0.09, 0.22, 0.09), 'legL', STEEL), p(foot(-0.09, 0.22, 0.09), 'legR', STEEL),
  ],
  // heavy, tower-wrecker: hunched armored block, spinning drill ram, hazard stripes, glowing vents
  breaker: [
    p(box(0.42, 0.28, 0.38, 0, 0.38, -0.02), 'root', 'side'),
    p(box(0.46, 0.08, 0.3, 0, 0.56, -0.06), 'root', STEEL),
    p(box(0.14, 0.16, 0.2, 0.27, 0.46, -0.02), 'root', DARK), p(box(0.14, 0.16, 0.2, -0.27, 0.46, -0.02), 'root', DARK),
    p(box(0.36, 0.05, 0.03, 0, 0.3, 0.18), 'root', HAZARD), p(box(0.36, 0.05, 0.03, 0, 0.42, 0.18), 'root', HAZARD),
    p(box(0.2, 0.06, 0.03, 0, 0.5, 0.18), 'root', EMBER, true),
    p(box(0.04, 0.08, 0.04, 0.1, 0.62, -0.16), 'root', EMBER, true), p(box(0.04, 0.08, 0.04, -0.1, 0.62, -0.16), 'root', EMBER, true),
    p(cyl(0.09, 0.09, 0.08, 8).rotateX(Math.PI / 2).translate(0, 0.38, 0.2), 'root', DARK),
    { ...p(new THREE.ConeGeometry(0.11, 0.3, 6).rotateX(Math.PI / 2), 'drill', STEEL), off: [0, 0.38, 0.38] as [number, number, number] },
    p(leg(0.13, 0.22, 0.1), 'legL', DARK), p(leg(-0.13, 0.22, 0.1), 'legR', DARK),
    p(foot(0.13, 0.22, 0.14, 0.18), 'legL', STEEL), p(foot(-0.13, 0.22, 0.14, 0.18), 'legR', STEEL),
  ],
  // heavy boss: walking fortress with shoulder plates, chest reactor, arm cannons, back stacks
  colossus: [
    p(box(0.7, 0.55, 0.5, 0, 0.95, 0), 'root', 'side'),
    p(box(0.5, 0.18, 0.4, 0, 0.62, 0), 'root', DARK),
    p(box(0.34, 0.24, 0.3, 0, 1.34, 0.04), 'root', DARK),
    p(box(0.24, 0.06, 0.04, 0, 1.36, 0.2), 'root', 0xff5468, true),
    at(p(cyl(0.12, 0.12, 0.05, 8).rotateX(Math.PI / 2), 'pulse', EMBER, true), 0, 1.0, 0.26),
    p(box(0.3, 0.06, 0.03, 0, 0.78, 0.26), 'root', HAZARD),
    p(box(0.28, 0.12, 0.38, 0.46, 1.24, 0), 'root', STEEL), p(box(0.28, 0.12, 0.38, -0.46, 1.24, 0), 'root', STEEL),
    p(cyl(0.06, 0.07, 0.36, 6).translate(0.18, 1.3, -0.3), 'root', DARK), p(cyl(0.06, 0.07, 0.36, 6).translate(-0.18, 1.3, -0.3), 'root', DARK),
    p(box(0.06, 0.04, 0.06, 0.18, 1.5, -0.3), 'root', EMBER, true), p(box(0.06, 0.04, 0.06, -0.18, 1.5, -0.3), 'root', EMBER, true),
    p(box(0.16, 0.5, 0.16, 0, -0.25, 0).translate(0.46, 0, 0), 'armL', DARK), p(box(0.16, 0.5, 0.16, 0, -0.25, 0).translate(-0.46, 0, 0), 'armR', DARK),
    p(cyl(0.07, 0.07, 0.3, 6).rotateX(Math.PI / 2).translate(0.46, -0.52, 0.1), 'armL', STEEL), p(cyl(0.07, 0.07, 0.3, 6).rotateX(Math.PI / 2).translate(-0.46, -0.52, 0.1), 'armR', STEEL),
    p(box(0.05, 0.05, 0.02, 0.46, -0.52, 0.26), 'armL', EMBER, true), p(box(0.05, 0.05, 0.02, -0.46, -0.52, 0.26), 'armR', EMBER, true),
    p(leg(0.2, 0.68, 0.2), 'legL', 'side'), p(leg(-0.2, 0.68, 0.2), 'legR', 'side'),
    p(box(0.22, 0.14, 0.06, 0.2, -0.32, 0.12), 'legL', STEEL), p(box(0.22, 0.14, 0.06, -0.2, -0.32, 0.12), 'legR', STEEL),
    p(foot(0.2, 0.68, 0.26, 0.36), 'legL', DARK), p(foot(-0.2, 0.68, 0.26, 0.36), 'legR', DARK),
  ],
}

/** Where each pivot hangs on the model, before animation. */
export const PIVOT_AT: Record<Pivot, [number, number, number]> = {
  root: [0, 0, 0], turret: [0, 0.22, 0], spin: [0, 0, 0], pulse: [0, 0, 0], rotor: [0, 0, 0], drill: [0, 0, 0],
  legL: [0, 0.24, 0], legR: [0, 0.24, 0], armL: [0, 1.15, 0], armR: [0, 1.15, 0],
}
/** Robot hip and shoulder heights (legs/arms swing from here). */
export const RIG: Partial<Record<RobotKind, { hip: number; shoulder: number }>> = {
  repair: { hip: 0.24, shoulder: 0.42 }, colossus: { hip: 0.7, shoulder: 1.15 },
}
/** Gatling barrels spin around their own axis: offset of that axis from the turret pivot. */
export const BARREL_AXIS: [number, number, number] = [0, 0.26, 0]
