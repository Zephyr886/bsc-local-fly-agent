import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import { brainReady, setupWindowsBrain, windowsRuntimePaths } from "./bootstrap.mjs";
import { desktopPreflight, runDesktopMigration } from "./migration.mjs";

let mainWindow = null;
let backend = null;
let backendOrigin = null;
let setupController = null;
let setupRunning = false;
let quitting = false;
let startupLog = null;

function trace(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  for (const path of [startupLog, process.env.FLAP_SMOKE_LOG].filter(Boolean)) {
    try { appendFileSync(path, line); } catch {}
  }
}

function configureUserDataPath() {
  if (!app.commandLine.hasSwitch("user-data-dir") && process.env.LOCALAPPDATA) {
    const userData = join(process.env.LOCALAPPDATA, "FLAP Fly Agent");
    mkdirSync(userData, { recursive: true });
    app.setPath("userData", userData);
  }
  const logs = join(app.getPath("userData"), "logs");
  mkdirSync(logs, { recursive: true });
  startupLog = join(logs, "desktop.log");
  trace(`main-loaded version=${app.getVersion()} packaged=${app.isPackaged}`);
}

function sendSetup(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("setup:progress", message);
}

function revealWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function loadAndReveal(loader) {
  await loader();
  revealWindow();
}

async function showAgent() {
  await loadAndReveal(() => mainWindow.loadURL(backendOrigin));
}

async function showSetup() {
  await loadAndReveal(() => mainWindow.loadFile(join(app.getAppPath(), "desktop", "setup.html")));
}

async function showLoading() {
  await loadAndReveal(() => mainWindow.loadFile(join(app.getAppPath(), "desktop", "loading.html")));
}

function createWindow(paths) {
  const allowedLocalPages = new Set([
    pathToFileURL(join(app.getAppPath(), "desktop", "setup.html")).href,
    pathToFileURL(join(app.getAppPath(), "desktop", "loading.html")).href,
  ]);
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1060,
    minHeight: 720,
    show: true,
    title: "FLAP Fly Agent",
    backgroundColor: "#07090d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(app.getAppPath(), "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.on("unresponsive", () => trace("window-unresponsive"));
  window.webContents.on("render-process-gone", (_event, details) => trace(`renderer-gone reason=${details.reason}`));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/bscscan\.com\/tx\/0x[0-9a-f]{64}$/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const backendAllowed = backendOrigin
      && (url === backendOrigin || url.startsWith(`${backendOrigin}/`));
    if (!backendAllowed && !allowedLocalPages.has(url)) event.preventDefault();
  });
  window.on("close", (event) => {
    if (!setupRunning) return;
    event.preventDefault();
    void dialog.showMessageBox(window, {
      type: "warning",
      buttons: ["继续初始化", "取消并退出"],
      defaultId: 0,
      cancelId: 0,
      title: "全脑环境仍在初始化",
      message: "现在退出会中断下载或安装。已完成的缓存会保留，下次可以继续。",
    }).then(({ response }) => {
      if (response === 1) {
        setupController?.abort();
        setupRunning = false;
        app.quit();
      }
    });
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  mainWindow = window;

  ipcMain.handle("setup:start", async () => {
    if (setupRunning) return { started: false };
    setupRunning = true;
    setupController = new AbortController();
    sendSetup({ stage: "starting", percent: null, message: "正在准备 Windows 运行环境" });
    try {
      await setupWindowsBrain(paths, { onProgress: sendSetup, signal: setupController.signal });
      sendSetup({ stage: "complete", percent: 100, message: "初始化完成，正在进入控制台" });
      await showAgent();
      return { started: true, complete: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendSetup({ stage: "error", percent: null, message });
      return { started: true, complete: false, error: message };
    } finally {
      setupRunning = false;
      setupController = null;
    }
  });
  ipcMain.handle("setup:skip", async () => {
    if (setupRunning) return { ok: false };
    await showAgent();
    return { ok: true };
  });
  return window;
}

function installMenu(paths) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: "系统",
    submenu: [
      { label: "安装或修复全脑环境", click: () => void showSetup() },
      { label: "打开数据目录", click: () => void shell.openPath(paths.userData) },
      { type: "separator" },
      { role: "quit", label: "退出" },
    ],
  }, {
    label: "查看",
    submenu: [
      { role: "reload", label: "刷新" },
      { role: "togglefullscreen", label: "全屏" },
      { role: "resetzoom", label: "实际大小" },
      { role: "zoomin", label: "放大" },
      { role: "zoomout", label: "缩小" },
    ],
  }]));
}

function configureRuntime() {
  const appRoot = app.getAppPath();
  const runtimeRoot = app.isPackaged ? process.resourcesPath : appRoot;
  const userData = app.getPath("userData");
  const paths = windowsRuntimePaths({ userData, runtimeRoot });
  process.env.FLAP_APP_ROOT = appRoot;
  process.env.FLAP_RUNTIME_ROOT = runtimeRoot;
  process.env.FLAP_DATA_ROOT = paths.dataRoot;
  process.env.FLAP_WORK_ROOT = paths.workRoot;
  process.env.FULL_BRAIN_PYTHON = paths.venvPython;
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";
  return { appRoot, paths };
}

async function startBackend(appRoot) {
  trace("backend-import-start");
  try {
    backend = await import(pathToFileURL(join(appRoot, "src", "server.mjs")).href);
  } catch (error) {
    trace(`backend-import-error ${error instanceof Error ? error.stack : String(error)}`);
    throw error;
  }
  trace("backend-imported");
  const ready = await backend.ready;
  trace(`backend-ready ${ready.origin}`);
  backendOrigin = ready.origin;
  return ready;
}

async function migrateBeforeBackend(paths) {
  sendSetup({ stage: "preflight", percent: null, message: "正在检查磁盘空间、旧数据和数据库版本" });
  const report = await desktopPreflight(paths);
  trace(`preflight legacy=${report.legacy.found} flies=${report.flies.count} db=${report.database.version} disk=${report.disk.sufficient}`);
  return runDesktopMigration(paths, {
    preflight: report,
    onProgress: (message) => {
      trace(`${message.stage} ${message.message}`);
      sendSetup(message);
    },
  });
}

async function launch() {
  configureUserDataPath();
  trace(`launch argv=${process.argv.slice(1).join(" ")}`);
  if (!app.requestSingleInstanceLock()) {
    trace("single-instance-denied");
    app.quit();
    return;
  }
  if (process.argv.includes("--smoke-test")) {
    const { appRoot, paths } = configureRuntime();
    await migrateBeforeBackend(paths);
    const ready = await startBackend(appRoot);
    const response = await fetch(`${ready.origin}/api/health`);
    if (!response.ok) throw new Error(`desktop smoke test failed: HTTP ${response.status}`);
    console.log(`DESKTOP_SMOKE_OK ${response.status}`);
    trace(`health-ok ${response.status}`);
    await backend.shutdown({ exitProcess: false });
    app.exit(0);
    return;
  }
  app.on("second-instance", () => {
    revealWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    setupController?.abort();
    Promise.resolve(backend?.shutdown?.({ exitProcess: false }))
      .finally(() => app.exit(0));
  });

  await app.whenReady();
  trace("app-ready");
  app.setAppUserModelId("com.flaptofly.flyagent");
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  const { appRoot, paths } = configureRuntime();
  createWindow(paths);
  installMenu(paths);
  await showLoading();
  await migrateBeforeBackend(paths);
  await startBackend(appRoot);
  if (brainReady(paths)) await showAgent();
  else await showSetup();
}

void launch().catch((error) => {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  const message = error instanceof Error ? error.message : String(error);
  trace(`fatal ${detail}`);
  if (process.argv.includes("--smoke-test")) console.error(detail);
  else {
    sendSetup({ stage: "error", percent: null, message: `启动失败：${message}` });
    revealWindow();
    dialog.showErrorBox("FLAP Fly Agent 启动失败",
      `${message}\n\n诊断日志：${startupLog || "用户数据目录/logs/desktop.log"}`);
  }
  app.exit(1);
});
