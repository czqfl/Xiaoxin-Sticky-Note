// 便签「涡旋消散」动画：从便签整体居中位置的一个点发起粒子化，粒子化以圆形向外扩张；
// 已被粒子化的圆形区域内的粒子开始绕中心顺时针旋转（平面圆盘涡旋）。
// ----------------------------------------------------------------------------
// 触发：关闭窗口时播放（particle_mode = "vortex" 时选用）。
// 呼出时不播放动画：直接复原便签显示（见 note.ts summoned 处理）。
//
// 视觉要点（对齐需求）：
// - **中心点起爆、圆形扩张**：粒子化前缘为以屏幕中心为圆心的圆，半径由 0 平滑扩张至覆盖整幅
//   （ease-out 二次曲线）；便签被圆覆盖的原始区域真正消失（mask 径向擦除，边缘羽化）。
// - **旋转吸入（旋涡）**：粒子铺满整个已粒子化圆盘（中心也有粒子、不空），绕心顺时针旋转的
//   同时整体向中心收缩（ease-in：先慢后快 → 旋涡内吸），寿命末段在中心附近消散、重生后再被
//   吸入；粒子化前缘宽羽化，边缘柔和不成整齐圆线。
// - 粒子颜色**每帧按粒子实际位置采样**后面背景色（additive 辉光），随位置变化跟随后面背景。
//
// 工程契约：复用粒子光效基础设施（WebGL 单次 draw call 点精灵 + 颜色场 + 代次守卫 + 看门狗）；
// cancelVortexParticles() 立即中止（停帧+复原页面、不触发 onDone），供“呼出打断关闭”；
// 看门狗强制收尾，杜绝动画卡死导致窗口无法关闭。

import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

let vortexActive = false;
/** 动画代次：每次 runVortex 启动 +1。上一轮动画遗留的延时清理凭此作废。 */
let vortexGen = 0;

/** 当前动画的“立即中止”句柄。 */
let cancelVortexFn: (() => void) | null = null;

/** 立即中止粒子动画并复原页面（呼出打断关闭时调用——不触发 onDone，窗口保持显示）。
 *  若粒子层窗口在播放（remote 模式），一并通知其停止隐藏。 */
export function cancelVortexParticles(): void {
  emit("particles-cancel").catch(() => {});
  const c = cancelVortexFn;
  cancelVortexFn = null;
  if (c) {
    c();
    return;
  }
  if (!vortexActive) return;
  vortexActive = false;
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) restoreRoot(root);
  document.querySelector(".glow-particles-canvas")?.remove();
}

/** 复原便签本体样式（裁剪 / mask / 透明度 / 阴影 还原）。 */
function restoreRoot(root: HTMLElement): void {
  try {
    root.style.clipPath = "";
    root.style.setProperty("-webkit-mask-image", "");
    root.style.setProperty("mask-image", "");
    root.style.opacity = "";
    root.style.boxShadow = "";
    root.style.transform = "";
    root.style.backfaceVisibility = "";
    root.style.transition = "";
  } catch {
    /* ignore */
  }
}

/** 隐藏便签本体（保持“空画面”，供下次呼出直接复原显示）。 */
function blankRoot(root: HTMLElement): void {
  try {
    root.style.clipPath = "inset(0 0 100% 0)";
    root.style.setProperty("-webkit-mask-image", "");
    root.style.setProperty("mask-image", "");
    root.style.opacity = "";
    root.style.boxShadow = "none";
    root.style.transform = "";
    root.style.backfaceVisibility = "";
    root.style.transition = "";
  } catch {
    /* ignore */
  }
}

/** 作废上一轮动画遗留的延时清理（cleanupAfterHide）。 */
export function bumpVortexGen(): void {
  vortexGen++;
}

/** 请求播放「涡旋消散」关闭动画；onDone 在动画完全结束后调用（真正关闭窗口）。
 * speed：动画速度百分比（100=原速），所有时序按 100/speed 缩放。 */
export function requestVortexDissolveClose(
  onDone: () => void,
  particleDensity = 50,
  speed = 100,
  remote = false,
): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || vortexActive) {
    onDone();
    return;
  }
  vortexActive = true;
  let done = false;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  const safeDone = () => {
    if (done) return;
    done = true;
    vortexActive = false;
    cancelVortexFn = null;
    onDone();
  };
  const watchdog = window.setTimeout(safeDone, 5000);
  cancelVortexFn = () => {
    if (aborted) return;
    aborted = true;
    window.clearTimeout(watchdog);
    if (stopRun) stopRun();
    done = true; // 阻止 onDone：finish() 不会被调用，窗口保持显示
    vortexActive = false;
  };
  void (async () => {
    // remote：先确认全屏粒子层窗口可用；不可用回退 self（粒子画在窗口内）
    let useRemote = false;
    if (remote && !aborted) {
      try {
        const layer = await WebviewWindow.getByLabel("particles");
        if (layer) {
          await layer.show();
          useRemote = true;
        }
      } catch {
        useRemote = false;
      }
    }
    if (aborted) return;
    try {
      // remote：提前并行获取颜色场与窗口位置（emit 不再 await，粒子层与 mask 几乎同步开始）
      let layerField: ColorField | null = null;
      let layerOrigin = { x: 0, y: 0 };
      if (useRemote && !aborted) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const [field, pos] = await Promise.all([
          buildColorField(root, w, h),
          getCurrentWindow().outerPosition().catch(() => null),
        ]);
        layerField = field;
        if (pos) {
          layerOrigin.x = pos.x / dpr;
          layerOrigin.y = pos.y / dpr;
        }
      }
      if (aborted) return;
      const animStartAt = performance.now(); // 动画开始时刻（粒子层用同一基准计算 age，严格同步）
      stopRun = runVortex(root, particleDensity, speed, () => {
        window.clearTimeout(watchdog);
        safeDone();
      }, useRemote ? "remote" : "self");
      // remote：立即发 start（颜色场/位置已就绪），粒子层与 mask 同步开始
      if (useRemote && !aborted) {
        const field = layerField;
        emit("particles-start", {
          type: "vortex",
          originX: layerOrigin.x,
          originY: layerOrigin.y,
          width: window.innerWidth,
          height: window.innerHeight,
          fieldW: field?.fw ?? 8,
          fieldH: field?.fh ?? 8,
          fieldData: field ? Array.from(field.data) : [],
          density: particleDensity,
          speed,
          startAt: animStartAt,
        }).catch(() => {});
      }
    } catch (e) {
      console.error("涡旋消散动画异常:", e);
      window.clearTimeout(watchdog);
      safeDone();
    }
  })();
}

// ---- 颜色工具：采样到的主题色提亮到足够发光的明度（保留色相）----
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

/** 让粒子颜色贴近背景实际颜色：只在背景过暗时轻微提亮到最低可见明度（保留色相）。 */
function toGlowColor(r: number, g: number, b: number): [number, number, number] {
  const [h, s, l] = rgbToHsl(r, g, b);
  const nl = Math.max(l, 0.62);
  const ns = Math.max(s, 0.3);
  return hslToRgb(h, ns, nl);
}

interface ColorField {
  data: Uint8ClampedArray;
  fw: number;
  fh: number;
}

/** 提取 CSS 变量里的 url("...") → data URL；无则返回空串。 */
function extractUrl(prop: string): string {
  if (!prop) return "";
  const m = prop.match(/url\((['"]?)([\s\S]*?)\1\)/);
  return m ? m[2] : "";
}

/**
 * 构建便签「区域颜色场」（低分辨率）：肉眼所见背景色 = --bg 底色 +（has-bg 时）背景图 cover
 * + 面板半透明叠加（--note-panel-alpha）。随后按粒子生成区域采样主题色。
 */
function buildColorField(root: HTMLElement, w: number, h: number): Promise<ColorField | null> {
  const fw = Math.max(8, Math.min(128, Math.round(w)));
  const fh = Math.max(8, Math.round((h * fw) / Math.max(1, w)));
  const c = document.createElement("canvas");
  c.width = fw;
  c.height = fh;
  const fctx = c.getContext("2d", { willReadFrequently: true });
  if (!fctx) return Promise.resolve(null);

  const cs = getComputedStyle(root);
  const bgColor = cs.backgroundColor || "rgb(128,128,128)";
  let panelAlpha = parseFloat(cs.getPropertyValue("--note-panel-alpha"));
  if (!isFinite(panelAlpha) || panelAlpha <= 0 || panelAlpha > 1) panelAlpha = 0.7;
  const dataUrl = extractUrl(cs.getPropertyValue("--note-bg-img"));

  const readBack = (): ColorField => ({
    data: fctx.getImageData(0, 0, fw, fh).data,
    fw,
    fh,
  });
  const fillSolid = (): void => {
    fctx.fillStyle = bgColor;
    fctx.fillRect(0, 0, fw, fh);
  };

  if (!dataUrl) {
    fillSolid();
    return Promise.resolve(readBack());
  }

  return new Promise((resolve) => {
    let settled = false;
    const finishWith = (withImage: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      if (withImage && withImage.naturalWidth > 0) {
        const iw = withImage.naturalWidth;
        const ih = withImage.naturalHeight;
        const ir = iw / ih;
        const fr = fw / fh;
        let dw: number, dh: number, dx: number, dy: number;
        if (ir > fr) {
          dh = fh; dw = fh * ir; dx = (fw - dw) / 2; dy = 0;
        } else {
          dw = fw; dh = fw / ir; dx = 0; dy = (fh - dh) / 2;
        }
        fctx.drawImage(withImage, dx, dy, dw, dh);
        fctx.save();
        fctx.globalAlpha = panelAlpha * 0.15;
        fctx.fillStyle = bgColor;
        fctx.fillRect(0, 0, fw, fh);
        fctx.restore();
      } else {
        fillSolid();
      }
      resolve(readBack());
    };
    const img = new Image();
    const timer = window.setTimeout(() => finishWith(null), 140);
    img.onload = () => {
      window.clearTimeout(timer);
      finishWith(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      finishWith(null);
    };
    img.src = dataUrl;
  });
}

/**
 * 播放一次涡旋消散动画：中心点圆形扩张粒子化，已粒子化圆盘内粒子绕中心顺时针旋转。
 */
function runVortex(
  root: HTMLElement,
  particleDensity: number,
  speed: number,
  onDone: () => void,
  mode: "self" | "remote" = "self",
): () => void {
  const myGen = ++vortexGen; // 本动画实例代次：作废上一轮遗留的延时清理
  const remote = mode === "remote";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;
  const k = Math.max(0.25, Math.min(4, 100 / Math.max(10, speed))); // 速度系数：200%→0.5（时长减半）

  // ---- 时序参数（整体 ~1.2s：圆形扩张 + 粒子旋转 + 透明度淡出收尾）----
  const duration = Math.round(1200 * k);

  // ---- 粒子覆盖层 canvas（WebGL：GPU 单次 draw call 渲染点精灵）。
  // remote 模式（粒子交给全屏透明粒子层窗口）下本窗口不建 canvas/GL。----
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | null = null;
  let loseGL = () => {};
  let aPosLoc = 0;
  let aParamLoc = 0;
  let aColorLoc = 0;
  let glBuf: WebGLBuffer | null = null;
  if (!remote) {
    canvas = document.createElement("canvas");
    canvas.className = "glow-particles-canvas";
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.position = "fixed";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.zIndex = "2147483647";
    canvas.style.pointerEvents = "none";
    canvas.style.transform = "translateZ(0)";
    document.body.appendChild(canvas);
    const glOpts: WebGLContextAttributes = { alpha: true, premultipliedAlpha: false, antialias: false, depth: false };
    gl = (canvas.getContext("webgl", glOpts) ||
      (canvas.getContext("experimental-webgl" as "webgl", glOpts) as unknown as WebGLRenderingContext | null)) as WebGLRenderingContext | null;
    if (!gl) {
      canvas.remove();
      finishEarly();
      return () => {};
    }
    const VS_SRC = `
      attribute vec2 a_pos;     // 设备像素坐标
      attribute vec2 a_param;   // x=直径(设备px) y=alpha
      attribute vec3 a_color;   // rgb 0~1
      uniform vec2 u_res;       // canvas 设备尺寸
      varying float v_alpha;
      varying vec3 v_color;
      void main() {
        vec2 clip = (a_pos / u_res) * 2.0 - 1.0;
        clip.y = -clip.y;       // 设备 y 向下，翻转
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
    const compileGL = (type: number, src: string): WebGLShader | null => {
      const sh = gl!.createShader(type);
      if (!sh) return null;
      gl!.shaderSource(sh, src);
      gl!.compileShader(sh);
      if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
        console.warn("[vortex] shader compile failed:", gl!.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const glVS = compileGL(gl.VERTEX_SHADER, VS_SRC);
    const glFS = compileGL(gl.FRAGMENT_SHADER, FS_SRC);
    if (!glVS || !glFS) {
      canvas.remove();
      finishEarly();
      return () => {};
    }
    const glProg = gl.createProgram();
    if (!glProg) {
      canvas.remove();
      finishEarly();
      return () => {};
    }
    gl.attachShader(glProg, glVS);
    gl.attachShader(glProg, glFS);
    gl.linkProgram(glProg);
    if (!gl.getProgramParameter(glProg, gl.LINK_STATUS)) {
      console.warn("[vortex] program link failed:", gl.getProgramInfoLog(glProg));
      canvas.remove();
      finishEarly();
      return () => {};
    }
    gl.useProgram(glProg);
    aPosLoc = gl.getAttribLocation(glProg, "a_pos");
    aParamLoc = gl.getAttribLocation(glProg, "a_param");
    aColorLoc = gl.getAttribLocation(glProg, "a_color");
    gl.uniform2f(gl.getUniformLocation(glProg, "u_res"), canvas.width, canvas.height);
    glBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive 辉光（非预乘）
    let glLost = false;
    loseGL = () => {
      if (glLost) return;
      glLost = true;
      const ext = gl!.getExtension("WEBGL_lose_context");
      if (ext) ext.loseContext();
    };
  }

  // ---- 颜色场（异步构建；之后按生成区域采样）----
  let field: ColorField | null = null;
  void buildColorField(root, w, h).then((f) => {
    field = f;
  });
  const sampleThemeColor = (x: number, y: number): [number, number, number] => {
    if (!field) return [235, 240, 255]; // 兜底亮白
    let fx = Math.round((x / w) * field.fw);
    if (fx < 0) fx = 0;
    else if (fx >= field.fw) fx = field.fw - 1;
    let fy = Math.round((y / h) * field.fh);
    if (fy < 0) fy = 0;
    else if (fy >= field.fh) fy = field.fh - 1;
    const idx = (fy * field.fw + fx) * 4;
    return toGlowColor(field.data[idx], field.data[idx + 1], field.data[idx + 2]);
  };

  // ---- 涡旋几何参数 ----
  const cx = w / 2;                 // 圆心 x（便签整体居中位置）
  const cy = h / 2;                 // 圆心 y
  const maxR = Math.hypot(w, h) / 2; // 最大半径：覆盖整幅（含四角）
  const omega = (Math.PI * 2 * 2) / (duration / 1000); // 粒子绕心角速度：全程约 2 圈（rad/s，顺时针）

  // ---- 粒子池（SoA）：粒子出生铺满整个已粒子化圆盘（比例 0~1 面积均匀，中心也有粒子），
  // 实际半径 = 当前粒子化前缘 curR × 比例 × 吸入收缩 —— 粒子绕心旋转的同时整体向中心收缩
  // （旋涡内吸），寿命末段在中心附近消散、重生后再被吸入；颜色每帧按粒子实际位置采样
  // （跟随后面背景）。remote 模式：粒子交给全屏粒子层窗口渲染（屏幕坐标，不被窗口框住）。
  let N = 0;
  let pth = new Float32Array(0);    // 初始圆周角 θ₀（绕心旋转）
  let pfrac = new Float32Array(0);  // 出生半径（绝对 px，铺满圆盘）；实际半径 = pfrac × 吸入收缩
  let pbirth = new Float32Array(0); // 出生时刻（相对动画起点的 age，ms）
  let plife = new Float32Array(0);  // 寿命 ms
  let psize = new Float32Array(0);  // 基础像素尺寸
  let pr = new Float32Array(0);     // 粒子颜色（生成位置背景色，带色飘散）
  let pg = new Float32Array(0);
  let pb = new Float32Array(0);
  let glData = new Float32Array(0);
  let respawn: (i: number, atAge: number, curR: number) => void = () => {};
  if (!remote) {
    N = Math.round(4000 + density * 18000); // 涡旋密度调疏（用户反馈太稠）
    const maxP = Math.max(N + 64, 256);
    pth = new Float32Array(maxP);
    pfrac = new Float32Array(maxP);
    pbirth = new Float32Array(maxP);
    plife = new Float32Array(maxP);
    psize = new Float32Array(maxP);
    pr = new Float32Array(maxP);
    pg = new Float32Array(maxP);
    pb = new Float32Array(maxP);
    glData = new Float32Array(maxP * 7);

    // 粒子消散式：在生成位置（便签该处背景）取色，随后带色旋转飘散（颜色固定跟随粒子）
    respawn = (i: number, atAge: number, curR: number): void => {
      pbirth[i] = atAge;
      pth[i] = Math.random() * Math.PI * 2;
      plife[i] = Math.round((900 + Math.random() * 600) * k); // 寿命随速度缩放
      psize[i] = 2.0;
      pfrac[i] = Math.sqrt(Math.random()); // 圆盘面积均匀的比例（0~1，跟随 curR 扩张）
      // 生成处取色：出生位置（当前圆盘该半径处）对应的便签背景色
      const r0 = curR * pfrac[i];
      const sx0 = cx + r0 * Math.cos(pth[i]);
      const sy0 = cy + r0 * Math.sin(pth[i]);
      const [r, g, b] = sampleThemeColor(sx0, sy0);
      pr[i] = r / 255; pg[i] = g / 255; pb[i] = b / 255;
    };
    for (let i = 0; i < N; i++) {
      respawn(i, 0, maxR * 0.05); // 起始前缘 5%（fadeIn 统一淡入）
    }
  }

  // ---- 帧循环控制 ----
  let rafId = 0;
  let backupId = 0;
  let start = 0;
  let started = false;
  let endedLocal = false;
  let watchdog = 0;

  const stopLoop = () => {
    endedLocal = true;
    cancelAnimationFrame(rafId);
    if (backupId) {
      window.clearInterval(backupId);
      backupId = 0;
    }
    if (watchdog) {
      window.clearTimeout(watchdog);
      watchdog = 0;
    }
    loseGL();
  };

  function finishEarly(): void {
    stopLoop();
    blankRoot(root);
    onDone();
  }

  const cleanupAfterHide = () => {
    stopLoop();
    try {
      canvas?.remove();
    } catch {
      /* ignore */
    }
    if (myGen !== vortexGen) return;
    blankRoot(root); // 保持“空画面”供下次呼出
    vortexActive = false;
  };

  const frame = (now: number) => {
    if (endedLocal) return;
    if (!started) {
      started = true;
      start = now;
    }
    const age = now - start;
    // 便签 mask：只扩张不回收（前 40% 扩张到 maxR，之后保持全擦，便签擦除后不恢复显示）
    const erodeP = Math.min(1, age / (duration * 0.4));
    const erodeR = maxR * (0.05 + 0.95 * erodeP * (2 - erodeP));
    // 粒子圆盘：两段式——前 40% 快速扩张（点扩散成圆盘），后 60% 迅速收拢回中心点
    const p = Math.min(1, age / duration);
    let curR: number;
    if (p < 0.4) {
      const q = p / 0.4;
      curR = maxR * (0.05 + 0.95 * q * (2 - q));
    } else {
      const q = (p - 0.4) / 0.6;
      curR = maxR * (1 - 0.95 * q * q);
    }

    // ---- 便签本体：保持静止。靠 mask 把“已被粒子化的圆形区域”真正擦成透明（消失），
    // 而非整体变透明；仅后半段（后 50% 动画时间）再让剩余便签轻微透明（100% → 65%）。----
    const fadeStart = duration * 0.5;
    if (age > fadeStart) {
      const p2 = Math.min(1, (age - fadeStart) / (duration - fadeStart));
      root.style.opacity = (1 - 0.35 * p2).toFixed(3); // 1.0 → 0.65
    }
    if (erodeR >= maxR) {
      // 粒子化已覆盖整幅 → 便签整体消失（保持，不恢复）
      root.style.webkitMaskImage = "linear-gradient(to right, rgba(0,0,0,0), rgba(0,0,0,0))";
      root.style.maskImage = "linear-gradient(to right, rgba(0,0,0,0), rgba(0,0,0,0))";
    } else {
      // mask：圆内透明（隐藏=已粒子化擦除）、圆外 #000（显示），前缘宽羽化（边缘柔和不呈圆线）
      const feather = 28;
      const inner = Math.max(0, erodeR - feather);
      const maskCss =
        `radial-gradient(circle at ${cx}px ${cy}px, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ${inner}px,` +
        ` #000 ${curR}px, #000 100%)`;
      root.style.webkitMaskImage = maskCss;
      root.style.maskImage = maskCss;
    }

    // ---- 粒子：圆盘内出生→绕心旋转吸入→寿命末段消散（仅 self 模式在本窗口渲染；
    // remote 模式粒子由全屏粒子层窗口渲染，不被窗口框住）----
    if (!remote) {
      gl!.clearColor(0, 0, 0, 0);
      gl!.clear(gl!.COLOR_BUFFER_BIT);
      const globalFade = age > duration - Math.round(300 * k) ? Math.max(0, (duration - age) / Math.round(300 * k)) : 1; // 末段整体淡出
      let drawCount = 0;
      for (let i = 0; i < N; i++) {
        let a = age - pbirth[i];
        if (a < 0) continue;            // 尚未出生
        if (a >= plife[i]) {            // 寿命到 → 在圆盘外缘重生（不息）
          respawn(i, age, curR);
          a = 0;
        }
        const theta = pth[i] + omega * (age / 1000); // 绕心顺时针旋转
        const t = a / plife[i];                      // 寿命进度 0→1
        const shrink = t * t;                        // 吸入收缩（ease-in：先慢后快 → 旋涡内吸）
        const r = curR * pfrac[i] * (1 - 0.92 * shrink); // 跟随当前圆盘扩张 + 向中心吸入收缩
        const sx = cx + r * Math.cos(theta);         // 屏幕 x
        const sy = cy + r * Math.sin(theta);         // 屏幕 y
        const fadeIn = Math.min(1, a / 150);         // 出生淡入
        const lifeFade = t > 0.7 ? Math.max(0, (1 - t) / 0.3) : 1; // 末段消散
        const alpha = fadeIn * lifeFade * globalFade;
        if (alpha < 0.02) continue;
        const haloR = psize[i] * (0.6 + 0.4 * fadeIn);
        const o = drawCount * 7;
        glData[o] = sx * dpr;
        glData[o + 1] = sy * dpr;
        glData[o + 2] = haloR * 2 * dpr;
        glData[o + 3] = alpha;
        // 粒子消散式：颜色 = 生成位置背景色，带色旋转飘散（固定跟随粒子）
        glData[o + 4] = pr[i];
        glData[o + 5] = pg[i];
        glData[o + 6] = pb[i];
        drawCount++;
      }
      if (drawCount > 0) {
        gl!.bindBuffer(gl!.ARRAY_BUFFER, glBuf);
        gl!.bufferData(gl!.ARRAY_BUFFER, glData.subarray(0, drawCount * 7), gl!.DYNAMIC_DRAW);
        gl!.enableVertexAttribArray(aPosLoc);
        gl!.vertexAttribPointer(aPosLoc, 2, gl!.FLOAT, false, 28, 0);
        gl!.enableVertexAttribArray(aParamLoc);
        gl!.vertexAttribPointer(aParamLoc, 2, gl!.FLOAT, false, 28, 8);
        gl!.enableVertexAttribArray(aColorLoc);
        gl!.vertexAttribPointer(aColorLoc, 3, gl!.FLOAT, false, 28, 16);
        gl!.drawArrays(gl!.POINTS, 0, drawCount);
      }
    }

    if (age >= duration) {
      gl?.clearColor(0, 0, 0, 0);
      gl?.clear(gl!.COLOR_BUFFER_BIT);
      stopLoop();
      try {
        onDone(); // 触发真正隐藏窗口
      } finally {
        window.setTimeout(cleanupAfterHide, 400);
      }
    }
  };

  const step = (now: number) => {
    frame(now);
    if (!endedLocal) rafId = requestAnimationFrame(step);
  };

  const beginLoop = (): void => {
    if (endedLocal) return;
    // 便签本体保持静止，仅由粒子层作旋转圆盘；直接开帧即可
    rafId = requestAnimationFrame(step);
  };

  beginLoop();
  return () => {
    if (endedLocal) return;
    endedLocal = true;
    stopLoop();
    restoreRoot(root);
    document.querySelector(".glow-particles-canvas")?.remove();
  };
}
