import {
  loadNote,
  saveNote,
  setAlwaysOnTop,
  startDragging,
  createNoteWindow,
  openHistoryWindow,
  closeWindow,
  minimizeToTray,
  markNoteClosed,
  getOpenNotes,
  newNoteId,
  translate,
  readMdCustom,
  saveSettings,
  formatWithLLM,
  openSettingsWindow,
  setAcrylic,
} from "./api";
import { NoteData, Settings } from "./types";
import { renderMarkdown } from "./markdown";
import { DEFAULT_MD_CSS, DEFAULT_MD_CSS_DARK, getThemeCss, MD_BG_CSS } from "./md-style";
import { requestFlameDissolveClose, playFlameMaterialize, cancelFlame } from "./flame";
import { requestGlowDissolveClose, cancelGlowParticles, bumpGlowGen } from "./glow-particles";
import { requestInhaleDissolveClose, playInhaleMaterialize, cancelInhaleParticles } from "./glow-particles-inhale";
import { MAX_BLUR_PX, applyGlassBlur, parseColorToRgbInt } from "./glass";
import { applyPanelBackground } from "./panel-bg";
import {
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  currentMonitor,
} from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import {
  getSettings,
  getShortcut,
  onSettingsChanged,
  setSettings,
  TARGET_LANGUAGES,
  normalizeGlassPct,
  normalizeOpacity,
} from "./settings";

const SAVE_DELAY = 500;

// ---- 直观的单色图标（Lucide 风格，跟随文字颜色，见图知义）----
// 翻译：languages 图标（左侧“文”笔画 + 右侧 A，一眼看出是翻译）
const ICON_TRANSLATE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>`;
// 复制：clipboard-copy 图标（两个叠放的方框）
const ICON_COPY = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
// 复制成功：对勾
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
// 最大化：浏览器“框框”图标（四角外扩）
const ICON_MAX = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
// 还原（已最大化时显示）：两个重叠方框
const ICON_RESTORE = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>`;

export function mountNoteApp(noteId: string, preset = "") {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="note-window">
      <div class="titlebar">
        <div class="titlebar-left">
          <button class="icon-btn gear" id="btn-settings" title="设置">&#9881;</button>
          <input class="title-input" id="note-title" placeholder="便签" maxlength="40" spellcheck="false" title="点击编辑标题" />
          <span class="save-status" id="save-status"></span>
        </div>
        <div class="titlebar-grip" id="drag-grip" title="拖动便签"><span class="grip-dots"></span></div>
        <div class="titlebar-right">
          <button class="icon-btn" id="btn-history" title="历史便签">&#9776;</button>
          <button class="icon-btn" id="btn-new" title="新建便签">&#xff0b;</button>
          <button class="icon-btn" id="btn-pin" title="置顶" aria-pressed="true">
            <span class="nail" aria-hidden="true">
              <svg class="pin-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <rect x="6.5" y="3.2" width="11" height="6.8" rx="2.4" fill="currentColor"></rect>
                <path d="M10.4 10 H13.6 L12 21 Z" fill="currentColor"></path>
              </svg>
            </span>
          </button>
          <button class="icon-btn" id="btn-max" title="最大化">${ICON_MAX}</button>
          <button class="icon-btn" id="btn-tray" title="最小化到托盘">&#9661;</button>
          <button class="icon-btn close" id="btn-close" title="关闭">&#10005;</button>
        </div>
      </div>
      <div class="toolbar">
        <div class="tool-color wps" id="tool-fg-wrap" title="字体颜色">
          <button type="button" class="cc-main" id="tool-fg-apply" title="应用当前字体颜色">
            <span class="cc-letter">A</span>
            <span class="cc-bar" id="tool-fg-bar"></span>
          </button>
          <button type="button" class="cc-drop" id="tool-fg-drop" title="选择字体颜色">▾</button>
          <input type="color" class="color-swatch-input" id="tool-fg" value="#3a3a3a" title="选择颜色">
        </div>
        <div class="tool-color wps" id="tool-bg-wrap" title="背景颜色">
          <button type="button" class="cc-main cc-main-bg" id="tool-bg-apply" title="应用当前背景颜色">
            <span class="cc-letter">B</span>
            <span class="cc-bar" id="tool-bg-bar"></span>
          </button>
          <button type="button" class="cc-drop" id="tool-bg-drop" title="选择背景颜色">▾</button>
          <input type="color" class="color-swatch-input" id="tool-bg" value="#fffefb" title="选择背景色">
        </div>
        <div class="tool-color wps" id="tool-size-wrap" title="文字大小">
          <button type="button" class="cc-main" id="tool-size-main" title="选择文字大小">
            <span class="cc-letter ts-letter" aria-hidden="true">A</span>
            <span class="ts-num" id="tool-size-num">14</span>
          </button>
          <button type="button" class="cc-drop" id="tool-size-drop" title="选择字号">▾</button>
        </div>
        <button class="icon-btn active" id="btn-translate-toggle" title="显示翻译区">${ICON_TRANSLATE}</button>
        <div class="tool-md" id="tool-md" title="Markdown 预览模式">
          <button type="button" class="md-btn" id="btn-md-preview" title="Markdown 预览：把内容渲染为 Markdown">预览</button>
          <button type="button" class="md-btn" id="btn-md-split" title="拆分预览：左侧编辑、右侧实时预览">拆分</button>
        </div>
        <div class="tool-format" id="tool-format" title="用大模型整理格式（选择 Markdown / 纯文本）">
          <button type="button" class="md-btn" id="btn-fmt" title="调用大模型整理便签格式">整理</button>
        </div>
      </div>
      <div class="editor-area" id="editor-area">
        <div class="editor" id="editor" contenteditable="true" data-placeholder="写点什么..."></div>
        <iframe class="md-preview" id="md-preview"></iframe>
      </div>
      <div class="translate-panel" id="translate-panel">
        <div class="translate-resizer" id="translate-resizer" title="拖动调整翻译区高度">
          <span class="resizer-grip"><i class="rd"></i><i class="rd"></i><i class="rd"></i></span>
        </div>
        <div class="translate-head">
          <span class="translate-title">翻译</span>
          <div class="tr-fmt-wrap">
            <button class="tr-fmt-btn" id="btn-fmt-format" title="翻译格式（点击切换命名风格）">翻译格式 <span class="caret">▾</span></button>
            <div class="fmt-menu tr-fmt-menu hidden" id="fmt-format-menu">
              <button type="button" class="fmt-menu-item" data-fmt="default">默认</button>
              <button type="button" class="fmt-menu-item" data-fmt="snake">下划线 snake_case</button>
              <button type="button" class="fmt-menu-item" data-fmt="camel">驼峰 camelCase</button>
              <button type="button" class="fmt-menu-item" data-fmt="snake_abbr">缩写下划线（大模型）</button>
              <button type="button" class="fmt-menu-item" data-fmt="camel_abbr">缩写驼峰（大模型）</button>
            </div>
          </div>
          <select class="tr-target" id="tr-target" title="目标语言"></select>
          <button class="icon-btn" id="btn-translate" title="翻译输入框内容">${ICON_TRANSLATE}</button>
        </div>
        <div class="translate-body">
          <textarea class="translate-src" id="translate-src" placeholder="在此输入要翻译的内容，或在便签中选中文字后右键翻译…" rows="2"></textarea>
          <div class="translate-dst-box">
            <div class="translate-dst" id="translate-dst" contenteditable="true" data-placeholder="译文…"></div>
            <button class="icon-btn btn-copy" id="btn-copy" title="复制译文">${ICON_COPY}</button>
          </div>
        </div>
      </div>
      <div class="cc-panel" id="tool-fg-panel" hidden></div>
      <div class="cc-panel" id="tool-bg-panel" hidden></div>
      <div class="win-resizer" id="win-resizer" title="拖动调整窗口大小">
        <svg class="win-resizer-grip" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M2.5 9.5 L9.5 2.5 M5 12 L12 5 M0.5 6.5 L6.5 0.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </div>
    </div>
  `;

  const editor = document.getElementById("editor") as HTMLDivElement;
  const appWindow = getCurrentWindow();
  const titlebar = document.querySelector(".titlebar")!;
  const btnPin = document.getElementById("btn-pin")!;
  const btnNew = document.getElementById("btn-new")!;
  const btnHistory = document.getElementById("btn-history")!;
  const btnClose = document.getElementById("btn-close")!;
  const btnTray = document.getElementById("btn-tray")!;
  const btnSettings = document.getElementById("btn-settings")!;
  const titleInput = document.getElementById("note-title") as HTMLInputElement;
  const saveStatus = document.getElementById("save-status") as HTMLElement | null;
  // 关闭动画期间抑制「保存中/已保存」状态提示（关闭会触发一次保存，但不应打扰关闭过程）；
  // 呼出/正常编辑时恢复显示。
  let suppressSaveStatus = false;
  const btnTranslate = document.getElementById("btn-translate")!;
  const btnCopy = document.getElementById("btn-copy") as HTMLButtonElement;
  const toolFg = document.getElementById("tool-fg") as HTMLInputElement;
  const toolBg = document.getElementById("tool-bg") as HTMLInputElement;
  const toolFgApply = document.getElementById("tool-fg-apply") as HTMLButtonElement;
  const toolBgApply = document.getElementById("tool-bg-apply") as HTMLButtonElement;
  const toolSizeWrap = document.getElementById("tool-size-wrap") as HTMLElement;
  const toolSizeMain = document.getElementById("tool-size-main") as HTMLButtonElement;
  const toolSizeDrop = document.getElementById("tool-size-drop") as HTMLButtonElement;
  const toolSizeNum = document.getElementById("tool-size-num") as HTMLSpanElement;
  const btnTranslateToggle = document.getElementById("btn-translate-toggle")!;
  const btnMax = document.getElementById("btn-max")!;
  const editorArea = document.getElementById("editor-area") as HTMLElement;
  const mdPreview = document.getElementById("md-preview") as HTMLIFrameElement;
  const btnMdPreview = document.getElementById("btn-md-preview")!;
  const btnMdSplit = document.getElementById("btn-md-split")!;
  const btnFmt = document.getElementById("btn-fmt") as HTMLButtonElement;
  const translateSrc = document.getElementById("translate-src") as HTMLTextAreaElement;
  const translateDst = document.getElementById("translate-dst") as HTMLDivElement;
  const trTarget = document.getElementById("tr-target") as HTMLSelectElement;
  const btnFmtFormat = document.getElementById("btn-fmt-format") as HTMLButtonElement;
  const fmtFormatMenu = document.getElementById("fmt-format-menu") as HTMLElement;
  const noteWindow = document.querySelector(".note-window") as HTMLElement;
  const winResizer = document.getElementById("win-resizer") as HTMLElement;

  let current: NoteData = {
    content: "",
    title: "",
    translate: false,
    md: "none",
    pinned: true,
    created: Date.now(),
    updated: Date.now(),
    width: 420,
    height: 440,
  };
  let saveTimer: number | undefined;
  let sizeSaveTimer: number | undefined;
  let posSaveTimer: number | undefined;
  // 该便签是否已被删除（在历史列表中删除）。为 true 时停止一切保存，防止窗口失焦/尺寸
  // 变化把已删除的内容重新写回磁盘导致“复活”。用户重新输入内容时会自动解除。
  let deleted = false;
  let savedRange: Range | null = null;
  // 工具栏交互前捕获的选区（字符偏移量）。点击工具栏按钮会令编辑器失焦、
  // 选区可能被改写，所以先在 mousedown 捕获阶段记下来，上色/改字号时据此还原。
  let toolbarOff: { start: number; end: number } | null = null;
  const toolbar = document.querySelector(".toolbar")!;

  // 最大化/还原状态（手动最大化到监控器工作区，规避无边框透明窗口原生 maximize 不生效）
  let savedBounds: { x: number; y: number; w: number; h: number } | null = null;
  let isMaximizedState = false;
  // 程序化改尺寸（最大化/还原）期间，跳过把“最大化尺寸”写回便签
  let programmaticResize = false;

  // Markdown 主题（来自设置）：样式注入到预览 iframe 内部，不污染便签窗口
  // 最近一次渲染用的源文本（预览态编辑器隐藏，innerText 为空，故缓存以便主题切换时重渲染）
  let lastMdSource = "";

  // 拖拽：标题栏空白处（非按钮/输入框）可拖动
  titlebar.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".icon-btn, input, select, textarea")) return;
    startDragging();
  });

  // 标题栏自适应：窗口变窄时提前隐藏次级按钮（历史/新建），并把居中的抓取区域
  // 收缩成小号抓点，避免抓取区域与右侧按钮重叠（抓取点始终保留可见）。
  function adaptTitlebar() {
    titlebar.classList.remove("crowded");
    const overflow = titlebar.scrollWidth > titlebar.clientWidth + 1;
    titlebar.classList.toggle("crowded", overflow || titlebar.clientWidth < 380);
  }

  // 工具栏自适应：窗口变窄放不下时，隐藏“预览/拆分/整理”等次级按钮，避免被裁切成半截。
  // 测量前先移除 .crowded 以按“全部显示”的真实内容宽度判断，防止隐藏/显示来回抖动。
  function adaptToolbar() {
    toolbar.classList.remove("crowded");
    const overflow = toolbar.scrollWidth > toolbar.clientWidth + 1;
    toolbar.classList.toggle("crowded", overflow);
  }
  requestAnimationFrame(() => {
    adaptToolbar();
    adaptTitlebar();
  });
  try {
    appWindow.onResized(() => {
      adaptToolbar();
      adaptTitlebar();
    });
  } catch {
    /* 某些环境下 onResized 不支持，忽略（缩放时可能不更新，影响极小） */
  }

  // 编辑器失焦时保存选区，方便工具栏恢复
  editor.addEventListener("blur", () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  });

  // 工具栏交互前（mousedown 捕获阶段，编辑器尚未失焦）记录当前选区偏移量，
  // 供「上色/改字号」按钮在失焦后仍能精准还原选区
  toolbar.addEventListener("mousedown", () => {
    toolbarOff = getSelectionOffsets();
  }, true);

  /**
   * 以「字符偏移量」记录当前选区。
   * 关键：execCommand 会把选中文字包进新的 <font>/<span> 或拆分文本节点，
   * 若用克隆 Range 记录，还原时指向的是被改写前的旧 DOM 节点，必然失效 → 选区丢失。
   * 改用字符偏移量后，无论 DOM 如何被改写，文字序列不变，按偏移重算选区始终精准，
   * 从而支持连续多次触发快捷键。
   * 兜底：工具栏点击会令编辑器失焦，WebView2 失焦后 DOM 选区可能已被折叠，
   * 此时回退到失焦前保存的 savedRange——否则“第一次改字号成功、之后都无效”。
   */
  function getSelectionOffsets(): { start: number; end: number } | null {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      return {
        start: textOffsetAt(range.startContainer, range.startOffset),
        end: textOffsetAt(range.endContainer, range.endOffset),
      };
    }
    if (savedRange && !savedRange.collapsed) {
      return {
        start: textOffsetAt(savedRange.startContainer, savedRange.startOffset),
        end: textOffsetAt(savedRange.endContainer, savedRange.endOffset),
      };
    }
    return null;
  }

  /** 把选区还原到字符偏移量位置（DOM 已被改写也能精确定位） */
  function restoreSelectionOffsets(off: { start: number; end: number } | null) {
    if (!off) return;
    try {
      editor.focus();
      const sel = window.getSelection();
      if (!sel) return;
      const s = positionAt(off.start);
      const e = positionAt(off.end);
      const range = document.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) {
      console.error("还原选区失败:", err);
    }
  }

  /** 计算 (container, offset) 在整个 editor 文本中的字符偏移量（忽略 <br> 等无文本节点） */
  function textOffsetAt(container: Node, offset: number): number {
    let count = 0;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ALL, null);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (n === container) {
        if (n.nodeType === Node.TEXT_NODE) return count + offset;
        // 元素容器：累加其前 offset 个子节点的文本长度
        let sub = 0;
        for (let i = 0; i < offset && i < n.childNodes.length; i++) {
          sub += n.childNodes[i].textContent?.length || 0;
        }
        return count + sub;
      }
      if (n.nodeType === Node.TEXT_NODE) count += n.textContent?.length || 0;
    }
    return count;
  }

  /** 根据目标字符偏移量，定位到对应的 (node, offset) 位置 */
  function positionAt(target: number): { node: Node; offset: number } {
    let count = 0;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
    let n: Node | null;
    let last: { node: Node; offset: number } = { node: editor, offset: 0 };
    while ((n = walker.nextNode())) {
      const len = n.textContent?.length || 0;
      if (count + len >= target) return { node: n, offset: target - count };
      count += len;
      last = { node: n, offset: len };
    }
    return last;
  }

  function applySavedSize() {
    const w = current.width && current.width > 0 ? current.width : 420;
    const h = current.height && current.height > 0 ? current.height : 440;
    try {
      getCurrentWindow().setSize(new LogicalSize(w, h)).catch(() => {});
    } catch (e) {
      console.error("设置窗口尺寸失败:", e);
    }
  }

  // ---- 图片预览：双击图片在独立窗口中打开（避免便签窗口过小看不清）----
  function setupImagePreview(): void {
    const onDbl = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const img = target.closest("img") as HTMLImageElement | null;
      if (!img) return;
      // markdown 预览区是独立 iframe，跨文档隔离，暂不纳入
      if (img.closest(".md-preview")) return;
      const imgs = Array.from(
        document.querySelectorAll(".editor img, .translate-dst img")
      ) as HTMLImageElement[];
      const idx = imgs.indexOf(img);
      if (idx < 0) return;
      const urls = imgs.map((m) => m.src);
      invoke("open_image_viewer", { urls, index: idx }).catch((err) =>
        console.error("打开图片预览失败:", err)
      );
    };
    editor.addEventListener("dblclick", onDbl);
    const tr = document.getElementById("translate-dst");
    if (tr) tr.addEventListener("dblclick", onDbl);
  }

  async function init() {
    try {
      const loaded = await loadNote(noteId);
      if (loaded) {
        current = { width: 420, height: 440, title: "", translate: false, md: "none", ...loaded };
        editor.innerHTML = loaded.content || "";
        titleInput.value = loaded.title || "";
        updatePin(loaded.pinned, false);
      } else {
        updatePin(true, false);
      }
      // 全局快捷速记带过来的预填文本（仅新建便签时生效）：直接写入编辑器并保存
      if (preset && !loaded) {
        editor.innerText = preset;
        current.content = editor.innerHTML;
        scheduleSave();
      }
    } catch (err) {
      console.error("加载便签失败:", err);
      updatePin(true, false);
    }
    // 便签窗口按“打开中”集合显隐；main 主窗由后端启动流程（show_all_open）统一决定，
    // 不在前端自行 show——否则启动时会与默认便签同时出现两个窗口。
    if (noteId !== "main") {
      try {
        const open = await getOpenNotes();
        if (open.includes(noteId)) await getCurrentWindow().show();
        else await getCurrentWindow().hide();
      } catch (e) {
        console.error("读取打开状态失败:", e);
      }
    }
    applyTranslateVisibility();
    applyMdMode();
    await applyTheme();
    await applyTranslateFormat();
    await applyMdTheme();
    updateMaxIcon();
    await refreshSettingsUI();
    applySavedSize();
    await applyBackground();
    await applyGlassEnabled();
    await refreshEdgeSnapSetting();
    probeEdge();
    setInterval(probeEdge, 400);
    editor.focus();
    setupImagePreview();
  }

  function updatePin(pinned: boolean, animate = true) {
    current.pinned = pinned;
    btnPin.classList.toggle("pinned", pinned);
    btnPin.setAttribute("aria-pressed", pinned ? "true" : "false");
    btnPin.title = pinned ? "取消置顶" : "置顶";
    // 钉子动画：置顶=敲入，取消=拔出（仅用户点击时播放，加载便签不播放）
    if (animate) {
      btnPin.classList.remove("anim-in", "anim-out");
      void btnPin.offsetWidth; // 强制 reflow 以重启动画
      btnPin.classList.add(pinned ? "anim-in" : "anim-out");
    }
    setAlwaysOnTop(pinned).catch((e) => console.error("置顶失败:", e));
  }

  /** 解析生效的背景图 data URL：优先便签自身背景，否则回退全局设置；磁盘路径读回为 data URL */
  async function resolveBgImage(s: Settings): Promise<string> {
    let bg = current.bg_image || s.bg_image || "";
    if (bg && !bg.startsWith("data:")) {
      try {
        const { readBgImage } = await import("./api");
        bg = await readBgImage(bg);
      } catch (e) {
        bg = "";
      }
    }
    return bg;
  }

  /** 应用/清除背景：
   *  - 透明主题：DWM 原生亚克力（系统合成器实时模糊便签背后的桌面，零延迟，
   *    与 PowerShell 设置同款）；“背景不透明度”控制着色层深浅。
   *  - 非透明：自定义背景图（优先便签自身，否则全局）+ CSS 高斯模糊。 */
  async function applyBackground() {
    const s = await getSettings();
    const transparent = s.theme === "transparent";
    const mdBody = ensurePreviewDoc()?.body ?? null;

    if (transparent) {
      noteWindow.classList.remove("bg-immersive");
      noteWindow.style.removeProperty("--note-panel-alpha");
      noteWindow.style.removeProperty("--note-bar-alpha");
      noteWindow.classList.add("bg-transparent");
      noteWindow.classList.remove("has-bg", "on-dark-bg");
      noteWindow.style.removeProperty("--note-bg-img");
      noteWindow.style.removeProperty("--note-bg-opacity");
      applyGlassBlur({ target: noteWindow, strength: 0, enabled: false });
      // 原生亚克力：DWM 实时模糊背后屏幕（不再截屏），强度由系统固定，
      // “背景不透明度”滑块调节着色层深浅（0 = 纯模糊完全透明）。
      await applyAcrylic();
      if (mdBody) {
        mdBody.classList.add("md-transparent");
        mdBody.classList.remove("has-bg-img");
        mdBody.style.removeProperty("--md-bg-img");
        mdBody.style.removeProperty("--md-bg-opacity");
        mdBody.style.removeProperty("--md-blur");
        // 透明主题：预览 body 也要透出亚克力模糊，叠一层半透明面板色保证文字可读。
        // 默认 CSS 给 body 写了 opaque var(--bg)，这里覆盖为与编辑区一致的玻璃观感。
        const tv = getComputedStyle(document.documentElement)
          .getPropertyValue("--trans-opacity")
          .trim();
        mdBody.style.background =
          tv === "0"
            ? "transparent"
            : `color-mix(in srgb, var(--bg) ${tv}%, transparent)`;
      }
      return;
    }

    // 非透明：关掉原生亚克力并清掉透明态
    await applyAcrylic();
    noteWindow.classList.remove("bg-transparent");
    // 清除透明主题在预览 body 上留的 inline 背景色
    if (mdBody) {
      mdBody.style.removeProperty("background");
    }

    const bgUrl = await resolveBgImage(s);
    await applyPanelBackground(noteWindow, s, { bgUrl: bgUrl || undefined });

    // 背景沉浸仅对「自定义背景图 + 非透明」有意义：整张便签（含标题栏/工具栏）透出背景
    const immersive = s.bg_immersive === true && !!bgUrl;
    noteWindow.classList.toggle("bg-immersive", immersive);
    if (bgUrl) {
      // 非沉浸：内容面板用 0.98 近不透明底色垫底保证可读；沉浸时由 CSS 整体透明
      noteWindow.style.setProperty("--note-panel-alpha", "0.98");
      noteWindow.style.setProperty("--note-bar-alpha", "0.98");
    } else {
      noteWindow.style.removeProperty("--note-panel-alpha");
      noteWindow.style.removeProperty("--note-bar-alpha");
    }
  }

  /** 透明主题：开启 DWM 实时模糊（SWCA 亚克力，失焦也持续模糊），
   *  “背景不透明度”控制面板深浅：
   *   0~1% → 关闭 DWM 效果，窗口完全透明（无模糊无面板）；
   *   ≥2% → DWM 实时模糊（tint 固定最小 alpha，避免本机放大渲染），
   *         + 主题色半透明面板（0.6 × 滑块值，线性 0~60%，保持磨砂玻璃感）。
   *  非透明主题时调用则关闭模糊。幂等，可反复调用。 */
  async function applyAcrylic(): Promise<void> {
    const s = await getSettings();
    if (s.theme !== "transparent") {
      noteWindow.style.removeProperty("--trans-opacity");
      noteWindow.classList.remove("transparent-clear");
      setAcrylic(false, 0, 0).catch(() => {});
      return;
    }
    const o = normalizeOpacity(s.transparent_opacity);
    if (o < 2) {
      // 低值 = 完全透明：关掉 DWM 效果与面板（--trans-opacity=0，不留 CSS 默认值），只留文字
      noteWindow.classList.add("transparent-clear");
      noteWindow.style.setProperty("--trans-opacity", "0");
      document.documentElement.style.setProperty("--trans-opacity", "0");
      setAcrylic(false, 0, 0).catch(() => {});
      return;
    }
    noteWindow.classList.remove("transparent-clear");
    // 面板 0.6 × 滑块值（线性 0~60%）：越高磨砂感越强，但始终透出模糊，不变成实心白板
    const capped = Math.round(o * 0.6);
    noteWindow.style.setProperty("--trans-opacity", String(capped));
    document.documentElement.style.setProperty("--trans-opacity", String(capped));
    // SWCA tint 固定最小 alpha（Rust 侧 alpha=1），此处只传主题面板色
    const tint =
      parseColorToRgbInt(getComputedStyle(noteWindow).getPropertyValue("--bg")) ?? 0;
    setAcrylic(true, 1, tint).catch((e) => console.error("应用实时模糊失败:", e));
  }

  /** 统一套用毛玻璃强度（0~100%）：自定义背景模式下 CSS 模糊管线，
   *  0% 原图无模糊，100% 强模糊（≈ MAX_BLUR_PX），与设置面板所见即所得。
   *  透明主题下模糊半径由系统固定（原生亚克力），此处只维护背景不透明度。 */
  async function applyGlassEnabled(): Promise<void> {
    const s = await getSettings();
    const transparent = s.theme === "transparent";
    const pct = normalizeGlassPct(s.glass_blur);
    const enabled = s.glass_enabled !== false;
    const { applyGlassBlur } = await import("./glass");
    if (transparent) {
      // 原生亚克力：不透明度变化时刷新（无需强度，系统固定模糊半径）
      await applyAcrylic();
      return;
    }
    applyGlassBlur({ target: noteWindow, strength: pct, enabled });
  }

  function scheduleSave() {
    if (deleted) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      current.content = editor.innerHTML;
      current.title = titleInput.value;
      current.updated = Date.now();
      setSaveStatus("保存中…");
      saveNote(noteId, current)
        .then(() => setSaveStatus("已保存"))
        .catch((e) => {
          console.error("保存失败:", e);
          setSaveStatus("保存失败", true);
        });
    }, SAVE_DELAY);
  }

  // 自动保存状态提示：输入停顿后短暂显示「保存中…」→「已保存」（或「保存失败」）。
  // 关闭动画期间 suppressSaveStatus 为真时跳过显示（保存照常执行）。
  let savedStatusTimer: number | undefined;
  function setSaveStatus(text: string, isError = false) {
    if (suppressSaveStatus) return;
    if (!saveStatus) return;
    saveStatus.textContent = text;
    saveStatus.classList.toggle("error", isError);
    saveStatus.classList.add("show");
    if (savedStatusTimer) window.clearTimeout(savedStatusTimer);
    savedStatusTimer = window.setTimeout(
      () => saveStatus!.classList.remove("show"),
      isError ? 2600 : 1400,
    );
  }

  // ---- 设置联动：提示文案 ----
  async function refreshSettingsUI() {
    await getSettings(); // 确保配置已加载，getShortcut 才能读到
    toolFgApply.title = `按当前颜色上色（${getShortcut("fg_color")}）`;
    toolBgApply.title = `按当前背景色上色（${getShortcut("bg_color")}）`;
    toolSizeWrap.title = `文字大小（增大 ${getShortcut("size_up")} / 减小 ${getShortcut("size_down")}）`;
    btnTranslate.title = `翻译（${getShortcut("translate")}）`;
  }

  // ---- 翻译区：目标语言下拉框（"自动"按设置的中英方向，其余为指定语言）----
  function populateTargetSelect() {
    trTarget.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = "自动";
    trTarget.appendChild(auto);
    TARGET_LANGUAGES.forEach((l) => {
      const opt = document.createElement("option");
      opt.value = l.value;
      opt.textContent = l.label;
      trTarget.appendChild(opt);
    });
    trTarget.value = "auto";
  }
  populateTargetSelect();

  onSettingsChanged(() => {
    refreshSettingsUI();
    applyTheme();
    applyTranslateFormat();
    applyMdTheme();
    applyBackground();
    applyGlassEnabled();
    refreshEdgeSnapSetting();
  });

  // ---- 靠边自动收起/弹出（QQ 贴边风格）----
  let edgeSnapEnabled = true;
  let pinnedEdge: "left" | "right" | "top" | "bottom" | null = null;
  let restorePos: { x: number; y: number } | null = null;
  let restoreWa: { x: number; y: number; w: number; h: number } | null = null;
  let collapsed = false;
  let snapping = false;
  // 记录鼠标当前是否在便签窗口内，用于“完全弹出后检测鼠标是否已离开”的自动收起
  let pointerInside = false;
  const EDGE_STRIP = 28; // 收起后留在屏幕外的可见条宽度
  const EDGE_MARGIN = 12; // 距屏幕边缘多少像素内算“贴边”

  // 缓动函数：弹出用轻微回弹（easeOutBack，柔和不夸张），收起用缓入（被“吸入”边缘）
  const easeOutBackSoft = (t: number): number => {
    const c1 = 0.9,
      c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  };
  const easeInCubic = (t: number): number => t * t * t;

  // 用 rAF 把窗口物理位置逐帧平滑移动到目标点（替代瞬移，弹出/收起更优雅）
  function animateWindowTo(tx: number, ty: number, duration: number, easing: (t: number) => number): Promise<void> {
    return new Promise((resolve) => {
      appWindow
        .outerPosition()
        .then((start) => {
          const sx = start.x,
            sy = start.y;
          const t0 = performance.now();
          const step = (now: number) => {
            const t = Math.min(1, (now - t0) / duration);
            const e = easing(t);
            const x = Math.round(sx + (tx - sx) * e);
            const y = Math.round(sy + (ty - sy) * e);
            appWindow.setPosition(new PhysicalPosition(x, y)).catch(() => {});
            if (t < 1) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        })
        .catch(() => resolve());
    });
  }

  async function refreshEdgeSnapSetting() {
    try {
      const s = await getSettings();
      edgeSnapEnabled = s.edge_snap !== false;
      if (!edgeSnapEnabled && collapsed) expandFromEdge();
    } catch (e) {
      console.error("读取贴边设置失败:", e);
    }
  }

  // 轮询窗口位置，判断当前是否贴边（不主动收起，仅记录状态）
  async function probeEdge() {
    if (snapping || collapsed) return;
    try {
      const pos = await appWindow.outerPosition();
      const size = await appWindow.outerSize();
      const m = await currentMonitor();
      if (!m) return;
      const wa = m.workArea;
      const left = pos.x,
        top = pos.y;
      const right = pos.x + size.width,
        bottom = pos.y + size.height;
      const waLeft = wa.position.x,
        waTop = wa.position.y;
      const waRight = wa.position.x + wa.size.width;
      const waBottom = wa.position.y + wa.size.height;
      if (left <= waLeft + EDGE_MARGIN) pinnedEdge = "left";
      else if (right >= waRight - EDGE_MARGIN) pinnedEdge = "right";
      else if (top <= waTop + EDGE_MARGIN) pinnedEdge = "top";
      else if (bottom >= waBottom - EDGE_MARGIN) pinnedEdge = "bottom";
      else pinnedEdge = null;
    } catch (e) {
      /* 忽略 */
    }
  }

  async function collapseToEdge() {
    if (!pinnedEdge || snapping) return;
    try {
      snapping = true;
      const pos = await appWindow.outerPosition();
      const size = await appWindow.outerSize();
      const m = await currentMonitor();
      if (!m) {
        snapping = false;
        return;
      }
      const wa = m.workArea;
      // 记录收起前的完全可见位置，以及此刻所在显示器的工作区。
      // 此刻窗口仍在屏内，currentMonitor 取的是正确的显示器，供弹出时夹取使用。
      restorePos = { x: pos.x, y: pos.y };
      restoreWa = { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height };
      let x = pos.x,
        y = pos.y;
      if (pinnedEdge === "left") x = wa.position.x - (size.width - EDGE_STRIP);
      else if (pinnedEdge === "right") x = wa.position.x + wa.size.width - EDGE_STRIP;
      else if (pinnedEdge === "top") y = wa.position.y - (size.height - EDGE_STRIP);
      else if (pinnedEdge === "bottom") y = wa.position.y + wa.size.height - EDGE_STRIP;
      // 收起：窗口被“缓入吸入”边缘（无 CSS 视觉，避免残留态闪烁）
      await animateWindowTo(x, y, 300, easeInCubic);
      collapsed = true;
    } catch (e) {
      console.error("贴边收起失败:", e);
    } finally {
      setTimeout(() => {
        snapping = false;
      }, 380);
    }
  }

  async function expandFromEdge(byHover = false) {
    if (!collapsed || !restorePos || snapping) return;
    try {
      snapping = true;
      const size = await appWindow.outerSize();
      // 用收起时记录的工作区把还原位置夹取到可视范围内，
      // 保证整窗完全弹出、不残留任何内容在屏幕外（同时避免“越收越偏”的累积 bug）。
      let tx = restorePos.x,
        ty = restorePos.y;
      if (restoreWa) {
        const maxX = restoreWa.x + restoreWa.w - size.width;
        const maxY = restoreWa.y + restoreWa.h - size.height;
        tx = Math.min(Math.max(tx, restoreWa.x), Math.max(restoreWa.x, maxX));
        ty = Math.min(Math.max(ty, restoreWa.y), Math.max(restoreWa.y, maxY));
      }
      // 弹出：窗口滑出（带轻微回弹）+ 内层卡片“绽放”淡入（见 .edge-pop-in）
      noteWindow.classList.add("edge-pop-in");
      await animateWindowTo(tx, ty, 360, easeOutBackSoft);
      noteWindow.classList.remove("edge-pop-in");
      collapsed = false;
      restorePos = null;
      restoreWa = null;
    } catch (e) {
      console.error("贴边弹出失败:", e);
    } finally {
      setTimeout(() => {
        snapping = false;
        // 完全弹出后做一次检测：若本次由“鼠标靠近贴边小条”触发弹出，
        // 而用户在完全弹出前就已离开窗口，则自动收起，避免便签卡在弹出状态。
        // （由呼出键 / 托盘触发的弹出不做此检测，以免误收起。）
        if (byHover && edgeSnapEnabled && pinnedEdge && !pointerInside && !collapsed) {
          collapseToEdge();
        }
      }, 400);
    }
  }

  // 鼠标离开窗口（relatedTarget 为 null）→ 记“鼠标已不在窗口内”
  document.addEventListener("mouseout", (e: MouseEvent) => {
    if (e.relatedTarget === null) pointerInside = false;
    if (collapsed) return;
    if (e.relatedTarget === null && edgeSnapEnabled && pinnedEdge) {
      collapseToEdge();
    }
  });
  // 鼠标回到窗口（收起时仅露出贴边小条）→ 记“鼠标在窗口内”并弹出（悬停触发）
  document.addEventListener("mouseover", () => {
    pointerInside = true;
    if (collapsed) expandFromEdge(true);
  });
  // 呼出键 / 托盘“显示便签”触发的事件：若当前处于贴边收起状态，则弹出
  // （非悬停触发，弹出后不做“鼠标是否已离开”的自动收起，避免误收起）
  // 呼出动画标记：便签被隐藏（消散/托盘）后置 true，下次呼出播放粒子成形动画；
  // 仅记录“隐藏→呼出”这一种转移，已可见的便签收到 summoned 不重复动画。
  let wasHidden = false;
  // 呼出动画“代次”：呼出是异步启动的（先 getSettings），期间若又触发托盘隐藏/关闭，
  // 递增此计数作废尚未开始的呼出动画，避免在已隐藏窗口上播放/与关闭动画打架。
  let summonSeq = 0;
  // 「粒子光效」模式无呼出动画：隐藏时窗口保持空画面（clip/mask 全裁），呼出时直接复原显示
  const restoreGlowSummoned = (): void => {
    bumpGlowGen(); // 作废上一轮关闭动画遗留的延时清理（否则 400ms 后 cleanupAfterHide 会把刚显示的便签再次裁空）
    try {
      noteWindow.style.clipPath = "";
      noteWindow.style.setProperty("-webkit-mask-image", "");
      noteWindow.style.setProperty("mask-image", "");
      noteWindow.style.opacity = "";
      noteWindow.style.boxShadow = "";
    } catch {
      /* ignore */
    }
  };

  appWindow.listen("summoned", () => {
    // 呼出：恢复保存状态提示的显示（关闭动画期间的抑制结束）
    suppressSaveStatus = false;
    if (collapsed) expandFromEdge(false);
    // 防御：若便签仍残留“隐藏时空画面”样式（clip/mask 未清，可能上次呼出的异步复原未生效），
    // 立即复原显示——避免呼出后窗口空白、或需多次按键才显示。幂等，已正常显示时无害。
    if (noteWindow.style.clipPath || noteWindow.style.webkitMaskImage || noteWindow.style.maskImage) {
      restoreGlowSummoned();
    }
    // 呼出打断进行中的关闭动画：先取消关闭（取消会复原页面、且不会触发 finish/隐藏），
    // 再按普通呼出流程处理，避免“关闭动画没播完就呼出”导致窗口又被隐藏/动画卡住。
    if (closing) {
      closing = false;
      finished = false;
        cancelFlame();
        cancelGlowParticles();
        // 关闭动画已被打断：把窗口视为"从空画面呼出"，补播呼出成形动画——
      // 否则 wasHidden 仍为 false（finish 未执行），呼出动画被吞掉、窗口空着。
      wasHidden = true;
    }
    // 呼出动画：仅从“隐藏态”呼出时播放（隐藏时窗口保持空画面），
    // 已可见的便签不重复动画；关闭动画播放中也不插入
    if (wasHidden && !closing) {
      wasHidden = false;
      if (noteWindow.classList.contains("bg-transparent")) {
        // 透明主题：无粒子特效，直接复原便签显示（窗口已由后端显示）
        noteWindow.style.clipPath = "";
        noteWindow.style.boxShadow = "";
        noteWindow.style.opacity = "";
        // 关闭后 50ms 内立刻呼出时亚克力还没恢复：立即补上，
        // 避免等定时器在可见窗口上触发 SWCA 造成卡顿 + 模糊晚到
        if (acrylicOffPending) {
          acrylicOffPending = false;
          applyAcrylic().catch(() => {});
        }
        return;
      }
      // 非透明主题：按粒子数量/风格设置启动呼出动画（火焰模式（设置值 "erode"，历史命名）用火焰消散；
      // 粒子吸入用吸入动画；默认「粒子光效」无呼出动画——直接复原便签显示）
      const seq = summonSeq; // 快照：等待 getSettings 期间若被隐藏/关闭作废则跳过
      getSettings()
        .then((s) => {
          // getSettings 是异步的：等待期间若又触发了关闭/托盘隐藏/删除，作废本次呼出，
          // 避免呼出动画与关闭动画同时改 clip-path 打架导致“卡住”。
          if (seq !== summonSeq || closing || deleted) return;
          const intensity = s.particle_count ?? 50;
          const speed = s.animation_speed ?? 100;
          if (s.particle_mode === "erode") playFlameMaterialize(noteWindow, intensity, speed);
          else if (s.particle_mode === "inhale") playInhaleMaterialize(noteWindow, intensity, speed);
          else restoreGlowSummoned();
        })
        .catch(() => {
          if (seq !== summonSeq || closing || deleted) return;
          // 读取失败回退到默认「粒子光效」：直接复原便签显示
          restoreGlowSummoned();
        });
    }
    // 确保窗口真正激活/置顶：Windows 前台锁会令全局快捷键触发的 show 偶尔不激活窗口
    // （窗口可见却躲在别的窗口后面 → 看似“没呼出”，需多次按键）。从窗口自身上下文再 focus 一次。
    appWindow.setFocus().catch(() => {});
  });

  // ---- 富文本格式化 ----

  /** 按当前颜色值给选区上色（直接作用于实时选区，不弹取色框、不还原旧选区） */
  function applyFgColor() {
    document.execCommand("foreColor", false, toolFg.value);
    scheduleSave();
  }

  /** 按当前背景色值给选区上背景（直接作用于实时选区） */
  function applyBgColor() {
    // hiliteColor 在 WebView2 中可能不支持，用 backColor 兜底
    if (!document.execCommand("hiliteColor", false, toolBg.value)) {
      document.execCommand("backColor", false, toolBg.value);
    }
    scheduleSave();
  }

  // ===== WPS 风格颜色按钮：左侧下拉选色、右侧上方图标应用、下方色条显示当前色 =====
  const COLOR_PRESETS = [
    "#000000", "#e03131", "#f08c00", "#f7d000", "#2f9e44",
    "#1971c2", "#6741d9", "#e8590c", "#ffffff", "#868e96",
  ];

  // ---- 最近使用颜色（跨便签、跨重启持久化，最多保留 8 个）----
  const RECENT_COLORS_KEY = "xiaoxin-sticky-note-recent-colors";
  function loadRecentColors(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) || "[]");
      return Array.isArray(v) ? v.filter((c) => typeof c === "string") : [];
    } catch {
      return [];
    }
  }
  function recordRecentColor(color: string): void {
    const norm = color.toUpperCase();
    const list = loadRecentColors().filter((c) => c !== norm);
    list.unshift(norm);
    while (list.length > 8) list.pop();
    try {
      localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(list));
    } catch {
      /* 忽略（存储不可用） */
    }
  }
  /** 渲染“最近使用”区（无记录时隐藏） */
  function renderRecentColors(panelEl: HTMLElement) {
    const box = panelEl.querySelector("#cc-recent") as HTMLElement | null;
    if (!box) return;
    const recents = loadRecentColors();
    box.innerHTML = recents.length
      ? `<div class="cc-recent-title">最近使用</div>` +
        recents
          .map((c) => `<button type="button" class="cc-swatch" data-color="${c}" style="background:${c}"></button>`)
          .join("")
      : "";
  }

  function updateColorBar(bar: HTMLElement, color: string): void {
    bar.style.background = color;
  }

  function setupColorControl(
    applyBtn: HTMLButtonElement,
    dropBtn: HTMLButtonElement,
    inputEl: HTMLInputElement,
    barEl: HTMLElement,
    panelEl: HTMLElement,
    applyFn: () => void,
  ): void {
    // 右侧上方：应用当前颜色（并记入最近使用）
    applyBtn.addEventListener("click", () => {
      restoreSelectionOffsets(toolbarOff);
      applyFn();
      updateColorBar(barEl, inputEl.value);
      recordRecentColor(inputEl.value);
      renderRecentColors(panelEl);
    });
    // 左侧下拉：展开/收起配色面板
    dropBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = panelEl.hasAttribute("hidden");
      document.querySelectorAll(".cc-panel:not([hidden])").forEach((p) => p.setAttribute("hidden", ""));
      if (willOpen) {
        // 定位色板：放在对应颜色按钮组的正下方
        const wrap = dropBtn.closest(".tool-color") as HTMLElement;
        if (wrap) {
          const rect = wrap.getBoundingClientRect();
          panelEl.style.top = rect.bottom + "px";
          panelEl.style.left = rect.left + "px";
        }
        renderRecentColors(panelEl);
        panelEl.removeAttribute("hidden");
      } else {
        panelEl.setAttribute("hidden", "");
      }
    });
    // 构建面板：最近使用 + 预设色块 + 自定义取色
    panelEl.innerHTML =
      `<div class="cc-recent" id="cc-recent"></div>` +
      COLOR_PRESETS.map(
        (c) => `<button type="button" class="cc-swatch" data-color="${c}" style="background:${c}"></button>`,
      ).join("") +
      `<label class="cc-custom">自定义<input type="color" class="cc-custom-input" value="${inputEl.value}"></label>`;
    // 事件委托统一处理色块点击（预设色块与“最近使用”色块共用）：
    // “最近使用”是打开面板时才渲染的，若在构建期逐个绑监听，新渲染的色块会点不动。
    panelEl.addEventListener("click", (e) => {
      const sw = (e.target as HTMLElement).closest(".cc-swatch") as HTMLButtonElement | null;
      if (!sw || !panelEl.contains(sw)) return;
      e.stopPropagation();
      inputEl.value = sw.getAttribute("data-color") || inputEl.value;
      updateColorBar(barEl, inputEl.value);
      restoreSelectionOffsets(toolbarOff);
      applyFn();
      recordRecentColor(inputEl.value);
      renderRecentColors(panelEl);
      panelEl.setAttribute("hidden", "");
    });
    const customInput = panelEl.querySelector(".cc-custom-input") as HTMLInputElement;
    customInput.addEventListener("input", () => {
      inputEl.value = customInput.value;
      updateColorBar(barEl, inputEl.value);
    });
    customInput.addEventListener("change", () => {
      restoreSelectionOffsets(toolbarOff);
      applyFn();
      recordRecentColor(inputEl.value);
      renderRecentColors(panelEl);
      panelEl.setAttribute("hidden", "");
    });
    inputEl.addEventListener("input", () => updateColorBar(barEl, inputEl.value));
    updateColorBar(barEl, inputEl.value);
  }

  // 点击面板以外区域收起所有配色面板
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest(".tool-color")) {
      document.querySelectorAll(".cc-panel:not([hidden])").forEach((p) => p.setAttribute("hidden", ""));
    }
  });

  /**
   * 给选区套上指定字号。用 extractContents 包裹法，保留选区内已有的
   * 颜色/背景等内联样式（execCommand("fontSize") 会破坏内层 color，故不用）。
   * 若选区整体已位于同一个字号 span 内，直接改该 span 的字号，
   * 避免反复点击字号按钮时不断嵌套新 span（嵌套也会让后续操作失效）。
   */
  function applyFontSizeToSelection(px: string) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;

    // 选区完全落在同一个字号 span 内 → 原地改字号（先移除内层多余字号，避免嵌套）
    const common = range.commonAncestorContainer;
    const commonEl = (common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement) as HTMLElement | null;
    const sizeSpan = commonEl?.closest("span[style*='font-size']") as HTMLElement | null;
    if (sizeSpan && range.toString() === (sizeSpan.textContent || "")) {
      sizeSpan.style.fontSize = px + "px";
      // 清理因嵌套产生的“空壳字号 span”，保持 DOM 干净
      sizeSpan.querySelectorAll("span[style*='font-size']").forEach((inner) => {
        const sp = inner as HTMLElement;
        if (sp.textContent === "") sp.remove();
      });
      const newRange = document.createRange();
      newRange.selectNodeContents(sizeSpan);
      sel.removeAllRanges();
      sel.addRange(newRange);
      scheduleSave();
      return;
    }

    const span = document.createElement("span");
    span.style.fontSize = px + "px";
    span.appendChild(range.extractContents()); // 取出选区内容（保留内层样式）并包裹
    range.insertNode(span);
    // 重新选中刚包裹的内容，方便继续操作 / 连续上色
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(newRange);
    scheduleSave();
  }

  /** 对选中文字按步长调整字号（基准由选区起始处的实际字号计算） */
  function changeSelectionFontSize(delta: number) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    let base = 14;
    const node = range.startContainer;
    const el = node.nodeType === Node.TEXT_NODE ? (node.parentElement as HTMLElement) : (node as HTMLElement);
    const parsed = parseFloat(getComputedStyle(el).fontSize);
    if (!isNaN(parsed)) base = parsed;
    const newSize = Math.min(48, Math.max(10, Math.round(base + delta)));
    applyFontSizeToSelection(String(newSize));
  }

  // WPS 风格颜色按钮：应用 / 下拉选色 / 色条均由此统一接管
  setupColorControl(
    toolFgApply,
    document.getElementById("tool-fg-drop") as HTMLButtonElement,
    toolFg,
    document.getElementById("tool-fg-bar") as HTMLElement,
    document.getElementById("tool-fg-panel") as HTMLElement,
    applyFgColor,
  );
  setupColorControl(
    toolBgApply,
    document.getElementById("tool-bg-drop") as HTMLButtonElement,
    toolBg,
    document.getElementById("tool-bg-bar") as HTMLElement,
    document.getElementById("tool-bg-panel") as HTMLElement,
    applyBgColor,
  );

  // ---- 字号：与颜色按钮同款的分段样式（左侧 Aa+数值，右侧 ▾），点击弹出自定义菜单 ----
  // 原实现用原生 <select>，在无边框透明窗口里点击无反馈、下拉框也偶发点不开；
  // 改为与「整理 / 翻译格式」同款的自定义弹出菜单，样式统一、反馈明确。
  const SIZE_OPTIONS = [12, 14, 16, 18, 20, 24, 28];
  let currentFontSize = 14;
  let sizeMenu: HTMLElement | null = null;

  function closeSizeMenu() {
    if (sizeMenu) {
      sizeMenu.remove();
      sizeMenu = null;
    }
    document.removeEventListener("mousedown", onSizeMenuOutside, true);
    document.removeEventListener("keydown", onSizeMenuKey, true);
  }
  function onSizeMenuOutside(e: MouseEvent) {
    if (sizeMenu && !sizeMenu.contains(e.target as Node) && !toolSizeWrap.contains(e.target as Node)) {
      closeSizeMenu();
    }
  }
  function onSizeMenuKey(e: KeyboardEvent) {
    if (e.key === "Escape") closeSizeMenu();
  }

  function showSizeMenu() {
    if (sizeMenu) {
      closeSizeMenu();
      return;
    }
    const rect = toolSizeWrap.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "fmt-menu size-menu";
    menu.innerHTML = SIZE_OPTIONS.map(
      (px) => `<button type="button" class="fmt-menu-item${px === currentFontSize ? " active" : ""}" data-size="${px}">${px} px</button>`,
    ).join("");
    document.body.appendChild(menu);
    sizeMenu = menu;
    // 定位：夹紧在便签窗口视口内，放不下则翻到按钮上方
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.left;
    if (left + mw > vw - 4) left = Math.max(4, vw - mw - 4);
    let top = rect.bottom + 6;
    if (top + mh > vh - 4) {
      const above = rect.top - mh - 6;
      top = above >= 4 ? above : Math.max(4, vh - mh - 4);
    }
    menu.style.top = top + "px";
    menu.style.left = left + "px";
    menu.querySelectorAll<HTMLButtonElement>(".fmt-menu-item").forEach((b) => {
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const px = Number(b.dataset.size);
        closeSizeMenu();
        if (!px) return;
        currentFontSize = px;
        toolSizeNum.textContent = String(px);
        // 套字号前先还原工具栏交互前捕获的选区（与颜色按钮一致）
        restoreSelectionOffsets(toolbarOff);
        applyFontSizeToSelection(String(px));
      });
    });
    // 延迟一帧再挂全局监听，避免本次点击立即触发“外部点击”把它关掉
    setTimeout(() => {
      document.addEventListener("mousedown", onSizeMenuOutside, true);
      document.addEventListener("keydown", onSizeMenuKey, true);
    }, 0);
  }
  toolSizeMain.addEventListener("click", showSizeMenu);
  toolSizeDrop.addEventListener("click", showSizeMenu);

  // ---- 每便签翻译开关：激活则变深色并显示翻译区，否则隐藏 ----
  function applyTranslateVisibility() {
    if (current.translate) {
      translatePanel.classList.remove("hidden");
      btnTranslateToggle.classList.add("active");
      btnTranslateToggle.title = "隐藏翻译区";
    } else {
      translatePanel.classList.add("hidden");
      btnTranslateToggle.classList.remove("active");
      btnTranslateToggle.title = "显示翻译区";
    }
  }

  btnTranslateToggle.addEventListener("click", () => {
    current.translate = !current.translate;
    applyTranslateVisibility();
    scheduleSave();
  });

  // ---- Markdown 预览/拆分：三个互斥态 none / preview / split（按每便签持久化）----
  // 建立/取回预览 iframe 的内部文档。仅首次写入骨架（md-base / md-theme 两个样式节点），
  // 之后只更新内容与样式，避免每次重渲染都 reload 造成闪烁与滚动复位。
  // 用户自定义 CSS 注入到这个独立文档后，body / @media / :root 等选择器只作用于预览区，
  // 不再污染便签窗口本身（原实现直接注入 document.head，会导致整窗被染蓝）。
  function ensurePreviewDoc(): Document | null {
    try {
      const doc = mdPreview.contentDocument;
      if (!doc) return null;
      if (!doc.getElementById("md-base")) {
        doc.open();
        doc.write(
          '<!DOCTYPE html><html><head><meta charset="utf-8">' +
          '<style id="md-base"></style><style id="md-theme"></style><style id="md-bg"></style></head><body></body></html>'
        );
        doc.close();
        const bg = doc.getElementById("md-bg");
        if (bg) bg.textContent = MD_BG_CSS;
      }
      return doc;
    } catch (e) {
      console.error("预览文档初始化失败:", e);
      return null;
    }
  }

  function renderMdPreview(src?: string) {
    // 取 Markdown 源：
    // - 调用方显式传入（如 applyMdMode 在隐藏编辑器前捕获、焦点切换时传入 lastMdSource）；
    // - 否则若编辑器可见（none/输入中）用其 innerText；
    // - 若编辑器被隐藏（纯预览/拆分态），innerText 会返回空串，必须回退到上次缓存的源，
    //   否则会出现“打开预览→点外部→点回便签→内容变空白”的 Bug。
    let text = src;
    if (text == null) {
      const editorVisible = editor.offsetParent !== null;
      text = (editorVisible ? editor.innerText : "") || lastMdSource || "";
    }
    lastMdSource = text;
    const doc = ensurePreviewDoc();
    if (!doc) return;
    doc.body.innerHTML = renderMarkdown(text);
  }

  function applyMdMode() {
    const mode = current.md || "none";
    // 先捕获源文本（此时编辑器仍可见，innerText 才准确），再切换显隐类，
    // 最后用 rAF 等布局稳定后再渲染——避免首帧 .md-preview 仍为 display:none
    // 导致样式未生效（拆分/预览首次点击偶发排版错乱，再点一次才正常）。
    const src = editor.innerText || "";
    editorArea.classList.toggle("preview", mode === "preview");
    editorArea.classList.toggle("split", mode === "split");
    btnMdPreview.classList.toggle("active", mode === "preview");
    btnMdSplit.classList.toggle("active", mode === "split");
    if (mode === "preview" || mode === "split") {
      requestAnimationFrame(() => renderMdPreview(src));
    }
    // 纯预览态编辑器不可见
  }

  // 当前翻译命名风格（默认值，加载设置后会被 applyTranslateFormat 覆盖）
  let currentFormat = "default";

  // ---- 全局外观主题（light / 多个深色主题）：给 <html> 挂对应的 theme-<name> 类 ----
  async function applyTheme() {
    const s = await getSettings();
    const theme = s.theme || "light";
    const root = document.documentElement;
    // light 不下类；dark 挂 .theme-dark；transparent 也挂 theme-dark——
    // PowerShell 深色亚克力观感：面板/tint 用深色主题变量（--bg #23232a），
    // 避免浅色变量（米白 #fffefb）造成“白板”效果。
    root.classList.remove("theme-dark");
    if (theme === "dark" || theme === "transparent") {
      root.classList.add("theme-dark");
    }
  }

  /** 翻译命名风格：从设置读取，刷新按钮高亮与当前状态 */
  async function applyTranslateFormat() {
    const s = await getSettings();
    currentFormat = s.translate_format || "default";
    const items = fmtFormatMenu.querySelectorAll<HTMLButtonElement>(".fmt-menu-item");
    items.forEach((it) => {
      it.classList.toggle("active", it.dataset.fmt === currentFormat);
    });
    btnFmtFormat.classList.toggle("active", currentFormat !== "default");
  }

  // ---- Markdown 主题（来自设置，作用于预览区）----
  async function applyMdTheme() {
    const s = await getSettings();
    const theme = s.md_theme || "default";
    const noteDark = (s.theme || "light") === "dark";
    const doc = ensurePreviewDoc();
    if (!doc) return;
    const base = doc.getElementById("md-base") as HTMLStyleElement | null;
    const themeEl = doc.getElementById("md-theme") as HTMLStyleElement | null;
    // 默认预览在“便签整体深色”时自动转深，避免亮底预览嵌在暗窗里的割裂感
    const baseCss = theme === "default" && noteDark ? DEFAULT_MD_CSS_DARK : DEFAULT_MD_CSS;
    if (base) base.textContent = baseCss;
    // 自定义主题：从磁盘上的 md_custom.css 读取（settings.json 只存路径），
    // 这样用户可在外部编辑器修改文件后通过“重新载入”即时生效。
    let custom = "";
    if (theme === "custom") {
      try {
        custom = await readMdCustom();
      } catch (e) {
        console.error("读取自定义样式文件失败:", e);
      }
    }
    if (themeEl) themeEl.textContent = getThemeCss(theme, custom);
    // 主题变化后重渲染，确保样式生效（用缓存的源文本，避免预览态编辑器隐藏导致取空）
    if (current.md === "preview" || current.md === "split") renderMdPreview(lastMdSource);
    // 主题/深色联动后，同步预览区背景图（md-bg 节点内容稳定，这里只确保类与图片已应用）
    applyMdBackground();
  }

  /** 为 Markdown 预览区套用与便签输入区统一的背景：
   *  透明主题：预览区完全透明，由窗口的 DWM 原生亚克力透出实时模糊背景；
   *  非透明：背景图（与输入区同一张）+ CSS 高斯模糊。 */
  async function applyMdBackground() {
    const s = await getSettings();
    const doc = ensurePreviewDoc();
    if (!doc) return;
    const transparent = s.theme === "transparent";
    const blurPx = Math.round((normalizeGlassPct(s.glass_blur) / 100) * MAX_BLUR_PX) + "px";
    if (transparent) {
      // 原生亚克力由窗口级 DWM 提供，预览区 body 透明 + 半透面板色，与编辑区观感一致
      doc.body.classList.add("md-transparent");
      doc.body.classList.remove("has-bg-img");
      doc.body.style.removeProperty("--md-bg-img");
      doc.body.style.removeProperty("--md-bg-opacity");
      doc.body.style.removeProperty("--md-blur");
      const tv = getComputedStyle(document.documentElement)
        .getPropertyValue("--trans-opacity")
        .trim();
      doc.body.style.background =
        tv === "0"
          ? "transparent"
          : `color-mix(in srgb, var(--bg) ${tv}%, transparent)`;
      return;
    }
    const bg = await resolveBgImage(s);
    // 非透明主题：清除透明主题在预览 body 上留的 inline 背景色
    doc.body.style.removeProperty("background");
    if (bg) {
      doc.body.classList.add("has-bg-img");
      doc.body.classList.remove("md-transparent");
      doc.body.style.setProperty("--md-bg-img", `url("${bg}")`);
      doc.body.style.setProperty("--md-bg-opacity", "1");
      doc.body.style.setProperty("--md-blur", blurPx);
    } else {
      doc.body.classList.remove("has-bg-img", "md-transparent");
      doc.body.style.removeProperty("--md-bg-img");
      doc.body.style.removeProperty("--md-bg-opacity");
      doc.body.style.removeProperty("--md-blur");
    }
  }

  btnMdPreview.addEventListener("click", () => {
    current.md = current.md === "preview" ? "none" : "preview";
    applyMdMode();
    scheduleSave();
  });

  btnMdSplit.addEventListener("click", () => {
    current.md = current.md === "split" ? "none" : "split";
    applyMdMode();
    scheduleSave();
  });

  // ---- 用大模型整理格式：先选格式（MD / 纯文本），再整理 ----
  // 点击「整理」按钮弹出小菜单让用户选择目标格式；选定后调用后端 format_with_llm，
  // 拿到整理结果后弹出 git 风格差异对比，由用户决定是否接受。整理期间按钮显示 loading。
  let fmtMenu: HTMLElement | null = null;
  function closeFormatMenu() {
    if (fmtMenu) {
      fmtMenu.remove();
      fmtMenu = null;
    }
    btnFmt.classList.remove("active");
    document.removeEventListener("mousedown", onFmtMenuOutside, true);
    document.removeEventListener("keydown", onFmtMenuKey, true);
  }
  function onFmtMenuOutside(e: MouseEvent) {
    if (fmtMenu && !fmtMenu.contains(e.target as Node) && e.target !== btnFmt) closeFormatMenu();
  }
  function onFmtMenuKey(e: KeyboardEvent) {
    if (e.key === "Escape") closeFormatMenu();
  }

  // 整张便签的加载遮罩（整理期间覆盖整个便签窗口，而非仅按钮）
  let fmtLoading: HTMLElement | null = null;
  function showFmtLoading() {
    if (fmtLoading) return;
    const el = document.createElement("div");
    el.className = "fmt-loading-overlay";
    el.innerHTML = `<div class="fmt-loading-box"><div class="spinner"></div><div class="fmt-loading-text">整理中…</div></div>`;
    document.body.appendChild(el);
    fmtLoading = el;
  }
  function hideFmtLoading() {
    if (fmtLoading) {
      fmtLoading.remove();
      fmtLoading = null;
    }
  }

  function showFormatMenu() {
    if (fmtMenu) {
      closeFormatMenu();
      return;
    }
    const rect = btnFmt.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "fmt-menu";
    menu.innerHTML = `
      <button type="button" class="fmt-menu-item" data-mode="md">Markdown 格式</button>
      <button type="button" class="fmt-menu-item" data-mode="text">纯文本格式</button>
      <button type="button" class="fmt-menu-item cancel" data-mode="cancel">取消</button>
    `;
    document.body.appendChild(menu);
    fmtMenu = menu;
    // 定位：保持在便签窗口（webview 视口）范围内；超出则夹紧，
    // 若按钮下方空间不足则翻到按钮上方，避免出现范围外/被裁切。
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.left;
    if (left + mw > vw - 4) left = Math.max(4, vw - mw - 4);
    let top = rect.bottom + 6;
    if (top + mh > vh - 4) {
      const above = rect.top - mh - 6;
      top = above >= 4 ? above : Math.max(4, vh - mh - 4);
    }
    menu.style.top = top + "px";
    menu.style.left = left + "px";
    btnFmt.classList.add("active");
    menu.querySelectorAll<HTMLButtonElement>(".fmt-menu-item").forEach((b) => {
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const mode = b.dataset.mode;
        closeFormatMenu();
        if (mode === "md") runFormat("md");
        else if (mode === "text") runFormat("text");
      });
    });
    // 延迟一帧再挂全局监听，避免本次点击立即触发“外部点击”把它关掉
    setTimeout(() => {
      document.addEventListener("mousedown", onFmtMenuOutside, true);
      document.addEventListener("keydown", onFmtMenuKey, true);
    }, 0);
  }

  async function runFormat(mode: "md" | "text") {
    const srcText = (editor.innerText || "").trim();
    if (!srcText) {
      toast("便签内容为空，无需整理");
      return;
    }
    btnFmt.disabled = true;
    showFmtLoading();
    try {
      const formatted = await formatWithLLM(srcText, mode === "md" ? "md" : "text");
      showFormatDiff(srcText, formatted, mode);
    } catch (e) {
      toast("整理失败：" + String(e));
    } finally {
      btnFmt.disabled = false;
      hideFmtLoading();
    }
  }

  btnFmt.addEventListener("click", showFormatMenu);

  /** 弹出 git 风格（unified diff）差异对比弹窗，支持“接受 / 取消”。 */
  function showFormatDiff(oldText: string, newText: string, mode: "md" | "text") {
    if (oldText === newText) {
      toast("内容已是最整洁，无需改动");
      return;
    }
    // 内容保全：检测模型输出中遗漏的原文行，自动补回，确保绝不丢数据
    // （尤其防止密码/凭据被模型“顺手清理/脱敏”而丢失）。
    const missing = findMissingLines(oldText, newText);
    let displayNew = newText;
    if (missing.length > 0) {
      displayNew =
        newText +
        "\n\n以下为原内容中未被整理覆盖、已自动补回的部分（如不需要可手动删除）：\n" +
        missing.join("\n");
    }
    // 安全提示：若模型返回明显短于原文（去掉空白后不足 60%），提醒逐行核对
    const origLen = oldText.replace(/\s+/g, "").length;
    const newLen = newText.replace(/\s+/g, "").length;
    const suspiciousDrop = origLen > 120 && newLen < origLen * 0.6;
    const rows = unifiedDiff(oldText, displayNew);
    const diffHtml = rows
      .map((r) => {
        const cls =
          r.type === "del" ? "diff-del" : r.type === "add" ? "diff-add" : "diff-ctx";
        const sign = r.type === "del" ? "-" : r.type === "add" ? "+" : " ";
        const esc = escapeHtml(r.text) || "&nbsp;";
        return `<div class="diff-line ${cls}"><span class="diff-sign">${sign}</span><span class="diff-text">${esc}</span></div>`;
      })
      .join("");

    const tipText = missing.length > 0
      ? `⚠️ 有 ${missing.length} 行原内容未被整理覆盖，已自动补回并标出，请核对（接受后可手动删除）。`
      : suspiciousDrop
        ? "⚠️ 整理后内容明显变少，可能遗漏了信息，请逐行核对后再接受。"
        : "核对改动，接受后用整理后的内容替换便签。";

    const overlay = document.createElement("div");
    overlay.className = "fmt-diff-overlay";
    overlay.id = "fmt-diff-overlay";
    overlay.innerHTML = `
      <div class="fmt-diff-modal">
        <div class="fmt-diff-header">
          <span class="fmt-diff-title">格式化预览（${mode === "md" ? "Markdown" : "纯文本"}）</span>
          <span class="fmt-diff-stat">-${rows.filter((r) => r.type === "del").length} +${rows.filter((r) => r.type === "add").length}</span>
        </div>
        <div class="fmt-diff-body">${diffHtml}</div>
        <div class="fmt-diff-footer">
          <span class="fmt-diff-tip${missing.length > 0 || suspiciousDrop ? " warn" : ""}">${tipText}</span>
          <button class="btn-primary" id="fmt-accept">接受</button>
          <button class="shortcut-rec" id="fmt-cancel">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    (overlay.querySelector("#fmt-cancel") as HTMLButtonElement).addEventListener("click", close);
    (overlay.querySelector("#fmt-accept") as HTMLButtonElement).addEventListener("click", () => {
      // 用整理后的纯文本替换编辑器内容（便签存储为 HTML，按换行封成段落）
      const html = textToHtml(displayNew);
      editor.innerHTML = html;
      current.content = html;
      // 整理为 Markdown 时，若当前未处于预览/拆分态，自动切到预览，让用户直接看到渲染后的标题/列表
      if (mode === "md" && (current.md || "none") === "none") {
        current.md = "preview";
        applyMdMode();
      }
      scheduleSave();
      toast(missing.length > 0 ? "已应用（含自动补回的原文内容）" : "已应用整理后的内容");
      close();
    });
  }

  /**
   * 找出“原内容中被模型输出遗漏的行”。对每行抽取显著 token（长度≥3 的字母数字/凭据符号），
   * 若这些 token 在整理结果中完全找不到，则认为该行被丢弃。用于格式化后自动补回，防止丢数据。
   */
  function findMissingLines(oldText: string, newText: string): string[] {
    const srcLines = oldText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const out = newText.toLowerCase();
    const missing: string[] = [];
    for (const line of srcLines) {
      const tokens = line.match(/[A-Za-z0-9@._\-]{3,}/g) || [];
      if (tokens.length === 0) {
        if (!newText.includes(line)) missing.push(line);
        continue;
      }
      const hit = tokens.some((t) => out.includes(t.toLowerCase()));
      if (!hit) missing.push(line);
    }
    return missing;
  }

  /** 行级统一差异（LCS）：返回带类型的行，便于 git 风格着色。 */
  function unifiedDiff(oldText: string, newText: string): { type: "ctx" | "del" | "add"; text: string }[] {
    const a = oldText.split("\n");
    const b = newText.split("\n");
    const n = a.length;
    const m = b.length;
    // LCS 动态规划表
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out: { type: "ctx" | "del" | "add"; text: string }[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ type: "ctx", text: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ type: "del", text: a[i] });
        i++;
      } else {
        out.push({ type: "add", text: b[j] });
        j++;
      }
    }
    while (i < n) {
      out.push({ type: "del", text: a[i] });
      i++;
    }
    while (j < m) {
      out.push({ type: "add", text: b[j] });
      j++;
    }
    return out;
  }

  /** 纯文本转 HTML：按空行/单行切分，逐行包裹 <br> 或成段 <p>。 */
  function textToHtml(text: string): string {
    const paragraphs = text.split(/\n{2,}/);
    return paragraphs
      .map((p) => {
        const trimmed = p.trim();
        if (!trimmed) return "";
        return "<p>" + escapeHtml(trimmed).replace(/\n/g, "<br>") + "</p>";
      })
      .join("");
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** 轻量提示：页面底部淡入淡出短消息。 */
  function toast(msg: string) {
    let el = document.getElementById("sticky-toast") as HTMLDivElement | null;
    if (!el) {
      el = document.createElement("div");
      el.id = "sticky-toast";
      el.className = "sticky-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    window.clearTimeout((el as any)._t);
    (el as any)._t = window.setTimeout(() => el!.classList.remove("show"), 2600);
  }

  // ---- 最大化 / 还原（手动最大化到当前监控器工作区，规避无边框透明窗口原生 maximize 不生效）----
  async function updateMaxIcon() {
    try {
      const max = isMaximizedState || (await appWindow.isMaximized().catch(() => false));
      btnMax.innerHTML = max ? ICON_RESTORE : ICON_MAX;
      btnMax.title = max ? "还原窗口" : "最大化";
      // 最大化时禁用右下角缩放手柄（此时无法手动改尺寸）
      winResizer.style.display = max ? "none" : "";
    } catch (e) {
      console.error("读取最大化状态失败:", e);
    }
  }

  async function toggleMaximize() {
    try {
      if (isMaximizedState && savedBounds) {
        // 还原到最大化前的位置与尺寸
        programmaticResize = true;
        await appWindow.setPosition(new PhysicalPosition(savedBounds.x, savedBounds.y));
        await appWindow.setSize(new PhysicalSize(savedBounds.w, savedBounds.h));
        isMaximizedState = false;
      } else {
        // 记录当前位置/尺寸（物理像素），随后铺满监控器工作区
        const pos = await appWindow.outerPosition();
        const size = await appWindow.outerSize();
        savedBounds = { x: pos.x, y: pos.y, w: size.width, h: size.height };
        const monitor = await currentMonitor();
        programmaticResize = true;
        if (monitor) {
          const wa = monitor.workArea;
          await appWindow.setPosition(new PhysicalPosition(wa.position.x, wa.position.y));
          await appWindow.setSize(new PhysicalSize(wa.size.width, wa.size.height));
        } else {
          await appWindow.maximize();
        }
        isMaximizedState = true;
      }
      updateMaxIcon();
    } catch (e) {
      console.error("最大化失败:", e);
    } finally {
      // 让本次程序化 resize 的尺寸保存被跳过；稍后恢复
      setTimeout(() => {
        programmaticResize = false;
      }, 700);
    }
  }

  btnMax.addEventListener("click", () => {
    toggleMaximize().catch((e) => console.error("最大化失败:", e));
  });

  // ---- 快捷键：实时匹配并执行 ----
  function matchShortcut(action: string, e: KeyboardEvent): boolean {
    const combo = getShortcut(action);
    if (!combo) return false;
    const parts = combo.split("+");
    const need = (p: string) => parts.includes(p);
    if (e.ctrlKey !== need("Ctrl")) return false;
    if (e.altKey !== need("Alt")) return false;
    if (e.shiftKey !== need("Shift")) return false;
    if (e.metaKey !== need("Meta")) return false;
    const main = parts[parts.length - 1];
    let pressed: string;
    if (e.code === "Equal") pressed = "Plus";
    else if (e.code === "Minus") pressed = "Minus";
    else if (e.code === "Space") pressed = "Space";
    else if (e.key.length === 1) pressed = e.key.toUpperCase();
    else pressed = e.key;
    return pressed === main;
  }

  document.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    // 选区保持策略：foreColor/backColor 原生保留选区；applyFontSizeToSelection 内部
    // 已用 selectNodeContents 重新选中文本。故正常情况下动作后选区仍在，无需干预。
    // 仅当动作意外令选区丢失（折叠）时，才按偏移量兜底还原——
    // 避免在已聚焦的 contenteditable 上无谓地 focus()+重设选区（实测会把选区收窄，
    // 导致字号快捷键第二次失效）。
    const run = (action: () => void) => {
      e.preventDefault();
      const before = getSelectionOffsets();
      action();
      const after = getSelectionOffsets();
      if (!after && before) restoreSelectionOffsets(before);
    };

    if (matchShortcut("fg_color", e)) {
      // 直接按当前颜色值修改，不弹出系统取色框
      run(applyFgColor);
    } else if (matchShortcut("bg_color", e)) {
      run(applyBgColor);
    } else if (matchShortcut("size_up", e)) {
      run(() => changeSelectionFontSize(2));
    } else if (matchShortcut("size_down", e)) {
      run(() => changeSelectionFontSize(-2));
    } else if (matchShortcut("translate", e)) {
      e.preventDefault();
      translateSelection(); // 翻译编辑器中选中的文字
    }
  });

  // ---- 翻译命名风格（翻译格式）：默认 / 下划线 / 驼峰 / 缩写下划线 / 缩写驼峰 ----
  // 菜单自按钮向上弹出；点选项把偏好存入设置（跨便签窗口与重启后保持一致）。
  function closeFmtFormatMenu() {
    fmtFormatMenu.classList.add("hidden");
    document.removeEventListener("mousedown", onFmtFormatOutside, true);
    document.removeEventListener("keydown", onFmtFormatKey, true);
  }
  function onFmtFormatOutside(e: MouseEvent) {
    if (!fmtFormatMenu.contains(e.target as Node) && !btnFmtFormat.contains(e.target as Node)) {
      closeFmtFormatMenu();
    }
  }
  function onFmtFormatKey(e: KeyboardEvent) {
    if (e.key === "Escape") closeFmtFormatMenu();
  }
  btnFmtFormat.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!fmtFormatMenu.classList.contains("hidden")) {
      closeFmtFormatMenu();
      return;
    }
    fmtFormatMenu.classList.remove("hidden");
    setTimeout(() => {
      document.addEventListener("mousedown", onFmtFormatOutside, true);
      document.addEventListener("keydown", onFmtFormatKey, true);
    }, 0);
  });
  fmtFormatMenu.querySelectorAll<HTMLButtonElement>(".fmt-menu-item").forEach((it) => {
    it.addEventListener("click", async () => {
      const fmt = it.dataset.fmt || "default";
      currentFormat = fmt;
      fmtFormatMenu
        .querySelectorAll(".fmt-menu-item")
        .forEach((x) => x.classList.toggle("active", x === it));
      btnFmtFormat.classList.toggle("active", fmt !== "default");
      closeFmtFormatMenu();
      // 持久化到设置，使其它便签窗口与下次启动保持一致
      try {
        const s = await getSettings();
        s.translate_format = fmt;
        await saveSettings(s);
        setSettings(s); // 更新缓存并派发变更，使其它窗口联动
      } catch (err) {
        console.error("保存翻译格式失败:", err);
      }
    });
  });

  // 英文短语 → snake_case / camelCase（供“下划线 / 驼峰”翻译格式使用）
  function toSnakeCase(s: string): string {
    return s
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[\s\-./\\]+/g, "_")
      .replace(/[^a-zA-Z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
  }
  function toCamelCase(s: string): string {
    const snake = toSnakeCase(s);
    return snake.replace(/_([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
  }

  // ---- 翻译 ----
  // 实际调用后端翻译并把结果写入译文区。
  // 多行文本逐行翻译后按换行拼接，避免翻译服务把换行吞掉、只译出第一行。
  async function runTranslate(text: string) {
    const fmt = currentFormat;
    const trimmed = (text || "").trim();
    if (!trimmed) {
      translateDst.textContent = "没有可翻译的内容";
      return;
    }

    // 缩写类：跳过传统翻译，直接走大模型生成命名风格标识符
    if (fmt === "snake_abbr" || fmt === "camel_abbr") {
      translateDst.textContent = "生成中…";
      translateDst.classList.add("loading");
      try {
        const style = fmt === "snake_abbr" ? "id_snake" : "id_camel";
        const id = await formatWithLLM(trimmed, style);
        translateDst.classList.remove("loading");
        translateDst.textContent = id || "（无结果）";
      } catch (err) {
        translateDst.classList.remove("loading");
        translateDst.textContent = String(err);
      }
      return;
    }

    // 默认 / 下划线 / 驼峰：传统翻译，再按需转换为命名风格
    const transform = (s: string): string =>
      fmt === "snake" ? toSnakeCase(s) : fmt === "camel" ? toCamelCase(s) : s;

    const lines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length <= 1) {
      translateDst.textContent = "翻译中…";
      translateDst.classList.add("loading");
      try {
        const res = await translate(trimmed, trTarget.value || "auto");
        translateDst.classList.remove("loading");
        translateDst.textContent = transform(res.text || "") || "（无结果）";
      } catch (err) {
        translateDst.classList.remove("loading");
        translateDst.textContent = String(err);
      }
      return;
    }

    // 多行：逐行翻译，按原换行结构拼接，每行分别套用命名风格转换
    translateDst.textContent = "翻译中…";
    translateDst.classList.add("loading");
    try {
      const results = await Promise.all(
        lines.map((l) =>
          translate(l, trTarget.value || "auto")
            .then((r) => transform(r.text || l))
            .catch(() => transform(l))
        )
      );
      translateDst.classList.remove("loading");
      translateDst.textContent = results.join("\n");
    } catch (err) {
      translateDst.classList.remove("loading");
      translateDst.textContent = String(err);
    }
  }

  // 翻译按钮：优先翻译编辑器中选中的文字；无选中时再翻译输入框内容
  async function translateFromInput() {
    const text = translateSrc.value.trim();
    if (!text) {
      translateDst.textContent = "请在上方输入框输入要翻译的内容，或在便签中选中文字";
      return;
    }
    await runTranslate(text);
  }

  // 统一入口：翻译编辑器中选中的文字（若有），否则翻译输入框内容。
  // 供翻译按钮、快捷键、右键菜单共用。
  async function translateSelection() {
    const sel = window.getSelection();
    let text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
    const off = getSelectionOffsets();
    // 实时选区为空时，回退到失焦前保存的选区（点按钮/右键菜单时编辑器可能已失焦）
    if (!text && savedRange) {
      text = savedRange.toString().trim();
    }
    if (text) {
      // 翻译区未打开时（如仅通过右键菜单触发），自动弹出，否则结果不可见
      if (!current.translate) {
        current.translate = true;
        applyTranslateVisibility();
        scheduleSave();
      }
      translateSrc.value = text;
      await runTranslate(text);
      restoreSelectionOffsets(off);
    } else {
      await translateFromInput();
    }
  }

  btnTranslate.addEventListener("click", () => translateSelection());

  // 复制译文
  btnCopy.addEventListener("click", async () => {
    const text = translateDst.textContent || "";
    if (!text || text === "翻译中…" || text === "没有可翻译的内容" || text === "请先在便签中选中要翻译的文字") {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      const oldTitle = btnCopy.title;
      btnCopy.innerHTML = ICON_CHECK;
      btnCopy.classList.add("copied");
      btnCopy.title = "已复制 ✓";
      window.setTimeout(() => {
        btnCopy.innerHTML = ICON_COPY;
        btnCopy.classList.remove("copied");
        btnCopy.title = oldTitle;
      }, 1200);
    } catch (e) {
      console.error("复制失败:", e);
    }
  });

  // ---- 编辑器右键菜单：选中文字后右键可"翻译" ----
  const ctxMenu = document.createElement("div");
  ctxMenu.className = "ctx-menu";
  ctxMenu.id = "ctx-menu";
  ctxMenu.innerHTML = `<button class="ctx-item" id="ctx-translate">翻译选中文字</button>`;
  ctxMenu.style.display = "none";
  document.body.appendChild(ctxMenu);
  const ctxTranslate = ctxMenu.querySelector("#ctx-translate") as HTMLButtonElement;

  editor.addEventListener("contextmenu", (e) => {
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    if (!text) return; // 无选区时走浏览器默认菜单
    e.preventDefault();
    ctxMenu.style.display = "block";
    // 防止菜单超出窗口
    const x = Math.min(e.clientX, window.innerWidth - 160);
    const y = Math.min(e.clientY, window.innerHeight - 40);
    ctxMenu.style.left = x + "px";
    ctxMenu.style.top = y + "px";
  });
  ctxTranslate.addEventListener("mousedown", (e) => {
    e.preventDefault();
    ctxMenu.style.display = "none";
    translateSelection();
  });
  // 点别处或按 Esc 关闭菜单
  document.addEventListener("mousedown", (e) => {
    if (ctxMenu.style.display === "none") return;
    if (!ctxMenu.contains(e.target as Node)) ctxMenu.style.display = "none";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ctxMenu.style.display !== "none") {
      ctxMenu.style.display = "none";
    }
  });

  // ---- 翻译区域可拖动调整高度 ----
  const translatePanel = document.querySelector(".translate-panel") as HTMLElement;
  const resizer = document.getElementById("translate-resizer")!;
  let resizing = false;
  let startY = 0;
  let startH = 0;
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    resizing = true;
    startY = e.clientY;
    startH = translatePanel.getBoundingClientRect().height;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const delta = startY - e.clientY; // 向上拖增大
    let h = startH + delta;
    const minH = 64;
    const maxH = Math.max(minH, window.innerHeight - 120);
    h = Math.max(minH, Math.min(maxH, h));
    translatePanel.style.height = h + "px";
    translatePanel.style.maxHeight = h + "px";
  });
  document.addEventListener("mouseup", () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  // ---- 右下角自定义缩放手柄（替代系统 resize，避免透明窗口白屏 / 投影边框）----
  // 用 appWindow.setSize 程序化改尺寸：不走系统 resize 边框，故无 WebView2 重建导致的白屏。
  const MIN_W = 220;
  const MIN_H = 150;
  let winResizing = false;
  let resStartX = 0;
  let resStartY = 0;
  let resStartW = 0;
  let resStartH = 0;
  winResizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    winResizing = true;
    // 缩放期间临时切到 resizable+shadow（复刻稳定态），避免 transparent+shadow(false) 下 setSize 触发 WebView2 重建崩溃
    appWindow.setResizable(true).catch(() => {});
    appWindow.setShadow(true).catch(() => {});
    resStartX = e.clientX;
    resStartY = e.clientY;
    resStartW = window.innerWidth;
    resStartH = window.innerHeight;
    try {
      winResizer.setPointerCapture(e.pointerId);
    } catch {
      /* 部分环境不支持指针捕获，退化为 document 级监听仍可工作 */
    }
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";
  });
  winResizer.addEventListener("pointermove", (e) => {
    if (!winResizing) return;
    const nw = Math.max(MIN_W, resStartW + (e.clientX - resStartX));
    const nh = Math.max(MIN_H, resStartH + (e.clientY - resStartY));
    appWindow.setSize(new LogicalSize(nw, nh)).catch(() => {});
  });
  const endWinResize = (e: PointerEvent) => {
    if (!winResizing) return;
    winResizing = false;
    // 缩放结束恢复：静止状态无投影、无系统缩放
    appWindow.setResizable(false).catch(() => {});
    appWindow.setShadow(false).catch(() => {});
    try {
      winResizer.releasePointerCapture(e.pointerId);
    } catch {
      /* 同上 */
    }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };
  winResizer.addEventListener("pointerup", endWinResize);
  winResizer.addEventListener("pointercancel", endWinResize);

  // ---- 按钮事件 ----

  btnSettings.addEventListener("click", () => {
    openSettingsWindow().catch((e) => console.error("打开设置窗口失败:", e));
  });

  btnPin.addEventListener("click", () => updatePin(!current.pinned));

  // 每便签背景图改在设置弹窗中配置（见 settings.ts），便签页面不再提供入口

  btnNew.addEventListener("click", async () => {
    try {
      const id = await newNoteId();
      await createNoteWindow(id);
    } catch (err) {
      console.error("新建便签失败:", err);
    }
  });

  btnHistory.addEventListener("click", () => {
    openHistoryWindow().catch((e) => console.error("打开历史失败:", e));
  });

  btnTray.addEventListener("click", () => {
    // 隐藏前先进入"空画面"状态：下次呼出时粒子成形动画从空开始，不闪出旧内容。
    // 作废尚未开始的呼出（getSettings 等待中），取消进行中的呼出/关闭动画——
    // **无条件取消两个动画**（不能只在 closing 时取消：火焰呼出动画播放中隐藏时
    // 若不清 materializing，下次呼出会被 playFlameMaterialize 拒绝，窗口显示空画面卡死）。
    summonSeq++;
    if (closing) {
      closing = false;
      finished = false;
    }
      cancelFlame();
      cancelGlowParticles();
      noteWindow.style.clipPath = "inset(0 0 100% 0)";
    noteWindow.style.boxShadow = "none";
    wasHidden = true;
    minimizeToTray().catch((e) => console.error("最小化到托盘失败:", e));
  });

  btnClose.addEventListener("click", () => {
    requestAnimatedClose();
  });

  /** 关闭窗口：先播放粒子消散动画（鸿蒙通知删除同款），结束后标记关闭并真正关闭/隐藏窗口。
   * 主窗口关闭是“隐藏到托盘”（JS 上下文不销毁），因此 closing/finished 必须在每次
   * 关闭完成后复位，否则主窗口再次显示后关闭按钮会永久失效。 */
  let closing = false;
  let finished = false;
  /** 关闭后亚克力尚未恢复的窗口期：此期间呼出需立即补上亚克力，
   *  否则窗口显示时无模糊、等定时器在可见窗口上触发 SWCA 才模糊（卡顿+模糊晚到）。 */
  let acrylicOffPending = false;
  /** 立即完成关闭（隐藏窗口）：requestAnimatedClose 与 play-close-anim（快捷键"全部关闭"
   *  打断正在播放的关闭动画）共用。复位 closing、关亚克力、隐藏窗口、标记已关闭。 */
  const finishClose = () => {
    closing = false; // 复位：主窗口隐藏后上下文仍在，必须复位
    if (finished) return;
    finished = true;
    // 透明主题的 DWM 亚克力在窗口隐藏时会重新合成，出现"便签缩小一下"的残影：
    // 隐藏前先关掉亚克力，隐藏后立刻恢复（50ms 内，窗口不可见无感知）——
    // 保证下次呼出瞬间模糊已就绪，不会在可见窗口上触发 SWCA 造成卡顿。
    setAcrylic(false, 0, 0).catch(() => {});
    acrylicOffPending = true;
    // 记录"已隐藏"：下次呼出时播放粒子成形动画（隐藏后窗口保持空画面）
    wasHidden = true;
    // 先真正关闭/隐藏窗口（关键路径，绝不被标记逻辑阻断），再异步标记已关闭
    closeWindow().catch((e) => console.error("关闭失败:", e));
    markNoteClosed(noteId).catch(() => {});
    window.setTimeout(() => {
      applyAcrylic()
        .catch(() => {})
        .finally(() => {
          acrylicOffPending = false;
        });
    }, 50);
  };

  function requestAnimatedClose() {
    if (closing) return;
    // 关闭动画期间抑制「保存中/已保存」提示（关闭会触发一次保存，但不应打扰关闭过程）
    suppressSaveStatus = true;
    // 呼出/成形动画若在播放，先立即收尾复原页面，避免两个动画同时改 clip-path / mask；
    // 同时作废任何“等待 getSettings 的待播放呼出”，确保关闭能干净接管——
    // 与“关闭被呼出打断”完全对称：双向都随时可打断对方。
      cancelGlowParticles(); // 取消进行中的粒子光效呼出/关闭动画
      cancelInhaleParticles(); // 取消进行中的粒子吸入呼出/关闭动画
      cancelFlame(); // 防御：清掉任何残留的火焰动画，避免叠加
    summonSeq++; // 作废进行中的呼出（其 getSettings().then 会检查 seq 后跳过）
    closing = true;
    finished = false;
    // 透明主题：无粒子特效，直接隐藏（亚克力常驻整窗，无需动画遮罩）
    if (noteWindow.classList.contains("bg-transparent")) {
      finishClose();
      return;
    }
    // 非透明主题：按粒子数量/风格设置启动关闭动画（数量从设置读取，失败回退默认 50）
    getSettings()
      .then((s) => {
        // getSettings 是异步的：等待期间若用户又呼出了（closing 已被复位/取消），
        // 作废本次关闭，避免关闭动画与呼出动画同时改 clip-path 打架导致“卡住”。
        if (!closing) return;
        const intensity = s.particle_count ?? 50;
        const speed = s.animation_speed ?? 100;
        // 关闭动画：默认粒子光效（鸿蒙通知删除同款·与呼出共用同一套粒子）；火焰模式（设置值 "erode"，历史命名）用火焰消散；inhale=粒子吸入。
        if (s.particle_mode === "erode") requestFlameDissolveClose(finishClose, intensity, speed);
        else if (s.particle_mode === "inhale") requestInhaleDissolveClose(finishClose, intensity, speed);
        // particle（默认粒子消散）：用全屏透明粒子层窗口渲染，粒子不被窗口框住（remote=true）——
        // 粒子可飘出便签边界、轨迹与 mask 同源（同一 T 场），是原本的正常行为，保留。
        else requestGlowDissolveClose(finishClose, intensity, speed, true);
      })
      .catch(() => {
        if (!closing) return;
        requestGlowDissolveClose(finishClose);
      });
  }

  // 用户重新输入内容 → 若此前被删除过，视为重新创建，解除删除态
  editor.addEventListener("input", () => {
    deleted = false;
    if (current.md === "preview" || current.md === "split") renderMdPreview();
    scheduleSave();
  });

  // 自定义标题：输入即保存
  titleInput.addEventListener("input", () => {
    deleted = false;
    current.title = titleInput.value;
    scheduleSave();
  });

  // 失焦立即保存
  window.addEventListener("blur", () => {
    if (deleted) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    current.content = editor.innerHTML;
    current.title = titleInput.value;
    current.updated = Date.now();
    setSaveStatus("保存中…");
    saveNote(noteId, current)
      .then(() => setSaveStatus("已保存"))
      .catch(() => setSaveStatus("保存失败", true));
  });

  // 该便签在历史列表被删除时，后端会向本窗口发送 note-deleted 事件：
  // 立即停止保存以防复活；非 main 窗口关闭自身，main 窗口清空内容。
  getCurrentWindow()
    .listen("note-deleted", () => {
      deleted = true;
      if (saveTimer) window.clearTimeout(saveTimer);
      if (sizeSaveTimer) window.clearTimeout(sizeSaveTimer);
      if (noteId === "main") {
        editor.innerHTML = "";
        titleInput.value = "";
        current.content = "";
        current.title = "";
      } else {
        // 便签已被删除：真正销毁窗口（普通“关闭”只是隐藏，见 close_window）
        appWindow.destroy().catch(() => {
          closeWindow().catch(() => {});
        });
      }
    })
    .catch((e) => console.error("监听删除事件失败:", e));

  // “全部关闭（全局）”快捷键由后端向每个可见窗口广播该事件，各窗口播放粒子消散动画后再关闭。
  // 若本窗口正在播放关闭动画（closing）：快捷键"全部关闭"再次到来 → 立即完成——
  // 清掉粒子层本便签实例 + 立即隐藏，避免"历史便签位置的粒子动画继续播放、与新建便签
  // 的动画叠加成双动画/错位"。
  getCurrentWindow()
    .listen("play-close-anim", () => {
      if (closing) {
        cancelGlowParticles();
        cancelInhaleParticles();
        cancelFlame();
        finishClose();
        return;
      }
      requestAnimatedClose();
    })
    .catch((e) => console.error("监听关闭动画事件失败:", e));

  // ---- 窗口尺寸记忆：拖拽改变大小后保存，下次打开沿用该便签自己的尺寸 ----
  (async () => {
    try {
      await appWindow.onResized(() => {
        updateMaxIcon();
        if (programmaticResize || deleted) return;
        if (sizeSaveTimer) window.clearTimeout(sizeSaveTimer);
        sizeSaveTimer = window.setTimeout(() => {
          if (deleted) return;
          current.width = Math.round(window.innerWidth);
          current.height = Math.round(window.innerHeight);
          saveNote(noteId, current).catch(() => {});
        }, 500);
      });
    } catch (e) {
      console.error("监听窗口尺寸失败:", e);
    }
  })();

  // ---- 窗口位置记忆：拖动后保存最后位置，下次呼出/重启在原位出现 ----
  // 跳过程序性移动：贴边收起/弹出动画（snapping/collapsed）、最大化铺满（programmaticResize/
  // isMaximizedState），只记录用户手动拖拽后的“真实落点”。
  (async () => {
    try {
      await appWindow.onMoved(() => {
        if (deleted || snapping || collapsed || programmaticResize || isMaximizedState) return;
        if (posSaveTimer) window.clearTimeout(posSaveTimer);
        posSaveTimer = window.setTimeout(async () => {
          if (deleted || snapping || collapsed || isMaximizedState) return;
          try {
            const pos = await appWindow.outerPosition();
            current.pos_x = pos.x;
            current.pos_y = pos.y;
            saveNote(noteId, current).catch(() => {});
          } catch {
            /* 忽略 */
          }
        }, 500);
      });
    } catch (e) {
      console.error("监听窗口位置失败:", e);
    }
  })();

  // 窗口聚焦状态变化（如从隐藏重新呼出）时，若处于 Markdown 模式则重新渲染：
  // 纯预览/拆分态下编辑器被隐藏、innerText 为空，故显式传入上次缓存的源，避免渲染成空白。
  appWindow
    .onFocusChanged(({ payload: focused }) => {
      if (focused && (current.md === "preview" || current.md === "split")) renderMdPreview(lastMdSource);
    })
    .catch((e) => console.error("监听聚焦失败:", e));

  init();
}
