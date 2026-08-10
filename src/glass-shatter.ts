// 便签「玻璃碎裂」关闭动画：便签瞬间碎裂成玻璃碎块（抖动网格三角化），
// 碎块向四周飞散、自旋、轻微下落，末段整体渐渐淡出（碎裂 → 渐隐）。
// ----------------------------------------------------------------------------
// 触发：关闭窗口时播放（粒子风格 particle_mode = "glass" 时选用）。
// 呼出时不播放成形动画：直接复原便签显示（见 note.ts summoned 处理 → restoreGlassSummoned）。
//
// 实现要点：
// - 便签本体在动画真正开始（颜色场就绪）时才裁空（clip-path inset 全裁），碎块接管画面；
// - 碎块 = 抖动网格三角化（每格 2 个三角形），颜色采样自便签「区域颜色场」
//   （复用 glow-particles.ts 的 buildColorField，含背景图 cover 取色）；
// - 碎块运动：从便签中心向外飞散（外圈更快）+ 空气阻力减速 + 自旋 + 轻微重力 + 末段整体淡出；
// - 玻璃质感：碎块半透明白描边（碎裂边缘高光）；
// - 工程契约：rAF + 备份定时器帧驱动（备份路径不得调度 rAF）、看门狗强制收尾、
//   cancel 停帧+复原页面且不触发 onDone、代次守卫防 cleanupAfterHide 误裁新呼出的便签。

import { buildColorField, type ColorField } from "./glow-particles";

let glassActive = false;
/** 动画代次：每次 runGlass 启动 +1。上一轮遗留的延时清理（cleanupAfterHide）凭此作废，
 *  避免快速呼出时把正在播放/刚复原的新便签再次裁空。 */
let glassGen = 0;
/** 当前玻璃动画的“立即中止”句柄（由 runGlass 注册；cancelGlassShards 调用）。
 *  中止 = 停帧 + 复原页面（保持可见，供“呼出打断关闭”等快速切换）。 */
let cancelGlassFn: (() => void) | null = null;

/** 立即中止玻璃动画并复原页面（关闭动画开始前/呼出打断关闭时调用，不触发 onDone）。 */
export function cancelGlassShards(): void {
  const c = cancelGlassFn;
  cancelGlassFn = null;
  if (c) {
    c();
    return;
  }
  // 兜底：无注册句柄时（理论不会出现）直接复原
  if (!glassActive) return;
  glassActive = false;
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) restoreRoot(root);
  document.querySelectorAll(".glass-canvas").forEach((el) => el.remove());
}

/** 作废上一轮玻璃动画遗留的延时清理（呼出时调用）。 */
export function bumpGlassGen(): void {
  glassGen++;
}

/** 复原便签本体样式（裁剪 / mask / 透明度 / 阴影全部还原）。 */
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

/** 隐藏便签本体（保持"空画面"，供下次呼出直接复原显示）。 */
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

/** 呼出复原（玻璃模式无成形动画）：清残留空画面样式 + 作废上一轮关闭动画的延时清理 + 移除画布。 */
export function restoreGlassSummoned(): void {
  bumpGlassGen();
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) restoreRoot(root);
  document.querySelectorAll(".glass-canvas").forEach((el) => el.remove());
}

/** 请求播放「玻璃碎裂」关闭动画；onDone 在动画完全结束后调用（用于真正关闭窗口）。
 * speed：动画速度百分比（100=原速），所有时序按 100/speed 缩放。 */
export function requestGlassShardsClose(onDone: () => void, particleDensity = 50, speed = 100): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || glassActive) {
    onDone();
    return;
  }
  glassActive = true;
  let done = false;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  const safeDone = () => {
    if (done) return;
    done = true;
    glassActive = false;
    cancelGlassFn = null;
    onDone();
  };
  const watchdog = window.setTimeout(safeDone, Math.round(4000 * Math.max(0.25, Math.min(4, 100 / Math.max(10, speed)))));
  cancelGlassFn = () => {
    if (aborted) return;
    aborted = true;
    window.clearTimeout(watchdog);
    if (stopRun) stopRun();
    done = true; // 阻止 onDone：finish() 不会被调用，窗口保持显示
    glassActive = false;
  };
  try {
    stopRun = runGlass(root, particleDensity, speed, () => {
      window.clearTimeout(watchdog);
      safeDone();
    });
  } catch (e) {
    console.error("玻璃碎裂动画异常:", e);
    window.clearTimeout(watchdog);
    safeDone();
  }
}

/** 播放一次玻璃碎裂动画。 */
function runGlass(
  root: HTMLElement,
  particleDensity: number,
  speed: number,
  onDone: () => void,
): () => void {
  const myGen = ++glassGen; // 本动画实例代次：作废上一轮遗留的延时清理
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const k = Math.max(0.25, Math.min(4, 100 / Math.max(10, speed))); // 速度系数：200%→0.5（时长减半）
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;

  // ---- 时序 ----
  const wipe = Math.round(1250 * k); // 碎裂飞散主体时长 ms
  const duration = wipe + Math.round(280 * k); // 总时长（含收尾余量）

  // ---- 覆盖层 canvas（2D，画在便签窗口内，zIndex 置顶）----
  const canvas = document.createElement("canvas");
  canvas.className = "glass-canvas";
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
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    finishEarly();
    return () => {};
  }
  ctx.scale(dpr, dpr);

  // ---- 颜色场（异步构建；之后按碎块质心采样，碎块 = 便签表面颜色 = 玻璃色）----
  let field: ColorField | null = null;
  const sampleColor = (x: number, y: number): [number, number, number] => {
    if (!field || field.data.length < 4) return [225, 232, 245];
    let fx = Math.round((x / w) * field.fw);
    if (fx < 0) fx = 0;
    else if (fx >= field.fw) fx = field.fw - 1;
    let fy = Math.round((y / h) * field.fh);
    if (fy < 0) fy = 0;
    else if (fy >= field.fh) fy = field.fh - 1;
    const idx = (fy * field.fw + fx) * 4;
    const r = field.data[idx], g = field.data[idx + 1], b = field.data[idx + 2];
    const max = Math.max(r, g, b);
    if (!isFinite(max)) return [225, 232, 245];
    if (max >= 150) return [r, g, b];
    const f = 150 / Math.max(1, max);
    return [Math.min(255, r * f), Math.min(255, g * f), Math.min(255, b * f)];
  };

  // ---- 碎块生成：抖动网格三角化（每格 2 个三角形 = 2 块玻璃）----
  // 密度越高格子越小、碎块越多（46~96px 格子）；碎块颜色 = 质心处便签表面颜色
  const cell = Math.max(46, 96 - 40 * density);
  const cols = Math.max(4, Math.round(w / cell));
  const rows = Math.max(3, Math.round(h / cell));
  const gw = w / cols, gh = h / rows;
  interface Shard {
    ax: number; ay: number; bx: number; by: number; cx2: number; cy2: number;
    cx: number; cy: number; // 质心（= 当前绘制位置）
    vx: number; vy: number; vr: number; rot: number;
  }
  const shards: Shard[] = [];
  const vx = new Float32Array((cols + 1) * (rows + 1));
  const vy = new Float32Array((cols + 1) * (rows + 1));
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const idx = j * (cols + 1) + i;
      // 内部顶点抖动（±35% 格宽）→ 碎裂不规则；边缘顶点不抖（保持外轮廓）
      const jx = (i === 0 || i === cols) ? 0 : (Math.random() - 0.5) * gw * 0.7;
      const jy = (j === 0 || j === rows) ? 0 : (Math.random() - 0.5) * gh * 0.7;
      vx[idx] = i * gw + jx;
      vy[idx] = j * gh + jy;
    }
  }
  const halfDiag = Math.hypot(w, h) * 0.5; // 归一化飞散速度用
  const pushTri = (a: number, b: number, c: number): void => {
    const ax = vx[a], ay = vy[a], bx = vx[b], by = vy[b], cx2 = vx[c], cy2 = vy[c];
    const cx = (ax + bx + cx2) / 3, cy = (ay + by + cy2) / 3;
    // 从便签中心向外飞散：外圈更快；方向加随机切向抖动
    const dx = cx - w / 2, dy = cy - h / 2;
    const dist = Math.hypot(dx, dy) || 1;
    const speedBase = (26 + Math.random() * 80) * (0.55 + 0.95 * Math.min(1, dist / halfDiag));
    const jitter = (Math.random() - 0.5) * 0.8;
    shards.push({
      ax, ay, bx, by, cx2, cy2, cx, cy,
      vx: (dx / dist) * speedBase + (-dy / dist) * jitter * speedBase,
      vy: (dy / dist) * speedBase + (dx / dist) * jitter * speedBase,
      vr: (Math.random() - 0.5) * 5.5, // 自旋
      rot: Math.random() * Math.PI * 2,
    });
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      pushTri(a, b, c);
      pushTri(b, d, c);
    }
  }

  // ---- 帧循环控制 ----
  let rafId = 0;
  let backupId = 0;
  let start = 0;
  let started = false;
  let lastPaint = 0;
  let endedLocal = false;
  let watchdog2 = 0;

  const stopLoop = (): void => {
    endedLocal = true;
    cancelAnimationFrame(rafId);
    if (backupId) {
      window.clearInterval(backupId);
      backupId = 0;
    }
    if (watchdog2) {
      window.clearTimeout(watchdog2);
      watchdog2 = 0;
    }
  };

  const cleanupAfterHide = (): void => {
    stopLoop();
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    // 代次守卫（仅保护便签本体样式）：若已启动新动画（glassGen 改变），本实例的
    // 延时清理作废，不再 blankRoot——否则会把刚呼出并已复原的便签再次裁空。
    if (myGen !== glassGen) return;
    blankRoot(root); // 保持"空画面"供下次呼出
    glassActive = false;
  };

  function finishEarly(): void {
    stopLoop();
    try {
      canvas.remove();
    } catch {
      /* ignore */
    }
    if (myGen !== glassGen) return;
    blankRoot(root);
    onDone();
  }

  const frame = (now: number): void => {
    if (endedLocal) return;
    if (!started) {
      started = true;
      start = now;
      lastPaint = now;
    }
    const age = now - start;
    const dt = Math.min(0.05, Math.max(0.001, (now - lastPaint) / 1000));
    lastPaint = now;

    ctx.clearRect(0, 0, w, h);
    // 末段整体渐渐淡出（碎裂 → 渐隐）
    const fadeStart = wipe * 0.45;
    let globalAlpha = 1;
    if (age > fadeStart) {
      globalAlpha = Math.max(0, 1 - (age - fadeStart) / Math.max(1, duration - fadeStart));
    }
    ctx.globalAlpha = globalAlpha;
    for (let i = 0; i < shards.length; i++) {
      const s = shards[i];
      // 空气阻力减速（越飘越轻）+ 轻微重力下落
      s.vx *= 1 - 0.85 * dt;
      s.vy = s.vy * (1 - 0.55 * dt) + 60 * dt;
      s.cx += s.vx * dt;
      s.cy += s.vy * dt;
      s.rot += s.vr * dt;
      // 以质心为轴旋转绘制
      ctx.save();
      ctx.translate(s.cx, s.cy);
      ctx.rotate(s.rot);
      ctx.beginPath();
      ctx.moveTo(s.ax - s.cx, s.ay - s.cy);
      ctx.lineTo(s.bx - s.cx, s.by - s.cy);
      ctx.lineTo(s.cx2 - s.cx, s.cy2 - s.cy);
      ctx.closePath();
      const [r, g, b] = sampleColor(s.cx, s.cy);
      ctx.fillStyle = `rgba(${r},${g},${b},0.9)`;
      ctx.fill();
      // 玻璃碎裂边缘高光
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.38)";
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (age >= duration) {
      stopLoop();
      onDone(); // 触发真正隐藏窗口
      window.setTimeout(cleanupAfterHide, 400);
    }
  };

  const step = (now: number): void => {
    lastPaint = now;
    frame(now);
    if (!endedLocal) rafId = requestAnimationFrame(step);
  };

  // 颜色场就绪后再启动循环（纯色主题立即；背景图 ≤140ms 上限解码）；
  // 启动时才裁空便签本体（避免颜色场未就绪时出现"内容消失、碎块未出"的空白闪帧）
  buildColorField(root, w, h).then((f) => {
    if (endedLocal) return;
    field = f;
    try {
      root.style.clipPath = "inset(0 0 100% 0)";
      root.style.boxShadow = "none";
      root.style.opacity = "";
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
    watchdog2 = window.setTimeout(() => {
      if (endedLocal) return;
      stopLoop();
      cleanupAfterHide();
      onDone();
    }, duration + 600);
  });

  // 返回"立即中止"句柄（cancelGlassShards 调用）：停帧、复原页面、移除覆盖层。
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
