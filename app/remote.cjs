'use strict';
/**
 * 远程后端模式（P1）。
 *
 * 启用后本机不启动 Core：桌宠窗口直接连 NAS 上的 Core。
 *   ssh -N -L <localPort>:127.0.0.1:<remotePetPort> user@host   （隧道由本进程托管）
 *   Coopanion.exe --pet-host --pet-url=http://127.0.0.1:<localPort>/pet
 *
 * 配置：<DATA>/remote.json（由托盘「远程后端设置…」里的表单写入）
 * 关闭：把 enabled 改成 false，或删掉 remote.json —— 应用即回到"本机 Core"模式。
 *
 * 只依赖 Electron 与 Node 内置模块，不改动原有任何逻辑。
 */
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');

const DEFAULTS = {
  enabled: false,
  /** NAS 主机（IPv4 或主机名） */
  sshHost: '',
  sshPort: 10039,
  sshUser: '',
  /** 私钥路径；留空则用系统 ssh 的默认密钥/交互认证 */
  keyPath: '',
  /** NAS 侧的桌宠 relay 端口（容器 compose 里发布的 17788） */
  remotePetPort: 17788,
  /** 本机隧道端口：桌宠页从 http://127.0.0.1:<localPort>/pet 加载 */
  localPort: 7788,
  /** 同时把 NapCat WebUI 也转发出来（浏览器开 http://127.0.0.1:<napcatPort>/webui） */
  forwardNapcat: false,
  napcatPort: 6099,
  /** 转发 NAS 上 Core 自带的 Web 控制台（模型/世界/提示词/日志都在里面） */
  consoleEnabled: true,
  /** 控制台隧道端口，两端同号（NAS 侧由 compose 的 console-relay 发布到 17790） */
  consolePort: 17790,
};

let cfgPath = '';
let iconsDir = '';
let tunnel = null;
let pet = null;
let tray = null;
let settingsWin = null;
let consoleWin = null;
let stopping = false;
let lastError = '';
let tunnelRetry = null;

/* ------------------------------- 配置 ------------------------------- */

function readCfg() {
  try {
    const raw = readFileSync(cfgPath, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeCfg(patch) {
  const next = { ...readCfg(), ...patch };
  writeFileSync(cfgPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

function petUrl(cfg) {
  return `http://127.0.0.1:${cfg.localPort}/pet`;
}

/* ------------------------------- 隧道 ------------------------------- */

function sshArgs(cfg) {
  const args = [
    '-N',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ];
  if (cfg.keyPath && existsSync(cfg.keyPath)) {
    args.push('-i', cfg.keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes');
  }
  args.push('-p', String(cfg.sshPort), '-L', `${cfg.localPort}:127.0.0.1:${cfg.remotePetPort}`);
  if (cfg.forwardNapcat) args.push('-L', `${cfg.napcatPort}:127.0.0.1:${cfg.napcatPort}`);
  if (cfg.consoleEnabled) args.push('-L', `${cfg.consolePort}:127.0.0.1:${cfg.consolePort}`);
  args.push(`${cfg.sshUser}@${cfg.sshHost}`);
  return args;
}

function killTunnel() {
  if (tunnelRetry) { clearTimeout(tunnelRetry); tunnelRetry = null; }
  if (!tunnel) return;
  try { tunnel.removeAllListeners('exit'); tunnel.kill(); } catch { /* 已经退出 */ }
  tunnel = null;
}

function startTunnel(cfg) {
  killTunnel();
  if (!cfg.sshHost || !cfg.sshUser) {
    lastError = '未填写 NAS 主机或用户名';
    refreshTray();
    return false;
  }
  tunnel = spawn('ssh', sshArgs(cfg), { windowsHide: true, stdio: 'ignore' });
  tunnel.on('error', (err) => {
    lastError = `无法启动 ssh：${err.message}`;
    refreshTray();
  });
  tunnel.on('exit', (code) => {
    tunnel = null;
    if (stopping) return;
    lastError = `隧道断开（exit ${code}），5 秒后重试`;
    refreshTray();
    notify(lastError);
    tunnelRetry = setTimeout(() => { tunnelRetry = null; void reconnect(); }, 5000);
  });
  lastError = '';
  refreshTray();
  return true;
}

/* ------------------------------ 桌宠窗口 ---------------------------- */

function killPet() {
  if (!pet) return;
  try { pet.kill(); } catch { /* 已经退出 */ }
  pet = null;
}

function spawnPet(url) {
  killPet();
  const env = { ...process.env };
  // 继承了这个变量会让 exe 退化成普通 node，报 bad option: --pet-host
  delete env.ELECTRON_RUN_AS_NODE;
  pet = spawn(process.execPath, ['--pet-host', `--pet-url=${url}`, '--parent-pid=0'], {
    detached: true, stdio: 'ignore', windowsHide: false, env,
  });
  pet.on('exit', () => { pet = null; });
  pet.unref();
}

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(typeof res.statusCode === 'number' && res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitReady(url, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await probe(url)) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

/* -------------------------------- 主流程 ---------------------------- */

// 隧道通了、但远端服务还没起来（NAS 在重启、比本机开机慢）时的退避重试
let readyRetry = null;
let readyDelay = 5000;

function clearReadyRetry() {
  if (readyRetry) { clearTimeout(readyRetry); readyRetry = null; }
}

function scheduleReadyRetry() {
  clearReadyRetry();
  const wait = readyDelay;
  readyDelay = Math.min(Math.round(readyDelay * 2), 60000);
  lastError = `还没就绪，${wait / 1000} 秒后重试`;
  refreshTray();
  readyRetry = setTimeout(() => { readyRetry = null; void reconnect(); }, wait);
}

/**
 * @param reset 操作者手动触发（托盘「重新连接」）时为 true：重置退避并重开隧道。
 */
async function reconnect(reset = false) {
  const cfg = readCfg();
  if (!cfg.enabled) return;
  clearReadyRetry();
  if (reset) { readyDelay = 5000; killTunnel(); }
  killPet();

  // 隧道还活着就别重开，只再探一次远端（NAS 慢启动时的常态）
  if (!(tunnel && tunnel.exitCode === null) && !startTunnel(cfg)) return;

  const url = petUrl(cfg);
  const ok = await waitReady(url);
  if (!ok) {
    scheduleReadyRetry();
    return;
  }
  readyDelay = 5000;
  spawnPet(url);
  lastError = '';
  refreshTray();
}

function status() {
  const cfg = readCfg();
  return {
    enabled: cfg.enabled,
    tunnel: Boolean(tunnel),
    pet: Boolean(pet),
    url: petUrl(cfg),
    consoleUrl: cfg.consoleEnabled ? `http://127.0.0.1:${cfg.consolePort}/` : null,
    error: lastError,
  };
}

function notify(body) {
  if (!Notification.isSupported()) return;
  try { new Notification({ title: 'Coopanion 远程后端', body }).show(); } catch { /* 通知失败不影响主流程 */ }
}

/* -------------------------------- 托盘 ------------------------------ */

function refreshTray() {
  if (!tray) return;
  const s = status();
  const cfg = readCfg();
  tray.setToolTip(`Coopanion · 远程 ${cfg.sshHost || '(未配置)'} · ${s.tunnel ? '隧道 OK' : '隧道断开'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开桌宠', click: () => { void reconnect(true); } },
    { label: '重新连接', click: () => { void reconnect(true); } },
    { type: 'separator' },
    // NAS 上 Core 自带的 Web 控制台：模型 / 世界 / 提示词 / 日志 / 存储都在里面
    { label: '打开 NAS 控制台', enabled: Boolean(s.tunnel && cfg.consoleEnabled), click: () => openConsole() },
    { label: '远程后端设置…', click: () => openSettings() },
    { type: 'separator' },
    {
      label: '开机自启', type: 'checkbox', checked: autostartGet(), enabled: process.platform !== 'linux',
      click: (item) => { autostartSet(item.checked); refreshTray(); },
    },
    ...(s.error ? [{ type: 'separator' }, { label: s.error, enabled: false }] : []),
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

/** NAS Core 自带的 Web UI（经隧道访问；不改任何本地文件）。 */
function openConsole() {
  const cfg = readCfg();
  const url = `http://127.0.0.1:${cfg.consolePort}/`;
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.loadURL(url);
    consoleWin.show();
    consoleWin.focus();
    return;
  }
  consoleWin = new BrowserWindow({
    width: 1180, height: 820, title: 'Coopanion · NAS 控制台',
    autoHideMenuBar: true, backgroundColor: '#f4f5f4',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  consoleWin.loadURL(url);
  consoleWin.on('closed', () => { consoleWin = null; });
}

function buildTray() {
  const name = process.platform === 'darwin' ? 'trayTemplate' : 'tray';
  const icon = nativeImage.createFromPath(join(iconsDir, `${name}.png`));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Coopanion · 远程后端');
  refreshTray();
  if (process.platform !== 'darwin') tray.on('click', () => openSettings());
}

/* ------------------------------ 设置窗口 ---------------------------- */

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560, height: 640, title: '远程后端设置', autoHideMenuBar: true,
    webPreferences: {
      // 本地打包的静态页，只读写 <DATA>/remote.json；不加载任何远程内容
      nodeIntegration: true, contextIsolation: false, sandbox: false, spellcheck: false,
    },
  });
  settingsWin.loadFile(join(__dirname, 'remote-settings.html'), { query: { cfg: cfgPath } });
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ------------------------------ 开机自启 ---------------------------- */

// 由 main.cjs 传入：portable 版登录项以文件夹命名，参数是 --background
// （主程序里没有任何代码读这个参数，它只是给 Electron 读回 openAtLogin 用的身份）。
let loginName;
let loginArgs = ['--background'];

function autostartGet() {
  if (process.platform === 'linux') return false;
  try {
    return loginName
      ? app.getLoginItemSettings().launchItems.some((item) => item.name === loginName)
      : app.getLoginItemSettings({ args: loginArgs }).openAtLogin;
  } catch {
    return false;
  }
}

function autostartSet(on) {
  if (process.platform === 'linux') return false;
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(on), args: loginArgs, ...(loginName ? { name: loginName } : {}) });
  } catch { /* 注册失败不致命 */ }
  return autostartGet();
}

/* -------------------------------- 导出 ------------------------------ */

function start(options) {
  cfgPath = join(options.dataDir, 'remote.json');
  iconsDir = options.iconsDir;
  loginName = options.loginName;
  if (Array.isArray(options.loginArgs)) loginArgs = options.loginArgs;
  const cfg = readCfg();
  if (!cfg.enabled) return false;

  stopping = false;
  app.on('before-quit', () => { stopping = true; clearReadyRetry(); killTunnel(); killPet(); });

  ipcMain.on('remote:reload', () => { void reconnect(true); });
  ipcMain.on('remote:quit', () => app.quit());
  ipcMain.handle('remote:status', () => status());
  ipcMain.handle('remote:read', () => readCfg());
  ipcMain.handle('remote:write', (_e, patch) => {
    const next = writeCfg(patch);
    if (next.enabled) void reconnect();
    refreshTray();
    return next;
  });
  ipcMain.handle('remote:autostart:get', () => autostartGet());
  ipcMain.handle('remote:autostart:set', (_e, on) => { const v = autostartSet(on); refreshTray(); return v; });

  buildTray();
  void reconnect();

  // 配置缺项：直接把设置窗口摊开，免得用户面对一个没有反应的托盘图标
  if (!cfg.sshHost || !cfg.sshUser) {
    lastError = '还没有配置 NAS 主机/用户名';
    refreshTray();
    openSettings();
  }
  return true;
}

module.exports = { start };
