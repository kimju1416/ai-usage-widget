const { app, BrowserWindow, Tray, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const POLL_INTERVAL_MS = 60 * 1000; // 1분마다 자동 새로고침

const userDataPath = app.getPath('userData');
const stateFile = path.join(userDataPath, 'widget-state.json');
const debugLogFile = path.join(userDataPath, 'debug.log');

const MAX_DEBUG_LOG_BYTES = 500 * 1024;

// 메인 프로세스를 블로킹하지 않도록 전부 비동기로 처리 — 디스크 지연(OneDrive 동기화 등)이
// 폴링 자체를 지연시키는 일이 없게 한다. 실패해도 무시(로그는 진단용일 뿐 기능에 영향 없음).
let debugLogTrimming = false;
function debugLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFile(debugLogFile, line, (err) => {
    if (err || debugLogTrimming) return;
    fs.stat(debugLogFile, (statErr, stat) => {
      if (statErr || !stat || stat.size <= MAX_DEBUG_LOG_BYTES) return;
      debugLogTrimming = true;
      fs.readFile(debugLogFile, 'utf-8', (readErr, content) => {
        if (!readErr) {
          fs.writeFile(debugLogFile, content.slice(-MAX_DEBUG_LOG_BYTES / 2), () => { debugLogTrimming = false; });
        } else {
          debugLogTrimming = false;
        }
      });
    });
  });
}

let widgetWin = null;
let tray = null;
let pollTimer = null;
const workerWins = { claude: null, codex: null, gemini: null };
const lastData = { claude: null, codex: null, gemini: null };
let loginCheckInFlight = { claude: false, codex: false, gemini: false };

// 예상치 못한 오류로 트레이 상주 앱 전체가 조용히 죽어버리는 걸 방지 — 로그만 남기고 계속 실행
process.on('uncaughtException', (err) => {
  debugLog(`uncaughtException: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  debugLog(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveState(patch) {
  try {
    const merged = { ...loadState(), ...patch };
    fs.writeFileSync(stateFile, JSON.stringify(merged));
  } catch (e) {
    // 무시
  }
}

function getMode() {
  return loadState().mode === 'tray' ? 'tray' : 'widget';
}

function getOpacity() {
  const v = loadState().opacity;
  return typeof v === 'number' ? v : 1;
}

function getAlwaysOnTop() {
  const v = loadState().alwaysOnTop;
  return typeof v === 'boolean' ? v : true; // 기본값: 항상 위로 고정
}

function getShowFable() {
  return loadState().showFable === true;
}

function getColorTheme() {
  return loadState().colorTheme === 'muted' ? 'muted' : 'vivid';
}

const WIDGET_SIZE_SCALE = { small: 0.96, medium: 1.2, large: 1.56 };
function getWidgetSize() {
  const v = loadState().widgetSize;
  return (v === 'small' || v === 'large') ? v : 'medium';
}

function getShowProvider(key) {
  const v = loadState()['show_' + key];
  return typeof v === 'boolean' ? v : key === 'claude'; // 기본값: Claude만 켜짐
}

function getGraphStyle() {
  return loadState().graphStyle === 'bar' ? 'bar' : 'ring';
}

// 해시/쿼리만 다르고 나머지 URL이 같으면 Electron/Chromium이 "같은 문서 내 이동"으로 처리해
// 페이지를 다시 로드하지 않을 수 있다. 매번 진짜로 새로 로드되도록 쿼리스트링에 타임스탬프를 섞는다.
//
// 중요: 각 서비스 페이지는 사용자 계정/시스템 언어에 따라 한국어가 아닐 수 있다.
// 한국어 문구만 매칭하면 영어 UI 사용자는 로그인해도 값을 영영 못 읽는다("로그인이 안 돼요" 제보의 원인)
// — 모든 추출 정규식은 한국어와 영어를 둘 다 지원해야 한다.
const CLAUDE_EXTRACT_SCRIPT = `(function(){
  const text = document.body.innerText || '';
  function grab(label) {
    const m = text.match(new RegExp(label + '\\\\s*\\\\n([^\\\\n]+)\\\\s*\\\\n(\\\\d+)%\\\\s*(?:사용됨|used)', 'i'));
    return m ? { reset: m[1].trim(), pct: parseInt(m[2], 10) } : null;
  }
  const session = grab('(?:현재\\\\s*세션|Current\\\\s*session)');
  const weekly = grab('(?:모든\\\\s*모델|All\\\\s*models)');
  const fable = grab('Fable');
  const hasLoginForm = !!document.querySelector('input[type="password"], input[name="email"]') ||
    /계속하려면 로그인|Continue with|Log in to Claude|로 계속하기|로그인 또는 회원가입|빠르게 생각하고/i.test(text);
  return {
    ok: !!(session && weekly),
    needsLogin: !session && !weekly && hasLoginForm,
    session: session,
    weekly: weekly,
    fable: fable
  };
})()`;

const CLAUDE_LOGIN_CHECK_SCRIPT = `(!location.href.includes('/login') && (
  !!document.querySelector('div[contenteditable="true"], textarea') ||
  /안녕하세요/.test(document.body.innerText || '')
))`;

// Codex는 "N% 남음"(remaining) 형태라 사용됨%로 변환한다. 영어 UI는 "N% left/remaining".
const CODEX_EXTRACT_SCRIPT = `(function(){
  const text = document.body.innerText || '';
  function grab(label) {
    const m = text.match(new RegExp(label + '\\\\s*\\\\n+(\\\\d+)%\\\\s*\\\\n*(?:남음|left|remaining)\\\\s*\\\\n*([^\\\\n]+)', 'i'));
    return m ? { reset: m[2].trim(), pct: 100 - parseInt(m[1], 10) } : null;
  }
  const session = grab('(?:5시간\\\\s*사용\\\\s*한도|5[\\\\s-]*h(?:our)?\\\\s*(?:usage\\\\s*)?limit)');
  const weekly = grab('(?:주간\\\\s*사용\\\\s*한도|Weekly\\\\s*(?:usage\\\\s*)?limit)');
  const hasLoginForm = !!document.querySelector('input[type="password"], input[name="email"]') ||
    /로그인 또는 회원가입|Log in or sign up|계정으로 계속하기|Continue with/i.test(text);
  return {
    ok: !!(session && weekly),
    needsLogin: !session && !weekly && hasLoginForm,
    session: session,
    weekly: weekly,
    fable: null
  };
})()`;

const CODEX_LOGIN_CHECK_SCRIPT = `(!document.querySelector('input[type="password"]') &&
  (!!document.querySelector('div[contenteditable="true"], textarea') || /Codex/.test(document.title)))`;

// gemini.google.com/usage 페이지 구조: "현재 사용량" 블록에 5시간 한도(N% 사용됨 + 초기화 시각),
// "주간 한도" 블록에 주간 값이 있다. 두 블록 다 이미 "사용됨%" 형식이라 별도 변환이 필요없다.
// 퍼센트/초기화 문구가 화면상 같은 줄에 있는지 다른 줄에 있는지 정확한 DOM 순서를 알 수 없어서,
// 블록 단위로 잘라낸 뒤 그 안에서 순서에 상관없이 각각 찾는 방식으로 만들었다.
const GEMINI_EXTRACT_SCRIPT = `(function(){
  const text = document.body.innerText || '';
  function findLabel(labels) {
    for (const label of labels) {
      const i = text.search(new RegExp(label, 'i'));
      if (i !== -1) return i;
    }
    return -1;
  }
  function block(startLabels, endLabels) {
    const s = findLabel(startLabels);
    if (s === -1) return '';
    const from = s + 4;
    let e = endLabels ? findLabel(endLabels) : -1;
    if (e === -1 || e <= from) e = from + 400;
    return text.slice(from, e);
  }
  function parse(blockText) {
    const pctM = blockText.match(/(\\d+)%\\s*(?:사용됨|used)/i);
    const resetM = blockText.match(/([^\\n]*(?:초기화|[Rr]esets?[^\\n]*))/);
    if (!pctM) return null;
    return { pct: parseInt(pctM[1], 10), reset: resetM ? resetM[1].trim() : '' };
  }
  const SESSION_LABELS = ['현재 사용량', 'Current usage'];
  const WEEKLY_LABELS = ['주간 한도', 'Weekly limit'];
  const session = parse(block(SESSION_LABELS, WEEKLY_LABELS));
  const weekly = parse(block(WEEKLY_LABELS, null));
  const hasLoginForm = !session && !weekly &&
    /Sign in|로그인|Google 계정으로 로그인/i.test(text);
  return {
    ok: !!(session && weekly),
    needsLogin: !session && !weekly && hasLoginForm,
    session: session,
    weekly: weekly,
    fable: null
  };
})()`;

const GEMINI_LOGIN_CHECK_SCRIPT = `(!location.href.includes('accounts.google.com') &&
  (!!document.querySelector('rich-textarea, div[contenteditable="true"], textarea') || /Gemini/.test(document.title)))`;

const PROVIDERS = {
  claude: {
    key: 'claude',
    label: 'Claude',
    partition: 'persist:claudeusage',
    loginUrl: 'https://claude.ai/login',
    usageUrl: () => `https://claude.ai/new?_w=${Date.now()}#settings/usage`,
    extractScript: CLAUDE_EXTRACT_SCRIPT,
    loginCheckScript: CLAUDE_LOGIN_CHECK_SCRIPT
  },
  codex: {
    key: 'codex',
    label: 'Codex',
    partition: 'persist:codexusage',
    loginUrl: 'https://chatgpt.com/auth/login',
    usageUrl: () => `https://chatgpt.com/codex/cloud/settings/analytics?_w=${Date.now()}#usage`,
    extractScript: CODEX_EXTRACT_SCRIPT,
    loginCheckScript: CODEX_LOGIN_CHECK_SCRIPT
  },
  gemini: {
    key: 'gemini',
    label: 'Gemini',
    partition: 'persist:geminiusage',
    loginUrl: 'https://gemini.google.com/app',
    usageUrl: () => `https://gemini.google.com/usage?_w=${Date.now()}`,
    extractScript: GEMINI_EXTRACT_SCRIPT,
    loginCheckScript: GEMINI_LOGIN_CHECK_SCRIPT
  }
};

const ALL_PROVIDER_KEYS = ['claude', 'codex', 'gemini'];

function widgetWidthFor(showFable, graphStyle) {
  // 막대형은 값을 세로로 쌓기 때문에 원 3개를 나란히 놓을 폭이 필요없다 — 항상 좁은 고정폭이면 된다.
  if (graphStyle === 'bar') return 168;
  return showFable ? 244 : 168; // 원형: Claude 3개 원을 같은 크기로 나란히 배치할 만큼 넉넉하게
}

function metricCountFor(key) {
  return key === 'claude' && getShowFable() ? 3 : 2;
}

// 로그인 필요 버튼이 보일 때만 여유 공간이 더 필요하고, 로그인된 상태(그래프+상태줄만)는
// 더 좁아도 된다 — 항상 넉넉한 고정값을 쓰면 로그인 후에 바닥에 빈 여백이 크게 남는다.
function sectionHeightFor(key) {
  const data = lastData[key];
  const needsLoginBtn = !data || data.needsLogin;
  if (getGraphStyle() === 'bar') {
    // 막대형 지표 1줄 실측: bar-row-top(약 14.5) + bar-track(6) + bar-reset(약 12.5) = 약 33px,
    // 줄 사이 margin-bottom 8px. 폰트별 줄높이 편차를 감안해 줄당 4px 여유를 둔다.
    const header = 18;
    const status = 14;
    const loginExtra = needsLoginBtn ? 20 : 0;
    const metricCount = metricCountFor(key);
    const rowsHeight = metricCount * 37 + (metricCount - 1) * 8;
    return header + rowsHeight + status + loginExtra;
  }
  // 재설정 시각 문구가 좁은 폭(Fable 꺼짐 등)에서 두 줄로 줄바꿈될 때도 안 잘리도록 여유를 둔다
  return needsLoginBtn ? 152 : 140;
}

function widgetSizeFor() {
  const claudeOn = getShowProvider('claude');
  const codexOn = getShowProvider('codex');
  const geminiOn = getShowProvider('gemini');
  const graphStyle = getGraphStyle();
  const width = Math.max(
    claudeOn ? widgetWidthFor(getShowFable(), graphStyle) : 0,
    codexOn ? 168 : 0,
    geminiOn ? 168 : 0,
    168
  );
  const sectionCount = (claudeOn ? 1 : 0) + (codexOn ? 1 : 0) + (geminiOn ? 1 : 0);
  const chrome = 22;
  const sectionsHeight = (claudeOn ? sectionHeightFor('claude') : 0) + (codexOn ? sectionHeightFor('codex') : 0) + (geminiOn ? sectionHeightFor('gemini') : 0);
  // .section + .section.on 은 margin-top 8 + padding-top 8 + border-top 1 = 17px를 차지한다.
  const gap = sectionCount > 1 ? 17 * (sectionCount - 1) : 0;
  const height = Math.max(chrome + sectionsHeight + gap, 168);
  const scale = WIDGET_SIZE_SCALE[getWidgetSize()];
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function resizeWidgetToState() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const size = widgetSizeFor();
  const bounds = widgetWin.getBounds();
  widgetWin.setBounds({ x: bounds.x, y: bounds.y, width: size.width, height: size.height });
}

function createWidgetWindow() {
  const state = loadState();
  const size = widgetSizeFor();
  widgetWin = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: typeof state.x === 'number' ? state.x : undefined,
    y: typeof state.y === 'number' ? state.y : undefined,
    frame: false,
    // 투명창 + roundedCorners:false 조합은 Windows 11에서 리사이즈/로그인 등 상태 변화 시
    // DWM 모서리 재계산과 충돌해 상단에 색이 낀 틈이 반복적으로 생기는 문제가 있었다.
    // 대신 완전 불투명 창으로 두고 Windows 자체 기본 모서리 둥글림을 그대로 사용한다 —
    // 카드 배경이 불투명이라 어떤 틈도 생길 수 없다.
    backgroundColor: '#1c1917',
    resizable: false,
    alwaysOnTop: getAlwaysOnTop(),
    skipTaskbar: true,
    show: getMode() === 'widget',
    opacity: getOpacity(),
    title: '',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  widgetWin.setTitle('');
  if (getAlwaysOnTop()) widgetWin.setAlwaysOnTop(true, 'screen-saver');
  widgetWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWin.loadFile('widget.html');

  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const [x, y] = widgetWin.getPosition();
      saveState({ x, y });
    }, 400);
  };
  widgetWin.on('move', scheduleSave);
  widgetWin.on('closed', () => { widgetWin = null; });

  widgetWin.webContents.once('did-finish-load', () => sendToWidget());
}

let aboutWin = null;

function openAboutWindow() {
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.show();
    aboutWin.focus();
    return;
  }
  aboutWin = new BrowserWindow({
    width: 400,
    height: 430,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '사용법',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  aboutWin.setMenuBarVisibility(false);
  aboutWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  aboutWin.loadFile('about.html');
  aboutWin.on('closed', () => { aboutWin = null; });
}

function createWorkerWindow(providerKey) {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 720,
    webPreferences: {
      partition: PROVIDERS[providerKey].partition
    }
  });
  win.on('closed', () => { workerWins[providerKey] = null; });
  workerWins[providerKey] = win;
  return win;
}

function getWorkerWindow(providerKey) {
  const existing = workerWins[providerKey];
  if (existing && !existing.isDestroyed()) return existing;
  return createWorkerWindow(providerKey);
}


function updateTray() {
  if (!tray) return;
  // Windows 트레이 툴팁은 글자수 제한이 있어(약 128자), reset 시각 등은 빼고 짧게 압축한다 —
  // 아니면 뒤쪽 provider(Codex) 줄이 통째로 잘려서 안 보이는 문제가 있었다.
  const lines = [];
  for (const key of ALL_PROVIDER_KEYS) {
    if (!getShowProvider(key)) continue;
    const data = lastData[key];
    const label = PROVIDERS[key].label;
    if (!data) {
      lines.push(`${label}: 불러오는 중`);
    } else if (data.needsLogin) {
      lines.push(`${label}: 로그인 필요`);
    } else if (!data.ok) {
      lines.push(`${label}: 읽기 실패`);
    } else {
      let line = `${label} 5h ${data.session.pct}% · 7d ${data.weekly.pct}%`;
      if (data.fable) line += ` · Fable ${data.fable.pct}%`;
      lines.push(line);
    }
  }
  tray.setToolTip(lines.length ? lines.join('\n') : 'Claude 사용량 위젯');
}

function sendToWidget() {
  updateTray();
  resizeWidgetToState();
  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.webContents.send('usage-data', {
      claude: lastData.claude,
      codex: lastData.codex,
      gemini: lastData.gemini,
      showClaude: getShowProvider('claude'),
      showCodex: getShowProvider('codex'),
      showGemini: getShowProvider('gemini'),
      showFable: getShowFable(),
      colorTheme: getColorTheme(),
      sizeScale: WIDGET_SIZE_SCALE[getWidgetSize()],
      graphStyle: getGraphStyle()
    });
  }
}

const POLL_TIMEOUT_MS = 25 * 1000; // 폴링 1회 최대 허용 시간 — 이보다 오래 걸리면 강제로 실패 처리하고 다음 주기를 위해 놓아준다
const pollInFlight = { claude: false, codex: false, gemini: false };
const pollGeneration = { claude: 0, codex: 0, gemini: 0 }; // 타임아웃난 이전 폴링이 뒤늦게 끝나 최신 결과를 덮어쓰는 것을 막기 위한 세대 토큰
const loginInFlight = { claude: false, codex: false, gemini: false }; // 로그인 창이 열려있는 동안엔 같은 워커 창을 폴링이 건드리지 않게 함

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// 오류 진단용 스니펫에서 이메일 등 개인정보로 보이는 패턴을 지운다 — 이 로그는 사용자가
// "디버그 로그 열기"로 직접 열어보거나 캡처해 공유할 수 있는 평문 파일이라 최소한의 마스킹을 한다.
function maskSensitive(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .slice(0, 120);
}

async function pollProvider(providerKey) {
  if (pollInFlight[providerKey]) {
    debugLog(`[${providerKey}] poll skip: 이전 폴링이 아직 진행 중`);
    return;
  }
  if (loginInFlight[providerKey]) {
    debugLog(`[${providerKey}] poll skip: 로그인 진행 중`);
    return;
  }
  pollInFlight[providerKey] = true;
  const myGeneration = ++pollGeneration[providerKey];
  debugLog(`[${providerKey}] pollProvider 시작`);
  const provider = PROVIDERS[providerKey];
  const win = getWorkerWindow(providerKey);
  debugLog(`[${providerKey}] getWorkerWindow 완료, loadURL 시작`);
  try {
    await withTimeout(
      (async () => {
        await win.loadURL(provider.usageUrl());
        debugLog(`[${providerKey}] loadURL 완료`);
        await new Promise((r) => setTimeout(r, 2500));
        let result = await win.webContents.executeJavaScript(provider.extractScript);

        // 사용량 화면이 늦게 열리는 경우가 있어, 실패했지만 로그아웃도 아니면 한 번 더 대기 후 재시도
        if (!result.ok && !result.needsLogin) {
          await new Promise((r) => setTimeout(r, 2500));
          result = await win.webContents.executeJavaScript(provider.extractScript);
        }

        // 값을 찾긴 했어도(ok=true) 페이지가 아직 이전/캐시된 숫자를 보여주는 과도기일 수 있다.
        // (Codex에서 100%가 잠깐 낮게 표시됐다가 다음 폴링에 다시 돌아오는 현상 확인됨)
        // 같은 값이 연속 두 번 읽힐 때까지 재확인해서(최대 3회) 안정된 값을 최종으로 채택한다 —
        // 두 번째 값을 무조건 믿으면 그 값 자체가 과도기 값일 수 있다.
        if (result.ok) {
          for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise((r) => setTimeout(r, 1500));
            const confirm = await win.webContents.executeJavaScript(provider.extractScript);
            if (!confirm.ok) break;
            const stable = confirm.session.pct === result.session.pct && confirm.weekly.pct === result.weekly.pct;
            if (!stable) {
              debugLog(`[${providerKey}] 값 안정화 재확인 ${attempt + 1}회: ${result.session.pct}/${result.weekly.pct} → ${confirm.session.pct}/${confirm.weekly.pct}`);
            }
            result = confirm;
            if (stable) break;
          }
        }

        // 타임아웃으로 이미 다음 세대가 시작된 뒤 뒤늦게 끝난 결과라면, 최신 데이터를 덮어쓰지 않고 버린다
        if (myGeneration !== pollGeneration[providerKey]) {
          debugLog(`[${providerKey}] poll 결과 폐기: 이미 다음 세대(${pollGeneration[providerKey]})가 진행 중 (내 세대 ${myGeneration})`);
          return;
        }

        if (result.ok) {
          const fableStr = result.fable ? ` fable=${result.fable.pct}%` : '';
          debugLog(`[${providerKey}] poll ok=true 5h=${result.session.pct}% 7d=${result.weekly.pct}%${fableStr}`);
        } else {
          const url = win.webContents.getURL();
          const snippet = await win.webContents.executeJavaScript('(document.body.innerText||"").slice(0,300)');
          debugLog(`[${providerKey}] poll ok=false needsLogin=${result.needsLogin} url=${url} snippet=${JSON.stringify(maskSensitive(snippet))}`);
        }
        lastData[providerKey] = result;
      })(),
      POLL_TIMEOUT_MS,
      `${providerKey} poll`
    );
  } catch (e) {
    if (myGeneration === pollGeneration[providerKey]) {
      debugLog(`[${providerKey}] poll error: ${e.message}`);
      lastData[providerKey] = { ok: false, needsLogin: false, session: null, weekly: null, fable: null };
    }
    // 타임아웃 시 워커 창에 남은 요청을 실제로 끊어서, 좀비 프로미스가 다음 폴링 창을 계속 붙잡지 않게 한다
    if (win && !win.isDestroyed()) {
      try { win.webContents.stop(); } catch (_) { /* 무시 */ }
    }
  } finally {
    pollInFlight[providerKey] = false;
  }
  if (myGeneration === pollGeneration[providerKey]) sendToWidget();
}

async function pollAll() {
  const jobs = ALL_PROVIDER_KEYS.filter(getShowProvider).map(pollProvider);
  await Promise.all(jobs);
}

function openLoginWindow(providerKey) {
  const provider = PROVIDERS[providerKey];
  const win = getWorkerWindow(providerKey);
  loginInFlight[providerKey] = true; // 로그인 흐름이 끝날 때까지 이 provider의 일반 폴링은 같은 창을 건드리지 않게 막는다
  win.show();
  win.focus();
  win.loadURL(provider.loginUrl);
  debugLog(`[${providerKey}] openLoginWindow: 로그인 페이지 로드`);

  if (loginCheckInFlight[providerKey]) return; // 이미 로그인 확인 루프가 돌고 있으면 중복 시작하지 않음
  loginCheckInFlight[providerKey] = true;

  let tries = 0;
  const maxTries = 200; // 최대 약 10분 대기
  const check = setInterval(async () => {
    tries += 1;
    const w = workerWins[providerKey];
    if (!w || w.isDestroyed() || tries > maxTries) {
      clearInterval(check);
      loginCheckInFlight[providerKey] = false;
      loginInFlight[providerKey] = false;
      return;
    }
    try {
      const loggedIn = await w.webContents.executeJavaScript(provider.loginCheckScript);
      if (loggedIn) {
        clearInterval(check);
        loginCheckInFlight[providerKey] = false;
        debugLog(`[${providerKey}] 로그인 감지됨 (시도 ${tries}회)`);
        await w.loadURL(provider.usageUrl());
        await new Promise((r) => setTimeout(r, 2500));
        const result = await w.webContents.executeJavaScript(provider.extractScript);
        debugLog(`[${providerKey}] 로그인 후 사용량 추출: ok=${result.ok}`);
        w.hide();
        lastData[providerKey] = result;
        loginInFlight[providerKey] = false;
        sendToWidget();
      }
    } catch (e) {
      debugLog(`[${providerKey}] 로그인 체크 오류(시도 ${tries}회): ${e.message}`);
    }
  }, 3000);
}

function applyMode(mode) {
  saveState({ mode });
  if (!widgetWin) { createWidgetWindow(); }
  if (mode === 'widget') {
    widgetWin.show();
  } else {
    widgetWin.hide();
  }
}

function applyOpacity(opacity) {
  saveState({ opacity });
  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.setOpacity(opacity);
  }
}

function applyAlwaysOnTop(alwaysOnTop) {
  saveState({ alwaysOnTop });
  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? 'screen-saver' : undefined);
  }
}

function applyShowFable(showFable) {
  saveState({ showFable });
  sendToWidget();
}

function applyColorTheme(colorTheme) {
  saveState({ colorTheme });
  sendToWidget();
}

function applyWidgetSize(widgetSize) {
  saveState({ widgetSize });
  sendToWidget(); // resizeWidgetToState()가 새 크기로 창도 같이 리사이즈함
}

function applyGraphStyle(graphStyle) {
  saveState({ graphStyle });
  sendToWidget(); // 그래프 모양에 따라 섹션 높이가 달라지므로 리사이즈도 같이 됨
}

function applyShowProvider(key, value) {
  // 최소 하나는 항상 켜져 있어야 한다
  const others = ALL_PROVIDER_KEYS.filter((k) => k !== key);
  if (!value && !others.some(getShowProvider)) return;
  saveState({ ['show_' + key]: value });
  if (value && !lastData[key]) pollProvider(key);
  sendToWidget();
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('Claude 사용량 위젯');

  const buildMenu = () => {
    const mode = getMode();
    const opacity = getOpacity();
    const colorTheme = getColorTheme();
    const opacityMenu = [1, 0.85, 0.7, 0.55].map((v) => ({
      label: `${Math.round(v * 100)}%`,
      type: 'radio',
      checked: Math.abs(opacity - v) < 0.001,
      click: () => { applyOpacity(v); tray.setContextMenu(buildMenu()); }
    }));
    const themeMenu = [
      { key: 'vivid', label: '컬러풀 (청록/핑크/노랑)' },
      { key: 'muted', label: '차분한 톤 (무채색)' }
    ].map((t) => ({
      label: t.label,
      type: 'radio',
      checked: colorTheme === t.key,
      click: () => { applyColorTheme(t.key); tray.setContextMenu(buildMenu()); }
    }));
    const widgetSize = getWidgetSize();
    const sizeMenu = [
      { key: 'small', label: '소' },
      { key: 'medium', label: '중' },
      { key: 'large', label: '대' }
    ].map((s) => ({
      label: s.label,
      type: 'radio',
      checked: widgetSize === s.key,
      click: () => { applyWidgetSize(s.key); tray.setContextMenu(buildMenu()); }
    }));
    const graphStyle = getGraphStyle();
    const graphStyleMenu = [
      { key: 'ring', label: '원형' },
      { key: 'bar', label: '막대형' }
    ].map((g) => ({
      label: g.label,
      type: 'radio',
      checked: graphStyle === g.key,
      click: () => { applyGraphStyle(g.key); tray.setContextMenu(buildMenu()); }
    }));

    return Menu.buildFromTemplate([
      {
        label: '위젯 카드로 보기',
        type: 'radio',
        checked: mode === 'widget',
        click: () => { applyMode('widget'); tray.setContextMenu(buildMenu()); }
      },
      {
        label: '트레이 아이콘으로만 보기',
        type: 'radio',
        checked: mode === 'tray',
        click: () => { applyMode('tray'); tray.setContextMenu(buildMenu()); }
      },
      {
        label: '항상 위로 고정',
        type: 'checkbox',
        checked: getAlwaysOnTop(),
        click: (menuItem) => { applyAlwaysOnTop(menuItem.checked); }
      },
      { label: '위젯 투명도', submenu: opacityMenu },
      { label: '위젯 크기', submenu: sizeMenu },
      { label: '그래프 모양', submenu: graphStyleMenu },
      { label: '색상 테마', submenu: themeMenu },
      {
        label: '위젯에 Fable 표시',
        type: 'checkbox',
        checked: getShowFable(),
        click: (menuItem) => { applyShowFable(menuItem.checked); }
      },
      { type: 'separator' },
      {
        label: 'Claude 표시',
        type: 'checkbox',
        checked: getShowProvider('claude'),
        click: (menuItem) => { applyShowProvider('claude', menuItem.checked); tray.setContextMenu(buildMenu()); }
      },
      {
        label: 'Codex 표시',
        type: 'checkbox',
        checked: getShowProvider('codex'),
        click: (menuItem) => { applyShowProvider('codex', menuItem.checked); tray.setContextMenu(buildMenu()); }
      },
      {
        label: 'Gemini 표시',
        type: 'checkbox',
        checked: getShowProvider('gemini'),
        click: (menuItem) => { applyShowProvider('gemini', menuItem.checked); tray.setContextMenu(buildMenu()); }
      },
      { type: 'separator' },
      { label: '지금 새로고침', click: () => pollAll() },
      { label: 'Claude 로그인 창 열기', click: () => openLoginWindow('claude') },
      { label: 'Codex 로그인 창 열기', click: () => openLoginWindow('codex') },
      { label: 'Gemini 로그인 창 열기', click: () => openLoginWindow('gemini') },
      {
        label: 'Windows 시작 시 자동 실행',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (menuItem) => {
          app.setLoginItemSettings({ openAtLogin: menuItem.checked });
        }
      },
      { label: '사용법', click: () => openAboutWindow() },
      { label: '디버그 로그 열기', click: () => shell.openPath(debugLogFile) },
      { type: 'separator' },
      { label: '종료', click: () => { app.quit(); } }
    ]);
  };

  tray.setContextMenu(buildMenu());
  tray.on('click', () => {
    if (getMode() !== 'widget') return; // 트레이 전용 모드에서는 좌클릭으로 창을 띄우지 않음
    if (!widgetWin) { createWidgetWindow(); return; }
    widgetWin.isVisible() ? widgetWin.hide() : widgetWin.show();
  });
}

ipcMain.on('refresh-now', () => pollAll());
ipcMain.on('open-login', (_event, providerKey) => openLoginWindow(ALL_PROVIDER_KEYS.includes(providerKey) ? providerKey : 'claude'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (getMode() !== 'widget') return; // 트레이 전용 모드 설정을 존중
    if (!widgetWin) { createWidgetWindow(); return; }
    widgetWin.show();
    widgetWin.focus();
  });

  app.whenReady().then(() => {
    debugLog('=== app ready, startup 시작 ===');
    createWidgetWindow();
    debugLog('createWidgetWindow 완료');
    createTray();
    debugLog('createTray 완료, pollAll 호출');

    pollAll();
    pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
  });
}

app.on('window-all-closed', (e) => {
  // 트레이 상주 앱이므로 창이 다 닫혀도 종료하지 않음
  e.preventDefault && e.preventDefault();
});

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
});
