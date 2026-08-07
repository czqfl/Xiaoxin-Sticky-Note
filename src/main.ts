import "./styles.css";
import { mountNoteApp } from "./note";
import { mountHistoryApp } from "./history";
import { openSettingsModal } from "./settings";
import { mountImageViewer } from "./image-viewer";
import { mountParticlesLayer } from "./particles-layer";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 全局错误兜底：任何未捕获异常都显示出来，避免静默空白/卡死难以排查。
function showFatal(msg: string) {
  let el = document.getElementById("fatal-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "fatal-banner";
    el.style.cssText =
      "position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#c0392b;color:#fff;" +
      "font:12px/1.5 sans-serif;padding:8px 12px;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,.3);" +
      "pointer-events:none";
    document.body.appendChild(el);
  }
  el.textContent = msg;
}
window.addEventListener("error", (e) =>
  showFatal("运行时错误：" + (e.message || String(e.error))),
);
window.addEventListener("unhandledrejection", (e) =>
  showFatal("未处理的 Promise 拒绝：" + String((e as PromiseRejectionEvent).reason)),
);

// 用 Tauri 窗口 label 区分窗口类型（替代不可靠的 ?view= URL 参数）
const label = getCurrentWindow().label;
const params = new URLSearchParams(window.location.search);
const noteId = params.get("noteId") || "main";
const preset = params.get("preset") || "";

if (label === "history") {
  mountHistoryApp();
} else if (label === "settings") {
  // 独立“设置”窗口（窗口由后端按历史窗口同款建法创建）：只打开设置面板
  openSettingsModal().catch((e) => console.error("设置面板加载失败:", e));
} else if (label === "imageviewer") {
  // 独立图片预览窗口：双击便签图片时由后端 open_image_viewer 命令创建
  mountImageViewer().catch((e) => console.error("图片预览加载失败:", e));
} else if (label === "particles") {
  // 全屏透明粒子层窗口：负责“粒子消散”动画的粒子渲染（粒子可飘出便签窗口）
  mountParticlesLayer().catch((e) => console.error("粒子层初始化失败:", e));
} else {
  mountNoteApp(noteId, preset);
}
