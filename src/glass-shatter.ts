// 便签「玻璃碎裂」关闭动画（v2：玻璃层破碎，背景保持完整）
// ----------------------------------------------------------------------------
// 正确语义（用户澄清）：碎裂的是覆盖在便签之上的「玻璃层」，不是便签内容本身。
// - 便签内容（背景/文字）**全程保持完整、连续可见**：不裁空、不裂成方块；
// - 在便签之上盖一层「玻璃」：蜘蛛网式裂纹（冲击点 P 放射裂纹 + 两层环带，
//   模拟真实玻璃破碎的碎裂形态）；
// - 裂缝处产生**折射变形**：每块玻璃碎片把底层背景纹理做小幅位移重贴（半透明），
//   裂纹缝隙处透出完整便签 → 错位不连续 = 折射观感；裂纹边缘带亮线高光；
// - 冲击瞬间有短促亮闪；碎片几乎不动（仅裂缝微开）；末段玻璃层连同便签一起淡出。
// ----------------------------------------------------------------------------
// 触发：关闭窗口时播放（粒子风格 particle_mode = "glass" 时选用）。
// 呼出时不播放成形动画：直接复原便签显示（note.ts summoned → restoreGlassSummoned）。
//
// 工程契约：rAF + 备份定时器帧驱动（备份路径不得调度 rAF）、看门狗强制收尾、
//   cancel 停帧+复原页面且不触发 onDone、代次守卫防 cleanupAfterHide 误裁新呼出的便签。

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

/** 呼出复原（玻璃模式无成形动画）：清残留样式 + 作废上一轮关闭动画的延时清理 + 移除画布。 */
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

/** 在便签分辨率重建背景纹理（底色 + 背景图 cover + 面板调色），供玻璃折射位移重贴。 */
function buildBgTexture(root: HTMLElement, w: number, h: number): Promise<HTMLCanvasElement | null> {
  const c = document.createElement("canvas");
  c.width = Math.max(8, Math.round(w));
  c.height = Math.max(8, Math.round(h));
  const ctx2 = c.getContext("2d");
  if (!ctx2) return Promise.resolve(null);
  const cs = getComputedStyle(root);
  const bgColor = cs.backgroundColor || "rgb(128,128,128)";
  let panelAlpha = parseFloat(cs.getPropertyValue("--note-panel-alpha"));
  if (!isFinite(panelAlpha) || panelAlpha <= 0 || panelAlpha > 1) panelAlpha = 0.7;
  const m = cs.getPropertyValue("--note-bg-img").match(/url\((['"]?)([\s\S]*?)\1\)/);
  const dataUrl = m ? m[2] : "";
  const fillSolid = (): void => {
    ctx2.fillStyle = bgColor;
    ctx2.fillRect(0, 0, w, h);
  };
  if (!dataUrl) {
    fillSolid();
    return Promise.resolve(c);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (img: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      if (img && img.naturalWidth > 0) {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const ir = iw / ih, fr = w / h;
        let dw: number, dh: number, dx: number, dy: number;
        if (ir > fr) {
          dh = h; dw = h * ir; dx = (w - dw) / 2; dy = 0;
        } else {
          dw = w; dh = w / ir; dx = 0; dy = (h - dh) / 2;
        }
        ctx2.fillStyle = bgColor;
        ctx2.fillRect(0, 0, w, h);
        ctx2.drawImage(img, dx, dy, dw, dh);
        ctx2.globalAlpha = panelAlpha * 0.15;
        ctx2.fillStyle = bgColor;
        ctx2.fillRect(0, 0, w, h);
        ctx2.globalAlpha = 1;
      } else {
        fillSolid();
      }
      resolve(c);
    };
    const img = new Image();
    const timer = window.setTimeout(() => finish(null), 140);
    img.onload = () => {
      window.clearTimeout(timer);
      finish(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      finish(null);
    };
    img.src = dataUrl;
  });
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
  const impactMs = Math.round(150 * k); // 冲击亮闪时长
  const wipe = Math.round(1250 * k); // 玻璃层可见主体时长
  const duration = wipe + Math.round(260 * k); // 总时长（含收尾余量）

  // ---- 覆盖层 canvas（2D，画在便签窗口内、内容之上，zIndex 置顶）----
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

  // ---- 背景纹理（折射位移重贴用；便签内容本身始终可见）----
  let bgTex: HTMLCanvasElement | null = null;

  // ---- 玻璃破碎形态：蜘蛛网式（冲击点 P 放射裂纹 + 两层环带）----
  const px = w * (0.3 + Math.random() * 0.4);
  const py = h * (0.3 + Math.random() * 0.4);
  const rayCount = 8 + Math.round(density * 4); // 8~12 条放射裂纹
  const R = 2; // 环带层数
  const ringFrac = [0.34, 0.66]; // 环带比例（中心到边界）
  const ringPts: { x: number; y: number }[][] = []; // ringPts[i][k]：第 i 条射线第 k 层环带点
  const rayEnd: { x: number; y: number }[] = []; // 第 i 条射线与矩形边界交点
  for (let i = 0; i < rayCount; i++) {
    const step = (Math.PI * 2) / rayCount;
    const th = i * step + (Math.random() - 0.5) * step * 0.55; // 角度抖动
    const cxs = Math.cos(th), sn = Math.sin(th);
    let tMax = Infinity;
    if (cxs > 0.0001) tMax = Math.min(tMax, (w - px) / cxs);
    else if (cxs < -0.0001) tMax = Math.min(tMax, -px / cxs);
    if (sn > 0.0001) tMax = Math.min(tMax, (h - py) / sn);
    else if (sn < -0.0001) tMax = Math.min(tMax, -py / sn);
    const row: { x: number; y: number }[] = [];
    for (let kk = 0; kk < R; kk++) {
      const f = ringFrac[kk] * (0.9 + Math.random() * 0.2);
      const rr = Math.max(6, tMax * f + (Math.random() - 0.5) * tMax * 0.06);
      const jt = (Math.random() - 0.5) * step * 0.35; // 切向抖动
      row.push({ x: px + Math.cos(th + jt) * rr, y: py + Math.sin(th + jt) * rr });
    }
    ringPts.push(row);
    rayEnd.push({ x: px + Math.cos(th) * (tMax + (Math.random() - 0.5) * 4), y: py + Math.sin(th) * (tMax + (Math.random() - 0.5) * 4) });
  }
  // 统一顶点表：0=冲击点，随后 射线×环带 点，最后 边界点
  const allPts: { x: number; y: number }[] = [{ x: px, y: py }];
  for (let i = 0; i < rayCount; i++) {
    for (let kk = 0; kk < R; kk++) allPts.push(ringPts[i][kk]);
  }
  const boundStart = allPts.length;
  for (let i = 0; i < rayCount; i++) allPts.push(rayEnd[i]);
  const ringIdx = (i: number, kk: number): number => 1 + (i % rayCount) * R + kk;
  const boundIdx = (i: number): number => boundStart + (i % rayCount);

  // 玻璃碎片（蜘蛛网单元：中心三角 + 环带四边形 + 外沿四边形）
  interface Cell {
    idx: number[]; // allPts 顶点索引
    sx: number; sy: number; // 裂缝开合位移（当前）
    vx: number; vy: number; // 位移速度（微开，快速停）
    rx: number; ry: number; // 折射位移（纹理重贴偏移）
  }
  const cells: Cell[] = [];
  const mkCell = (idx: number[]): void => {
    let cx = 0, cy = 0;
    for (const ii of idx) {
      cx += allPts[ii].x;
      cy += allPts[ii].y;
    }
    cx /= idx.length;
    cy /= idx.length;
    const ddx = cx - px, ddy = cy - py;
    const dl = Math.hypot(ddx, ddy) || 1;
    const mag = 1.2 + Math.random() * 2.2; // 折射位移 1.2~3.4px
    const tan = (Math.random() - 0.5) * 0.7;
    const open = 3 + Math.random() * 5; // 裂缝微开速度
    cells.push({
      idx,
      sx: 0, sy: 0,
      vx: (ddx / dl) * open + (-ddy / dl) * tan * open,
      vy: (ddy / dl) * open + (ddx / dl) * tan * open,
      rx: (ddx / dl) * mag + (-ddy / dl) * tan * mag,
      ry: (ddy / dl) * mag + (ddx / dl) * tan * mag,
    });
  };
  for (let i = 0; i < rayCount; i++) {
    const ni = (i + 1) % rayCount;
    mkCell([0, ringIdx(i, 0), ringIdx(ni, 0)]); // 中心三角
    mkCell([ringIdx(i, 0), ringIdx(i, 1), ringIdx(ni, 1), ringIdx(ni, 0)]); // 环带四边形
    mkCell([ringIdx(i, 1), ringIdx(ni, 1), boundIdx(ni), boundIdx(i)]); // 外沿四边形
  }
  // 裂纹线段（绘制亮线用）：放射裂纹（P→环0→环1→边界）+ 环带裂纹
  const segs: [number, number][] = [];
  for (let i = 0; i < rayCount; i++) {
    const ni = (i + 1) % rayCount;
    segs.push([0, ringIdx(i, 0)]);
    segs.push([ringIdx(i, 0), ringIdx(i, 1)]);
    segs.push([ringIdx(i, 1), boundIdx(i)]);
    for (let kk = 0; kk < R; kk++) segs.push([ringIdx(i, kk), ringIdx(ni, kk)]);
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

    // 末段整体渐渐淡出（玻璃层 → 渐隐）：smoothstep 缓出
    const fadeStart = wipe * 0.3;
    let glassAlpha = 1;
    if (age > fadeStart) {
      const t = Math.min(1, (age - fadeStart) / Math.max(1, duration - fadeStart));
      glassAlpha = Math.max(0, 1 - t * t * (3 - 2 * t));
    }

    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = glassAlpha;

    // ---- 玻璃碎片：半透明折射贴片（背景纹理位移重贴 → 裂缝处错位 = 折射）----
    for (const cl of cells) {
      cl.sx += cl.vx * dt;
      cl.sy += cl.vy * dt;
      cl.vx *= 1 - 4 * dt;
      cl.vy *= 1 - 4 * dt;
      ctx.save();
      ctx.translate(cl.sx, cl.sy); // 裂缝微开
      ctx.beginPath();
      ctx.moveTo(allPts[cl.idx[0]].x, allPts[cl.idx[0]].y);
      for (let q = 1; q < cl.idx.length; q++) ctx.lineTo(allPts[cl.idx[q]].x, allPts[cl.idx[q]].y);
      ctx.closePath();
      ctx.clip();
      if (bgTex) {
        // 折射：纹理位移重贴（半透明 → 底下完整便签透出）
        ctx.globalAlpha = glassAlpha * 0.4;
        ctx.drawImage(bgTex, cl.rx, cl.ry);
        ctx.globalAlpha = glassAlpha;
      }
      // 玻璃极淡冷色调
      ctx.fillStyle = "rgba(206,224,250,0.05)";
      ctx.fill();
      ctx.restore();
    }

    // ---- 裂纹亮线（玻璃边缘受光）----
    if (glassAlpha > 0.01) {
      ctx.strokeStyle = `rgba(255,255,255,${(0.5 * glassAlpha).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (const [a, b] of segs) {
        ctx.moveTo(allPts[a].x, allPts[a].y);
        ctx.lineTo(allPts[b].x, allPts[b].y);
      }
      ctx.stroke();
    }

    // ---- 冲击瞬间亮闪（冲击点放射短光线，快速消失）----
    if (age < impactMs) {
      const t = age / impactMs;
      ctx.strokeStyle = `rgba(255,255,255,${((1 - t) * 0.6).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < rayCount; i++) {
        const f = 0.28 + t * 0.16;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + (rayEnd[i].x - px) * f, py + (rayEnd[i].y - py) * f);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // ---- 便签本体末段一起淡出（关闭收尾）----
    const noteFadeStart = wipe * 0.7;
    if (age > noteFadeStart) {
      const t = Math.min(1, (age - noteFadeStart) / Math.max(1, duration - noteFadeStart));
      root.style.opacity = Math.max(0, 1 - t * t * (3 - 2 * t)).toFixed(3);
    }

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

  // 背景纹理就绪后再启动（底色立即；背景图 ≤140ms 上限解码）。
  // 便签内容不裁空：玻璃只是盖在上面的一层，背景全程完整可见。
  buildBgTexture(root, w, h).then((tex) => {
    if (endedLocal) return;
    bgTex = tex;
    try {
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
