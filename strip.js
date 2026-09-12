// 작업표시줄 글자 띠 — 시계 옆 트레이 영역 바로 왼쪽에 5시간/주간 사용량을 두 줄로 띄운다.
// 투명한 작은 창을 작업표시줄 위에 겹쳐 올리는 방식이라 1초마다 자리·맨 위 여부·전체화면을 다시 확인한다.
// 켜 둔 동안에만 창을 만들고, 끄면 창을 없애 메모리를 돌려준다.
// 글자 띠가 떠 있는 동안은 트레이 아이콘이 필요 없으므로 onPresenceChange로 main.js에 알린다.
const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const layout = require('./strip-layout');
const win32 = require('./strip-win32');

const TICK_MS = 1000;
const THEME_EVERY_TICKS = 5;      // 작업표시줄 밝기 테마는 5초마다 확인
const HEARTBEAT_EVERY_TICKS = 30; // 30초마다 "메인 살아 있음" 신호 — 끊기면 글자 띠가 흐려진다
const GAP_CSS = 4;                // 트레이 영역과 띄울 간격(CSS px)
const MAX_WIDTH_CSS = 600;
// 못 띄우는 상태가 5초 이어져야 트레이 아이콘을 되살린다(탐색기 재시작 같은 순간 끊김은 넘긴다).
// 틱 횟수로 세면 안 된다 — 글자 폭·화면 변경 때도 틱이 불려 5번이 1초 안에 찰 수 있다.
const ABSENT_MS = 5000;
const DECIDE_TIMEOUT_MS = 5000;   // 켠 뒤 5초 안에 판단이 안 서면(창이 안 뜨는 등) 트레이 아이콘부터 되살린다
// 작업표시줄을 누르면 작업표시줄이 글자 띠를 덮는다 — 1초 틱만으로는 그 사이 오른쪽 클릭이 작업표시줄로 갔다(실측).
// 맨 위로 다시 올리기만 0.25초마다 따로 한다(자리 계산 없이 SetWindowPos 한 번).
const RAISE_MS = 250;

let current = null; // 아래 IPC 핸들러가 지금 살아 있는 글자 띠를 찾는 곳

ipcMain.on('strip-size', (event, width) => {
  if (current && current.owns(event.sender)) current.setContentWidth(width);
});
ipcMain.on('strip-click', (event) => {
  if (current && current.owns(event.sender)) current.handleClick();
});
ipcMain.on('strip-context', (event) => {
  if (current && current.owns(event.sender)) current.handleContextMenu();
});

function createStrip({ getModel, onClick, onContextMenu, onPresenceChange, log }) {
  let win = null;
  let hwnd = 0;
  let timer = null;
  let ticks = 0;
  let loaded = false;
  let shown = false;
  let contentWidth = 0; // 렌더러가 잰 글자 폭(CSS px)
  let lightTheme = null;
  let lastNote = '';
  let wantRunning = false;
  let presence = null;  // 글자 띠가 트레이 아이콘 역할을 대신하는 중인지 — 모르면 null
  let absentSince = 0;  // 못 띄우는 상태가 시작된 시각(0이면 아님)
  let decideTimer = null;
  let taskbarOverride = null; // 검증 스크립트 전용
  let raiseTimer = null;
  let raisePaused = false;    // 글자 띠에서 연 메뉴가 떠 있는 동안 — 다시 올리면 메뉴 아랫부분을 가린다
  let contextCount = 0;       // 오른쪽 클릭이 메인까지 도착한 횟수(검증용)
  let hookRightUps = 0;       // 창 메시지 단계에서 본 오른쪽 버튼 뗌 횟수(검증용)

  // 1초마다 도는 자리라 같은 판단은 한 번만 기록한다
  function note(key, detail) {
    if (key === lastNote) return;
    lastNote = key;
    log(`[strip] ${key}${detail ? ' ' + detail : ''}`);
  }

  function reportPresence(value) {
    if (presence === value) return;
    presence = value;
    log(`[strip] 트레이 아이콘 ${value ? '뺌(글자 띠가 대신함)' : '필요(글자 띠를 못 띄움)'}`);
    if (!onPresenceChange) return;
    try {
      onPresenceChange(value);
    } catch (e) {
      log(`[strip] 트레이 아이콘 전환 오류: ${e.message}`);
    }
  }

  // 숨은 사유가 잠깐인지(전체화면·자동 숨김) 이 자리에 못 띄우는 것인지 가려서 트레이 아이콘 필요 여부를 정한다
  function applyPresence(reason) {
    const p = layout.presenceForReason(reason);
    if (p === 'pending') return;
    if (p === 'present') {
      absentSince = 0;
      reportPresence(true);
      return;
    }
    if (!absentSince) absentSince = Date.now();
    if (Date.now() - absentSince >= ABSENT_MS) reportPresence(false);
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed() && loaded) win.webContents.send(channel, payload);
  }

  function pushModel() {
    let model;
    try {
      model = getModel();
    } catch (e) {
      log(`[strip] 표시 내용 만들기 오류: ${e.message}`);
      return;
    }
    send('strip-model', { ...model, light: lightTheme === true });
  }

  function hide() {
    if (shown && win && !win.isDestroyed()) win.hide();
    shown = false;
  }

  function tick() {
    if (!win || win.isDestroyed() || !loaded) return;
    ticks += 1;
    if (ticks % THEME_EVERY_TICKS === 1) {
      const light = win32.isTaskbarLight();
      if (light !== lightTheme) {
        lightTheme = light;
        pushModel();
      }
    }
    if (ticks % HEARTBEAT_EVERY_TICKS === 0) send('strip-heartbeat');

    const state = win32.getNotificationState();
    if (layout.hideForNotificationState(state)) {
      note('숨김: 전체화면', `state=${state}`);
      hide();
      applyPresence('fullscreen');
      return;
    }

    const info = taskbarOverride || win32.getTaskbarInfo();
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const b = display.bounds;
    // 주 모니터는 항상 원점(0,0)에 있어 DIP × 배율이 곧 물리 좌표다
    const monitor = {
      left: Math.round(b.x * scale),
      top: Math.round(b.y * scale),
      right: Math.round((b.x + b.width) * scale),
      bottom: Math.round((b.y + b.height) * scale)
    };
    const res = layout.computeStripRect({
      taskbar: info && info.taskbar,
      notify: info && info.notify,
      rebar: info && info.rebar,
      monitor,
      width: contentWidth * scale,
      gap: GAP_CSS * scale
    });
    if (!res.visible) {
      note(`숨김: ${res.reason}`, JSON.stringify(info));
      hide();
      applyPresence(res.reason);
      return;
    }
    if (!shown) {
      win.showInactive();
      shown = true;
    }
    // 실제 창 자리를 재서 다를 때만 옮긴다(배율 변경 등으로 윈도우가 창을 밀어도 다음 틱에 되돌린다)
    const actual = win32.readRect(hwnd);
    if (layout.sameRect(actual, res.rect)) {
      if (!raisePaused) win32.placeTopmost(hwnd, null);
    } else {
      // SetWindowPos만 쓰면 Electron이 기억하는 크기(처음 1×1)에 묶여 창이 잘린다(실측 65×65) —
      // Electron에 DIP 크기를 먼저 알린 뒤 물리 픽셀로 정확히 맞춘다
      win.setBounds({
        x: Math.round(res.rect.x / scale),
        y: Math.round(res.rect.y / scale),
        width: Math.max(1, Math.round(res.rect.width / scale)),
        height: Math.max(1, Math.round(res.rect.height / scale))
      });
      win32.placeTopmost(hwnd, res.rect);
    }
    note(`표시 ${JSON.stringify(res.rect)}`, `scale=${scale}`);
    applyPresence(null);
  }

  function safeTick() {
    try {
      tick();
    } catch (e) {
      note('오류', e && e.stack ? e.stack : String(e));
    }
  }

  function destroyWindow() {
    const w = win;
    win = null;
    hwnd = 0;
    loaded = false;
    shown = false;
    if (w && !w.isDestroyed()) w.destroy();
  }

  function create() {
    ticks = 0;
    contentWidth = 0;
    lastNote = '';
    win = new BrowserWindow({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      show: false,
      frame: false,
      // 크기가 바뀌지 않는 작은 창이라 위젯 카드에서 겪은 투명창 모서리 틈 문제(v1.0.x)와 조건이 다르다 —
      // 작업표시줄 색에 맞춰 칠할 방법이 없어 투명으로 둔다
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      title: '',
      webPreferences: {
        preload: path.join(__dirname, 'strip-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    });
    const myWin = win;
    myWin.setAlwaysOnTop(true, 'screen-saver');
    hwnd = win32.hwndOf(myWin);
    // 오른쪽 클릭이 화면(렌더러)까지 안 가고 사라지는 판이 드물게 있다(12번 중 1번, 실측) — 창 메시지 단계에서도 센다
    if (typeof myWin.hookWindowMessage === 'function') {
      myWin.hookWindowMessage(0x0205, () => { hookRightUps += 1; }); // WM_RBUTTONUP
    }
    myWin.on('closed', () => {
      if (win === myWin) destroyWindow();
    });
    myWin.webContents.on('render-process-gone', (_e, details) => {
      log(`[strip] 렌더러 종료: ${details && details.reason}`);
      if (win !== myWin) return;
      destroyWindow();
      // 다시 뜰 때까지 메뉴를 열 곳이 없으면 안 되므로 트레이 아이콘부터 되살린다
      absentSince = 0;
      reportPresence(false);
      if (wantRunning) setTimeout(() => { if (wantRunning && !win) create(); }, 5000);
    });
    myWin.webContents.once('did-finish-load', () => {
      if (win !== myWin) return;
      loaded = true;
      lightTheme = win32.isTaskbarLight();
      pushModel();
      safeTick();
    });
    myWin.loadFile(path.join(__dirname, 'strip.html'));
  }

  const onDisplayChange = () => safeTick();

  const self = {
    available: () => win32.available(),
    isRunning: () => !!win,
    start() {
      wantRunning = true;
      if (!win32.available()) {
        log(`[strip] Win32 불러오기 실패: ${win32.lastLoadError()}`);
        reportPresence(false);
        return;
      }
      current = self;
      if (!win) {
        presence = null;
        absentSince = 0;
        create();
      }
      clearTimeout(decideTimer);
      decideTimer = setTimeout(() => {
        decideTimer = null;
        if (wantRunning && presence === null) {
          log('[strip] 5초 안에 글자 띠를 못 띄움 — 트레이 아이콘 되살림');
          reportPresence(false);
        }
      }, DECIDE_TIMEOUT_MS);
      if (!raiseTimer) {
        raiseTimer = setInterval(() => {
          if (!shown || raisePaused || !hwnd) return;
          try { win32.placeTopmost(hwnd, null); } catch (e) { note('오류', e && e.stack ? e.stack : String(e)); }
        }, RAISE_MS);
      }
      if (!timer) {
        timer = setInterval(safeTick, TICK_MS);
        screen.on('display-metrics-changed', onDisplayChange);
        screen.on('display-added', onDisplayChange);
        screen.on('display-removed', onDisplayChange);
      }
      log('[strip] 켜짐');
    },
    stop() {
      const wasRunning = !!win || !!timer;
      wantRunning = false;
      clearTimeout(decideTimer);
      decideTimer = null;
      if (raiseTimer) {
        clearInterval(raiseTimer);
        raiseTimer = null;
      }
      raisePaused = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
        screen.removeListener('display-metrics-changed', onDisplayChange);
        screen.removeListener('display-added', onDisplayChange);
        screen.removeListener('display-removed', onDisplayChange);
      }
      destroyWindow();
      if (current === self) current = null;
      absentSince = 0;
      if (wasRunning) log('[strip] 꺼짐');
      reportPresence(false);
    },
    update() {
      if (win) pushModel();
    },
    owns(sender) {
      return !!(win && !win.isDestroyed() && sender && sender.id === win.webContents.id);
    },
    setContentWidth(width) {
      const w = Math.ceil(Number(width));
      if (!Number.isFinite(w) || w <= 0) return;
      contentWidth = Math.min(w, MAX_WIDTH_CSS);
      safeTick();
    },
    handleClick() {
      try { onClick(); } catch (e) { log(`[strip] 클릭 처리 오류: ${e.message}`); }
    },
    handleContextMenu() {
      contextCount += 1;
      try { onContextMenu(); } catch (e) { log(`[strip] 메뉴 열기 오류: ${e.message}`); }
    },
    window: () => win,
    // 글자 띠에서 메뉴를 여는 동안 맨 위로 다시 올리기를 멈춘다(메뉴가 작업표시줄 높이까지 내려와 겹친다)
    setRaisePaused(paused) {
      raisePaused = !!paused;
    },
    // 검증 스크립트 전용
    debugState: () => ({ running: !!win, loaded, shown, contentWidth, lightTheme, lastNote, hwnd, presence, raisePaused, contextCount, hookRightUps }),
    // 검증 스크립트 전용: 작업표시줄 실측값 대신 넣은 값으로 판단하게 한다(null이면 다시 실측)
    debugSetTaskbarOverride(info) {
      taskbarOverride = info || null;
      safeTick();
    }
  };
  return self;
}

module.exports = { createStrip };
