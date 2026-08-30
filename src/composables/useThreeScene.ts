import { ref } from 'vue'
import * as THREE from 'three'
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js'
import { useNodeStore } from '@/stores/nodeStore'
import { JobRole } from '@/models'
import { debugLog } from '@/services/debugLog'

const ROLE_COLORS: Record<string, { core: string; glow: string; label: string }> = {
  [JobRole.Finance]: { core: '#ffd700', glow: '#cc9900', label: '财务' },
  [JobRole.HR]: { core: '#ff6699', glow: '#cc3366', label: '人事' },
  [JobRole.Sales]: { core: '#00ff88', glow: '#00cc66', label: '销售' },
  [JobRole.Legal]: { core: '#88ccff', glow: '#5599cc', label: '法务' },
  [JobRole.General]: { core: '#ccbbff', glow: '#9988cc', label: '通用' },
}

export function useThreeScene(containerRef: ReturnType<typeof ref<HTMLDivElement | undefined>>) {
  let scene: THREE.Scene
  let camera: THREE.PerspectiveCamera
  let renderer: THREE.WebGLRenderer
  let controls: TrackballControls
  let animationId: number = 0
  let clock: THREE.Clock

  const nodeStore = useNodeStore()
  const isReady = ref(false)

  const nodeMeshes: Map<string, THREE.Object3D> = new Map()
  const nodeHitTargets: Map<string, THREE.Mesh> = new Map()
  const connectionLines: THREE.Line[] = []
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let lastMousePos = { x: 0, y: 0 }
  let lastMouseTime = 0

  let starfieldRef: THREE.Points | null = null
  let cubeWireframeRef: THREE.LineSegments | null = null
  let l0SpriteRef: THREE.Sprite | null = null
  let pointerDownPos = { x: 0, y: 0 }
  let pointerDownHitId: string | null = null
  let pointerMovedDistance = 0
  let ctrlSelectingId: string | null = null
  let lastClickTime = 0
  let lastClickNodeId: string | null = null

  const glowTextures: Map<string, THREE.Texture> = new Map()

  const decayWarningSprites: Map<string, THREE.Sprite> = new Map()
  const deepFieldObjects: THREE.Points[] = []
  const pulsingObjects: THREE.Sprite[] = []

  let gravityPulsePool: THREE.Sprite[] = []
  let cacheHitPulsePool: THREE.Sprite[] = []

  function createPulsePoolItem(coreColor: string, glowColor: string, baseOpacity: number): THREE.Sprite {
    const tex = createGlowTexture(coreColor, glowColor, 128, 1)
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: baseOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const sprite = new THREE.Sprite(mat)
    sprite.visible = false
    sprite.userData.isPulse = true
    sprite.userData.pulseTime = 0
    sprite.userData.isPoolItem = true
    scene.add(sprite)
    return sprite
  }

  function acquirePulseFromPool(pool: THREE.Sprite[], coreColor: string, glowColor: string, baseOpacity: number): THREE.Sprite {
    for (const item of pool) {
      if (!item.visible) {
        item.visible = true
        item.userData.pulseTime = 0
        if (item.material instanceof THREE.SpriteMaterial) {
          item.material.opacity = baseOpacity
        }
        return item
      }
    }
    const newItem = createPulsePoolItem(coreColor, glowColor, baseOpacity)
    pool.push(newItem)
    return newItem
  }

  let onboardingStardusts: THREE.Group[] = []
  let onboardingLabels: { sprite: THREE.Sprite; startTime: number }[] = []
  let onboardingPulseCount = 0
  let onboardingPulseTimer = 0
  let onboardingStarted = false
  let onboardingExplodeTime = -1

  let ingestParticles: THREE.Sprite[] = []
  let ingestSpawnTimer = 0

  let tractorBeamRef: THREE.Line | null = null
  let selectionBreathTime = 0
  let selectionRingGroup: THREE.Group | null = null
  let selectionRingTargetId: string | null = null
  let starDotTexture: THREE.Texture | null = null
  let starBrightTexture: THREE.Texture | null = null

  let flowParticles: { sprite: THREE.Sprite; from: THREE.Vector3; to: THREE.Vector3; progress: number; speed: number; birthTime: number }[] = []
  let flowSpawnTimer = 0

  let starLogAsteroids: { group: THREE.Group; entryId: string; targetPos: THREE.Vector3; returning: boolean; returnProgress: number }[] = []

  let l0RedFlashTimer = 0

  let l2CandidateSprites: Map<string, THREE.Sprite> = new Map()
  let l2SelectedId: string | null = null
  let l2SelectedDiffraction: THREE.Sprite | null = null

  let l1Flashes: { nodeId: string; startTime: number; duration: number }[] = []
  let convergenceBeam: { active: boolean; startTime: number; phase: number; beams: THREE.Line[]; particles: THREE.Sprite[] } = { active: false, startTime: 0, phase: 0, beams: [], particles: [] }
  let pulsarBurst: { active: boolean; startTime: number; rings: THREE.Mesh[]; sprites: THREE.Sprite[] } = { active: false, startTime: 0, rings: [], sprites: [] }

  let dagChain: {
    active: boolean
    steps: { nodeId: string; stepNum: number; status: 'pending' | 'running' | 'done' | 'failed' | 'replanned' | 'reuse' | 'skip' }[]
    lines: THREE.Line[]
    startTime: number
  } = { active: false, steps: [], lines: [], startTime: 0 }

  let isFlyingTo = false
  let flyStartPos = new THREE.Vector3()
  let flyTargetPos = new THREE.Vector3()
  let flyTargetLookAt = new THREE.Vector3()
  let flyProgress = 0

  const hoveredNodeInfo = ref<{ nodeId: string; screenX: number; screenY: number; label: string } | null>(null)

  function createStarDotTexture(): THREE.Texture {
    const size = 16
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const cx = size / 2
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.4, 'rgba(255,255,255,0.6)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(canvas)
    tex.needsUpdate = true
    return tex
  }

  function createStarBrightTexture(): THREE.Texture {
    const size = 32
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const cx = size / 2
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.15, 'rgba(255,255,255,0.9)')
    grad.addColorStop(0.4, 'rgba(255,255,255,0.3)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(canvas)
    tex.needsUpdate = true
    return tex
  }

  function createGlowTexture(coreColor: string, glowColor: string, size: number = 128, sharpness: number = 0): THREE.Texture {
    const key = `${coreColor}_${glowColor}_${size}_${sharpness}`
    if (glowTextures.has(key)) return glowTextures.get(key)!

    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!

    const cx = size / 2
    const cy = size / 2

    const outerRadius = size * 0.5
    const innerStop = sharpness > 0 ? 0.05 + sharpness * 0.03 : 0.15
    const midStop = sharpness > 0 ? 0.08 + sharpness * 0.02 : 0.35
    const outerStop = sharpness > 0 ? 0.2 + sharpness * 0.05 : 0.6

    const outerGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerRadius)
    outerGlow.addColorStop(0, glowColor + 'ee')
    outerGlow.addColorStop(innerStop, glowColor + 'aa')
    outerGlow.addColorStop(midStop, glowColor + '44')
    outerGlow.addColorStop(outerStop, glowColor + '0d')
    outerGlow.addColorStop(1, glowColor + '00')
    ctx.fillStyle = outerGlow
    ctx.fillRect(0, 0, size, size)

    const crossLen = size * (0.5 + sharpness * 0.08)
    const crossWidth = 0.6 + sharpness * 0.4
    drawStarCross(ctx, cx, cy, crossLen, glowColor + '88', crossWidth)

    const coreRadius = size * (0.14 + sharpness * 0.03)
    const coreGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius)
    coreGlow.addColorStop(0, '#ffffff')
    coreGlow.addColorStop(0.25, coreColor)
    coreGlow.addColorStop(1, coreColor + '00')
    ctx.fillStyle = coreGlow
    ctx.beginPath()
    ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2)
    ctx.fill()

    if (sharpness > 1) {
      ctx.globalCompositeOperation = 'lighter'
      const brightCore = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.06)
      brightCore.addColorStop(0, '#ffffff')
      brightCore.addColorStop(1, 'transparent')
      ctx.fillStyle = brightCore
      ctx.beginPath()
      ctx.arc(cx, cy, size * 0.06, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
    }

    const texture = new THREE.CanvasTexture(canvas)
    texture.needsUpdate = true
    glowTextures.set(key, texture)
    return texture
  }

  function createTextTexture(text: string, color: string): THREE.Texture {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const ctx = canvas.getContext('2d')!
    ctx.font = '28px "Segoe UI", "Microsoft YaHei", sans-serif'
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 128, 32)
    const tex = new THREE.CanvasTexture(canvas)
    tex.needsUpdate = true
    return tex
  }

  function drawStarCross(ctx: CanvasRenderingContext2D, cx: number, cy: number, length: number, color: string, width: number) {
    ctx.save()
    ctx.globalAlpha = 1
    ctx.strokeStyle = color
    ctx.lineWidth = width

    const drawRay = (angle: number, len: number) => {
      const grad = ctx.createLinearGradient(
        cx, cy,
        cx + Math.cos(angle) * len,
        cy + Math.sin(angle) * len
      )
      grad.addColorStop(0, color)
      grad.addColorStop(1, 'transparent')
      ctx.strokeStyle = grad
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len)
      ctx.stroke()
    }

    drawRay(0, length)
    drawRay(Math.PI, length)
    drawRay(Math.PI / 2, length)
    drawRay(Math.PI * 3 / 2, length)
    const diagAngles = [Math.PI / 4, Math.PI * 3 / 4, Math.PI * 5 / 4, Math.PI * 7 / 4]
    for (const a of diagAngles) {
      drawRay(a, length * 0.5)
    }
    ctx.restore()
  }

  function init() {
    const el = containerRef.value
    if (!el) {
      console.error('[StarMap] container is null')
      return
    }

    const w = el.clientWidth || window.innerWidth
    const h = el.clientHeight || window.innerHeight
    debugLog('[StarMap] init, size:', w, 'x', h)

    clock = new THREE.Clock()
    starDotTexture = createStarDotTexture()
    starBrightTexture = createStarBrightTexture()
    scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x050510, 0.008)

    camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 1000)
    camera.position.set(0, 2, 12)

    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x050510, 1)
    el.appendChild(renderer.domElement)

    controls = new TrackballControls(camera, renderer.domElement)
    controls.rotateSpeed = 1.5
    controls.zoomSpeed = 1.2
    controls.panSpeed = 0.5
    controls.noPan = true
    controls.minDistance = 4
    controls.maxDistance = 30
    controls.noRoll = false
    controls.staticMoving = false
    controls.dynamicDampingFactor = 0.15
    controls.target.set(0, 0, 0)
    controls.mouseButtons = {
      LEFT: null as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.ZOOM,
      RIGHT: THREE.MOUSE.ROTATE
    }

    createStarfield()
    createDeepSpace()
    createCubeStarframe()
    createAllNodes()

    for (let i = 0; i < 5; i++) gravityPulsePool.push(createPulsePoolItem('#88ccff', '#4488cc', 0.7))
    for (let i = 0; i < 5; i++) cacheHitPulsePool.push(createPulsePoolItem('#00ff88', '#00cc44', 0.8))

    window.addEventListener('resize', onResize)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    animate()
    isReady.value = true
  }

  function createStarfield() {
    const dustCount = 5000
    const dustPositions = new Float32Array(dustCount * 3)
    for (let i = 0; i < dustCount; i++) {
      const r = 80 + Math.random() * 400
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      dustPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      dustPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      dustPositions[i * 3 + 2] = r * Math.cos(phi)
    }
    const dustGeo = new THREE.BufferGeometry()
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3))
    const dustMat = new THREE.PointsMaterial({
      map: starDotTexture,
      color: 0x99aabb,
      size: 0.3,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const dustField = new THREE.Points(dustGeo, dustMat)
    dustField.userData.isDeepField = true
    scene.add(dustField)
    deepFieldObjects.push(dustField)

    const brightCount = 400
    const brightPositions = new Float32Array(brightCount * 3)
    const brightColors = new Float32Array(brightCount * 3)
    const starColorPalette = [
      [0.7, 0.8, 1.0],
      [1.0, 0.95, 0.8],
      [1.0, 0.7, 0.5],
      [0.6, 0.7, 1.0],
      [1.0, 1.0, 1.0],
    ]
    for (let i = 0; i < brightCount; i++) {
      const r = 30 + Math.random() * 250
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      brightPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      brightPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      brightPositions[i * 3 + 2] = r * Math.cos(phi)
      const c = starColorPalette[Math.floor(Math.random() * starColorPalette.length)]
      brightColors[i * 3] = c[0]
      brightColors[i * 3 + 1] = c[1]
      brightColors[i * 3 + 2] = c[2]
    }
    const brightGeo = new THREE.BufferGeometry()
    brightGeo.setAttribute('position', new THREE.BufferAttribute(brightPositions, 3))
    brightGeo.setAttribute('color', new THREE.BufferAttribute(brightColors, 3))
    const brightMat = new THREE.PointsMaterial({
      map: starBrightTexture,
      size: 1.2,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true
    })
    starfieldRef = new THREE.Points(brightGeo, brightMat)
    scene.add(starfieldRef)

    const midCount = 2000
    const midPositions = new Float32Array(midCount * 3)
    for (let i = 0; i < midCount; i++) {
      const r = 15 + Math.random() * 150
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      midPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      midPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      midPositions[i * 3 + 2] = r * Math.cos(phi)
    }
    const midGeo = new THREE.BufferGeometry()
    midGeo.setAttribute('position', new THREE.BufferAttribute(midPositions, 3))
    const midMat = new THREE.PointsMaterial({
      map: starDotTexture,
      color: 0xccddff,
      size: 0.5,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const midField = new THREE.Points(midGeo, midMat)
    midField.userData.isDeepField = true
    scene.add(midField)
    deepFieldObjects.push(midField)
  }

  function createDeepSpace() {
    const bandCount = 8000
    const bandPositions = new Float32Array(bandCount * 3)
    const bandColors = new Float32Array(bandCount * 3)
    for (let i = 0; i < bandCount; i++) {
      const t = i / bandCount
      const armAngle = t * Math.PI * 6
      const r = 20 + t * 300
      const spread = 8 + t * 20
      const x = Math.cos(armAngle) * r + (Math.random() - 0.5) * spread
      const z = Math.sin(armAngle) * r + (Math.random() - 0.5) * spread
      const y = (Math.random() - 0.5) * spread * 0.3
      bandPositions[i * 3] = x
      bandPositions[i * 3 + 1] = y
      bandPositions[i * 3 + 2] = z
      const warmth = Math.random()
      if (warmth < 0.3) {
        bandColors[i * 3] = 0.4 + Math.random() * 0.2
        bandColors[i * 3 + 1] = 0.5 + Math.random() * 0.2
        bandColors[i * 3 + 2] = 0.8 + Math.random() * 0.2
      } else if (warmth < 0.6) {
        bandColors[i * 3] = 0.6 + Math.random() * 0.3
        bandColors[i * 3 + 1] = 0.6 + Math.random() * 0.2
        bandColors[i * 3 + 2] = 0.7 + Math.random() * 0.2
      } else {
        bandColors[i * 3] = 0.8 + Math.random() * 0.2
        bandColors[i * 3 + 1] = 0.7 + Math.random() * 0.2
        bandColors[i * 3 + 2] = 0.5 + Math.random() * 0.2
      }
    }
    const bandGeo = new THREE.BufferGeometry()
    bandGeo.setAttribute('position', new THREE.BufferAttribute(bandPositions, 3))
    bandGeo.setAttribute('color', new THREE.BufferAttribute(bandColors, 3))
    const bandMat = new THREE.PointsMaterial({
      map: starDotTexture,
      size: 0.3,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true
    })
    const galaxyBand = new THREE.Points(bandGeo, bandMat)
    galaxyBand.userData.isDeepField = true
    scene.add(galaxyBand)
    deepFieldObjects.push(galaxyBand)

    const nebulaColors = [
      { r: 0.3, g: 0.2, b: 0.6, hex: 0x4433aa },
      { r: 0.2, g: 0.3, b: 0.5, hex: 0x3355aa },
      { r: 0.4, g: 0.15, b: 0.3, hex: 0x662255 },
      { r: 0.15, g: 0.35, b: 0.3, hex: 0x225544 },
    ]
    for (let n = 0; n < 6; n++) {
      const nc = nebulaColors[n % nebulaColors.length]
      const nebulaCount = 300
      const nebulaPositions = new Float32Array(nebulaCount * 3)
      const cx = (Math.random() - 0.5) * 200
      const cy = (Math.random() - 0.5) * 40
      const cz = (Math.random() - 0.5) * 200
      const nebulaRadius = 15 + Math.random() * 30
      for (let i = 0; i < nebulaCount; i++) {
        const angle1 = Math.random() * Math.PI * 2
        const angle2 = Math.random() * Math.PI
        const dist = Math.random() * nebulaRadius
        nebulaPositions[i * 3] = cx + Math.sin(angle2) * Math.cos(angle1) * dist
        nebulaPositions[i * 3 + 1] = cy + Math.cos(angle2) * dist * 0.3
        nebulaPositions[i * 3 + 2] = cz + Math.sin(angle2) * Math.sin(angle1) * dist
      }
      const nGeo = new THREE.BufferGeometry()
      nGeo.setAttribute('position', new THREE.BufferAttribute(nebulaPositions, 3))
      const nMat = new THREE.PointsMaterial({
        map: starDotTexture,
        color: nc.hex,
        size: 2.0,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.025,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const nebulaCloud = new THREE.Points(nGeo, nMat)
      nebulaCloud.userData.isDeepField = true
      scene.add(nebulaCloud)
      deepFieldObjects.push(nebulaCloud)
    }
  }

  function createCubeStarframe() {
    const s = 12.0
    const corners: [number, number, number][] = []
    for (let x = -1; x <= 1; x += 2) {
      for (let y = -1; y <= 1; y += 2) {
        for (let z = -1; z <= 1; z += 2) {
          corners.push([x * (s / 2), y * (s / 2), z * (s / 2)])
        }
      }
    }

    const group = new THREE.Group()

    const vertexTex = createGlowTexture('#88aadd', '#4466aa', 64, 3)
    for (const c of corners) {
      const sm = new THREE.SpriteMaterial({
        map: vertexTex,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const sprite = new THREE.Sprite(sm)
      sprite.position.set(c[0], c[1], c[2])
      sprite.scale.set(0.18, 0.18, 1)
      sprite.userData.pulseSpeed = 0.5 + Math.random() * 0.3
      sprite.userData.pulseMin = 0.35
      sprite.userData.pulseMax = 0.75
      group.add(sprite)
    }

    const edgeMids: number[] = []
    for (let i = 0; i < corners.length; i++) {
      for (let j = i + 1; j < corners.length; j++) {
        const a = corners[i]
        const b = corners[j]
        const diff = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
        if (Math.abs(diff - s) < 0.01) {
          edgeMids.push(
            (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2
          )
        }
      }
    }

    const midTex = createGlowTexture('#6688bb', '#334466', 32, 1)
    for (let i = 0; i < edgeMids.length; i += 3) {
      const ms = new THREE.SpriteMaterial({
        map: midTex,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const sp = new THREE.Sprite(ms)
      sp.position.set(edgeMids[i], edgeMids[i + 1], edgeMids[i + 2])
      sp.scale.set(0.08, 0.08, 1)
      sp.userData.pulseSpeed = 0.3 + Math.random() * 0.2
      sp.userData.pulseMin = 0.15
      sp.userData.pulseMax = 0.4
      group.add(sp)
    }

    cubeWireframeRef = null
    group.userData.isCubeFrame = true
    scene.add(group)
  }

  function createCoronaTexture(layer: number, size: number = 256): THREE.Texture {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const cx = size / 2
    const cy = size / 2
    const r = size * 0.5

    const baseHue = 210
    const hueShift = layer * 15
    const hue = baseHue + hueShift
    const sat = 80 - layer * 10
    const light = 70 + layer * 5

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    const innerRatio = 0.2 + layer * 0.08
    const midRatio = 0.4 + layer * 0.06
    const outerRatio = 0.7 + layer * 0.04

    const baseAlpha = Math.max(0.03, 0.25 - layer * 0.06)

    grad.addColorStop(0, `hsla(${hue}, ${sat}%, ${light}%, 0)`)
    grad.addColorStop(innerRatio, `hsla(${hue}, ${sat}%, ${light}%, ${baseAlpha * 0.3})`)
    grad.addColorStop(midRatio, `hsla(${hue}, ${sat}%, ${light}%, ${baseAlpha})`)
    grad.addColorStop(outerRatio, `hsla(${hue}, ${sat}%, ${light}%, ${baseAlpha * 0.5})`)
    grad.addColorStop(1, `hsla(${hue}, ${sat}%, ${light}%, 0)`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)

    if (layer < 3) {
      const rays = 4 + layer * 2
      for (let i = 0; i < rays; i++) {
        const angle = (i / rays) * Math.PI * 2 + layer * 0.3
        const rayLen = r * (0.6 + layer * 0.12)
        const rayWidth = 0.3 + layer * 0.3
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(angle)
        const rayGrad = ctx.createLinearGradient(0, 0, rayLen, 0)
        rayGrad.addColorStop(0, `hsla(${hue}, ${sat}%, ${light}%, 0)`)
        rayGrad.addColorStop(0.3, `hsla(${hue}, ${sat}%, ${light}%, ${baseAlpha * 0.3})`)
        rayGrad.addColorStop(0.7, `hsla(${hue}, ${sat}%, ${light}%, ${baseAlpha * 0.15})`)
        rayGrad.addColorStop(1, `hsla(${hue}, ${sat}%, ${light}%, 0)`)
        ctx.fillStyle = rayGrad
        ctx.beginPath()
        ctx.moveTo(0, -rayWidth)
        ctx.lineTo(rayLen, 0)
        ctx.lineTo(0, rayWidth)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }
    }

    const tex = new THREE.CanvasTexture(canvas)
    tex.needsUpdate = true
    return tex
  }

  let l0CoronaSprites: THREE.Sprite[] = []
  let l0CoronaPhase = 0

  function createNodeMeshL0(pos: { x: number; y: number; z: number }, gravityWeight: number = 1): THREE.Group {
    const group = new THREE.Group()
    group.position.set(pos.x, pos.y, pos.z)

    const coreTex = createGlowTexture('#ffffff', '#ddeeff', 256, 4)
    const coreMat = new THREE.SpriteMaterial({
      map: coreTex,
      transparent: true,
      opacity: 1.0,
      blending: THREE.NormalBlending,
      depthWrite: true
    })
    const coreSprite = new THREE.Sprite(coreMat)
    const coreScale = 0.45 + gravityWeight * 0.1
    coreSprite.scale.set(coreScale, coreScale, 1)
    coreSprite.userData.isL0Core = true
    coreSprite.userData.gravityWeight = gravityWeight
    group.add(coreSprite)

    const innerGlowTex = createGlowTexture('#ffffff', '#aaccff', 256, 2)
    const innerGlowMat = new THREE.SpriteMaterial({
      map: innerGlowTex,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const innerGlow = new THREE.Sprite(innerGlowMat)
    const innerScale = 0.8 + gravityWeight * 0.15
    innerGlow.scale.set(innerScale, innerScale, 1)
    innerGlow.userData.isL0InnerGlow = true
    group.add(innerGlow)

    l0CoronaSprites = []
    const coronaLayers = 5
    for (let i = 0; i < coronaLayers; i++) {
      const tex = createCoronaTexture(i, 256)
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 1.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const sprite = new THREE.Sprite(mat)
      const scale = 1.4 + i * 0.7 + gravityWeight * 0.2
      sprite.scale.set(scale, scale, 1)
      sprite.userData.isL0Corona = true
      sprite.userData.coronaIndex = i
      sprite.userData.baseScale = scale
      sprite.userData.rotSpeed = 0.05 + i * 0.02
      sprite.userData.phaseOffset = i * 1.1
      group.add(sprite)
      l0CoronaSprites.push(sprite)
    }

    l0SpriteRef = coreSprite
    return group
  }

  function createNodeMeshL1(pos: { x: number; y: number; z: number }, isL05: boolean = false, isOrchestrator: boolean = false): THREE.Group {
    const group = new THREE.Group()
    group.position.set(pos.x, pos.y, pos.z)

    const l0Pos = nodeMeshes.get('l0-user-core')?.position ?? new THREE.Vector3(0, 0, 0)
    const offset = new THREE.Vector3(pos.x - l0Pos.x, pos.y - l0Pos.y, pos.z - l0Pos.z)
    const orbitRadius = offset.length()
    const baseAngle = Math.atan2(offset.x, offset.z)
    const elevation = Math.asin(Math.min(1, Math.max(-1, orbitRadius > 0.001 ? offset.y / orbitRadius : 0)))

    group.userData.basePos = { x: pos.x, y: pos.y, z: pos.z }
    group.userData.orbitRadius = orbitRadius
    group.userData.orbitBaseAngle = baseAngle
    group.userData.orbitElevation = elevation
    group.userData.orbitSpeed = 0.02
    group.userData.orbitElevOscSpeed = 0
    group.userData.orbitElevOscAmp = 0
    group.userData.orbitRadOscSpeed = 0
    group.userData.orbitRadOscAmp = 0
    group.userData.orbitPhaseOffset = 0
    group.userData.isL1Orbit = true

    let coreColor = '#ffd700'
    let glowColor = '#ffaa22'
    let baseScale = 1.0

    if (isL05) {
      coreColor = '#ff8800'
      glowColor = '#cc6600'
      baseScale = 1.2
    } else if (isOrchestrator) {
      coreColor = '#ffdd44'
      glowColor = '#ccaa22'
      baseScale = 1.1
    }

    const tex = createGlowTexture(coreColor, glowColor, 256, 2)
    const spriteMat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const sprite = new THREE.Sprite(spriteMat)
    sprite.scale.set(baseScale, baseScale, 1)
    group.add(sprite)

    sprite.userData.pulseSpeed = isL05 ? 2.0 : isOrchestrator ? 1.2 : 0.8
    sprite.userData.pulseMin = 0.7
    sprite.userData.pulseMax = 1.0

    return group
  }

  function createNodeMeshL2(pos: { x: number; y: number; z: number }, locked: boolean, isDegraded: boolean = false): THREE.Group {
    const group = new THREE.Group()
    group.position.set(pos.x, pos.y, pos.z)

    const l0Pos = nodeMeshes.get('l0-user-core')?.position ?? new THREE.Vector3(0, 0, 0)
    const offset = new THREE.Vector3(pos.x - l0Pos.x, pos.y - l0Pos.y, pos.z - l0Pos.z)
    const orbitRadius = offset.length()
    const baseAngle = Math.atan2(offset.x, offset.z)
    const elevation = Math.asin(Math.min(1, Math.max(-1, orbitRadius > 0.001 ? offset.y / orbitRadius : 0)))

    group.userData.basePos = { x: pos.x, y: pos.y, z: pos.z }
    group.userData.orbitRadius = orbitRadius
    group.userData.orbitBaseAngle = baseAngle
    group.userData.orbitElevation = elevation
    group.userData.orbitSpeed = 0.03 + Math.random() * 0.05
    group.userData.orbitElevOscSpeed = 0.02 + Math.random() * 0.03
    group.userData.orbitElevOscAmp = 0.04 + Math.random() * 0.05
    group.userData.orbitRadOscSpeed = 0.015 + Math.random() * 0.02
    group.userData.orbitRadOscAmp = 0.03 + Math.random() * 0.04
    group.userData.orbitPhaseOffset = Math.random() * Math.PI * 2

    let coreColor: string
    let glowColor: string
    if (isDegraded) {
      coreColor = '#555555'
      glowColor = '#333333'
    } else {
      coreColor = locked ? '#00ffff' : '#2a8a9a'
      glowColor = locked ? '#00ccdd' : '#1a5a6a'
    }

    const sharp = isDegraded ? 0 : (locked ? 2 : 1)
    const tex = createGlowTexture(coreColor, glowColor, 128, sharp)
    const spriteMat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: isDegraded ? 0.3 : (locked ? 0.9 : 0.55),
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const sprite = new THREE.Sprite(spriteMat)
    sprite.scale.set(0.7, 0.7, 1)
    group.add(sprite)

    if (isDegraded) {
      sprite.userData.pulseSpeed = 0.3
      sprite.userData.pulseMin = 0.15
      sprite.userData.pulseMax = 0.35
      group.userData.isDegraded = true
    } else {
      sprite.userData.pulseSpeed = locked ? 1.2 : 0.6
      sprite.userData.pulseMin = locked ? 0.65 : 0.35
      sprite.userData.pulseMax = locked ? 1.0 : 0.7
    }

    if (locked && !isDegraded) {
      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 8, 8),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      )
      beacon.position.set(0, 0.12, 0)
      beacon.userData.isBeacon = true
      group.add(beacon)
    }

    return group
  }

  function createNodeMeshL3(pos: { x: number; y: number; z: number }, heat: number, daysUntilCollapse: number = 30, isCollapsed: boolean = false): THREE.Group {
    const group = new THREE.Group()
    const dir = new THREE.Vector3(pos.x, pos.y, pos.z)
    const len = dir.length()
    if (len > 0.001) {
      dir.normalize()
    }

    const l0Pos = nodeMeshes.get('l0-user-core')?.position ?? new THREE.Vector3(0, 0, 0)
    const offset = new THREE.Vector3(pos.x - l0Pos.x, pos.y - l0Pos.y, pos.z - l0Pos.z)
    const orbitRadius = offset.length()
    const baseAngle = Math.atan2(offset.x, offset.z)
    const elevation = Math.asin(Math.min(1, Math.max(-1, orbitRadius > 0.001 ? offset.y / orbitRadius : 0)))

    if (isCollapsed) {
      group.position.set(dir.x * len * 0.4, dir.y * len * 0.4 - 1.8, dir.z * len * 0.4)
    } else {
      group.position.set(pos.x, pos.y, pos.z)
    }

    if (isCollapsed) {
      const nebulaMat = new THREE.SpriteMaterial({
        map: createGlowTexture('#1a1a2a', '#0a0a15', 32),
        transparent: true,
        opacity: 0.05,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const nebulaSprite = new THREE.Sprite(nebulaMat)
      nebulaSprite.scale.set(0.15, 0.15, 1)
      group.add(nebulaSprite)
      group.userData.isCollapsed = true
      group.userData.baseAngle = Math.atan2(dir.x, dir.z)
      group.userData.elevation = Math.asin(Math.min(1, Math.max(-1, dir.y)))
      group.userData.driftSpeed = 0.0001
      group.userData.driftRadius = len * 0.4
      return group
    }

    const t = heat / 100
    const r = Math.floor(100 + t * 80)
    const g = Math.floor(160 - t * 80)
    const b = Math.floor(100 + t * 100)
    const coreHex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
    const glowR = Math.floor(r * 0.7)
    const glowG = Math.floor(g * 0.7)
    const glowB = Math.floor(b * 0.7)
    const glowHex = `#${glowR.toString(16).padStart(2, '0')}${glowG.toString(16).padStart(2, '0')}${glowB.toString(16).padStart(2, '0')}`

    const tex = createGlowTexture(coreHex, glowHex, 64, 1)
    const spriteMat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const sprite = new THREE.Sprite(spriteMat)
    sprite.scale.set(0.28, 0.28, 1)
    group.add(sprite)

    sprite.userData.pulseSpeed = 0.4 + Math.random() * 0.4
    sprite.userData.pulseMin = 0.3
    sprite.userData.pulseMax = 0.7

    if (daysUntilCollapse <= 7 && daysUntilCollapse > 0) {
      const redEdgeMat = new THREE.SpriteMaterial({
        map: createGlowTexture('#ff2200', '#880000', 32),
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const redEdge = new THREE.Sprite(redEdgeMat)
      redEdge.scale.set(0.3, 0.3, 1)
      redEdge.userData.isDecayWarning = true
      group.add(redEdge)
    }

    group.userData.isL3 = true
    group.userData.basePos = { x: pos.x, y: pos.y, z: pos.z }
    group.userData.orbitRadius = orbitRadius
    group.userData.orbitBaseAngle = baseAngle
    group.userData.orbitElevation = elevation
    group.userData.orbitSpeed = 0.05 + Math.random() * 0.07
    group.userData.orbitElevOscSpeed = 0.03 + Math.random() * 0.04
    group.userData.orbitElevOscAmp = 0.02 + Math.random() * 0.03
    group.userData.orbitRadOscSpeed = 0.02 + Math.random() * 0.025
    group.userData.orbitRadOscAmp = 0.02 + Math.random() * 0.03
    group.userData.orbitPhaseOffset = Math.random() * Math.PI * 2

    return group
  }

  function createAllNodes() {
    const degradedIds = nodeStore.degraded.isDegraded ? nodeStore.degraded.unavailableToolIds : []

    for (const node of nodeStore.nodes) {
      let mesh: THREE.Group
      let nodeDecay: { daysUntilCollapse: number; isCollapsed: boolean } | undefined

      if (node.level === 'L3') {
        nodeDecay = nodeStore.l3DecayStates.find(s => s.nodeId === node.id)
      }

      switch (node.level) {
        case 'L0': mesh = createNodeMeshL0(node.position, node.gravityWeight ?? 1); break
        case 'L1': mesh = createNodeMeshL1(node.position, node.isL05 ?? false, node.isOrchestrator ?? false); break
        case 'L2': {
          const isDeg = degradedIds.includes(node.id)
          mesh = createNodeMeshL2(node.position, node.locked, isDeg)
          break
        }
        case 'L3': {
          mesh = createNodeMeshL3(node.position, node.communityHeat ?? 50, nodeDecay?.daysUntilCollapse ?? 30, nodeDecay?.isCollapsed ?? false)
          break
        }
        default: continue
      }

      mesh.userData.nodeId = node.id
      mesh.userData.level = node.level
      scene.add(mesh)
      nodeMeshes.set(node.id, mesh)

      if (nodeDecay?.isCollapsed) {
        const hitMesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.08, 4, 4),
          new THREE.MeshBasicMaterial({ visible: false })
        )
        hitMesh.position.copy(mesh.position)
        hitMesh.userData.nodeId = node.id
        scene.add(hitMesh)
        nodeHitTargets.set(node.id, hitMesh)
        continue
      }

      const hitRadius = node.level === 'L0' ? 0.5 : node.level === 'L1' ? 0.4 : node.level === 'L2' ? 0.3 : 0.12
      const hitMesh = new THREE.Mesh(
        new THREE.SphereGeometry(hitRadius, 8, 8),
        new THREE.MeshBasicMaterial({ visible: false })
      )
      hitMesh.position.copy(mesh.position)
      hitMesh.userData.nodeId = node.id
      scene.add(hitMesh)
      nodeHitTargets.set(node.id, hitMesh)
    }
  }

  function removeConnectionLines() {
    for (const line of connectionLines) {
      scene.remove(line)
      line.geometry.dispose()
    }
    connectionLines.length = 0
  }

  function removeTractorBeam() {
    if (tractorBeamRef) {
      scene.remove(tractorBeamRef)
      tractorBeamRef.geometry.dispose()
      tractorBeamRef = null
    }
  }

  function showConnections(nodeId: string) {
    removeConnectionLines()
    const neighbors = nodeStore.getNeighbors(nodeId)
    const sourceMesh = nodeMeshes.get(nodeId)
    if (!sourceMesh) return

    for (const neighbor of neighbors) {
      const targetMesh = nodeMeshes.get(neighbor.id)
      if (!targetMesh) continue

      const connFlow = nodeStore.connectionFlows.find(f =>
        (f.from === nodeId && f.to === neighbor.id) || (f.from === neighbor.id && f.to === nodeId)
      )
      const flowType = connFlow?.type ?? 'data'

      const points = [sourceMesh.position.clone(), targetMesh.position.clone()]
      const geo = new THREE.BufferGeometry().setFromPoints(points)

      if (flowType === 'data') {
        const mat = new THREE.LineBasicMaterial({
          color: 0x4488cc,
          transparent: true,
          opacity: 0.35,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
        const line = new THREE.Line(geo, mat)
        line.userData.flowType = 'data'
        connectionLines.push(line)
        scene.add(line)
      } else {
        const mat = new THREE.LineDashedMaterial({
          color: 0xff8844,
          transparent: true,
          opacity: 0.3,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          dashSize: 0.05,
          gapSize: 0.03
        })
        const line = new THREE.Line(geo, mat)
        line.computeLineDistances()
        line.userData.flowType = 'control'
        connectionLines.push(line)
        scene.add(line)
      }

      if (connFlow?.isRunning) {
        nodeStore.addFlowPath(nodeId, neighbor.id)
      }
    }
  }

  function updateTractorBeam(elapsed: number) {
    removeTractorBeam()

    const selectedId = nodeStore.interaction.selectedNodeId
    if (!selectedId) return

    const mesh = nodeMeshes.get(selectedId)
    if (!mesh) return

    const pulse = Math.sin(elapsed * 3) * 0.5 + 0.5
    const points: THREE.Vector3[] = []
    const segments = 20
    for (let i = 0; i <= segments; i++) {
      const t = i / segments
      const p = new THREE.Vector3().lerpVectors(
        new THREE.Vector3(0, 0, 0),
        mesh.position,
        t
      )
      const offset = Math.sin(t * Math.PI * 4 + elapsed * 5) * 0.02 * (1 - t)
      p.x += offset
      p.z += offset * 0.5
      points.push(p)
    }

    const geo = new THREE.BufferGeometry().setFromPoints(points)
    const mat = new THREE.LineBasicMaterial({
      color: mesh.userData.level === 'L1' ? 0xffd700 : mesh.userData.level === 'L2' ? 0x00ccdd : 0x88aacc,
      transparent: true,
      opacity: 0.15 + pulse * 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    tractorBeamRef = new THREE.Line(geo, mat)
    scene.add(tractorBeamRef)
  }

  function getMouseNDC(event: PointerEvent): THREE.Vector2 {
    const rect = renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    )
  }

  function hitTest(event: PointerEvent): string | null {
    const raycaster = new THREE.Raycaster()
    const mouse = getMouseNDC(event)
    raycaster.setFromCamera(mouse, camera)
    const targets = Array.from(nodeHitTargets.values())
    const intersects = raycaster.intersectObjects(targets)
    if (intersects.length > 0) {
      if (intersects.length === 1) return intersects[0].object.userData.nodeId as string
      let closest = intersects[0]
      for (let i = 1; i < intersects.length; i++) {
        if (intersects[i].distance < closest.distance) closest = intersects[i]
      }
      return closest.object.userData.nodeId as string
    }
    return null
  }

  function hitTestOnboarding(event: PointerEvent): string | null {
    const raycaster = new THREE.Raycaster()
    const mouse = getMouseNDC(event)
    raycaster.setFromCamera(mouse, camera)
    for (const sd of onboardingStardusts) {
      const hits = raycaster.intersectObjects(sd.children, true)
      if (hits.length > 0) return sd.userData.role as string
    }
    return null
  }

  function onPointerMove(event: PointerEvent) {
    const now = performance.now()
    const dx = event.clientX - lastMousePos.x
    const dy = event.clientY - lastMousePos.y
    const dt = now - lastMouseTime
    if (dt > 0) {
      const speed = Math.sqrt(dx * dx + dy * dy) / dt * 1000
      nodeStore.setMouseSpeed(speed)
    }

    if (pointerDownHitId) {
      const pdx = event.clientX - pointerDownPos.x
      const pdy = event.clientY - pointerDownPos.y
      pointerMovedDistance = Math.sqrt(pdx * pdx + pdy * pdy)
    }

    lastMousePos = { x: event.clientX, y: event.clientY }
    lastMouseTime = now

    if (nodeStore.interaction.onboardingPhase === 'stardust') return

    const hitId = nodeStore.isInteractionAllowed() ? hitTest(event) : null
    if (hitId !== nodeStore.interaction.hoveredNodeId) {
      if (hoverTimer) clearTimeout(hoverTimer)
      if (hitId) {
        nodeStore.hoverNode(hitId)
        const node = nodeStore.nodes.find(n => n.id === hitId)
        hoveredNodeInfo.value = {
          nodeId: hitId,
          screenX: event.clientX,
          screenY: event.clientY,
          label: node?.name || hitId
        }
        hoverTimer = setTimeout(() => {
          showConnections(hitId)
        }, 500)
      } else {
        nodeStore.hoverNode(null)
        hoveredNodeInfo.value = null
        removeConnectionLines()
      }
    } else if (hitId && hoveredNodeInfo.value) {
      hoveredNodeInfo.value.screenX = event.clientX
      hoveredNodeInfo.value.screenY = event.clientY
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    pointerDownPos = { x: event.clientX, y: event.clientY }
    pointerMovedDistance = 0

    if (nodeStore.interaction.onboardingPhase === 'stardust') {
      const roleHit = hitTestOnboarding(event)
      if (roleHit) {
        pointerDownHitId = `onboarding-${roleHit}`
      } else {
        pointerDownHitId = null
      }
      return
    }

    pointerDownHitId = nodeStore.isInteractionAllowed() ? hitTest(event) : null
    if (pointerDownHitId && event.ctrlKey) {
      ctrlSelectingId = pointerDownHitId
    }
  }

  function onPointerUp(event: PointerEvent) {
    if (ctrlSelectingId) {
      const isClick = pointerMovedDistance < 5
      if (isClick) {
        nodeStore.toggleNodeSelection(ctrlSelectingId)
        selectionBreathTime = 0
      }
      ctrlSelectingId = null
      pointerDownHitId = null
      return
    }
    if (event.button !== 0) return

    if (nodeStore.interaction.onboardingPhase === 'stardust' && pointerDownHitId?.startsWith('onboarding-')) {
      const isClick = pointerMovedDistance < 5
      if (isClick) {
        const role = pointerDownHitId.replace('onboarding-', '') as JobRole
        nodeStore.selectOnboardingRole(role)
        triggerStardustExplode(role)
      }
      pointerDownHitId = null
      return
    }

    const isClick = pointerMovedDistance < 5 && pointerDownHitId
    const hitId = pointerDownHitId

    if (isClick && hitId) {
      const node = nodeStore.nodes.find(n => n.id === hitId)
      if (node && node.level === 'L3') {
        const decay = nodeStore.l3DecayStates.find(s => s.nodeId === hitId)
        if (decay?.isCollapsed) {
          nodeStore.reviveL3Node(hitId)
          rebuildNode(hitId)
          triggerGravityPulse(hitId)
          pointerDownHitId = null
          return
        }
        if (decay && decay.daysUntilCollapse <= 7 && decay.daysUntilCollapse > 0) {
          nodeStore.anchorL3Node(hitId)
        }
      }

      if (node && node.level === 'L2') {
        const upHitId = hitTest(event)
        if (upHitId && upHitId !== hitId) {
          const targetNode = nodeStore.nodes.find(n => n.id === upHitId)
          if (targetNode && targetNode.level === 'L1') {
            nodeStore.swapLevels(hitId, upHitId)
            nodeStore.endDrag()
            pointerDownHitId = null
            return
          }
        }
      }
      nodeStore.interaction.ctrlKey = event.ctrlKey || event.metaKey
      nodeStore.selectNode(hitId)
      selectionBreathTime = 0
      triggerGravityPulse(hitId)

      const now = performance.now()
      const isDoubleClick = hitId === lastClickNodeId && (now - lastClickTime) < 300
      lastClickTime = now
      lastClickNodeId = hitId

      if (isDoubleClick && node) {
        if (node.level === 'L2') {
          const manifest = nodeStore.getL2Manifest(hitId)
          if (manifest) {
            const promptTemplate = manifest.execution.directCall?.promptTemplate
            const command = promptTemplate
              ? promptTemplate.replace('{{input}}', manifest.identity.name)
              : '/' + manifest.identity.name
            if (window._holoStarMapDblClickCommand) window._holoStarMapDblClickCommand(command)
          }
        } else if (node.level === 'L1' && node.jobRoles && node.jobRoles.length > 0) {
          nodeStore.interaction.selectedRole = node.jobRoles[0] as JobRole
        }
      }
    }

    nodeStore.endDrag()
    pointerDownHitId = null
  }

  function rebuildNode(nodeId: string) {
    const oldMesh = nodeMeshes.get(nodeId)
    const oldHit = nodeHitTargets.get(nodeId)
    if (oldMesh) {
      decayWarningSprites.delete(nodeId)
      for (const child of oldMesh.children) {
        if (child.userData.isPulse && child instanceof THREE.Sprite) {
          const idx = pulsingObjects.indexOf(child)
          if (idx >= 0) pulsingObjects.splice(idx, 1)
        }
      }
      scene.remove(oldMesh)
      nodeMeshes.delete(nodeId)
    }
    if (oldHit) {
      scene.remove(oldHit)
      nodeHitTargets.delete(nodeId)
    }

    const node = nodeStore.nodes.find(n => n.id === nodeId)
    if (!node) return

    let mesh: THREE.Group
    switch (node.level) {
      case 'L0': mesh = createNodeMeshL0(node.position, node.gravityWeight ?? 1); break
      case 'L1': mesh = createNodeMeshL1(node.position, node.isL05 ?? false, node.isOrchestrator ?? false); break
      case 'L2': {
        const degradedIds = nodeStore.degraded.isDegraded ? nodeStore.degraded.unavailableToolIds : []
        mesh = createNodeMeshL2(node.position, node.locked, degradedIds.includes(node.id))
        break
      }
      case 'L3': {
        const decay = nodeStore.l3DecayStates.find(s => s.nodeId === node.id)
        mesh = createNodeMeshL3(node.position, node.communityHeat ?? 50, decay?.daysUntilCollapse ?? 30, decay?.isCollapsed ?? false)
        break
      }
      default: return
    }

    mesh.userData.nodeId = node.id
    mesh.userData.level = node.level
    scene.add(mesh)
    nodeMeshes.set(node.id, mesh)

    for (const child of mesh.children) {
      if (child.userData.isDecayWarning && child instanceof THREE.Sprite) {
        decayWarningSprites.set(nodeId, child)
      }
    }

     const hitRadius = node.level === 'L0' ? 0.5 : node.level === 'L1' ? 0.4 : node.level === 'L2' ? 0.3 : 0.15
    const hitMesh = new THREE.Mesh(
      new THREE.SphereGeometry(hitRadius, 8, 8),
      new THREE.MeshBasicMaterial({ visible: false })
    )
    hitMesh.position.copy(mesh.position)
    hitMesh.userData.nodeId = node.id
    scene.add(hitMesh)
    nodeHitTargets.set(node.id, hitMesh)
  }

  function rebuildAllL2Nodes() {
    for (const node of nodeStore.l2Nodes) {
      rebuildNode(node.id)
    }
  }

  function triggerGravityPulse(nodeId: string) {
    const mesh = nodeMeshes.get(nodeId)
    if (!mesh) return
    const sprite = acquirePulseFromPool(gravityPulsePool, '#88ccff', '#4488cc', 0.7)
    sprite.position.copy(mesh.position)
    sprite.scale.set(0.1, 0.1, 1)
    pulsingObjects.push(sprite)
  }

  function triggerCacheHitPulse(nodeId: string) {
    const mesh = nodeMeshes.get(nodeId)
    if (!mesh) return
    const sprite = acquirePulseFromPool(cacheHitPulsePool, '#00ff88', '#00cc44', 0.8)
    sprite.position.copy(mesh.position)
    sprite.scale.set(0.1, 0.1, 1)
    pulsingObjects.push(sprite)
  }

  function updateCacheHitVisuals() {
    for (const nodeId of nodeStore.nodeVisualEvents.keys()) {
      const evt = nodeStore.consumeNodeVisualEvent(nodeId)
      if (evt) {
        triggerCacheHitPulse(nodeId)
      }
    }
  }

  function startOnboarding() {
    if (onboardingStarted) return
    onboardingStarted = true
    nodeStore.setOnboardingPhase('pulsing')
    onboardingPulseCount = 0
    onboardingPulseTimer = 0
  }

  function spawnStardustCores() {
    const roles = Object.keys(ROLE_COLORS) as JobRole[]
    const spreadAngle = Math.PI * 2 / roles.length
    const radius = 0.8
    const centerZ = 1.2
    const centerY = 0.3

    for (let i = 0; i < roles.length; i++) {
      const role = roles[i]
      const rc = ROLE_COLORS[role]
      const angle = spreadAngle * i - Math.PI / 2

      const group = new THREE.Group()
      const x = Math.cos(angle) * radius * 0.3
      const y = centerY + Math.sin(angle) * radius * 0.3
      const z = centerZ

      const targetX = Math.cos(angle) * radius
      const targetY = centerY + Math.sin(angle) * radius
      const targetZ = centerZ

      const tex = createGlowTexture(rc.core, rc.glow, 128, 2)
      const spriteMat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const sprite = new THREE.Sprite(spriteMat)
      sprite.scale.set(0.25, 0.25, 1)
      group.add(sprite)

      const labelTex = createTextTexture(rc.label, rc.core)
      const labelMat = new THREE.SpriteMaterial({
        map: labelTex,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const labelSprite = new THREE.Sprite(labelMat)
      labelSprite.scale.set(0.5, 0.12, 1)
      labelSprite.position.set(0, -0.22, 0)
      group.add(labelSprite)

      group.position.set(x, y, z)
      group.userData.role = role
      group.userData.targetX = targetX
      group.userData.targetY = targetY
      group.userData.targetZ = targetZ
      group.userData.spawnTime = clock.getElapsedTime()
      group.userData.isStardust = true

      scene.add(group)
      onboardingStardusts.push(group)
      onboardingLabels.push({ sprite: labelSprite, startTime: clock.getElapsedTime() + 0.5 })
    }

    nodeStore.setOnboardingPhase('stardust')
  }

  function triggerStardustExplode(selectedRole: JobRole) {
    onboardingExplodeTime = clock.getElapsedTime()
    nodeStore.setOnboardingPhase('exploding')
    nodeStore.applyJobRoleTemplates(selectedRole)
  }

  function updateOnboardingAnimations(delta: number, elapsed: number) {
    const phase = nodeStore.interaction.onboardingPhase
    if (phase === 'waiting' || phase === 'done') return

    if (phase === 'pulsing') {
      onboardingPulseTimer += delta
      if (l0SpriteRef && l0SpriteRef.material instanceof THREE.SpriteMaterial) {
        const burst = Math.sin(elapsed * 6) * 0.5 + 0.5
        l0SpriteRef.material.opacity = 0.6 + burst * 0.4
        const s = 0.4 + burst * 0.2
        l0SpriteRef.scale.set(s, s, 1)
      }
      for (const cs of l0CoronaSprites) {
        if (cs.material instanceof THREE.SpriteMaterial) {
          const burst = Math.sin(elapsed * 6 + (cs.userData.coronaIndex as number) * 0.3) * 0.5 + 0.5
          cs.material.opacity = 0.4 + burst * 0.6
          const baseS = cs.userData.baseScale as number
          const s = baseS * (1.0 + burst * 0.2)
          cs.scale.set(s, s, 1)
        }
      }
      onboardingPulseCount = Math.floor(onboardingPulseTimer / 0.8)
      if (onboardingPulseCount >= 3) {
        spawnStardustCores()
      }
      return
    }

    if (phase === 'stardust') {
      for (const sd of onboardingStardusts) {
        const t = Math.min(1, (elapsed - sd.userData.spawnTime) * 2)
        const tx = sd.userData.targetX as number
        const ty = sd.userData.targetY as number
        const tz = sd.userData.targetZ as number
        sd.position.x += (tx - sd.position.x) * delta * 3
        sd.position.y += (ty - sd.position.y) * delta * 3
        sd.position.z += (tz - sd.position.z) * delta * 3

        const sprite = sd.children[0] as THREE.Sprite
        if (sprite?.material instanceof THREE.SpriteMaterial) {
          sprite.material.opacity = Math.min(1, t)
        }
      }
      for (const lb of onboardingLabels) {
        const t = Math.min(1, (elapsed - lb.startTime) * 2)
        if (lb.sprite.material instanceof THREE.SpriteMaterial) {
          lb.sprite.material.opacity = Math.min(0.8, t)
        }
      }
      return
    }

    if (phase === 'exploding') {
      const explodeElapsed = elapsed - onboardingExplodeTime
      const selectedRole = nodeStore.interaction.selectedRole

      for (const sd of onboardingStardusts) {
        const isSelected = sd.userData.role === selectedRole
        const sprite = sd.children[0] as THREE.Sprite
        const label = sd.children[1] as THREE.Sprite

        if (isSelected) {
          const expand = explodeElapsed * 3
          sd.scale.set(1 + expand, 1 + expand, 1)
          if (sprite?.material instanceof THREE.SpriteMaterial) {
            sprite.material.opacity = Math.max(0, 1 - explodeElapsed * 1.5)
          }
          if (label?.material instanceof THREE.SpriteMaterial) {
            label.material.opacity = Math.max(0, 0.8 - explodeElapsed * 2)
          }
        } else {
          if (sprite?.material instanceof THREE.SpriteMaterial) {
            sprite.material.opacity = Math.max(0, sprite.material.opacity - delta * 4)
          }
          if (label?.material instanceof THREE.SpriteMaterial) {
            label.material.opacity = Math.max(0, label.material.opacity - delta * 4)
          }
        }
      }

      if (explodeElapsed > 1.5) {
        for (const sd of onboardingStardusts) {
          scene.remove(sd)
        }
        onboardingStardusts = []
        onboardingLabels = []

        if (l0SpriteRef) {
          l0SpriteRef.scale.set(0.55, 0.55, 1)
        }

        nodeStore.setOnboardingPhase('done')
      }
    }
  }

  function updateDegradedVisuals(delta: number, _elapsed: number) {
    if (!nodeStore.degraded.isDegraded) return

    if (l0SpriteRef && l0SpriteRef.material instanceof THREE.SpriteMaterial) {
      const breathe = Math.sin(_elapsed * 0.8) * 0.5 + 0.5
      l0SpriteRef.material.opacity = 0.3 + breathe * 0.3
      l0SpriteRef.material.color.setHex(0xffaa44)
    }

    if (cubeWireframeRef && cubeWireframeRef.material instanceof THREE.LineBasicMaterial) {
      cubeWireframeRef.material.opacity = 0.04
      cubeWireframeRef.material.color.setHex(0x446688)
    }
  }

  function updateIngestAnimation(delta: number, elapsed: number) {
    const progress = nodeStore.ingestProgress
    if (!progress.isRunning) {
      for (const p of ingestParticles) {
        scene.remove(p)
        if (p.material instanceof THREE.SpriteMaterial) p.material.dispose()
      }
      ingestParticles = []
      return
    }

    ingestSpawnTimer += delta
    if (ingestSpawnTimer > 0.15) {
      ingestSpawnTimer = 0
      const angle = Math.random() * Math.PI * 2
      const radius = 1.5 + Math.random() * 0.5
      const y = (Math.random() - 0.5) * 1.5

      const tex = createGlowTexture('#88ddff', '#4488aa', 32, 1)
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const sprite = new THREE.Sprite(mat)
      sprite.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
      sprite.scale.set(0.06, 0.06, 1)
      sprite.userData.isIngestParticle = true
      sprite.userData.birthTime = elapsed
      sprite.userData.startPos = sprite.position.clone()
      scene.add(sprite)
      ingestParticles.push(sprite)
    }

    for (let i = ingestParticles.length - 1; i >= 0; i--) {
      const p = ingestParticles[i]
      const age = elapsed - (p.userData.birthTime as number)
      const t = Math.min(1, age / 2.0)

      const start = p.userData.startPos as THREE.Vector3
      p.position.lerpVectors(start, new THREE.Vector3(0, 0, 0), t)
      const s = 0.06 * (1 - t * 0.8)
      p.scale.set(s, s, 1)

      if (p.material instanceof THREE.SpriteMaterial) {
        p.material.opacity = Math.max(0, 0.6 * (1 - t))
      }

      if (t >= 1) {
        scene.remove(p)
        if (p.material instanceof THREE.SpriteMaterial) p.material.dispose()
        ingestParticles.splice(i, 1)
      }
    }
  }

  function updateL3DecayWarning(elapsed: number) {
    for (const [_nodeId, sprite] of decayWarningSprites) {
      if (sprite.material instanceof THREE.SpriteMaterial) {
        const blink = Math.sin(elapsed * 3) * 0.5 + 0.5
        sprite.material.opacity = 0.15 + blink * 0.35
      }
    }
  }

  function updateL0RedFlash(elapsed: number) {
    if (!nodeStore.interaction.l0RedFlash) {
      l0RedFlashTimer = 0
      for (const cs of l0CoronaSprites) {
        if (cs.material instanceof THREE.SpriteMaterial) {
          cs.visible = true
        }
      }
      return
    }
    l0RedFlashTimer += 0.016
    if (l0RedFlashTimer > 4) {
      nodeStore.setL0RedFlash(false)
      l0RedFlashTimer = 0
      return
    }
    if (l0SpriteRef && l0SpriteRef.material instanceof THREE.SpriteMaterial) {
      const flash = Math.sin(elapsed * 12) * 0.5 + 0.5
      l0SpriteRef.material.color.setHex(flash > 0.5 ? 0xff2222 : 0xff6644)
      l0SpriteRef.material.opacity = 0.5 + flash * 0.5
    }
    for (const cs of l0CoronaSprites) {
      if (cs.material instanceof THREE.SpriteMaterial) {
        cs.material.opacity = 0.15
      }
    }
  }

  function highlightL2Candidates(nodeIds: string[]) {
    for (const [id, sprite] of l2CandidateSprites) {
      if (!nodeIds.includes(id)) {
        sprite.parent?.remove(sprite)
        if (sprite.material instanceof THREE.SpriteMaterial) sprite.material.dispose()
        l2CandidateSprites.delete(id)
      }
    }

    for (const nodeId of nodeIds) {
      if (l2CandidateSprites.has(nodeId)) continue
      const mesh = nodeMeshes.get(nodeId)
      if (!mesh) continue

      const tex = createGlowTexture('#00ffff', '#0088aa', 64, 1)
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const sprite = new THREE.Sprite(mat)
      sprite.scale.set(1.2, 1.2, 1)
      sprite.userData.isL2Candidate = true
      mesh.add(sprite)
      l2CandidateSprites.set(nodeId, sprite)
    }
  }

  function setL2Selected(nodeId: string | null) {
    if (l2SelectedDiffraction) {
      l2SelectedDiffraction.parent?.remove(l2SelectedDiffraction)
      if (l2SelectedDiffraction.material instanceof THREE.SpriteMaterial) l2SelectedDiffraction.material.dispose()
      l2SelectedDiffraction = null
    }

    l2SelectedId = nodeId
    if (!nodeId) return

    const mesh = nodeMeshes.get(nodeId)
    if (!mesh) return

    const tex = createGlowTexture('#ffffff', '#ffd700', 128, 3)
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const sprite = new THREE.Sprite(mat)
    sprite.scale.set(2.5, 2.5, 1)
    sprite.userData.isL2Diffraction = true
    mesh.add(sprite)
    l2SelectedDiffraction = sprite
  }

  function updateL2Highlights(elapsed: number) {
    for (const [id, sprite] of l2CandidateSprites) {
      if (sprite.material instanceof THREE.SpriteMaterial) {
        const pulse = Math.sin(elapsed * 4) * 0.5 + 0.5
        sprite.material.opacity = 0.25 + pulse * 0.35
      }
    }

    if (l2SelectedDiffraction && l2SelectedDiffraction.material instanceof THREE.SpriteMaterial) {
      const pulse = Math.sin(elapsed * 6) * 0.5 + 0.5
      l2SelectedDiffraction.material.opacity = 0.5 + pulse * 0.4
      const s = 2.5 + pulse * 0.5
      l2SelectedDiffraction.scale.set(s, s, 1)
    }
  }

  function triggerL1Flash(nodeId: string) {
    l1Flashes.push({ nodeId, startTime: clock.getElapsedTime(), duration: 0.6 })
  }

  const probeFlashes: { nodeId: string; startTime: number }[] = []

  function triggerProbeFlash(nodeId: string) {
    probeFlashes.push({ nodeId, startTime: clock.getElapsedTime() })
  }

  function triggerConvergenceBeam() {
    convergenceBeam.active = true
    convergenceBeam.startTime = clock.getElapsedTime()
    convergenceBeam.phase = 0
    convergenceBeam.beams = []
    convergenceBeam.particles = []

    const l0Pos = nodeMeshes.get('l0-user-core')?.position ?? new THREE.Vector3(0, 0, 0)
    const l1Ids = ['l1-knowledge-feeder', 'l1-model-gateway', 'l1-task-translator', 'l1-pipeline-builder', 'l1-workspace-memory', 'l1-result-beautifier']
    const l2Nodes = nodeStore.nodes.filter(n => n.level === 'L2').slice(0, 8)
    const l3Nodes = nodeStore.nodes.filter(n => n.level === 'L3').slice(0, 12)

    const outerNodes = [...l3Nodes, ...l2Nodes]
    const innerNodes = l1Ids.map(id => ({ id, pos: nodeMeshes.get(id)?.position }))

    for (const n of outerNodes) {
      const mesh = nodeMeshes.get(n.id)
      if (!mesh) continue
      const points = [mesh.position.clone(), l0Pos.clone()]
      const geo = new THREE.BufferGeometry().setFromPoints(points)
      const mat = new THREE.LineBasicMaterial({
        color: 0x44ddff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const line = new THREE.Line(geo, mat)
      line.userData.beamType = 'outer'
      line.userData.targetPos = l0Pos.clone()
      scene.add(line)
      convergenceBeam.beams.push(line)
    }

    for (const n of innerNodes) {
      if (!n.pos) continue
      const points = [n.pos.clone(), l0Pos.clone()]
      const geo = new THREE.BufferGeometry().setFromPoints(points)
      const mat = new THREE.LineBasicMaterial({
        color: 0xffdd44,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const line = new THREE.Line(geo, mat)
      line.userData.beamType = 'inner'
      line.userData.targetPos = l0Pos.clone()
      scene.add(line)
      convergenceBeam.beams.push(line)
    }
  }

  function triggerL0PulsarBurst() {
    pulsarBurst.active = true
    pulsarBurst.startTime = clock.getElapsedTime()
    pulsarBurst.rings = []
    pulsarBurst.sprites = []

    const l0Pos = nodeMeshes.get('l0-user-core')?.position ?? new THREE.Vector3(0, 0, 0)

    for (let i = 0; i < 5; i++) {
      const innerR = 0.1 + i * 0.15
      const outerR = innerR + 0.08
      const geo = new THREE.RingGeometry(innerR, outerR, 64)
      const mat = new THREE.MeshBasicMaterial({
        color: i < 2 ? 0xffffff : i < 4 ? 0xffdd44 : 0xff8800,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      })
      const ring = new THREE.Mesh(geo, mat)
      ring.position.copy(l0Pos)
      ring.userData.pulsarRing = true
      ring.userData.ringIndex = i
      scene.add(ring)
      pulsarBurst.rings.push(ring)
    }

    const burstTex = createGlowTexture('#ffffff', '#ffdd88', 128, 3)
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.SpriteMaterial({
        map: burstTex,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const sprite = new THREE.Sprite(mat)
      sprite.position.copy(l0Pos)
      sprite.scale.set(0.1, 0.1, 1)
      const angle = (i / 24) * Math.PI * 2
      const elevation = (Math.random() - 0.5) * Math.PI * 0.8
      sprite.userData.pulsarParticle = true
      sprite.userData.direction = new THREE.Vector3(
        Math.cos(angle) * Math.cos(elevation),
        Math.sin(elevation),
        Math.sin(angle) * Math.cos(elevation)
      ).normalize()
      sprite.userData.speed = 2.0 + Math.random() * 3.0
      sprite.userData.birthIndex = i
      scene.add(sprite)
      pulsarBurst.sprites.push(sprite)
    }
  }

  function updateOrbits(elapsed: number) {
    const l0Pos = nodeMeshes.get('l0-user-core')?.position ?? new THREE.Vector3(0, 0, 0)

    const positions = new Map<string, THREE.Vector3>()
    nodeMeshes.forEach((mesh, nodeId) => {
      if (!mesh.userData.orbitRadius || mesh.userData.isCollapsed) return

      const r0 = mesh.userData.orbitRadius as number
      const baseAngle = mesh.userData.orbitBaseAngle as number
      const elev0 = mesh.userData.orbitElevation as number
      const speed = mesh.userData.orbitSpeed as number
      const elevOscSpeed = mesh.userData.orbitElevOscSpeed as number
      const elevOscAmp = mesh.userData.orbitElevOscAmp as number
      const radOscSpeed = mesh.userData.orbitRadOscSpeed as number
      const radOscAmp = mesh.userData.orbitRadOscAmp as number
      const phaseOff = mesh.userData.orbitPhaseOffset as number

      const angle = baseAngle + elapsed * speed + phaseOff
      const elev = elev0 + Math.sin(elapsed * elevOscSpeed + phaseOff * 1.3) * elevOscAmp
      const r = r0 + Math.sin(elapsed * radOscSpeed + phaseOff * 2.1) * radOscAmp

      const pos = new THREE.Vector3(
        l0Pos.x + r * Math.cos(elev) * Math.sin(angle),
        l0Pos.y + r * Math.sin(elev),
        l0Pos.z + r * Math.cos(elev) * Math.cos(angle)
      )
      positions.set(nodeId, pos)
    })

    const repulsionDist: Record<string, number> = {
      'L1': 1.8,
      'L2': 1.2,
      'L3': 0.6
    }
    const repulseStrength = 0.3
    const displacements = new Map<string, THREE.Vector3>()

    positions.forEach((posA, idA) => {
      const meshA = nodeMeshes.get(idA)
      if (!meshA) return
      const levelA = meshA.userData.level as string
      const isL1A = !!meshA.userData.isL1Orbit
      const minDist = repulsionDist[levelA] ?? 0.8
      const disp = new THREE.Vector3(0, 0, 0)

      positions.forEach((posB, idB) => {
        if (idA === idB) return
        const meshB = nodeMeshes.get(idB)
        if (!meshB) return
        const isL1B = !!meshB.userData.isL1Orbit
        if (isL1A && isL1B) return

        const diff = posA.clone().sub(posB)
        const dist = diff.length()
        const otherMinDist = repulsionDist[meshB.userData.level as string] ?? 0.8
        const effectiveMinDist = Math.max(minDist, otherMinDist)
        if (dist < effectiveMinDist && dist > 0.001) {
          const force = (1 - dist / effectiveMinDist) * (isL1A ? 0 : repulseStrength)
          disp.add(diff.normalize().multiplyScalar(force))
        }
      })

      displacements.set(idA, disp)
    })

    positions.forEach((pos, nodeId) => {
      const disp = displacements.get(nodeId) ?? new THREE.Vector3(0, 0, 0)
      const finalPos = pos.clone().add(disp)
      const mesh = nodeMeshes.get(nodeId)!
      mesh.position.copy(finalPos)

      const hitMesh = nodeHitTargets.get(nodeId)
      if (hitMesh) {
        hitMesh.position.copy(finalPos)
      }
    })

    nodeHitTargets.forEach((hitMesh, nodeId) => {
      const mesh = nodeMeshes.get(nodeId)
      if (mesh && mesh.userData.isCollapsed && mesh.userData.orbitRadius) {
        const r0 = mesh.userData.orbitRadius as number
        const baseAngle = mesh.userData.orbitBaseAngle as number
        const elev0 = mesh.userData.orbitElevation as number
        const speed = mesh.userData.orbitSpeed as number * 0.5
        const angle = baseAngle + elapsed * speed
        hitMesh.position.set(
          l0Pos.x + r0 * Math.cos(elev0) * Math.sin(angle),
          l0Pos.y + r0 * Math.sin(elev0) - 1.8,
          l0Pos.z + r0 * Math.cos(elev0) * Math.cos(angle)
        )
      }
    })
  }

  function updateL1Flashes(elapsed: number) {
    for (let i = l1Flashes.length - 1; i >= 0; i--) {
      const flash = l1Flashes[i]
      const t = (elapsed - flash.startTime) / flash.duration
      if (t >= 1) {
        l1Flashes.splice(i, 1)
        continue
      }

      const group = nodeMeshes.get(flash.nodeId)
      if (!group) continue
      const sprite = group.children.find(c => c instanceof THREE.Sprite && !c.userData.isLabel) as THREE.Sprite | undefined
      if (!sprite || !(sprite.material instanceof THREE.SpriteMaterial)) continue

      const intensity = Math.pow(1 - t, 2)
      sprite.material.color.setRGB(1, 1, 1)
      sprite.material.opacity = 1
      sprite.scale.setScalar(1.8 * intensity + 1.0)
    }

    for (let i = probeFlashes.length - 1; i >= 0; i--) {
      const pf = probeFlashes[i]
      const t = (elapsed - pf.startTime) / 0.5
      if (t >= 1) {
        probeFlashes.splice(i, 1)
        continue
      }
      const group = nodeMeshes.get(pf.nodeId)
      if (!group) continue
      const sprite = group.children.find(c => c instanceof THREE.Sprite && !c.userData.isLabel) as THREE.Sprite | undefined
      if (!sprite || !(sprite.material instanceof THREE.SpriteMaterial)) continue
      const intensity = Math.pow(1 - t, 2)
      sprite.material.color.setRGB(1, 0.15, 0.1)
      sprite.material.opacity = 1
      sprite.scale.setScalar(2.0 * intensity + 1.0)
    }
  }

  function updateConvergenceBeam(elapsed: number) {
    if (!convergenceBeam.active) return
    const t = elapsed - convergenceBeam.startTime

    if (t < 1.5) {
      for (const beam of convergenceBeam.beams) {
        if (!(beam.material instanceof THREE.LineBasicMaterial)) continue
        if (beam.userData.beamType === 'outer') {
          beam.material.opacity = Math.min(0.5, t * 0.5)
        } else {
          beam.material.opacity = Math.min(0.6, Math.max(0, (t - 0.5) * 0.8))
        }
      }
    } else if (t < 2.5) {
      for (const beam of convergenceBeam.beams) {
        if (!(beam.material instanceof THREE.LineBasicMaterial)) continue
        const fade = 1 - (t - 1.5)
        beam.material.opacity = fade * (beam.userData.beamType === 'outer' ? 0.5 : 0.6)
      }
    } else {
      for (const beam of convergenceBeam.beams) {
        scene.remove(beam)
        beam.geometry.dispose()
        if (beam.material instanceof THREE.LineBasicMaterial) beam.material.dispose()
      }
      convergenceBeam.beams = []
      convergenceBeam.active = false
    }

    if (t > 1.2 && convergenceBeam.phase === 0) {
      convergenceBeam.phase = 1
      triggerL0PulsarBurst()
    }
  }

  function updatePulsarBurst(elapsed: number) {
    if (!pulsarBurst.active) return
    const t = elapsed - pulsarBurst.startTime

    for (const ring of pulsarBurst.rings) {
      if (!(ring.material instanceof THREE.MeshBasicMaterial)) continue
      const idx = ring.userData.ringIndex as number
      const delay = idx * 0.15
      const rt = t - delay
      if (rt < 0) {
        ring.visible = false
        continue
      }
      ring.visible = true
      const expand = 1 + rt * 6
      ring.scale.set(expand, expand, expand)
      ring.material.opacity = Math.max(0, 0.9 - rt * 0.8)
      ring.lookAt(camera.position)
    }

    for (const sprite of pulsarBurst.sprites) {
      if (!(sprite.material instanceof THREE.SpriteMaterial)) continue
      const idx = sprite.userData.birthIndex as number
      const delay = idx * 0.03
      const st = t - delay
      if (st < 0) {
        sprite.visible = false
        continue
      }
      sprite.visible = true
      const dir = sprite.userData.direction as THREE.Vector3
      const speed = sprite.userData.speed as number
      const l0Pos = nodeMeshes.get('l0-user-core')?.position ?? new THREE.Vector3(0, 0, 0)
      sprite.position.copy(l0Pos).addScaledVector(dir, st * speed)
      const s = 0.15 * Math.max(0, 1 - st * 0.6)
      sprite.scale.set(s, s, 1)
      sprite.material.opacity = Math.max(0, 0.9 - st * 0.7)
    }

    if (t > 3.0) {
      for (const ring of pulsarBurst.rings) {
        scene.remove(ring)
        ring.geometry.dispose()
        if (ring.material instanceof THREE.MeshBasicMaterial) ring.material.dispose()
      }
      for (const sprite of pulsarBurst.sprites) {
        scene.remove(sprite)
        if (sprite.material instanceof THREE.SpriteMaterial) sprite.material.dispose()
      }
      pulsarBurst.rings = []
      pulsarBurst.sprites = []
      pulsarBurst.active = false
    }
  }

  function updateL1WorkVisuals(elapsed: number) {
    const status = nodeStore.l1WorkStatus
    const l1Ids = ['l1-knowledge-feeder', 'l1-model-gateway', 'l1-task-translator', 'l1-pipeline-builder', 'l1-workspace-memory', 'l1-result-beautifier']

    for (const nodeId of l1Ids) {
      const s = status[nodeId]
      if (!s || s === 'idle') continue

      const group = nodeMeshes.get(nodeId)
      if (!group) continue

      const sprite = group.children.find(c => c instanceof THREE.Sprite && !c.userData.isLabel) as THREE.Sprite | undefined
      if (!sprite || !(sprite.material instanceof THREE.SpriteMaterial)) continue

      if (s === 'working') {
        const pulse = Math.sin(elapsed * 6) * 0.3 + 0.7
        sprite.material.color.setRGB(0.9 * pulse, 0.7 * pulse, 0.2 * pulse)
        sprite.material.opacity = 0.6 + pulse * 0.4
        sprite.scale.setScalar(1.2 + pulse * 0.3)
      } else if (s === 'success') {
        sprite.material.color.setHex(0xffffff)
        sprite.material.opacity = 1
        sprite.scale.setScalar(1.5)
      } else if (s === 'error') {
        const errPulse = Math.sin(elapsed * 3) * 0.5 + 0.5
        sprite.material.color.setRGB(0.8 + errPulse * 0.2, 0.1, 0.1)
        sprite.material.opacity = 0.5 + errPulse * 0.5
        sprite.scale.setScalar(1 + errPulse * 0.2)
      } else if (s === 'long_running') {
        const ring = Math.sin(elapsed * 2) * 0.3 + 0.7
        sprite.material.color.setRGB(0.3, 0.5 * ring, 0.8 * ring)
        sprite.material.opacity = 0.6 + ring * 0.3
        sprite.scale.setScalar(1.3 + ring * 0.2)
      }
    }
  }

  function updateFlowParticles(delta: number, elapsed: number) {
    const paths = nodeStore.flowActivePaths
    if (paths.length === 0 && flowParticles.length === 0) return

    flowSpawnTimer += delta
    if (flowSpawnTimer > 0.12 && paths.length > 0) {
      flowSpawnTimer = 0
      const path = paths[Math.floor(Math.random() * paths.length)]
      const fromMesh = nodeMeshes.get(path.from)
      const toMesh = nodeMeshes.get(path.to)
      if (fromMesh && toMesh) {
        const tex = createGlowTexture('#66ddff', '#3388cc', 16, 1)
        const mat = new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          opacity: 0.8,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
        const sprite = new THREE.Sprite(mat)
        sprite.position.copy(fromMesh.position)
        sprite.scale.set(0.04, 0.04, 1)
        sprite.userData.isFlowParticle = true
        scene.add(sprite)
        flowParticles.push({
          sprite,
          from: fromMesh.position.clone(),
          to: toMesh.position.clone(),
          progress: 0,
          speed: 0.6 + Math.random() * 0.4,
          birthTime: elapsed
        })
      }
    }

    for (let i = flowParticles.length - 1; i >= 0; i--) {
      const fp = flowParticles[i]
      fp.progress += delta * fp.speed
      const t = Math.min(1, fp.progress)
      fp.sprite.position.lerpVectors(fp.from, fp.to, t)
      const s = 0.04 * (1 + Math.sin(t * Math.PI) * 0.5)
      fp.sprite.scale.set(s, s, 1)
      if (fp.sprite.material instanceof THREE.SpriteMaterial) {
        fp.sprite.material.opacity = 0.8 * (1 - t * 0.6)
      }
      if (t >= 1) {
        scene.remove(fp.sprite)
        if (fp.sprite.material instanceof THREE.SpriteMaterial) fp.sprite.material.dispose()
        flowParticles.splice(i, 1)
      }
    }

    const now = Date.now()
    for (let i = paths.length - 1; i >= 0; i--) {
      if (now - paths[i].startTime > 5000) {
        paths.splice(i, 1)
      }
    }
  }

  function spawnStarLogAsteroid(entryId: string, toolName: string) {
    const angle = Math.random() * Math.PI * 2
    const r = 3.0 + Math.random() * 1.5
    const startPos = new THREE.Vector3(
      Math.cos(angle) * r,
      (Math.random() - 0.5) * 2,
      Math.sin(angle) * r
    )

    const group = new THREE.Group()
    group.position.copy(startPos)

    const coreTex = createGlowTexture('#cc9966', '#886644', 64, 1)
    const coreMat = new THREE.SpriteMaterial({
      map: coreTex,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const coreSprite = new THREE.Sprite(coreMat)
    coreSprite.scale.set(0.15, 0.15, 1)
    group.add(coreSprite)

    const ringGeo = new THREE.RingGeometry(0.12, 0.14, 16)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xcc8844,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    group.add(ring)

    group.userData.entryId = entryId
    group.userData.isStarLog = true
    scene.add(group)

    starLogAsteroids.push({
      group,
      entryId,
      targetPos: new THREE.Vector3(0, 0, 0),
      returning: false,
      returnProgress: 0
    })
  }

  function triggerStarLogReturn(entryId: string) {
    const asteroid = starLogAsteroids.find(a => a.entryId === entryId && !a.returning)
    if (asteroid) {
      asteroid.returning = true
      asteroid.returnProgress = 0
      asteroid.targetPos = new THREE.Vector3(0, 0, 0)
    }
  }

  function updateStarLogAsteroids(delta: number) {
    for (let i = starLogAsteroids.length - 1; i >= 0; i--) {
      const ast = starLogAsteroids[i]

      if (ast.returning) {
        ast.returnProgress += delta * 1.5
        const t = Math.min(1, ast.returnProgress)
        const eased = 1 - Math.pow(1 - t, 3)
        const startPos = ast.group.userData.originalPos as THREE.Vector3 | undefined
        if (!startPos) {
          ast.group.userData.originalPos = ast.group.position.clone()
        }
        const from = (ast.group.userData.originalPos as THREE.Vector3) || ast.group.position.clone()
        ast.group.position.lerpVectors(from, ast.targetPos, eased)
        ast.group.scale.setScalar(1 - t * 0.5)

        if (t >= 1) {
          scene.remove(ast.group)
          starLogAsteroids.splice(i, 1)
        }
      } else {
        const bob = Math.sin(Date.now() * 0.001 + i * 1.7) * 0.003
        ast.group.position.y += bob
        const ring = ast.group.children[1]
        if (ring) ring.rotation.z += delta * 0.5
      }
    }
  }

  function updateFilterVisibility() {
    const visible = nodeStore.visibleNodeIds
    const hasFilter = nodeStore.levelFilter.length > 0 || nodeStore.roleFilter.length > 0
    for (const [id, mesh] of nodeMeshes) {
      if (hasFilter) {
        mesh.visible = visible.has(id)
        const hit = nodeHitTargets.get(id)
        if (hit) hit.visible = visible.has(id)
      } else {
        mesh.visible = true
        const hit = nodeHitTargets.get(id)
        if (hit) hit.visible = true
      }
    }
  }

  function updateSelectionRing(elapsed: number) {
    const selectedId = nodeStore.interaction.selectedNodeId

    if (!selectedId) {
      if (selectionRingGroup) {
        scene.remove(selectionRingGroup)
        selectionRingGroup.traverse((obj) => {
          if (obj instanceof THREE.Mesh) { obj.geometry.dispose(); obj.material.dispose() }
          if (obj instanceof THREE.Sprite && obj.material instanceof THREE.SpriteMaterial) { obj.material.dispose() }
        })
        selectionRingGroup = null
        selectionRingTargetId = null
      }
      return
    }

    if (selectedId !== selectionRingTargetId) {
      if (selectionRingGroup) {
        scene.remove(selectionRingGroup)
        selectionRingGroup.traverse((obj) => {
          if (obj instanceof THREE.Mesh) { obj.geometry.dispose(); obj.material.dispose() }
          if (obj instanceof THREE.Sprite && obj.material instanceof THREE.SpriteMaterial) { obj.material.dispose() }
        })
      }

      selectionRingGroup = new THREE.Group()

      const glowTex = createGlowTexture('#ffffff', '#aaccff', 64, 2)
      const particleCount = 120
      for (let i = 0; i < particleCount; i++) {
        const mat = new THREE.SpriteMaterial({
          map: glowTex,
          transparent: true,
          opacity: 0.5 + Math.random() * 0.4,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
        const sp = new THREE.Sprite(mat)
        const angle = (i / particleCount) * Math.PI * 2 + Math.random() * 0.2
        const r = 0.55 + Math.random() * 0.25
        sp.userData.selParticle = true
        sp.userData.baseAngle = angle
        sp.userData.orbitR = r
        sp.userData.speed = 0.3 + Math.random() * 0.4
        sp.userData.baseOpacity = 0.3 + Math.random() * 0.5
        sp.userData.size = 0.04 + Math.random() * 0.08
        sp.scale.set(sp.userData.size as number, sp.userData.size as number, 1)
        selectionRingGroup.add(sp)
      }

      scene.add(selectionRingGroup)
      selectionRingTargetId = selectedId
    }

    if (selectionRingGroup) {
      const targetMesh = nodeMeshes.get(selectedId)
      if (targetMesh) {
        selectionRingGroup.position.copy(targetMesh.position)
      }

      selectionRingGroup.children.forEach((child) => {
        if (child instanceof THREE.Sprite && child.userData.selParticle) {
          const baseAngle = child.userData.baseAngle as number
          const r = child.userData.orbitR as number
          const speed = child.userData.speed as number
          const baseOp = child.userData.baseOpacity as number
          const sz = child.userData.size as number
          const a = baseAngle + elapsed * speed
          child.position.set(Math.cos(a) * r, Math.sin(a) * r, 0)
          if (child.material instanceof THREE.SpriteMaterial) {
            const twinkle = Math.sin(elapsed * (3 + speed * 5) + baseAngle * 3) * 0.5 + 0.5
            child.material.opacity = baseOp * (0.4 + twinkle * 0.6)
          }
        }
      })

      selectionRingGroup.lookAt(camera.position)
    }
  }

  function updateAnimations(delta: number, elapsed: number) {
    const hoveredId = nodeStore.interaction.hoveredNodeId
    const selectedId = nodeStore.interaction.selectedNodeId
    const multiSelectedIds = new Set(nodeStore.selectedNodeIds)

    selectionBreathTime += delta

    scene.traverse((obj) => {
      if (obj.userData.nodeId) {
        const isHovered = obj.userData.nodeId === hoveredId
        const isSelected = obj.userData.nodeId === selectedId
        const isMultiSelected = multiSelectedIds.has(obj.userData.nodeId)
        const baseScale = obj.userData.baseScale as number || 1.0

        let targetScale = baseScale
        if (isSelected) {
          const breathPulse = Math.sin(selectionBreathTime * 2.5) * 0.5 + 0.5
          targetScale = baseScale * (1.2 + breathPulse * 0.3)
        } else if (isMultiSelected) {
          const breathPulse = Math.sin(selectionBreathTime * 3) * 0.5 + 0.5
          targetScale = baseScale * (1.1 + breathPulse * 0.2)
        } else if (isHovered) {
          targetScale = baseScale * 1.5
        }

        const currentScale = obj.scale.x
        const newScale = currentScale + (targetScale - currentScale) * Math.min(1, delta * 8)
        obj.scale.set(newScale, newScale, newScale)

        if ((isSelected || isMultiSelected) && obj.userData.level !== 'L0') {
          if (obj.children[0] instanceof THREE.Sprite && obj.children[0].material instanceof THREE.SpriteMaterial) {
            const breathPulse = Math.sin(selectionBreathTime * 2.5) * 0.5 + 0.5
            obj.children[0].material.opacity = Math.min(1, 0.7 + breathPulse * 0.3)
          }
        }
      }

      if (obj.userData.isL0Core && obj instanceof THREE.Sprite && obj.material instanceof THREE.SpriteMaterial) {
        if (!nodeStore.interaction.l0RedFlash) {
          obj.material.opacity = 1.0
        }
      }

      if (obj.userData.isL0InnerGlow && obj instanceof THREE.Sprite && obj.material instanceof THREE.SpriteMaterial) {
        if (!nodeStore.interaction.l0RedFlash) {
          const breathe = Math.sin(elapsed * 1.5) * 0.5 + 0.5
          obj.material.opacity = 0.5 + breathe * 0.3
        }
      }

      if (obj.userData.isL0Corona && obj instanceof THREE.Sprite && obj.material instanceof THREE.SpriteMaterial) {
        const idx = obj.userData.coronaIndex as number
        const phaseOff = obj.userData.phaseOffset as number
        const baseS = obj.userData.baseScale as number
        const breathA = Math.sin(elapsed * (0.8 + idx * 0.3) + phaseOff) * 0.5 + 0.5
        const breathB = Math.sin(elapsed * (0.5 + idx * 0.2) + phaseOff * 1.7) * 0.5 + 0.5
        const scale = baseS * (1.0 + breathA * 0.08 + breathB * 0.04)
        obj.scale.set(scale, scale, 1)
        obj.material.rotation += delta * (obj.userData.rotSpeed as number) * (idx % 2 === 0 ? 1 : -1)
      }
      if (obj.userData.pulseSpeed && obj instanceof THREE.Sprite && obj.material instanceof THREE.SpriteMaterial && !obj.userData.nodeId) {
        const pulse = Math.sin(elapsed * (obj.userData.pulseSpeed as number)) * 0.5 + 0.5
        const baseOpacity = (obj.userData.pulseMin as number) + pulse * ((obj.userData.pulseMax as number) - (obj.userData.pulseMin as number))
        obj.material.opacity = baseOpacity
      }

      if (obj.userData.isL3 || obj.userData.isCollapsed) {
      }
    })

    for (let i = pulsingObjects.length - 1; i >= 0; i--) {
      const obj = pulsingObjects[i]
      obj.userData.pulseTime = (obj.userData.pulseTime as number) + delta
      const t = obj.userData.pulseTime as number
      const scale = 1 + t * 4
      obj.scale.set(scale, scale, scale)
      if (obj.material instanceof THREE.SpriteMaterial) {
        obj.material.opacity = Math.max(0, 0.7 - t * 0.9)
      }
      if (t > 0.9) {
        if (obj.userData.isPoolItem) {
          obj.visible = false
          obj.scale.set(1, 1, 1)
        } else {
          scene.remove(obj)
          obj.material.dispose()
        }
        pulsingObjects.splice(i, 1)
      }
    }

    if (starfieldRef) {
      starfieldRef.rotation.y += delta * 0.001
    }
    for (const df of deepFieldObjects) {
      df.rotation.y += delta * 0.0005
    }
  }

  function triggerDAGChain(
    stepNodes: { nodeId: string; stepNum: number; dependsOn: number[] }[]
  ) {
    clearDAGChain()
    dagChain.active = true
    dagChain.startTime = clock.getElapsedTime()
    dagChain.steps = stepNodes.map(s => ({
      nodeId: s.nodeId,
      stepNum: s.stepNum,
      status: 'pending' as const
    }))
    dagChain.lines = []

    for (let i = 0; i < stepNodes.length; i++) {
      const from = stepNodes[i]
      for (const depStep of from.dependsOn) {
        const depNode = stepNodes.find(s => s.stepNum === depStep)
        if (!depNode) continue
        const fromMesh = nodeMeshes.get(from.nodeId)
        const toMesh = nodeMeshes.get(depNode.nodeId)
        if (!fromMesh || !toMesh) continue
        const points = [toMesh.position.clone(), fromMesh.position.clone()]
        const geo = new THREE.BufferGeometry().setFromPoints(points)
        const mat = new THREE.LineDashedMaterial({
          color: 0x9944ff,
          transparent: true,
          opacity: 0.6,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          dashSize: 0.15,
          gapSize: 0.08
        })
        const line = new THREE.Line(geo, mat)
        line.computeLineDistances()
        line.userData.dagStepFrom = depStep
        line.userData.dagStepTo = from.stepNum
        scene.add(line)
        dagChain.lines.push(line)
      }
    }
  }

  function setDAGStepStatus(stepNum: number, status: 'pending' | 'running' | 'done' | 'failed' | 'replanned' | 'reuse' | 'skip') {
    const step = dagChain.steps.find(s => s.stepNum === stepNum)
    if (!step) return
    step.status = status

    for (const line of dagChain.lines) {
      if (line.userData.dagStepTo === stepNum) {
        if (!(line.material instanceof THREE.LineDashedMaterial)) continue
        if (status === 'running') {
          line.material.color.setHex(0x44ddff)
          line.material.opacity = 0.9
          line.material.dashSize = 0.3
          line.material.gapSize = 0.02
        } else if (status === 'done') {
          line.material.color.setHex(0xffdd44)
          line.material.opacity = 0.7
          line.material.dashSize = 0.5
          line.material.gapSize = 0
        } else if (status === 'failed') {
          line.material.color.setHex(0xff4444)
          line.material.opacity = 0.8
          line.material.dashSize = 0.1
          line.material.gapSize = 0.1
        } else if (status === 'replanned') {
          line.material.color.setHex(0xff8800)
          line.material.opacity = 0.9
          line.material.dashSize = 0.2
          line.material.gapSize = 0.06
        } else if (status === 'reuse') {
          line.material.color.setHex(0x44ff88)
          line.material.opacity = 0.5
          line.material.dashSize = 0.4
          line.material.gapSize = 0
        } else if (status === 'skip') {
          line.material.color.setHex(0x555566)
          line.material.opacity = 0.2
          line.material.dashSize = 0.05
          line.material.gapSize = 0.15
        } else {
          line.material.color.setHex(0x9944ff)
          line.material.opacity = 0.4
          line.material.dashSize = 0.15
          line.material.gapSize = 0.08
        }
        line.computeLineDistances()
        line.material.needsUpdate = true
      }
    }

    if (status === 'running') {
      triggerL1Flash(step.nodeId)
    }
  }

  function clearDAGChain() {
    for (const line of dagChain.lines) {
      scene.remove(line)
      line.geometry.dispose()
      if (line.material instanceof THREE.Material) line.material.dispose()
    }
    // Remove orphaned ghost sprites from all node meshes
    nodeMeshes.forEach((mesh) => {
      const ghosts: THREE.Sprite[] = []
      mesh.children.forEach(c => { if (c.userData.isDAGGhost) ghosts.push(c as THREE.Sprite) })
      for (const ghost of ghosts) {
        mesh.remove(ghost)
        if (ghost.material instanceof THREE.SpriteMaterial) {
          ghost.material.map?.dispose()
          ghost.material.dispose()
        }
      }
    })
    dagChain = { active: false, steps: [], lines: [], startTime: 0 }
  }

  function updateDAGChain(elapsed: number) {
    if (!dagChain.active) return
    const t = elapsed - dagChain.startTime

    // Update line positions to follow orbiting nodes
    for (const line of dagChain.lines) {
      if (!(line.material instanceof THREE.LineDashedMaterial)) continue
      const fromStep = dagChain.steps.find(s => s.stepNum === line.userData.dagStepTo)
      const toStep = dagChain.steps.find(s => s.stepNum === line.userData.dagStepFrom)
      if (fromStep && toStep) {
        const fromMesh = nodeMeshes.get(fromStep.nodeId)
        const toMesh = nodeMeshes.get(toStep.nodeId)
        if (fromMesh && toMesh) {
          const positions = line.geometry.attributes.position as THREE.BufferAttribute
          if (positions) {
            positions.setXYZ(0, toMesh.position.x, toMesh.position.y, toMesh.position.z)
            positions.setXYZ(1, fromMesh.position.x, fromMesh.position.y, fromMesh.position.z)
            positions.needsUpdate = true
            line.computeLineDistances()
          }
        }
      }
      const stepTo = line.userData.dagStepTo || 0
      const targetStep = dagChain.steps.find(s => s.stepNum === stepTo)
      let baseOp = 0.4
      if (targetStep) {
        if (targetStep.status === 'running') baseOp = 0.8
        else if (targetStep.status === 'done') baseOp = 0.6
        else if (targetStep.status === 'failed') baseOp = 0.7
        else if (targetStep.status === 'replanned') baseOp = 0.8
        else if (targetStep.status === 'reuse') baseOp = 0.35
        else if (targetStep.status === 'skip') baseOp = 0.12
      }
      const pulse = Math.sin(t * 3 + stepTo * 0.5) * 0.15
      line.material.opacity = Math.max(0.1, Math.min(1, baseOp + pulse))
    }
    for (const step of dagChain.steps) {
      const mesh = nodeMeshes.get(step.nodeId)
      if (!mesh) continue
      if (step.status === 'pending') {
        const depLines = dagChain.lines.filter(l => l.userData.dagStepTo === step.stepNum)
        const allDepsDone = depLines.length === 0 || depLines.every(l => {
          const depStep = dagChain.steps.find(ds => ds.stepNum === l.userData.dagStepFrom)
          return depStep?.status === 'done' || depStep?.status === 'reuse'
        })
        if (!allDepsDone) {
          let ghost = mesh.children.find(c => c.userData.isDAGGhost) as THREE.Sprite | undefined
          if (!ghost) {
            const ghostTex = createGlowTexture('#9944ff', '#6622aa', 64, 1)
            const ghostMat = new THREE.SpriteMaterial({
              map: ghostTex,
              transparent: true,
              opacity: 0.25,
              blending: THREE.AdditiveBlending,
              depthWrite: false
            })
            ghost = new THREE.Sprite(ghostMat)
            ghost.scale.set(1.5, 1.5, 1)
            ghost.userData.isDAGGhost = true
            mesh.add(ghost)
          }
          if (ghost.material instanceof THREE.SpriteMaterial) {
            ghost.material.opacity = 0.15 + Math.sin(t * 2) * 0.1
          }
        } else {
          const ghost = mesh.children.find(c => c.userData.isDAGGhost)
          if (ghost) {
            mesh.remove(ghost)
            if (ghost instanceof THREE.Sprite && ghost.material instanceof THREE.SpriteMaterial) ghost.material.dispose()
          }
        }
      } else if (step.status === 'reuse') {
        const ghost = mesh.children.find(c => c.userData.isDAGGhost)
        if (ghost) {
          mesh.remove(ghost)
          if (ghost instanceof THREE.Sprite && ghost.material instanceof THREE.SpriteMaterial) ghost.material.dispose()
        }
      } else if (step.status === 'skip') {
        const ghost = mesh.children.find(c => c.userData.isDAGGhost)
        if (ghost) {
          mesh.remove(ghost)
          if (ghost instanceof THREE.Sprite && ghost.material instanceof THREE.SpriteMaterial) ghost.material.dispose()
        }
      } else {
        const ghost = mesh.children.find(c => c.userData.isDAGGhost)
        if (ghost) {
          mesh.remove(ghost)
          if (ghost instanceof THREE.Sprite && ghost.material instanceof THREE.SpriteMaterial) ghost.material.dispose()
        }
      }
    }
  }

  let fpsCapMode = false
  let lastFrameTime = 0
  const LOW_FPS_INTERVAL = 1000

  const onVisibilityChange = () => { fpsCapMode = document.hidden }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  function animate() {
    animationId = requestAnimationFrame(animate)
    const now = performance.now()
    if (fpsCapMode && now - lastFrameTime < LOW_FPS_INTERVAL) return
    lastFrameTime = now
    const delta = clock.getDelta()
    const elapsed = clock.getElapsedTime()

    controls.update()
    updateFlyTo(delta)

    updateFilterVisibility()
    updateOnboardingAnimations(delta, elapsed)
    updateDegradedVisuals(delta, elapsed)
    updateIngestAnimation(delta, elapsed)
    updateL3DecayWarning(elapsed)
    updateL0RedFlash(elapsed)
    updateL1WorkVisuals(elapsed)
    updateOrbits(elapsed)
    updateL2Highlights(elapsed)
    updateL1Flashes(elapsed)
    updateDAGChain(elapsed)
    updateConvergenceBeam(elapsed)
    updatePulsarBurst(elapsed)
    updateFlowParticles(delta, elapsed)
    updateStarLogAsteroids(delta)
    updateTractorBeam(elapsed)
    updateSelectionRing(elapsed)
    updateCacheHitVisuals()
    updateAnimations(delta, elapsed)
    renderer.render(scene, camera)
  }

  function onResize() {
    const el = containerRef.value
    if (!el || !renderer || !camera || !controls) return
    const w = el.clientWidth || window.innerWidth
    const h = el.clientHeight || window.innerHeight
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    controls.handleResize()
  }

  function flyToNode(nodeId: string) {
    const mesh = nodeMeshes.get(nodeId)
    if (!mesh || !camera || !controls) return
    isFlyingTo = true
    flyStartPos.copy(camera.position)
    flyTargetLookAt.copy(mesh.position)
    const dir = new THREE.Vector3()
    camera.getWorldDirection(dir)
    flyTargetPos.copy(mesh.position).sub(dir.multiplyScalar(4))
    flyTargetPos.y = mesh.position.y + 1
    flyProgress = 0
    controls.enabled = false
  }

  function resetCamera() {
    if (!camera || !controls) return
    isFlyingTo = true
    flyStartPos.copy(camera.position)
    flyTargetPos.set(0, 2, 12)
    flyTargetLookAt.set(0, 0, 0)
    flyProgress = 0
    controls.enabled = false
  }

  function updateFlyTo(delta: number) {
    if (!isFlyingTo) return
    flyProgress += delta * 1.5
    const t = Math.min(1, flyProgress)
    const eased = t * t * (3 - 2 * t)
    camera!.position.lerpVectors(flyStartPos, flyTargetPos, eased)
    controls!.target.lerp(flyTargetLookAt, eased * 0.3)
    if (t >= 1) {
      isFlyingTo = false
      controls!.target.copy(flyTargetLookAt)
      controls!.enabled = true
    }
  }

  function setDegradedVisuals(isDegraded: boolean) {
    if (!isDegraded) {
      if (l0SpriteRef && l0SpriteRef.material instanceof THREE.SpriteMaterial) {
        l0SpriteRef.material.color.setHex(0xffffff)
        l0SpriteRef.material.opacity = 1.0
      }
      for (const cs of l0CoronaSprites) {
        if (cs.material instanceof THREE.SpriteMaterial) {
          cs.material.opacity = 1.0
        }
      }
      if (cubeWireframeRef && cubeWireframeRef.material instanceof THREE.LineBasicMaterial) {
        cubeWireframeRef.material.opacity = 0.08
        cubeWireframeRef.material.color.setHex(0x3366aa)
      }
    }
    rebuildAllL2Nodes()
  }

  function dispose() {
    cancelAnimationFrame(animationId)
    window.removeEventListener('resize', onResize)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (renderer) {
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
    }
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose())
        } else {
          obj.material.dispose()
        }
      }
    })
    renderer.dispose()
    if (hoverTimer) clearTimeout(hoverTimer)
  }

  function setThemeBackground(theme: 'dark' | 'light' | 'green') {
    if (!renderer || !scene) return
    const bgMap: Record<string, number> = { dark: 0x050510, light: 0xd8dce8, green: 0x1a2a1a }
    renderer.setClearColor(bgMap[theme] ?? 0x050510)
    if (scene.fog) {
      const fogColorMap: Record<string, number> = { dark: 0x050510, light: 0xd8dce8, green: 0x1a2a1a }
      (scene.fog as THREE.Fog).color.setHex(fogColorMap[theme] ?? 0x050510)
    }
  }

  return { init, dispose, isReady, hitTest, nodeMeshes, startOnboarding, setDegradedVisuals, rebuildNode, spawnStarLogAsteroid, triggerStarLogReturn, triggerL1Flash, triggerProbeFlash, triggerConvergenceBeam, triggerL0PulsarBurst, highlightL2Candidates, setL2Selected, triggerDAGChain, setDAGStepStatus, clearDAGChain, setThemeBackground, flyToNode, resetCamera, hoveredNodeInfo, onResize }
}
