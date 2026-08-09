// 打包完成后，把安装包与便携版 exe 复制到项目根目录（与 src 目录同级）
import { copyFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join, basename } from "node:path";

const root = process.cwd();

function findSetupExe() {
  const dir = join(root, "src-tauri/target/release/bundle/nsis");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".exe"));
  // 优先带 setup 字样，否则取第一个 exe
  files.sort((a, b) => (a.includes("setup") ? -1 : 0) - (b.includes("setup") ? -1 : 0));
  return files.length ? join(dir, files[0]) : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 复制并容忍“文件被占用”(EBUSY/EPERM)：退避重试若干次；
// 仍失败则复制到 .new 备用文件，并提示用户关闭占用进程。
async function copyRobust(src, destName) {
  if (!src || !existsSync(src)) {
    console.error(`[copy-bundle] 未找到产物: ${src}`);
    process.exitCode = 1;
    return;
  }
  const destPath = join(root, destName);
  let lastErr = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      copyFileSync(src, destPath);
      console.log(`[copy-bundle] 已复制 -> ${destName}`);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code === "EBUSY" || e.code === "EPERM") {
        const wait = Math.min(2000, 250 * 2 ** (attempt - 1));
        console.warn(
          `[copy-bundle] 目标文件被占用(${e.code})，${attempt}/6 次重试，等待 ${wait}ms…`
        );
        await sleep(wait);
        continue;
      }
      break; // 其它错误直接抛出
    }
  }
  // 仍被占用：复制到 .new 备用名，避免覆盖流程整体失败
  if (lastErr && (lastErr.code === "EBUSY" || lastErr.code === "EPERM")) {
    const alt = destPath + ".new";
    try {
      copyFileSync(src, alt);
      console.warn(
        `[copy-bundle] 无法覆盖被占用的 ${destName}（可能被正在运行的程序/安装包占用）。\n` +
          `              已另存为 ${basename(alt)}，请关闭占用该文件的程序后手动重命名覆盖。`
      );
      process.exitCode = 1;
      return;
    } catch (e2) {
      console.error(`[copy-bundle] 复制 ${destName} 失败: ${lastErr.message}`);
      process.exitCode = 1;
      return;
    }
  }
  // 非占用类错误
  console.error(`[copy-bundle] 复制 ${destName} 失败: ${lastErr && lastErr.message}`);
  process.exitCode = 1;
}

const setup = findSetupExe();
const portable = join(root, "src-tauri/target/release/xiaoxin-sticky-note.exe");

await copyRobust(setup, "XiaoxinStickyNote_1.0.0_x64-setup.exe");
await copyRobust(portable, "xiaoxin-sticky-note.exe");

if (!process.exitCode) {
  console.log("[copy-bundle] 完成：安装包与便携版已置于项目根目录（与 src 同级）。");
}
