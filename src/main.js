import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const $ = (s) => document.querySelector(s);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const COARSE = matchMedia('(pointer: coarse)').matches || innerWidth < 800;

/* ---------- capability + fallback ---------- */
// probes WebGL level and whether the device looks like a strong GPU (webgl2, high DPR, large screen)
function probeGPU() {
  try {
    const c = document.createElement('canvas');
    const gl2 = c.getContext('webgl2');
    if (!gl2) return { ok: !!c.getContext('webgl'), strong: false };
    const maxTex = gl2.getParameter(gl2.MAX_TEXTURE_SIZE);
    const dpr = window.devicePixelRatio || 1;
    return { ok: true, strong: !COARSE && maxTex >= 8192 && dpr >= 1.5 && innerWidth >= 1280 };
  } catch { return { ok: false, strong: false }; }
}
const GPU = probeGPU();
const RICH = GPU.strong;               // richer colour variance + denser fields on strong GPUs only
const DENS = RICH ? 1.6 : 1;
const dn = (n) => Math.round(n * DENS);

// startup runs at the bottom of the module, after every let/const is initialised

// Text choreography. Each .reveal block is driven by its on-screen position, so it fades and
// rises in as the camera approaches its chapter and fades out as the camera passes it.
// Reduced motion or missing JS: everything is simply shown, no transforms at all.
const REVEALS = [];
function setupReveal() {
  const els = [...document.querySelectorAll('.reveal')];
  if (REDUCED || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  document.documentElement.classList.add('choreo');
  REVEALS.push(...els);
}
function updateReveals() {
  if (!REVEALS.length) return;
  const vh = innerHeight || 1;
  for (const el of REVEALS) {
    const r = el.getBoundingClientRect();
    const c = (r.top + r.bottom) / 2 / vh;             // 0 = top of screen, 1 = bottom
    const enter = sstep(1.02, 0.82, c);                  // rises in as the block reaches the lower-middle
    const leave = sstep(0.22, 0.02, c);                  // fades out once it slides past the top
    const v = enter * (1 - leave);
    el.style.setProperty('--rv', v.toFixed(3));
    el.style.setProperty('--ry', ((1 - enter) * 34 + leave * -18).toFixed(1) + 'px');
  }
}

/* ---------- seeded random ---------- */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => (r() + r() + r() - 1.5) / 1.5;

/* ---------- shaders ---------- */
const SHARED = {
  uTime: { value: 0 },
  uPR: { value: 1 },
  uScale: { value: 1 },
  uNear: { value: 2.0 },
  uFar: { value: 320.0 },
};

const COMMON_VERT = /* glsl */ `
uniform float uPR; uniform float uScale; uniform float uNear; uniform float uFar;
varying vec3 vColor; varying float vAlpha;
float pointFade(float d){
  return smoothstep(uNear, uNear + 5.0, d) * (1.0 - smoothstep(uFar * 0.5, uFar, d));
}
void emitPoint(vec4 mv, float sz){
  float d = max(-mv.z, 0.001);
  gl_PointSize = clamp(sz * uPR * uScale * 260.0 / d, 0.6, 72.0);
  gl_Position = projectionMatrix * mv;
}
`;

const POINT_FRAG = /* glsl */ `
precision highp float;
uniform float uOpacity;
varying vec3 vColor; varying float vAlpha;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float core = exp(-d * d * 5.5);
  float a = core * vAlpha * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

const GALAXY_VERT = COMMON_VERT + /* glsl */ `
attribute float aR; attribute float aA; attribute float aH; attribute float aSize; attribute vec3 aColor;
uniform float uRad; uniform float uSpin; uniform float uThick; uniform float uTime;
void main(){
  float r = aR * uRad;
  float ang = aA + aR * 5.2 + uTime * uSpin / (0.25 + aR);
  vec3 p = vec3(cos(ang) * r, aH * uThick * (0.2 + 0.8 * (1.0 - aR)), sin(ang) * r);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vColor = aColor;
  vAlpha = pointFade(-mv.z);
  emitPoint(mv, aSize);
}
`;

const CLOUD_VERT = COMMON_VERT + /* glsl */ `
attribute vec3 aPos; attribute vec3 aSeed; attribute vec3 aColor; attribute float aSize;
uniform float uDrift; uniform float uTime;
void main(){
  vec3 p = aPos + uDrift * vec3(
    sin(uTime * 0.25 + aSeed.x * 6.283),
    cos(uTime * 0.20 + aSeed.y * 6.283),
    sin(uTime * 0.23 + aSeed.z * 6.283));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vColor = aColor;
  vAlpha = pointFade(-mv.z);
  emitPoint(mv, aSize);
}
`;

const SPHERE_VERT = COMMON_VERT + /* glsl */ `
attribute vec3 aN; attribute vec3 aSeed; attribute vec3 aColor; attribute float aSize;
uniform float uRadius; uniform float uDisp; uniform vec3 uLight; uniform float uWobble; uniform float uTime;
void main(){
  float t = uTime * uWobble;
  float n = sin(aN.x * 3.1 + t + aSeed.x * 6.283) * 0.5
          + sin(aN.y * 2.7 - t * 0.7 + aSeed.y * 6.283) * 0.35
          + sin(aN.z * 4.3 + t * 0.4) * 0.25;
  vec3 p = aN * (uRadius + uDisp * n);
  vec3 nrm = normalize(mat3(modelMatrix) * aN);
  float lam = max(dot(nrm, normalize(uLight)), 0.0);
  float rim = pow(1.0 - max(dot(nrm, vec3(0.0, 0.0, 1.0)), 0.0), 2.5) * 0.35;
  vColor = aColor * (0.16 + 0.95 * lam) + aColor * rim;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vAlpha = pointFade(-mv.z);
  emitPoint(mv, aSize);
}
`;

const GRAIN = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes;
    varying vec2 vUv;
    float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float v = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - smoothstep(0.42, 0.95, v) * 0.6;
      float g = rand(vUv * uRes + fract(uTime) * 91.7) - 0.5;
      c.rgb += g * 0.035;
      gl_FragColor = c;
    }
  `,
};

/* ---------- renderer, scene, camera ---------- */
let renderer, scene, camera, composer, bloom, grain;
let quality = 1, baseQuality = COARSE ? 0.5 : 1, basePR = 1;
const materials = [];
const groups = {};
const shows = {};

function makeMat(vert, uniforms, extra = {}) {
  const m = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: POINT_FRAG,
    uniforms: { ...uniforms, uOpacity: { value: extra.opacity ?? 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  // shared globals (time, pixel ratio, scale, depth range)
  for (const k of Object.keys(SHARED)) m.uniforms[k] = SHARED[k];
  materials.push(m);
  return m;
}

function pointsFrom(count, attrs, mat, name) {
  const g = new THREE.BufferGeometry();
  for (const [key, arr, size] of attrs) g.setAttribute(key, new THREE.BufferAttribute(arr, size));
  g.setDrawRange(0, count);
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  p.userData = { count, name };
  return p;
}

/* ---------- scene builders ---------- */
function buildStars(r) {
  const n = dn(9000);
  const pos = new Float32Array(n * 3), seed = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (r() - 0.5) * 170;
    pos[i * 3 + 1] = (r() - 0.5) * 110;
    pos[i * 3 + 2] = 60 - r() * 340;
    seed[i * 3] = r(); seed[i * 3 + 1] = r(); seed[i * 3 + 2] = r();
    const warm = r() < 0.18;
    const k = 0.7 + r() * 0.6;
    if (warm) { col.set([1.0 * k, 0.72 * k, 0.45 * k], i * 3); }
    else { col.set([0.7 * k, 0.82 * k, 1.0 * k], i * 3); }
    sz[i] = r() < 0.02 ? 3.2 : 0.5 + r() * 1.3;
  }
  const mat = makeMat(CLOUD_VERT, { uDrift: { value: 0.4 } });
  const pts = pointsFrom(n, [['aPos', pos, 3], ['aSeed', seed, 3], ['aColor', col, 3], ['aSize', sz, 1]], mat, 'stars');
  scene.add(pts);
  shows.stars = { mat, z: -100, fade: null };
  groups.stars = pts;
}

function buildGalaxy(r, { n, rad, thick, spin, tint, pinkness }) {
  const aR = new Float32Array(n), aA = new Float32Array(n), aH = new Float32Array(n), aS = new Float32Array(n), aC = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const rr = Math.pow(r(), 1.7);
    const arm = Math.floor(r() * 2) * Math.PI;
    aR[i] = rr;
    aA[i] = arm + gauss(r) * 0.35 * (0.3 + rr);
    aH[i] = gauss(r) * 0.6;
    const core = rr < 0.18;
    const k = 0.6 + r() * 0.8;
    // strong GPUs: per-star hue jitter so the arms read as a mix of blue, violet and gold
    const j = RICH ? (r() - 0.5) * 0.5 : 0;
    if (core) aC.set([1.0 * k, 0.86 * k, 0.6 * k], i * 3);
    else if (r() < pinkness) aC.set([1.0 * k, 0.5 * k, 0.72 * k], i * 3);
    else aC.set([Math.max(0, tint[0] + j * 0.6) * k, Math.max(0, tint[1] + j * 0.2) * k, Math.max(0, tint[2] - j * 0.4) * k], i * 3);
    aS[i] = r() < 0.04 ? 3.0 : 0.6 + r() * 1.5;
  }
  const mat = makeMat(GALAXY_VERT, { uRad: { value: rad }, uSpin: { value: spin }, uThick: { value: thick } });
  return pointsFrom(n, [['aR', aR, 1], ['aA', aA, 1], ['aH', aH, 1], ['aSize', aS, 1], ['aColor', aC, 3]], mat, 'galaxy');
}

function buildNebula(r) {
  const n = dn(22000);
  const pos = new Float32Array(n * 3), seed = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n);
  const palette = RICH
    ? [[1.0, 0.35, 0.55], [0.35, 0.9, 0.9], [1.0, 0.7, 0.4], [0.5, 0.45, 1.0], [0.45, 1.0, 0.6], [1.0, 0.88, 0.5], [0.85, 0.3, 1.0], [0.3, 0.6, 1.0]]
    : [[1.0, 0.35, 0.55], [0.35, 0.9, 0.9], [1.0, 0.7, 0.4], [0.5, 0.45, 1.0]];
  for (let i = 0; i < n; i++) {
    const cx = gauss(r) * 30, cy = gauss(r) * 14, cz = gauss(r) * 22;
    pos.set([cx, cy, cz], i * 3);
    seed.set([r(), r(), r()], i * 3);
    const pc = palette[Math.floor(r() * palette.length)];
    const k = RICH ? 0.04 + r() * 0.16 : 0.06 + r() * 0.1;
    col.set([pc[0] * k, pc[1] * k, pc[2] * k], i * 3);
    sz[i] = 0.7 + r() * 1.3;
  }
  const mat = makeMat(CLOUD_VERT, { uDrift: { value: 1.2 } }, { opacity: 0.55 });
  return pointsFrom(n, [['aPos', pos, 3], ['aSeed', seed, 3], ['aColor', col, 3], ['aSize', sz, 1]], mat, 'nebula');
}

function buildPlanet(r) {
  const n = dn(26000);
  const nrm = new Float32Array(n * 3), seed = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const x = s * Math.cos(th), y = u, z = s * Math.sin(th);
    nrm.set([x, y, z], i * 3);
    seed.set([r(), r(), r()], i * 3);
    const band = Math.sin(y * 13 + Math.sin(th * 3) * 0.8) * 0.5 + 0.5;
    const a = [1.0, 0.6, 0.36], b = [0.98, 0.86, 0.66], c = [0.6, 0.32, 0.22];
    const m = band < 0.5 ? [a[0] + (c[0] - a[0]) * band * 2, a[1] + (c[1] - a[1]) * band * 2, a[2] + (c[2] - a[2]) * band * 2]
                         : [c[0] + (b[0] - c[0]) * (band - 0.5) * 2, c[1] + (b[1] - c[1]) * (band - 0.5) * 2, c[2] + (b[2] - c[2]) * (band - 0.5) * 2];
    col.set(m, i * 3);
    sz[i] = 0.9 + r() * 1.1;
  }
  const g = new THREE.Group();
  const mat = makeMat(SPHERE_VERT, {
    uRadius: { value: 9 }, uDisp: { value: 0.12 }, uLight: { value: new THREE.Vector3(-0.6, 0.5, 0.6) }, uWobble: { value: 0.15 },
  });
  g.add(pointsFrom(n, [['aN', nrm, 3], ['aSeed', seed, 3], ['aColor', col, 3], ['aSize', sz, 1]], mat, 'planet'));

  // ring
  const rn = 14000;
  const rp = new Float32Array(rn * 3), rs = new Float32Array(rn * 3), rc = new Float32Array(rn * 3), rz = new Float32Array(rn);
  for (let i = 0; i < rn; i++) {
    const rad = 14 + Math.pow(r(), 0.8) * 9, th = r() * Math.PI * 2;
    rp.set([Math.cos(th) * rad, gauss(r) * 0.12, Math.sin(th) * rad], i * 3);
    rs.set([r(), r(), r()], i * 3);
    const k = 0.5 + r() * 0.5;
    rc.set([0.95 * k, 0.85 * k, 0.7 * k], i * 3);
    rz[i] = 0.6 + r() * 1.2;
  }
  const rmat = makeMat(CLOUD_VERT, { uDrift: { value: 0.05 } });
  g.add(pointsFrom(rn, [['aPos', rp, 3], ['aSeed', rs, 3], ['aColor', rc, 3], ['aSize', rz, 1]], rmat, 'ring'));
  g.rotation.set(0.35, 0, 0.25);
  return g;
}

function buildCell(r) {
  const g = new THREE.Group();
  // membrane
  const mn = dn(26000);
  const nrm = new Float32Array(mn * 3), seed = new Float32Array(mn * 3), col = new Float32Array(mn * 3), sz = new Float32Array(mn);
  for (let i = 0; i < mn; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    nrm.set([s * Math.cos(th), u, s * Math.sin(th)], i * 3);
    seed.set([r(), r(), r()], i * 3);
    const k = 0.55 + r() * 0.45;
    col.set([0.35 * k, 0.95 * k, 0.85 * k], i * 3);
    sz[i] = 0.8 + r() * 1.0;
  }
  const mem = makeMat(SPHERE_VERT, {
    uRadius: { value: 10 }, uDisp: { value: 0.45 }, uLight: { value: new THREE.Vector3(-0.6, 0.5, 0.6) }, uWobble: { value: 0.55 },
  });
  g.add(pointsFrom(mn, [['aN', nrm, 3], ['aSeed', seed, 3], ['aColor', col, 3], ['aSize', sz, 1]], mem, 'membrane'));

  // nucleus
  const nn = 9000;
  const nN = new Float32Array(nn * 3), nS = new Float32Array(nn * 3), nC = new Float32Array(nn * 3), nZ = new Float32Array(nn);
  for (let i = 0; i < nn; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    nN.set([s * Math.cos(th), u, s * Math.sin(th)], i * 3);
    nS.set([r(), r(), r()], i * 3);
    const k = 0.6 + r() * 0.5;
    nC.set([1.0 * k, 0.62 * k, 0.32 * k], i * 3);
    nZ[i] = 0.9 + r() * 0.9;
  }
  const nuc = makeMat(SPHERE_VERT, {
    uRadius: { value: 3.4 }, uDisp: { value: 0.3 }, uLight: { value: new THREE.Vector3(-0.6, 0.5, 0.6) }, uWobble: { value: 0.9 },
  });
  g.add(pointsFrom(nn, [['aN', nN, 3], ['aSeed', nS, 3], ['aColor', nC, 3], ['aSize', nZ, 1]], nuc, 'nucleus'));

  // DNA double helix inside the nucleus
  const hn = 2400;
  const hp = new Float32Array(hn * 3), hs = new Float32Array(hn * 3), hc = new Float32Array(hn * 3), hz = new Float32Array(hn);
  for (let i = 0; i < hn; i++) {
    const t = (i / hn) * Math.PI * 14;
    const strand = i % 2;
    const ph = t + strand * Math.PI;
    const y = (i / hn - 0.5) * 7.0;
    hp.set([Math.cos(ph) * 1.25, y, Math.sin(ph) * 1.25], i * 3);
    hs.set([r(), r(), r()], i * 3);
    hc.set(strand ? [0.7, 0.95, 1.0] : [1.0, 0.85, 0.5], i * 3);
    hz[i] = 1.1;
  }
  g.add(pointsFrom(hn, [['aPos', hp, 3], ['aSeed', hs, 3], ['aColor', hc, 3], ['aSize', hz, 1]], makeMat(CLOUD_VERT, { uDrift: { value: 0.03 } }), 'helix'));

  // organelle clusters (mitochondria, vesicles)
  const clusters = 16, per = 240, on = clusters * per;
  const oP = new Float32Array(on * 3), oS = new Float32Array(on * 3), oC = new Float32Array(on * 3), oZ = new Float32Array(on);
  for (let c = 0; c < clusters; c++) {
    let cx, cy, cz;
    do { cx = (r() * 2 - 1) * 6; cy = (r() * 2 - 1) * 6; cz = (r() * 2 - 1) * 6; } while (cx * cx + cy * cy + cz * cz > 36 || cx * cx + cy * cy + cz * cz < 16);
    const magenta = r() < 0.5;
    for (let j = 0; j < per; j++) {
      const i = c * per + j;
      oP.set([cx + gauss(r) * 0.7, cy + gauss(r) * 0.7, cz + gauss(r) * 0.7], i * 3);
      oS.set([r(), r(), r()], i * 3);
      oC.set(magenta ? [1.0 * 0.85, 0.35 * 0.85, 0.85 * 0.85] : [0.55, 1.0, 0.55], i * 3);
      oZ[i] = 1.0 + r() * 0.8;
    }
  }
  g.add(pointsFrom(on, [['aPos', oP, 3], ['aSeed', oS, 3], ['aColor', oC, 3], ['aSize', oZ, 1]], makeMat(CLOUD_VERT, { uDrift: { value: 0.35 } }), 'organelles'));
  return g;
}

/* ---------- boot + preloader ---------- */
async function boot() {
  const canvas = $('#stage');
  basePR = Math.min(window.devicePixelRatio || 1, COARSE ? 1.5 : 2);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x03040a, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setPixelRatio(basePR * (0.6 + 0.4 * quality));
  renderer.setSize(innerWidth, innerHeight, false);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
  camera.position.set(0, 0, 12);

  setScale();
  const r = rng(20260428);
  const setStep = (label, pct) => { $('#pl-note').textContent = label; $('#pl-bar').style.width = pct + '%'; $('#pl-pct').firstChild.textContent = Math.round(pct); };

  const steps = [
    ['Charting two trillion galaxies', () => { groups.galA = buildGalaxy(rng(11), { n: COARSE ? 36000 : 60000, rad: 40, thick: 5, spin: 0.9, tint: [0.55, 0.78, 1.0], pinkness: 0.12 }); }],
    ['Igniting a stellar nursery', () => { groups.nebula = buildNebula(rng(22)); }],
    ['Shaping a young planet', () => { groups.planet = buildPlanet(rng(33)); }],
    ['Growing a human cell', () => { groups.cell = buildCell(rng(44)); }],
    ['Sowing the starfield', () => { buildStars(rng(55)); }],
    ['Compiling shaders', async () => { await renderer.compileAsync(scene, camera); }],
    ['Loading type', async () => { if (document.fonts) await document.fonts.ready; }],
  ];

  // progressive build with real progress
  const total = steps.length;
  for (let i = 0; i < total; i++) {
    const [label] = steps[i];
    setStep(label, (i / total) * 100);
    await nextFrame();
    await steps[i][1]();
  }
  setStep('Ready', 100);

  // lay out groups (only after every group exists)
  const galA = groups.galA; galA.position.set(-22, 6, -70); galA.rotation.set(1.1, 0.2, 0.1); scene.add(galA);
  const galB = buildGalaxy(rng(66), { n: COARSE ? 16000 : 28000, rad: 26, thick: 4, spin: -1.3, tint: [1.0, 0.8, 0.55], pinkness: 0.05 });
  galB.position.set(40, -12, -100); galB.rotation.set(0.5, 0.4, 0.4); scene.add(galB);
  groups.galB = galB;
  groups.nebula.position.set(0, 0, -132); scene.add(groups.nebula);
  groups.planet.position.set(14, -1, -168); scene.add(groups.planet);
  groups.cell.position.set(-2, 0, -216); scene.add(groups.cell);
  makeInspectableObjects();
  ensureCycleCopies(1);

  // scene groups registry for visibility
  groups.galA.userData.z = -70; groups.galB.userData.z = -100;
  groups.nebula.userData.z = -132; groups.planet.userData.z = -168; groups.cell.userData.z = -216;

  // post stack
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.72);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  grain = new ShaderPass(GRAIN);
  grain.renderToScreen = true;
  composer.addPass(grain);

  wire();
  await minimumPreloaderTime();
  const pl = $('#preloader');
  pl.classList.add('done');
  $('#sound').classList.add('sound-ready');
  pl.setAttribute('aria-hidden', 'true');
  // remove from the DOM once its fade has finished (fallback timer covers reduced-motion / missed transitionend)
  const dropPreloader = () => pl.remove();
  pl.addEventListener('transitionend', dropPreloader, { once: true });
  setTimeout(dropPreloader, 1800);
  requestAnimationFrame(loop);
}

const nextFrame = () => new Promise((res) => setTimeout(() => requestAnimationFrame(() => res()), 16));
let startedAt = performance.now();
async function minimumPreloaderTime() {
  const wait = Math.max(0, 1600 - (performance.now() - startedAt));
  await new Promise((r) => setTimeout(r, wait));
}

/* ---------- scroll, input, audio ---------- */
let targetP = 0, camZ = 12, camZTarget = 12;
let mx = 0, my = 0, smx = 0, smy = 0;
let dragYaw = 0, dragPitch = 0, dragYawT = 0, dragPitchT = 0, dragVel = 0;
let dragging = false, lastX = 0, lastY = 0, lastT = 0;
let needsRender = true;
let audio = null, soundOn = false, audioPathPhase = 0, pathTangent = 0;
let cycleIndex = 0, scrollMovingUntil = 0, pathSpan = 1, appendedLoops = 0;
let inspectRaycaster = null, pointerNdc = new THREE.Vector2(), inspectMarkers = [], cycleInspectMarkers = [];
let lastRaycastAt = 0, hoveredIndex = -1, selectedIndex = -1, selectedMarker = null, hintDismissed = false;
const INSPECT_DATA = [
  { name: 'The Glasswing Reach', info: 'Spiral galaxy · 2.4 billion light-years · twin arms braided with blue giants.' },
  { name: 'Vesper Crown', info: 'Spiral galaxy · 6.1 billion light-years · an amber core wrapped in young stars.' },
  { name: 'The Lumen Veil', info: 'Emission nebula · 8,700 light-years · ionised gas drifting through a stellar nursery.' },
  { name: 'Nacre', info: 'Ringed super-Earth · 41 light-years · silicate bands caught in a pale orbital glow.' },
  { name: 'Asterion Cell', info: 'Organic microcosm · 0.0000000003 light-years · membrane, nucleus and active organelles.' },
  { name: 'The Quiet Expanse', info: 'Sparse stellar field · 12,000 light-years · cool blue suns scattered through deep space.' },
  { name: 'The Lantern Drift', info: 'Stellar cluster · 19,400 light-years · warm giants crossing a loose field of companions.' },
];

function setScale() {
  SHARED.uPR.value = renderer ? renderer.getPixelRatio() : basePR;
  SHARED.uScale.value = Math.max(0.6, Math.min(1.25, Math.min(innerWidth, innerHeight * 1.6) / 1000));
}

function readScroll() {
  ensureContentLoops(Math.floor(scrollY / pathSpan) + 2);
  const progress = Math.max(0, scrollY / pathSpan);
  ensureCycleCopies(Math.floor(progress) + 2);
  cycleIndex = Math.floor(progress);
  targetP = progress - cycleIndex;
  camZTarget = 12 - progress * 252;
  $('#progress').style.width = (targetP * 100).toFixed(2) + '%';
  scrollMovingUntil = performance.now() + 180;
  needsRender = true;
}

function wire() {
  pathSpan = Math.max(1, $('#content').getBoundingClientRect().height);
  ensureContentLoops(2);
  addEventListener('scroll', readScroll, { passive: true });
  addEventListener('wheel', () => ensureContentLoops(Math.floor((scrollY + innerHeight * 2) / pathSpan) + 2), { passive: true });
  addEventListener('resize', onResize);
  // parallax: mouse on desktop, a finger hovering/dragging on touch. Off under reduced motion.
  if (!REDUCED) {
    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      mx = (e.clientX / innerWidth) * 2 - 1;
      my = (e.clientY / innerHeight) * 2 - 1;
      needsRender = true;
    }, { passive: true });
    const layer0 = $('#drag-layer');
    layer0.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      mx = (e.clientX / innerWidth) * 2 - 1; my = (e.clientY / innerHeight) * 2 - 1;
    });
  }

  const layer = $('#drag-layer');
  layer.addEventListener('pointermove', inspectPointerMove, { passive: true });
  layer.addEventListener('click', inspectClick);
  layer.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    downX = e.clientX; downY = e.clientY;
    if (e.pointerType === 'touch') {
      pointerNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      inspectRaycaster.setFromCamera(pointerNdc, camera);
      const hit = inspectRaycaster.intersectObjects([...inspectMarkers, ...cycleInspectMarkers])[0];
      if (hit) { dragging = false; inspectClick(e); return; }
    }
    dragging = true; dragVel = 0; lastX = e.clientX; lastY = e.clientY; lastT = performance.now();
    layer.classList.add('dragging');
    try { layer.setPointerCapture(e.pointerId); } catch {}
  });
  layer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    dragYawT += dx * 0.0035;
    dragPitchT = Math.max(-0.7, Math.min(0.7, dragPitchT + dy * 0.0028));
    dragVel = dx * 0.0035;
    if (e.pointerType === 'touch' && !REDUCED) { mx = (e.clientX / innerWidth) * 2 - 1; my = (e.clientY / innerHeight) * 2 - 1; }
    needsRender = true;
  });
  const end = () => { dragging = false; layer.classList.remove('dragging'); };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
  layer.addEventListener('pointerleave', end);

  $('#sound').addEventListener('click', toggleSound);
  $('#inspect-close').addEventListener('click', closeInspect);
  addEventListener('click', (e) => {
    if (selectedIndex >= 0 && !e.target.closest('#inspect-card') && !e.target.closest('#drag-layer')) closeInspect();
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInspect(); });
  const hint = $('#inspect-hint');
  setTimeout(() => { if (!hintDismissed) hint.classList.add('visible'); }, 1900);
  readScroll();
}

function makeInspectableObjects() {
  const coords = [[-22, 6, -70], [40, -12, -100], [0, 0, -132], [14, -1, -168], [-2, 0, -216], [-62, 26, -44], [67, 28, -190]];
  const markerCanvas = document.createElement('canvas'); markerCanvas.width = markerCanvas.height = 128;
  const ctx = markerCanvas.getContext('2d');
  const glow = ctx.createRadialGradient(64,64,1,64,64,62);
  glow.addColorStop(0,'rgba(228,255,250,1)'); glow.addColorStop(.08,'rgba(126,243,214,.95)');
  glow.addColorStop(.22,'rgba(126,243,214,.42)'); glow.addColorStop(.52,'rgba(126,243,214,.08)'); glow.addColorStop(1,'rgba(126,243,214,0)');
  ctx.fillStyle=glow; ctx.fillRect(0,0,128,128);
  const texture = new THREE.CanvasTexture(markerCanvas);
  coords.forEach((position, index) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map:texture, color: index < 2 ? 0xc8e8ff : 0x7ef3d6, transparent:true, opacity:.78, depthWrite:false, blending:THREE.AdditiveBlending }));
    sprite.position.set(...position); sprite.userData.baseY=position[1]; sprite.scale.set(8.5,8.5,1); sprite.userData.inspectIndex=index; sprite.userData.baseScale=8.5;
    scene.add(sprite); inspectMarkers.push(sprite);
  });
  inspectRaycaster = new THREE.Raycaster(); inspectRaycaster.params.Sprite = { threshold: 2 };
}
let cycleCopies = [];
const sourceNames = ['stars', 'galA', 'galB', 'nebula', 'planet', 'cell'];
function ensureCycleCopies(through) {
  while (cycleCopies.length < through) {
    const index = cycleCopies.length + 1, copies=[];
    for (const name of sourceNames) {
      const source=groups[name], clone=source.clone(true);
      clone.position.copy(source.position); clone.position.z -= index * 252;
      clone.userData.z=(source.userData.z ?? source.position.z)-index*252;
      clone.traverse(child=>{ if(child.isPoints) child.material=child.material.clone(); });
      scene.add(clone); copies.push(clone);
    }
    const markers=inspectMarkers.map(source=>{
      const clone=source.clone(); clone.position.copy(source.position); clone.position.z-=index*252;
      clone.material=source.material.clone(); clone.userData={...source.userData,cycle:index}; scene.add(clone); return clone;
    });
    cycleInspectMarkers.push(...markers); cycleCopies.push(copies);
  }
}
function ensureContentLoops(through) {
  const content=$('#content');
  while(appendedLoops<through) {
    const originals=[...content.children].filter(el=>!el.dataset.loopClone);
    const fragment=document.createDocumentFragment();
    originals.forEach(el=>{
      const copy=el.cloneNode(true); copy.dataset.loopClone='true';
      copy.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id')); if(copy.id) copy.removeAttribute('id');
      copy.querySelectorAll('[aria-labelledby],[aria-describedby]').forEach(node=>{node.removeAttribute('aria-labelledby');node.removeAttribute('aria-describedby');});
      fragment.appendChild(copy);
    });
    const added=[...fragment.querySelectorAll('.reveal')]; REVEALS.push(...added);
    content.appendChild(fragment); appendedLoops++;
  }
}
function inspectPointerMove(e) {
  if (e.pointerType === 'touch' || performance.now() - lastRaycastAt < 90 || performance.now() < scrollMovingUntil || dragging) return;
  lastRaycastAt = performance.now();
  pointerNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  inspectRaycaster.setFromCamera(pointerNdc, camera);
  const hits = inspectRaycaster.intersectObjects([...inspectMarkers, ...cycleInspectMarkers]);
  hoveredIndex = hits.length ? hits[0].object.userData.inspectIndex : -1;
  $('#drag-layer').classList.toggle('inspect-hover', hoveredIndex >= 0);
}
let downX = 0, downY = 0;
function inspectClick(e) {
  if (performance.now() < scrollMovingUntil || Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 8) return;
  e.stopPropagation();
  pointerNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  inspectRaycaster.setFromCamera(pointerNdc, camera);
  const hit = inspectRaycaster.intersectObjects([...inspectMarkers, ...cycleInspectMarkers])[0];
  if (!hit) { closeInspect(); return; }
  selectedIndex = hit.object.userData.inspectIndex;
  selectedMarker = hit.object;
  selectedMarker.userData.selectedCameraZ = camZ;
  hintDismissed = true; $('#inspect-hint').classList.remove('visible'); $('#inspect-hint').classList.add('dismissed');
  const item = INSPECT_DATA[selectedIndex];
  $('#inspect-title').textContent = item.name;
  $('#inspect-copy').textContent = item.info;
  const card = $('#inspect-card'); card.classList.add('open'); card.setAttribute('aria-hidden', 'false');
  inspectMarkers.concat(cycleInspectMarkers).forEach(marker => { marker.material.opacity = marker.userData.inspectIndex === selectedIndex ? 1 : .72; });
  needsRender = true;
}
function closeInspect() {
  selectedIndex = -1;
  selectedMarker = null;
  const card = $('#inspect-card');
  if (card) { card.classList.remove('open'); card.setAttribute('aria-hidden', 'true'); }
  inspectMarkers.concat(cycleInspectMarkers).forEach(marker => { marker.material.opacity = .78; });
  needsRender = true;
}

function onResize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  grain.uniforms.uRes.value.set(w, h);
  setScale();
  needsRender = true;
}

function audioInit() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);

  // Warm, barely-there harmonic bed. The moving arpeggio carries the sound, not a loud drone.
  const lowpass = ctx.createBiquadFilter(); lowpass.type = 'lowpass'; lowpass.frequency.value = 300; lowpass.Q.value = 0.7; lowpass.connect(master);
  const drone = ctx.createGain(); drone.gain.value = 0.13; drone.connect(lowpass);
  const oscs = [[55, 'sine', 0.18], [82.41, 'triangle', 0.055]].map(([frequency, type, level], i) => {
    const osc = ctx.createOscillator(); osc.type = type; osc.frequency.value = frequency;
    if (i === 1) osc.detune.value = -4;
    const gain = ctx.createGain(); gain.gain.value = level;
    osc.connect(gain).connect(drone); osc.start();
    return osc;
  });

  // A soft D-major pentatonic figure, voiced as short overlapping notes through a warm filter.
  const padFilter = ctx.createBiquadFilter(); padFilter.type = 'lowpass'; padFilter.frequency.value = 1250; padFilter.Q.value = 0.45;
  const padGain = ctx.createGain(); padGain.gain.value = 0.82; padFilter.connect(padGain).connect(master);
  const notes = [293.66, 369.99, 440, 554.37, 659.25, 554.37, 440, 369.99];
  const voices = Array.from({ length: 4 }, (_, i) => {
    const osc = ctx.createOscillator(); osc.type = i % 2 ? 'sine' : 'triangle';
    osc.frequency.value = notes[i]; osc.detune.value = (i - 1.5) * 2;
    const gain = ctx.createGain(); gain.gain.value = 0;
    osc.connect(gain).connect(padFilter); osc.start();
    return { osc, gain };
  });

  const shimmerFilter = ctx.createBiquadFilter(); shimmerFilter.type = 'bandpass'; shimmerFilter.frequency.value = 1700; shimmerFilter.Q.value = 0.7;
  const shimmerGain = ctx.createGain(); shimmerGain.gain.value = 0.006;
  const shimmerPan = ctx.createStereoPanner(); shimmerPan.pan.value = 0;
  shimmerFilter.connect(shimmerGain).connect(shimmerPan).connect(master);
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const samples = buffer.getChannelData(0); let last = 0;
  for (let i = 0; i < samples.length; i++) {
    last = (last + 0.035 * (Math.random() * 2 - 1)) / 1.035;
    samples[i] = last * 4.2;
  }
  const noise = ctx.createBufferSource(); noise.buffer = buffer; noise.loop = true;
  noise.connect(shimmerFilter); noise.start();
  return { ctx, master, lowpass, padFilter, padGain, shimmerFilter, shimmerGain, shimmerPan, oscs, drone, noise, voices, notes, nextStep: ctx.currentTime + 0.15, stepIndex: 0 };
}

function scheduleArpeggio(sound, now, journey) {
  const beat = 0.38;
  while (sound.nextStep < now + 0.08) {
    const at = sound.nextStep;
    const index = sound.stepIndex++;
    const noteIndex = (index + Math.floor(journey * 4)) % sound.notes.length;
    const voice = sound.voices[index % sound.voices.length];
    const sparkle = index % 4 === 2 && Math.random() < 0.72;
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(0.0001, at);
    voice.osc.frequency.setTargetAtTime(sound.notes[noteIndex] * (sparkle ? 2 : 1), at, 0.025);
    const level = (0.036 + Math.random() * 0.012) * (0.78 + journey * 0.22);
    voice.gain.gain.linearRampToValueAtTime(level, at + 0.035);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, at + beat * 0.88);
    sound.nextStep += beat * (index % 8 === 7 ? 1.35 : 1);
  }
}
function toggleSound() {
  const btn = $('#sound');
  if (!btn.classList.contains('sound-ready')) return;
  soundOn = !soundOn;
  if (soundOn) {
    if (!audio) audio = audioInit();
    if (!audio) { soundOn = false; return; }
    audio.ctx.resume();
    const now = audio.ctx.currentTime;
    audio.master.gain.cancelScheduledValues(now);
    audio.master.gain.setTargetAtTime(0.34, now, 1.6);
  } else if (audio) {
    audio.master.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.35);
  }
  btn.textContent = soundOn ? 'Sound on' : 'Sound off';
  btn.setAttribute('aria-pressed', String(soundOn));
}

/* ---------- visibility helper ---------- */
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// d = how far the camera is past the object's plane (negative = still ahead of it).
// A chapter is fully visible while the camera is roughly between its plane and ~120 units before it.
function fadeFor(zc) {
  const d = camZ - zc;
  return sstep(-60, -20, d) * (1 - sstep(120, 220, d));
}

/* ---------- adaptive quality ---------- */
let frames = 0, fpsWindowStart = performance.now(), fps = 60;
function adapt(now) {
  if (now - fpsWindowStart < 1000) return;
  fps = frames * 1000 / (now - fpsWindowStart);
  frames = 0; fpsWindowStart = now;
  let q = quality;
  if (fps < 50 && q > 0.3) q = Math.max(0.3, q - 0.1);
  else if (fps > 58 && q < baseQuality) q = Math.min(baseQuality, q + 0.05);
  if (Math.abs(q - quality) > 0.001) {
    quality = q;
    applyQuality();
  }
}
function applyQuality() {
  for (const g of Object.values(groups)) {
    const n = g.userData.count ?? g.children?.[0]?.userData?.count;
    if (g.isPoints) g.geometry.setDrawRange(0, Math.max(1, Math.floor(g.userData.count * quality)));
    else g.traverse((c) => { if (c.isPoints) c.geometry.setDrawRange(0, Math.max(1, Math.floor(c.userData.count * quality))); });
  }
  const pr = basePR * (0.6 + 0.4 * quality);
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  setScale();
}

/* ---------- main loop ---------- */
let lastNow = performance.now(), clock = 0;
const reducedNeedsRender = () => REDUCED && !needsRender;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - lastNow) / 1000);
  lastNow = now;
  frames++;
  adapt(now);

  if (document.hidden) return;
  // easing toward scroll target (instant under reduced motion)
  const k = REDUCED ? 1 : 1 - Math.exp(-dt * 5.5);
  const prev = camZ;
  camZ += (camZTarget - camZ) * k;

  if (!REDUCED) clock += dt;
  smx += (mx - smx) * (REDUCED ? 1 : 1 - Math.exp(-dt * 3));
  smy += (my - smy) * (REDUCED ? 1 : 1 - Math.exp(-dt * 3));
  dragYaw += (dragYawT - dragYaw) * (REDUCED ? 1 : 1 - Math.exp(-dt * 4));
  dragPitch += (dragPitchT - dragPitch) * (REDUCED ? 1 : 1 - Math.exp(-dt * 4));

  if (selectedIndex >= 0 && selectedMarker && Math.abs(camZ - selectedMarker.userData.selectedCameraZ) > 28) closeInspect();
  if (REDUCED && !needsRender && Math.abs(camZ - prev) < 1e-4) return;
  needsRender = false;

  const t = clock;
  SHARED.uTime.value = t;
  inspectMarkers.forEach(marker => {
    const pulse = 1 + .11 * Math.sin(t * 2.1 + marker.userData.inspectIndex * .9);
    const bob = Math.sin(t * 1.3 + marker.userData.inspectIndex * 1.2) * 1.15;
    marker.scale.setScalar(marker.userData.baseScale * pulse); marker.position.y = marker.userData.baseY + bob;
  });
  cycleInspectMarkers.forEach(marker => {
    const pulse=1+.11*Math.sin(t*2.1+marker.userData.inspectIndex*.9);
    marker.scale.setScalar(marker.userData.baseScale*pulse); marker.position.y=marker.userData.baseY+Math.sin(t*1.3+marker.userData.inspectIndex*1.2)*1.15;
  });

  // camera: scroll-driven dolly with parallax, drag orbit and a whisper of roll
  const px = smx * 2.6 + Math.sin(t * 0.13) * 0.4 * (REDUCED ? 0 : 1);
  const py = -smy * 1.8 + Math.cos(t * 0.11) * 0.3 * (REDUCED ? 0 : 1);
  // The camera path is periodic at the exact scroll-cycle length. Its first
  // derivative is also zero at the seam, so position, heading and speed agree.
  const pathU = (12 - camZ) / 252, pathPhase = pathU * Math.PI * 2;
  camera.position.set(px + .18 * Math.sin(pathPhase), py + .1 * (1 - Math.cos(pathPhase)), camZ);
  const lookX = dragYaw * 36 - smx * 1.5 + .06 * Math.sin(pathPhase);
  const lookY = dragPitch * 22 - smy * 1.0;
  camera.lookAt(lookX, lookY, camZ - 40);
  camera.rotateZ(Math.sin(pathPhase) * 0.025);

  // Every scroll-dependent field uses the unwrapped path coordinate. At each seam
  // camera pose, chapter opacity, bloom and fog meet the next chapter's start value.
  const g = groups;
  const sceneCopies = [g.stars,g.galA,g.galB,g.nebula,g.planet,g.cell].map(group => [group]);
  cycleCopies.forEach((copies,index) => copies.forEach((group,i) => sceneCopies[i].push(group)));
  sceneCopies.forEach((copies,i) => {
    const baseZ=[0,-70,-100,-132,-168,-216][i];
    copies.forEach((group,index) => {
      if (!group) return;
      if (index>0) group.traverse(child => { if(child.isPoints) for(const key of Object.keys(SHARED)) child.material.uniforms[key]=SHARED[key]; });
      if (i===0) {
        group.visible=true;
        if (group.material?.uniforms?.uDrift) group.material.uniforms.uDrift.value=.4 + .05*Math.sin(pathPhase);
      } else setGroupOpacity(group, fadeFor(baseZ-index*252));
    });
  });
  bloom.strength = .515 + .035 * Math.cos(pathPhase);
  renderer.setClearColor(new THREE.Color(0x03040a).lerp(new THREE.Color(0x040712), .5 - .5 * Math.cos(pathPhase)), 1);
  audioPathPhase = pathPhase;
  if (g.galA && !REDUCED) g.galA.rotation.y += dt * 0.02;

  if (audio && soundOn) {
    const c = audio.ctx.currentTime;
    const journey = 0.5 - 0.5 * Math.cos(audioPathPhase);
    const drift = Math.sin(t * 0.17) + (Math.random() - 0.5) * 0.025;
    audio.lowpass.frequency.setTargetAtTime(300 + journey * 180 + drift * 24, c, 1.6);
    audio.padFilter.frequency.setTargetAtTime(1050 + journey * 850 + Math.sin(t * 0.21) * 150, c, 1.4);
    audio.padGain.gain.setTargetAtTime(0.64 + journey * 0.24, c, 2.2);
    audio.shimmerFilter.frequency.setTargetAtTime(1450 + journey * 650 + Math.sin(t * 0.11) * 170, c, 1.8);
    audio.shimmerGain.gain.setTargetAtTime(0.0035 + journey * 0.0025, c, 2.5);
    audio.shimmerPan.pan.setTargetAtTime(Math.sin(t * 0.08) * 0.32, c, 2.4);
    scheduleArpeggio(audio, c, journey);
  }
  updateReveals();
  grain.uniforms.uTime.value = t;
  window.__deepField = { fps: Math.round(fps), quality: +quality.toFixed(2), frames: window.__deepField?.frames, camZ: +camZ.toFixed(1) };
  composer.render(dt);
}

function setGroupOpacity(group, v) {
  group.traverse((c) => { if (c.isPoints && c.material) c.material.uniforms.uOpacity.value = v; });
  group.visible = v > 0.002;
}

/* ---------- startup (kept last so every binding is initialised) ---------- */
setupReveal();
if (!GPU.ok) {
  document.documentElement.classList.add("no-gl");
  $("#preloader")?.remove();
} else {
  boot().catch((err) => {
    console.error(err);
    document.documentElement.classList.add("no-gl");
    $("#preloader")?.remove();
  });
}
