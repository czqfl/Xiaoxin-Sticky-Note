export interface NoteData {
  content: string;
  /** 用户自定义标题（可空） */
  title?: string;
  /** Markdown 预览模式：none / preview / split（每便签独立配置） */
  md?: string;
  pinned: boolean;
  created: number;
  updated: number;
  width?: number;
  height?: number;
  /** 窗口最后一次所在位置（物理像素，跨重启记忆；无值时居中） */
  pos_x?: number;
  pos_y?: number;
  /** 自定义背景图片（base64 data URL，可空） */
  bg_image?: string;
}

export interface NoteMeta {
  id: string;
  /** 用户自定义标题（可空） */
  title: string;
  snippet: string;
  updatedStr: string;
  updated: number;
}

export interface Settings {
  shortcuts: Record<string, string>;
  /** Markdown 预览主题：default / github / rose-pine / solarized / custom */
  md_theme: string;
  /** 自定义主题 CSS 文件在磁盘上的绝对路径（md_theme === "custom" 时生效） */
  md_custom_path: string;
  /** 用户上传时的原始文件名（仅用于设置界面展示） */
  md_custom_filename: string;
  /** 全局外观主题：light / dark */
  theme: string;
  /** 全局默认背景图片（base64 data URL，可空；单张便签自身背景优先） */
  bg_image?: string;
  /** 背景沉浸：整张便签（含标题栏/工具栏）都显示背景，而非仅输入区 */
  bg_immersive?: boolean;
  /** 靠边自动收起（QQ 贴边风格）：便签拖到屏幕边缘附近、鼠标离开时收起，移回时弹出 */
  edge_snap?: boolean;
  /** 便签存储目录（绝对路径，可空；空 = 默认应用数据目录 %APPDATA%/XiaoxinStickyNote） */
  notes_dir?: string;
  /** 大模型 API Base URL（OpenAI 兼容，可空；空 = https://api.openai.com/v1） */
  llm_base_url?: string;
  /** 大模型 API Key */
  llm_api_key?: string;
  /** 大模型模型名（可空；空 = gpt-4o-mini） */
  llm_model?: string;
  /** 独立“毛玻璃效果”开关：开启后内容面板叠加磨砂（透明背景磨砂桌面、图片背景磨砂图片） */
  glass_enabled?: boolean;
  /** 毛玻璃模糊强度（px），仅 glass_enabled 开启时生效 */
  glass_blur?: number;
  /** 透明主题“背景不透明度”（0~100%）：原生亚克力着色层强度，等价 PowerShell 设置的不透明度滑块 */
  transparent_opacity?: number;
  /** 粒子数量 0~100（同时控制“粒子消散”与“粒子吸入”两种动画的粒子规模），默认 50 */
  particle_count?: number;
  /** 粒子效果风格：particle=粒子（呼出+关闭·默认，鸿蒙通知删除同款，颜色采样自背景主题色）/ erode=火焰（呼出+关闭，橙黄火舌贴燃烧边；设置值 "erode" 为历史命名，沿用旧值避免破坏已保存设置）。旧值 flame 已移除，归入 particle */
  particle_mode?: string;
  /** 粒子动画速度（百分比，100=原速，50=半速，200=2倍速）；对所有粒子动画生效 */
  animation_speed?: number;
}
