// 在 release 模式下隐藏 Windows 控制台黑窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use chrono::TimeZone;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri::ipc::Response;

#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
struct NoteData {
    content: String,
    title: String,
    /// 是否展示翻译区（每个便签独立配置，默认不展示）
    #[serde(default)]
    translate: bool,
    /// Markdown 预览模式：none / preview / split（每个便签独立配置，默认 none）
    md: String,
    pinned: bool,
    created: u64,
    updated: u64,
    width: u32,
    height: u32,
    /// 窗口最后一次所在位置（物理像素，跨重启记忆；无值时居中）。
    /// 用 f64：Tauri outerPosition() 在缩放屏下返回小数，i32 会让 serde 反序列化整体失败、位置丢失。
    #[serde(default)]
    pos_x: Option<f64>,
    #[serde(default)]
    pos_y: Option<f64>,
    /// 自定义背景图片（base64 data URL，可空）
    #[serde(default)]
    bg_image: Option<String>,
}

impl Default for NoteData {
    fn default() -> Self {
        let now = now_secs();
        Self {
            content: String::new(),
            title: String::new(),
            translate: false,
            md: "none".to_string(),
            pinned: true,
            created: now,
            updated: now,
            width: 420,
            height: 440,
            pos_x: None,
            pos_y: None,
            bg_image: None,
        }
    }
}

#[derive(Debug, Serialize)]
struct NoteMeta {
    id: String,
    title: String,
    snippet: String,
    updated_str: String,
    updated: u64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn storage_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| {
        std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string())
    });
    PathBuf::from(appdata).join("StickyNotes")
}

/// 由 settings.notes_dir 字段推导实际便签目录：空或无效路径时回退默认应用数据目录。
fn notes_dir_of(field: &str) -> PathBuf {
    if !field.trim().is_empty() {
        let p = PathBuf::from(field);
        // 目录已存在，或父目录存在（可新建）即视为可用
        if p.is_dir() || p.parent().map_or(false, |pp| pp.exists()) {
            return p;
        }
    }
    storage_dir()
}

/// 便签存储目录：读取设置中的 notes_dir，无效时回退默认应用数据目录。
fn notes_dir() -> PathBuf {
    notes_dir_of(&load_settings_inner().notes_dir)
}

fn note_path(id: &str) -> PathBuf {
    notes_dir().join(format!("sticky_note_{}.json", id))
}

/// 确保“设置/缓存”目录存在（固定为应用数据目录，与便签存储目录解耦）。
fn ensure_storage() -> Result<(), String> {
    std::fs::create_dir_all(storage_dir()).map_err(|e| e.to_string())
}

/// 确保便签存储目录存在（可能已被用户自定义）。
fn ensure_notes_dir() -> Result<(), String> {
    std::fs::create_dir_all(notes_dir()).map_err(|e| e.to_string())
}

/// 把旧便签目录里的 sticky_note_*.json 迁移到新目录（跨盘则复制后删除）。
fn migrate_notes_to(from: &PathBuf, to: &PathBuf) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    if let Ok(entries) = std::fs::read_dir(from) {
        for entry in entries.flatten() {
            let p = entry.path();
            let ok = p
                .file_name()
                .map(|n| n.to_string_lossy().starts_with("sticky_note_"))
                .unwrap_or(false)
                && p.extension().map_or(false, |e| e == "json");
            if !ok {
                continue;
            }
            let dest = to.join(p.file_name().unwrap());
            // 同盘 rename 即可；跨盘 rename 失败则复制后删除（保留原文件以防中断）
            if std::fs::rename(&p, &dest).is_err() {
                if std::fs::copy(&p, &dest).is_ok() {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }
    Ok(())
}

/// 去除 HTML 标签，提取纯文本用于历史列表摘要
fn strip_html(html: &str) -> String {
    // 粗略去标签：遇到 < 跳到 >，把 &nbsp; 替换为空格
    let mut result = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result.replace("&nbsp;", " ")
}

#[tauri::command]
fn load_note(id: &str) -> Result<Option<NoteData>, String> {
    let path = note_path(id);
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let data: NoteData = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(Some(data))
}

#[tauri::command]
fn save_note(id: &str, data: NoteData) -> Result<(), String> {
    ensure_notes_dir()?;
    let path = note_path(id);
    // 空便签（无内容且无标题）不落盘：删除可能残留的空文件，避免历史列表出现“空便签”条目。
    let plain = strip_html(&data.content);
    if plain.trim().is_empty() && data.title.trim().is_empty() {
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
        return Ok(());
    }
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_notes() -> Result<Vec<NoteMeta>, String> {
    ensure_notes_dir()?;
    let mut items = Vec::new();
    let entries = std::fs::read_dir(notes_dir()).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        // 只把 sticky_note_<id>.json 视为便签，排除 settings.json / open_notes.json 等配置文件
        if !name.starts_with("sticky_note_") {
            continue;
        }
        let id = name.strip_prefix("sticky_note_").unwrap_or(name).to_string();
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let data: NoteData = match serde_json::from_str(&content) {
            Ok(d) => d,
            Err(_) => continue,
        };
        // content 可能是 HTML，去标签后取纯文本
        let plain = strip_html(&data.content);
        let first = plain
            .trim()
            .lines()
            .next()
            .unwrap_or("(空便签)")
            .to_string();
        let snippet = if first.is_empty() {
            "(空便签)".to_string()
        } else {
            first.chars().take(36).collect()
        };
        let updated_str = chrono::Local
            .timestamp_opt(data.updated as i64, 0)
            .single()
            .map(|dt| dt.format("%m/%d %H:%M").to_string())
            .unwrap_or_default();

        items.push(NoteMeta {
            id,
            title: data.title.clone(),
            snippet,
            updated_str,
            updated: data.updated,
        });
    }

    items.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(items)
}

#[tauri::command]
fn delete_note(app: AppHandle, id: &str) -> Result<(), String> {
    // 若该便签的窗口正打开，先通知它“已被删除”，令其停止保存/关闭自身，
    // 否则窗口失焦或尺寸变化时会把内容写回磁盘，导致删除后又“复活”。
    if let Some(win) = app.get_webview_window(id) {
        let _ = win.emit("note-deleted", ());
    }
    let path = note_path(id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    // 同时从“打开中”集合移除，防止后续呼出时因文件已删而重新创建（复活）。
    let mut open = load_open_notes();
    open.retain(|x| x != id);
    let _ = save_open_notes(&open);
    rebuild_tray_menu(&app);
    Ok(())
}

// ===== 便签“打开中”状态（独立于设置，单独文件，避免被保存设置时覆盖）=====
// 仅托盘不进任务栏：每个便签窗口“最小化到托盘”视为仍打开（保留在集合里），
// “关闭”视为已关闭（从集合移除）。呼出时重新展示集合里所有便签；集合为空
// 则呼出默认的第一个历史便签。
fn open_notes_path() -> PathBuf {
    storage_dir().join("open_notes.json")
}

fn load_open_notes() -> Vec<String> {
    let p = open_notes_path();
    if !p.exists() {
        return Vec::new();
    }
    let content = std::fs::read_to_string(&p).unwrap_or_default();
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_open_notes(v: &[String]) -> Result<(), String> {
    ensure_storage()?;
    let json = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(open_notes_path(), json).map_err(|e| e.to_string())
}

fn mark_note_open_inner(id: &str) {
    let mut v = load_open_notes();
    if !v.contains(&id.to_string()) {
        v.push(id.to_string());
        let _ = save_open_notes(&v);
    }
}

#[tauri::command]
fn mark_note_open(app: AppHandle, id: String) {
    mark_note_open_inner(&id);
    rebuild_tray_menu(&app);
}

#[tauri::command]
fn mark_note_closed(app: AppHandle, id: String) {
    let mut v = load_open_notes();
    v.retain(|x| x != &id);
    let _ = save_open_notes(&v);
    rebuild_tray_menu(&app);
}

#[tauri::command]
fn get_open_notes(app: AppHandle) -> Vec<String> {
    // 只返回“当前真实存在的窗口”，避免窗口被其它方式关闭（如 Alt+F4）
    // 却没从持久化集合移除时，便签被误判为“打开中”而无法删除。
    let persisted = load_open_notes();
    let mut result: Vec<String> = persisted
        .into_iter()
        .filter(|id| app.get_webview_window(id).is_some())
        .collect();
    // main 永不写入持久化集合，但始终视为“打开中”
    if app.get_webview_window("main").is_some() {
        result.push("main".to_string());
    }
    result
}

#[tauri::command]
fn new_note_id() -> String {
    uuid::Uuid::new_v4().to_string().replace("-", "")[..6].to_string()
}

// ===== 设置（快捷键 / 翻译配置）=====
// 使用应用数据目录下的 settings.json 持久化，所有便签窗口共享同一份配置。

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
struct Settings {
    shortcuts: HashMap<String, String>,
    translation_provider: String,
    /// 输入含中文时，翻译目标语种
    target_when_cjk: String,
    /// 输入为非中文（英文等）时，翻译目标语种
    target_when_latin: String,
    baidu_appid: String,
    baidu_key: String,
    youdao_appkey: String,
    youdao_secret: String,
    /// Markdown 预览主题：default / github / rose-pine / solarized / custom
    md_theme: String,
    /// 自定义主题 CSS 文件在磁盘上的绝对路径（md_theme === "custom" 时生效）
    md_custom_path: String,
    /// 用户上传时的原始文件名（仅用于设置界面展示）
    md_custom_filename: String,
    /// 全局外观主题：light / dark
    #[serde(default)]
    theme: String,
    /// 全局默认背景图片（base64 data URL，可空；单张便签自身背景优先）
    #[serde(default)]
    bg_image: String,
    /// 背景沉浸：整张便签（含标题栏/工具栏）都显示背景，而非仅输入区
    #[serde(default)]
    bg_immersive: bool,
    /// 透明背景：整张便签沉浸式透明，桌面直接透出（开启后背景图片自动清除且不可用）
    #[serde(default)]
    bg_transparent: bool,
    /// 透明背景不透明度 0~1（默认 0.3）；值越大越不透明（毛玻璃效果）
    #[serde(default = "default_bg_glass_opacity")]
    bg_glass_opacity: f64,
    /// 靠边自动收起（QQ 贴边风格）
    #[serde(default)]
    edge_snap: bool,
    /// 便签存储目录（绝对路径，可空；空 = 默认应用数据目录 %APPDATA%/StickyNotes）
    #[serde(default)]
    notes_dir: String,
    /// 大模型 API Base URL（OpenAI 兼容，可空；空 = https://api.openai.com/v1）
    #[serde(default)]
    llm_base_url: String,
    /// 大模型 API Key
    #[serde(default)]
    llm_api_key: String,
    /// 大模型模型名（可空；空 = gpt-4o-mini）
    #[serde(default)]
    llm_model: String,
    /// 翻译结果命名风格：default / snake / camel / snake_abbr / camel_abbr
    #[serde(default)]
    translate_format: String,
    /// 独立“毛玻璃效果”开关：开启后便签内容面板叠加 backdrop-filter 磨砂，
    /// 透明背景时磨砂桌面、背景图片时磨砂背景图（兼容两种模式）。
    #[serde(default = "default_true")]
    glass_enabled: bool,
    /// 毛玻璃强度（0~100%），仅 glass_enabled 开启时生效。
    /// 透明背景：控制面板“透出程度”（原生 Acrylic 模糊强度由系统决定）；
    /// 自定义背景：控制背景图模糊半径（0%=原图，100%≈40px 强模糊）。
    #[serde(default = "default_glass_blur")]
    glass_blur: f64,
    /// 透明主题“背景不透明度”（0~100%）：控制面板半透明深浅。
    /// DWM 只负责背后桌面的实时模糊（无着色），面板 = 主题色按该百分比混入透明
    /// （CSS --trans-opacity，color-mix），与 PowerShell 设置的“背景不透明度”同款。
    #[serde(default = "default_transparent_opacity")]
    transparent_opacity: f64,
    /// 粒子数量 0~100（同时控制“粒子消散”与“粒子吸入”两种动画的粒子规模）：默认 50，上限 100。
    #[serde(default = "default_particle_count", alias = "particle_intensity")]
    particle_count: f64,
    /// 粒子效果风格：flame=火焰消散（默认）/ erode=侵蚀消散（烧纸/酸蚀，羽化软边）。
    #[serde(default = "default_particle_mode")]
    particle_mode: String,
    /// 粒子动画速度（百分比，100=原速，50=半速，200=2倍速）：对所有粒子动画生效。
    #[serde(default = "default_animation_speed")]
    animation_speed: f64,
}

fn default_bg_glass_opacity() -> f64 {
    0.3
}

fn default_true() -> bool {
    true
}

fn default_glass_blur() -> f64 {
    55.0
}

fn default_transparent_opacity() -> f64 {
    65.0
}

fn default_particle_count() -> f64 {
    50.0
}

fn default_particle_mode() -> String {
    "flame".into()
}

fn default_animation_speed() -> f64 {
    100.0
}

impl Default for Settings {
    fn default() -> Self {
        let mut shortcuts = HashMap::new();
        shortcuts.insert("fg_color".into(), "Ctrl+Shift+C".into());
        shortcuts.insert("bg_color".into(), "Ctrl+Shift+B".into());
        shortcuts.insert("size_up".into(), "Ctrl+Plus".into());
        shortcuts.insert("size_down".into(), "Ctrl+Minus".into());
        shortcuts.insert("translate".into(), "Ctrl+Shift+T".into());
        shortcuts.insert("show_app".into(), "Ctrl+O".into());
        shortcuts.insert("close_all".into(), "Ctrl+Shift+X".into());
        shortcuts.insert("new_note".into(), "Ctrl+Shift+N".into());
        Settings {
            shortcuts,
            translation_provider: "mymemory".into(),
            target_when_cjk: "en".into(),
            target_when_latin: "zh".into(),
            baidu_appid: String::new(),
            baidu_key: String::new(),
            youdao_appkey: String::new(),
            youdao_secret: String::new(),
            md_theme: "default".into(),
            md_custom_path: String::new(),
            md_custom_filename: String::new(),
            theme: "light".into(),
            bg_image: String::new(),
            bg_immersive: false,
            bg_transparent: false,
            bg_glass_opacity: 0.3,
            edge_snap: true,
            notes_dir: String::new(),
            llm_base_url: String::new(),
            llm_api_key: String::new(),
            llm_model: String::new(),
            translate_format: "default".into(),
            glass_enabled: true,
            glass_blur: 16.0,
            transparent_opacity: 65.0,
            particle_count: 50.0,
            particle_mode: "flame".into(),
            animation_speed: 100.0,
        }
    }
}

fn settings_path() -> PathBuf {
    storage_dir().join("settings.json")
}

fn load_settings_inner() -> Settings {
    let path = settings_path();
    if !path.exists() {
        return Settings::default();
    }
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    // 容错：手改/工具改写设置文件可能带 UTF-8 BOM（serde_json 不支持，会导致整份配置
    // 解析失败、前端回退默认浅色主题——表现为“透明主题一片白”）。这里剥掉 BOM。
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    // 旧版兼容迁移：把 settings.json 里直接存的 md_custom_css 文本改写为磁盘文件 + 路径引用
    let content = migrate_custom_css(&path, raw);
    match serde_json::from_str::<Settings>(&content) {
        Ok(mut s) => {
            // 补齐缺失的默认快捷键，避免旧配置丢失预设
            let def = Settings::default();
            for (k, v) in def.shortcuts {
                s.shortcuts.entry(k).or_insert(v);
            }
            s
        }
        Err(_) => Settings::default(),
    }
}

/// 旧版兼容：settings.json 曾把自定义 CSS 文本直接存为 md_custom_css 字段；
/// 新版改为磁盘文件 + 路径引用。若检测到旧字段且无新路径，则写出 md_custom.css
/// 并改写配置文件，避免用户之前上传的样式“丢失”。
fn migrate_custom_css(path: &PathBuf, content: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(content) {
        Ok(x) => x,
        Err(_) => return content.to_string(),
    };
    let has_path = v
        .get("md_custom_path")
        .map(|x| x.as_str().map(|s| !s.is_empty()).unwrap_or(false))
        .unwrap_or(false);
    if has_path {
        return content.to_string();
    }
    let css = match v.get("md_custom_css").and_then(|x| x.as_str()) {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => return content.to_string(),
    };
    let custom_path = storage_dir().join("md_custom.css");
    if std::fs::write(&custom_path, &css).is_err() {
        return content.to_string();
    }
    let mut new_v = v.clone();
    new_v["md_custom_path"] =
        serde_json::Value::String(custom_path.to_string_lossy().to_string());
    new_v["md_custom_filename"] = serde_json::Value::String("migrated.css".to_string());
    if let Some(obj) = new_v.as_object_mut() {
        obj.remove("md_custom_css");
    }
    match serde_json::to_string_pretty(&new_v) {
        Ok(s) => {
            let _ = std::fs::write(path, &s);
            s
        }
        Err(_) => content.to_string(),
    }
}

#[tauri::command]
fn load_settings() -> Settings {
    load_settings_inner()
}

/// 返回“实际生效”的便签存储目录（已把默认/无效 notes_dir 解析为真实绝对路径）。
/// 前端在存储路径设置区用它始终显示当前真实位置，避免空的输入框看起来像 bug。
#[tauri::command]
fn effective_notes_dir() -> String {
    notes_dir().to_string_lossy().to_string()
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    // 若便签存储路径发生变更，先把旧目录里的便签文件迁移到新目录（保留历史）。
    let old = load_settings_inner();
    let old_dir = notes_dir_of(&old.notes_dir);
    let new_dir = notes_dir_of(&settings.notes_dir);
    if old_dir != new_dir {
        let _ = migrate_notes_to(&old_dir, &new_dir);
    }
    ensure_storage()?;
    let path = settings_path();
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    // 通知所有窗口（含其它已打开的便签窗口）设置已变更，使其重新读取并应用
    // （否则只有打开设置弹窗的那个窗口会更新，其余便签仍是旧配置，表现像“配置不生效”）。
    let _ = app.emit("settings-changed", ());
    Ok(())
}

// ===== 自定义 Markdown 样式文件（磁盘持久化 + 系统默认程序打开）=====
// 自定义 CSS 以真实文件形式保存在应用数据目录（md_custom.css），
// settings.json 只记录其路径与原始文件名，便于用户随时打开/编辑。

/// 将自定义 CSS 内容写入磁盘文件 md_custom.css，返回其绝对路径。
#[tauri::command]
fn save_md_custom(content: String) -> Result<String, String> {
    ensure_storage()?;
    let path = storage_dir().join("md_custom.css");
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取自定义 CSS 文件内容；文件不存在时返回空串。
#[tauri::command]
fn read_md_custom() -> String {
    let path = storage_dir().join("md_custom.css");
    if !path.exists() {
        return String::new();
    }
    std::fs::read_to_string(&path).unwrap_or_default()
}

// ===== 背景图（磁盘持久化，settings 只存路径）=====
// 背景图体积可能很大，若以 base64 直接塞进 settings.json / 走 IPC，
// 超过几 MB 就会保存或加载失败。因此改为：前端压缩后把图片写到 bg/ 目录，
// settings 只记录其绝对路径；显示时再按需读回为 data URL 套到 CSS 背景上。

/// 背景图专用目录：storage_dir()/bg，确保存在。
fn bg_dir() -> PathBuf {
    let d = storage_dir().join("bg");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// 接收前端传来的（已压缩的）图片 data URL，解码后写入 bg/<key>.<ext>，返回绝对路径。
/// key 用于区分不同背景（全局背景固定用 "global"），重新上传会覆盖同名文件。
#[tauri::command]
fn save_bg_image(data_url: String, key: String) -> Result<String, String> {
    let marker = "base64,";
    let idx = data_url.find(marker).ok_or("无效的图片数据")?;
    let b64 = &data_url[idx + marker.len()..];
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("解码图片失败：{}", e))?;
    let mime = data_url
        .get(5..)
        .and_then(|s| s.find(';').map(|e| &s[..e]))
        .unwrap_or("image/png")
        .to_string();
    let ext = match mime.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    };
    let safe_key: String = key
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let safe_key = if safe_key.is_empty() { "img".to_string() } else { safe_key };
    let path = bg_dir().join(format!("{}.{}", safe_key, ext));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取背景图文件，返回 data URL（供前端套到 CSS 背景）。文件不存在/无法读取时返回错误。
/// 支持无扩展名文件（如 Windows 的 TranscodedWallpaper）：按文件头魔数嗅探真实格式。
#[tauri::command]
fn read_bg_image(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("背景图文件不存在".into());
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "png" => "image/png",
        // 无扩展名（如 TranscodedWallpaper）：按魔数嗅探，避免把 JPEG 内容标成 png 导致解码失败
        _ => {
            if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
                "image/jpeg"
            } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
                "image/png"
            } else if bytes.starts_with(b"RIFF")
                && bytes.len() > 12
                && &bytes[8..12] == b"WEBP"
            {
                "image/webp"
            } else if bytes.starts_with(b"BM") {
                "image/bmp"
            } else if bytes.starts_with(b"GIF8") {
                "image/gif"
            } else {
                "image/png"
            }
        }
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// 读取当前 Windows 桌面壁纸路径，供透明模式把“窗口背后的内容”当作一张图来做毛玻璃。
/// 说明：透明模式不再用采不到桌面的 CSS backdrop-filter，而是把壁纸当背景图、
/// 复用与自定义背景图相同的“图片当背景”路径；前端用 canvas 预模糊+缓存，避免实时 filter:blur 卡顿。
/// 读取：优先注册表 HKCU\Control Panel\Desktop 的 Wallpaper 值；失败则回退 TranscodedWallpaper（ASCII 路径，中文用户名也不会乱码）。
/// 非 Windows / 都失败 / 无壁纸时返回空串，前端回退到主题色半透明面板（可见但不做磨砂）。
#[tauri::command]
fn get_wallpaper() -> String {
    #[cfg(target_os = "windows")]
    {
        // 1) 注册表 Wallpaper 值（注意：reg.exe 输出为系统代码页，含中文路径时 from_utf8_lossy 可能乱码；
        //    若乱码导致 Path::exists() 为假，会自动落到下面的 TranscodedWallpaper 兜底，故不影响正确性）
        if let Ok(out) = std::process::Command::new("reg")
            .args(["query", "HKCU\\Control Panel\\Desktop", "/v", "Wallpaper"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                if line.contains("Wallpaper") && line.contains("REG_SZ") {
                    if let Some(idx) = line.find("REG_SZ") {
                        let p = line[idx + "REG_SZ".len()..].trim().to_string();
                        if !p.is_empty() && std::path::Path::new(&p).exists() {
                            return p;
                        }
                    }
                }
            }
        }
        // 2) 兜底：Windows 把实际壁纸缓存为 TranscodedWallpaper（路径固定、ASCII，不会因中文用户名乱码）
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let tm = std::path::Path::new(&profile)
                .join("AppData")
                .join("Roaming")
                .join("Microsoft")
                .join("Windows")
                .join("Themes")
                .join("TranscodedWallpaper");
            if tm.exists() {
                return tm.to_string_lossy().to_string();
            }
        }
        String::new()
    }
    #[cfg(not(target_os = "windows"))]
    {
        String::new()
    }
}

/// 删除背景图文件（仅允许删除 bg/ 目录内的文件，防误删系统文件）。
#[tauri::command]
fn delete_bg_image(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let base = bg_dir();
    if !p.starts_with(&base) {
        return Err("只能删除背景图目录内的文件".into());
    }
    if p.exists() {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// 用操作系统默认程序打开指定文件（用于“编辑自定义样式”）。
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("路径为空".to_string());
    }
    if !std::path::Path::new(&path).exists() {
        return Err(format!("文件不存在: {}", path));
    }
    #[cfg(target_os = "windows")]
    {
        // 直接把原始路径交给 Command::args，由 Rust 按 CommandLineToArgvW 规则自动决定
        // 是否加引号、如何转义。早期版本用 format!("\"{}\"", path) 手动预加引号，
        // Rust 会把内部 " 转义为 \"，而 cmd.exe 不把 \" 当转义，结果把 "css\"" 拆成
        // \ + css + \ + 空，start 拼出 "md_custom.cass\" 这种被篡改的路径。
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 用资源管理器打开指定目录（用于“打开便签存储目录”）。目录不存在时先创建。
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ===== 翻译 =====

#[derive(Debug, Serialize)]
struct TranslateOut {
    text: String,
    provider: String,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// RFC3986 非保留字符原样保留，其余按 UTF-8 字节做百分号编码（用于 GET 查询参数）
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        let u = c as u32;
        (0x4E00..=0x9FFF).contains(&u) || (0x3000..=0x303F).contains(&u) || (0xFF00..=0xFFEF).contains(&u)
    })
}

/// 简单语种对推断：含中文则 zh->target，否则 target->zh
fn detect_pair(text: &str, target: &str) -> (String, String) {
    if has_cjk(text) {
        ("zh".to_string(), target.to_string())
    } else {
        (target.to_string(), "zh".to_string())
    }
}

/// 纯 Rust 实现的 MD5（百度翻译签名需要），返回小写十六进制串
fn md5_hex(input: &[u8]) -> String {
    let mut msg = input.to_vec();
    let orig_len_bits = (msg.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&orig_len_bits.to_le_bytes());

    let s: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21,
        6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let k: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ];

    let mut a0: u32 = 0x67452301;
    let mut b0: u32 = 0xefcdab89;
    let mut c0: u32 = 0x98badcfe;
    let mut d0: u32 = 0x10325476;

    for chunk in msg.chunks(64) {
        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = u32::from_le_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let f = f
                .wrapping_add(a)
                .wrapping_add(k[i])
                .wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f.rotate_left(s[i]));
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..16].copy_from_slice(&d0.to_le_bytes());
    out.iter().map(|b| format!("{:02x}", b)).collect()
}

#[tauri::command]
async fn translate(text: String, target: Option<String>) -> Result<TranslateOut, String> {
    let settings = load_settings_inner();
    let client = reqwest::Client::new();
    // 目标语言：优先用前端传入的覆盖值（非 "auto"），否则按输入语种自动（中文->target_when_cjk，否则->target_when_latin）
    let target = match target {
        Some(t) if !t.is_empty() && t != "auto" => t,
        _ => {
            if has_cjk(&text) {
                if settings.target_when_cjk.is_empty() {
                    "en".to_string()
                } else {
                    settings.target_when_cjk.clone()
                }
            } else {
                if settings.target_when_latin.is_empty() {
                    "zh".to_string()
                } else {
                    settings.target_when_latin.clone()
                }
            }
        }
    };

    match settings.translation_provider.as_str() {
        "baidu" => {
            if settings.baidu_appid.is_empty() || settings.baidu_key.is_empty() {
                return Err("请先在设置中配置百度翻译的 AppID 与密钥".into());
            }
            let salt = now_ms().to_string();
            let sign = md5_hex(
                format!("{}{}{}{}", settings.baidu_appid, text, salt, settings.baidu_key).as_bytes(),
            );
            let params = [
                ("q", text.as_str()),
                ("from", "auto"),
                ("to", target.as_str()),
                ("appid", settings.baidu_appid.as_str()),
                ("salt", salt.as_str()),
                ("sign", sign.as_str()),
            ];
            let resp = client
                .post("https://fanyi-api.baidu.com/api/trans/vip/translate")
                .form(&params)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            if let Some(msg) = body.get("error_msg").and_then(|v| v.as_str()) {
                return Err(format!("百度翻译错误: {}", msg));
            }
            let translated = body["trans_result"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|o| o["dst"].as_str())
                .unwrap_or("")
                .to_string();
            Ok(TranslateOut {
                text: translated,
                provider: "baidu".into(),
            })
        }
        "youdao" => {
            if settings.youdao_appkey.is_empty() || settings.youdao_secret.is_empty() {
                return Err("请先在设置中配置有道翻译的 AppKey 与密钥".into());
            }
            let salt = now_ms().to_string();
            let curtime = now_secs().to_string();
            let input = if text.chars().count() <= 20 {
                text.clone()
            } else {
                let head: String = text.chars().take(10).collect();
                let tail: String = text.chars().rev().take(10).collect::<String>().chars().rev().collect();
                format!("{}{}", head, tail)
            };
            let sign_raw = format!(
                "{}{}{}{}{}",
                settings.youdao_appkey, input, salt, curtime, settings.youdao_secret
            );
            let mut hasher = Sha256::new();
            hasher.update(sign_raw.as_bytes());
            let sign = format!("{:x}", hasher.finalize());
            let params = [
                ("q", text.as_str()),
                ("from", "auto"),
                ("to", target.as_str()),
                ("appKey", settings.youdao_appkey.as_str()),
                ("salt", salt.as_str()),
                ("sign", sign.as_str()),
                ("signType", "v3"),
                ("curtime", curtime.as_str()),
            ];
            let resp = client
                .post("https://openapi.youdao.com/api")
                .form(&params)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            if let Some(code) = body.get("errorCode").and_then(|v| v.as_str()) {
                if code != "0" {
                    return Err(format!("有道翻译错误: {}", code));
                }
            }
            let translated = body["translation"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Ok(TranslateOut {
                text: translated,
                provider: "youdao".into(),
            })
        }
        _ => {
            // MyMemory：免密钥，开箱即用
            let (from, to) = detect_pair(&text, &target);
            let url = format!(
                "https://api.mymemory.translated.net/get?q={}&langpair={}|{}",
                urlencode(&text),
                from,
                to
            );
            let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
            let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let translated = body["responseData"]["translatedText"]
                .as_str()
                .unwrap_or("")
                .to_string();
            if translated.is_empty() {
                return Err("翻译失败，请稍后重试".into());
            }
            Ok(TranslateOut {
                text: translated,
                provider: "mymemory".into(),
            })
        }
    }
}

/// 用大模型（OpenAI 兼容接口）整理便签文本格式。
/// output_format = "md" 时整理为干净的 Markdown；其它值整理为纯文本。
/// 返回模型整理后的结果文本，由前端做 git 风格差异对比后再决定是否接受。
#[tauri::command]
async fn format_with_llm(content: String, output_format: String) -> Result<String, String> {
    let settings = load_settings_inner();
    if settings.llm_api_key.trim().is_empty() {
        return Err("请先在设置中填写大模型 API Key".into());
    }
    let base = if settings.llm_base_url.trim().is_empty() {
        "https://api.openai.com/v1".to_string()
    } else {
        settings.llm_base_url.trim_end_matches('/').to_string()
    };
    // 兼容“只填到 /chat/completions 之前”或“填到 /v1 之后”的情况
    let url = if base.ends_with("/chat/completions") {
        base
    } else {
        format!("{}/chat/completions", base)
    };
    let model = if settings.llm_model.trim().is_empty() {
        "gpt-4o-mini".to_string()
    } else {
        settings.llm_model.trim().to_string()
    };

    let of = output_format.trim();
    let (sys_instr, user_instr) = if of == "md" {
        (
            "You are a formatting assistant. Reformat the user's note into clean, well-structured MARKDOWN.\n\
             WHAT TO DO (this is the main task -- you MUST add Markdown structure):\n\
             - Turn section titles/labels into Markdown headings, e.g. `## 8981环境账号密码`.\n\
             - Turn repeated items into `-` bullet lists.\n\
             - Wrap commands and code snippets in fenced code blocks (```bash ... ```).\n\
             - Use tables or **bold** where it improves clarity.\n\
             - Put a blank line between blocks so the Markdown renders correctly.\n\
             CRITICAL -- PRESERVE ALL CONTENT (this must NOT override the structure above):\n\
             - Keep EVERY line, number, name, URL, email, password, token, credential and code snippet EXACTLY as given. Do not drop, merge, deduplicate, reorder, translate, or alter any fact.\n\
             - The note may contain passwords / API keys / credentials. This is the user's PRIVATE data: output ALL of it verbatim. Do NOT redact, mask, hide, refuse, or 'clean up' anything for safety reasons.\n\
             - Adding `#`/`##`, `-`, or code fences is STRUCTURAL formatting and is REQUIRED here -- it is NOT 'rewriting' the user's wording; the text of each item stays exactly as written.\n\
             - Output ONLY the Markdown text. No commentary, no explanation, no surrounding code fence.\n\
             EXAMPLE (input -> output):\n\
             输入：\n\
             测试环境账号：\n\
             alice\n\
             secret123\n\
             bob\n\
             secret456\n\
             \n\
             启动命令：\n\
             python main.py\n\
             输出：\n\
             ## 测试环境账号\n\
             - alice\n\
             - secret123\n\
             - bob\n\
             - secret456\n\
             \n\
             ## 启动命令\n\
             ```bash\n\
             python main.py\n\
             ```"
                .to_string(),
            "Reformat the following note into clean Markdown:",
        )
    } else if of == "id_snake" || of == "id_camel" {
        let style_name = if of == "id_snake" { "snake_case" } else { "camelCase" };
        let style_rule = if of == "id_snake" {
            "Use lowercase letters and digits only; separate words with a single underscore."
        } else {
            "Start with a lowercase letter; capitalize the first letter of every following word; no separators."
        };
        (
            format!(
                "You are a programming identifier generator. Given a short phrase (which may be in Chinese or English) that describes a variable, field, function, or concept, output a SINGLE concise {style_name} identifier.\n\
                 Rules:\n\
                 1) Understand the meaning first. If the phrase is not in English, translate its meaning into English.\n\
                 2) Keep only the essential naming words; drop filler words (the, a, an, of, for, to, my, your) unless they carry meaning.\n\
                 3) Abbreviate long words using widely-recognized shortenings, e.g.: authentication->auth, configuration->config, environment->env, number->num, current->cur, window->win, manager->mgr, application->app, directory->dir, database->db, reference->ref, total->tot, maximum->max, minimum->min, length->len, count->cnt, description->desc, information->info, parameter->param, property->prop, request->req, response->res, temporary->tmp, previous->prev, next->nxt, default->def.\n\
                 Only use abbreviations that are commonly understood; when unsure, keep the full word. Never invent cryptic or ambiguous abbreviations.\n\
                 4) Case style: {style_rule}\n\
                 5) Use only letters, digits, and (for snake_case) underscores. No spaces, hyphens, or other punctuation.\n\
                 6) No leading or trailing separators, and never two separators in a row.\n\
                 7) Output ONLY the identifier. No explanation, no quotes, no code fences, no surrounding text.",
                style_name = style_name,
                style_rule = style_rule,
            ),
            "Generate an identifier for the following phrase:",
        )
    } else {
        (
            "You are a meticulous formatting assistant. Your ONLY job is to reformat the user's note into clean plain text. \
             Strict rules: \
             1) Preserve 100% of the original information VERBATIM. Every line, sentence, list item, number, name, URL, email, password, token, credential, and code snippet MUST appear in the output with its exact text. Do not drop, merge, deduplicate, or summarize any content. \
             2) CRITICAL: The note may contain passwords, API keys, tokens, credentials, or other sensitive-looking text. This is the user's PRIVATE data. You MUST output ALL of it exactly as given. Do NOT redact, mask, hide, refuse, or \"clean up\" any part for safety reasons; preserving the user's content exactly is the top priority. \
             3) Do NOT invent, guess, translate, or alter any facts. Keep the note's original language. \
             4) Do NOT rewrite the meaning or wording of the content; only adjust its structure (clear paragraphs, consistent punctuation, simple indentation/lists). \
             5) Do NOT use any Markdown symbols. Output ONLY the plain text, with no commentary or explanation."
                .to_string(),
            "Please reformat the following note into clean plain text:",
        )
    };

    let messages = serde_json::json!([
        { "role": "system", "content": sys_instr },
        { "role": "user", "content": format!("{}\n\n{}", user_instr, content) }
    ]);

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": 0.0,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(settings.llm_api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("大模型请求失败 ({}): {}", status, detail));
    }

    let resp_json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let formatted = resp_json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if formatted.trim().is_empty() {
        return Err("大模型返回为空，请重试".into());
    }
    // 去掉模型可能夹带的 ```markdown / ``` 围栏
    let cleaned = strip_code_fences(&formatted);
    Ok(cleaned)
}

/// 去掉模型输出外层可能包裹的 ```lang ... ``` 代码围栏。
fn strip_code_fences(text: &str) -> String {
    let t = text.trim();
    let fence_start = t.find("```");
    if let Some(start) = fence_start {
        // 仅当末尾也有 ``` 时视为围栏
        if t.ends_with("```") {
            let after = &t[start + 3..];
            // 去掉首行的语言标识（如 ```markdown）
            let rest = if let Some(nl) = after.find('\n') {
                &after[nl + 1..]
            } else {
                after
            };
            let inner = &rest[..rest.len() - 3];
            return inner.trim().to_string();
        }
    }
    text.trim().to_string()
}

#[tauri::command]
async fn start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_always_on_top(window: tauri::WebviewWindow, pinned: bool) -> Result<(), String> {
    window.set_always_on_top(pinned).map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    // 便签窗口（含 main）关闭 = 隐藏到托盘：保留 webview 常驻，
    // 下次呼出仅是 show()，瞬时出现且位置/状态完全保留（也是“呼出卡顿”的根治）。
    // 辅助窗口（历史/设置）仍真正关闭，避免长期驻留占内存。
    match window.label() {
        "history" | "settings" => window.close().map_err(|e| e.to_string()),
        _ => window.hide().map_err(|e| e.to_string()),
    }
}

#[tauri::command]
async fn minimize_to_taskbar(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
async fn minimize_to_tray(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
async fn show_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn quit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

/// 把设置里存的组合（如 "Ctrl+O"）转成全局快捷键插件可解析的形式（如 "ctrl+o"）
fn to_accelerator(combo: &str) -> String {
    combo
        .replace("Ctrl", "ctrl")
        .replace("Alt", "alt")
        .replace("Shift", "shift")
        .replace("Meta", "meta")
        .replace("Plus", "+")
        .replace("Minus", "-")
        .replace("Space", "space")
        .to_lowercase()
}

/// 动态（重新）注册全部全局快捷键（呼出 / 全部关闭 / 新建便签）。
/// 设置保存后由前端调用；启动时也在 setup 中调用一次。
/// 同一组合可绑定到多个动作：注册时对组合去重（避免重复 register 报错），
/// 触发时由 dispatch_shortcut 把绑定到该组合的所有动作都执行一遍。
fn register_all_shortcuts(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    let settings = load_settings_inner();
    let mut seen = std::collections::HashSet::new();
    for key in ["show_app", "close_all", "new_note"] {
        if let Some(combo) = settings.shortcuts.get(key) {
            let acc = to_accelerator(combo);
            if !acc.is_empty() && seen.insert(acc.clone()) {
                let _ = app.global_shortcut().register(acc.as_str());
            }
        }
    }
}

#[tauri::command]
fn register_shortcuts(app: AppHandle) -> Result<(), String> {
    register_all_shortcuts(&app);
    Ok(())
}

/// 全局快捷键动作枚举，供分发时匹配。
#[derive(PartialEq)]
enum ShortcutAction {
    Show,
    CloseAll,
    NewNote,
}

/// 根据触发快捷键的 id 分发到对应动作。
/// 注意：同一组合可能绑定多个动作，因此这里把匹配到的动作都收集起来再统一处理。
/// 特别地，当“呼出”与“全部关闭”绑定到同一组合时，二者不能各跑一遍（否则先开再关、
/// 净效果为关闭，表现为“按一下先弹出又立刻收起”）。此时改为一次切换：若当前有便签
/// 窗口可见则全部关闭，否则全部呼出。
fn dispatch_shortcut(app: &AppHandle, id: u32) {
    let settings = load_settings_inner();
    let actions = [
        ("show_app", ShortcutAction::Show),
        ("close_all", ShortcutAction::CloseAll),
        ("new_note", ShortcutAction::NewNote),
    ];
    let mut matched: Vec<ShortcutAction> = Vec::new();
    for (key, action) in actions {
        if let Some(combo) = settings.shortcuts.get(key) {
            if let Ok(hk) = tauri_plugin_global_shortcut::Shortcut::from_str(&to_accelerator(combo)) {
                if hk.id() == id {
                    matched.push(action);
                }
            }
        }
    }
    // “呼出”与“全部关闭”同一快捷键：做一次切换而非“先开再关”。
    if matched.contains(&ShortcutAction::Show) && matched.contains(&ShortcutAction::CloseAll) {
        let any_visible = app
            .webview_windows()
            .values()
            .any(|w| w.is_visible().unwrap_or(false));
        if any_visible {
            close_all_with_anim(app);
        } else {
            show_all_open(app, false);
        }
        if matched.contains(&ShortcutAction::NewNote) {
            quick_new_note(app);
        }
        return;
    }
    // 其余情况（各动作绑定到不同组合）按收集到的动作逐一执行。
    for action in matched {
        match action {
            ShortcutAction::Show => show_all_open(app, false),
            ShortcutAction::CloseAll => close_all_with_anim(app),
            ShortcutAction::NewNote => quick_new_note(app),
        }
    }
}

/// “全部关闭”：向每个可见便签窗口广播 play-close-anim，由各窗口自行播放
/// 关闭动画（粒子消散）后再隐藏到托盘。辅助窗口（设置/历史）不受影响。
fn close_all_with_anim(app: &AppHandle) {
    for (_label, win) in app.webview_windows() {
        if !win.is_visible().unwrap_or(false) {
            continue;
        }
        if matches!(win.label(), "settings" | "history") {
            continue;
        }
        let _ = win.emit("play-close-anim", ());
    }
}

/// “全部关闭”：把所有便签窗口隐藏到托盘（保留进程，可再次呼出）。辅助窗口不受影响。
#[tauri::command]
fn close_all_notes(app: AppHandle) -> Result<(), String> {
    for (_label, win) in app.webview_windows() {
        if matches!(win.label(), "settings" | "history") {
            continue;
        }
        let _ = win.hide();
    }
    Ok(())
}

/// 把新建窗口的左上角 (x, y) 钳制到主显示器工作区内，确保窗口（宽 w 高 h）整体可见、不超出屏幕边界。
fn clamp_to_workarea(x: f64, y: f64, w: f64, h: f64, app: &AppHandle) -> (f64, f64) {
    if let Ok(Some(mon)) = app.primary_monitor() {
        let wa = mon.work_area();
        let min_x = wa.position.x as f64;
        let min_y = wa.position.y as f64;
        let max_x = (wa.position.x as f64 + wa.size.width as f64) - w;
        let max_y = (wa.position.y as f64 + wa.size.height as f64) - h;
        let cx = if max_x >= min_x { x.max(min_x).min(max_x) } else { min_x };
        let cy = if max_y >= min_y { y.max(min_y).min(max_y) } else { min_y };
        return (cx, cy);
    }
    (x, y)
}

#[tauri::command]
async fn create_note_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    mark_note_open_inner(&id);
    rebuild_tray_menu(&app);
    let pos = window.outer_position().unwrap_or_default();
    let x = pos.x as f64 + 30.0;
    let y = pos.y as f64 + 30.0;
    let (x, y) = clamp_to_workarea(x, y, 420.0, 440.0, &app);
    let url = format!("index.html?noteId={}", id);
        let win = WebviewWindowBuilder::new(&app, &id, WebviewUrl::App(url.into()))
            .title("便签")
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .always_on_top(true)
            .inner_size(420.0, 440.0)
            .min_inner_size(220.0, 150.0)
            .position(x, y)
            .visible(false)
            .shadow(false)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
async fn open_note_window(app: AppHandle, id: String) -> Result<(), String> {
    mark_note_open_inner(&id);
    rebuild_tray_menu(&app);
    ensure_note_window(&app, &id);
    // 通知前端播放粒子成形呼出动画（与 show_all_open / 托盘点击同一事件）
    if let Some(win) = app.get_webview_window(&id) {
        let _ = win.emit("summoned", ());
    }
    Ok(())
}

/// 确保某个便签窗口存在并展示：已存在则显示/取消最小化/聚焦；不存在则新建并展示。
/// 新建时沿用该便签记忆的尺寸与最后位置（钳制到工作区内），无记忆才居中。
fn ensure_note_window(app: &AppHandle, id: &str) {
    if let Some(win) = app.get_webview_window(id) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    } else {
        let saved = load_note(id).ok().flatten();
        let (w, h) = saved
            .as_ref()
            .map(|n| (n.width.max(220) as f64, n.height.max(150) as f64))
            .unwrap_or((420.0, 440.0));
        let saved_pos = saved
            .as_ref()
            .and_then(|n| Some((n.pos_x?, n.pos_y?)));
        let url = format!("index.html?noteId={}", id);
        let mut builder = WebviewWindowBuilder::new(app, id, WebviewUrl::App(url.into()))
            .title("便签")
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .always_on_top(true)
            .inner_size(w, h)
            .min_inner_size(220.0, 150.0)
            .visible(false)
            .shadow(false)
            .skip_taskbar(true);
        builder = match saved_pos {
            Some((px, py)) => {
                // 记忆位置是物理像素；builder.position 接收逻辑坐标，这里换算后再钳制到工作区
                let scale = app
                    .primary_monitor()
                    .ok()
                    .flatten()
                    .map(|m| m.scale_factor())
                    .unwrap_or(1.0);
                let (cx, cy) = clamp_to_workarea(px as f64, py as f64, w * scale, h * scale, app);
                builder.position(cx / scale, cy / scale)
            }
            None => builder.center(),
        };
        if let Ok(win) = builder.build() {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// 向前台窗口发送 Ctrl+C，把当前选中的文本复制到剪贴板（Windows 下用 user32!keybd_event）。
#[cfg(target_os = "windows")]
fn send_copy_to_foreground() {
    #[link(name = "user32")]
    extern "system" {
        fn keybd_event(bVk: u8, bScan: u8, dwFlags: u32, dwExtraInfo: usize);
    }
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const VK_CONTROL: u8 = 0x11;
    unsafe {
        keybd_event(VK_CONTROL, 0, 0, 0); // Ctrl 按下
        keybd_event(0x43, 0, 0, 0); // C 按下
        keybd_event(0x43, 0, KEYEVENTF_KEYUP, 0); // C 抬起
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0); // Ctrl 抬起
    }
}

/// 抓取当前前台窗口中选中的文本：先记住原剪贴板，向前台窗口发 Ctrl+C，
/// 稍候读回剪贴板；若内容与原来不同（说明确有选区被复制），返回该文本，
/// 并把原剪贴板还原（不覆盖用户已有内容）。无任何选中时返回空串。
#[cfg(target_os = "windows")]
fn capture_selection() -> String {
    let original = arboard::Clipboard::new()
        .ok()
        .and_then(|mut c| c.get_text().ok())
        .unwrap_or_default();
    send_copy_to_foreground();
    // 等前台窗口处理复制（部分程序复制有延迟）
    std::thread::sleep(std::time::Duration::from_millis(150));
    let captured = arboard::Clipboard::new()
        .ok()
        .and_then(|mut c| c.get_text().ok())
        .unwrap_or_default();
    // 还原用户原剪贴板（忽略失败）
    if let Ok(mut c) = arboard::Clipboard::new() {
        let _ = c.set_text(original.clone());
    }
    if !captured.trim().is_empty() && captured != original {
        captured
    } else {
        String::new()
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_selection() -> String {
    // 非 Windows 暂不支持模拟复制，便签为空白。
    String::new()
}

/// “全局快捷速记”：在任意位置按下快捷键，直接新建一张空白便签窗口并聚焦输入，
/// 无需先打开主窗口。若按下快捷键时其他程序中有选中文本，会自动抓取并预填到便签。
/// 窗口按主显示器工作区居中，并按已打开便签数量做轻微层叠偏移，避免连续速记重叠。
fn quick_new_note(app: &AppHandle) {
    // 尝试抓取当前选中的文本（有则预填，无则空白便签）
    let preset = capture_selection();
    let id = uuid::Uuid::new_v4().to_string().replace("-", "")[..6].to_string();
    mark_note_open_inner(&id);
    rebuild_tray_menu(app);
    if let Ok(Some(mon)) = app.primary_monitor() {
        let wa = mon.work_area();
        let mut x = wa.position.x as f64 + (wa.size.width as f64 - 420.0) / 2.0;
        let mut y = wa.position.y as f64 + (wa.size.height as f64 - 440.0) / 2.0;
        let open_count = app.webview_windows().len() as f64;
        let cascade = open_count * 26.0;
        x += cascade % 220.0;
        y += cascade % 220.0;
        let (cx, cy) = clamp_to_workarea(x, y, 420.0, 440.0, app);
        x = cx;
        y = cy;
        let mut url = format!("index.html?noteId={}", id);
        if !preset.is_empty() {
            url.push_str("&preset=");
            url.push_str(&urlencode(&preset));
        }
        if let Ok(win) = WebviewWindowBuilder::new(app, &id, WebviewUrl::App(url.into()))
            .title("便签")
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .always_on_top(true)
            .inner_size(420.0, 440.0)
            .min_inner_size(220.0, 150.0)
            .position(x, y)
            .visible(false)
            .shadow(false)
            .skip_taskbar(true)
            .build()
        {
            let _ = win.show();
            let _ = win.set_focus();
        }
    } else {
        // 兜底：拿不到显示器信息时直接居中新建（与呼出逻辑一致）
        ensure_note_window(app, &id);
    }
}

/// “呼出便签”：重新展示所有“打开中”的便签窗口；若集合为空，则呼出默认的第一个
/// 历史便签（按更新时间排序的首个，无历史则打开 main）。
/// 呼出“打开中”的便签窗口。
/// - startup=true（应用启动）：只弹出一个便签（默认 / 第一个），避免每次启动恢复多个窗口。
///   打开集合收敛为这唯一一个，托盘菜单也更干净；其余便签仍可在“历史”里重新打开，不丢数据。
/// - startup=false（托盘点击 / 单实例唤起）：展示当前打开集合里的全部（启动后通常只有一个，
///   若用户中途新建过更多，则一并展开）。
fn show_all_open(app: &AppHandle, startup: bool) {
    let ids = load_open_notes();
    // 取默认 / 第一个便签 id（借用 ids[0]，不消耗 ids，下方分支仍要用）
    let first_id = if ids.is_empty() {
        list_notes()
            .ok()
            .and_then(|v| v.into_iter().next().map(|m| m.id))
            .unwrap_or_else(|| "main".to_string())
    } else {
        ids[0].clone()
    };
    if startup {
        let v = vec![first_id.clone()];
        let _ = save_open_notes(&v);
        ensure_note_window(app, &first_id);
    } else if ids.is_empty() {
        let v = vec![first_id.clone()];
        let _ = save_open_notes(&v);
        ensure_note_window(app, &first_id);
    } else {
        for id in &ids {
            ensure_note_window(app, id);
        }
    }
    // 通知各便签窗口：若处于“贴边收起”状态则弹出，使呼出键 / 托盘都能展开收起的便签
    for (_label, win) in app.webview_windows() {
        let _ = win.emit("summoned", ());
    }
    // 刷新托盘菜单里的“打开的便签”列表（呼出可能新增默认便签）
    rebuild_tray_menu(app);
}

#[tauri::command]
async fn open_history_window(app: AppHandle) -> Result<(), String> {
    const LABEL: &str = "history";
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let _win = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
        .title("历史便签")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .inner_size(340.0, 460.0)
        .min_inner_size(300.0, 180.0)
        .center()
        .visible(false)
        .shadow(false)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;
    // 可见性交由前端 mountHistoryApp 在骨架渲染、主题类套上后再 show，
    // 避免后端 build 后立刻 show 导致的首帧白/透明闪烁。
    Ok(())
}

/// 取便签在托盘菜单中的显示名：优先用标题，否则取正文首行摘要（去 HTML 标签、截断）。
fn note_display_label(id: &str) -> String {
    if let Ok(Some(data)) = load_note(id) {
        if !data.title.trim().is_empty() {
            return data.title.trim().to_string();
        }
        let plain = strip_html(&data.content).trim().to_string();
        if plain.is_empty() {
            return "(空便签)".to_string();
        }
        return plain.lines().next().unwrap_or("").chars().take(30).collect();
    }
    id.to_string()
}

/// 构建系统托盘右键菜单：在“显示便签 / 退出”之间插入当前打开的便签列表，
/// 点击某条便签即呼出（显示并聚焦，且展开贴边收起的便签）。
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let show_item = MenuItem::with_id(app, "tray_show", "显示便签", true, None::<&str>)?;
    menu.append(&show_item)?;

    // 仅列入真实存在的窗口，避免 open_notes 中残留的已关闭 id 出现在菜单里。
    let open_ids = load_open_notes();
    let mut note_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    for id in open_ids {
        if app.get_webview_window(&id).is_none() {
            continue;
        }
        let label = note_display_label(&id);
        note_items.push(MenuItem::with_id(
            app,
            format!("note:{}", id),
            label,
            true,
            None::<&str>,
        )?);
    }
    if !note_items.is_empty() {
        let sep1 = PredefinedMenuItem::separator(app)?;
        let sep2 = PredefinedMenuItem::separator(app)?;
        menu.append(&sep1)?;
        for it in &note_items {
            menu.append(it)?;
        }
        menu.append(&sep2)?;
    }

    let quit_item = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
    menu.append(&quit_item)?;
    Ok(menu)
}

/// 实时截屏毛玻璃：截取“指定屏幕区域”的当前画面，编码为 JPEG 原始字节（Vec<u8>）返回。
/// 前端用 createImageBitmap 解码绘制——去掉 base64 编码 + data URL 字符串 IPC 传输 +
/// JS 端 base64 解码 + data URL 解析这一整套每帧 CPU/带宽开销（这是实时模糊卡顿主因）。
/// 透明主题用它把“便签背后的真实屏幕”作为毛玻璃底图。坐标 / 尺寸为逻辑像素，
/// scale 为降采样系数（0~1，越小体积越小、越糊）。仅 Windows 实现（GDI BitBlt）。
#[tauri::command]
fn capture_screen_region(x: i32, y: i32, w: i32, h: i32, scale: f32) -> Result<Response, String> {
    #[cfg(target_os = "windows")]
    {
        use image::ImageEncoder;
        use windows_sys::Win32::Graphics::Gdi::*;

        let sw = ((w as f32 * scale).max(1.0)) as i32;
        let sh = ((h as f32 * scale).max(1.0)) as i32;

        unsafe {
            let screen_dc = GetDC(std::ptr::null_mut());
            if screen_dc.is_null() {
                return Err("GetDC 失败".into());
            }
            let mem_dc = CreateCompatibleDC(screen_dc);
            if mem_dc.is_null() {
                ReleaseDC(std::ptr::null_mut(), screen_dc);
                return Err("CreateCompatibleDC 失败".into());
            }
            let bitmap = CreateCompatibleBitmap(screen_dc, sw, sh);
            if bitmap.is_null() {
                DeleteDC(mem_dc);
                ReleaseDC(std::ptr::null_mut(), screen_dc);
                return Err("CreateCompatibleBitmap 失败".into());
            }
            let old = SelectObject(mem_dc, bitmap);
            SetStretchBltMode(mem_dc, 4); // HALFTONE：缩小时平滑
            let ok = StretchBlt(mem_dc, 0, 0, sw, sh, screen_dc, x, y, w, h, SRCCOPY);
            if ok == 0 {
                SelectObject(mem_dc, old);
                DeleteObject(bitmap);
                DeleteDC(mem_dc);
                ReleaseDC(std::ptr::null_mut(), screen_dc);
                return Err("StretchBlt 失败".into());
            }

            let mut header: BITMAPINFOHEADER = std::mem::zeroed();
            header.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            header.biWidth = sw;
            header.biHeight = -sh; // 负高 = 自顶向下
            header.biPlanes = 1;
            header.biBitCount = 32;
            header.biCompression = 0; // BI_RGB

            let mut buf: Vec<u8> = vec![0u8; (sw * sh * 4) as usize];
            let lines = GetDIBits(
                mem_dc,
                bitmap,
                0,
                sh as u32,
                buf.as_mut_ptr() as *mut std::ffi::c_void,
                &header as *const _ as *mut BITMAPINFO,
                DIB_RGB_COLORS,
            );
            if lines == 0 {
                SelectObject(mem_dc, old);
                DeleteObject(bitmap);
                DeleteDC(mem_dc);
                ReleaseDC(std::ptr::null_mut(), screen_dc);
                return Err("GetDIBits 失败".into());
            }

            SelectObject(mem_dc, old);
            DeleteObject(bitmap);
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);

            // GDI 为 BGRA；JPEG 无 alpha 且编码远快于 PNG（前端还会做高斯模糊，
            // 低质量 JPEG 的压缩噪点会被模糊掉，观感无差）。这是实时毛玻璃“卡顿”的主要瓶颈改善点。
            let mut rgb: Vec<u8> = Vec::with_capacity((buf.len() / 4 * 3) as usize);
            for chunk in buf.chunks_exact(4) {
                rgb.push(chunk[2]);
                rgb.push(chunk[1]);
                rgb.push(chunk[0]);
            }

            let mut jpg: Vec<u8> = Vec::new();
            {
                let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 50);
                enc.write_image(&rgb, sw as u32, sh as u32, image::ExtendedColorType::Rgb8)
                    .map_err(|e| e.to_string())?;
            }
            // 直接返回原始 JPEG 字节：用 tauri::ipc::Response 走真正的二进制通道
            // （若直接返回 Vec<u8>，Tauri 会按 serde_json 编码成“数字数组”，体积反而更大）。
            // 前端拿到的是 ArrayBuffer / Uint8Array，零 base64 开销。
            Ok(Response::new(jpg))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, w, h, scale);
        Err("仅 Windows 支持实时截屏".into())
    }
}

/// 原生亚克力毛玻璃（PowerShell 设置同款 DWM 效果）：
/// 直接调 SetWindowCompositionAttribute(ACCENT_ENABLE_ACRYLICBLURBEHIND)（SWCA）：
/// - 与焦点无关：便签失焦也持续模糊（SYSTEMBACKDROP 亚克力失焦即停止渲染模糊，
///   一点便签外部"透明效果就消失"，正是用户反馈的问题）；
/// - tint 由 gradient 完全控制：颜色 = 前端传的主题色（--bg），alpha = 背景不透明度
///   （0~255，0 会失效故前端最小传 1）——1% 时 tint 约 1% 几乎不可见，
///   100% 时为纯主题色面板；无黑色蒙版（勿用黑色 tint）。
/// 为什么不用 Effect::Blur（SWCA blurbehind）：渐变渲染异常（黑色蒙版/黑白闪）。
/// 未文档化 API 不在导入表，运行时 GetProcAddress 动态获取（window-vibrancy 同款）。
#[tauri::command]
fn set_acrylic(
    window: tauri::WebviewWindow,
    enable: bool,
    _opacity: u32,
    tint_rgb: u32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

        #[repr(C)]
        struct AccentPolicy {
            accent_state: u32,
            accent_flags: u32,
            gradient_color: u32, // ABGR
            animation_id: u32,
        }
        #[repr(C)]
        struct WindowCompositionAttribData {
            attrib: u32,
            pv_data: *mut c_void,
            cb_data: u32,
        }
        type SetWcaFn = unsafe extern "system" fn(
            windows_sys::Win32::Foundation::HWND,
            *mut WindowCompositionAttribData,
        ) -> i32;

        fn call_set_wca(
            hwnd: windows_sys::Win32::Foundation::HWND,
            data: *mut WindowCompositionAttribData,
        ) -> i32 {
            use std::sync::OnceLock;
            static PROC: OnceLock<Option<SetWcaFn>> = OnceLock::new();
            let proc = *PROC.get_or_init(|| unsafe {
                let module: Vec<u16> = "user32"
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .collect();
                let m = GetModuleHandleW(module.as_ptr());
                if m.is_null() {
                    return None;
                }
                // GetProcAddress 的符号名是 ANSI 字节串（ASCII 兼容）
                let bytes = "SetWindowCompositionAttribute\0".as_bytes();
                let p = GetProcAddress(m, bytes.as_ptr().cast());
                if p.is_none() {
                    return None;
                }
                Some(std::mem::transmute::<unsafe extern "system" fn() -> isize, SetWcaFn>(
                    p.unwrap(),
                ))
            });
            match proc {
                Some(f) => unsafe { f(hwnd, data) },
                None => 0,
            }
        }

        const WCA_ACCENT_POLICY: u32 = 19;
        const ACCENT_DISABLED: u32 = 0;
        const ACCENT_ENABLE_ACRYLICBLURBEHIND: u32 = 4;

        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        // windows crate 的 HWND 与 windows-sys 的 HWND 底层都是 *mut c_void
        let raw: windows_sys::Win32::Foundation::HWND = hwnd.0 as _;
        let (state, flags, gradient) = if enable {
            // 本机实测 SWCA tint 会放大渲染（alpha 极小时仍有可见着色），
            // 因此 alpha 固定取 1（最小可用的“不失效”值），着色近似不可见；
            // 面板深浅完全由前端 CSS（--trans-opacity）线性控制。
            let r = (tint_rgb >> 16) & 0xff;
            let g = (tint_rgb >> 8) & 0xff;
            let b = tint_rgb & 0xff;
            (
                ACCENT_ENABLE_ACRYLICBLURBEHIND,
                0u32,
                (1u32 << 24) | (b << 16) | (g << 8) | r,
            )
        } else {
            (ACCENT_DISABLED, 0u32, 0u32)
        };
        let mut policy = AccentPolicy {
            accent_state: state,
            accent_flags: flags,
            gradient_color: gradient,
            animation_id: 0,
        };
        let mut data = WindowCompositionAttribData {
            attrib: WCA_ACCENT_POLICY,
            pv_data: (&mut policy as *mut AccentPolicy).cast(),
            cb_data: std::mem::size_of::<AccentPolicy>() as u32,
        };
        let ok = call_set_wca(raw, &mut data);
        if ok == 0 {
            return Err("SetWindowCompositionAttribute 失败".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, enable, opacity, tint_rgb);
        Ok(())
    }
}

// ===== 为什么不用 DWM 原生圆角（DWMWA_WINDOW_CORNER_PREFERENCE = ROUND）=====
// 历史教训：圆角窗口的边界会被 DWM 画一圈细描边轮廓，透明内容（粒子消散动画
// 把面板裁剪掉后）上会残留成“边框”。曾用“动画期间临时关圆角、结束恢复”的方式
// 规避，但打开便签后立刻关闭时，前端初始化仍在进行（SWCA 亚克力等组合调用
// 可能晚于关圆角到达），圆角描边随时会在动画中复活——竞态无法彻底消除。
// 因此这里不再初始化 DWM 圆角：窗口保持直角，圆角完全由 CSS border-radius 负责
// （.note-window 自带 14px 圆角面板），动画期间不存在任何圆角描边，也就没有
// 需要开关的边框。代价：透明主题下 SWCA 亚克力区域是矩形，四个角会比面板
// 多出极小的模糊三角（无着色），肉眼几乎不可辨。

// ===== 图片预览独立窗口 =====
// 双击便签图片时，前端把图片 URL 列表（及当前序号）暂存到 ViewerState，再调用本命令
// 打开一个 label="imageviewer" 的独立窗口；该窗口的前端视图拉取 ViewerState 并展示大图，
// 避免在小便签窗口内挤一个看不清的预览弹层。
#[derive(Clone, Serialize)]
struct ViewerData {
    urls: Vec<String>,
    index: usize,
}
struct ViewerState(Mutex<Option<ViewerData>>);

#[tauri::command]
async fn open_image_viewer(
    app: AppHandle,
    state: State<'_, ViewerState>,
    urls: Vec<String>,
    index: usize,
) -> Result<(), String> {
    // 锁仅用于写入暂存数据，立即释放，绝不跨 await 持有（否则 get_viewer_data 取数据时死锁）
    {
        let mut s = state.0.lock().unwrap();
        *s = Some(ViewerData { urls, index });
    }
    const LABEL: &str = "imageviewer";
    if let Some(win) = app.get_webview_window(LABEL) {
        // 窗口已存在：刷新暂存数据并通知前端重新拉取
        let _ = win.emit("viewer-reload", ());
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    // 异步命令：窗口创建在 async 运行时线程上进行，避免在主线程同步 build WebView2 造成的死锁
    let _win = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
        .title("图片预览")
        .decorations(true)
        .transparent(false)
        .resizable(true)
        .always_on_top(true)
        .inner_size(900.0, 680.0)
        .min_inner_size(360.0, 300.0)
        .center()
        .visible(false)
        .shadow(true)
        .build()
        .map_err(|e| e.to_string())?;
    // 注意：此处故意不调用 win.show()——窗口可见性交由前端在 WebView 首帧
    // （结构已注入、CSS 已应用、图片数据已加载）就绪后再 show，彻底消除
    // 打开瞬间的白屏/透明闪。窗口已存在分支（上方）仍保留 show 以复用可见窗口。
    Ok(())
}

#[tauri::command]
fn get_viewer_data(state: State<ViewerState>) -> Option<ViewerData> {
    state.0.lock().unwrap().take()
}

/// 打开独立的“设置”窗口：与历史窗口完全相同的建法（透明无边框、可见性在 build 之后打开）。/// 关键：build 时 visible(false)，等 webview 初始化完成后再 show()——若在 build 时直接
/// visible(true)（旧写法），WebView2 初始化与页面导航存在竞态，窗口会停在 about:blank
/// 一片白、内容永远不加载（即长期“设置窗口白面板”的根因）。
#[tauri::command]
async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    const LABEL: &str = "settings";
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let _win = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("settings.html".into()))
        .title("便签设置")
        .decorations(false)
        .transparent(true) // 透明窗：与便签同款 —— 透明主题下靠 DWM 原生 Acrylic 做实时磨砂，
                           // 不透明则底色由 .settings-standalone .settings-modal 实色垫底，观感一致。
                           // 首帧白/闪烁已由前端 paint 后再 show 规避（见下方注释），无需靠不透明兜底。
        .resizable(true)
        .always_on_top(true)
        .inner_size(800.0, 600.0)
        .min_inner_size(680.0, 500.0)
        .center()
        .visible(false)
        .shadow(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;
    // 可见性交由前端 openSettingsModal 在 paint(initial) 同步画完面板后 show，
    // 避免后端 build 后立刻 show 导致的首帧白/透明闪烁。
    Ok(())
}

/// “打开中”集合变化后重建托盘菜单，使其反映最新便签列表（菜单创建后不会自动更新）。
fn rebuild_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_all_open(app, false);
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            // 全局快捷键：分发到“呼出 / 全部关闭 / 新建便签”等动作
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        dispatch_shortcut(app, shortcut.id());
                    }
                })
                .build(),
        )
        .setup(|app| {
            // ---- 系统托盘（右键菜单含当前打开的便签列表）----
            let menu = build_tray_menu(app.handle())?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("便签")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    if id == "tray_show" {
                        show_all_open(app, false);
                    } else if id == "tray_quit" {
                        app.exit(0);
                    } else if let Some(note_id) = id.strip_prefix("note:") {
                        // 点击便签项：呼出该便签（展开并聚焦，展开贴边收起状态）
                        ensure_note_window(app, note_id);
                        if let Some(win) = app.get_webview_window(note_id) {
                            let _ = win.emit("summoned", ());
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        show_all_open(app, false);
                    }
                })
                .build(app)?;

            // ---- 注册全部全局快捷键（来自设置：呼出 / 全部关闭 / 新建便签）----
            register_all_shortcuts(app.handle());

            // ---- 按“打开中”的便签集合呼出：启动只弹出一个便签（默认 / 第一个）----
            show_all_open(app.handle(), true);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_note,
            save_note,
            list_notes,
            delete_note,
            new_note_id,
            load_settings,
            save_settings,
            translate,
            format_with_llm,
            start_dragging,
            set_always_on_top,
            close_window,
            minimize_to_taskbar,
            minimize_to_tray,
            show_window,
            quit_app,
            register_shortcuts,
            close_all_notes,
            create_note_window,
            open_note_window,
            open_history_window,
            mark_note_open,
            mark_note_closed,
            get_open_notes,
            save_md_custom,
            read_md_custom,
            open_file,
            open_folder,
            effective_notes_dir,
            save_bg_image,
            read_bg_image,
            delete_bg_image,
            get_wallpaper,
            capture_screen_region,
            set_acrylic,
            open_settings_window,
            open_image_viewer,
            get_viewer_data,
        ])
        .manage(ViewerState(Mutex::new(None)))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
