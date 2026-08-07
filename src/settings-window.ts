// 独立“设置”窗口入口：只加载设置面板，绝不混入便签 / 历史 / 图片预览 bundle。
//
// 这是根治“打开设置面板即白板”的关键。此前的实现复用 index.html 共享入口，
// main.ts 顶层会 import note/history/image-viewer 全套模块；只要其中任一模块在
// 求值期抛错（且早于 main.ts 的全局错误监听注册），整页就白屏、连错误红条都没有。
// 独立入口只加载 settings.ts（其依赖图不含 note.ts），从根上消除了这个脆弱点。
import "./styles.css";
import { openSettingsModal } from "./settings";

// 首帧兜底底色：透明窗体下必须透明，否则这条最高优先级内联样式会盖住 DWM 原生 Acrylic 磨砂。
// 非透明主题由 .settings-standalone .settings-modal 实色垫底，透明主题由半透面板叠在 Acrylic 上，
// 二者都不依赖 body 实色。出错时由 #settings-fatal（实色 div）兜底，不会白板。
const root = document.documentElement;
root.style.background = "transparent";
if (document.body) document.body.style.background = "transparent";

// 全局错误兜底：任何未捕获异常直接显示在页面上，绝不再静默白屏。
function showErr(msg: string): void {
  let el = document.getElementById("settings-fatal");
  if (!el) {
    el = document.createElement("div");
    el.id = "settings-fatal";
    el.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#f3efe7;color:#c0392b;" +
      "font:13px/1.6 sans-serif;padding:24px;white-space:pre-wrap;overflow:auto;";
    document.body.appendChild(el);
  }
  el.textContent = "设置窗口加载失败（已兜底显示，不会白板）：\n" + msg;
}
window.addEventListener("error", (e) =>
  showErr("运行时错误：" + (e.message || String(e.error))),
);
window.addEventListener("unhandledrejection", (e) =>
  showErr("未处理的 Promise 拒绝：" + String((e as PromiseRejectionEvent).reason)),
);

// 调用已有的独立设置面板逻辑。其 standalone 路径会：
//  1) 同步先画骨架（缓存/默认设置），瞬间可见、绝不白屏；
//  2) 把主题类挂到 documentElement，使面板用上用户真实主题色（否则整页白）；
//  3) applyStandaloneBg 铺底；渲染完成后由前端 show 窗口。
// 因为本入口只加载 settings.ts（不含 note/history），不会再出现“共享 bundle 抛错 → 白板”。
openSettingsModal().catch((e) => showErr("openSettingsModal: " + String(e)));
