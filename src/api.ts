import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { NoteData, NoteMeta, Settings } from "./types";

/** 关闭当前窗口（用于独立“设置”窗口的关闭/保存后退出）。 */
export async function getCurrent(): Promise<{ destroy(): Promise<void> }> {
  return getCurrentWindow() as unknown as { destroy(): Promise<void> };
}

export async function loadNote(id: string): Promise<NoteData | null> {
  return invoke<NoteData | null>("load_note", { id });
}

export async function saveNote(id: string, data: NoteData): Promise<void> {
  return invoke("save_note", { id, data });
}

export async function listNotes(): Promise<NoteMeta[]> {
  return invoke<NoteMeta[]>("list_notes");
}

export async function deleteNote(id: string): Promise<void> {
  return invoke("delete_note", { id });
}

export async function newNoteId(): Promise<string> {
  return invoke<string>("new_note_id");
}

export async function setAlwaysOnTop(pinned: boolean): Promise<void> {
  return invoke("set_always_on_top", { pinned });
}

export async function startDragging(): Promise<void> {
  return invoke("start_dragging");
}

export async function createNoteWindow(id: string): Promise<void> {
  return invoke("create_note_window", { id });
}

export async function openNoteWindow(id: string): Promise<void> {
  return invoke("open_note_window", { id });
}

export async function openHistoryWindow(): Promise<void> {
  return invoke("open_history_window");
}

export async function closeWindow(): Promise<void> {
  return invoke("close_window");
}

export async function minimizeToTaskbar(): Promise<void> {
  return invoke("minimize_to_taskbar");
}

export async function minimizeToTray(): Promise<void> {
  return invoke("minimize_to_tray");
}

/** 标记某便签为“打开中”（加入持久化打开集合） */
export async function markNoteOpen(id: string): Promise<void> {
  return invoke("mark_note_open", { id });
}

/** 标记某便签已关闭（从持久化打开集合移除） */
export async function markNoteClosed(id: string): Promise<void> {
  return invoke("mark_note_closed", { id });
}

/** 读取当前“打开中”的便签 ID 集合 */
export async function getOpenNotes(): Promise<string[]> {
  return invoke("get_open_notes");
}

export async function showWindow(label: string): Promise<void> {
  return invoke("show_window", { label });
}

export async function quitApp(): Promise<void> {
  return invoke("quit_app");
}

/** （重新）注册全部全局快捷键（呼出 / 全部关闭 / 新建便签），设置保存后调用 */
export async function registerShortcuts(): Promise<void> {
  return invoke("register_shortcuts");
}

export async function loadSettings(): Promise<Settings> {
  return invoke<Settings>("load_settings");
}

export async function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}

/** 将自定义 Markdown 样式 CSS 写入磁盘文件，返回其绝对路径 */
export async function saveMdCustom(content: string): Promise<string> {
  return invoke<string>("save_md_custom", { content });
}

/** 读取自定义 Markdown 样式 CSS 文件内容（不存在时返回空串） */
export async function readMdCustom(): Promise<string> {
  return invoke<string>("read_md_custom");
}

/** 用系统默认程序打开指定文件 */
export async function openFile(path: string): Promise<void> {
  return invoke("open_file", { path });
}

/** 用大模型整理便签文本格式。outputFormat = "md" 返回 Markdown，其它返回纯文本。 */
export async function formatWithLLM(content: string, outputFormat: string): Promise<string> {
  return invoke<string>("format_with_llm", { content, outputFormat });
}

/** 用资源管理器打开指定目录 */
export async function openFolder(path: string): Promise<void> {
  return invoke("open_folder", { path });
}

/** 返回实际生效的便签存储目录（已把默认/无效 notes_dir 解析为真实绝对路径） */
export async function effectiveNotesDir(): Promise<string> {
  return invoke<string>("effective_notes_dir");
}

/** 把（已压缩的）背景图 data URL 写入磁盘，返回其绝对路径（settings 只存路径，避免 base64 过大） */
export async function saveBgImage(dataUrl: string, key: string): Promise<string> {
  return invoke<string>("save_bg_image", { dataUrl, key });
}

/** 读取背景图文件，返回可用于 CSS 背景的 data URL */
export async function readBgImage(path: string): Promise<string> {
  return invoke<string>("read_bg_image", { path });
}

/** 读取当前桌面壁纸路径（透明模式把“背后内容”当图片做毛玻璃用） */
export async function getWallpaper(): Promise<string> {
  return invoke<string>("get_wallpaper");
}

/** 截取“指定屏幕区域”的实时画面，返回 JPEG 原始字节（Uint8Array）。
 * 透明主题用它做实时毛玻璃底图：前端经 createImageBitmap 解码后用 canvas 绘制（GPU 合成）。
 * 坐标单位为逻辑像素。Tauri 会把 Rust 的 Vec<u8> 作为二进制 ArrayBuffer 传出，零 base64 开销。 */
export async function captureScreenRegion(
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number
): Promise<Uint8Array> {
  const res = await invoke("capture_screen_region", { x, y, w, h, scale });
  return res instanceof Uint8Array ? res : new Uint8Array(res as ArrayBuffer);
}

/** 原生亚克力（DWM 实时毛玻璃，零截屏延迟，Windows 11 设置同款）：
 *  enable 总开关；opacity 0~255 等价“背景不透明度”（0 = 纯模糊无着色）；
 *  tintRgb 为着色色值 0xRRGGBB（配合主题色）。 */
export async function setAcrylic(enable: boolean, opacity: number, tintRgb: number): Promise<void> {
  return invoke("set_acrylic", { enable, opacity, tintRgb });
}

/** 打开独立的“设置”窗口（与便签窗口解耦，自带固定尺寸）。 */
export async function openSettingsWindow(): Promise<void> {
  return invoke("open_settings_window");
}

/** 删除背景图文件（仅限 bg/ 目录内） */
export async function deleteBgImage(path: string): Promise<void> {
  return invoke("delete_bg_image", { path });
}

/** 用系统原生目录选择器挑选一个目录，返回其绝对路径（Tauri dialog 插件，跨平台可靠）。 */
export async function selectFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择便签存储目录",
  });
  // 单目录选择返回 string | null
  return typeof selected === "string" ? selected : null;
}
