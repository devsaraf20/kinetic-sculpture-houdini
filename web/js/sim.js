// Three.js simulation of the sculpture: ceiling, motors, strings, balls.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLAG_RANGE, FLAG_SPEED, FLAG_ACCEL } from './limits.js';

const MM = 0.001;           // scene units are metres
const FLOOR_GAP = 0.25;     // metres between floor and the lowest ball position

export const COLORS = {
  ball: new THREE.Color('#d9d2c3'),
  low: new THREE.Color('#5b7fa6'),
  high: new THREE.Color('#e8c27a'),
  speed: new THREE.Color('#ff3b3b'),
  accel: new THREE.Color('#ff9a1f'),
  range: new THREE.Color('#d03cff'),
  selected: new THREE.Color('#2ee6c9'),
};

export class SculptureView {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0f1216');
    this.scene.fog = new THREE.Fog('#0f1216', 6, 16);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight('#cfd8e3', '#20242b', 0.9));
    const key = new THREE.DirectionalLight('#ffffff', 1.6);
    key.position.set(2.5, 4, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -2;
    key.shadow.camera.right = key.shadow.camera.top = 2;
    this.scene.add(key);
    this.key = key;

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.colorMode = 'height';
    this.colorRange = null;   // [lo, hi] mm for the height gradient (default: travel)
    this.selected = -1;
    this.onPick = () => {};
    this.raycaster = new THREE.Raycaster();
    this.pointerDown = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', e => { this.pointerDown = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', e => {
      if (!this.pointerDown) return;
      const d = Math.hypot(e.clientX - this.pointerDown[0], e.clientY - this.pointerDown[1]);
      this.pointerDown = null;
      if (d < 5) this.pick(e);
    });
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  /** (Re)build geometry for a grid of balls. */
  build({ rows, cols, spacing_mm, balls, minMM, maxMM }) {
    this.root.clear();
    this.rows = rows; this.cols = cols; this.balls = balls;
    this.minMM = minMM; this.maxMM = maxMM;
    const sp = (spacing_mm || 100) * MM;
    const n = balls.length;
    this.ballY0 = FLOOR_GAP - minMM * MM;
    const ceilY = FLOOR_GAP + (maxMM - minMM) * MM + 0.18;
    this.ceilY = ceilY;
    const w = (cols - 1) * sp, d = (rows - 1) * sp;
    this.pos = balls.map(b => new THREE.Vector3(b.col * sp - w / 2, 0, b.row * sp - d / 2));
    const radius = Math.min(sp * 0.32, 0.06);
    this.radius = radius;

    const floor = new THREE.Mesh(new THREE.CircleGeometry(Math.max(w, d) * 1.2 + 1.5, 64),
      new THREE.MeshStandardMaterial({ color: '#171b21', roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.root.add(floor);
    const grid = new THREE.GridHelper(Math.max(w, d) + 1.2, Math.round((Math.max(w, d) + 1.2) / 0.1), '#2a313b', '#1d232b');
    grid.position.y = 0.001;
    this.root.add(grid);

    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(w + sp * 1.4, 0.04, d + sp * 1.4),
      new THREE.MeshStandardMaterial({ color: '#2b3038', roughness: 0.6, metalness: 0.3 }));
    ceiling.position.y = ceilY + 0.06;
    this.root.add(ceiling);

    // Motors (instanced boxes under the ceiling plate).
    const motorGeo = new THREE.BoxGeometry(sp * 0.42, 0.042, sp * 0.42);
    const motorMat = new THREE.MeshStandardMaterial({ color: '#3a414c', roughness: 0.4, metalness: 0.6 });
    const motors = new THREE.InstancedMesh(motorGeo, motorMat, n);
    const m4 = new THREE.Matrix4();
    this.pos.forEach((p, i) => { m4.makeTranslation(p.x, ceilY + 0.02, p.z); motors.setMatrixAt(i, m4); });
    this.root.add(motors);

    // Travel envelope: faint planes at the lowest and highest allowed height.
    const envMat = new THREE.MeshBasicMaterial({ color: '#2ee6c9', transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false });
    for (const mm of [minMM, maxMM]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(w + sp, d + sp), envMat);
      pl.rotation.x = -Math.PI / 2;
      pl.position.y = this.ballY0 + mm * MM;
      this.root.add(pl);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(pl.geometry),
        new THREE.LineBasicMaterial({ color: '#2ee6c9', transparent: true, opacity: 0.25 }));
      edge.rotation.x = -Math.PI / 2;
      edge.position.copy(pl.position);
      this.root.add(edge);
    }

    // Balls.
    const ballGeo = new THREE.SphereGeometry(radius, 24, 16);
    const ballMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.25 });
    this.ballMesh = new THREE.InstancedMesh(ballGeo, ballMat, n);
    this.ballMesh.castShadow = true;
    this.ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n; i++) this.ballMesh.setColorAt(i, COLORS.ball);
    this.root.add(this.ballMesh);

    // Ghost balls (original animation when viewing the smoothed one).
    this.ghostMesh = new THREE.InstancedMesh(ballGeo, new THREE.MeshBasicMaterial({ color: '#8fa3b8', wireframe: true, transparent: true, opacity: 0.25 }), n);
    this.ghostMesh.visible = false;
    this.root.add(this.ghostMesh);

    // Selection ring.
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.45, radius * 0.12, 8, 32),
      new THREE.MeshBasicMaterial({ color: COLORS.selected }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    this.root.add(this.ring);

    // Strings.
    this.stringPos = new Float32Array(n * 6);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.stringPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.strings = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: '#7d8794', transparent: true, opacity: 0.7 }));
    this.root.add(this.strings);

    // Camera framing.
    const size = Math.max(w, d, (maxMM - minMM) * MM);
    const mid = (FLOOR_GAP + ceilY) / 2;
    this.controls.target.set(0, mid, 0);
    this.camera.position.set(size * 1.6 + 0.6, mid + size * 0.55 + 0.3, size * 1.9 + 0.8);
    this.key.shadow.camera.left = this.key.shadow.camera.bottom = -size - 0.5;
    this.key.shadow.camera.right = this.key.shadow.camera.top = size + 0.5;
    this.key.shadow.camera.updateProjectionMatrix();
    this.scene.fog.near = size * 3 + 2; this.scene.fog.far = size * 6 + 8;
    this.controls.update();
  }

  /**
   * heights: Float32Array-like of length n (mm) for the frame to show.
   * flags: per-ball violation flags for that frame (Uint8Array) or null.
   * ghost: optional heights of the original animation.
   */
  update(heights, flags, ghost = null) {
    if (!this.ballMesh) return;
    const n = this.pos.length;
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    const [cLo, cHi] = this.colorRange || [this.minMM, this.maxMM];
    const span = Math.max(cHi - cLo, 1);
    for (let i = 0; i < n; i++) {
      const p = this.pos[i];
      const y = this.ballY0 + heights[i] * MM;
      m4.makeTranslation(p.x, y, p.z);
      this.ballMesh.setMatrixAt(i, m4);
      const fl = flags ? flags[i] : 0;
      if (fl & FLAG_RANGE) col.copy(COLORS.range);
      else if (fl & FLAG_SPEED) col.copy(COLORS.speed);
      else if (fl & FLAG_ACCEL) col.copy(COLORS.accel);
      else if (this.colorMode === 'height') {
        const t = Math.min(1, Math.max(0, (heights[i] - cLo) / span));
        col.copy(COLORS.low).lerp(COLORS.high, t);
      } else col.copy(COLORS.ball);
      this.ballMesh.setColorAt(i, col);
      const k = i * 6;
      this.stringPos[k] = p.x; this.stringPos[k + 1] = this.ceilY; this.stringPos[k + 2] = p.z;
      this.stringPos[k + 3] = p.x; this.stringPos[k + 4] = y + this.radius; this.stringPos[k + 5] = p.z;
      if (i === this.selected) this.ring.position.set(p.x, y, p.z);
      if (ghost) { m4.makeTranslation(p.x, this.ballY0 + ghost[i] * MM, p.z); this.ghostMesh.setMatrixAt(i, m4); }
    }
    this.ballMesh.instanceMatrix.needsUpdate = true;
    this.ballMesh.instanceColor.needsUpdate = true;
    this.strings.geometry.attributes.position.needsUpdate = true;
    this.strings.geometry.computeBoundingSphere();
    this.ballMesh.computeBoundingSphere();
    this.ghostMesh.visible = !!ghost;
    if (ghost) this.ghostMesh.instanceMatrix.needsUpdate = true;
    this.ring.visible = this.selected >= 0;
  }

  select(i) { this.selected = i; }

  pick(e) {
    if (!this.ballMesh) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    const hit = this.raycaster.intersectObject(this.ballMesh)[0];
    this.onPick(hit ? hit.instanceId : -1);
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
