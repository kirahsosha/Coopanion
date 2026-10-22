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
  /** NapCat WebUI 的 token：填了就能免手输直接进控制台（只存本机 remote.json） */
  napcatToken: '',
  /** NAS 上 NapCat 的 webui.json 路径；打开控制台前会读它校正 token（普通 SSH 用户可读） */
  napcatConfigPath: '/data_n005/coopanion/napcat/config/webui.json',
  /** 转发 NAS 上 Core 自带的 Web 控制台（模型/世界/提示词/日志都在里面） */
  consoleEnabled: true,
  /** 控制台隧道端口，两端同号（NAS 侧由 compose 的 console-relay 发布到 17790） */
  consolePort: 17790,
  /**
   * 桌宠服务端口。装扮页 / 桌宠预览是桌宠 World 自己的页面，World 上报的地址是
   * 它视角的 127.0.0.1:7797 —— 要在本机打开，就得把 7797 也转到 NAS 的桌宠 relay。
   */
  petServicePort: 7797,
};

/**
 * 改动这些字段才需要重连（重建隧道 / 重开桌宠窗口）。
 * token、开机自启之类不在其中 —— 改个 token 不该把桌宠关掉重开。
 */
const TUNNEL_KEYS = [
  'sshHost', 'sshPort', 'sshUser', 'keyPath', 'localPort', 'remotePetPort',
  'consolePort', 'consoleEnabled', 'petServicePort', 'forwardNapcat', 'napcatPort',
];

let cfgPath = '';
let iconsDir = '';
let tunnel = null;
let pet = null;
let tray = null;
let settingsWin = null;
let consoleWin = null;
let napcatWin = null;
let stopping = false;
let lastError = '';
let tunnelRetry = null;
/** 主题（main.cjs）用的控制台端口：远程模式下指向隧道，不启用时为 null。 */
let currentConsolePort = null;
/** 本次运行是否已经从 World 那里核对过桌宠服务端口。 */
let portLearned = false;
/** 由 main.cjs 注入：原版设置窗口（它自己会用 activePort() 走隧道）。 */
let openSettingsWindow = null;
let started = false;

/** main.cjs 的 serveWindow/设置窗口靠它决定把请求发到哪个端口。 */
function consolePort() {
  return started && currentConsolePort ? currentConsolePort : null;
}

/** 诊断日志：<DATA>/logs/remote.log（只记远程后端自己的事，不碰 Core 的日志） */
function log(line) {
  try {
    require('node:fs').appendFileSync(join(cfgPath, '..', 'logs', 'remote.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* 日志失败不影响功能 */ }
}

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

/** 隧道与"跑一条远程命令"共用的连接参数（不含目的地）。 */
function sshBase(cfg) {
  const args = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=8',
  ];
  if (cfg.keyPath && existsSync(cfg.keyPath)) {
    args.push('-i', cfg.keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes');
  }
  args.push('-p', String(cfg.sshPort));
  return args;
}

function sshTarget(cfg) {
  return `${cfg.sshUser}@${cfg.sshHost}`;
}

/**
 * 从 NAS 读 NapCat 当前的 WebUI token。
 * QQ 重新扫码登录后 NapCat 会刷新 token，存着的那份就过期了 —— 这里每次开控制台前校一次。
 * webui.json 权限是 644，普通 SSH 用户就能读，不需要 sudo。
 * @returns {Promise<string|null>}
 */
function readNapcatToken(cfg) {
  const path = cfg.napcatConfigPath || '/data_n005/coopanion/napcat/config/webui.json';
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('ssh', [...sshBase(cfg), sshTarget(cfg), `cat ${path}`], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const done = (value) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve(null); }, 10000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => done(null));
    child.on('close', () => {
      try {
        const token = JSON.parse(out).token;
        done(typeof token === 'string' && token ? token : null);
      } catch {
        done(null);
      }
    });
  });
}

function sshArgs(cfg) {
  const args = ['-N', '-o', 'ExitOnForwardFailure=yes', ...sshBase(cfg)];
  args.push('-L', `${cfg.localPort}:127.0.0.1:${cfg.remotePetPort}`);
  // 桌宠服务本身（装扮页 / 预览页用）：World 上报的是它自己的 127.0.0.1:7797
  if (cfg.petServicePort && cfg.petServicePort !== cfg.localPort) {
    args.push('-L', `${cfg.petServicePort}:127.0.0.1:${cfg.remotePetPort}`);
  }
  if (cfg.forwardNapcat) args.push('-L', `${cfg.napcatPort}:127.0.0.1:${cfg.napcatPort}`);
  if (cfg.consoleEnabled) args.push('-L', `${cfg.consolePort}:127.0.0.1:${cfg.consolePort}`);
  args.push(sshTarget(cfg));
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

/**
 * 关掉桌宠窗口。必须杀**整棵进程树**：Electron 的 renderer/GPU 是它的子进程，
 * 只 kill 主进程会留下一堆孤儿（表现为"又出现一个桌宠 + 残留后台进程"）。
 */
function killPet() {
  if (!pet) return;
  const pid = pet.pid;
  pet = null;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      // /T 连子进程一起杀，/F 强制；spawnSync 保证在拉起新窗口之前已经杀干净
      require('node:child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* 已经退出 */ }
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
 * 问 NAS 上的桌宠 World 要它自己的地址（`pet/state` 返回 `url` / `dressUrl`），
 * 从中取出真实端口。装扮页与预览页用的就是这个地址，写死迟早会对不上。
 * @returns 端口号；拿不到时 null（调用方保留配置里的值当兜底）。
 */
async function learnPetServicePort(cfg) {
  if (!cfg.consoleEnabled) return null;
  const panel = `http://127.0.0.1:${cfg.consolePort}/api/webui/providers/${encodeURIComponent('world:desktop-pet')}/panels/pet/state`;
  try {
    const res = await fetch(panel, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [] }), signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const reported = body?.url ?? body?.data?.url ?? null;
    if (typeof reported !== 'string') return null;
    const port = Number(new URL(reported).port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * @param reset 操作者手动触发（托盘「重新连接」）时为 true：重置退避并重开隧道。
 */
async function reconnect(reset = false) {
  const cfg = readCfg();
  if (!cfg.enabled) { currentConsolePort = null; return; }
  currentConsolePort = cfg.consoleEnabled ? cfg.consolePort : null;
  clearReadyRetry();
  if (reset) { readyDelay = 5000; portLearned = false; killTunnel(); }
  killPet();

  // 隧道还活着就别重开，只再探一次远端（NAS 慢启动时的常态）
  if (!(tunnel && tunnel.exitCode === null) && !startTunnel(cfg)) return;

  const url = petUrl(cfg);
  const ok = await waitReady(url);
  if (!ok) {
    scheduleReadyRetry();
    return;
  }

  // 端口自愈：World 上报的桌宠服务端口和本地隧道端口不一致时，改配置并重开一次隧道。
  // 只在拉起桌宠窗口之前做，避免窗口先连上再被掐。
  if (!portLearned) {
    portLearned = true;
    const actual = await learnPetServicePort(cfg);
    if (actual && actual !== cfg.petServicePort) {
      writeCfg({ petServicePort: actual });
      killTunnel();
      const next = readCfg();
      if (startTunnel(next) && (await waitReady(url, 10000))) {
        readyDelay = 5000;
        spawnPet(url);
        lastError = '';
        refreshTray();
        return;
      }
      scheduleReadyRetry();
      return;
    }
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
    // 原版设置窗口（build/console）：远程模式下它的请求经隧道打到 NAS 的 Core
    { label: 'Coopanion 设置…', enabled: Boolean(s.tunnel && cfg.consoleEnabled), click: () => openSettingsWindow?.() },
    // QQ 协议端控制台：登录态、账号、连接参数；token 已带在 URL 里
    { label: '打开 NapCat WebUI', enabled: Boolean(s.tunnel && cfg.forwardNapcat), click: () => openNapcat() },
    { label: '远程连接设置…', click: () => openSettings() },
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

/**
 * NapCat 的 WebUI 地址。它的页面本身不校验 token（由前端读 URL 后存起来），
 * 所以把 token 拼进 query 就能免手输直接进控制台。
 */
function napcatUrl(cfg = readCfg()) {
  const base = `http://127.0.0.1:${cfg.napcatPort}/webui/`;
  return cfg.napcatToken ? `${base}?token=${encodeURIComponent(cfg.napcatToken)}` : base;
}

/**
 * 打开前先跟 NAS 校一次 token：QQ 扫码重登后 NapCat 会刷新它，
 * 本地存的那份就会失效（表现为一直要求输密码/页面打不开）。
 */
async function openNapcat() {
  const cfg = readCfg();
  const fresh = await readNapcatToken(cfg);
  if (fresh && fresh !== cfg.napcatToken) {
    cfg.napcatToken = fresh;
    writeCfg({ napcatToken: fresh });
    log('napcat token refreshed from NAS');
  }
  const url = napcatUrl(cfg);
  if (napcatWin && !napcatWin.isDestroyed()) {
    napcatWin.loadURL(url);
    napcatWin.show();
    napcatWin.focus();
    return url;
  }
  napcatWin = new BrowserWindow({
    width: 1120, height: 800, title: 'NapCat WebUI',
    autoHideMenuBar: true, backgroundColor: '#f4f5f4',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  napcatWin.loadURL(url);
  napcatWin.on('closed', () => { napcatWin = null; });
  return url;
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

let inited = false;

/**
 * 无论是否启用远程模式都要跑：注册 IPC、记住配置路径。
 * 本机模式（enabled: false）下托盘里仍然要能打开「远程后端设置」，否则勾掉之后
 * 就再也进不去了 —— 只能手改 remote.json。
 */
function init(options) {
  if (inited) return;
  inited = true;
  cfgPath = join(options.dataDir, 'remote.json');
  iconsDir = options.iconsDir;
  loginName = options.loginName;
  if (Array.isArray(options.loginArgs)) loginArgs = options.loginArgs;
  openSettingsWindow = typeof options.openSettings === 'function' ? options.openSettings : null;

  ipcMain.on('remote:reload', () => { void reconnect(true); });
  ipcMain.on('remote:quit', () => app.quit());
  ipcMain.on('remote:restart', () => { app.relaunch(); app.exit(0); });
  ipcMain.on('remote:open', () => openSettings());
  ipcMain.on('remote:napcat', () => { void openNapcat(); });
  ipcMain.handle('remote:napcat-url', () => napcatUrl());
  // 手动"从 NAS 读一次 token"：读不到返回 null（页面上提示检查 SSH 配置）
  ipcMain.handle('remote:napcat-token', async () => {
    const token = await readNapcatToken(readCfg());
    if (token) { writeCfg({ napcatToken: token }); log('napcat token read on demand'); }
    return token;
  });
  ipcMain.handle('remote:status', () => status());
  ipcMain.handle('remote:read', () => readCfg());
  ipcMain.handle('remote:write', (_e, patch) => {
    const before = readCfg();
    const next = writeCfg(patch);
    // 模式切换（本机 ⇄ 远程）只能在启动时决定，写进配置后必须重启才生效
    const needRestart = started ? !next.enabled : Boolean(next.enabled);
    // 只有动到隧道/端口的字段才重连；否则会把好好的桌宠关掉重开一个
    const tunnelChanged = TUNNEL_KEYS.some((k) => String(before[k] ?? '') !== String(next[k] ?? ''));
    const reconnected = Boolean(started && next.enabled && tunnelChanged);
    if (reconnected) void reconnect(true);
    refreshTray();
    return { cfg: next, needRestart, reconnected };
  });
  ipcMain.handle('remote:autostart:get', () => autostartGet());
  ipcMain.handle('remote:autostart:set', (_e, on) => { const v = autostartSet(on); refreshTray(); return v; });
}

/**
 * 监听宿主进程写来的「打开设置」信号文件（桌宠齿轮）。
 * 用文件而不是再拉起一个进程：点一次只多一次 writeFileSync，不会留下残留进程。
 * 用轮询而不是 fs.watch：Windows 上的目录监听不够可靠，500ms 一次 stat 的成本可以忽略。
 */
function watchOpenRequest(dataDir) {
  const file = join(dataDir, '.open-settings.req');
  let last = 0;
  log(`watcher start: ${file}`);
  setInterval(() => {
    try {
      if (!existsSync(file)) return;
      const now = Date.now();
      if (now - last < 800) return;
      last = now;
      try { require('node:fs').rmSync(file, { force: true }); } catch { /* 删不掉不影响打开 */ }
      log('gear request detected → opening settings');
      (openSettingsWindow ?? openSettings)();
    } catch (err) {
      log(`watcher error: ${err && err.message ? err.message : String(err)}`);
    }
  }, 500).unref();
}

function start(options) {
  init(options);
  const cfg = readCfg();
  if (!cfg.enabled) return false;
  started = true;

  stopping = false;
  app.on('before-quit', () => { stopping = true; clearReadyRetry(); killTunnel(); killPet(); });

  // 桌宠的齿轮：远程模式下由宿主进程再拉起一次主程序来通知我们
  // （见 world 包的 host/electron-main.cjs 里的 pet:openSettings）
  watchOpenRequest(options.dataDir);
  app.on('second-instance', () => { (openSettingsWindow ?? openSettings)(); });

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

module.exports = { init, start, consolePort, openSettings };
