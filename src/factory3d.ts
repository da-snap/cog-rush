// Send tab: a tiny 3D factory yard drawn over each factory tile. One pad per wave slot:
// queued = yellow pad with a pile of parts, building = pad fades yellow -> green while the robot
// assembles out of the pile, ready = green pad with the finished robot. Pure view, like scene3d.
import * as THREE from 'three'
import type { RobotKind } from './sim/config.ts'
import { DARK, HAZARD, METAL, PIVOT_AT, RIG, ROBOT_MODELS, STEEL } from './models.ts'

const GREEN = 0x8ce66b, EMPTY = 0x2a3038
export interface FactoryTile { el: HTMLElement; kind: RobotKind; queue: number[]; total: number; cap: number; color: number }

const COLS = 4, GAP = 0.62
const padGeo = new THREE.BoxGeometry(0.46, 0.06, 0.46)
const bitGeo = new THREE.BoxGeometry(0.12, 0.08, 0.1)
const sparkGeo = new THREE.BoxGeometry(0.06, 0.06, 0.06)

/** A robot model as a plain mesh group (no pivot animation): parts placed where scene3d hangs them. */
function robotMesh(kind: RobotKind, side: number) {
  const g = new THREE.Group()
  const hip = RIG[kind]?.hip ?? PIVOT_AT.legL[1], shoulder = RIG[kind]?.shoulder ?? PIVOT_AT.armL[1]
  for (const pt of ROBOT_MODELS[kind]) {
    const c = pt.color === 'side' || pt.color === 'dmg' ? side : pt.color
    const m = new THREE.Mesh(pt.geo, pt.glow ? new THREE.MeshBasicMaterial({ color: c, toneMapped: false }) : new THREE.MeshStandardMaterial({ color: c, flatShading: true, metalness: 0.35, roughness: 0.55 }))
    const y = pt.pivot === 'legL' || pt.pivot === 'legR' ? hip : pt.pivot === 'armL' || pt.pivot === 'armR' ? shoulder : 0
    m.position.set(pt.off?.[0] ?? 0, y + (pt.off?.[1] ?? 0), pt.off?.[2] ?? 0)
    g.add(m)
  }
  // fit any robot (Scout to Colossus) on a pad
  const box = new THREE.Box3().setFromObject(g), s = 0.58 / Math.max(box.max.x - box.min.x, box.max.z - box.min.z, (box.max.y - box.min.y) * 0.8)
  const wrap = new THREE.Group(); g.scale.setScalar(s); g.position.y = -box.min.y * s; wrap.add(g) // models face +z: toward the camera
  return wrap
}

interface Yard { kind: RobotKind; cap: number; root: THREE.Group; pads: THREE.Mesh[]; piles: THREE.Group[]; bots: THREE.Group[]; spark: THREE.Mesh; door: THREE.MeshBasicMaterial }

export class FactoryView {
  canvas = document.createElement('canvas')
  renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true })
  scene = new THREE.Scene()
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50)
  yards: (Yard | null)[] = []
  t = 0

  constructor() {
    Object.assign(this.canvas.style, { position: 'fixed', left: '0', top: '0', pointerEvents: 'none', zIndex: '2', display: 'none' })
    document.body.appendChild(this.canvas)
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setScissorTest(true)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1
    this.scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x0b0d10, 1.8))
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2); sun.position.set(-3, 8, 6); this.scene.add(sun)
  }

  private yard(i: number, kind: RobotKind, cap: number, color: number): Yard {
    const old = this.yards[i]
    if (old && old.kind === kind && old.cap === cap) return old
    if (old) this.scene.remove(old.root)
    const root = new THREE.Group(), rows = Math.ceil(cap / COLS)
    // the factory shed behind the pads: hull, hazard band, glowing door the parts go into
    const shed = new THREE.Mesh(new THREE.BoxGeometry(COLS * GAP, 0.55, 0.45), new THREE.MeshStandardMaterial({ color: METAL, flatShading: true }))
    shed.position.set(0, 0.275, -0.55); root.add(shed)
    const band = new THREE.Mesh(new THREE.BoxGeometry(COLS * GAP + 0.02, 0.06, 0.47), new THREE.MeshStandardMaterial({ color: HAZARD }))
    band.position.set(0, 0.5, -0.55); root.add(band)
    const door = new THREE.MeshBasicMaterial({ color: 0x3a3f47, toneMapped: false })
    const doorM = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.02), door); doorM.position.set(0, 0.15, -0.32); root.add(doorM)
    const pads: THREE.Mesh[] = [], piles: THREE.Group[] = [], bots: THREE.Group[] = []
    for (let k = 0; k < cap; k++) {
      const x = ((k % COLS) - (COLS - 1) / 2) * GAP, z = Math.floor(k / COLS) * GAP
      const pad = new THREE.Mesh(padGeo, new THREE.MeshStandardMaterial({ color: EMPTY, emissive: 0x000000, flatShading: true }))
      pad.position.set(x, 0.03, z); root.add(pad); pads.push(pad)
      // a pile of parts: a few scrap bits, same jumble per pad
      const pile = new THREE.Group()
      for (let b = 0; b < 4; b++) {
        const m = new THREE.Mesh(bitGeo, new THREE.MeshStandardMaterial({ color: b % 2 ? STEEL : b === 2 ? color : DARK, flatShading: true }))
        const a = (k * 7 + b * 2.3) % 6.28
        m.position.set(Math.cos(a) * 0.1, 0.1 + (b === 3 ? 0.07 : 0), Math.sin(a) * 0.1); m.rotation.set(a, a * 1.7, 0)
        pile.add(m)
      }
      pile.position.set(x, 0, z); root.add(pile); piles.push(pile)
      const bot = robotMesh(kind, color); bot.position.set(x, 0.06, z); root.add(bot); bots.push(bot)
    }
    const spark = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: 0xfff1a0, toneMapped: false })); root.add(spark)
    root.userData.rows = rows
    this.scene.add(root)
    return this.yards[i] = { kind, cap, root, pads, piles, bots, spark, door }
  }

  /** Draw one yard per factory tile; tiles = [] hides the view (other tab, no factories). */
  render(tiles: (FactoryTile | null)[], dt: number) {
    this.t += dt
    const live = tiles.filter(Boolean) as FactoryTile[]
    if (!live.length) { this.canvas.style.display = 'none'; return }
    // canvas covers just the tile row
    const rs = live.map(f => f.el.getBoundingClientRect())
    const L = Math.min(...rs.map(r => r.left)), T = Math.min(...rs.map(r => r.top)), R = Math.max(...rs.map(r => r.right)), B = Math.max(...rs.map(r => r.bottom))
    const W = Math.ceil(R - L), H = Math.ceil(B - T)
    Object.assign(this.canvas.style, { display: 'block', left: `${L}px`, top: `${T}px` })
    const sz = this.renderer.getSize(new THREE.Vector2())
    if (sz.x !== W || sz.y !== H) this.renderer.setSize(W, H)
    this.renderer.setScissor(0, 0, W, H); this.renderer.setClearColor(0, 0); this.renderer.clear()
    tiles.forEach((f, i) => {
      if (!f) { if (this.yards[i]) this.yards[i]!.root.visible = false; return }
      const y = this.yard(i, f.kind, f.cap, f.color)
      for (const o of this.yards) if (o) o.root.visible = o === y
      const building = f.queue.findIndex(x => x > 0)
      let busy = false
      y.pads.forEach((pad, k) => {
        const left = f.queue[k], mat = pad.material as THREE.MeshStandardMaterial
        const p = left === undefined ? -1 : left === 0 ? 1 : k === building ? 1 - left / f.total : 0
        const col = p < 0 ? EMPTY : new THREE.Color(HAZARD).lerp(new THREE.Color(GREEN), p).getHex()
        mat.color.setHex(col); mat.emissive.setHex(p < 0 ? 0 : col).multiplyScalar(0.25)
        // pile shrinks into the robot as it assembles
        const pile = y.piles[k], bot = y.bots[k]
        pile.visible = p >= 0 && p < 1; pile.scale.setScalar(Math.max(0.2, 1 - p))
        bot.visible = p > 0
        bot.scale.setScalar(p >= 1 ? 1 : 0.3 + 0.7 * p)
        bot.position.y = 0.06 + (p >= 1 ? Math.abs(Math.sin(this.t * 3 + k)) * 0.03 : 0)
        if (p > 0 && p < 1) {
          busy = true
          bot.rotation.y = this.t * 2 // turntable while assembling
          const a = this.t * 9
          y.spark.position.set(pad.position.x + Math.cos(a) * 0.2, 0.2 + Math.abs(Math.sin(a * 1.3)) * 0.15, pad.position.z + Math.sin(a) * 0.2)
          y.spark.scale.setScalar(0.6 + Math.random() * 0.8)
        } else bot.rotation.y = 0
      })
      y.spark.visible = busy
      y.door.color.setHex(busy ? (Math.sin(this.t * 14) > 0 ? HAZARD : 0xff8a2c) : 0x3a3f47)
      // camera: look down at the yard from the front, fitted to this tile's free area (below the label)
      const r = f.el.getBoundingClientRect(), top = 17
      const vx = r.left - L, vw = r.width, vh = r.height - top, vy = B - r.bottom
      if (vh < 10) return
      const rows = y.root.userData.rows as number
      const spanX = COLS * GAP + 0.2, spanZ = rows * GAP + 0.9, cz = (rows - 1) * GAP / 2 - 0.25
      const aspect = vw / vh, half = Math.max(spanX / 2, (spanZ * 0.6 + 0.75) * aspect / 2) // ortho fit both ways (camera ~36° down)
      const c = this.camera
      c.left = -half; c.right = half; c.top = half / aspect; c.bottom = -half / aspect; c.updateProjectionMatrix()
      c.position.set(0, 4, cz + 5.5); c.lookAt(0, 0.15, cz)
      this.renderer.setViewport(vx, vy, vw, vh); this.renderer.setScissor(vx, vy, vw, vh)
      this.renderer.render(this.scene, c)
    })
  }
}
