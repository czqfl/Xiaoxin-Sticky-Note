import { loadSettings, saveSettings, saveMdCustom, openFile, startDragging, setAcrylic } from "./api";
import { applyGlassBlur, parseColorToRgbInt } from "./glass";
import { applyPanelBackground } from "./panel-bg";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./types";

/* ===== 自定义下拉皮肤：用 div 包裹原生 <select>，使选项列表背景完全由本程序 CSS
   变量控制——彻底摆脱 WebView2 原生 <option> 永远白底（其弹出列表跟随 Windows 系统
   明暗主题）的局限。原生 <select> 仍保留在 DOM 中承担取值/change 事件，仅被视觉隐藏。 */
let openCs: { close: () => void; wrap: HTMLElement } | null = null;
let csDocBound = false;

function ensureCsDocEvents() {
  if (csDocBound) return;
  csDocBound = true;
  document.addEventListener("mousedown", (e) => {
    if (openCs && !openCs.wrap.contains(e.target as Node)) openCs.close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openCs) openCs.close();
  });
}

function enhanceSelect(native: HTMLSelectElement) {
  if (native.parentElement?.classList.contains("cs")) return; // 已增强
  ensureCsDocEvents();

  const wrap = document.createElement("div");
  wrap.className = "cs";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cs-trigger";
  const label = document.createElement("span");
  label.className = "cs-text";
  const caret = document.createElement("span");
  caret.className = "cs-caret";
  caret.textContent = "▾";
  trigger.append(label, caret);

  const panel = document.createElement("div");
  panel.className = "cs-panel";
  const list = document.createElement("div");
  list.className = "cs-list";
  panel.appendChild(list);
  wrap.append(trigger, panel);

  native.parentNode?.insertBefore(wrap, native);
  wrap.appendChild(native);
  native.classList.add("cs-native");

  function onAutoClose() {
    api.close();
  }

  const api = {
    wrap,
    close() {
      wrap.classList.remove("open");
      window.removeEventListener("scroll", onAutoClose, true);
      window.removeEventListener("resize", onAutoClose);
      if (openCs === api) openCs = null;
    },
  };

  function makeItem(o: HTMLOptionElement) {
    const item = document.createElement("div");
    item.className = "cs-item";
    item.textContent = o.textContent;
    item.dataset.value = o.value;
    item.addEventListener("click", () => {
      native.value = o.value;
      native.dispatchEvent(new Event("change")); // 触发 renderKeys/syncMdCustomRow 等原生监听
      api.close();
      refresh();
    });
    return item;
  }

  function buildList() {
    list.innerHTML = "";
    const groups = native.querySelectorAll("optgroup");
    if (groups.length) {
      groups.forEach((g) => {
        const gh = document.createElement("div");
        gh.className = "cs-group";
        gh.textContent = g.label;
        list.appendChild(gh);
        g.querySelectorAll("option").forEach((o) => list.appendChild(makeItem(o)));
      });
    } else {
      native.querySelectorAll("option").forEach((o) => list.appendChild(makeItem(o)));
    }
  }

  function refresh() {
    const sel = native.options[native.selectedIndex];
    label.textContent = sel ? sel.textContent : "";
    list.querySelectorAll<HTMLElement>(".cs-item").forEach((it) => {
      it.classList.toggle("selected", it.dataset.value === native.value);
    });
  }

  function openPanel() {
    if (openCs && openCs !== api) openCs.close();
    buildList();
    refresh();
    wrap.classList.add("open");
    // fixed 定位，脱离 .settings-modal 的 overflow 裁剪；靠近窗口底边时向上弹出
    const r = trigger.getBoundingClientRect();
    panel.style.width = r.width + "px";
    panel.style.left = r.left + "px";
    const ph = panel.offsetHeight;
    const below = window.innerHeight - r.bottom - 4;
    panel.style.top = ph <= below ? r.bottom + 4 + "px" : Math.max(4, r.top - 4 - ph) + "px";
    panel.scrollTop = 0;
    openCs = api;
    window.addEventListener("scroll", onAutoClose, true);
    window.addEventListener("resize", onAutoClose);
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (wrap.classList.contains("open")) api.close();
    else openPanel();
  });

  refresh();
}

export const SHORTCUT_ACTIONS: { key: string; label: string }[] = [
  { key: "fg_color", label: "字体颜色" },
  { key: "bg_color", label: "字体背景色" },
  { key: "size_up", label: "增大字号" },
  { key: "size_down", label: "减小字号" },
  { key: "translate", label: "翻译" },
  { key: "show_app", label: "呼出便签（全局）" },
  { key: "close_all", label: "全部关闭（全局）" },
  { key: "new_note", label: "新建便签（全局）" },
];

export const PROVIDERS: { value: string; label: string }[] = [
  { value: "mymemory", label: "MyMemory（免密钥，开箱即用）" },
  { value: "baidu", label: "百度翻译" },
  { value: "youdao", label: "有道翻译" },
];

export const TARGET_LANGUAGES: { value: string; label: string }[] = [
  { value: "zh", label: "中文" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日文" },
  { value: "ko", label: "韩文" },
  { value: "fr", label: "法文" },
  { value: "de", label: "德文" },
  { value: "es", label: "西班牙文" },
  { value: "ru", label: "俄文" },
  { value: "it", label: "意大利文" },
  { value: "pt", label: "葡萄牙文" },
  { value: "ar", label: "阿拉伯文" },
];

/** 把存储的毛玻璃强度统一规范为 0~100 的整数百分比。
 *  旧版本以 px（4~40）存储，这里做兼容迁移：>100 视为旧 px 值换算成百分比。 */
export function normalizeGlassPct(v: number | undefined | null): number {
  if (typeof v !== "number" || Number.isNaN(v)) return 55;
  if (v > 100) return Math.round((v / 40) * 100); // 旧 px -> 百分比（40px ≈ 100%）
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** 把存储的“背景不透明度”统一规范为 0~100 的整数百分比（透明主题原生亚克力着色层）。 */
export function normalizeOpacity(v: number | undefined | null): number {
  if (typeof v !== "number" || Number.isNaN(v)) return 65;
  return Math.max(0, Math.min(100, Math.round(v)));
}

let cached: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (!cached) {
    const raw = (await withTimeout(loadSettings(), 8000, "load_settings")) as Settings & { bg_transparent?: boolean };
    // 迁移：旧版 bg_transparent 透明开关统一收归为 theme:"transparent"（幂等）
    if (raw.bg_transparent === true && raw.theme !== "transparent") {
      raw.theme = "transparent";
      delete raw.bg_transparent;
      try {
        await saveSettings(raw as Settings);
      } catch (e) {
        console.error("迁移透明设置失败:", e);
      }
    }
    cached = raw as Settings;
  }
  return cached;
}

/** 同步读取快捷键，设置未加载完时返回空串 */
export function getShortcut(action: string): string {
  return cached?.shortcuts?.[action] ?? "";
}

export function getProviderLabel(value: string): string {
  return PROVIDERS.find((p) => p.value === value)?.label.split("（")[0] ?? value;
}

// 所有便签窗口（独立 webview）共享同一份设置缓存；任一窗口修改设置后都会注册
// 监听器，收到变更时从磁盘重新读取并回调，实现全局同步（解决“改了背景只有当前便签生效”）。
const listeners: Array<() => void> = [];
let globalListenerRegistered = false;

/** 从磁盘重新加载设置并通知所有监听器（主题 / 背景 / 快捷键等联动） */
async function notifyChanged(): Promise<void> {
  try {
    cached = await withTimeout(loadSettings(), 8000, "notifyChanged load_settings");
  } catch (e) {
    console.error("重新读取设置失败:", e);
  }
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      console.error("设置变更回调出错:", e);
    }
  }
}

/** 注册“设置变更”监听器：会被后端广播的全局事件（settings-changed）与窗口内事件共同触发 */
export function onSettingsChanged(cb: () => void): void {
  listeners.push(cb);
  if (!globalListenerRegistered) {
    globalListenerRegistered = true;
    // 后端保存设置后会向所有窗口广播该事件，保证其它已打开便签窗口也同步刷新
    listen("settings-changed", () => {
      notifyChanged();
    }).catch((e) => console.error("监听 settings-changed 失败:", e));
  }
}

/**
 * 用一份新的完整设置覆盖模块内缓存，并派发变更事件，通知所有监听者（如便签窗口的
 * 主题联动）。供“标题栏一键切换主题”等场景在不经过本弹窗时更新全局配置缓存。
 */
export function setSettings(next: Settings): void {
  cached = JSON.parse(JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
}

const SETTINGS_EVENT = "stickynote-settings-changed";
// 窗口内事件（如标题栏一键切换主题、重新载入 Markdown 样式）也走同一刷新流程
if (typeof window !== "undefined") {
  window.addEventListener(SETTINGS_EVENT, () => {
    notifyChanged();
  });
}

/** 读取图片文件为 data URL */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * 读取图片、限制最长边（默认 1920px）后转 data URL，避免背景图体积过大。
 * 关键点：始终经过 canvas 重编码（小图也不再原样返回），不透明图统一压成 JPEG（体积小），
 * 仅当 PNG/WebP 确实含透明像素时才保留 PNG，从而把任意来源图片压到几百 KB 以内。
 */
async function fileToDataUrlScaled(file: File, maxEdge = 1920): Promise<string> {
  const raw = await fileToDataUrl(file);
  return await new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(raw);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      // 检测是否含透明像素（仅对可能带透明的格式检测）
      let hasAlpha = false;
      if (file.type === "image/png" || file.type === "image/webp") {
        const data = ctx.getImageData(0, 0, w, h).data;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 255) {
            hasAlpha = true;
            break;
          }
        }
      }
      const out = hasAlpha
        ? canvas.toDataURL("image/png")
        : canvas.toDataURL("image/jpeg", 0.82);
      resolve(out);
    };
    img.onerror = () => reject(new Error("图片解析失败"));
    img.src = raw;
  });
}

/** 将一次按键事件解析为快捷键组合字符串，仅修饰键时返回 null */
function eventToCombo(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") {
    return null;
  }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  let main = "";
  if (e.code === "Equal") main = "Plus";
  else if (e.code === "Minus") main = "Minus";
  else if (e.code === "Space") main = "Space";
  else if (key.length === 1) main = key.toUpperCase();
  else main = key;
  parts.push(main);
  return parts.join("+");
}

/** 给一个 Promise 加超时，超时后自动拒绝，防止 IPC 调用无限挂起 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("IPC 调用超时：" + label)), ms),
    ),
  ]);
}

/** 设置面板的兜底默认值（独立窗口读取设置失败/超时时使用，保证面板可渲染、可操作） */
function defaultSettings(): Settings {
  return {
    theme: "light",
    shortcuts: {},
    translation_provider: "mymemory",
    target_when_cjk: "en",
    target_when_latin: "zh",
    md_theme: "default",
    edge_snap: true,
    bg_immersive: false,
    glass_enabled: true,
    glass_blur: 55,
    transparent_opacity: 65,
    particle_count: 50,
    particle_mode: "particle",
  } as Settings;
}

export async function openSettingsModal(): Promise<void> {
  const existing = document.getElementById("settings-overlay");
  if (existing) existing.remove();

  // 独立“设置”窗口：面板铺满窗口、无暗色遮罩（窗口自带系统标题栏与关闭按钮）
  let standalone = false;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    standalone = getCurrentWindow().label === "settings";
  } catch {
    /* 忽略 */
  }

  // 立即挂载浮层骨架
  const overlay = document.createElement("div");
  overlay.className = "settings-overlay" + (standalone ? " settings-standalone" : "");
  overlay.id = "settings-overlay";
  overlay.innerHTML = `
    <div class="settings-modal settings-layout">
      <div class="settings-header"><span class="settings-title">设置</span></div>
      <div class="settings-body"><p class="settings-tip">加载中…</p></div>
    </div>`;
  document.body.appendChild(overlay);

  // 同步先把面板画出来——"加载中"仅闪现一瞬间，用户立即可见全部 UI
  const initial: Settings = (cached as Settings | null) ?? defaultSettings();
  let dirty = false;

  // 把当前主题映射到 documentElement 的 CSS 主题类：透明主题与便签保持一致用
  // theme-dark（深色背景变量 + 浅色文字）；theme-transparent 在 styles.css 未定义任何
  // 变量，会回退到浅色（白底），正是“透明主题下设置面板一片白”的根因。
  // 切换主题（themeSel change）与初次 paint 都必须调用，否则独立设置窗口缺深色类。
  const THEME_ROOT_CLASSES = [
    "theme-dark", "theme-dracula", "theme-nord", "theme-gruvbox",
    "theme-onedark", "theme-catppuccin", "theme-tokyonight",
    "theme-solarized-light", "theme-ayu", "theme-sakura", "theme-everforest",
    "theme-transparent",
  ];
  function syncRootTheme(theme: string) {
    const root = document.documentElement;
    root.classList.remove(...THEME_ROOT_CLASSES);
    if (theme === "dark" || theme === "transparent") {
      root.classList.add("theme-dark");
    } else if (theme !== "light") {
      root.classList.add("theme-" + theme);
    }
  }

  function paint(s: Settings) {
  const draft: Settings = JSON.parse(JSON.stringify(s));

  // 独立“设置”窗口：把当前主题套用到 documentElement，让面板使用用户实际的主题色。
  // 否则独立窗口没有 .note-window，主题 CSS 变量（--bg 等）取不到，整页会一片白。
  syncRootTheme(draft.theme || "light");

  try {
    overlay.innerHTML = `
    <div class="settings-modal settings-layout">
      <div class="settings-header">
        <span class="settings-title">设置</span>
        <button class="icon-btn close" id="set-close" title="关闭">\u2715</button>
      </div>
      <div class="settings-body settings-layout-body">
        <div class="settings-content" id="settings-content">
          <section class="settings-pane active" id="pane-shortcuts">
            <div class="settings-section">
              <h3 class="settings-h3">快捷键</h3>
              <p class="settings-tip">点击"录制"后按下组合键，电脑会实时识别，再点"确定"录入。</p>
              <div class="shortcut-list" id="shortcut-list"></div>
            </div>
          </section>

          <section class="settings-pane active" id="pane-translate">
            <div class="settings-section">
              <h3 class="settings-h3">翻译</h3>
              <div class="settings-row">
                <label class="settings-label">翻译方式</label>
                <select class="settings-select" id="set-provider"></select>
              </div>
              <div id="provider-keys"></div>
            </div>
          </section>

          <section class="settings-pane active" id="pane-lang">
            <div class="settings-section">
              <h3 class="settings-h3">自动语言方向</h3>
              <p class="settings-tip">目标语言选"自动"时按输入语种自动选目标；翻译时也可在翻译区直接选指定语言。</p>
              <div class="settings-row">
                <label class="settings-label">中文译为</label>
                <select class="settings-select" id="set-target-cjk"></select>
              </div>
              <div class="settings-row">
                <label class="settings-label">外文译为</label>
                <select class="settings-select" id="set-target-latin"></select>
              </div>
            </div>
          </section>

          <section class="settings-pane active" id="pane-llm">
            <div class="settings-section">
              <h3 class="settings-h3">大模型（整理格式）</h3>
              <p class="settings-tip">用于工具栏「MD / 文本」按钮：调用大模型把便签内容整理为干净的 Markdown 或纯文本。兼容 OpenAI 及任意 OpenAI 格式接口（DeepSeek、通义、智谱等）。</p>
              <div class="settings-row">
                <label class="settings-label">Base URL</label>
                <input class="settings-input" id="set-llm-base" placeholder="https://api.openai.com/v1">
              </div>
              <div class="settings-row">
                <label class="settings-label">API Key</label>
                <input class="settings-input" id="set-llm-key" type="password" placeholder="sk-...">
              </div>
              <div class="settings-row">
                <label class="settings-label">模型名</label>
                <input class="settings-input" id="set-llm-model" placeholder="gpt-4o-mini">
              </div>
            </div>
          </section>

          <section class="settings-pane active" id="pane-theme">
            <div class="settings-section">
              <h3 class="settings-h3">主题与窗口</h3>
              <div class="settings-row">
                <label class="settings-label">主题</label>
                <select class="settings-select" id="set-theme"></select>
                <span class="theme-preview" id="theme-preview"></span>
              </div>
              <label class="settings-check"><input type="checkbox" id="set-edge-snap"> 贴边自动收起 / 弹出（QQ 风格）</label>
              <div class="settings-row" id="particle-count-row">
                <label class="settings-label">粒子数量</label>
                <input type="range" id="particle-count" min="0" max="100" step="1" value="50">
                <span class="settings-val" id="particle-count-val">50</span>
              </div>
              <div class="settings-row">
                <label class="settings-label">动画效果</label>
                <select class="settings-select" id="set-particle-mode">
                  <option value="particle">粒子消散</option>
                  <option value="inhale">粒子吸入</option>
                  <option value="erode">火焰侵蚀</option>
                </select>
              </div>
            </div>
          </section>

          <section class="settings-pane active" id="pane-bg">
            <div class="settings-section">
              <h3 class="settings-h3">背景与高斯模糊</h3>
              <p class="settings-tip" id="bg-mode-tip">选一张图片作为便签的全局默认背景；若单张便签已设置自己的背景，则优先用它的。透明主题下背景图片不生效。</p>
              <div class="settings-row bg-img-row is-mode-sensitive" id="bg-img-controls">
                <label class="settings-label">背景图片</label>
                <button class="shortcut-rec" id="bg-upload" type="button">选择图片</button>
                <input type="file" id="bg-file" accept="image/*" class="hidden-file">
                <button class="shortcut-rec" id="bg-clear" type="button">清除</button>
              </div>
              <div class="bg-img-preview" id="bg-preview"></div>
              <label class="settings-check is-mode-sensitive" id="bg-immersive-row"><input type="checkbox" id="set-bg-immersive"> 背景沉浸（标题栏、工具栏也透出背景）</label>
              <div class="settings-divider"></div>
              <label class="settings-check is-mode-sensitive" id="glass-chk-row"><input type="checkbox" id="set-glass"> 高斯模糊效果</label>
              <div class="settings-row is-mode-sensitive" id="glass-blur-row">
                <label class="settings-label">高斯模糊强度</label>
                <input type="range" id="glass-blur" min="0" max="100" step="1" value="55">
                <span class="settings-val" id="glass-blur-val">55%</span>
              </div>
              <!-- 透明主题专用：原生亚克力“背景不透明度”（等价 PowerShell 设置的同名滑块） -->
              <div class="settings-row is-mode-sensitive" id="trans-opacity-row" style="display:none">
                <label class="settings-label">背景不透明度</label>
                <input type="range" id="trans-opacity" min="0" max="100" step="1" value="65">
                <span class="settings-val" id="trans-opacity-val">65%</span>
              </div>
              <p class="settings-tip bg-mode-note" id="bg-mode-note" style="display:none"></p>
            </div>
          </section>

          <section class="settings-pane active" id="pane-storage">
            <div class="settings-section">
              <h3 class="settings-h3">便签存储路径</h3>
              <p class="settings-tip">每个便签均保存为独立 JSON 文件（位于此目录下，可在资源管理器中用记事本打开查看）。修改路径并保存后，原有便签会自动迁移到新目录。</p>
              <div class="settings-row notes-dir-row">
                <label class="settings-label">存储目录</label>
                <button class="shortcut-rec" id="notes-dir-browse" type="button">浏览</button>
                <button class="shortcut-rec" id="notes-dir-open" type="button">打开</button>
                <button class="shortcut-rec" id="notes-dir-reset" type="button">恢复默认</button>
              </div>
              <p class="settings-tip notes-dir-effective" id="notes-dir-effective"></p>
            </div>
          </section>

          <section class="settings-pane active" id="pane-md">
            <div class="settings-section">
              <h3 class="settings-h3">Markdown 样式</h3>
              <p class="settings-tip">设置 Markdown 便签的渲染风格；选"自定义"可上传自己的 CSS 样式文件，样式仅作用于预览区。</p>
              <div class="settings-row">
                <label class="settings-label">主题</label>
                <select class="settings-select" id="set-md-theme"></select>
              </div>
              <div class="settings-row" id="md-custom-row" style="display:none">
                <label class="settings-label">自定义</label>
                <button class="shortcut-rec" id="md-upload" type="button">上传/替换</button>
                <input type="file" id="md-file" accept=".css,text/css" class="hidden-file">
                <span class="settings-tip md-filename" id="md-filename"></span>
                <button class="shortcut-rec" id="md-edit" type="button" style="display:none">编辑</button>
                <button class="shortcut-rec" id="md-reload" type="button" style="display:none">重载</button>
              </div>
            </div>
          </section>
        </div>
      </div>
      <div class="settings-footer">
        <span class="settings-msg" id="set-msg"></span>
        <button class="btn-primary" id="set-save">应用</button>
      </div>
    </div>
  `;
  } catch (e) {
    console.error("设置面板 HTML 渲染失败:", e);
    // 兜底：显示错误信息而非白屏
    const body = overlay.querySelector(".settings-body");
    if (body) {
      body.innerHTML = `<p class="settings-tip" style="color:#c0392b">设置面板渲染失败：${String((e as Error)?.message || e)}</p>`;
    }
    return; // 不再继续绑定事件
  }

  // 独立窗口兜底：modal 加内联背景色/文字色，即便 styles.css 变量失效也绝不白板

  // ---- 单栏堆叠布局，无需左侧菜单 ----

  const list = overlay.querySelector("#shortcut-list") as HTMLDivElement | null;
  const msg = overlay.querySelector("#set-msg") as HTMLSpanElement;

  if (!list) { console.error("设置面板缺少 #shortcut-list，渲染中止"); return; }

  // ---- 快捷键行 ----
  const recCleanup: Array<(abort?: boolean) => void> = [];

  SHORTCUT_ACTIONS.forEach((action) => {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.innerHTML = `
      <span class="shortcut-label">${action.label}</span>
      <span class="shortcut-combo" data-action="${action.key}">${draft.shortcuts[action.key] || "未设置"}</span>
      <button class="shortcut-rec" data-action="${action.key}">录制</button>
      <button class="shortcut-confirm" data-action="${action.key}" style="display:none">确定</button>
    `;
    list.appendChild(row);

    const comboEl = row.querySelector(".shortcut-combo") as HTMLElement;
    const recBtn = row.querySelector(".shortcut-rec") as HTMLButtonElement;
    const confirmBtn = row.querySelector(".shortcut-confirm") as HTMLButtonElement;
    let pending: string | null = null;
    let recording = false;

    function stopRecording(abort = false) {
      if (!recording) return;
      recording = false;
      document.removeEventListener("keydown", onKey, true);
      recCleanup.splice(recCleanup.indexOf(stopRecording), 1);
      recBtn.textContent = "录制";
      recBtn.classList.remove("recording");
      confirmBtn.style.display = "none";
      if (abort) {
        pending = null;
        comboEl.textContent = draft.shortcuts[action.key] || "未设置";
        comboEl.classList.remove("listening");
      }
    }

    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        stopRecording(true);
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) return; // 仅修饰键，继续等待
      pending = combo;
      comboEl.textContent = `已识别：${combo}（点“确定”保存）`;
      comboEl.classList.add("listening");
      confirmBtn.style.display = "";
    }

    recBtn.addEventListener("click", () => {
      if (recording) {
        stopRecording(true);
        return;
      }
      recording = true;
      pending = null;
      comboEl.textContent = "请按下快捷键组合…";
      comboEl.classList.add("listening");
      recBtn.textContent = "停止";
      recBtn.classList.add("recording");
      confirmBtn.style.display = "none";
      document.addEventListener("keydown", onKey, true);
      recCleanup.push(() => stopRecording(true));
    });

    confirmBtn.addEventListener("click", () => {
      if (pending) {
        draft.shortcuts[action.key] = pending;
        comboEl.textContent = pending;
        comboEl.classList.remove("listening");
        pending = null;
      }
      stopRecording(false);
    });
  });

  // ---- 翻译方式 + 密钥 ----
  const providerSel = overlay.querySelector("#set-provider") as HTMLSelectElement;
  const keysBox = overlay.querySelector("#provider-keys") as HTMLDivElement;

  PROVIDERS.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.value;
    opt.textContent = p.label;
    providerSel.appendChild(opt);
  });
  providerSel.value = draft.translation_provider;

  function renderKeys() {
    const v = providerSel.value;
    if (v === "baidu") {
      keysBox.innerHTML = `
        <div class="settings-row">
          <label class="settings-label">AppID</label>
          <input class="settings-input" id="k-baidu-appid" value="${draft.baidu_appid}">
        </div>
        <div class="settings-row">
          <label class="settings-label">密钥</label>
          <input class="settings-input" id="k-baidu-key" type="password" value="${draft.baidu_key}">
        </div>`;
    } else if (v === "youdao") {
      keysBox.innerHTML = `
        <div class="settings-row">
          <label class="settings-label">AppKey</label>
          <input class="settings-input" id="k-youdao-appkey" value="${draft.youdao_appkey}">
        </div>
        <div class="settings-row">
          <label class="settings-label">密钥</label>
          <input class="settings-input" id="k-youdao-secret" type="password" value="${draft.youdao_secret}">
        </div>`;
    } else {
      keysBox.innerHTML = `<p class="settings-tip">MyMemory 无需密钥，直接可用。</p>`;
    }
  }
  providerSel.addEventListener("change", renderKeys);
  renderKeys();

  // ---- 自动语言方向 ----
  const targetCjkSel = overlay.querySelector("#set-target-cjk") as HTMLSelectElement;
  const targetLatinSel = overlay.querySelector("#set-target-latin") as HTMLSelectElement;

  function fillLangSelect(sel: HTMLSelectElement, value: string) {
    TARGET_LANGUAGES.forEach((l) => {
      const opt = document.createElement("option");
      opt.value = l.value;
      opt.textContent = l.label;
      sel.appendChild(opt);
    });
    // 已存值不在列表里时补一个选项，避免丢失
    if (value && !TARGET_LANGUAGES.some((l) => l.value === value)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value;
      sel.appendChild(opt);
    }
    sel.value = value || "en";
  }
  fillLangSelect(targetCjkSel, draft.target_when_cjk);
  fillLangSelect(targetLatinSel, draft.target_when_latin);

  // ---- Markdown 主题 ----
  const mdThemeSel = overlay.querySelector("#set-md-theme") as HTMLSelectElement;
  const mdCustomRow = overlay.querySelector("#md-custom-row") as HTMLElement;
  const mdUploadBtn = overlay.querySelector("#md-upload") as HTMLButtonElement;
  const mdFileInput = overlay.querySelector("#md-file") as HTMLInputElement;
  const mdFilename = overlay.querySelector("#md-filename") as HTMLElement;
  const mdEditBtn = overlay.querySelector("#md-edit") as HTMLButtonElement;
  const mdReloadBtn = overlay.querySelector("#md-reload") as HTMLButtonElement;

  const MD_THEMES: { value: string; label: string }[] = [
    { value: "default", label: "默认（暖色）" },
    { value: "github", label: "GitHub" },
    { value: "rose-pine", label: "玫瑰枯木（暗色）" },
    { value: "solarized", label: "Solarized（浅色）" },
    { value: "monokai", label: "Monokai（暗色）" },
    { value: "ayu-dark", label: "Ayu Dark（暗色）" },
    { value: "solarized-dark", label: "Solarized Dark（暗色）" },
    { value: "github-dark", label: "GitHub Dark（暗色）" },
    { value: "custom", label: "自定义（上传 CSS）" },
  ];
  MD_THEMES.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.value;
    opt.textContent = t.label;
    mdThemeSel.appendChild(opt);
  });
  mdThemeSel.value = draft.md_theme || "default";

  // 同步“自定义”行的可见性，以及已加载文件名 / 编辑·重载按钮
  const syncMdCustomRow = () => {
    const isCustom = mdThemeSel.value === "custom";
    mdCustomRow.style.display = isCustom ? "flex" : "none";
    const hasFile = !!(draft.md_custom_path && draft.md_custom_filename);
    mdFilename.textContent = hasFile ? `已加载：${draft.md_custom_filename}` : "";
    mdEditBtn.style.display = hasFile ? "" : "none";
    mdReloadBtn.style.display = hasFile ? "" : "none";
  };
  syncMdCustomRow();
  mdThemeSel.addEventListener("change", syncMdCustomRow);

  // ---- 外观主题（按 浅色 / 深色 分组，便于浏览）----
  const themeSel = overlay.querySelector("#set-theme") as HTMLSelectElement;
  const themePreview = overlay.querySelector("#theme-preview") as HTMLElement;
  const THEME_COLORS: Record<string, string> = {
    light: "#fffefb",
    transparent: "#a8c8ee",
    dark: "#2b2b2b",
  };
  function updateThemePreview(theme: string) {
    themePreview.style.background = THEME_COLORS[theme] || "#fffefb";
  }
  updateThemePreview(draft.theme || "light");
  const THEME_GROUPS: { label: string; items: { value: string; label: string }[] }[] = [
    {
      label: "浅色",
      items: [{ value: "light", label: "浅色（暖白）" }],
    },
    {
      label: "透明",
      items: [{ value: "transparent", label: "透明（高斯模糊）" }],
    },
    {
      label: "深色",
      items: [{ value: "dark", label: "深色（石墨）" }],
    },
  ];
  THEME_GROUPS.forEach((g) => {
    const og = document.createElement("optgroup");
    og.label = g.label;
    g.items.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.value;
      opt.textContent = t.label;
      og.appendChild(opt);
    });
    themeSel.appendChild(og);
  });
  themeSel.value = draft.theme || "light";

  // 用自定义皮肤包裹原生下拉，使选项列表背景跟随主题（原生 <option> 在 WebView2 下永远白底）
  enhanceSelect(providerSel);
  enhanceSelect(targetCjkSel);
  enhanceSelect(targetLatinSel);
  enhanceSelect(mdThemeSel);
  enhanceSelect(themeSel);

  // 透明主题实时预览：切到/切离透明时即时启停 DWM 实时模糊（零延迟）。
  // “背景不透明度”0% = 关闭 DWM 效果完全透明；>0% = 系统亚克力实时模糊 +
  // 主题色面板（上限 65%，始终透出磨砂感，不变成实心白板）。拖动滑块即刻生效。
  function previewPanel(): HTMLElement | null {
    return document.querySelector(".note-window") as HTMLElement | null;
  }
  /** 透明主题下：隐藏“高斯模糊强度/开关”与背景图片相关控件，显示“背景不透明度”；非透明则相反 */
  function syncTransparentControls(transparent: boolean) {
    const glassChkRow = overlay.querySelector("#glass-chk-row") as HTMLElement | null;
    const glassBlurRow = overlay.querySelector("#glass-blur-row") as HTMLElement | null;
    const transRow = overlay.querySelector("#trans-opacity-row") as HTMLElement | null;
    if (glassChkRow) glassChkRow.style.display = transparent ? "none" : "";
    if (glassBlurRow) glassBlurRow.style.display = transparent ? "none" : "";
    if (transRow) transRow.style.display = transparent ? "" : "none";
    const bgImgControls = overlay.querySelector("#bg-img-controls") as HTMLElement | null;
    const bgImmersiveRow = overlay.querySelector("#bg-immersive-row") as HTMLElement | null;
    if (bgImgControls) bgImgControls.style.display = transparent ? "none" : "";
    if (bgImmersiveRow) bgImmersiveRow.style.display = transparent ? "none" : "";
    const note = overlay.querySelector("#bg-mode-note") as HTMLElement | null;
    if (note) {
      note.style.display = transparent ? "" : "none";
      note.textContent = transparent
        ? "透明主题为实时磨砂（系统亚克力模糊背后桌面）：“背景不透明度”0% = 完全透明无模糊；越高磨砂感越强，最高保持玻璃感（面板跟随主题色，无白色蒙版）。"
        : "";
    }
  }
  /** 实时套用“背景不透明度”：低值（<2%）关闭 DWM 效果（完全透明），≥2% 开启并写
   *  主题色面板（--trans-opacity，0.6 × 滑块值，线性 0~60%）；SWCA tint 固定最小
   *  alpha（Rust 侧 alpha=1），滑块拖动即刻生效（不依赖 IPC）。独立窗口直接作用于设置面板。 */
  function applyAcrylicLive() {
    const o = normalizeOpacity(draft.transparent_opacity);
    const panel = standalone
      ? (overlay.querySelector(".settings-modal") as HTMLElement | null)
      : previewPanel();
    if (o < 2) {
      document.documentElement.style.setProperty("--trans-opacity", "0");
      if (panel) {
        panel.style.setProperty("--trans-opacity", "0");
        panel.classList.add("transparent-clear");
      }
      setAcrylic(false, 0, 0).catch(() => {});
      return;
    }
    const capped = Math.round(o * 0.6);
    document.documentElement.style.setProperty("--trans-opacity", String(capped));
    if (panel) {
      panel.style.setProperty("--trans-opacity", String(capped));
      panel.classList.remove("transparent-clear");
    }
    const tint =
      parseColorToRgbInt(
        panel ? getComputedStyle(panel).getPropertyValue("--bg") : null,
      ) ?? 0;
    setAcrylic(true, 1, tint).catch(() => {});
  }
  // 独立设置窗口：把当前设置（背景图 + 毛玻璃 / 原生亚克力）套用到设置面板自身，
  // 使其与便签窗口观感完全一致（背景图、模糊强度、透明主题实时磨砂同款）。
  // 仅在 standalone 模式生效；内嵌浮层（盖在便签上）由下方便签窗口负责背景，无需自绘。
  async function applyStandaloneBg() {
    if (!standalone) return;
    const modal = overlay.querySelector(".settings-modal") as HTMLElement | null;
    if (!modal) return;
    const s = draft;
    const transparent = s.theme === "transparent";
    if (transparent) {
      modal.classList.remove("has-bg", "on-dark-bg", "glass");
      modal.classList.add("bg-transparent");
      modal.style.removeProperty("--note-bg-img");
      modal.style.removeProperty("--note-bg-opacity");
      modal.style.removeProperty("--glass-blur");
      const o = normalizeOpacity(s.transparent_opacity);
      if (o < 2) {
        modal.classList.add("transparent-clear");
        modal.style.setProperty("--trans-opacity", "0");
        document.documentElement.style.setProperty("--trans-opacity", "0");
        setAcrylic(false, 0, 0).catch(() => {});
      } else {
        modal.classList.remove("transparent-clear");
        const capped = Math.round(o * 0.6);
        modal.style.setProperty("--trans-opacity", String(capped));
        document.documentElement.style.setProperty("--trans-opacity", String(capped));
        const tint = parseColorToRgbInt(getComputedStyle(modal).getPropertyValue("--bg")) ?? 0;
        setAcrylic(true, 1, tint).catch((e) => console.error("应用实时模糊失败:", e));
      }
    } else {
      modal.classList.remove("bg-transparent", "transparent-clear");
      modal.style.removeProperty("--trans-opacity");
      document.documentElement.style.removeProperty("--trans-opacity");
      setAcrylic(false, 0, 0).catch(() => {});
      await applyPanelBackground(modal, s);
      const hasBg = modal.classList.contains("has-bg");
      const pct = normalizeGlassPct(s.glass_blur);
      const enabled = s.glass_enabled !== false;
      applyGlassBlur({ target: modal, strength: hasBg ? pct : 0, enabled: hasBg && enabled });
    }
  }

  function applyTransparentPreview(transparent: boolean) {
    syncTransparentControls(transparent);
    if (standalone) { void applyStandaloneBg(); return; }
    const panel = previewPanel();
    if (transparent) {
      applyAcrylicLive();
      if (!panel) return;
      panel.classList.add("bg-transparent");
      panel.classList.remove("has-bg");
      panel.style.removeProperty("--note-bg-img");
      applyGlassBlur({ target: panel, strength: 0, enabled: false });
    } else {
      if (panel) {
        panel.classList.remove("bg-transparent");
        panel.style.removeProperty("--trans-opacity");
        panel.classList.remove("transparent-clear");
        applyGlassBlur({ target: panel, strength: 0, enabled: false });
      }
      setAcrylic(false, 0, 0).catch(() => {});
    }
  }
  themeSel.addEventListener("change", () => {
    // 切换主题时同步 documentElement 主题类：尤其切到 transparent 必须补 theme-dark，
    // 否则独立设置窗口缺深色变量 → 面板白底看不清（paint 之外的切换路径也会触发）。
    syncRootTheme(themeSel.value);
    updateThemePreview(themeSel.value);
    applyTransparentPreview(themeSel.value === "transparent");
    applyGlassLive(normalizeGlassPct(draft.glass_blur));
  });

  // ---- 靠边自动收起 ----
  const edgeSnapChk = overlay.querySelector("#set-edge-snap") as HTMLInputElement;
  edgeSnapChk.checked = draft.edge_snap !== false;
  const particleCountSlider = overlay.querySelector("#particle-count") as HTMLInputElement;
  const particleCountVal = overlay.querySelector("#particle-count-val") as HTMLElement;
  particleCountSlider.value = String(draft.particle_count ?? 50);
  particleCountVal.textContent = String(draft.particle_count ?? 50);
  particleCountSlider.addEventListener("input", () => {
    particleCountVal.textContent = particleCountSlider.value;
  });
  // ---- 动画效果：particle=粒子消散（仅关闭·默认·多点起爆向外扩散；呼出直接显示）、inhale=粒子吸入（呼出+关闭，向内汇聚，独立成项便于日后分化）、erode=火焰（呼出+关闭，橙黄火舌贴燃烧边；设置值 "erode" 为历史命名）----
  // 注意：必须先设置 value 再 enhanceSelect，否则自定义下拉的 label 会停在第一个选项上
  // （enhanceSelect 内部会立即按当前选中项渲染文本，后设 value 不会触发它重新同步）。
  const particleModeSel = overlay.querySelector("#set-particle-mode") as HTMLSelectElement;
  particleModeSel.value =
    draft.particle_mode === "erode" ? "erode" :
    draft.particle_mode === "inhale" ? "inhale" : "particle";
  enhanceSelect(particleModeSel);
  // ---- 粒子数量仅在「粒子吸入 / 粒子消散」时显示；火焰不使用该数值 ----
  const particleCountRow = overlay.querySelector("#particle-count-row") as HTMLElement;
  const syncParticleCountVisibility = () => {
    const show = particleModeSel.value !== "erode";
    particleCountRow.style.display = show ? "" : "none";
  };
  syncParticleCountVisibility();
  particleModeSel.addEventListener("change", syncParticleCountVisibility);

  // ---- 全局默认背景图 ----
  const bgUploadBtn = overlay.querySelector("#bg-upload") as HTMLButtonElement;
  const bgFileInput = overlay.querySelector("#bg-file") as HTMLInputElement;
  const bgClearBtn = overlay.querySelector("#bg-clear") as HTMLButtonElement;
  const bgPreview = overlay.querySelector("#bg-preview") as HTMLElement;
  const bgImmersiveChk = overlay.querySelector("#set-bg-immersive") as HTMLInputElement;

  bgImmersiveChk.checked = draft.bg_immersive === true;

  // 显示预览：draft.bg_image 现在是磁盘路径（旧数据可能是 data: URL，兼容）。
  async function renderBgPreview() {
    if (draft.bg_image) {
      try {
        const { readBgImage } = await import("./api");
        const url = draft.bg_image.startsWith("data:")
          ? draft.bg_image
          : await readBgImage(draft.bg_image);
        bgPreview.style.backgroundImage = `url("${url}")`;
        bgPreview.style.display = "block";
        bgPreview.classList.remove("no-bg");
        bgPreview.textContent = "";
      } catch (e) {
        bgPreview.style.display = "none";
      }
    } else {
      // 无背景图时显示占位
      bgPreview.style.display = "flex";
      bgPreview.classList.add("no-bg");
      bgPreview.style.backgroundImage = "";
      bgPreview.textContent = "未设置背景图";
    }
  }

  bgUploadBtn.addEventListener("click", () => {
    if (draft.theme === "transparent") {
      msg.textContent = "透明主题下无法设置背景图片，请先切到浅色/深色主题。";
      msg.classList.remove("ok");
      return;
    }
    bgFileInput.click();
  });
  bgFileInput.addEventListener("change", async () => {
    const file = bgFileInput.files && bgFileInput.files[0];
    if (!file) return;
    try {
      // 前端先压缩到合理体积，再交给后端落盘，只把“路径”存进 settings（避免 base64 过大）。
      const compressed = await fileToDataUrlScaled(file, 1920);
      const { saveBgImage } = await import("./api");
      draft.bg_image = await saveBgImage(compressed, "global");
      await renderBgPreview();
      if (standalone) void applyStandaloneBg();
      msg.textContent = "已选择背景图，点“保存”生效。";
      msg.classList.add("ok");
    } catch (e) {
      msg.textContent = "读取图片失败：" + String(e);
      msg.classList.remove("ok");
    }
  });
  bgClearBtn.addEventListener("click", async () => {
    const old = draft.bg_image;
    draft.bg_image = "";
    renderBgPreview();
    if (standalone) void applyStandaloneBg();
    if (old && !old.startsWith("data:")) {
      try {
        const { deleteBgImage } = await import("./api");
        await deleteBgImage(old);
      } catch (e) {
        console.error("删除旧背景图失败:", e);
      }
    }
    msg.textContent = "已清除背景图。";
    msg.classList.add("ok");
  });
  // 初始渲染时即显示已配置的背景图预览（否则重新打开设置时预览区是空白的）
  renderBgPreview();

  // ---- 毛玻璃强度（0~100%，透明背景与背景图片两种模式统一）----
  const glassChk = overlay.querySelector("#set-glass") as HTMLInputElement;
  const glassBlurInput = overlay.querySelector("#glass-blur") as HTMLInputElement;
  const glassBlurVal = overlay.querySelector("#glass-blur-val") as HTMLSpanElement;
  glassChk.checked = draft.glass_enabled !== false;
  glassBlurInput.value = String(normalizeGlassPct(draft.glass_blur));

  // 统一套用毛玻璃强度预览（与 note.ts 的 applyGlassEnabled 同一套映射，所见即所得）：
  // 透明主题与自定义背景共用同一条 CSS 模糊管线：0% 原图无模糊，100% 强模糊
  // （≈ MAX_BLUR_PX，几乎看不到轮廓），两模式效果一致。
  function applyGlassLive(pct: number) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    glassBlurVal.textContent = p + "%";
    const panel = standalone
      ? (overlay.querySelector(".settings-modal") as HTMLElement | null)
      : previewPanel();
    if (!panel || !panel.classList.contains("has-bg")) return;
    applyGlassBlur({ target: panel, strength: p, enabled: glassChk.checked });
  }
  glassChk.addEventListener("change", () => {
    draft.glass_enabled = glassChk.checked;
    applyGlassLive(normalizeGlassPct(draft.glass_blur));
  });
  glassBlurInput.addEventListener("input", () => {
    draft.glass_blur = Number(glassBlurInput.value);
    applyGlassLive(Number(glassBlurInput.value));
  });
  applyGlassLive(normalizeGlassPct(draft.glass_blur));

  // ---- 透明主题“背景不透明度”（原生亚克力着色层，PowerShell 设置同款滑块）----
  const transOpacityInput = overlay.querySelector("#trans-opacity") as HTMLInputElement;
  const transOpacityVal = overlay.querySelector("#trans-opacity-val") as HTMLSpanElement;
  transOpacityInput.value = String(normalizeOpacity(draft.transparent_opacity));
  transOpacityVal.textContent = normalizeOpacity(draft.transparent_opacity) + "%";
  transOpacityInput.addEventListener("input", () => {
    draft.transparent_opacity = Number(transOpacityInput.value);
    transOpacityVal.textContent = transOpacityInput.value + "%";
    applyAcrylicLive();
  });
  // 初始按当前主题同步控件可见性（透明主题隐藏强度配置、显示不透明度）并实时预览
  applyTransparentPreview(draft.theme === "transparent");

  // 上传/替换：读取 CSS 文本写入磁盘文件，并记录路径与原始文件名（立即持久化，确保记住）
  mdUploadBtn.addEventListener("click", () => mdFileInput.click());
  mdFileInput.addEventListener("change", async () => {
    const file = mdFileInput.files && mdFileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const path = await saveMdCustom(text);
      draft.md_custom_path = path;
      draft.md_custom_filename = file.name;
      draft.md_theme = "custom";
      mdThemeSel.value = "custom";
      syncMdCustomRow();
      msg.textContent = "已保存样式文件：" + file.name;
      msg.classList.add("ok");
      // 立即写入 settings.json，即便不点“保存”直接关掉弹窗也能记住该文件
      try {
        await saveSettings(draft);
        cached = JSON.parse(JSON.stringify(draft));
        window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
      } catch (e) {
        console.error("自动持久化设置失败:", e);
      }
    } catch (e) {
      msg.textContent = "保存样式文件失败：" + String(e);
      msg.classList.remove("ok");
    }
  });

  // 编辑文件：用系统默认程序打开磁盘上的 CSS 文件
  mdEditBtn.addEventListener("click", async () => {
    if (!draft.md_custom_path) return;
    try {
      await openFile(draft.md_custom_path);
      msg.textContent = "已用系统默认程序打开样式文件，编辑后点“重新载入”。";
      msg.classList.add("ok");
    } catch (e) {
      msg.textContent = "打开文件失败：" + String(e);
      msg.classList.remove("ok");
    }
  });

  // 重新载入：重新读取磁盘上的 CSS 文件并重渲染预览（外部编辑后生效）
  mdReloadBtn.addEventListener("click", async () => {
    try {
      window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
      msg.textContent = "已重新载入样式文件。";
      msg.classList.add("ok");
    } catch (e) {
      msg.textContent = "重新载入失败：" + String(e);
      msg.classList.remove("ok");
    }
  });

  // ---- 大模型（整理格式）----
  const llmBase = overlay.querySelector("#set-llm-base") as HTMLInputElement;
  const llmKey = overlay.querySelector("#set-llm-key") as HTMLInputElement;
  const llmModel = overlay.querySelector("#set-llm-model") as HTMLInputElement;
  llmBase.value = draft.llm_base_url || "";
  llmKey.value = draft.llm_api_key || "";
  llmModel.value = draft.llm_model || "";

  // ---- 便签存储路径 ----
  // 存储目录不再提供手动输入框（不可输入且无用），改用浏览选择；用变量暂存当前所选路径
  let notesDirValue = draft.notes_dir || "";
  const notesDirBrowse = overlay.querySelector("#notes-dir-browse") as HTMLButtonElement;
  const notesDirOpen = overlay.querySelector("#notes-dir-open") as HTMLButtonElement;
  const notesDirReset = overlay.querySelector("#notes-dir-reset") as HTMLButtonElement;
  const notesDirEffective = overlay.querySelector("#notes-dir-effective") as HTMLElement;

  // 始终显示“实际生效”的存储目录，避免空输入框看起来像 bug
  async function refreshNotesDirEffective() {
    try {
      const { effectiveNotesDir } = await import("./api");
      notesDirEffective.textContent = "实际存储位置：" + (notesDirValue || (await effectiveNotesDir()));
    } catch (e) {
      notesDirEffective.textContent = "";
    }
  }
  refreshNotesDirEffective();

  notesDirBrowse.addEventListener("click", async () => {
    try {
      const { selectFolder } = await import("./api");
      const dir = await selectFolder();
      if (dir) {
        notesDirValue = dir;
        msg.textContent = "已选择目录：" + dir;
        msg.classList.add("ok");
        refreshNotesDirEffective();
      }
    } catch (e) {
      msg.textContent = "选择目录失败：" + String(e);
      msg.classList.remove("ok");
    }
  });
  notesDirOpen.addEventListener("click", async () => {
    const dir = notesDirValue || (draft.notes_dir || "");
    if (!dir) {
      msg.textContent = "当前使用默认目录，请先浏览保存后再打开。";
      msg.classList.remove("ok");
      return;
    }
    try {
      const { openFolder } = await import("./api");
      await openFolder(dir);
    } catch (e) {
      msg.textContent = "打开目录失败：" + String(e);
      msg.classList.remove("ok");
    }
  });
  notesDirReset.addEventListener("click", () => {
    notesDirValue = "";
    msg.textContent = "已恢复默认存储目录。";
    msg.classList.add("ok");
    refreshNotesDirEffective();
  });

  // ---- 关闭 ----
  async function close() {
    document.removeEventListener("keydown", onEscKey);
    recCleanup.forEach((fn) => fn());
    overlay.remove();
    // 设置面板运行在独立“设置”窗口里：关闭面板即关闭窗口
    // （后端 close_window 对 settings 标签真正销毁窗口，对便签窗口只是隐藏）。
    try {
      const { closeWindow } = await import("./api");
      await closeWindow();
    } catch (e) {
      console.error("关闭设置窗口失败:", e);
    }
  }
  // Esc 关闭设置面板：若自定义下拉正打开则先关下拉，否则关闭面板
  const onEscKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (openCs) { openCs.close(); return; }
    close();
  };
  document.addEventListener("keydown", onEscKey);
  (overlay.querySelector("#set-close") as HTMLButtonElement).addEventListener("click", close);
  // 独立“设置”窗口里整窗就是面板本体，不存在“点遮罩关闭”的概念。
  // 旧写法按 e.target === overlay 判断，会把窗口四周的空白边缘（16px padding 区）
  // 误当成遮罩点击，导致“抓窗口边缘/标题栏想拖动”时面板直接关闭。
  overlay.addEventListener("mousedown", (e) => {
    if (!standalone && e.target === overlay) close();
  });
  // 独立窗口无系统标题栏：把设置面板头部（除 ✕ 按钮）做成拖动区域（与历史窗口一致），
  // 按住头部即可拖动整个设置窗口。
  (overlay.querySelector(".settings-header") as HTMLElement | null)?.addEventListener(
    "mousedown",
    (e) => {
      if ((e.target as HTMLElement).closest(".icon-btn, input, select, textarea")) return;
      startDragging().catch(() => {});
    },
  );

  // 标记用户已手动改动，避免异步刷新覆盖其输入
  overlay.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea").forEach((el) => {
    el.addEventListener("input", () => { dirty = true; });
    el.addEventListener("change", () => { dirty = true; });
  });

  // ---- 应用（原“保存”）：点击立即生效配置，但面板保持打开，可连续调整对比 ——
  (overlay.querySelector("#set-save") as HTMLButtonElement).addEventListener("click", async () => {
    draft.translation_provider = providerSel.value;
    if (draft.translation_provider === "baidu") {
      draft.baidu_appid = (overlay.querySelector("#k-baidu-appid") as HTMLInputElement)?.value ?? "";
      draft.baidu_key = (overlay.querySelector("#k-baidu-key") as HTMLInputElement)?.value ?? "";
    } else if (draft.translation_provider === "youdao") {
      draft.youdao_appkey = (overlay.querySelector("#k-youdao-appkey") as HTMLInputElement)?.value ?? "";
      draft.youdao_secret = (overlay.querySelector("#k-youdao-secret") as HTMLInputElement)?.value ?? "";
    }
    draft.target_when_cjk = targetCjkSel.value;
    draft.target_when_latin = targetLatinSel.value;
    draft.md_theme = mdThemeSel.value;
    draft.theme = themeSel.value;
    draft.edge_snap = edgeSnapChk.checked;
    draft.particle_count = Number(particleCountSlider.value);
    draft.particle_mode = (overlay.querySelector("#set-particle-mode") as HTMLSelectElement).value;
    draft.llm_base_url = llmBase.value.trim();
    draft.llm_api_key = llmKey.value.trim();
    draft.llm_model = llmModel.value.trim();
    draft.notes_dir = notesDirValue;
    draft.bg_immersive = bgImmersiveChk.checked;
    draft.glass_enabled = glassChk.checked;
    draft.glass_blur = Number(glassBlurInput.value);
    draft.transparent_opacity = Number(transOpacityInput.value);
    try {
      await saveSettings(draft);
      cached = JSON.parse(JSON.stringify(draft));
      refreshNotesDirEffective();
      // 重新注册全部全局快捷键（呼出 / 全部关闭 / 新建便签）
      try {
        const { registerShortcuts } = await import("./api");
        await registerShortcuts();
      } catch (e) {
        console.error("注册全局快捷键失败:", e);
      }
      msg.textContent = "已应用";
      msg.classList.add("ok");
      window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
    } catch (err) {
      msg.textContent = "应用失败：" + String(err);
      msg.classList.remove("ok");
    }
  });
    if (standalone) void applyStandaloneBg();
  } // ===== paint 函数结束 =====

  try {
    paint(initial); // 同步先画（缓存/默认值）：瞬间可见，绝不白屏
  } catch (e) {
    console.error("设置面板初始渲染失败:", e);
    const body = overlay.querySelector(".settings-body");
    if (body) {
      body.innerHTML = "";
      const p = document.createElement("p");
      p.className = "settings-tip";
      p.textContent = "设置面板加载失败：" + String((e as Error)?.message || e);
      body.appendChild(p);
    }
  }

  // 面板已同步渲染完成（含主题类与背景 class），此刻再让窗口可见，
  // 避免后端 build 后立刻 show 导致的首帧白/透明闪烁。
  if (standalone) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().show();
      await getCurrentWindow().setFocus();
    } catch (e) {
      console.error("显示设置窗口失败:", e);
    }
  }

  // 后台静默加载真实设置并刷新面板（用户已手动改动则不覆盖）。
  (async () => {
    try {
      const raw = await withTimeout(loadSettings(), 6000, "加载设置");
      if (!cached) cached = raw as Settings;
      const real = cached!;
      if (!dirty) {
        try { paint(real); } catch (e) { console.error("设置刷新失败:", e); }
      }
    } catch (e) {
      console.error("异步加载设置失败:", e);
    }
  })();
}
