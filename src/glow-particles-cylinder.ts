// 便签「旋柱消散」动画：画面水平居中的竖直中线为轴，便签卷成圆柱体绕轴旋转并粒子化消散。
// ----------------------------------------------------------------------------
// 触发：关闭窗口时播放（particle_mode = "cylinder" 时选用）。
// 呼出时不播放动画：直接复原便签显示（见 note.ts summoned 处理）。
//
// 视觉要点（对齐需求）：
// - **便签本体绕竖轴旋转**：CSS perspective + rotateY，约 2 圈，呈现圆柱体侧面旋转；
//   backface-visibility:hidden 让转到背面的部分隐没（圆柱实体感）；后段透明度淡出 → 消失。
// - **粒子从竖轴发散成圆柱**：粒子初始聚集在居中竖线（轴，半径 0），向径向（左右）发散到
//   圆柱表面半径 R，沿圆周分布并随轴旋转；透视投影（近大近亮 / 远小远暗）→ 粒子化的旋转圆柱。
// - **圆柱上下端对应便签顶 / 底边**：粒子轴向位置 y 均匀铺满 [0, h]，沿竖轴贯穿全高。
// - 颜色采样自主题色（粒子颜色 = 背景颜色），additive 叠加出辉光。
//
// 工程契约：复用粒子光效基础设施（WebGL 单次 draw call 点精灵 + 颜色场 + 代次守卫 + 看门狗）；
// cancelCylinderParticles() 立即中止（停帧+复原页面、不触发 onDone），供“呼出打断关闭”；
// 看门狗强制收尾，杜绝动画卡死导致窗口无法关闭。

let cylinderActive = false;
/** 动画代次：每次 runCylinder 启动 +1。上一轮动画遗留的延时清理凭此作废。 */
let cylinderGen = 0;

/** 当前动画的“立即中止”句柄。 */
let cancelCylinderFn: (() => void) | null = null;

/** 立即中止粒子动画并复原页面（呼出打断关闭时调用——不触发 onDone，窗口保持显示）。 */
export function cancelCylinderParticles(): void {
  const c = cancelCylinderFn;
  cancelCylinderFn = null;
  if (c) {
    c();
    return;
  }
  if (!cylinderActive) return;
  cylinderActive = false;
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) restoreRoot(root);
  document.querySelector(".glow-particles-canvas")?.remove();
}

/** 复原便签本体样式（裁剪 / mask / 透明度 / 阴影 / 旋转 / 背面显隐 还原）。 */
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
export function bumpCylinderGen(): void {
  cylinderGen++;
}

/** 请求播放「旋柱消散」关闭动画；onDone 在动画完全结束后调用（真正关闭窗口）。 */
export function requestCylinderDissolveClose(onDone: () => void, particleDensity = 50): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || cylinderActive) {
    onDone();
    return;
  }
  cylinderActive = true;
  let done = false;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  const safeDone = () => {
    if (done) return;
    done = true;
    cylinderActive = false;
    cancelCylinderFn = null;
    onDone();
  };
  const watchdog = window.setTimeout(safeDone, 5000);
  cancelCylinderFn = () => {
    if (aborted) return;
    aborted = true;
    window.clearTimeout(watchdog);
    if (stopRun) stopRun();
    done = true; // 阻止 onDone：finish() 不会被调用，窗口保持显示
    cylinderActive = false;
  };
  try {
    stopRun = runCylinder(root, particleDensity, () => {
      window.clearTimeout(watchdog);
      safeDone();
    });
  } catch (e) {
    console.error("旋柱消散动画异常:", e);
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
 * 播放一次旋柱消散动画：便签本体绕竖轴 rotateY 旋转 + 粒子从竖轴发散到圆周并绕轴透视旋转。
 */
function runCylinder(
  root: HTMLElement,
  particleDensity: number,
  onDone: () => void,
): () => void {
  const myGen = ++cylinderGen; // 本动画实例代次：作废上一轮遗留的延时清理
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;

  // ---- 时序参数（整体 ~2.2s：旋转 + 粒子发散 + 透明度淡出收尾）----
  const duration = 2200;

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
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("[cylinder] shader compile failed:", gl.getShaderInfoLog(sh));
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
    console.warn("[cylinder] program link failed:", gl.getProgramInfoLog(glProg));
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

  // ---- 圆柱几何参数 ----
  const cx = w / 2;                 // 竖直中轴（屏幕水平中心）
  const R = w * 0.46;               // 圆柱半径（地面径向，略小于半宽留边）
  const focal = R * 2.6;            // 透视焦距：近大远小
  const omega = (Math.PI * 2 * 2) / (duration / 1000); // 绕轴角速度：全程约 2 圈（rad/s）
  const growMs = 900;               // 粒子从轴发散到表面的时长

  // ---- 粒子池（SoA）：全部粒子预先分配并错峰出生，一次消散 ----
  const N = Math.round(6400 + density * 43000);
  const maxP = Math.max(N + 64, 256);
  const pth = new Float32Array(maxP);    // 当前圆周角 θ
  const pyAx = new Float32Array(maxP);   // 轴向位置（屏幕 y，0~h）
  const pbirth = new Float32Array(maxP); // 出生延迟（错峰从轴发散）
  const plife = new Float32Array(maxP);  // 寿命 ms
  const psize = new Float32Array(maxP);  // 基础像素尺寸
  const pseed = new Float32Array(maxP);  // 随机相位（微抖动）
  const pr = new Float32Array(maxP);
  const pg = new Float32Array(maxP);
  const pb = new Float32Array(maxP);
  const glData = new Float32Array(maxP * 7);
  for (let i = 0; i < N; i++) {
    pth[i] = Math.random() * Math.PI * 2;
    pyAx[i] = Math.random() * h;
    pbirth[i] = Math.random() * duration * 0.35; // 错峰出生
    plife[i] = 1200 + Math.random() * 700;
    psize[i] = 1.8;
    pseed[i] = Math.random() * Math.PI * 2;
    // 采样靠近轴的主题色（径向生长起点在轴上）
    const [r, g, b] = sampleThemeColor(cx + (Math.random() - 0.5) * w * 0.4, pyAx[i]);
    pr[i] = r / 255; pg[i] = g / 255; pb[i] = b / 255;
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
      canvas.remove();
    } catch {
      /* ignore */
    }
    if (myGen !== cylinderGen) return;
    blankRoot(root); // 保持“空画面”供下次呼出
    cylinderActive = false;
  };

  const frame = (now: number) => {
    if (endedLocal) return;
    if (!started) {
      started = true;
      start = now;
    }
    const age = now - start;

    // ---- 便签本体绕竖轴旋转（圆柱侧面）+ 后段淡出 ----
    const spinDeg = (age / duration) * 720; // 约 2 圈
    root.style.transform = `perspective(900px) rotateY(${spinDeg}deg)`;
    root.style.backfaceVisibility = "hidden";
    root.style.transition = "none";
    const fadeStart = duration * 0.55;
    if (age > fadeStart) {
      const p = Math.min(1, (age - fadeStart) / (duration - fadeStart));
      root.style.opacity = (1 - p).toFixed(3);
    }

    // ---- 粒子：从轴发散到圆周 + 绕轴旋转 + 透视投影 ----
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const globalFade = age > duration - 200 ? Math.max(0, (duration - age) / 200) : 1;
    let drawCount = 0;
    for (let i = 0; i < N; i++) {
      const a = age - pbirth[i];
      if (a < 0) continue; // 未出生
      const life = plife[i];
      const u = a / life;
      if (u >= 1) continue; // 已消亡
      const theta = pth[i] + omega * (age / 1000); // 随轴旋转（与便签 rotateY 同步）
      const grow = Math.min(1, a / growMs);         // 半径 0→R（从轴发散）
      const r = R * grow;
      const z = r * Math.cos(theta);                // 透视深度（朝观众为正）
      const s = focal / (focal - z);                // 近大远小
      const sx = cx + r * Math.sin(theta) * s;      // 屏幕 x（圆周投影）
      const sy = pyAx[i];                           // 轴向位置（沿竖轴）
      const fadeIn = Math.min(1, a / 120);          // 出生放大淡入
      const t = 1 - u;
      const alpha = fadeIn * t * t * globalFade;    // 末段 + 寿命淡出
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
    frame(now);
    if (!endedLocal) rafId = requestAnimationFrame(step);
  };

  const beginLoop = (): void => {
    if (endedLocal) return;
    // 首帧前先把便签切到旋转初始态，避免“静止一帧”突兀
    root.style.transform = "perspective(900px) rotateY(0deg)";
    root.style.backfaceVisibility = "hidden";
    root.style.transition = "none";
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
