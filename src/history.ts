import { listNotes, deleteNote, openNoteWindow, closeWindow, startDragging, getOpenNotes, setAcrylic } from "./api";
import { getSettings } from "./settings";
import { applyPanelBackground } from "./panel-bg";
import { applyGlassBlur, parseColorToRgbInt } from "./glass";
import type { Settings } from "./types";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

export function mountHistoryApp() {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="history-window">
      <div class="titlebar">
        <div class="titlebar-left">
          <span class="dot">\u25cf</span>
          <span class="title-text">历史便签</span>
        </div>
        <div class="titlebar-right">
          <button class="icon-btn close" id="btn-close" title="关闭">\u2715</button>
        </div>
      </div>
      <div class="history-list" id="history-list"></div>
      <div class="win-resizer" id="win-resizer" title="拖动调整窗口大小">
        <svg class="win-resizer-grip" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M2.5 9.5 L9.5 2.5 M5 12 L12 5 M0.5 6.5 L6.5 0.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </div>
    </div>
  `;

  const listEl = document.getElementById("history-list")!;
  const titlebar = document.querySelector(".titlebar")!;
  const btnClose = document.getElementById("btn-close")!;
  const appWindow = getCurrentWindow();
  const winResizer = document.getElementById("win-resizer") as HTMLElement;

  // 套用全局外观主题（浅色 / 深色），使历史窗口与便签配色一致。
  getSettings()
    .then((s) => {
      const root = document.documentElement;
      root.classList.remove("theme-dark");
      if (s.theme === "dark" || s.theme === "transparent") root.classList.add("theme-dark");
      // 套用与便签一致的背景效果（背景图+毛玻璃 / 透明主题原生亚克力）
      void applyHistoryBg(s);
      // 骨架已同步渲染、主题类已套上，此刻再显示窗口，消除打开瞬间白/透明闪
      getCurrentWindow().show().then(() => getCurrentWindow().setFocus()).catch(() => {});
    })
    .catch((e) => {
      console.error("读取主题失败:", e);
      // 即便主题读取失败，骨架也已渲染，仍需把窗口显示出来
      getCurrentWindow().show().catch(() => {});
    });

  // 设置变更时实时同步背景（与便签窗口一致）
  listen("xiaoxin-sticky-note-settings-changed", () => {
    getSettings().then((s) => void applyHistoryBg(s)).catch(() => {});
  }).catch((e) => console.error("监听设置变更失败:", e));

  // 套用与便签一致的背景效果（背景图+毛玻璃 或 透明主题原生亚克力）
  async function applyHistoryBg(s: Settings): Promise<void> {
    const root = document.querySelector(".history-window") as HTMLElement | null;
    if (!root) return;
    const transparent = s.theme === "transparent";
    if (transparent) {
      root.classList.remove("has-bg", "on-dark-bg", "glass");
      root.classList.add("bg-transparent");
      root.style.removeProperty("--note-bg-img");
      root.style.removeProperty("--note-bg-opacity");
      root.style.removeProperty("--glass-blur");
      const o = Math.min(100, Math.max(0, Number(s.transparent_opacity ?? 65)));
      const capped = Math.round(o * 0.6);
      document.documentElement.style.setProperty("--trans-opacity", String(capped));
      root.style.setProperty("--trans-opacity", String(capped));
      const tint = parseColorToRgbInt(getComputedStyle(root).getPropertyValue("--bg")) ?? 0;
      setAcrylic(true, 1, tint).catch((e) => console.error("应用实时模糊失败:", e));
    } else {
      root.classList.remove("bg-transparent");
      document.documentElement.style.removeProperty("--trans-opacity");
      root.style.removeProperty("--trans-opacity");
      setAcrylic(false, 0, 0).catch(() => {});
      await applyPanelBackground(root, s);
      const hasBg = root.classList.contains("has-bg");
      const pct = s.glass_blur ?? 55;
      const enabled = s.glass_enabled !== false;
      applyGlassBlur({ target: root, strength: hasBg ? pct : 0, enabled: hasBg && enabled });
    }
  }

  // 拖拽
  titlebar.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".icon-btn")) return;
    startDragging();
  });

  btnClose.addEventListener("click", () => {
    closeWindow().catch((e) => console.error("关闭失败:", e));
  });

  // ---- 右下角自定义缩放手柄（替代系统 resize，避免透明窗口白屏 / 投影边框）----
  const MIN_W = 300;
  const MIN_H = 180;
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
    appWindow.setResizable(true).catch(() => {});
    appWindow.setShadow(true).catch(() => {});
    resStartX = e.clientX;
    resStartY = e.clientY;
    resStartW = window.innerWidth;
    resStartH = window.innerHeight;
    try {
      winResizer.setPointerCapture(e.pointerId);
    } catch {
      /* 部分环境不支持指针捕获 */
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

  async function render() {
    let items;
    try {
      items = await listNotes();
    } catch (err) {
      console.error("加载列表失败:", err);
      listEl.innerHTML = `<div class="empty-state"><div class="empty-text">加载失败，请重试</div></div>`;
      return;
    }

    // 读取“打开中”的便签集合：只有已关闭的便签才允许删除，
    // 打开中的便签删除会导致窗口把内容写回而“复活”，故禁用其删除按钮。
    let openSet = new Set<string>();
    try {
      const open = await getOpenNotes();
      openSet = new Set(open);
    } catch (err) {
      console.error("读取打开状态失败:", err);
    }

    listEl.innerHTML = "";

    if (items.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">\u270e</div>
          <div class="empty-text">还没有历史便签</div>
        </div>
      `;
      return;
    }

    items.forEach((item) => {
      const isOpen = openSet.has(item.id);
      const card = document.createElement("div");
      card.className = "history-card" + (isOpen ? " open-note" : "");
      const title = (item.title || "").trim();
      // 有标题：标题为主行、内容摘要为副行；无标题：直接以内容摘要为主行
      const primary = title || item.snippet;
      const secondary = title ? `<div class="card-snippet">${escapeHtml(item.snippet)}</div>` : "";
      const statusTag = isOpen ? `<div class="card-status">打开中</div>` : "";
      // 所有便签都显示删除按钮：后端 delete_note 会先向窗口发 note-deleted
      // （前端停止保存并关闭窗口），再删文件，故即使便签还开着也能安全删除、不会复活。
      const delBtnHtml = `<button class="card-delete" title="删除">\u2715</button>`;
      card.innerHTML = `
        <div class="card-info">
          <div class="card-title">${escapeHtml(primary)}</div>
          ${secondary}
          <div class="card-time">${escapeHtml(item.updatedStr)}</div>
          ${statusTag}
        </div>
        ${delBtnHtml}
      `;

      card.addEventListener("click", () => {
        openNoteWindow(item.id).catch((e) => console.error("打开便签失败:", e));
      });

      const delBtn = card.querySelector(".card-delete")! as HTMLButtonElement;

      // 两次点击确认删除（替代不可用的 confirm 弹窗）
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (delBtn.classList.contains("confirming")) {
          try {
            await deleteNote(item.id);
            render();
          } catch (err) {
            console.error("删除失败:", err);
            delBtn.classList.remove("confirming");
            delBtn.textContent = "\u2715";
          }
        } else {
          delBtn.classList.add("confirming");
          delBtn.textContent = "确认?";
          setTimeout(() => {
            if (delBtn.isConnected) {
              delBtn.classList.remove("confirming");
              delBtn.textContent = "\u2715";
            }
          }, 3000);
        }
      });

      listEl.appendChild(card);
    });
  }

  render();
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
