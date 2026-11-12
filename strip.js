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
ipcMain.on('strip-hover', (event, on) => {
  if (current && current.owns(event.sender)) current.handleHover(!!on);
});
ipcMain.on('strip-pop-size', (event, size) => {
  if (current && current.ownsPop(event.sender)) current.setPopSize(size);
});

const POP_TICK_MS = 250; // 안내 창이 떠 있는 동안 커서가 글자 띠를 벗어났는지 보는 간격
const POP_GAP = 6;       // 글자 띠 위로 띄울 간격(DIP)

function createStrip({ getModel, getHoverModel, onClick, onContextMenu, onPresenceChange, log }) {
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
  // 마우스 올림 안내 창(v1.0.27)
  let pop = null;
  let popLoaded = false;
  let popShown = false;
  let popSize = null;         // 안내 창 렌더러가 잰 내용 크기(DIP)
  let popTimer = null;
  let popTicks = 0;

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
    // 크기는 Electron에게만 맡긴다. 이 창은 Electron이 보이지 않는 테두리(실측 세로 16px)를 더 잡고 있어서,
    // SetWindowPos로 물리 크기를 작업표시줄 높이(48)에 억지로 맞추면 화면 안쪽이 32로 줄어
    // 글씨가 위쪽 32px 안에서만 가운데 정렬됐다(1.0.22 «위에 딱 붙음»). 그래서 비교도 Electron 안쪽 크기로 한다.
    const actual = win32.readRect(hwnd);
    const want = {
      x: Math.round(res.rect.x / scale),
      y: Math.round(res.rect.y / scale),
      width: Math.max(1, Math.round(res.rect.width / scale)),
      height: Math.max(1, Math.round(res.rect.height / scale))
    };
    const inner = win.getContentBounds();
    const placed = actual && actual.left === res.rect.x && actual.top === res.rect.y &&
      inner.width === want.width && inner.height === want.height;
    if (!placed) win.setBounds(want);
    if (!placed || !raisePaused) win32.placeTopmost(hwnd, null);
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

  // ── 마우스 올림 안내 창 ──
  function cursorOnStrip() {
    if (!win || win.isDestroyed() || !shown) return false;
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    return c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
  }

  function pushPop() {
    if (!pop || pop.isDestroyed() || !popLoaded || !getHoverModel) return;
    let model;
    try {
      model = getHoverModel();
    } catch (e) {
      log(`[strip] 안내 창 내용 만들기 오류: ${e.message}`);
      return;
    }
    pop.webContents.send('strip-pop-model', { ...model, light: lightTheme === true });
  }

  function placePop() {
    if (!pop || pop.isDestroyed() || !popSize || !win || win.isDestroyed()) return false;
    const sb = win.getBounds();
    const wa = screen.getDisplayMatching(sb).workArea;
    const w = Math.max(1, popSize.w);
    const h = Math.max(1, popSize.h);
    let x = sb.x + sb.width - w;                  // 오른쪽 끝을 글자 띠에 맞춘다
    x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - w - 4));
    const y = Math.max(wa.y, sb.y - h - POP_GAP); // 작업표시줄 바로 위
    pop.setBounds({ x, y, width: w, height: h });
    return true;
  }

  function hidePop() {
    if (popTimer) { clearInterval(popTimer); popTimer = null; }
    if (popShown && pop && !pop.isDestroyed()) pop.hide();
    popShown = false;
  }

  function destroyPop() {
    hidePop();
    const p = pop;
    pop = null;
    popLoaded = false;
    popSize = null;
    if (p && !p.isDestroyed()) p.destroy();
  }

  function createPop() {
    pop = new BrowserWindow({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: lightTheme ? '#f7f7f7' : '#202020',
      hasShadow: true,
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
    const myPop = pop;
    myPop.setAlwaysOnTop(true, 'screen-saver');
    myPop.setIgnoreMouseEvents(true); // 보기만 하는 창 — 커서가 올라가도 아래로 통과
    myPop.on('closed', () => { if (pop === myPop) { pop = null; popLoaded = false; popShown = false; popSize = null; } });
    myPop.webContents.on('render-process-gone', () => { if (pop === myPop) destroyPop(); });
    myPop.webContents.once('did-finish-load', () => {
      if (pop !== myPop) return;
      popLoaded = true;
      pushPop();
    });
    myPop.loadFile(path.join(__dirname, 'strip-pop.html'));
  }

  function showPop() {
    if (!getHoverModel || !shown || raisePaused) return;
    if (!pop || pop.isDestroyed()) createPop();
    else pushPop();
    if (!popTimer) {
      popTicks = 0;
      popTimer = setInterval(() => {
        try {
          if (!cursorOnStrip() || raisePaused) { hidePop(); return; }
          popTicks += 1;
          if (popTicks % 4 === 0) pushPop(); // 1초마다 남은 시간을 새로 센다
        } catch (e) {
          note('오류', e && e.stack ? e.stack : String(e));
          hidePop();
        }
      }, POP_TICK_MS);
    }
  }

  function destroyWindow() {
    destroyPop();
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
    handleHover(on) {
      try {
        if (on) showPop();
        else if (!cursorOnStrip()) hidePop();
      } catch (e) { log(`[strip] 안내 창 오류: ${e.message}`); }
    },
    ownsPop(sender) {
      return !!(pop && !pop.isDestroyed() && sender && sender.id === pop.webContents.id);
    },
    setPopSize(size) {
      const w = Math.ceil(Number(size && size.w));
      const h = Math.ceil(Number(size && size.h));
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
      popSize = { w: Math.min(w, 520), h: Math.min(h, 600) };
      if (!popTimer) return;       // 그새 커서가 떠났으면 띄우지 않는다
      if (placePop() && !popShown) {
        pop.showInactive();
        popShown = true;
      }
    },
    handleContextMenu() {
      hidePop();
      contextCount += 1;
      try { onContextMenu(); } catch (e) { log(`[strip] 메뉴 열기 오류: ${e.message}`); }
    },
    window: () => win,
    // 글자 띠에서 메뉴를 여는 동안 맨 위로 다시 올리기를 멈춘다(메뉴가 작업표시줄 높이까지 내려와 겹친다)
    setRaisePaused(paused) {
      raisePaused = !!paused;
    },
    // 검증 스크립트 전용
    debugState: () => ({ running: !!win, loaded, shown, contentWidth, lightTheme, lastNote, hwnd, presence, raisePaused, contextCount, hookRightUps, popShown, popSize }),
    // 검증 스크립트 전용: 마우스 올림을 흉내 낸다
    debugHover: (on) => self.handleHover(on),
    // 검증 스크립트 전용: 작업표시줄 실측값 대신 넣은 값으로 판단하게 한다(null이면 다시 실측)
    debugSetTaskbarOverride(info) {
      taskbarOverride = info || null;
      safeTick();
    }
  };
  return self;
}

module.exports = { createStrip };
