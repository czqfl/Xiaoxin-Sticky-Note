# AGENTS.md

Windows desktop sticky-note app: **Tauri 2 (Rust) + Vite + TypeScript** (vanilla TS, no framework). Frontend, Rust backend, README, and commit messages are all in **Chinese** — write new UI strings in Chinese.

## Commands

```bash
npm install                # install frontend deps
npm run tauri dev          # dev mode, Vite on port 1420 (strictPort)
npm run build              # tsc && vite build — the ONLY frontend verification (no lint/typecheck scripts)
cd src-tauri && cargo check # verify Rust side (no cargo tests; run cargo build --release for a full build)
npm run pack               # tauri build + scripts/copy-bundle.mjs copies NSIS installer & portable exe to repo root
```

- **No tests, no linter, no CI.** Verification = `npm run build` (tsc catches type errors) + `cargo check`.
- `npm run pack` exits 1 if the root `.exe` files are locked (app running); `copy-bundle.mjs` retries, then writes a `.new` file and tells you to rename manually.
- Root `*.exe`, `dist/`, `src-tauri/target/`, `src-tauri/gen/` are gitignored build artifacts.

## Architecture

- One `index.html` serves **all** windows; the window type comes from the Tauri window label, not the URL: note windows use the `noteId` query param, plus `history` and `settings` labels (`src/main.ts:29-41`). Never add a new window type without handling its label there.
- All Tauri commands live in one file: `src-tauri/src/main.rs` (~2200 lines). Frontend wrappers in `src/api.ts`; register new commands in the `invoke_handler!` macro (main.rs:2117).
- Monoliths to extend in place: `src/note.ts` (~88KB, note window), `src/settings.ts` (~48KB), `src/styles.css` (~50KB). Glass/transparency visuals span `glass.ts`, `panel-bg.ts`, `blur-anim.ts`. Particle animations: `dissolve.ts` (close), `summon.ts` (show) — used ONLY in non-transparent themes; in the transparent theme note.ts skips them entirely (instant hide/show), because SWCA acrylic blur is whole-window and cannot region-follow (SetWindowRgn doesn't clip it, screenshots capture other windows since WDA_EXCLUDEFROMCAPTURE doesn't affect GDI BitBlt, wallpaper layers mismatch the acrylic look). Animations share the rAF+backup-timer frame driver (backup path must NOT schedule rAF, or the queue snowballs and particles freeze), the "leave window empty while hidden" convention, and must NOT use `will-change: clip-path` (promotes a compositor layer whose stale texture shows the old background in transparent windows). three.js is in package.json but unused.
- Runtime data lives in `%APPDATA%/XiaoxinStickyNote/`: `settings.json`, `open_notes.json`, one `xiaoxin_sticky_note_<id>.json` per note (content stored as **HTML**), `md_custom.css`, `bg/`. `settings.json` may carry a UTF-8 BOM (stripped in Rust) — don't "fix" it.

## Gotchas (hard-won)

- Closing a note window **hides to tray** (windows persist, "close" only hides — see `close_window` command); only `settings`/`history` windows truly close. Deleting a note first emits `note-deleted` to the open window, or it will resave itself and "revive".
- Transparent windows must be built with `visible(false)` then shown after `.build()`, or the window stays white/blank (WebView2 init race). Don't "fix" the ordering.
- Release builds need the default `custom-protocol` cargo feature (Cargo.toml) — removing it breaks asset loading in the packaged app.
- `透明背景需求说明.md` is the design/constraint doc for the transparent-glass feature — read it before touching glass code. CSS `backdrop-filter` does NOT work in this transparent-window app; glass uses screen capture (`capture_screen_region`), wallpaper-as-image, and native acrylic.
- Windows-only APIs are used directly (undocumented `SetWindowCompositionAttribute` via `GetProcAddress`, DWM rounded corners, GDI `BitBlt`, `SetWindowDisplayAffinity`). Code is `#[cfg(target_os = "windows")]`-guarded but the app is only ever built/run on Windows.
- `legacy/` is the old Python/tkinter version — do not modify. `data/`, `diag*.txt`, `build-*.log`, `rustup.err` are local debug artifacts; leave them alone.
