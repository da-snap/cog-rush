// 3D view of the match (three.js). Pure view: reads sim state and events, never changes them.
import * as THREE from 'three'
import { COLS, EXIT_ROWS, MC, ROBOTS, ROWS, SPAWN_ROWS, TOWERS, type RobotKind, type TowerKind } from './sim/config.ts'
import { INF, field, pathFrom, towerStats, wouldSeal, type Game, type Tower } from './sim/sim.ts'
import { BARREL_AXIS, COLOSSUS_HIP, PIVOT_AT, ROBOT_MODELS, TOWER_MODELS, type Part, type Pivot } from './models.ts'
import * as sfx from './audio.ts'

// design-system colors
const COL = {
  void: 0x0b0d10, board: 0x12151a, seam: 0x2a3038, hazard: 0xffc42e, rogue: 0xff5468, online: 0x8ce66b, dust: 0x9ba3ae, white: 0xeceef1,
  kinetic: 0xd9dee5, explosive: 0xff6b2c, energy: 0x3be3cf,
}
const DMG = { kinetic: COL.kinetic, explosive: COL.explosive, energy: COL.energy }
export const LANE_GAP = 14 // world units between lane origins
const ROBOT_SCALE: Record<RobotKind, number> = { scout: 1.4, drone: 1.3, repair: 1.3, shield: 1.3, tank: 1.25, splitter: 1.3, breaker: 1.25, colossus: 1.1 }
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600

export interface UiState {
  me: number; focus: number; layout: 'single' | 'both'
  sel: { x: number; y: number } | null // selected tower cell (own lane)
  hover: { x: number; y: number } | null; buildKind: TowerKind | null; drag: number[]
  free: { x: number; y: number; w: number; h: number } // screen rect not covered by HUD
  mini: { x: number; y: number; w: number; h: number } | null // phone: small view of the other lane
}

// --- instanced part batches ----------------------------------------------------

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _c = new THREE.Color(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3()
const litMat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, metalness: 0.35, roughness: 0.55 })
const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })

class Batch<K extends string> {
  meshes = new Map<K, { part: Part; mesh: THREE.InstancedMesh; n: number }[]>()
  constructor(scene: THREE.Scene, defs: Record<K, Part[]>, cap: number) {
    for (const k of Object.keys(defs) as K[]) {
      this.meshes.set(k, defs[k].map(part => {
        const mesh = new THREE.InstancedMesh(part.geo, part.glow ? glowMat : litMat, cap)
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        mesh.setColorAt(0, _c.set(0xffffff))
        mesh.frustumCulled = false
        mesh.count = 0
        scene.add(mesh)
        return { part, mesh, n: 0 }
      }))
    }
  }
  begin() { for (const list of this.meshes.values()) for (const b of list) b.n = 0 }
  /** root: world matrix of the model; pose(pivot) = matrix of that pivot relative to root */
  add(kind: K, root: THREE.Matrix4, pose: (pv: Pivot) => THREE.Matrix4, color: (pc: Part['color']) => number, flash: number) {
    for (const b of this.meshes.get(kind)!) {
      if (b.n >= b.mesh.instanceMatrix.count) continue
      b.mesh.setMatrixAt(b.n, _m2.multiplyMatrices(root, pose(b.part.pivot)))
      _c.set(color(b.part.color))
      if (flash > 0) _c.lerp(new THREE.Color(0xffffff), flash)
      b.mesh.setColorAt(b.n, _c)
      b.n++
    }
  }
  end() {
    for (const list of this.meshes.values()) for (const b of list) {
      b.mesh.count = b.n
      b.mesh.instanceMatrix.needsUpdate = true
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true
    }
  }
}

// --- particles -----------------------------------------------------------------

class Particles {
  max = MOBILE ? 900 : 2500
  pos = new Float32Array(this.max * 3); vel = new Float32Array(this.max * 3); col = new Float32Array(this.max * 3)
  life = new Float32Array(this.max); maxLife = new Float32Array(this.max); size = new Float32Array(this.max); alpha = new Float32Array(this.max)
  grav = new Float32Array(this.max)
  next = 0
  geo = new THREE.BufferGeometry()
  points: THREE.Points
  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage))
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { scale: { value: 300 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying vec3 vC; varying float vA; uniform float scale;
        void main(){ vC=color; vA=alpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*scale/-mv.z; gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `varying vec3 vC; varying float vA; void main(){ vec2 d=gl_PointCoord-0.5; float r=dot(d,d); if(r>0.25) discard; gl_FragColor=vec4(vC, vA*(1.0-r*4.0)); }`,
    })
    this.points = new THREE.Points(this.geo, mat)
    this.points.frustumCulled = false
    scene.add(this.points)
  }
  emit(x: number, y: number, z: number, n: number, color: number, speed: number, life: number, size: number, up = 0, grav = 6) {
    _c.set(color)
    for (let k = 0; k < n; k++) {
      const i = this.next = (this.next + 1) % this.max
      const a = Math.random() * Math.PI * 2, e = Math.random() * 2 - 1, s = speed * (0.3 + Math.random() * 0.7)
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z
      this.vel[i * 3] = Math.cos(a) * Math.sqrt(1 - e * e) * s
      this.vel[i * 3 + 1] = Math.abs(e) * s + up
      this.vel[i * 3 + 2] = Math.sin(a) * Math.sqrt(1 - e * e) * s
      this.col[i * 3] = _c.r; this.col[i * 3 + 1] = _c.g; this.col[i * 3 + 2] = _c.b
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.4)
      this.size[i] = size * (0.6 + Math.random() * 0.6)
      this.grav[i] = grav
    }
  }
  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue }
      this.life[i] -= dt
      this.vel[i * 3 + 1] -= this.grav[i] * dt
      this.pos[i * 3] += this.vel[i * 3] * dt
      this.pos[i * 3 + 1] = Math.max(0.02, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt)
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
      this.alpha[i] = Math.max(0, this.life[i] / this.maxLife[i])
    }
    for (const k of ['position', 'color', 'size', 'alpha']) this.geo.getAttribute(k).needsUpdate = true
  }
}

// --- short-lived bolts (tracers, beams, lightning) and rings ---------------------

class Bolts {
  mesh: THREE.InstancedMesh
  items: { a: THREE.Vector3; b: THREE.Vector3; w: number; color: number; t: number; life: number }[] = []
  constructor(scene: THREE.Scene, cap: number) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
    this.mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 5).translate(0, 0.5, 0), mat, cap)
    this.mesh.setColorAt(0, _c.set(0xffffff))
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
  }
  add(a: THREE.Vector3, b: THREE.Vector3, w: number, color: number, life: number) {
    if (this.items.length < this.mesh.instanceMatrix.count) this.items.push({ a, b, w, color, t: life, life })
  }
  update(dt: number) {
    this.items = this.items.filter(it => (it.t -= dt) > 0)
    const up = new THREE.Vector3(0, 1, 0)
    this.items.forEach((it, i) => {
      const dir = _v.subVectors(it.b, it.a), len = dir.length() || 0.001
      _q.setFromUnitVectors(up, dir.divideScalar(len))
      const w = it.w * (it.t / it.life)
      this.mesh.setMatrixAt(i, _m.compose(it.a, _q, _s.set(w, len, w)))
      this.mesh.setColorAt(i, _c.set(it.color))
    })
    this.mesh.count = this.items.length
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}

class Rings {
  mesh: THREE.InstancedMesh
  items: { x: number; z: number; r0: number; r1: number; color: number; t: number; life: number }[] = []
  constructor(scene: THREE.Scene, cap: number) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    this.mesh = new THREE.InstancedMesh(new THREE.RingGeometry(0.9, 1, 32).rotateX(-Math.PI / 2), mat, cap)
    this.mesh.setColorAt(0, _c.set(0xffffff))
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
  }
  add(x: number, z: number, r0: number, r1: number, color: number, life: number) {
    if (this.items.length < this.mesh.instanceMatrix.count) this.items.push({ x, z, r0, r1, color, t: life, life })
  }
  update(dt: number) {
    this.items = this.items.filter(it => (it.t -= dt) > 0)
    this.items.forEach((it, i) => {
      const k = 1 - it.t / it.life, r = it.r0 + (it.r1 - it.r0) * (1 - (1 - k) ** 2)
      this.mesh.setMatrixAt(i, _m.makeScale(r, 1, r).setPosition(it.x, 0.06, it.z))
      this.mesh.setColorAt(i, _c.set(it.color).multiplyScalar(1 - k))
    })
    this.mesh.count = this.items.length
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}

// --- board texture -----------------------------------------------------------------

function boardTexture() {
  const S = 48, c = document.createElement('canvas')
  c.width = COLS * S; c.height = ROWS * S
  const x = c.getContext('2d')!
  x.fillStyle = '#12151A'; x.fillRect(0, 0, c.width, c.height)
  const hatch = (y0: number, h: number, base: string, stripe: string) => {
    x.fillStyle = base; x.fillRect(0, y0, c.width, h)
    x.save(); x.beginPath(); x.rect(0, y0, c.width, h); x.clip()
    x.strokeStyle = stripe; x.lineWidth = 10
    for (let k = -h; k < c.width + h; k += 26) { x.beginPath(); x.moveTo(k, y0); x.lineTo(k - h, y0 + h); x.stroke() }
    x.restore()
  }
  hatch(0, SPAWN_ROWS * S, '#10161A', 'rgba(140,230,107,.16)')
  hatch((ROWS - EXIT_ROWS) * S, EXIT_ROWS * S, '#1A1014', 'rgba(255,84,104,.2)')
  x.strokeStyle = '#20252C'; x.lineWidth = 2
  for (let i = 0; i <= COLS; i++) { x.beginPath(); x.moveTo(i * S, 0); x.lineTo(i * S, c.height); x.stroke() }
  for (let j = 0; j <= ROWS; j++) { x.beginPath(); x.moveTo(0, j * S); x.lineTo(c.width, j * S); x.stroke() }
  x.font = 'bold 22px JetBrains Mono, monospace'; x.fillStyle = 'rgba(140,230,107,.8)'; x.fillText('DROP', 10, 30)
  x.fillStyle = 'rgba(255,84,104,.85)'; x.fillText('CORE', 10, ROWS * S - 14)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function floorTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256
  const x = c.getContext('2d')!
  x.fillStyle = '#0B0D10'; x.fillRect(0, 0, 256, 256)
  x.strokeStyle = '#14171C'; x.lineWidth = 2
  for (let i = 0; i <= 256; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 256); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(256, i); x.stroke() }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 40); t.colorSpace = THREE.SRGBColorSpace
  return t
}

// --- the scene ---------------------------------------------------------------------

interface RobotVis { yaw: number; phase: number; x: number; z: number; hp: number; flash: number; lane: number; kind: RobotKind; owner: number }
interface TowerVis { yaw: number; want: number; recoil: number; spin: number; spinV: number; born: number; hp: number; flash: number; x: number; z: number; color: number; lost: boolean }

export class Scene3D {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400)
  mini = new THREE.OrthographicCamera(-6, 6, 11, -11, 0.1, 100)
  towers: Batch<TowerKind>; robots: Batch<RobotKind>
  parts: Particles; bolts: Bolts; rings: Rings
  shadows: THREE.InstancedMesh; bars: THREE.InstancedMesh; chevrons: THREE.InstancedMesh
  ghost: THREE.InstancedMesh; range: THREE.Mesh; rangeFill: THREE.Mesh; selRing: THREE.Mesh
  boards: THREE.Mesh[] = []; sealGlow: THREE.Mesh[] = []
  rv = new Map<number, RobotVis>(); tv = new Map<number, TowerVis>()
  time = 0; shakeAmt = 0
  cam = { x: 5.5, z: 10, dist: 30, tx: 5.5, tz: 10, tdist: 30, ready: false }
  pathCache = new Map<string, number[]>()

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.35
    this.renderer.autoClear = false
    const s = this.scene
    s.background = new THREE.Color(COL.void)
    s.fog = new THREE.Fog(COL.void, 40, 90)
    s.add(new THREE.HemisphereLight(0xc8d8ff, 0x0b0d10, 1.6))
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2); sun.position.set(-8, 18, 10); s.add(sun)
    const rim = new THREE.DirectionalLight(0xffc42e, 0.6); rim.position.set(10, 6, -12); s.add(rim)

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.9 }))
    floor.position.set(10, -0.02, 10); s.add(floor)
    const btex = boardTexture()
    for (let p = 0; p < 2; p++) {
      const ox = p * LANE_GAP
      const board = new THREE.Mesh(new THREE.PlaneGeometry(COLS, ROWS).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: btex, roughness: 0.8, metalness: 0.1 }))
      board.position.set(ox + COLS / 2, 0, ROWS / 2); s.add(board); this.boards.push(board)
      // side rails with hazard caps
      const railMat = new THREE.MeshStandardMaterial({ color: 0x1c2027, flatShading: true, metalness: 0.5, roughness: 0.5 })
      for (const rx of [-0.2, COLS + 0.2]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, ROWS + 0.4), railMat); rail.position.set(ox + rx, 0.25, ROWS / 2); s.add(rail)
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, ROWS + 0.4), new THREE.MeshBasicMaterial({ color: 0xb08a20, toneMapped: false }))
        strip.position.set(ox + rx + (rx < 0 ? 0.17 : -0.17), 0.52, ROWS / 2); s.add(strip)
      }
      const endMat = new THREE.MeshStandardMaterial({ color: 0x14171c, flatShading: true })
      for (const [ez, c] of [[-0.3, COL.online], [ROWS + 0.3, COL.rogue]] as const) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(COLS + 0.8, 0.3, 0.6), endMat); wall.position.set(ox + COLS / 2, 0.15, ez); s.add(wall)
        const lip = new THREE.Mesh(new THREE.BoxGeometry(COLS + 0.8, 0.04, 0.08), new THREE.MeshBasicMaterial({ color: c, toneMapped: false })); lip.position.set(ox + COLS / 2, 0.32, ez + (ez < 0 ? 0.26 : -0.26)); s.add(lip)
      }
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(COLS + 0.6, ROWS + 0.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COL.rogue, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }))
      glow.position.set(ox + COLS / 2, 0.01, ROWS / 2); s.add(glow); this.sealGlow.push(glow)
    }

    this.towers = new Batch(s, TOWER_MODELS, COLS * ROWS * 2)
    this.robots = new Batch(s, ROBOT_MODELS, 260)
    this.parts = new Particles(s); this.bolts = new Bolts(s, 400); this.rings = new Rings(s, 80)

    const sh = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false })
    this.shadows = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2), sh, 520); this.shadows.frustumCulled = false; s.add(this.shadows)
    const barMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, toneMapped: false })
    this.bars = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), barMat, 1200); this.bars.frustumCulled = false; this.bars.renderOrder = 10
    this.bars.setColorAt(0, _c.set(0xffffff)); s.add(this.bars)
    const chev = new THREE.Shape(); chev.moveTo(-0.16, -0.08); chev.lineTo(0, 0.08); chev.lineTo(0.16, -0.08); chev.lineTo(0.16, -0.16); chev.lineTo(0, 0); chev.lineTo(-0.16, -0.16); chev.closePath()
    this.chevrons = new THREE.InstancedMesh(new THREE.ShapeGeometry(chev).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }), 900)
    this.chevrons.setColorAt(0, _c.set(0xffffff)); this.chevrons.frustumCulled = false; s.add(this.chevrons)

    const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false })
    this.ghost = new THREE.InstancedMesh(new THREE.BoxGeometry(0.86, 0.5, 0.86).translate(0, 0.25, 0), ghostMat, 30); this.ghost.setColorAt(0, _c.set(0xffffff)); this.ghost.frustumCulled = false; s.add(this.ghost)
    this.range = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COL.hazard, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false }))
    this.rangeFill = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COL.hazard, transparent: true, opacity: 0.06, depthWrite: false }))
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.58, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COL.hazard, toneMapped: false }))
    s.add(this.range, this.rangeFill, this.selRing)
    this.mini.position.set(0, 30, 0); this.mini.up.set(0, 0, -1); this.mini.lookAt(0, 0, 0)
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
  }

  private fitKey = ''
  /** Fit the camera so the focused lane(s) fill the free screen rect, viewed from behind the exit. */
  private frame(ui: UiState, W: number, H: number) {
    const both = ui.layout === 'both'
    const x0 = both ? -0.6 : ui.focus * LANE_GAP - 0.6, x1 = both ? LANE_GAP + COLS + 0.6 : ui.focus * LANE_GAP + COLS + 0.6
    this.cam.tx = (x0 + x1) / 2
    this.cam.tz = ROWS / 2
    const fr = ui.free
    // shift the projection centre into the middle of the free rect
    this.camera.setViewOffset(W, H, W / 2 - (fr.x + fr.w / 2), H / 2 - (fr.y + fr.h / 2), W, H)
    const key = `${W}x${H}:${fr.x},${fr.y},${fr.w},${fr.h}:${x0},${x1}`
    if (key === this.fitKey) return
    this.fitKey = key
    // binary search the distance at which all four lane corners land inside the free rect
    const corners = [[x0, -0.6], [x1, -0.6], [x0, ROWS + 0.6], [x1, ROWS + 0.6]].map(([x, z]) => new THREE.Vector3(x, 0, z))
    const fits = (d: number) => {
      this.place(this.cam.tx, this.cam.tz, d, 0, 0)
      return corners.every(c => {
        const v = c.clone().project(this.camera)
        const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H
        return sx >= fr.x + 4 && sx <= fr.x + fr.w - 4 && sy >= fr.y + 4 && sy <= fr.y + fr.h - 4 && v.z < 1
      })
    }
    let lo = 4, hi = 300
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid }
    this.cam.tdist = hi
    if (!this.cam.ready) { this.cam.x = this.cam.tx; this.cam.z = this.cam.tz; this.cam.dist = hi; this.cam.ready = true }
  }

  private place(x: number, z: number, dist: number, sx: number, sy: number) {
    const pitch = THREE.MathUtils.degToRad(52)
    this.camera.position.set(x + sx, Math.sin(pitch) * dist + sy, z + Math.cos(pitch) * dist)
    this.camera.lookAt(x + sx * 0.5, 0, z)
    this.camera.updateMatrixWorld()
    this.camera.updateProjectionMatrix()
  }

  shake(a: number) { this.shakeAmt = Math.min(1.2, this.shakeAmt + a) }

  /** Screen point -> lane cell, or null. */
  pick(px: number, py: number, W: number, H: number): { lane: number; x: number; y: number } | null {
    const ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2(px / W * 2 - 1, -(py / H) * 2 + 1), this.camera)
    const hit = new THREE.Vector3()
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null
    const lane = Math.floor((hit.x + (LANE_GAP - COLS) / 2) / LANE_GAP)
    const x = Math.floor(hit.x - lane * LANE_GAP), y = Math.floor(hit.z)
    return lane >= 0 && lane < 2 && x >= 0 && x < COLS && y >= 0 && y < ROWS ? { lane, x, y } : null
  }
  /** Was this screen point inside the phone mini-map? */
  inMini(px: number, py: number, ui: UiState) { const m = ui.mini; return !!m && px >= m.x && px <= m.x + m.w && py >= m.y && py <= m.y + m.h }

  // --- sim events -> effects and sounds ---------------------------------------------

  onStep(g: Game, ui: UiState, quiet = false) {
    const hear = (p: number) => !quiet && (ui.layout === 'both' || p === ui.focus)
    for (const e of g.events) {
      const ox = e.p * LANE_GAP
      if (e.t === 'fx') {
        const a = new THREE.Vector3(ox + e.x1 / MC, 0.55, e.y1 / MC), b = new THREE.Vector3(ox + e.x2 / MC, 0.35, e.y2 / MC)
        const tw = g.lanes[e.p].towers[Math.floor(e.y1 / MC) * COLS + Math.floor(e.x1 / MC)]
        const v = tw && this.tv.get(tw.id)
        if (v) { v.want = Math.atan2(b.x - a.x, b.z - a.z); v.recoil = 1; v.spinV = 30 }
        const c = DMG[TOWERS[e.tower].dmg]
        if (e.k === 'line' && e.tower === 'tesla') this.lightning(a.setY(0.7), b, c)
        else if (e.k === 'line') { this.bolts.add(a, b, 0.03, c, 0.07); if (Math.random() < 0.3) this.parts.emit(a.x, a.y, a.z, 2, 0xffe08a, 2, 0.1, 0.12, 0, 0) }
        else if (e.k === 'beam') this.bolts.add(a, new THREE.Vector3(ox + e.x2 / MC, 0.35, e.y2 / MC), Math.max(0.04, e.r / MC / 2), c, 0.08)
        else if (e.k === 'boom') {
          this.bolts.add(a, b, 0.05, c, 0.1)
          this.parts.emit(b.x, 0.3, b.z, 10, c, 3, 0.45, 0.25, 1)
          this.parts.emit(b.x, 0.2, b.z, 4, 0x555b63, 0.8, 0.9, 0.5, 0.6, -0.5)
          this.rings.add(b.x, b.z, 0.1, e.r / MC, c, 0.35)
        } else this.rings.add(a.x, a.z, 0.2, e.r / MC, c, 0.5)
        if (hear(e.p)) sfx.shot(e.tower)
      } else if (e.t === 'kill') {
        const r = this.rv.get(e.robot)
        if (r) {
          const big = r.kind === 'colossus' || r.kind === 'tank'
          const c = r.owner < 0 ? COL.dust : r.owner === ui.me ? COL.hazard : COL.rogue
          this.parts.emit(r.x, 0.4, r.z, big ? 40 : 14, 0xffb347, big ? 5 : 3.5, 0.5, big ? 0.5 : 0.3, 1.5)
          this.parts.emit(r.x, 0.4, r.z, big ? 20 : 8, c, 2.5, 0.8, 0.15, 2)
          this.parts.emit(r.x, 0.3, r.z, big ? 10 : 4, 0x3a3f46, 0.6, 1.2, 0.7, 0.8, -0.4)
          if (big) this.rings.add(r.x, r.z, 0.2, 1.6, 0xffb347, 0.4)
          if (hear(e.p)) { sfx.kill(); if (big) { sfx.boom(r.kind === 'colossus'); this.shake(r.kind === 'colossus' ? 0.6 : 0.15) } }
        }
      } else if (e.t === 'leak') {
        const r = this.rv.get(e.robot)
        if (r) { this.parts.emit(r.x, 0.3, ROWS - 0.5, 24, COL.rogue, 4, 0.6, 0.35, 2); this.rings.add(r.x, ROWS - 0.5, 0.2, 2.5, COL.rogue, 0.5) }
        if (e.p === ui.me) { this.shake(0.35); sfx.leak() }
      } else if (e.t === 'towerLost') {
        const v = this.tv.get(e.tower)
        if (v) {
          v.lost = true
          this.parts.emit(v.x, 0.4, v.z, 26, 0xffb347, 4, 0.5, 0.35, 2)
          this.parts.emit(v.x, 0.3, v.z, 14, 0x2a3038, 3, 1.2, 0.3, 3, 8) // debris
          this.parts.emit(v.x, 0.3, v.z, 6, 0x3a3f46, 0.6, 1.4, 0.8, 0.8, -0.4)
          this.rings.add(v.x, v.z, 0.2, 1.8, 0xffb347, 0.45)
        }
        if (hear(e.p)) { sfx.boom(true); this.shake(0.3) }
      } else if (e.t === 'wave' && e.p === ui.me) sfx.horn()
      else if (e.t === 'released' && e.p === ui.me) sfx.alarm()
    }
  }

  private lightning(a: THREE.Vector3, b: THREE.Vector3, c: number) {
    let prev = a.clone()
    for (let k = 1; k <= 4; k++) {
      const t = k / 4, pnt = new THREE.Vector3().lerpVectors(a, b, t)
      if (k < 4) pnt.add(new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.4))
      this.bolts.add(prev, pnt, 0.035, c, 0.09)
      prev = pnt
    }
    this.parts.emit(b.x, b.y, b.z, 3, c, 2, 0.15, 0.15, 0, 0)
  }

  // --- per-frame draw ----------------------------------------------------------------

  render(g: Game, ui: UiState, alpha: number, prev: Map<number, { x: number; y: number }>, dt: number, W: number, H: number) {
    this.time += dt
    const t = this.time
    this.frame(ui, W, H)
    // smooth camera
    const k = 1 - Math.exp(-dt * 5)
    this.cam.x += (this.cam.tx - this.cam.x) * k; this.cam.z += (this.cam.tz - this.cam.z) * k; this.cam.dist += (this.cam.tdist - this.cam.dist) * k
    const sx = (Math.random() - 0.5) * this.shakeAmt * 0.6, sy = (Math.random() - 0.5) * this.shakeAmt * 0.6
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.5)
    this.place(this.cam.x, this.cam.z, this.cam.dist, sx, sy)

    this.towers.begin(); this.robots.begin()
    let nShadow = 0, nBar = 0, nChev = 0
    const seenR = new Set<number>(), seenT = new Set<number>()

    const camQ = this.camera.quaternion
    const bar = (x: number, y: number, z: number, w: number, frac: number, color: number) => {
      if (nBar + 2 > this.bars.instanceMatrix.count) return
      this.bars.setMatrixAt(nBar, _m.compose(_v.set(x, y, z), camQ, _s.set(w, 0.07, 1))); this.bars.setColorAt(nBar++, _c.set(0x14171c))
      const fw = w * Math.max(0, frac)
      this.bars.setMatrixAt(nBar, _m.compose(_v.set(x, y, z).add(new THREE.Vector3(-(w - fw) / 2, 0, 0.001).applyQuaternion(camQ)), camQ, _s.set(fw, 0.07, 1)))
      this.bars.setColorAt(nBar++, _c.set(color))
    }

    g.lanes.forEach((L, p) => {
      const ox = p * LANE_GAP
      ;(this.sealGlow[p].material as THREE.MeshBasicMaterial).opacity = L.sealed ? 0.12 + Math.sin(t * 8) * 0.06 : 0

      // towers
      for (const tw of L.towers) {
        if (!tw) continue
        seenT.add(tw.id)
        let v = this.tv.get(tw.id)
        if (!v) { v = { yaw: Math.PI, want: Math.PI, recoil: 0, spin: 0, spinV: 0, born: t, hp: tw.hp, flash: 0, x: ox + tw.x + 0.5, z: tw.y + 0.5, color: DMG[TOWERS[tw.kind].dmg], lost: false }; this.tv.set(tw.id, v); if (ui.me >= 0 && (p === ui.focus || ui.layout === 'both')) { sfx.build(); this.parts.emit(ox + tw.x + 0.5, 0.1, tw.y + 0.5, 8, 0x9ba3ae, 1.5, 0.4, 0.3, 1) } }
        if (tw.hp < v.hp) v.flash = 1
        v.hp = tw.hp
        v.flash = Math.max(0, v.flash - dt * 6)
        let dy = v.want - v.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); v.yaw += dy * (1 - Math.exp(-dt * 14))
        v.recoil = Math.max(0, v.recoil - dt * 8)
        v.spinV = Math.max(0, v.spinV - dt * 20); v.spin += v.spinV * dt
        const age = t - v.born, pop = age < 0.35 ? 1 + Math.sin(age / 0.35 * Math.PI) * 0.25 - (1 - age / 0.35) * 0.8 : 1
        const lvl = 1 + (tw.level - 1) * 0.08
        const root = new THREE.Matrix4().makeTranslation(ox + tw.x + 0.5, 0, tw.y + 0.5).multiply(_m.makeScale(pop * lvl, pop * lvl, pop * lvl))
        const turret = new THREE.Matrix4().makeTranslation(...PIVOT_AT.turret).multiply(new THREE.Matrix4().makeRotationY(v.yaw)).multiply(new THREE.Matrix4().makeTranslation(0, 0, -v.recoil * 0.06))
        const dmg = DMG[TOWERS[tw.kind].dmg], kind = tw.kind
        this.towers.add(kind, root, pv => {
          if (pv === 'turret') return turret
          if (pv === 'spin') return kind === 'gatling'
            ? turret.clone().multiply(new THREE.Matrix4().makeTranslation(...BARREL_AXIS)).multiply(new THREE.Matrix4().makeRotationZ(v.spin))
            : new THREE.Matrix4().makeRotationY(t * 1.5 + tw.id)
          if (pv === 'pulse') { const s = 1 + Math.sin(t * 6 + tw.id) * 0.12; return new THREE.Matrix4().makeScale(s, s, s) }
          return _m2.identity()
        }, pc => pc === 'dmg' ? dmg : pc === 'side' ? COL.hazard : pc, v.flash)
        // level pips and branch badge as small glowing marks above the base
        if (tw.hp < tw.maxHp) bar(ox + tw.x + 0.5, 1.0, tw.y + 0.5, 0.7, tw.hp / tw.maxHp, COL.rogue)
      }

      // robots
      for (const r of L.robots) {
        seenR.add(r.id)
        const pp = prev.get(r.id) ?? r
        const x = ox + (pp.x + (r.x - pp.x) * alpha) / MC, z = (pp.y + (r.y - pp.y) * alpha) / MC
        let v = this.rv.get(r.id)
        if (!v) { v = { yaw: 0, phase: Math.random() * 6, x, z, hp: r.hp, flash: 0, lane: p, kind: r.kind, owner: r.owner }; this.rv.set(r.id, v) }
        const dx = x - v.x, dz = z - v.z, moved = Math.hypot(dx, dz)
        if (moved > 0.0005) { const want = Math.atan2(dx, dz); let d = want - v.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); v.yaw += d * (1 - Math.exp(-dt * 12)) }
        v.phase += moved * 9
        v.x = x; v.z = z
        if (r.hp < v.hp) v.flash = 1
        v.hp = r.hp; v.flash = Math.max(0, v.flash - dt * 7)
        const air = ROBOTS[r.kind].air
        const fly = air ? 1.1 + Math.sin(t * 3 + r.id) * 0.08 : 0
        const bob = air ? 0 : Math.abs(Math.sin(v.phase)) * 0.03
        const s = ROBOT_SCALE[r.kind]
        const root = new THREE.Matrix4().makeTranslation(x, fly + bob, z).multiply(new THREE.Matrix4().makeRotationY(v.yaw)).multiply(_m.makeScale(s, s, s))
        const side = r.owner < 0 ? COL.dust : r.owner === ui.me ? COL.hazard : COL.rogue
        const swing = Math.sin(v.phase) * (r.stun > 0 ? 0 : 0.7)
        const hip = r.kind === 'colossus' ? COLOSSUS_HIP : PIVOT_AT.legL[1]
        this.robots.add(r.kind, root, pv => {
          switch (pv) {
            case 'legL': return new THREE.Matrix4().makeTranslation(0, hip, 0).multiply(new THREE.Matrix4().makeRotationX(swing))
            case 'legR': return new THREE.Matrix4().makeTranslation(0, hip, 0).multiply(new THREE.Matrix4().makeRotationX(-swing))
            case 'armL': return new THREE.Matrix4().makeTranslation(...PIVOT_AT.armL).multiply(new THREE.Matrix4().makeRotationX(-swing * 0.6))
            case 'armR': return new THREE.Matrix4().makeTranslation(...PIVOT_AT.armR).multiply(new THREE.Matrix4().makeRotationX(swing * 0.6))
            case 'rotor': return new THREE.Matrix4().makeRotationY(t * 40)
            case 'spin': return new THREE.Matrix4().makeRotationY(t * 2)
            case 'pulse': { const q = 1 + Math.sin(t * 5 + r.id) * 0.15; return new THREE.Matrix4().makeScale(q, q, q) }
            default: return _m2.identity()
          }
        }, pc => pc === 'side' ? side : pc === 'dmg' ? side : pc, v.flash)
        if (nShadow < this.shadows.instanceMatrix.count) {
          const rad = r.kind === 'colossus' ? 0.7 : 0.25
          this.shadows.setMatrixAt(nShadow++, _m.makeScale(rad, 1, rad).setPosition(x, 0.015, z))
        }
        if (r.shield > 0) this.parts.emit(x, 0.5 + fly, z, 1, COL.energy, 0.3, 0.2, 0.25, 0, 0)
        if (r.slow > 0 && Math.random() < 0.2) this.parts.emit(x, 0.3 + fly, z, 1, COL.energy, 0.5, 0.3, 0.12, 0.5, 0)
        if (r.hp < r.maxHp) bar(x, (r.kind === 'colossus' ? 1.8 : 0.85) + fly, z, r.kind === 'colossus' ? 1.2 : 0.6, r.hp / r.maxHp, side === COL.dust ? COL.white : side)
      }

      // burning ground
      for (const b of L.burns) if (Math.random() < 0.5) this.parts.emit(ox + b.x + Math.random(), 0.05, b.y + Math.random(), 1, COL.explosive, 0.5, 0.5, 0.3, 1.2, 0)

      // route chevrons (with build preview for the own lane)
      let towers = L.towers
      const own = p === ui.me
      const previewCells: number[] = []
      if (own && ui.buildKind && ui.hover && !ui.drag.length && !L.towers[ui.hover.y * COLS + ui.hover.x]) previewCells.push(ui.hover.y * COLS + ui.hover.x)
      if (own) previewCells.push(...ui.drag)
      if (previewCells.length) { towers = L.towers.slice(); for (const i of previewCells) towers[i] = { kind: 'gatling', hp: TOWERS.gatling.hp * MC } as Tower }
      const key = `${p}:${L.towers.map(x => x ? 1 : 0).join('')}:${previewCells.join(',')}:${L.sealed}`
      let path = this.pathCache.get(key)
      if (!path) {
        const preview = towers !== L.towers
        const open = preview ? field(towers, false) : L.openDist
        const sealed = open[(COLS - 1) / 2] >= INF
        path = pathFrom(sealed ? (preview ? field(towers, true) : L.breachDist) : open, towers)
        if (sealed) path = [-1, ...path] // marker: draw red
        if (this.pathCache.size > 40) this.pathCache.clear()
        this.pathCache.set(key, path)
      }
      const sealedPath = path[0] === -1, cells = sealedPath ? path.slice(1) : path
      const chevColor = sealedPath ? COL.rogue : COL.hazard
      const flow = (t * 1.5) % 1
      for (let i = 0; i + 1 < cells.length && nChev < this.chevrons.instanceMatrix.count; i++) {
        const a = cells[i], b = cells[i + 1]
        const ax = ox + a % COLS + 0.5, az = Math.floor(a / COLS) + 0.5, bx = ox + b % COLS + 0.5, bz = Math.floor(b / COLS) + 0.5
        const yaw = Math.atan2(bx - ax, bz - az)
        for (const f of [flow * 0.5, flow * 0.5 + 0.5]) {
          this.chevrons.setMatrixAt(nChev, _m.makeRotationY(yaw + Math.PI).setPosition(ax + (bx - ax) * f, 0.03, az + (bz - az) * f))
          this.chevrons.setColorAt(nChev++, _c.set(chevColor).multiplyScalar(own || ui.layout === 'both' ? 0.9 : 0.6))
        }
      }
    })

    // forget robots/towers that are gone
    for (const id of this.rv.keys()) if (!seenR.has(id)) this.rv.delete(id)
    for (const [id, v] of this.tv) if (!seenT.has(id)) {
      if (!v.lost) this.parts.emit(v.x, 0.2, v.z, 10, 0x9ba3ae, 1.5, 0.5, 0.35, 1.5) // sold
      this.tv.delete(id)
    }

    // build ghosts, range ring, selection
    const L = g.lanes[ui.me], ox = ui.me * LANE_GAP
    let nGhost = 0
    const ghostAt = (i: number, red: boolean) => {
      if (nGhost >= this.ghost.instanceMatrix.count) return
      this.ghost.setMatrixAt(nGhost, _m.makeTranslation(ox + i % COLS + 0.5, 0, Math.floor(i / COLS) + 0.5))
      this.ghost.setColorAt(nGhost++, _c.set(red ? COL.rogue : COL.hazard))
    }
    const sealedNow = !!(ui.hover && ui.buildKind && !L.towers[ui.hover.y * COLS + ui.hover.x] && wouldSeal(L, ui.hover.x, ui.hover.y))
    for (const i of ui.drag) ghostAt(i, false)
    let rangeAt: { x: number; y: number; r: number; red: boolean } | null = null
    if (ui.sel) {
      const tw = L.towers[ui.sel.y * COLS + ui.sel.x]
      if (tw) {
        rangeAt = { x: tw.x, y: tw.y, r: towerStats(tw).rangeMc / MC, red: false }
        this.selRing.visible = true
        this.selRing.position.set(ox + tw.x + 0.5, 0.05 + Math.sin(t * 4) * 0.02, tw.y + 0.5)
      }
    } else this.selRing.visible = false
    if (!ui.sel && ui.buildKind && ui.hover && !ui.drag.length && !L.towers[ui.hover.y * COLS + ui.hover.x]) {
      ghostAt(ui.hover.y * COLS + ui.hover.x, sealedNow)
      rangeAt = { x: ui.hover.x, y: ui.hover.y, r: TOWERS[ui.buildKind].rangeMc / MC, red: sealedNow }
    }
    if (!ui.sel) this.selRing.visible = false
    this.range.visible = this.rangeFill.visible = !!rangeAt
    if (rangeAt) {
      for (const m of [this.range, this.rangeFill]) { m.position.set(ox + rangeAt.x + 0.5, 0.04, rangeAt.y + 0.5); m.scale.set(rangeAt.r, 1, rangeAt.r) }
      ;(this.range.material as THREE.MeshBasicMaterial).color.set(rangeAt.red ? COL.rogue : COL.hazard)
      ;(this.rangeFill.material as THREE.MeshBasicMaterial).color.set(rangeAt.red ? COL.rogue : COL.hazard)
    }
    ;(this.ghost.material as THREE.MeshBasicMaterial).opacity = 0.3 + Math.sin(t * 6) * 0.1
    this.ghost.count = nGhost; this.ghost.instanceMatrix.needsUpdate = true; if (this.ghost.instanceColor) this.ghost.instanceColor.needsUpdate = true

    this.towers.end(); this.robots.end()
    this.shadows.count = nShadow; this.shadows.instanceMatrix.needsUpdate = true
    this.bars.count = nBar; this.bars.instanceMatrix.needsUpdate = true; if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true
    this.chevrons.count = nChev; this.chevrons.instanceMatrix.needsUpdate = true; if (this.chevrons.instanceColor) this.chevrons.instanceColor.needsUpdate = true
    this.parts.update(dt); this.bolts.update(dt); this.rings.update(dt)
    ;(this.parts.points.material as THREE.ShaderMaterial).uniforms.scale.value = H * this.renderer.getPixelRatio() * 0.5

    // main view
    const r = this.renderer
    r.setScissorTest(false)
    r.setViewport(0, 0, W, H)
    r.clear()
    r.render(this.scene, this.camera)
    // phone: other lane as a top-down mini-map
    if (ui.mini) {
      const m = ui.mini, other = 1 - ui.focus
      this.mini.position.set(other * LANE_GAP + COLS / 2, 30, ROWS / 2)
      this.mini.left = -COLS / 2 - 0.3; this.mini.right = COLS / 2 + 0.3; this.mini.top = ROWS / 2 + 0.3; this.mini.bottom = -ROWS / 2 - 0.3
      this.mini.lookAt(other * LANE_GAP + COLS / 2, 0, ROWS / 2)
      this.mini.updateProjectionMatrix()
      r.setScissorTest(true)
      r.setScissor(m.x, H - m.y - m.h, m.w, m.h); r.setViewport(m.x, H - m.y - m.h, m.w, m.h)
      r.clear()
      r.render(this.scene, this.mini)
      r.setScissorTest(false)
    }
  }
}
