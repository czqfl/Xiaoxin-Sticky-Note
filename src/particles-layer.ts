// 全屏透明「粒子层」窗口：负责所有粒子动画的粒子渲染（particle 粒子消散 / cylinder 旋柱 /
// vortex 涡旋）。粒子坐标使用**屏幕坐标**（原点=屏幕左上角），因此粒子可以飘出便签窗口、
// 在整个屏幕上自由活动，不会被便签窗口的四周边框框住。
// ----------------------------------------------------------------------------
// 便签窗口负责 mask（便签本体擦除）+ 计时；本窗口只画粒子。参数经「particles-start」
// 事件传入（type + 便签屏幕位置/尺寸 + 颜色场 + 粒子强度 + 动画速度）。
// 动画播完自隐藏；「particles-cancel」立即停止并隐藏。

import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

type LayerKind = "particle" | "cylinder" | "vortex";

interface ParticleLayerStart {
  type: LayerKind;
  /** 便签窗口左上角屏幕坐标（CSS px） */
  originX: number;
  originY: number;
  /** 便签窗口宽高（CSS px） */
  width: number;
  height: number;
  /** 便签“区域颜色场”（RGBA，fw×fh，覆盖便签矩形） */
  fieldW: number;
  fieldH: number;
  fieldData: number[];
  /** 粒子消散模式：消散时间场（单位 ms） */
  tW: number;
  tH: number;
  tField: number[];
  /** 粒子强度 0~100 */
  density: number;
  /** 动画速度百分比（100=原速） */
  speed: number;
}

let canvas: HTMLCanvasElement | null = null;
let gl: WebGLRenderingContext | null = null;
let rafId = 0;
let backupId = 0;
let layerActive = false;
let layerEnded = false;
let dpr = 1;
let duration = 2400;
let k = 1;
let start = 0;
let started = false;
let lastPaint = 0;
let layerKind: LayerKind = "particle";

// ---- 粒子池（SoA；particle 模式动态增减，cylinder/vortex 固定池重生）----
let maxP = 1024;
let px = new Float32Array(maxP);
let py = new Float32Array(maxP);
let pth = new Float32Array(maxP);    // 初始角 / 圆周角
let prad = new Float32Array(maxP);   // cylinder: 截面半径；vortex: 半径比例
let pbirth = new Float32Array(maxP); // 出生时刻（动画 age，ms）
let pang = new Float32Array(maxP);
let pv0 = new Float32Array(maxP);
let pv1 = new Float32Array(maxP);
let plife = new Float32Array(maxP);
let page = new Float32Array(maxP);
let psize = new Float32Array(maxP);
let pseed = new Float32Array(maxP);
let psway = new Float32Array(maxP);
let pr = new Float32Array(maxP);
let pg = new Float32Array(maxP);
let pb = new Float32Array(maxP);
let glData = new Float32Array(maxP * 7);
let pcount = 0;

// ---- particle 模式：发射点（便签矩形内网格）----
let emitX: Float32Array = new Float32Array(0);
let emitY: Float32Array = new Float32Array(0);
let emitT: Float32Array = new Float32Array(0);
let emitDone: Uint8Array = new Uint8Array(0);
let ecount = 0;
let binSize = 20;
let binPts: number[][] = [];
let maxEmitT = 0;

// ---- 当前动画参数 ----
let originX = 0;
let originY = 0;
let rectW = 1;
let rectH = 1;
let fieldW = 8;
let fieldH = 8;
let fieldData: number[] = new Array(64).fill(255);
let tW = 8;
let tH = 8;
let tField: number[] = new Array(64).fill(0);
let layerDensity = 50;
// cylinder / vortex 几何
let cx = 0;
let cy = 0;
let maxR = 500;
let R = 200;
let focal = 520;
let omega = 6;

const ensurePool = (n: number): void => {
  if (n <= maxP) return;
  maxP = n;
  px = new Float32Array(maxP); py = new Float32Array(maxP); pth = new Float32Array(maxP);
  prad = new Float32Array(maxP); pbirth = new Float32Array(maxP); pang = new Float32Array(maxP);
  pv0 = new Float32Array(maxP); pv1 = new Float32Array(maxP); plife = new Float32Array(maxP);
  page = new Float32Array(maxP); psize = new Float32Array(maxP); pseed = new Float32Array(maxP);
  psway = new Float32Array(maxP); pr = new Float32Array(maxP); pg = new Float32Array(maxP);
  pb = new Float32Array(maxP); glData = new Float32Array(maxP * 7);
};

const sampleColor = (lx: number, ly: number): [number, number, number] => {
  let fx = Math.round((lx / rectW) * fieldW);
  if (fx < 0) fx = 0;
  else if (fx >= fieldW) fx = fieldW - 1;
  let fy = Math.round((ly / rectH) * fieldH);
  if (fy < 0) fy = 0;
  else if (fy >= fieldH) fy = fieldH - 1;
  const idx = (fy * fieldW + fx) * 4;
  const r = fieldData[idx], g = fieldData[idx + 1], b = fieldData[idx + 2];
  const max = Math.max(r, g, b);
  if (max >= 158) return [r, g, b];
  const f = 158 / Math.max(1, max);
  return [Math.min(255, r * f), Math.min(255, g * f), Math.min(255, b * f)];
};

const sampleT = (lx: number, ly: number): number => {
  let fx = Math.round((lx / rectW) * tW);
  if (fx < 0) fx = 0;
  else if (fx >= tW) fx = tW - 1;
  let fy = Math.round((ly / rectH) * tH);
  if (fy < 0) fy = 0;
  else if (fy >= tH) fy = tH - 1;
  return tField[fy * tW + fx];
};

// ---- particle：从便签矩形内按 T 场时刻生成，向四周/上方飘散越过边界 ----
const spawn = (sx: number, sy: number, age: number): void => {
  if (pcount >= maxP) return;
  let life = (1800 + Math.random() * 1600) * k;
  const fit = duration - age - 40;
  if (fit < 120) return;
  if (life > fit) life = fit;
  const i = pcount++;
  px[i] = sx;
  py[i] = sy;
  pang[i] = (Math.random() - 0.5) * ((110 * Math.PI) / 180);
  pv0[i] = 20 + Math.random() * 40;
  pv1[i] = 650;
  plife[i] = life;
  page[i] = 0;
  psize[i] = 1.8;
  pseed[i] = Math.random() * Math.PI * 2;
  psway[i] = (Math.random() - 0.5) * 60;
  const [r, g, b] = sampleColor(sx - originX, sy - originY);
  pr[i] = r / 255; pg[i] = g / 255; pb[i] = b / 255;
};

// ---- cylinder：固定半径旋转圆柱壳（粒子铺满截面圆盘，绕竖轴透视旋转）----
const respawnCylinder = (i: number, atAge: number): void => {
  pbirth[i] = atAge;
  pth[i] = Math.random() * Math.PI * 2;
  py[i] = originY + Math.random() * rectH;
  plife[i] = Math.round((1200 + Math.random() * 900) * k);
  psize[i] = 1.8;
  prad[i] = R * Math.sqrt(Math.random()); // 截面圆盘面积均匀 → 实心圆柱
  const [r, g, b] = sampleColor(Math.random() * rectW, py[i] - originY);
  pr[i] = r / 255; pg[i] = g / 255; pb[i] = b / 255;
};

// ---- vortex：中心点圆形扩张 + 圆盘内粒子绕心旋转吸入 ----
const respawnVortex = (i: number, atAge: number): void => {
  pbirth[i] = atAge;
  pth[i] = Math.random() * Math.PI * 2;
  plife[i] = Math.round((900 + Math.random() * 600) * k);
  psize[i] = 2.0;
  prad[i] = Math.sqrt(Math.random()); // 铺满整个圆盘（中心也有粒子）
  const [r, g, b] = sampleColor(Math.random() * rectW, Math.random() * rectH);
  pr[i] = r / 255; pg[i] = g / 255; pb[i] = b / 255;
};

function stopLayer(): void {
  layerEnded = true;
  cancelAnimationFrame(rafId);
  if (backupId) {
    window.clearInterval(backupId);
    backupId = 0;
  }
  if (gl) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  pcount = 0;
  layerActive = false;
  getCurrentWindow().hide().catch(() => {});
}

// ---- 各模式的初始化 ----
function buildEmitGrid(p: ParticleLayerStart): void {
  rectW = Math.max(1, p.width);
  rectH = Math.max(1, p.height);
  originX = p.originX;
  originY = p.originY;
  fieldW = p.fieldW || 8;
  fieldH = p.fieldH || 8;
  fieldData = p.fieldData || [];
  tW = p.tW || 8;
  tH = p.tH || 8;
  tField = p.tField || [];
  const spacing = 3;
  const ecx = Math.max(2, Math.ceil(rectW / spacing));
  const ecy = Math.max(2, Math.ceil(rectH / spacing));
  ecount = ecx * ecy;
  emitX = new Float32Array(ecount);
  emitY = new Float32Array(ecount);
  emitT = new Float32Array(ecount);
  emitDone = new Uint8Array(ecount);
  let ei = 0;
  maxEmitT = 0;
  for (let iy = 0; iy < ecy; iy++) {
    for (let ix = 0; ix < ecx; ix++) {
      const lx = (ix + 0.5) * spacing;
      const ly = (iy + 0.5) * spacing;
      emitX[ei] = originX + lx;
      emitY[ei] = originY + ly;
      let T = sampleT(lx, ly);
      if (!isFinite(T) || T < 0) T = 0;
      emitT[ei] = T;
      if (T > maxEmitT) maxEmitT = T;
      ei++;
    }
  }
  binSize = 20;
  const binCount = Math.ceil(maxEmitT / binSize) + 2;
  binPts = [];
  for (let b = 0; b < binCount; b++) binPts.push([]);
  for (let i = 0; i < ecount; i++) {
    let b = Math.floor(emitT[i] / binSize);
    if (b < 0) b = 0;
    else if (b >= binCount) b = binCount - 1;
    binPts[b].push(i);
  }
  const peakAlive = Math.round(ecount * (0.03 + 0.97 * layerDensity / 100));
  ensurePool(peakAlive + 1500);
  pcount = 0;
}

function initCylinder(p: ParticleLayerStart): void {
  rectW = Math.max(1, p.width);
  rectH = Math.max(1, p.height);
  originX = p.originX;
  originY = p.originY;
  fieldW = p.fieldW || 8;
  fieldH = p.fieldH || 8;
  fieldData = p.fieldData || [];
  cx = originX + rectW / 2;
  R = rectW * 0.46;
  focal = R * 2.6;
  omega = (Math.PI * 2 * 2) / (duration / 1000);
  const N = Math.round(6400 + layerDensity * 32000);
  ensurePool(N + 64);
  for (let i = 0; i < N; i++) {
    respawnCylinder(i, Math.random() * 260);
  }
  pcount = N;
}

function initVortex(p: ParticleLayerStart): void {
  rectW = Math.max(1, p.width);
  rectH = Math.max(1, p.height);
  originX = p.originX;
  originY = p.originY;
  fieldW = p.fieldW || 8;
  fieldH = p.fieldH || 8;
  fieldData = p.fieldData || [];
  cx = originX + rectW / 2;
  cy = originY + rectH / 2;
  maxR = Math.hypot(rectW, rectH) / 2;
  omega = (Math.PI * 2 * 2) / (duration / 1000);
  const N = Math.round(4000 + layerDensity * 18000);
  ensurePool(N + 64);
  for (let i = 0; i < N; i++) {
    respawnVortex(i, Math.random() * 240);
  }
  pcount = N;
}

const frame = (now: number): void => {
  if (layerEnded) return;
  if (!started) {
    started = true;
    start = now;
    lastPaint = now;
  }
  const dt = Math.min(0.05, Math.max(0.001, (now - lastPaint) / 1000));
  lastPaint = now;
  const age = now - start;
  const globalFade = age > duration - 200 ? Math.max(0, (duration - age) / 200) : 1;

  if (!gl) return;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  let drawCount = 0;

  if (layerKind === "particle") {
    // 发射：按 T 场分批生成（与便签窗口 mask 消散同步）
    const keepProb = Math.max(0.015, layerDensity / 100);
    const b1 = Math.min(binPts.length - 1, Math.floor(age / binSize));
    for (let b = 0; b <= b1; b++) {
      const pts = binPts[b];
      for (let z = 0; z < pts.length; z++) {
        const idx = pts[z];
        if (emitDone[idx] === 0) {
          emitDone[idx] = 1;
          if (Math.random() < keepProb) spawn(emitX[idx], emitY[idx], age);
        }
      }
    }
    for (let i = 0; i < pcount; i++) {
      const a = page[i] + dt * 1000;
      page[i] = a;
      const life = plife[i];
      const u = a / life;
      if (u >= 1) {
        const last = --pcount;
        if (i !== last) {
          px[i] = px[last]; py[i] = py[last]; pang[i] = pang[last];
          pv0[i] = pv0[last]; pv1[i] = pv1[last]; plife[i] = plife[last];
          page[i] = page[last]; psize[i] = psize[last]; pseed[i] = pseed[last];
          psway[i] = psway[last]; pr[i] = pr[last]; pg[i] = pg[last]; pb[i] = pb[last];
        }
        i--;
        continue;
      }
      const speed = pv0[i] + pv1[i] * (a / 1000);
      const dx = Math.sin(pang[i]);
      const dy = -Math.cos(pang[i]);
      const sway = Math.sin(a * 0.004 + pseed[i]) * 40;
      px[i] += (dx * speed + psway[i] + sway) * dt;
      py[i] += dy * speed * dt;
      const t = 1 - u;
      const alpha = t * Math.pow(t, 0.2) * globalFade;
      if (alpha < 0.02) continue;
      const haloR = psize[i] * 1.25;
      const o = drawCount * 7;
      glData[o] = px[i] * dpr;
      glData[o + 1] = py[i] * dpr;
      glData[o + 2] = haloR * 2 * dpr;
      glData[o + 3] = alpha;
      glData[o + 4] = pr[i];
      glData[o + 5] = pg[i];
      glData[o + 6] = pb[i];
      drawCount++;
    }
  } else if (layerKind === "cylinder") {
    // 粒子半径随时间缓慢扩张（比便签 mask 条带慢，ease-in 先慢后快）：
    // 粒子在旋转的同时轨道半径逐渐变大，最后飘出便签矩形区域
    const growT = age / duration;
    const grow = 1 + 1.2 * growT * growT; // 最终 ~2.2R（R=0.46w → 最大半径≈便签宽，飘出左右）
    for (let i = 0; i < pcount; i++) {
      let a = age - pbirth[i];
      if (a < 0) continue;
      if (a >= plife[i]) {
        respawnCylinder(i, age);
        a = 0;
      }
      const theta = pth[i] + omega * (age / 1000);
      const r = prad[i] * grow;
      const z = r * Math.cos(theta);
      const s = Math.min(focal / (focal - z), 3); // 近大远小（限幅避免飘远后爆放大）
      const sx = cx + r * Math.sin(theta) * s;
      const sy = py[i];
      const fadeIn = Math.min(1, a / 150);
      const u = a / plife[i];
      const lifeFade = u > 0.7 ? Math.max(0, (1 - u) / 0.3) : 1;
      const depthShade = 0.62 + 0.38 * Math.max(0, Math.min(1, (z + r) / (2 * r)));
      const alpha = fadeIn * lifeFade * globalFade * depthShade;
      if (alpha < 0.02) continue;
      const haloR = psize[i] * s * (0.6 + 0.4 * fadeIn);
      const o = drawCount * 7;
      glData[o] = sx * dpr;
      glData[o + 1] = sy * dpr;
      glData[o + 2] = haloR * 2 * dpr;
      glData[o + 3] = alpha;
      glData[o + 4] = pr[i];
      glData[o + 5] = pg[i];
      glData[o + 6] = pb[i];
      drawCount++;
    }
  } else {
    // vortex
    const p = Math.min(1, age / duration);
    // 起始即有一个小圆盘（5% maxR），避免粒子全挤在圆心一个点 additive 叠加成刺眼白斑
    const curR = maxR * (0.05 + 0.95 * p * (2 - p));
    for (let i = 0; i < pcount; i++) {
      let a = age - pbirth[i];
      if (a < 0) continue;
      if (a >= plife[i]) {
        respawnVortex(i, age);
        a = 0;
      }
      const theta = pth[i] + omega * (age / 1000);
      const t = a / plife[i];
      const shrink = t * t;
      const r = curR * prad[i] * (1 - 0.92 * shrink);
      const sx = cx + r * Math.cos(theta);
      const sy = cy + r * Math.sin(theta);
      const fadeIn = Math.min(1, a / 150);
      const lifeFade = t > 0.7 ? Math.max(0, (1 - t) / 0.3) : 1;
      const alpha = fadeIn * lifeFade * globalFade;
      if (alpha < 0.02) continue;
      const col = sampleColor(sx - originX, sy - originY);
      const haloR = psize[i] * (0.6 + 0.4 * fadeIn);
      const o = drawCount * 7;
      glData[o] = sx * dpr;
      glData[o + 1] = sy * dpr;
      glData[o + 2] = haloR * 2 * dpr;
      glData[o + 3] = alpha;
      glData[o + 4] = col[0] / 255;
      glData[o + 5] = col[1] / 255;
      glData[o + 6] = col[2] / 255;
      drawCount++;
    }
  }

  if (drawCount > 0) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, glData.subarray(0, drawCount * 7), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(aParamLoc);
    gl.vertexAttribPointer(aParamLoc, 2, gl.FLOAT, false, 28, 8);
    gl.enableVertexAttribArray(aColorLoc);
    gl.vertexAttribPointer(aColorLoc, 3, gl.FLOAT, false, 28, 16);
    gl.drawArrays(gl.POINTS, 0, drawCount);
  }

  if (age >= duration) {
    stopLayer();
  }
};

const step = (now: number): void => {
  frame(now);
  if (!layerEnded) rafId = requestAnimationFrame(step);
};

function startLayer(p: ParticleLayerStart): void {
  layerKind = p.type || "particle";
  layerDensity = Math.max(0, Math.min(100, p.density ?? 50));
  k = Math.max(0.25, Math.min(4, 100 / Math.max(10, p.speed ?? 100)));
  if (layerKind === "particle") {
    buildEmitGrid(p);
    duration = Math.round(2400 * k);
  } else if (layerKind === "cylinder") {
    duration = Math.round(1000 * k);
    initCylinder(p);
  } else {
    duration = Math.round(1200 * k);
    initVortex(p);
  }
  layerEnded = false;
  layerActive = true;
  started = false;
  getCurrentWindow().show().catch(() => {});
  rafId = requestAnimationFrame(step);
  backupId = window.setInterval(() => {
    if (layerEnded) return;
    const now = performance.now();
    if (now - lastPaint > 60) {
      lastPaint = now;
      frame(now);
    }
  }, 40);
  window.setTimeout(() => {
    if (layerEnded) return;
    stopLayer();
  }, duration + 600);
}

// ---- WebGL 基础设施 ----
let buf: WebGLBuffer | null = null;
let aPosLoc = 0;
let aParamLoc = 0;
let aColorLoc = 0;

function setupGL(): boolean {
  if (!canvas) return false;
  const glOpts: WebGLContextAttributes = { alpha: true, premultipliedAlpha: false, antialias: false, depth: false };
  const ctx = (canvas.getContext("webgl", glOpts) ||
    (canvas.getContext("experimental-webgl" as "webgl", glOpts) as unknown as WebGLRenderingContext | null)) as WebGLRenderingContext | null;
  if (!ctx) return false;
  gl = ctx;
  const VS_SRC = `
    attribute vec2 a_pos;
    attribute vec2 a_param;
    attribute vec3 a_color;
    uniform vec2 u_res;
    varying float v_alpha;
    varying vec3 v_color;
    void main() {
      vec2 clip = (a_pos / u_res) * 2.0 - 1.0;
      clip.y = -clip.y;
      gl_Position = vec4(clip, 0.0, 1.0);
      gl_PointSize = a_param.x;
      v_alpha = a_param.y;
      v_color = a_color;
    }`;
  const FS_SRC = `
    precision mediump float;
    varying float v_alpha;
    varying vec3 v_color;
    void main() {
      vec2 d = gl_PointCoord - vec2(0.5);
      float r2 = dot(d, d);
      if (r2 > 0.25) discard;
      float r = sqrt(r2);
      float a = clamp((0.3 - r) / 0.06, 0.0, 1.0);
      gl_FragColor = vec4(v_color * 1.5, v_alpha * a);
    }`;
  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl!.createShader(type);
    if (!sh) return null;
    gl!.shaderSource(sh, src);
    gl!.compileShader(sh);
    return gl!.getShaderParameter(sh, gl!.COMPILE_STATUS) ? sh : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VS_SRC);
  const fs = compile(gl.FRAGMENT_SHADER, FS_SRC);
  if (!vs || !fs) return false;
  const prog = gl.createProgram();
  if (!prog) return false;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
  gl.useProgram(prog);
  aPosLoc = gl.getAttribLocation(prog, "a_pos");
  aParamLoc = gl.getAttribLocation(prog, "a_param");
  aColorLoc = gl.getAttribLocation(prog, "a_color");
  gl.uniform2f(gl.getUniformLocation(prog, "u_res"), canvas.width, canvas.height);
  buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  return true;
}

export async function mountParticlesLayer(): Promise<void> {
  const win = getCurrentWindow();
  const ww = window.screen.width || window.innerWidth;
  const hh = window.screen.height || window.innerHeight;
  await win.setPosition(new LogicalPosition(0, 0)).catch(() => {});
  await win.setSize(new LogicalSize(ww, hh)).catch(() => {});
  win.setIgnoreCursorEvents(true).catch(() => {});
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  document.body.style.background = "transparent";
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(ww * dpr));
  canvas.height = Math.max(1, Math.round(hh * dpr));
  canvas.style.position = "fixed";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.zIndex = "2147483647";
  canvas.style.pointerEvents = "none";
  document.body.appendChild(canvas);
  if (!setupGL()) {
    console.error("粒子层 WebGL 初始化失败");
    return;
  }
  await listen<ParticleLayerStart>("particles-start", (e) => {
    startLayer(e.payload);
  });
  await listen("particles-cancel", () => {
    if (layerActive || !layerEnded) stopLayer();
  });
}
