// Low-poly models built from primitives. Each model is a list of parts; each part hangs off a
// named pivot that the scene animates (turret yaw, leg swing, rotor spin...). Parts are drawn
// with one InstancedMesh per part, so a full lane is a few dozen draw calls, not thousands.
import * as THREE from 'three'
import type { RobotKind, TowerKind } from './sim/config.ts'

export type Pivot = 'root' | 'turret' | 'spin' | 'legL' | 'legR' | 'armL' | 'armR' | 'rotor' | 'pulse'
/** 'side' = robot owner color, 'dmg' = tower damage color, else a fixed hex */
export type PartColor = number | 'side' | 'dmg'
export interface Part { geo: THREE.BufferGeometry; pivot: Pivot; color: PartColor; glow?: boolean }

// palette (CogRush Design System)
export const METAL = 0x2a3038, DARK = 0x1c2027, STEEL = 0x8a929c, HAZARD = 0xffc42e

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z)
const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg)
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
    p(new THREE.IcosahedronGeometry(0.09, 0).translate(0, 0.62, 0), 'pulse', 'dmg', true),
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
    p(new THREE.IcosahedronGeometry(0.14, 1).translate(0, 0.68, 0), 'pulse', 'dmg', true),
  ],
  laser: [
    p(plate(), 'root', METAL),
    p(box(0.3, 0.16, 0.3, 0, 0.08, 0), 'turret', DARK),
    p(box(0.16, 0.16, 0.62, 0, 0.24, 0.12), 'turret', 'dmg'),
    p(cyl(0.05, 0.05, 0.08, 8).rotateX(Math.PI / 2).translate(0, 0.24, 0.46), 'turret', 'dmg', true),
  ],
}

// Robots face +z. Legs hang from hips (pivot origin at the hip), so a rotation about x swings them.
const leg = (x: number, len: number, w = 0.07) => box(w, len, w, x, -len / 2, 0)
export const ROBOT_MODELS: Record<RobotKind, Part[]> = {
  scout: [
    p(new THREE.ConeGeometry(0.18, 0.36, 3).rotateX(Math.PI / 2).translate(0, 0.32, 0), 'root', 'side'),
    p(box(0.06, 0.06, 0.06, 0, 0.36, 0.18), 'root', 0xffffff, true),
    p(leg(0.08, 0.22), 'legL', DARK), p(leg(-0.08, 0.22), 'legR', DARK),
  ],
  drone: [
    p(new THREE.OctahedronGeometry(0.16, 0).scale(1.2, 0.6, 1.4), 'root', 'side'),
    p(box(0.5, 0.03, 0.04), 'root', DARK), p(box(0.04, 0.03, 0.5), 'root', DARK),
    p(cyl(0.11, 0.11, 0.01, 8).translate(0.25, 0.04, 0), 'rotor', STEEL), p(cyl(0.11, 0.11, 0.01, 8).translate(-0.25, 0.04, 0), 'rotor', STEEL),
    p(cyl(0.11, 0.11, 0.01, 8).translate(0, 0.04, 0.25), 'rotor', STEEL), p(cyl(0.11, 0.11, 0.01, 8).translate(0, 0.04, -0.25), 'rotor', STEEL),
    p(box(0.05, 0.03, 0.05, 0, -0.04, 0.18), 'root', 0xffffff, true),
  ],
  repair: [
    p(box(0.3, 0.24, 0.3, 0, 0.34, 0), 'root', 'side'),
    p(box(0.22, 0.05, 0.06, 0, 0.48, 0), 'pulse', 0x8ce66b, true), p(box(0.06, 0.05, 0.22, 0, 0.48, 0), 'pulse', 0x8ce66b, true),
    p(leg(0.1, 0.22), 'legL', DARK), p(leg(-0.1, 0.22), 'legR', DARK),
  ],
  shield: [
    p(cyl(0.2, 0.2, 0.28, 6).translate(0, 0.36, 0), 'root', 'side'),
    p(new THREE.SphereGeometry(0.17, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.5, 0), 'pulse', 0x3be3cf, true),
    p(leg(0.1, 0.22), 'legL', DARK), p(leg(-0.1, 0.22), 'legR', DARK),
  ],
  tank: [
    p(box(0.46, 0.18, 0.56, 0, 0.2, 0), 'root', 'side'),
    p(box(0.12, 0.16, 0.6, 0.27, 0.1, 0), 'root', DARK), p(box(0.12, 0.16, 0.6, -0.27, 0.1, 0), 'root', DARK),
    p(cyl(0.15, 0.17, 0.12, 8).translate(0, 0.34, -0.03), 'root', 'side'),
    p(cyl(0.04, 0.04, 0.38, 6).rotateX(Math.PI / 2).translate(0, 0.34, 0.2), 'root', STEEL),
  ],
  splitter: [
    p(new THREE.OctahedronGeometry(0.24, 0).translate(0, 0.42, 0), 'spin', 'side'),
    p(new THREE.TetrahedronGeometry(0.1, 0).translate(0.2, 0.42, 0), 'spin', 0x3be3cf, true),
    p(new THREE.TetrahedronGeometry(0.1, 0).translate(-0.2, 0.42, 0), 'spin', 0x3be3cf, true),
    p(leg(0.09, 0.22), 'legL', DARK), p(leg(-0.09, 0.22), 'legR', DARK),
  ],
  breaker: [
    p(box(0.4, 0.3, 0.4, 0, 0.36, 0), 'root', 'side'),
    p(new THREE.ConeGeometry(0.12, 0.28, 4).rotateX(Math.PI / 2).translate(0, 0.36, 0.32), 'root', STEEL),
    p(box(0.3, 0.06, 0.06, 0, 0.53, 0.12), 'root', 0xff6b2c, true),
    p(leg(0.12, 0.22, 0.1), 'legL', DARK), p(leg(-0.12, 0.22, 0.1), 'legR', DARK),
  ],
  colossus: [
    p(box(0.7, 0.55, 0.5, 0, 0.95, 0), 'root', 'side'),
    p(box(0.34, 0.24, 0.3, 0, 1.34, 0.04), 'root', DARK),
    p(box(0.24, 0.06, 0.04, 0, 1.36, 0.2), 'root', 0xff5468, true),
    p(box(0.16, 0.5, 0.16, 0, -0.25, 0).translate(0.46, 0, 0), 'armL', DARK), p(box(0.16, 0.5, 0.16, 0, -0.25, 0).translate(-0.46, 0, 0), 'armR', DARK),
    p(leg(0.2, 0.68, 0.2), 'legL', 'side'), p(leg(-0.2, 0.68, 0.2), 'legR', 'side'),
  ],
}

/** Where each pivot hangs on the model, before animation. */
export const PIVOT_AT: Record<Pivot, [number, number, number]> = {
  root: [0, 0, 0], turret: [0, 0.22, 0], spin: [0, 0, 0], pulse: [0, 0, 0], rotor: [0, 0, 0],
  legL: [0, 0.24, 0], legR: [0, 0.24, 0], armL: [0, 1.15, 0], armR: [0, 1.15, 0],
}
export const COLOSSUS_HIP = 0.7
/** Gatling barrels spin around their own axis: offset of that axis from the turret pivot. */
export const BARREL_AXIS: [number, number, number] = [0, 0.26, 0]
