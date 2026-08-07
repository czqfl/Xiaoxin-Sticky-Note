// 便签「粒子光效消散」动画（恢复版）：界面从随机几处开始碎裂成发光微粒，
// 区域化朝相近方向加速上升、边升边淡出，全程带光晕辉光。粒子在便签窗口内渲染。
// ----------------------------------------------------------------------------
// 触发：关闭窗口时播放（粒子风格 particle_mode = "particle" 时选用）。
// 呼出时不播放动画：直接复原便签显示（见 note.ts summoned 处理）。
//
// 视觉要点（对齐需求）：
// - **上中下三部分限制起爆**：便签竖向三等分——
//   下 1/3 必须随机某点发起消散（~0ms）；
//   上 1/3 随机从左侧 / 右侧 / 上侧边缘发起消散（~0ms）；
//   中 1/3 必发 1 点（动画 ~40% 时起爆）；下/上各 35% 概率补充 1 点（~40% 时）。
//   每个区域以自身为起点向外蔓延，方向性扩张速度：往上消散 > 左右消散 > 往下消散
//   （等效距离 上×0.4 / 左右×1.0 / 下×1.8）；幂函数蔓延（先慢后快）；
//   花瓣状角度调制 → 扩散形状不规则（非圆形）；取 min 叠加 → 各区域前沿先后推进。
// - 动画后 50%：便签整体透明度 100% → 50% 淡出（不必等 mask 铺满全窗）。
// - **等加速上升**：所有粒子初速度相同、加速度相同（speed = v0 + a·t），
//   随机左右偏转 ±55°，可飘向窗口边缘；粒子寿命 1300~1800ms。
// - 颜色（动态主题采样）：构建便签"区域颜色场"（--bg 底色 + has-bg 背景图 cover 为主导，
//   底色仅轻量调和），按粒子**生成区域**采样对应背景颜色（背景是什么颜色粒子就是什么颜色），
//   additive 叠加出辉光，边升边变淡直至自然消散。
//
// 工程契约：canvas 覆盖层画粒子（z-index 置顶、pointer-events:none、WebGL 单次 draw call
// 点精灵）；cancelGlowParticles() 立即中止（停帧+复原页面、不触发 onDone），供"呼出打断关闭"；
// 看门狗强制收尾，杜绝动画卡死导致窗口无法关闭。

let glowActive = false;
/** 动画代次：每次 runGlow 启动 +1。上一轮动画遗留的延时清理（cleanupAfterHide）凭此作废，
 *  避免快速呼出时把正在播放的新动画便签裁掉/隐藏（见 cleanupAfterHide 守卫）。 */
let glowGen = 0;

/** 当前粒子动画的“立即中止”句柄（由 runGlow 注册；cancelGlowParticles 调用）。 */
let cancelGlowFn: (() => void) | null = null;

/** 立即中止粒子动画并复原页面（呼出打断关闭时调用——不触发 onDone，窗口保持显示）。 */
export function cancelGlowParticles(): void {
  const c = cancelGlowFn;
  cancelGlowFn = null;
  if (c) {
    c();
    return;
  }
  // 兜底：无注册句柄时（理论不会出现）直接复原页面
  if (!glowActive) return;
  glowActive = false;
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) restoreRoot(root);
  document.querySelector(".glow-particles-canvas")?.remove();
}

/** 复原便签本体样式（裁剪 / mask / 透明度 / 阴影还原）。 */
function restoreRoot(root: HTMLElement): void {
  try {
    root.style.clipPath = "";
    root.style.setProperty("-webkit-mask-image", "");
    root.style.setProperty("mask-image", "");
    root.style.opacity = "";
    root.style.boxShadow = "";
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
  } catch {
    /* ignore */
  }
}

/** 作废上一轮动画遗留的延时清理（cleanupAfterHide）。
 *  粒子模式无呼出动画，呼出本身不递增 glowGen；若不作废，关闭动画结束后 400ms 的
 *  cleanupAfterHide 会把「刚呼出并已复原显示」的便签再次裁成空画面（呼出后不显示）。 */
export function bumpGlowGen(): void {
  glowGen++;
}

/** 请求播放「粒子光效消散」关闭动画；onDone 在动画完全结束后调用（真正关闭窗口）。 */
export function requestGlowDissolveClose(onDone: () => void, particleDensity = 50): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || glowActive) {
    onDone();
    return;
  }
  glowActive = true;
  let done = false;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  const safeDone = () => {
    if (done) return;
    done = true;
    glowActive = false;
    cancelGlowFn = null;
    onDone();
  };
  const watchdog = window.setTimeout(safeDone, 5000);
  cancelGlowFn = () => {
    if (aborted) return;
    aborted = true;
    window.clearTimeout(watchdog);
    if (stopRun) stopRun();
    done = true; // 阻止 onDone：finish() 不会被调用，窗口保持显示
    glowActive = false;
  };
  try {
    stopRun = runGlow(root, particleDensity, () => {
      window.clearTimeout(watchdog);
      safeDone();
    });
  } catch (e) {
    console.error("粒子光效消散动画异常:", e);
    window.clearTimeout(watchdog);
    safeDone();
  }
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
  const nl = Math.max(l, 0.62); // 兜底提亮：深色主题下粒子也足够明亮（additive 叠加后清晰可见）
  const ns = Math.max(s, 0.3); // 避免发灰
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
 * 背景图是 data URL（内存中），解码很快；给 140ms 上限，超时/失败回退纯色，绝不卡住动画。
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

  // 无背景图：纯色主题，直接填充即可
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
        // cover 适配 + 轻量底色调和：以背景图颜色为主导（粒子颜色 = 背景颜色），
        // 底色仅轻微混合防刺眼。
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

/** 播放一次粒子光效消散动画。 */
function runGlow(
  root: HTMLElement,
  particleDensity: number,
  onDone: () => void,
): () => void {
  const myGen = ++glowGen; // 本动画实例代次：作废上一轮遗留的延时清理
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;

  // ---- 时序参数（整体 ~2.4s：主体消散 1400ms + 透明度淡出收尾）
  const wipe = 1400; // 主体消散窗口 ms
  const secondBatchAt = 960; // 第二批区域在动画 ~40% 时起爆
  const duration = 2400; // 总时长 ~2.4s（后半段透明度淡出代替铺满全窗）

  // ---- 粒子覆盖层 canvas（WebGL：GPU 单次 draw call 渲染点精灵）----
  const canvas = document.createElement("canvas");
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
  const gl = (canvas.getContext("webgl", glOpts) ||
    (canvas.getContext("experimental-webgl" as "webgl", glOpts) as unknown as WebGLRenderingContext | null)) as WebGLRenderingContext | null;
  if (!gl) {
    canvas.remove();
    finishEarly();
    return () => {};
  }
  // 顶点：设备像素坐标 → clip 空间；用 gl_PointSize 当点直径；片元用 gl_PointCoord 画软圆辉光
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
      // 清晰圆形光点：亮核直径 = psize（占点尺寸 60%），边缘羽化 —— 圆点独立可辨
      float r = sqrt(r2);
      float a = clamp((0.3 - r) / 0.06, 0.0, 1.0);
      gl_FragColor = vec4(v_color * 1.5, v_alpha * a);
    }`;
  const compileGL = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("[glow] shader compile failed:", gl.getShaderInfoLog(sh));
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
    console.warn("[glow] program link failed:", gl.getProgramInfoLog(glProg));
    canvas.remove();
    finishEarly();
    return () => {};
  }
  gl.useProgram(glProg);
  const aPosLoc = gl.getAttribLocation(glProg, "a_pos");
  const aParamLoc = gl.getAttribLocation(glProg, "a_param");
  const aColorLoc = gl.getAttribLocation(glProg, "a_color");
  gl.uniform2f(gl.getUniformLocation(glProg, "u_res"), canvas.width, canvas.height);
  const glBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive 辉光（非预乘）
  let glLost = false;
  const loseGL = () => {
    if (glLost) return;
    glLost = true;
    const ext = gl.getExtension("WEBGL_lose_context");
    if (ext) ext.loseContext();
  };

  // ---- 颜色场（异步构建；之后按生成区域采样）----
  let field: ColorField | null = null;
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

  // ---- 消散时间场 T(x,y)：上中下三部分限制起爆 ----
  // 便签竖向三等分：
  // - 下 1/3：必须随机某点发起消散（~0ms 起爆）
  // - 中 1/3：必发 1 点（动画 ~40% 时起爆）
  // - 上 1/3：随机从左侧 / 右侧 / 上侧边缘发起消散（~0ms 起爆）
  // - 下/上各 35% 概率补充 1 点（~40% 时起爆）→ 每次 3~5 个起爆点
  // 方向性扩张速度：往上消散 > 左右消散 > 往下消散（等效距离 上×0.4/左右×1.0/下×1.8）
  // 幂函数蔓延 0.7：前沿先慢后快；花瓣状角度调制 → 扩散形状不规则（非圆形）
  const featherMs = 70; // 羽化软边时间带宽
  const maskScale = Math.max(0.18, Math.min(0.32, 120 / Math.max(w, 1))); // 目标宽 ~120px
  const mw = Math.max(8, Math.round(w * maskScale));
  const mh = Math.max(8, Math.round(h * maskScale));
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = mw;
  maskCanvas.height = mh;
  const mctx = maskCanvas.getContext("2d");
  if (!mctx) {
    finishEarly();
    return () => {};
  }
  const mimg = mctx.createImageData(mw, mh);
  const mpx32 = new Uint32Array(mimg.data.buffer); // 32 位写入，仅改最高字节(alpha)

  // 区域生成（每次播放重新生成 → 每次观感不同）
  const diag = Math.hypot(w, h);
  interface DissolveRegion { x: number; y: number; t0: number; scale: number }
  const regions: DissolveRegion[] = [];
  const makeRegion = (x: number, y: number, t0: number): DissolveRegion => ({
    x,
    y,
    t0,
    scale: 1.1 + Math.random() * 0.25,
  });
  // 下 1/3：必须随机某点（首批）
  regions.push(makeRegion(Math.random() * w, (2 / 3 + Math.random() / 3) * h, Math.random() * 60));
  // 上 1/3：随机 左 / 右 / 上 侧边缘发起（首批，贴在对应边缘上）
  const side = Math.random();
  if (side < 1 / 3) {
    regions.push(makeRegion(Math.random() * 30, (Math.random() / 3) * h, Math.random() * 60)); // 左侧边
  } else if (side < 2 / 3) {
    regions.push(makeRegion(w - Math.random() * 30, (Math.random() / 3) * h, Math.random() * 60)); // 右侧边
  } else {
    regions.push(makeRegion(Math.random() * w, Math.random() * 30, Math.random() * 60)); // 上侧边
  }
  // 中 1/3：必发 1 点（动画 40% 时起爆）
  regions.push(makeRegion(Math.random() * w, (1 / 3 + Math.random() / 3) * h, secondBatchAt + Math.random() * 120 - 60));
  // 补充起爆点（各 35% 概率，动画 40% 时）：下/上部各可能再多 1 点
  if (Math.random() < 0.35) {
    regions.push(makeRegion(Math.random() * w, (2 / 3 + Math.random() / 3) * h, secondBatchAt + Math.random() * 120 - 60));
  }
  if (Math.random() < 0.35) {
    regions.push(makeRegion(Math.random() * w, Math.random() * 30, secondBatchAt + Math.random() * 120 - 60));
  }
  const noisePhase = Math.random() * 100; // 噪声相位随机 → 每次前沿弯曲不同

  // 确定性值噪声
  const hash01 = (n: number): number => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const valueNoise = (x: number, y: number): number => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash01(ix + iy * 57.31);
    const b = hash01(ix + 1 + iy * 57.31);
    const c = hash01(ix + (iy + 1) * 57.31);
    const d = hash01(ix + 1 + (iy + 1) * 57.31);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  // 柔和弯曲：低频大缓弯 ＋ 高频小碎弯（幅度加大 → 前沿不规则、不圆滑）
  const gentleNoise = (nx: number, ny: number): number => {
    const q = (h - ny) / h;
    const amp = 0.4 + 0.6 * q;
    return amp * (
      80 * (valueNoise(nx * 0.004 + noisePhase, ny * 0.003) * 2 - 1) +
      50 * (valueNoise(nx * 0.009 + 7.3 + noisePhase, ny * 0.007 + 1.7) * 2 - 1) +
      26 * (valueNoise(nx * 0.035 + 3.1, ny * 0.022 + 4.2) * 2 - 1) +
      14 * (valueNoise(nx * 0.08 + 9.7, ny * 0.05 + 8.4) * 2 - 1)
    );
  };

  // 返回 CSS 坐标 (nx,ny) 的消散时刻
  const dissolveTimeAt = (nx: number, ny: number): number => {
    let best = Infinity;
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      const dx = nx - r.x;
      const dy = ny - r.y;
      // 方向性扩张：上×0.4（最快）、左右×1.0、下×1.8（最慢）
      let eff = Math.hypot(dx, dy * (dy < 0 ? 0.4 : 1.8));
      // 花瓣状角度调制 → 扩散形状不规则（非圆形）
      const theta = Math.atan2(dy, dx);
      const petal =
        1 +
        0.16 * Math.sin(theta * 3 + noisePhase) +
        0.11 * Math.sin(theta * 5 - noisePhase * 0.7 + 1.9) +
        0.07 * Math.sin(theta * 7 + noisePhase * 1.3 + 4.1);
      eff *= Math.max(0.4, petal);
      // 幂函数 0.7：dT/dr 随距离递减 → 前沿速度随扩散递增，消散先慢后快
      const Tsrc = r.t0 + Math.pow(eff / diag, 0.7) * wipe * r.scale;
      if (Tsrc < best) best = Tsrc;
    }
    let T = best + gentleNoise(nx, ny);
    if (T < 0) T = 0;
    else if (T > duration - featherMs) T = duration - featherMs;
    return T;
  };

  // 烘焙到蒙版分辨率
  const Tfield = new Float32Array(mw * mh);
  for (let my = 0; my < mh; my++) {
    const ny = (my + 0.5) / maskScale;
    for (let mx = 0; mx < mw; mx++) {
      const nx = (mx + 0.5) / maskScale;
      Tfield[my * mw + mx] = dissolveTimeAt(nx, ny);
    }
  }

  // ---- mask 裁切：把 T 场逐像素 alpha 渲染到蒙版 canvas，驱动便签平滑消散 ----
  const setMask = (url: string): void => {
    root.style.setProperty("-webkit-mask-image", `url("${url}")`);
    root.style.setProperty("mask-image", `url("${url}")`);
    root.style.setProperty("-webkit-mask-size", "100% 100%");
    root.style.setProperty("mask-size", "100% 100%");
    root.style.setProperty("-webkit-mask-repeat", "no-repeat");
    root.style.setProperty("mask-repeat", "no-repeat");
  };
  const renderMask = (age: number): void => {
    let p = 0;
    for (let i = 0; i < Tfield.length; i++) {
      const local = age - Tfield[i];
      let a = local / featherMs;
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      a = 1 - a; // dissolve：可见→消散
      mpx32[p++] = ((a * 255) & 0xff) << 24 | 0x00ffffff; // RGB 白 + alpha
    }
    mctx.putImageData(mimg, 0, 0);
  };
  // 蒙版替换：先解码（new Image onload）再 set，避免逐帧 dataURL 闪烁
  let lastMaskPush = -1;
  let maskSeq = 0;
  let lastAppliedSeq = 0;
  const pushMask = (age: number, force: boolean): void => {
    if (!force && age - lastMaskPush < 30) return; // ~30Hz 更新蒙版即可（羽化边缘平滑）
    lastMaskPush = age;
    renderMask(age);
    const url = maskCanvas.toDataURL();
    const seq = ++maskSeq;
    const im = new Image();
    im.onload = () => {
      if (endedLocal || seq < lastAppliedSeq) return;
      lastAppliedSeq = seq;
      setMask(url);
    };
    im.onerror = () => {
      /* 解码失败：保留上一帧 mask，最终由看门狗收尾 */
    };
    im.src = url;
  };

  // ---- 发射点网格：铺满整面，每个点在自身 T 时刻恰好生成一粒粒子 ----
  const emitSpacing = 3;
  const ecx = Math.max(2, Math.ceil(w / emitSpacing));
  const ecy = Math.max(2, Math.ceil(h / emitSpacing));
  const ecount = ecx * ecy;
  const emitX = new Float32Array(ecount);
  const emitY = new Float32Array(ecount);
  const emitT = new Float32Array(ecount);
  const emitDone = new Uint8Array(ecount);
  let ei = 0;
  let maxEmitT = 0;
  for (let iy = 0; iy < ecy; iy++) {
    for (let ix = 0; ix < ecx; ix++) {
      const nx = (ix + 0.5) * emitSpacing;
      const ny = (iy + 0.5) * emitSpacing;
      emitX[ei] = nx;
      emitY[ei] = ny;
      const T = dissolveTimeAt(nx, ny);
      emitT[ei] = T;
      if (T > maxEmitT) maxEmitT = T;
      ei++;
    }
  }
  // 发射点按 T 分桶（binSize ms）：帧循环只遍历已到时刻的桶
  const binSize = 20;
  const binCount = Math.ceil(maxEmitT / binSize) + 2;
  const binPts: number[][] = [];
  for (let b = 0; b < binCount; b++) binPts.push([]);
  for (let i = 0; i < ecount; i++) {
    let b = Math.floor(emitT[i] / binSize);
    if (b < 0) b = 0;
    else if (b >= binCount) b = binCount - 1;
    binPts[b].push(i);
  }

  // ---- 粒子池（SoA + swap-remove；初速度/加速度全粒子一致，等加速上升）----
  // 粒子数量（density）真正控制存活粒子数：peakAlive 占发射点总数的比例随 density 变化；
  // 发射点网格（ecount，极密）仅决定每个粒子的出生位置，不直接决定粒子数。
  const peakAlive = Math.round(ecount * (0.03 + 0.97 * density));
  const maxP = peakAlive + 1500;
  const px = new Float32Array(maxP);
  const py = new Float32Array(maxP);
  const pang = new Float32Array(maxP);
  const pv0 = new Float32Array(maxP);
  const pv1 = new Float32Array(maxP);
  const plife = new Float32Array(maxP);
  const page = new Float32Array(maxP);
  const psize = new Float32Array(maxP);
  const pseed = new Float32Array(maxP);
  const psway = new Float32Array(maxP);
  const pr = new Float32Array(maxP);
  const pg = new Float32Array(maxP);
  const pb = new Float32Array(maxP);
  const glData = new Float32Array(maxP * 7);
  let pcount = 0;

  // 在 (x,y) 生成一粒发光微粒；颜色采样自该生成区域的主题色。
  const spawn = (x: number, y: number, age: number): void => {
    if (pcount >= maxP) return;
    let life = 1300 + Math.random() * 500; // 1300~1800ms
    const fit = duration - age - 40;
    if (fit < 120) return;
    if (life > fit) life = fit;
    const i = pcount++;
    px[i] = x;
    py[i] = y;
    pang[i] = (Math.random() - 0.5) * ((110 * Math.PI) / 180); // 随机左右偏转 ±55°
    pv0[i] = 30; // 初速度相同（px/s，缓慢起飘）
    pv1[i] = 650; // 加速度相同（px/s²，明显加速）
    plife[i] = life;
    page[i] = 0;
    psize[i] = 1.8; // 亮核 1.8px
    pseed[i] = Math.random() * Math.PI * 2;
    psway[i] = (Math.random() - 0.5) * 20; // ±10 px/s 恒定向漂移
    const [r, g, b] = sampleThemeColor(x, y);
    pr[i] = r / 255; pg[i] = g / 255; pb[i] = b / 255;
  };

  // ---- 帧循环控制 ----
  let rafId = 0;
  let backupId = 0;
  let start = 0;
  let started = false;
  let prevNow = 0;
  let lastPaint = 0;
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
    // 本实例资源（rAF/计时器/WebGL context/canvas）必须无条件释放——
    // 若随代次守卫一起跳过，每次「关闭后 400ms 内呼出」都泄漏一个 WebGL canvas，
    // 多次后 GPU 内存累积会压垮渲染进程（崩溃页哭脸 + 白屏）。
    stopLoop();
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    // 代次守卫（仅保护便签本体样式）：若已启动新动画（glowGen 改变），本实例的
    // 延时清理作废，不再 blankRoot——否则会把正在播放的新动画便签裁掉/隐藏。
    if (myGen !== glowGen) return;
    blankRoot(root); // 保持“空画面”供下次呼出
    glowActive = false;
  };

  const frame = (now: number) => {
    if (endedLocal) return;
    if (!started) {
      started = true;
      start = now;
      prevNow = now;
    }
    const dt = Math.min(0.05, Math.max(0.001, (now - prevNow) / 1000));
    prevNow = now;
    const age = now - start;

    // ---- 推进 mask 消散 + 发射点按各自 T 时刻生成粒子 ----
    pushMask(age, false);
    // 动画后 50%：便签整体透明度 100% → 50% 淡出
    const fadeHalf = duration * 0.5;
    if (age > fadeHalf) {
      const p = Math.min(1, (age - fadeHalf) / fadeHalf);
      root.style.opacity = (1 - 0.5 * p).toFixed(3);
    }
    // 按粒子数量节流发射：density 越低，保留的发射点比例越小（整面均匀变稀）；
    // 配合上面的峰值上限 maxP，粒子数随 density 在 ≈1.5%~100% 区间近似线性变化。
    const keepProb = Math.max(0.015, density);
    const b1 = Math.min(binCount - 1, Math.floor(age / binSize));
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

    // ---- 粒子：物理更新 + GPU 单次 draw call 绘制（additive 辉光）----
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const globalFade = age > duration - 200 ? Math.max(0, (duration - age) / 200) : 1;
    let drawCount = 0;
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
      // 等加速上升：speed = v0 + a·t（初速度/加速度全部粒子一致）
      const speed = pv0[i] + pv1[i] * (a / 1000);
      const dx = Math.sin(pang[i]);
      const dy = -Math.cos(pang[i]); // 向上为负 y
      px[i] += (dx * speed + psway[i]) * dt;
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
    if (drawCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
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
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      stopLoop();
      try {
        onDone(); // 触发真正隐藏窗口
      } finally {
        window.setTimeout(cleanupAfterHide, 400);
      }
    }
  };

  const step = (now: number) => {
    lastPaint = now;
    frame(now);
    if (!endedLocal) rafId = requestAnimationFrame(step);
  };

  const beginLoop = (): void => {
    if (endedLocal) return;
    renderMask(0);
    setMask(maskCanvas.toDataURL());
    try {
      root.style.clipPath = "";
      root.style.boxShadow = "none";
      root.style.opacity = ""; // 清除可能残留的后半段淡出透明度，从 100% 开始
    } catch {
      /* ignore */
    }
    rafId = requestAnimationFrame(step);
    backupId = window.setInterval(() => {
      if (endedLocal) return;
      const now = performance.now();
      if (now - lastPaint > 60) {
        lastPaint = now;
        frame(now);
      }
    }, 40);
    // 看门狗：无论循环是否推进，到时强制收尾，杜绝卡死
    watchdog = window.setTimeout(() => {
      if (endedLocal) return;
      stopLoop();
      cleanupAfterHide();
      onDone();
    }, duration + 600);
  };

  // 颜色场就绪后再启动循环（纯色主题立即；背景图 ≤140ms 上限解码）
  buildColorField(root, w, h).then((f) => {
    if (endedLocal) return;
    field = f;
    beginLoop();
  });

  // 返回“立即中止”句柄（cancelGlowParticles 调用）：停帧、移除覆盖层、复原页面样式。
  return () => {
    stopLoop();
    restoreRoot(root);
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
  };
}
