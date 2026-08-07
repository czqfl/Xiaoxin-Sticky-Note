// 便签「火焰消散」动画：火焰式逐像素消散（像真实火舌舔过纸面与金属；与粒子光效 dissolve/summon 为两套独立效果）
// ----------------------------------------------------------------------------
// 触发：关闭窗口 / 呼出窗口时播放（与火焰二选一，由设置 particle_mode 决定）。
//
// 效果（对齐用户需求）：
// - 从底部开始向上消散，但消散边界**不是水平直线**——边缘呈锯齿状 / 波浪状 / 破碎状，
//   像真实火焰舔过纸面与金属；
// - 同一水平线上不同位置的消散进度有随机差异（±200ms），有的已消散到中部、有的还在底部，
//   形成错落有致的节奏；
// - 消散起点不止整条底边：还在底部随机布置 2~3 个「种子点」，像墨水滴在宣纸上一样
//   向四周扩散（不规则圆 / 椭圆），与底部推进前沿取 min 融合成多前沿火焰；
// - 消散边界带**羽化模糊**（真正的逐像素软边，不是硬切）；
// - 整体持续约 1 秒，配合整体透明度从 100% 渐变到 0%（末端淡出）。
//
// 火焰本体（逐像素元胞自动机火焰场，Doom Fire 算法移植）：
// - 火焰热值从燃烧前沿注入，逐像素向上传播并衰减（每像素 = 下方 3 像素加权均值 × 衰减系数），
//   形成**连续流动的火焰体**（不是离散粒子点），摇曳自动涌现；
// - 随机起燃点：T 场含 2~3 个全屏随机种子点（配合底部推进前沿，多点起燃）；
// - 火焰根植于侵蚀边缘：热值每帧从各列最新前沿行注入，火焰随侵蚀推进移动；
// - 火焰高度随侵蚀进度：初期低矮（~25px）→ 后期升高（~100px），由裁剪行数控制；
// - 颜色：256 色调色板 暗红→红→橙→亮黄→白热 平滑渐变（焰心白热 #FFF5E0 最亮），
//   低热值处半透明（羽化边缘，透出背后画布）；
// - 火焰成簇：低频正弦调制各列注入强度 → 2~3 段火舌旺/弱交替（破碎燃烧带）；
// - 火星飞溅：2D 点精灵在侵蚀边缘随机迸发（白→橙→暗红渐冷），随机方向飞散后熄灭。
//
// 关键工程决策：**不用 WebGL**——本应用是透明窗口（SWCA 亚克力），WebView2 的 WebGL
// canvas 在透明背景合成下不可见（画面只有粒子层/火星层，火焰本体永不显示）。
// 火焰采用 2D canvas 逐像素渲染（低分辨率计算 + 放大羽化），与该环境已验证可靠的技术一致。
//
// 实现（关键：逐像素羽化无法用 clip-path 硬边实现，改用 CSS mask 蒙版）：
// - 把「消散时间场」T(x,y)（该像素开始消散的毫秒时刻）在初始化时一次性烘焙出来：
//     T = min(底部向上基准, 各种子点椭圆距离场) + 多倍频值噪声(±200ms) + 每格哈希抖动(±40ms)
//   噪声是平滑的 → 波浪起伏；哈希抖动是碎的 → 锯齿；种子点距离场 → 不规则扩散。
// - 每帧把 T 场按当前 age 转成一张低分辨率 alpha 蒙版（visible=不透明 / dissolved=透明 /
//   边界处按羽化带宽渐变），putImageData 后 toDataURL，作为 .note-window 的
//   -webkit-mask-image；mask-size:100% 100% 上采样 → 低分辨率蒙版自动进一步柔化羽化。
// - 蒙版用「先解码再替换」（new Image onload 后才 set）避免逐帧 dataURL 闪烁；
// - 透明度淡出：root.style.opacity 随全局进度 1→0（消散）/ 0→1（成形）；
// - 火焰覆盖层：2D canvas 逐像素火焰场（热值注入+传播+调色板，Doom Fire 算法），
//   火焰连续流动、根植于燃烧前沿，另叠少量火星点精灵；
// - 关闭(dissolve)与呼出(materialize)互为倒放：dissolve 底部向上消失，
//   materialize 顶部向下成形（用 Tm = wipe - T 反转同一时间场）。

let flaming = false;
let materializing = false;
/** 动画代次：每次 runFlame 启动 +1。上一轮动画遗留的延时清理（cleanupAfterHide）凭此作废，
 *  避免快速呼出时把正在播放的新动画便签裁掉/隐藏（见 cleanupAfterHide 守卫）。 */
let flameGen = 0;

/** 当前火焰动画的“立即中止”句柄（由 runFlame 注册；cancelFlame 调用）。
 *  中止 = 停帧 + 复原页面（保持可见，供“呼出打断关闭”等快速切换）。 */
let cancelFlameFn: (() => void) | null = null;

/** 立即中止火焰动画并复原页面（关闭动画开始前调用，避免与呼出动画同时改 mask/透明度；
 *  呼出打断关闭时也调用——此时不触发 onDone，窗口保持显示）。 */
export function cancelFlame(): void {
  const c = cancelFlameFn;
  cancelFlameFn = null;
  if (c) {
    c();
    return;
  }
  // 兜底：无注册句柄时（理论不会出现）直接复原
  if (!flaming && !materializing) return;
  flaming = false;
  materializing = false;
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (root) restoreRoot(root);
  document.querySelectorAll(".flame-canvas").forEach((el) => el.remove());
}

/** 复原便签本体样式（mask / 透明度 / 阴影 / 裁剪全部还原）。 */
function restoreRoot(root: HTMLElement): void {
  try {
    root.style.setProperty("-webkit-mask-image", "");
    root.style.setProperty("mask-image", "");
    root.style.clipPath = "";
    root.style.opacity = "";
    root.style.boxShadow = "";
  } catch {
    /* ignore */
  }
}

/** 隐藏便签本体（保持"空画面"，供下次呼出从空开始，契约与 dissolve.ts 一致）。 */
function blankRoot(root: HTMLElement): void {
  try {
    root.style.setProperty("-webkit-mask-image", "");
    root.style.setProperty("mask-image", "");
    root.style.clipPath = "inset(0 0 100% 0)";
    root.style.opacity = "";
    root.style.boxShadow = "none";
  } catch {
    /* ignore */
  }
}

/** 请求播放「火焰消散」关闭动画；onDone 在动画完全结束后调用（用于真正关闭窗口）。
 * speed：动画速度百分比（100=原速），所有时序按 100/speed 缩放。 */
export function requestFlameDissolveClose(onDone: () => void, particleDensity = 50, speed = 100): void {
  const root = document.querySelector(".note-window") as HTMLElement | null;
  if (!root || flaming) {
    onDone();
    return;
  }
  flaming = true;
  let done = false;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  const safeDone = () => {
    if (done) return;
    done = true;
    flaming = false;
    cancelFlameFn = null;
    onDone();
  };
  const watchdog = window.setTimeout(safeDone, Math.round(4000 * Math.max(0.25, Math.min(4, 100 / Math.max(10, speed)))));
  cancelFlameFn = () => {
    if (aborted) return;
    aborted = true;
    window.clearTimeout(watchdog);
    if (stopRun) stopRun();
    done = true; // 阻止 onDone：finish() 不会被调用，窗口保持显示
    flaming = false;
  };
  try {
    stopRun = runFlame(root, "dissolve", particleDensity, speed, () => {
      window.clearTimeout(watchdog);
      safeDone();
    });
  } catch (e) {
    console.error("火焰消散动画异常:", e);
    window.clearTimeout(watchdog);
    safeDone();
  }
}

/** 播放「火焰成形」呼出动画（关闭的倒放：顶部向下成形）；收尾自动复原页面。 */
export function playFlameMaterialize(root: HTMLElement, particleDensity = 50, speed = 100): void {
  // 强制接管：若已有火焰动画在播放（快速呼出时上一轮动画未收尾、materializing 残留），
  // 先取消旧的再启动新的，杜绝「呼出被静默拒绝 → 窗口空画面永久卡死」。
  if (materializing || flaming) cancelFlame();
  materializing = true;
  let aborted = false;
  let stopRun: (() => void) | null = null;
  cancelFlameFn = () => {
    if (aborted) return;
    aborted = true;
    if (stopRun) stopRun();
    materializing = false;
  };
  try {
    stopRun = runFlame(root, "materialize", particleDensity, speed, () => {
      /* materialize 收尾在 runFlame 内自行复原，无需额外 onDone */
    });
  } catch (e) {
    console.error("火焰成形动画异常:", e);
    cancelFlameFn = null;
    materializing = false;
    restoreRoot(root);
  }
}

// ---- 确定性哈希 / 值噪声（提供平滑的波浪起伏 + 细碎的锯齿）----
function hash2(ix: number, iy: number): number {
  let n = (ix * 374761393 + iy * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967295; // 0..1
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy; // 0..1
}

/** 多倍频值噪声，输出约 [-1,1]：低频出大波浪、高频出锯齿破碎。 */
function fbm(x: number, y: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    sum += (valueNoise(x * freq, y * freq) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

interface Seed {
  x: number;
  y: number;
  invRx: number;
  invRy: number;
}

/**
 * 播放一次火焰动画。
 * @param direction "dissolve"=关闭消散（底部向上）；"materialize"=呼出成形（顶部向下，倒放）
 */
function runFlame(
  root: HTMLElement,
  direction: "dissolve" | "materialize",
  particleDensity: number,
  speed: number,
  onDone: () => void,
): () => void {
  const myGen = ++flameGen; // 本动画实例代次：作废上一轮遗留的延时清理
  const isDissolve = direction === "dissolve";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // 内容尺寸（便签本体）：动画开始前窗口尚未扩大，innerWidth/Height 即便签尺寸。
  const w = window.innerWidth;
  const h = window.innerHeight;
  const k = Math.max(0.25, Math.min(4, 100 / Math.max(10, speed))); // 速度系数：200%→0.5（时长减半）

  // ---- 时序参数 ----
  const wipe = Math.round(1000 * k); // 消散 / 成形主体时长 ms（用户要求约 1 秒）
  const featherMs = Math.round(90 * k); // 羽化软边时间带宽（越大边缘越柔）
  const tailMs = Math.round((isDissolve ? 520 : 160) * k); // 收尾余时（关闭时让火舌多停留片刻；成形更短）
  const duration = wipe + tailMs;

  // ---- 蒙版：低分辨率逐像素 alpha（mask-size:100% 100% 上采样柔化）----
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
  const img = mctx.createImageData(mw, mh);
  const px32 = new Uint32Array(img.data.buffer); // 以 32 位写入，仅改最高字节(alpha)

  // ---- 消散时间场 T(x,y)（初始化烘焙一次，单位 ms，越小越先消散）----
  const noiseAmp = 200; // ±200ms：同一水平线不同位置的进度差（20%~40%）
  const jitterAmp = 42; // 细碎锯齿
  const leadIn = noiseAmp + jitterAmp + 8; // 保证 T∈[0, wipe-featherMs]
  const baseMax = wipe - featherMs - leadIn;
  const noiseScale = 1 / 42; // 主波长 ~42px

  // 2~3 个随机种子点（墨滴扩散源）：全屏随机分布——燃烧不一定从最下方开始，
  // 而是从便签上随机 2~3 点同时发起（配合底部推进前沿，形成多点起燃的真实烧纸感）
  const seedCount = 2 + Math.floor(Math.random() * 2);
  const seeds: Seed[] = [];
  for (let i = 0; i < seedCount; i++) {
    const rx = (0.22 + Math.random() * 0.3) * w;
    const ry = (0.22 + Math.random() * 0.35) * h;
    seeds.push({
      x: (0.15 + Math.random() * 0.7) * w,
      y: (0.12 + Math.random() * 0.76) * h, // 全屏随机（避开极边缘）
      invRx: 1 / rx,
      invRy: 1 / ry,
    });
  }
  const seedSpan = wipe * 0.5; // 种子点从中心到边缘的扩散耗时

  // 返回 CSS 坐标 (nx,ny) 的消散时刻（dissolve 语义：底部小、顶部大）
  const dissolveTimeAt = (nx: number, ny: number): number => {
    // 底部向上基准：底部 leadIn，顶部 baseMax
    let base = leadIn + ((h - ny) / h) * (baseMax - leadIn);
    // 种子点扩散场（不规则椭圆），取 min → 多前沿火焰 / 局部破洞
    for (let i = 0; i < seedCount; i++) {
      const s = seeds[i];
      const dx = (nx - s.x) * s.invRx;
      const dy = (ny - s.y) * s.invRy;
      const d = Math.sqrt(dx * dx + dy * dy); // 0..1 归一化椭圆距离
      const t = d * seedSpan;
      if (t < base) base = t;
    }
    const n = fbm(nx * noiseScale, ny * noiseScale) * noiseAmp;
    const j = (hash2(Math.round(nx), Math.round(ny)) * 2 - 1) * jitterAmp;
    let T = base + n + j;
    if (T < 0) T = 0;
    else if (T > baseMax + noiseAmp + jitterAmp) T = baseMax + noiseAmp + jitterAmp;
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

  // ---- 火焰本体：逐像素元胞自动机火焰场（Doom Fire 算法移植）----
  // 原理（经研究验证的经典方案，Lode's Computer Graphics Tutorial）：
  // 火焰热值从"燃烧前沿"注入，逐像素向上传播并衰减（每像素 = 下方 3 像素加权均值 × 衰减系数），
  // 天然形成**连续流动的火焰体**（不是离散粒子点），摇曳自动涌现；颜色用 256 色调色板
  // 白→黄→橙→红 映射。低分辨率计算 + 放大渲染（imageSmoothing 天然羽化），CPU 开销可控。
  // 火焰强度（粒子密度设置映射 0..1），控制火焰高度与注入强度。
  const density = Math.max(0, Math.min(100, particleDensity)) / 100;
  const canvas = document.createElement("canvas");
  canvas.className = "flame-canvas";
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.position = "fixed";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.zIndex = "2147483646"; // 火焰在火星层之下（火星从火中迸出）
  canvas.style.pointerEvents = "none";
  canvas.style.transform = "translateZ(0)";
  document.body.appendChild(canvas);
  const fctx2 = canvas.getContext("2d");

  // ---- 火焰场缓冲（低分辨率：宽 ~192px，高按比例；放大渲染羽化）----
  const fireW = 192;
  const fireH = Math.max(24, Math.round(h / w * fireW));
  const fireCanvas = document.createElement("canvas");
  fireCanvas.width = fireW;
  fireCanvas.height = fireH;
  const fireCtx = fireCanvas.getContext("2d");
  const fireImg = fireCtx ? fireCtx.createImageData(fireW, fireH) : null;
  const firePx = fireImg ? new Uint32Array(fireImg.data.buffer) : null;
  // 热值缓冲：0=无火 .. 255=白热（Uint8，双缓冲：读旧帧传播一步、写新帧，Doom Fire 标准做法）
  const fireBufA = new Uint8Array(fireW * fireH);
  const fireBufB = new Uint8Array(fireW * fireH);

  // ---- 256 色调色板：白→黄→橙→红→暗（按热值从高到低）----
  // 调色板下标 = 热值（255 白热、~200 亮黄、~140 橙、~90 红、~40 暗红、0 透明）
  const paletteR = new Uint8Array(256);
  const paletteG = new Uint8Array(256);
  const paletteB = new Uint8Array(256);
  {
    // 分段线性插值：从暗红(0) → 红(50) → 橙(110) → 亮黄(185) → 白热(255)
    // 颜色整体压低（不过曝、不刺眼）
    const stops: [number, number, number, number][] = [
      [0, 25, 7, 3],      // 0：暗红（余烬）
      [55, 230, 55, 10],  // 55：红
      [115, 235, 120, 28],// 115：橙
      [185, 240, 178, 80],// 185：亮黄橙
      [235, 248, 230, 180],// 235：白黄
      [255, 250, 240, 215],// 255：白热（非纯白，避免过曝）
    ];
    for (let s = 0; s < stops.length - 1; s++) {
      const [v0, r0, g0, b0] = stops[s];
      const [v1, r1, g1, b1] = stops[s + 1];
      for (let v = v0; v <= v1 && v < 256; v++) {
        const k = (v - v0) / Math.max(1, v1 - v0);
        paletteR[v] = Math.round(r0 + (r1 - r0) * k);
        paletteG[v] = Math.round(g0 + (g1 - g0) * k);
        paletteB[v] = Math.round(b0 + (b1 - b0) * k);
      }
    }
  }

  // ---- 火焰场渲染：热值从当前前沿注入 → 双向传播衰减 → 调色板映射 ----
  // 每帧调用；热值注入在前沿行，向**上下两侧**双向传播（dissolve/materialize 通用，
  // 边缘两侧都出火，上边沿与洞下沿也能看到火焰舔舐）。
  // 列映射表：每个火焰场列 → 最近的 mask 列（fireW/cols 非整数时避免映射空隙列无火）
  const colMap = new Int16Array(fireW);
  for (let fx = 0; fx < fireW; fx++) {
    colMap[fx] = Math.min(mw - 1, Math.max(0, Math.round((fx / fireW) * (mw - 1))));
  }
  const updateFlameField = (age: number): void => {
    if (!fireImg || !firePx || !fireCtx || !fctx2) return;
    const progress = Math.min(1, age / wipe);
    // 火焰高度随侵蚀进度：初期低矮（~25px）→ 后期升高（~100px）
    const flameH = (25 + 75 * progress) * (0.6 + 0.4 * density);
    const flameRows = Math.max(3, Math.round((flameH / h) * fireH));
    const injectHeat = 190 + 15 * density; // 注入热值（降低强度，避免过亮）

    // 双缓冲 Doom Fire：读旧帧（src）传播一步写入新帧（dst）→ 每帧热值只前进一行，
    // 火焰随时间自然向上蔓延、持续摇曳；随后注入新热值、按前沿裁剪。
    const src = fireBufA;
    const dst = fireBufB;
    dst.fill(0);
    const rows = mh;

    // 1) 双向传播（Doom Fire 核心：每个像素向「上下」两个方向按衰减系数扩散，读 src 写 dst）
    //    ——火焰在燃烧前沿的**两侧**都可见：上边沿、洞下沿等「完整侧在窗口外/已烧没区」的
    //    边缘，单向传播时火焰会飘出窗口而消失，双向传播后这些边缘也能看到火焰舔舐。
    //    关键：必须加「随机水平风偏」+「每像素随机掉热」——否则某些列会被确定性竖直扩散
    //    强化成笔直向上的细长光线（草状伪影，明显不像火焰）。这是 Doom Fire 经典手法：
    //    风偏让火舌左右摇曳、随机掉热烧断竖直长线，火焰尖端自然闪烁。
    const decay = 0.88; // 衰减系数：越大火焰越高（0.8~0.9 区间）
    for (let y = 0; y < fireH; y++) {
      const row = y * fireW;
      for (let x = 0; x < fireW; x++) {
        const v = src[row + x];
        if (v < 2) continue;
        const l = x > 0 ? src[row + x - 1] : v;
        const r = x < fireW - 1 ? src[row + x + 1] : v;
        let d = (l + v * 2 + r) * 0.25 * decay;
        if (d < 2) continue;
        // 随机掉热：每像素 0/1 衰减，烧断竖直长线（草状伪影根因之一）
        d -= Math.random() < 0.5 ? 0 : 1;
        if (d < 2) continue;
        // 随机水平风偏：-1/0/+1，让火舌左右摇曳、不再连成笔直光线
        const wind = (Math.random() * 3 | 0) - 1;
        if (y > 0) {
          const nx = x + wind;
          if (nx >= 0 && nx < fireW) {
            const idx = (y - 1) * fireW + nx;
            if (d > dst[idx]) dst[idx] = d > 255 ? 255 : d;
          }
        }
        if (y < fireH - 1) {
          const nx = x + wind;
          if (nx >= 0 && nx < fireW) {
            const idx = (y + 1) * fireW + nx;
            if (d > dst[idx]) dst[idx] = d > 255 ? 255 : d;
          }
        }
      }
    }

    // 2) 燃烧带注入（写入 dst）：每个火焰场列经 colMap 找到对应 mask 列，在该列的**燃烧带**
    //    （mask alpha 处于过渡区的所有行）注入热值——火焰与侵蚀轨迹完全一致，边缘不漏段。
    for (let fx = 0; fx < fireW; fx++) {
      const mx = colMap[fx];
      if (!bandHas[mx]) continue;
      // 火焰成簇：低频正弦调制（火舌旺弱交替，但**不归零**——保证每条燃烧带都出火，
      // 只是强弱不同；配合随机扰动产生摇曳）
      const cluster =
        0.82 +
        0.13 * Math.sin(fx * 0.35 + age * 0.0004) +
        0.1 * Math.sin(fx * 0.9 - age * 0.0007 + 2.0);
      // 注入热值：下限保护（>=60，即所有燃烧带列至少出火），上限 230（整体压低，不刺眼）
      const baseHeat = Math.max(60, Math.min(230, Math.round(injectHeat * cluster * (0.7 + Math.random() * 0.3))));
      const loM = bandLo[mx], hiM = bandHi[mx];
      for (let my = loM; my <= hiM; my++) {
        const fy = Math.round((my / rows) * fireH); // 燃烧带行（火焰场坐标）
        if (fy < 0 || fy >= fireH) continue;
        const heat = Math.max(55, baseHeat); // 带内保下限，连续出火
        const idx = fy * fireW + fx;
        dst[idx] = Math.max(dst[idx], heat);
        if (fx > 0) dst[idx - 1] = Math.max(dst[idx - 1], Math.round(heat * 0.7));
        if (fx < fireW - 1) dst[idx + 1] = Math.max(dst[idx + 1], Math.round(heat * 0.7));
      }
    }

    // 3) 裁剪：无燃烧带列清零；有燃烧带列保留燃烧带两侧各 flameRows 的火焰带——
    //    火焰紧贴侵蚀轨迹（燃烧带）并向外舔出，其它区域清零（避免全屏糊火）。
    const keepMin = new Int16Array(fireW);
    const keepMax = new Int16Array(fireW);
    keepMin.fill(-1);
    keepMax.fill(-1);
    for (let fx = 0; fx < fireW; fx++) {
      const mx = colMap[fx];
      if (!bandHas[mx]) continue;
      const fyLo = Math.round((bandLo[mx] / rows) * fireH);
      const fyHi = Math.round((bandHi[mx] / rows) * fireH);
      keepMin[fx] = Math.max(0, fyLo - flameRows);
      keepMax[fx] = Math.min(fireH - 1, fyHi + flameRows);
    }
    for (let x = 0; x < fireW; x++) {
      const lo = keepMin[x];
      if (lo < 0) {
        for (let y = 0; y < fireH; y++) dst[y * fireW + x] = 0;
        continue;
      }
      const hi = keepMax[x];
      for (let y = 0; y < lo; y++) dst[y * fireW + x] = 0;
      for (let y = hi + 1; y < fireH; y++) dst[y * fireW + x] = 0;
    }

    // 4) 调色板映射 → ImageData（带半透明：热值低处透出背景；读 dst）
    let p = 0;
    for (let i = 0; i < fireW * fireH; i++) {
      const v = dst[i];
      if (v < 12) {
        firePx[p++] = 0; // 透明
      } else {
        const alpha = Math.min(255, 55 + v * 0.5); // 低热值处仍可见（羽化但不消失，整体更透）
        firePx[p++] = (alpha << 24) | (paletteB[v] << 16) | (paletteG[v] << 8) | paletteR[v];
      }
    }
    fireCtx.putImageData(fireImg, 0, 0);
    // 5) 放大绘制到全屏（imageSmoothing 天然羽化，火焰连续柔和）
    fctx2.imageSmoothingEnabled = true;
    fctx2.clearRect(0, 0, w, h);
    fctx2.drawImage(fireCanvas, 0, 0, w, h);
    // 6) 交换缓冲：dst 成为下一帧的 src
    fireBufA.set(dst);
  };

  // ---- 火星/余烬覆盖层（2D canvas，叠在火焰之上）：侵蚀边缘零星迸发、随机方向飞散后熄灭 ----
  const sparkCanvas = document.createElement("canvas");
  sparkCanvas.className = "flame-canvas"; // 与火焰同 class，清理时一并移除
  sparkCanvas.width = canvas.width;
  sparkCanvas.height = canvas.height;
  sparkCanvas.style.position = "fixed";
  sparkCanvas.style.left = "0";
  sparkCanvas.style.top = "0";
  sparkCanvas.style.width = "100%";
  sparkCanvas.style.height = "100%";
  sparkCanvas.style.zIndex = "2147483647"; // 火星在火焰之上（从火中迸出飞溅）
  sparkCanvas.style.pointerEvents = "none";
  sparkCanvas.style.transform = "translateZ(0)";
  document.body.appendChild(sparkCanvas);
  const sctx = sparkCanvas.getContext("2d");
  const MAX_SPARKS = 260;
  const spx = new Float32Array(MAX_SPARKS);
  const spy = new Float32Array(MAX_SPARKS);
  const spvx = new Float32Array(MAX_SPARKS);
  const spvy = new Float32Array(MAX_SPARKS);
  const spLife = new Float32Array(MAX_SPARKS);
  const spAge = new Float32Array(MAX_SPARKS);
  const spSize = new Float32Array(MAX_SPARKS);
  const spHue = new Float32Array(MAX_SPARKS); // 0=亮白 0.5=橙 1=暗红
  let sparkCount = 0;
  // 火星精灵（径向渐变光点，additive 绘制）：3 档色温（亮白/橙/暗红），按寿命渐冷切换
  const makeSparkSprite = (r1: number, g1: number, b1: number): HTMLCanvasElement => {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 16;
    const cx = c.getContext("2d");
    if (cx) {
      const g = cx.createRadialGradient(8, 8, 0, 8, 8, 8);
      g.addColorStop(0, `rgba(${Math.min(255, r1 + 60)},${Math.min(255, g1 + 50)},${Math.min(255, b1 + 30)},1)`);
      g.addColorStop(0.4, `rgba(${r1},${g1},${b1},0.9)`);
      g.addColorStop(1, `rgba(${Math.max(0, r1 - 60)},${Math.max(0, g1 - 50)},${Math.max(0, b1 - 40)},0)`);
      cx.fillStyle = g;
      cx.fillRect(0, 0, 16, 16);
    }
    return c;
  };
  const sparkSpriteHot = makeSparkSprite(255, 235, 180);   // 亮白热
  const sparkSpriteWarm = makeSparkSprite(255, 175, 70);   // 橙
  const sparkSpriteDim = makeSparkSprite(230, 110, 40);    // 暗红
  const sparkSprites = [sparkSpriteHot, sparkSpriteWarm, sparkSpriteDim];
  // 在侵蚀前沿迸发火星：每帧在若干列的前沿附近随机生成（密度受粒子强度设置与剩余时间影响）
  const spawnSparks = (age: number): void => {
    if (!sctx || !isDissolve) return; // 火星主要在关闭（燃烧）方向；呼出反向不飞溅
    const remain = 1 - Math.min(1, age / wipe);
    if (remain <= 0) return;
    const cols = mw;
    const rows = mh;
    const chance = 0.07 * density * (0.4 + 0.6 * remain); // 零星火星（小而亮，点缀不糊）
    for (let x = 0; x < cols; x++) {
      if (Math.random() > chance) continue;
      if (!bandHas[x]) continue;
      const f = (bandLo[x] + bandHi[x]) * 0.5; // 燃烧带中心（mask 行）
      if (sparkCount >= MAX_SPARKS) break;
      const i = sparkCount++;
      // 火星从燃烧带位置（画布坐标）迸出，随机方向（偏上为主、略带斜向）
      const px = ((x + Math.random()) / cols) * w;
      const py = ((f + (Math.random() - 0.5) * 1.5) / rows) * h;
      spx[i] = px;
      spy[i] = py;
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.6; // 向上 ±45°
      const spd = 60 + Math.random() * 140; // 60~200 px/s
      spvx[i] = Math.cos(ang) * spd;
      spvy[i] = Math.sin(ang) * spd;
      spLife[i] = 500 + Math.random() * 1200; // 0.5~1.7s 后熄灭
      spAge[i] = 0;
      spSize[i] = 0.9 + Math.random() * 1.3; // 更小的光点
      spHue[i] = Math.random(); // 0 白 ~ 1 暗红
    }
  };
  const updateSparks = (dtMs: number): void => {
    if (!sctx) return;
    sctx.clearRect(0, 0, w, h);
    sctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < sparkCount; i++) {
      spAge[i] += dtMs;
      const u = spAge[i] / spLife[i];
      if (u >= 1) {
        const last = --sparkCount;
        if (i !== last) {
          spx[i] = spx[last]; spy[i] = spy[last]; spvx[i] = spvx[last]; spvy[i] = spvy[last];
          spLife[i] = spLife[last]; spAge[i] = spAge[last]; spSize[i] = spSize[last]; spHue[i] = spHue[last];
        }
        i--;
        continue;
      }
      spx[i] += spvx[i] * (dtMs / 1000);
      spy[i] += spvy[i] * (dtMs / 1000);
      spvy[i] += 60 * (dtMs / 1000); // 轻微向下重力，火星抛物线
      const fade = 1 - u;
      const alpha = fade * fade * 0.95;
      if (alpha < 0.02) continue;
      // 色温：随寿命渐冷（白热→橙→暗红），按 spHue 偏移分档
      const h = spHue[i];
      const heat = 1 - u; // 1 刚迸出 .. 0 将熄
      let si: number;
      const cold = h * (1 - heat * 0.85); // 0..1 冷度
      if (cold < 0.33) si = 0;
      else if (cold < 0.66) si = 1;
      else si = 2;
      sctx.globalAlpha = alpha;
      sctx.globalCompositeOperation = "lighter";
      const r = spSize[i] * (1 + 0.6 * u) * 1.8; // 精灵绘制半径（含光晕，小而亮）
      sctx.drawImage(sparkSprites[si], spx[i] - r / 2, spy[i] - r / 2, r, r);
    }
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = "source-over";
  };

  // ---- 燃烧带定位：逐列找出「正在侵蚀」的连续像素带（mask alpha 处于羽化过渡区的行）----
  // 与「侵蚀轨迹」完全一致：凡 mask 当前在软边过渡（alpha∈[BAND_LO,BAND_HI]）处都算燃烧带，
  // 洞的上下沿、底部推进前沿、种子洞内部统统被包含（过渡带是连续的，连洞也包进去）→
  // 火焰 100% 贴合侵蚀边缘，不漏段、不依赖 0.5 穿越点检测（旧方案会漏检导致部分边缘无火）。
  const BAND_LO = 0.08, BAND_HI = 0.92; // alpha 过渡带阈值（羽化软边区）
  const bandLo = new Int16Array(mw);   // 每列燃烧带起始行（mask 行），无则保持 -1
  const bandHi = new Int16Array(mw);   // 每列燃烧带结束行
  const bandHas = new Uint8Array(mw);  // 每列是否有燃烧带
  const computeFlameField = (): void => {
    const cols = mw, rows = mh;
    for (let x = 0; x < cols; x++) {
      let lo = -1, hi = -1;
      for (let y = 0; y < rows; y++) {
        const a = ((px32[x + y * cols] >>> 24) & 0xff) / 255;
        if (a > BAND_LO && a < BAND_HI) {
          if (lo < 0) lo = y;
          hi = y;
        }
      }
      if (lo >= 0) {
        bandLo[x] = lo;
        bandHi[x] = hi;
        bandHas[x] = 1;
      } else {
        bandHas[x] = 0;
      }
    }
  };


  // ---- 便签本体：进入动画态 ----
  // dissolve：便签本就可见，清掉可能残留的 clip-path、改由 mask 接管；
  // materialize：保持空裁剪（clip-path inset），等空蒙版解码后再清除，避免闪现旧内容。
  if (isDissolve) {
    try {
      root.style.clipPath = "";
    } catch {
      /* ignore */
    }
  }
  root.style.boxShadow = "none";
  const setMask = (url: string) => {
    root.style.setProperty("-webkit-mask-image", `url("${url}")`);
    root.style.setProperty("mask-image", `url("${url}")`);
    root.style.setProperty("-webkit-mask-size", "100% 100%");
    root.style.setProperty("mask-size", "100% 100%");
    root.style.setProperty("-webkit-mask-repeat", "no-repeat");
    root.style.setProperty("mask-repeat", "no-repeat");
  };

  // 把当前 age 对应的蒙版写入 canvas 并返回是否还有内容（materialize 起始全透明）
  const renderMask = (age: number): void => {
    let p = 0;
    for (let i = 0; i < Tfield.length; i++) {
      let T = Tfield[i];
      if (!isDissolve) T = wipe - T;
      const local = age - T;
      let a = local / featherMs; // -inf..+inf
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      if (isDissolve) a = 1 - a; // dissolve：可见→消散
      const alphaByte = (a * 255) & 0xff;
      px32[p++] = (alphaByte << 24) | 0x00ffffff; // RGB 白 + alpha
    }
    mctx.putImageData(img, 0, 0);
  };

  // 蒙版替换：先解码（new Image onload）再 set，避免逐帧 dataURL 闪烁。
  // 关键：用 lastAppliedSeq 跟踪「已应用的最新帧序号」——只丢弃比已应用更旧的帧，
  // 绝不能用 seq !== maskSeq 丢弃（否则 Image 解码慢于推帧间隔(30ms)时，中间所有帧都会被
  // 判为"非最新"而丢弃，setMask 直到最后一帧才执行 → materialize 的 mask 永远停在全透明、
  // 便签被透明 mask 藏住、直到收尾 restoreRoot 才"瞬间出现"，表现为"只有粒子、没有便签"）。
  let lastMaskPush = -1;
  let maskSeq = 0;
  let lastAppliedSeq = 0; // 已应用的最大帧序号
  const pushMask = (age: number, force: boolean): void => {
    if (!force && age - lastMaskPush < 30) return; // ~30Hz 更新蒙版即可（羽化边缘平滑）
    lastMaskPush = age;
    renderMask(age);
    const url = maskCanvas.toDataURL();
    const seq = ++maskSeq;
    const im = new Image();
    const apply = (): void => {
      if (endedLocal || seq < lastAppliedSeq) return; // 丢弃比已应用更旧的帧（防乱序回退）
      lastAppliedSeq = seq;
      setMask(url);
    };
    im.onload = apply;
    im.onerror = () => {
      // 解码失败兜底：materialize 直接显示本体（清 mask + 还原 opacity），避免卡在空白等看门狗；
      // dissolve 本体本就可见，mask 仅增强裁切，解码失败可忽略。
      if (endedLocal || isDissolve || seq < lastAppliedSeq) return;
      lastAppliedSeq = seq;
      try {
        root.style.opacity = "1";
        root.style.setProperty("-webkit-mask-image", "");
        root.style.setProperty("mask-image", "");
      } catch {
        /* ignore */
      }
    };
    im.src = url;
  };

  // 全局透明度：dissolve 从完全不透明缓慢淡出到透明度 70%（opacity 0.3）即止——
  // 剩余画面由后续「火烧/关闭」收尾，无需完全透明；materialize 从全透明淡入到不透明。
  // 淡出放缓：dissolve 用整个动画时长（wipe+tailMs）完成淡出，而不是随 wipe 一起结束。
  const applyOpacity = (age: number): void => {
    const fadeSpan = isDissolve ? duration : wipe;
    let p = age / fadeSpan;
    if (p < 0) p = 0;
    else if (p > 1) p = 1;
    const o = isDissolve ? 1 - p * 0.7 : p;
    root.style.opacity = o.toFixed(3);
  };

  // ---- 帧循环 ----
  // rafId/backupId 是本动画实例的局部句柄（不能是模块级：多个动画实例并存时
  // 共享句柄会导致 A 的 stopLoop 取消掉 B 的 rAF，帧循环互相踩踏、动画卡死）。
  let rafId = 0;
  let backupId = 0;
  let start = 0;
  let started = false;
  let prevFrameNow = 0; // 上一帧时间戳（计算 dtMs 供火星粒子积分）
  let lastPaint = 0;
  let endedLocal = false;
  let watchdog = 0; // 强制收尾看门狗句柄

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
  };

  function finishEarly(): void {
    // 无法渲染时直接收尾（dissolve：隐藏；materialize：复原）
    stopLoop();
    try {
      sparkCanvas.remove();
    } catch {
      /* ignore */
    }
    if (isDissolve) {
      blankRoot(root);
      onDone();
    } else {
      restoreRoot(root);
      materializing = false;
      onDone();
    }
  }

  const cleanupAfterHide = () => {
    // 本实例资源（rAF/计时器/canvas）必须无条件释放——
    // 若随代次守卫一起跳过，每次「关闭后 400ms 内呼出」都泄漏 canvas，
    // 多次后内存累积会压垮渲染进程（崩溃页哭脸 + 白屏）。
    stopLoop();
    try {
      canvas.remove();
      sparkCanvas.remove();
    } catch {
      /* ignore */
    }
    // 代次守卫（仅保护便签本体样式）：若已启动新动画（flameGen 改变），本实例的
    // 延时清理作废，不再 blankRoot——否则会把正在播放的新动画便签裁掉/隐藏。
    if (myGen !== flameGen) return;
    // 保持"空画面"供下次呼出（契约同 dissolve.ts cleanup）
    blankRoot(root);
    flaming = false;
  };

  const finishMaterialize = () => {
    stopLoop();
    if (myGen !== flameGen) return; // 已被新动画接管：勿复位其样式
    materializing = false;
    // 让“便签已完整显现”的最后一帧先提交，再移除覆盖层与复位样式，避免收尾闪一下。
    requestAnimationFrame(() => {
      if (myGen !== flameGen) return; // 期间已启动新动画：勿复位其样式
      try {
        canvas.remove();
        sparkCanvas.remove();
      } catch {
        /* ignore */
      }
      restoreRoot(root);
    });
  };

  const frame = (now: number) => {
    if (endedLocal) return; // 已取消/收尾：丢弃迟到帧（rAF 回调入队后无法撤销，必须在此拦截）
    if (!started) {
      started = true;
      start = now;
      prevFrameNow = now;
    }
    // age 取真实墙钟（首帧定 start），与位移积分解耦
    const age = now - start;
    const dtMs = Math.min(50, Math.max(0, now - prevFrameNow));
    prevFrameNow = now;

    pushMask(age, false);
    applyOpacity(age);
    spawnSparks(age);
    updateSparks(dtMs);

    // ---- 火焰场：先定位燃烧带（bandLo/bandHi），再逐像素渲染连续火焰体 ----
    computeFlameField();
    updateFlameField(age);

    if (age >= duration) {
      if (isDissolve) {
        stopLoop();
        try {
          onDone(); // 触发真正隐藏窗口
        } finally {
          window.setTimeout(cleanupAfterHide, 400);
        }
      } else {
        window.clearInterval(backupId);
        finishMaterialize();
        onDone();
      }
      return;
    }
  };

  const step = (now: number) => {
    lastPaint = now;
    frame(now);
    if (!endedLocal) rafId = requestAnimationFrame(step);
  };

  // 两种方向都同步启动循环（不依赖 Image.onload），避免首帧蒙版未解码时循环永不开始、
  // materialize 卡死（便签呼出后无内容、materializing 卡 true、后续呼出被忽略）。
  // dissolve 首帧为全可见、materialize 首帧为全透明，各自与语义一致。
  renderMask(0);
  setMask(maskCanvas.toDataURL());
  if (isDissolve) {
    try {
      root.style.clipPath = "";
    } catch {
      /* ignore */
    }
  } else {
    // materialize：清掉 flame 残留的 clip-path 空裁切，由 mask 接管；起始 opacity=0
    // 配合 applyOpacity 淡入，杜绝闪现旧内容。
    try {
      root.style.clipPath = "";
    } catch {
      /* ignore */
    }
    root.style.opacity = "0";
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

  // 看门狗：无论循环是否推进，到时强制收尾——materialize 复原内容 / dissolve 隐藏窗口，
  // 彻底杜绝「呼出后便签无内容」卡死（与 summon.ts 的看门狗同思路）。
  watchdog = window.setTimeout(() => {
    if (endedLocal) return;
    stopLoop();
    if (isDissolve) {
      cleanupAfterHide();
      onDone();
    } else {
      finishMaterialize();
      onDone();
    }
  }, duration + 600);

  // 返回“立即中止”句柄（cancelFlame 调用）：停帧、移除覆盖层、复原页面样式。
  // 中止 = 保持窗口可见（呼出打断关闭 / 关闭打断呼出都走这里）。
  return () => {
    stopLoop();
    restoreRoot(root);
    try {
      canvas.remove();
      sparkCanvas.remove();
    } catch {
      /* ignore */
    }
  };
}
