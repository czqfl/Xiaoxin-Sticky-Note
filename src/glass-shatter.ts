// 便签「玻璃碎裂」关闭动画（v3：玻璃层破碎 + 折射，裂纹去规律化、细节丰富）
// ----------------------------------------------------------------------------
// 核心语义（用户澄清）：碎裂的是覆盖在便签之上的「玻璃层」，便签内容全程完整可见。
// - 玻璃层=不规则裂纹网：簇状主裂纹（角度分组聚簇、部分中途截止）+ 随机环带（2~3 层、
//   比例随机、虚线断开=不闭合感）+ 递归分支裂缝（2~3 级、逐级变细变短）+ 毛刺抖动折线；
// - 裂缝细节：宽窄/透明度随距冲击点渐细渐淡、断续间隙、明暗双描边（偏移暗影 + 亮线）；
// - 质感层次：玻璃斜向高光渐变、裂纹粉尘颗粒（沿裂缝预生成）、冲击瞬间细小碎屑飞散 + 亮闪；
// - 裂缝处折射：每块玻璃碎片把背景纹理做位移重贴（半透明），位移量越靠近冲击点越大。
// ----------------------------------------------------------------------------
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
  const halfDiag = Math.hypot(w, h) * 0.5;

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

  // ================= 玻璃破碎形态生成（烘焙一次，静态） =================
  // 冲击点（可偏边）
  const px = w * (0.25 + Math.random() * 0.5);
  const py = h * (0.25 + Math.random() * 0.5);
  // 主裂纹：角度分组聚簇（打破等角/对称）
  const mainCount = 7 + Math.round(density * 5); // 7~12 条
  const anchorCount = 3 + Math.floor(Math.random() * 2); // 3~4 个角度簇锚点
  const anchors: number[] = [];
  for (let g = 0; g < anchorCount; g++) anchors.push(Math.random() * Math.PI * 2);
  interface Polyline { pts: { x: number; y: number }[]; wMul: number; aMul: number }
  const mainPolys: Polyline[] = [];
  const allPolyPoints: { x: number; y: number }[] = []; // 供粉尘/碎屑撒点
  const dirArr: { x: number; y: number }[] = [];
  const tMaxArr: number[] = [];
  const lenArr: number[] = [];
  for (let i = 0; i < mainCount; i++) {
    const th = anchors[Math.floor(Math.random() * anchorCount)] + (Math.random() - 0.5) * 0.95;
    const dirx = Math.cos(th), diry = Math.sin(th);
    let tMax = Infinity;
    if (dirx > 0.0001) tMax = Math.min(tMax, (w - px) / dirx);
    else if (dirx < -0.0001) tMax = Math.min(tMax, -px / dirx);
    if (diry > 0.0001) tMax = Math.min(tMax, (h - py) / diry);
    else if (diry < -0.0001) tMax = Math.min(tMax, -py / diry);
    const len = tMax * (0.45 + Math.random() * 0.55); // 部分中途截止（45%~100%）
    // 折线化（毛刺/锯齿）：2~4 段 + 垂直抖动
    const segN = 2 + Math.floor(Math.random() * 3);
    const jamp = Math.min(7, len * 0.08);
    const pts: { x: number; y: number }[] = [];
    for (let s = 0; s <= segN; s++) {
      const t = s / segN;
      const jx = (s > 0 && s < segN ? (Math.random() - 0.5) * jamp : 0);
      pts.push({
        x: px + dirx * len * t + -diry * jx,
        y: py + diry * len * t + dirx * jx,
      });
    }
    mainPolys.push({ pts, wMul: 1, aMul: 1 });
    allPolyPoints.push(...pts);
    dirArr.push({ x: dirx, y: diry });
    tMaxArr.push(tMax);
    lenArr.push(len);
  }
  // 分支裂缝（2~3 级，逐级变细变短）
  const branchPolys: Polyline[] = [];
  const pointOnPoly = (poly: Polyline, t: number): { x: number; y: number } => {
    const n = poly.pts.length - 1;
    const f = t * n;
    const i0 = Math.min(n - 1, Math.floor(f));
    const a = poly.pts[i0], b = poly.pts[i0 + 1];
    const u = f - i0;
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  };
  const totalBranchLen = (poly: Polyline): number => {
    let L = 0;
    for (let s = 0; s < poly.pts.length - 1; s++) L += Math.hypot(poly.pts[s + 1].x - poly.pts[s].x, poly.pts[s + 1].y - poly.pts[s].y);
    return L;
  };
  for (let i = 0; i < mainCount; i++) {
    const poly = mainPolys[i];
    const parentLen = totalBranchLen(poly);
    const th = Math.atan2(poly.pts[poly.pts.length - 1].y - poly.pts[0].y, poly.pts[poly.pts.length - 1].x - poly.pts[0].x);
    const nb = Math.random() < 0.75 ? 1 + Math.floor(Math.random() * 2) : 0;
    for (let b = 0; b < nb; b++) {
      const t0 = 0.15 + Math.random() * 0.55;
      const base = pointOnPoly(poly, t0);
      const sign = Math.random() < 0.5 ? -1 : 1;
      const bAng = th + sign * (0.5 + Math.random() * 0.75); // 与父裂纹夹角 30°~75°
      const bLen = parentLen * (0.2 + Math.random() * 0.3);
      const bSegN = 2;
      const bPts: { x: number; y: number }[] = [];
      const bjamp = Math.min(5, bLen * 0.1);
      for (let s = 0; s <= bSegN; s++) {
        const t = s / bSegN;
        const jx = (s > 0 && s < bSegN ? (Math.random() - 0.5) * bjamp : 0);
        bPts.push({
          x: base.x + Math.cos(bAng) * bLen * t + -Math.sin(bAng) * jx,
          y: base.y + Math.sin(bAng) * bLen * t + Math.cos(bAng) * jx,
        });
      }
      branchPolys.push({ pts: bPts, wMul: 0.6, aMul: 0.85 });
      allPolyPoints.push(...bPts);
      // 三级分支（30% 概率，从分支中点再分）
      if (Math.random() < 0.3 && bLen > 26) {
        const c0 = 0.5;
        const cbase = pointOnPoly({ pts: bPts, wMul: 1, aMul: 1 }, c0);
        const cAng = bAng + (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.6);
        const cLen = bLen * (0.4 + Math.random() * 0.25);
        const cPts = [
          { x: cbase.x, y: cbase.y },
          { x: cbase.x + Math.cos(cAng) * cLen * 0.6 + -Math.sin(cAng) * (Math.random() - 0.5) * 3, y: cbase.y + Math.sin(cAng) * cLen * 0.6 + Math.cos(cAng) * (Math.random() - 0.5) * 3 },
          { x: cbase.x + Math.cos(cAng) * cLen, y: cbase.y + Math.sin(cAng) * cLen },
        ];
        branchPolys.push({ pts: cPts, wMul: 0.4, aMul: 0.7 });
        allPolyPoints.push(...cPts);
      }
    }
  }
  // 环带裂纹：2~3 层、比例随机、虚线断开（不闭合感）
  const R = 2 + (Math.random() < 0.4 ? 1 : 0);
  const fR: number[] = [];
  for (let kk = 0; kk < R; kk++) fR.push(0.22 + Math.random() * 0.5);
  fR.sort((a, b) => a - b);
  const ringPolys: Polyline[] = [];
  for (let kk = 0; kk < R; kk++) {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < mainCount; i++) {
      const rr = tMaxArr[i] * fR[kk] + (Math.random() - 0.5) * Math.min(8, tMaxArr[i] * 0.05);
      pts.push({ x: px + dirArr[i].x * rr, y: py + dirArr[i].y * rr });
    }
    pts.push({ ...pts[0] }); // 闭合
    ringPolys.push({ pts, wMul: 1, aMul: 1 });
    allPolyPoints.push(...pts);
  }
  // 二次冲击（30% 概率）：另一处小裂纹丛 + 碎屑
  const secondImp = Math.random() < 0.3;
  const p2 = secondImp
    ? { x: px + (Math.random() - 0.5) * w * 0.6, y: py + (Math.random() - 0.5) * h * 0.6 }
    : null;
  if (p2) {
    const secN = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < secN; i++) {
      const th = Math.random() * Math.PI * 2;
      const dx2 = Math.cos(th), dy2 = Math.sin(th);
      let tM = Infinity;
      if (dx2 > 0.0001) tM = Math.min(tM, (w - p2.x) / dx2);
      else if (dx2 < -0.0001) tM = Math.min(tM, -p2.x / dx2);
      if (dy2 > 0.0001) tM = Math.min(tM, (h - p2.y) / dy2);
      else if (dy2 < -0.0001) tM = Math.min(tM, -p2.y / dy2);
      const L = tM * (0.25 + Math.random() * 0.3);
      const pts = [
        { x: p2.x, y: p2.y },
        { x: p2.x + dx2 * L * 0.6 + -dy2 * (Math.random() - 0.5) * 4, y: p2.y + dy2 * L * 0.6 + dx2 * (Math.random() - 0.5) * 4 },
        { x: p2.x + dx2 * L, y: p2.y + dy2 * L },
      ];
      branchPolys.push({ pts, wMul: 0.5, aMul: 0.75 });
      allPolyPoints.push(...pts);
    }
  }

  // ---- 裂纹线段（带属性：宽/透明度，随距冲击点渐细渐淡）----
  interface CrackSeg { x1: number; y1: number; x2: number; y2: number; w: number; alpha: number }
  const segs: CrackSeg[] = [];
  const pushPolySegs = (poly: Polyline, taper: boolean, dashProb: number): void => {
    const n = poly.pts.length - 1;
    for (let s = 0; s < n; s++) {
      if (dashProb > 0 && Math.random() < dashProb) continue; // 断续
      const t = n > 1 ? s / (n - 1) : 0;
      const w = (taper ? 1.9 - 1.15 * t : 1.35) * poly.wMul * (0.8 + Math.random() * 0.45);
      const alpha = Math.min(0.72, (taper ? 0.62 - 0.36 * t : 0.42) * poly.aMul * (0.75 + Math.random() * 0.5));
      segs.push({ x1: poly.pts[s].x, y1: poly.pts[s].y, x2: poly.pts[s + 1].x, y2: poly.pts[s + 1].y, w, alpha });
    }
  };
  for (const poly of mainPolys) pushPolySegs(poly, true, 0);
  for (const poly of branchPolys) pushPolySegs(poly, true, 0.12);
  for (const poly of ringPolys) pushPolySegs(poly, false, 0.28);

  // ---- 玻璃碎片（折射单元）：主射线全距 + 环带全距（保证铺满，缝隙=裂纹）----
  interface Cell {
    idx: number[];
    sx: number; sy: number;
    vx: number; vy: number;
    rx: number; ry: number;
  }
  const allPts: { x: number; y: number }[] = [{ x: px, y: py }];
  const ringPts: { x: number; y: number }[][] = [];
  for (let kk = 0; kk < R; kk++) {
    const row: { x: number; y: number }[] = [];
    for (let i = 0; i < mainCount; i++) {
      const rr = tMaxArr[i] * fR[kk] + (Math.random() - 0.5) * Math.min(8, tMaxArr[i] * 0.05);
      row.push({ x: px + dirArr[i].x * rr, y: py + dirArr[i].y * rr });
    }
    ringPts.push(row);
    allPts.push(...row);
  }
  const boundStart = allPts.length;
  for (let i = 0; i < mainCount; i++) {
    allPts.push({ x: px + dirArr[i].x * tMaxArr[i], y: py + dirArr[i].y * tMaxArr[i] });
  }
  const ringIdx = (kk: number, i: number): number => 1 + kk * mainCount + (i % mainCount);
  const boundIdx = (i: number): number => boundStart + (i % mainCount);
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
    // 折射位移：越靠近冲击点越大（近 3.4px → 远 1px），加随机切向
    const mag = 1.0 + 2.2 * (1 - Math.min(1, dl / halfDiag));
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
  for (let i = 0; i < mainCount; i++) {
    const ni = (i + 1) % mainCount;
    mkCell([0, ringIdx(0, i), ringIdx(0, ni)]); // 中心
    for (let kk = 0; kk < R - 1; kk++) {
      mkCell([ringIdx(kk, i), ringIdx(kk, ni), ringIdx(kk + 1, ni), ringIdx(kk + 1, i)]); // 环带间
    }
    mkCell([ringIdx(R - 1, i), ringIdx(R - 1, ni), boundIdx(ni), boundIdx(i)]); // 外沿
  }

  // ---- 玻璃粉尘颗粒（沿裂缝预生成，随整体淡出）----
  const dust: { x: number; y: number; r: number; bright: boolean }[] = [];
  const dustCount = 20 + Math.round(density * 40);
  for (let i = 0; i < dustCount; i++) {
    const src = allPolyPoints[Math.floor(Math.random() * allPolyPoints.length)];
    dust.push({
      x: src.x + (Math.random() - 0.5) * 6,
      y: src.y + (Math.random() - 0.5) * 6,
      r: 0.5 + Math.random() * 1.1,
      bright: Math.random() < 0.6,
    });
  }

  // ---- 冲击碎屑飞散（短暂）----
  const burst: { x: number; y: number; vx: number; vy: number; life: number; age: number; size: number }[] = [];
  const burstCount = 6 + Math.round(density * 8);
  for (let i = 0; i < burstCount; i++) {
    const a2 = Math.random() * Math.PI * 2;
    const sp = 30 + Math.random() * 80;
    burst.push({ x: px, y: py, vx: Math.cos(a2) * sp, vy: Math.sin(a2) * sp, life: 220 + Math.random() * 140, age: 0, size: 1 + Math.random() * 1.4 });
  }
  if (p2) {
    for (let i = 0; i < 4; i++) {
      const a2 = Math.random() * Math.PI * 2;
      const sp = 20 + Math.random() * 50;
      burst.push({ x: p2.x, y: p2.y, vx: Math.cos(a2) * sp, vy: Math.sin(a2) * sp, life: 160 + Math.random() * 100, age: 0, size: 0.8 + Math.random() });
    }
  }

  // 玻璃斜向高光（极淡，缓存）
  const sheen = ctx.createLinearGradient(0, 0, w, h);
  sheen.addColorStop(0, "rgba(255,255,255,0.055)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0)");
  sheen.addColorStop(1, "rgba(255,255,255,0.03)");

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
    if (myGen !== glassGen) return;
    blankRoot(root);
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

    // 末段整体渐渐淡出（smoothstep 缓出）
    const fadeStart = wipe * 0.3;
    let glassAlpha = 1;
    if (age > fadeStart) {
      const t = Math.min(1, (age - fadeStart) / Math.max(1, duration - fadeStart));
      glassAlpha = Math.max(0, 1 - t * t * (3 - 2 * t));
    }

    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = glassAlpha;

    // 1) 玻璃碎片：半透明折射贴片（背景纹理位移重贴 → 裂缝处错位 = 折射）
    for (const cl of cells) {
      cl.sx += cl.vx * dt;
      cl.sy += cl.vy * dt;
      cl.vx *= 1 - 4 * dt;
      cl.vy *= 1 - 4 * dt;
      ctx.save();
      ctx.translate(cl.sx, cl.sy);
      ctx.beginPath();
      ctx.moveTo(allPts[cl.idx[0]].x, allPts[cl.idx[0]].y);
      for (let q = 1; q < cl.idx.length; q++) ctx.lineTo(allPts[cl.idx[q]].x, allPts[cl.idx[q]].y);
      ctx.closePath();
      ctx.clip();
      if (bgTex) {
        ctx.globalAlpha = glassAlpha * 0.4;
        ctx.drawImage(bgTex, cl.rx, cl.ry);
        ctx.globalAlpha = glassAlpha;
      }
      ctx.fillStyle = "rgba(206,224,250,0.05)";
      ctx.fill();
      ctx.restore();
    }

    // 2) 玻璃斜向高光（极淡）
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, h);

    // 3) 裂纹：明暗双描边（偏移暗影 + 亮线），宽窄/透明度已烘焙在 segs
    for (const sg of segs) {
      ctx.save();
      ctx.translate(1, 1);
      ctx.strokeStyle = `rgba(16,18,34,${(0.16 * sg.alpha * glassAlpha).toFixed(3)})`;
      ctx.lineWidth = sg.w + 0.9;
      ctx.beginPath();
      ctx.moveTo(sg.x1, sg.y1);
      ctx.lineTo(sg.x2, sg.y2);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = `rgba(255,255,255,${(sg.alpha * glassAlpha).toFixed(3)})`;
      ctx.lineWidth = sg.w;
      ctx.beginPath();
      ctx.moveTo(sg.x1, sg.y1);
      ctx.lineTo(sg.x2, sg.y2);
      ctx.stroke();
    }

    // 4) 玻璃粉尘颗粒（随整体淡出）
    for (const d of dust) {
      ctx.fillStyle = d.bright ? `rgba(255,255,255,${(0.45 * glassAlpha).toFixed(3)})` : `rgba(40,46,66,${(0.28 * glassAlpha).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5) 冲击碎屑飞散（短暂，快速衰减）
    for (let i = 0; i < burst.length; i++) {
      const b = burst[i];
      b.age += dt * 1000;
      if (b.age >= b.life) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx *= 1 - 3.5 * dt;
      b.vy *= 1 - 3.5 * dt;
      const a = (1 - b.age / b.life) * glassAlpha;
      if (a < 0.02) continue;
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // 6) 冲击瞬间亮闪（短促）
    if (age < impactMs) {
      const t = age / impactMs;
      ctx.strokeStyle = `rgba(255,255,255,${((1 - t) * 0.55).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < mainCount; i++) {
        const f = 0.24 + t * 0.18;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + dirArr[i].x * lenArr[i] * f, py + dirArr[i].y * lenArr[i] * f);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // 便签本体末段一起淡出（关闭收尾）
    const noteFadeStart = wipe * 0.7;
    if (age > noteFadeStart) {
      const t = Math.min(1, (age - noteFadeStart) / Math.max(1, duration - noteFadeStart));
      root.style.opacity = Math.max(0, 1 - t * t * (3 - 2 * t)).toFixed(3);
    }

    if (age >= duration) {
      stopLoop();
      onDone();
      window.setTimeout(cleanupAfterHide, 400);
    }
  };

  const step = (now: number): void => {
    lastPaint = now;
    frame(now);
    if (!endedLocal) rafId = requestAnimationFrame(step);
  };

  // 背景纹理就绪后再启动（底色立即；背景图 ≤140ms 上限解码）。便签内容不裁空。
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
    watchdog2 = window.setTimeout(() => {
      if (endedLocal) return;
      stopLoop();
      cleanupAfterHide();
      onDone();
    }, duration + 600);
  });

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
