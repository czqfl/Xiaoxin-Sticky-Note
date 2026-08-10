// 全屏透明「粒子层」窗口：负责「粒子消散」动画的粒子渲染。
// 粒子坐标使用**屏幕物理像素**（原点=屏幕左上角），因此粒子可以飘出便签窗口、
// 在整个屏幕上自由活动，不会被便签窗口的四周边框框住。
// ----------------------------------------------------------------------------
// 便签窗口负责 mask（便签本体擦除）+ 计时；本窗口只画粒子。参数经「particles-start」
// 事件传入（type + 便签屏幕位置/尺寸 + 颜色场 + 粒子强度 + 动画速度）。
//
// **多动画实例**：粒子层是全局单例窗口，但可同时服务多个便签的消散动画
// （快捷键"全部关闭"会同时触发所有便签关闭）——每个便签一个 PAnim 实例，
// 各自的发射网格/时间场/粒子池独立，帧循环统一驱动、合并绘制到同一画布。
// 「particles-cancel」按 (seq + origin) 精确匹配移除对应实例，过期事件忽略。
// 全部实例播完自隐藏；窗口隐藏时无循环。

import { getCurrentWindow, LogicalPosition, PhysicalSize, currentMonitor } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

type LayerKind = "particle";

interface ParticleLayerStart {
  type: LayerKind;
  /** 动画序号（便签侧递增）：cancel 按 (seq+origin) 精确匹配，过期事件忽略 */
  seq?: number;
  /** 便签窗口左上角屏幕坐标（**物理 px**）——粒子发射网格由此平移 */
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
  /** 便签动画开始时刻（Date.now() 系统时钟）：粒子层用同一基准计算 age，保证与便签 mask 同步 */
  startAt?: number;
  /** 便签窗口 devicePixelRatio（物理 px ↔ CSS px 换算：网格×resp、取色/速度用） */
  dprNote?: number;
}

/** 单个便签的消散动画实例（粒子池独立，坐标/时间场/取色各自独立） */
interface PAnim {
  seq: number;
  originX: number;
  originY: number;
  rectW: number;
  rectH: number;
  fieldW: number;
  fieldH: number;
  fieldData: number[];
  tW: number;
  tH: number;
  tField: number[];
  noteDpr: number;
  emitX: Float32Array;
  emitY: Float32Array;
  emitT: Float32Array;
  emitDone: Uint8Array;
  binPts: number[][];
  ecount: number;
  layerStartAt: number;
  duration: number;
  k: number;
  /** 保留概率（0~1），由 density 换算 */
  keepProb: number;
  done: boolean;
  // ---- 粒子池（SoA；本实例独立）----
  maxP: number;
  px: Float32Array;
  py: Float32Array;
  pang: Float32Array;
  pv0: Float32Array;
  pv1: Float32Array;
  plife: Float32Array;
  page: Float32Array;
  psize: Float32Array;
  pseed: Float32Array;
  psway: Float32Array;
  pr: Float32Array;
  pg: Float32Array;
  pb: Float32Array;
  pcount: number;
}

let canvas: HTMLCanvasElement | null = null;
let gl: WebGLRenderingContext | null = null;
let rafId = 0;
let backupId = 0;
let layerEnded = true; // 初始无动画（循环不跑）
let dpr = 1;
let started = false;
let lastPaint = 0;

/** 所有进行中的动画实例（每便签一个） */
let anims: PAnim[] = [];

/** 全局 glData（合并所有实例的粒子绘制，按需扩容） */
let glData = new Float32Array(65536 * 7);

const ensureGlData = (n: number): void => {
  if (n * 7 <= glData.length) return;
  const g = new Float32Array(Math.max(glData.length * 2, n * 7));
  g.set(glData);
  glData = g;
};

/** 颜色采样：输入为物理 px（相对本实例便签左上角），/noteDpr 转 CSS px 后对颜色场采样 */
const sampleColor = (inst: PAnim, lxPhys: number, lyPhys: number): [number, number, number] => {
  if (!inst.fieldData || inst.fieldData.length < 4) return [235, 240, 255];
  const lx = lxPhys / inst.noteDpr;
  const ly = lyPhys / inst.noteDpr;
  let fx = Math.round((lx / inst.rectW) * inst.fieldW);
  if (fx < 0) fx = 0;
  else if (fx >= inst.fieldW) fx = inst.fieldW - 1;
  let fy = Math.round((ly / inst.rectH) * inst.fieldH);
  if (fy < 0) fy = 0;
  else if (fy >= inst.fieldH) fy = inst.fieldH - 1;
  const idx = (fy * inst.fieldW + fx) * 4;
  if (idx + 2 >= inst.fieldData.length) return [235, 240, 255];
  const r = inst.fieldData[idx], g = inst.fieldData[idx + 1], b = inst.fieldData[idx + 2];
  const max = Math.max(r, g, b);
  if (!isFinite(max)) return [235, 240, 255];
  if (max >= 158) return [r, g, b];
  const f = 158 / Math.max(1, max);
  return [Math.min(255, r * f), Math.min(255, g * f), Math.min(255, b * f)];
};

/** 在 (sx, sy)（物理 px）为指定实例生成一粒发光微粒 */
const spawn = (inst: PAnim, sx: number, sy: number, age: number): void => {
  if (inst.pcount >= inst.maxP) return;
  let life = Math.round((3000 + Math.random() * 2200) * inst.k); // 3~5.2s（×k 随速度缩放）
  const fit = inst.duration - age - 40;
  if (fit < 120) return;
  if (life > fit) life = fit;
  const i = inst.pcount++;
  inst.px[i] = sx;   // 物理 px（屏幕）
  inst.py[i] = sy;
  inst.pang[i] = (Math.random() - 0.5) * ((110 * Math.PI) / 180); // ±55°
  // —— 增强飘动：放慢直线飞射（速度包络走缓），给摆动让出视觉空间 ——
  inst.pv0[i] = (6 + Math.random() * 12) * inst.noteDpr; // 初速 6~18 px/s（原 10~30）
  inst.pv1[i] = 190 * inst.noteDpr;                       // 加速度 190 px/s²（原 330，压低直线感）
  inst.plife[i] = life;
  inst.page[i] = 0;
  inst.psize[i] = 1.9 + Math.random() * 0.7;              // 尺寸 1.9~2.6（原固定 1.8，微增且带随机）
  inst.pseed[i] = Math.random() * Math.PI * 2;
  inst.psway[i] = (Math.random() - 0.5) * 100 * inst.noteDpr; // 水平漂移偏置 ±50 px/s（原 ±30，加大）
  const [r, g, b] = sampleColor(inst, sx - inst.originX, sy - inst.originY);
  inst.pr[i] = r / 255; inst.pg[i] = g / 255; inst.pb[i] = b / 255;
};

/** 构建一个便签的消散动画实例（发射网格 + T 时刻分桶 + 粒子池） */
function buildAnim(p: ParticleLayerStart): PAnim {
  const noteDpr = Math.max(1, p.dprNote || 1);
  const rectW = Math.max(1, p.width);
  const rectH = Math.max(1, p.height);
  const fieldW = p.fieldW || 8;
  const fieldH = p.fieldH || 8;
  const fieldData = p.fieldData || [];
  const tW = p.tW || 8;
  const tH = p.tH || 8;
  const tField = p.tField || [];
  const spacing = 3;
  const ecx = Math.max(2, Math.ceil(rectW / spacing));
  const ecy = Math.max(2, Math.ceil(rectH / spacing));
  const ecount = ecx * ecy;
  const emitX = new Float32Array(ecount);
  const emitY = new Float32Array(ecount);
  const emitT = new Float32Array(ecount);
  const emitDone = new Uint8Array(ecount);
  const sampleT = (lx: number, ly: number): number => {
    let fx = Math.round((lx / rectW) * tW);
    if (fx < 0) fx = 0; else if (fx >= tW) fx = tW - 1;
    let fy = Math.round((ly / rectH) * tH);
    if (fy < 0) fy = 0; else if (fy >= tH) fy = tH - 1;
    return tField[fy * tW + fx];
  };
  let ei = 0;
  let maxEmitT = 0;
  for (let iy = 0; iy < ecy; iy++) {
    for (let ix = 0; ix < ecx; ix++) {
      const lx = (ix + 0.5) * spacing;   // 便签局部 CSS px
      const ly = (iy + 0.5) * spacing;
      // 物理像素统一：局部 CSS px × resp 转物理 + origin（物理 px）= 屏幕物理 px
      emitX[ei] = p.originX + lx * noteDpr;
      emitY[ei] = p.originY + ly * noteDpr;
      let T = sampleT(lx, ly);
      if (!isFinite(T) || T < 0) T = 0;
      emitT[ei] = T;
      if (T > maxEmitT) maxEmitT = T;
      ei++;
    }
  }
  const binSize = 20;
  const binCount = Math.ceil(maxEmitT / binSize) + 2;
  const binPts: number[][] = [];
  for (let b = 0; b < binCount; b++) binPts.push([]);
  for (let i = 0; i < ecount; i++) {
    let b = Math.floor(emitT[i] / binSize);
    if (b < 0) b = 0; else if (b >= binCount) b = binCount - 1;
    binPts[b].push(i);
  }
  const density = Math.max(0, Math.min(100, p.density ?? 50)) / 100;
  const keepProb = Math.max(0.015, density);
  const peakAlive = Math.round(ecount * (0.03 + 0.97 * density));
  const maxP = peakAlive + 1500;
  const k = Math.max(0.25, Math.min(4, 100 / Math.max(10, p.speed ?? 100)));
  return {
    seq: p.seq ?? 0,
    originX: p.originX,
    originY: p.originY,
    rectW, rectH, fieldW, fieldH, fieldData, tW, tH, tField, noteDpr,
    emitX, emitY, emitT, emitDone, binPts, ecount,
    layerStartAt: p.startAt ?? Date.now(),
    duration: Math.round(2400 * k),
    k, keepProb,
    done: false,
    maxP,
    px: new Float32Array(maxP), py: new Float32Array(maxP), pang: new Float32Array(maxP),
    pv0: new Float32Array(maxP), pv1: new Float32Array(maxP), plife: new Float32Array(maxP),
    page: new Float32Array(maxP), psize: new Float32Array(maxP), pseed: new Float32Array(maxP),
    psway: new Float32Array(maxP), pr: new Float32Array(maxP), pg: new Float32Array(maxP),
    pb: new Float32Array(maxP),
    pcount: 0,
  };
}

/** 停止一切：清空所有实例、停循环、隐藏窗口 */
function stopLayer(): void {
  layerEnded = true;
  cancelAnimationFrame(rafId);
  if (backupId) {
    window.clearInterval(backupId);
    backupId = 0;
  }
  anims = [];
  if (gl) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  // 动画全部结束隐藏粒子层窗口：平时不显示（避免全屏置顶透明窗口干扰便签呼出/显示）。
  getCurrentWindow().hide().catch(() => {});
}

const frame = (now: number): void => {
  if (layerEnded) return;
  if (!started) {
    started = true;
    lastPaint = now;
  }
  const dt = Math.min(0.05, Math.max(0.001, (now - lastPaint) / 1000));
  lastPaint = now;
  if (!gl) return;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  let drawCount = 0;

  // 倒序遍历：播完的实例就地移除
  for (let a = anims.length - 1; a >= 0; a--) {
    const inst = anims[a];
    const age = Date.now() - inst.layerStartAt; // 系统时钟，与便签 mask 严格同基准
    if (age >= inst.duration) {
      inst.done = true;
      anims.splice(a, 1);
      continue;
    }
    const globalFade = age > inst.duration - 200 ? Math.max(0, (inst.duration - age) / 200) : 1;
    // ---- 发射：按 T 场分批生成（与便签窗口 mask 消散同步）----
    const b1 = Math.min(inst.binPts.length - 1, Math.floor(age / 20));
    for (let b = 0; b <= b1; b++) {
      const pts = inst.binPts[b];
      for (let z = 0; z < pts.length; z++) {
        const idx = pts[z];
        if (inst.emitDone[idx] === 0) {
          inst.emitDone[idx] = 1;
          if (Math.random() < inst.keepProb) spawn(inst, inst.emitX[idx], inst.emitY[idx], age);
        }
      }
    }
    // ---- 粒子：物理更新 + 写入全局 glData ----
    ensureGlData(drawCount + inst.pcount);
    for (let i = 0; i < inst.pcount; i++) {
      const a2 = inst.page[i] + dt * 1000;
      inst.page[i] = a2;
      const life = inst.plife[i];
      const u = a2 / life;
      if (u >= 1) {
        const last = --inst.pcount;
        if (i !== last) {
          inst.px[i] = inst.px[last]; inst.py[i] = inst.py[last]; inst.pang[i] = inst.pang[last];
          inst.pv0[i] = inst.pv0[last]; inst.pv1[i] = inst.pv1[last]; inst.plife[i] = inst.plife[last];
          inst.page[i] = inst.page[last]; inst.psize[i] = inst.psize[last]; inst.pseed[i] = inst.pseed[last];
          inst.psway[i] = inst.psway[last]; inst.pr[i] = inst.pr[last]; inst.pg[i] = inst.pg[last]; inst.pb[i] = inst.pb[last];
        }
        i--;
        continue;
      }
      const aSec = a2 / 1000;
      // 速度包络：起步缓、中段渐强、后段趋稳——避免直线飞射，让摆动看得见
      const spdRamp = Math.min(1, aSec / 0.9);
      const speed = (inst.pv0[i] + inst.pv1[i] * spdRamp) * (1 + 0.3 * Math.sin(a2 * 0.0021 + inst.pseed[i] * 3));
      const dx = Math.sin(inst.pang[i]);
      const dy = -Math.cos(inst.pang[i]); // 向上为负 y
      // —— 强飘动：慢漂移 + 中频摆动 + 高频抖动，多频正弦叠加 → 复杂有机曲线路径 ——
      const s1 = Math.sin(a2 * 0.0025 + inst.pseed[i]) * 85 * inst.noteDpr;
      const s2 = Math.sin(a2 * 0.009 + inst.pseed[i] * 2.3) * 55 * inst.noteDpr;
      const s3 = Math.sin(a2 * 0.024 + inst.pseed[i] * 4.1) * 20 * inst.noteDpr;
      const swayX = inst.psway[i] + s1 + s2 + s3;
      // 纵向起伏（漂浮感）：竖直方向也摆动，幅度随年龄渐强
      const bobY = Math.sin(a2 * 0.0062 + inst.pseed[i] * 1.7) * 55 * inst.noteDpr * (0.35 + 0.65 * spdRamp);
      inst.px[i] += (dx * speed + swayX) * dt;
      inst.py[i] += (dy * speed + bobY) * dt;
      const t = 1 - u;
      // 明暗呼吸（微闪烁）增强流动感；寿命自然淡出
      const twinkle = 0.8 + 0.2 * Math.sin(a2 * 0.02 + inst.pseed[i] * 5);
      const alpha = t * Math.pow(t, 0.2) * globalFade * twinkle;
      if (alpha < 0.02) continue;
      // 尺寸呼吸：随摆动节奏轻微脉动（飘动感）
      const pulse = 1 + 0.22 * Math.sin(a2 * 0.007 + inst.pseed[i] * 2);
      const haloR = inst.psize[i] * pulse * 1.3;
      const o = drawCount * 7;
      glData[o] = inst.px[i];       // 物理 px 直出（u_res = canvas 物理宽）
      glData[o + 1] = inst.py[i];
      glData[o + 2] = haloR * 2 * inst.noteDpr;
      glData[o + 3] = alpha;
      glData[o + 4] = inst.pr[i];
      glData[o + 5] = inst.pg[i];
      glData[o + 6] = inst.pb[i];
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

  if (anims.length === 0) {
    stopLayer();
  }
};

const step = (now: number): void => {
  frame(now);
  if (!layerEnded) rafId = requestAnimationFrame(step);
};

function startLayer(p: ParticleLayerStart): void {
  const now = Date.now();
  // 防御：清理所有已过期实例（超过各自 duration 仍未移除——兜底防历史残留，
  // 避免"历史位置出现粒子"）
  anims = anims.filter((a) => now - a.layerStartAt < a.duration);
  // 同一便签（同 origin，容差 4px 吸收浮点/位置微动）的旧实例 → 移除（新动画覆盖旧的，
  // 快速重复触发不残留双实例）；不同位置（不同便签）的实例保留 → 多便签并发互不影响。
  anims = anims.filter((a) => !(Math.abs(a.originX - p.originX) < 4 && Math.abs(a.originY - p.originY) < 4));
  const inst = buildAnim(p);
  anims.push(inst);
  // 循环未跑则启动（多实例共享一个 rAF 驱动）
  if (layerEnded) {
    layerEnded = false;
    started = false;
    rafId = requestAnimationFrame(step);
    backupId = window.setInterval(() => {
      if (layerEnded) return;
      const now = performance.now();
      if (now - lastPaint > 60) {
        lastPaint = now;
        frame(now);
      }
    }, 40);
  }
  // ⚠️ 不在这里 setSize：粒子层窗口 transparent+shadow(false) 对 setSize 敏感，
  // 可能触发 WebView2 渲染重建/白屏。mount 时已 calibrate 一次保证窗口全屏。
  getCurrentWindow().show().catch(() => {});
  // —— 关键：粒子层与便签窗口同为 alwaysOnTop，但 show() 不会激活 focusable:false
  // 的窗口，聚焦中的便签仍压在粒子层之上 → 粒子飘进便签未擦除（不透明）区域时被
  // 便签内容遮住，观感像“顶到墙顿一下、飞出便签顶部后又继续往上飞”。
  // 重新置顶一次（SetWindowPos HWND_TOPMOST）把粒子层抬到置顶层最上面，
  // 粒子全程在便签之上可见、连续飘散无遮挡。
  getCurrentWindow().setAlwaysOnTop(true).catch(() => {});
}

/** 校准粒子层窗口几何：锚定屏幕左上角 (0,0) 并铺满整屏，同步 canvas 缓冲尺寸。
 *  mount 时（app 启动、窗口未就绪）setSize 可能静默失败 → 窗口停在 tauri.conf.json
 *  固定尺寸，粒子屏幕坐标与窗口错位。启动时校准一次（currentMonitor 物理分辨率），
 *  resizable:true 时 setSize 才生效。动画中不再 setSize。 */
async function calibrateLayerWindow(): Promise<void> {
  const win = getCurrentWindow();
  const mon = await currentMonitor().catch(() => null);
  const fallbackW = Math.round((window.screen.width || window.innerWidth || 1920) * (window.devicePixelRatio || 1));
  const fallbackH = Math.round((window.screen.height || window.innerHeight || 1080) * (window.devicePixelRatio || 1));
  const pw = Math.max(1, mon?.size?.width ?? fallbackW);
  const ph = Math.max(1, mon?.size?.height ?? fallbackH);
  await win.setPosition(new LogicalPosition(0, 0)).catch(() => {});
  await win.setSize(new PhysicalSize(pw, ph)).catch(() => {});
  if (canvas && (canvas.width !== pw || canvas.height !== ph)) {
    canvas.width = pw;
    canvas.height = ph;
    gl = null;
    buf = null;
    aPosLoc = 0;
    aParamLoc = 0;
    aColorLoc = 0;
    if (!setupGL()) {
      console.error("粒子层 WebGL 重建失败");
    }
  }
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
    uniform sampler2D u_sprite;
    void main() {
      // 圆形发光纹理：alpha 决定形状（点精灵在部分驱动上 discard 圆形不可靠 → 用纹理兜底）
      vec4 c = texture2D(u_sprite, gl_PointCoord);
      if (c.a < 0.01) discard;
      gl_FragColor = vec4(v_color * 1.5, v_alpha * c.a);
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
  // ---- 圆形发光精灵纹理（径向渐变：中心实、边缘透明圆）----
  const spriteLoc = gl.getUniformLocation(prog, "u_sprite");
  if (spriteLoc) gl.uniform1i(spriteLoc, 0);
  const SS = 32;
  const spr = document.createElement("canvas");
  spr.width = SS;
  spr.height = SS;
  const sctx = spr.getContext("2d");
  if (sctx) {
    const g = sctx.createRadialGradient(SS / 2, SS / 2, 0, SS / 2, SS / 2, SS / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.75)");
    g.addColorStop(0.75, "rgba(255,255,255,0.2)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, SS, SS);
  }
  const tex = gl.createTexture();
  if (tex) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, spr);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  return true;
}

export async function mountParticlesLayer(): Promise<void> {
  const win = getCurrentWindow();
  // 启动时校准窗口几何（currentMonitor 物理分辨率 + PhysicalSize）——一次就够，
  // 后续动画中不再 setSize（避免 transparent+shadow(false) 窗口 setSize 触发 WebView2 重建）。
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  await calibrateLayerWindow();
  const ww = window.screen.width || window.innerWidth;
  const hh = window.screen.height || window.innerHeight;
  // 物理全屏尺寸（canvas 与校准后的窗口保持一致）
  const pw = Math.max(1, Math.round(ww * dpr));
  const ph = Math.max(1, Math.round(hh * dpr));
  win.setIgnoreCursorEvents(true).catch(() => {});
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  document.body.style.background = "transparent";
  canvas = document.createElement("canvas");
  // ⚠️ 必须直接用物理全屏尺寸——刚创建的 canvas.width 默认是 300（不是 0）
  canvas.width = pw;
  canvas.height = ph;
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
  await listen<{ seq?: number; originX?: number; originY?: number }>("particles-cancel", (e) => {
    const seq = e?.payload?.seq ?? 0;
    const ox = e?.payload?.originX;
    const oy = e?.payload?.originY;
    if (seq !== 0) {
      // 按 (seq + origin) 精确匹配：过期/别的窗口的 cancel 不影响本窗口/其他实例
      anims = anims.filter(
        (a) =>
          !(a.seq === seq &&
            (ox === undefined || Math.abs(a.originX - ox) < 1) &&
            (oy === undefined || Math.abs(a.originY - oy) < 1)),
      );
    } else {
      // 无序号（旧协议）：全停
      anims = [];
    }
    if (anims.length === 0) stopLayer();
  });
}
