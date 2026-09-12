// 작업표시줄 글자 띠 실검증 — main.js를 그대로 태워 실제 작업표시줄 위에서 확인한다.
// 실행: npx electron tools/strip-verify.js --user-data-dir=<임시 폴더>
// 결과: tools/_strip-verify.json, 캡처: tools/_strip-shot-*.png
// ⚠ 반드시 임시 userData로 돌린다 — 설치된 위젯의 로그인·설정과 섞이지 않고, 단일 인스턴스 잠금도 따로 잡힌다.
// ⚠ 전체화면 검사에서 검은 화면이 몇 초 뜨고, 메뉴 검사에서 마우스가 잠깐 움직인다(끝나면 제자리로 돌려놓는다).
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

if (!process.argv.some((a) => a.startsWith('--user-data-dir='))) {
  console.error('--user-data-dir=<임시 폴더> 를 꼭 주세요');
  process.exit(2);
}

const userData = app.getPath('userData');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'widget-state.json'), JSON.stringify({
  mode: 'widget', taskbarStrip: true, show_claude: true, show_codex: true, show_gemini: true, x: 40, y: 40
}));

const V = require('../main.js').__verify;
const win32 = require('../strip-win32');
const layout = require('../strip-layout');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const U = {
  GetWindow: user32.func('intptr __stdcall GetWindow(intptr, uint)'),
  FindWindowW: user32.func('intptr __stdcall FindWindowW(str16, str16)'),
  FindWindowExW: user32.func('intptr __stdcall FindWindowExW(intptr, intptr, str16, str16)'),
  SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr, intptr, int, int, int, int, uint)'),
  GetWindowThreadProcessId: user32.func('uint __stdcall GetWindowThreadProcessId(intptr, _Out_ uint*)'),
  IsWindow: user32.func('bool __stdcall IsWindow(intptr)'),
  IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr)'),
  GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr, _Out_ void*, int)'),
  SetCursorPos: user32.func('bool __stdcall SetCursorPos(int, int)'),
  GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ void*)'),
  mouse_event: user32.func('void __stdcall mouse_event(uint, uint, uint, uint, uintptr)'),
  keybd_event: user32.func('void __stdcall keybd_event(uint8, uint8, uint, uintptr)'),
  WindowFromPoint: user32.func('intptr __stdcall WindowFromPoint(int64)'),
  GetAncestor: user32.func('intptr __stdcall GetAncestor(intptr, uint)')
};

function classOf(h) {
  const buf = Buffer.alloc(512);
  const len = h ? U.GetClassNameW(h, buf, 256) : 0;
  return buf.toString('utf16le', 0, len * 2);
}

const OUT = path.join(__dirname, '_strip-verify.json');
const result = { userData, checks: [], errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(name, ok, detail) {
  result.checks.push({ name, ok: !!ok, detail });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
}

async function waitFor(fn, ms, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

const findWin = (file) => BrowserWindow.getAllWindows()
  .find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith(file));

async function shot(name, rect) {
  const d = screen.getPrimaryDisplay();
  const s = d.scaleFactor;
  const size = { width: Math.round(d.bounds.width * s), height: Math.round(d.bounds.height * s) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((x) => String(x.display_id) === String(d.id)) || sources[0];
  fs.writeFileSync(path.join(__dirname, name), src.thumbnail.crop(rect).toPNG());
}

// 우리 프로세스의 보이는 최상위 창 — 메뉴가 열리면 새 창이 하나 생긴다
function myVisibleWindows() {
  const list = [];
  let h = 0;
  for (let n = 0; n < 20000; n++) {
    h = U.FindWindowExW(0, h, null, null);
    if (!h) break;
    const pid = [0];
    U.GetWindowThreadProcessId(h, pid);
    if (pid[0] !== process.pid || !U.IsWindowVisible(h)) continue;
    const buf = Buffer.alloc(512);
    const len = U.GetClassNameW(h, buf, 256);
    list.push({ hwnd: h, cls: buf.toString('utf16le', 0, len * 2), rect: win32.readRect(h) });
  }
  return list;
}

// 누르는 바로 그 순간 커서 아래 최상위 창을 돌려준다(툴팁 등 끼어든 창을 가려내려고)
async function clickAt(x, y, button) {
  U.SetCursorPos(x, y);
  await sleep(150);
  const under = U.GetAncestor(U.WindowFromPoint(x + y * 4294967296), 2);
  const [down, up] = button === 'right' ? [0x0008, 0x0010] : [0x0002, 0x0004];
  U.mouse_event(down, 0, 0, 0, 0);
  await sleep(60);
  U.mouse_event(up, 0, 0, 0, 0);
  return { hwnd: under, cls: classOf(under) };
}

// a가 b보다 위에 있는지: b에서 위로 올라가다 a를 만나면 true
function isAbove(a, b) {
  let h = U.GetWindow(b, 3);
  for (let n = 0; h && n < 5000; n++) {
    if (h === a) return true;
    h = U.GetWindow(h, 3);
  }
  return false;
}

const FAKE_ROWS = [
  { label: '5시간', cells: [
    { name: 'Claude', text: '82', level: 'high' },
    { name: 'Codex', text: '—', level: 'none' },
    { name: 'Gemini', text: '12', level: 'low' }
  ] },
  { label: '주간', cells: [
    { name: 'Claude', text: '91', level: 'high' },
    { name: 'Codex', text: '40', level: 'low' },
    { name: 'Gemini', text: '55', level: 'mid' }
  ] }
];

function placement(win) {
  return { info: win32.getTaskbarInfo(), r: win32.readRect(win32.hwndOf(win)) };
}

app.whenReady().then(async () => {
  const cursor = Buffer.alloc(8);
  U.GetCursorPos(cursor);
  try {
    const scale = screen.getPrimaryDisplay().scaleFactor;
    const gap = Math.round(4 * scale);

    // 시작 직후: 글자 띠가 뜰 때까지 트레이 아이콘이 한 번도 안 떠야 한다(떴다 사라지는 깜빡임 없음)
    let traySeenAtStartup = false;
    const stripWin = await waitFor(() => {
      if (V.hasTray()) traySeenAtStartup = true;
      const w = findWin('strip.html');
      return w && w.isVisible() ? w : null;
    }, 10000, 50);
    record('글자 띠 창 생성·작업표시줄 위에 보임', stripWin);
    if (!stripWin) return;
    stripWin.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) result.errors.push(`strip console: ${message}`);
    });
    record('시작할 때 트레이 아이콘이 떴다 사라지지 않음', !traySeenAtStartup && !V.hasTray(), { traySeenAtStartup });

    const dom = async (w = stripWin) => JSON.parse(await w.webContents.executeJavaScript(`JSON.stringify({
      text: document.getElementById('strip').innerText,
      light: document.body.classList.contains('light'),
      rows: document.querySelectorAll('#strip .lbl').length,
      width: Math.ceil(document.getElementById('strip').getBoundingClientRect().width),
      highColor: (document.querySelector('.v.high') ? getComputedStyle(document.querySelector('.v.high')).color : null)
    })`));

    const first = await dom();
    record('처음 내용: 두 줄·서비스 3개', first.rows === 2 && /Claude/.test(first.text) && /Codex/.test(first.text) && /Gemini/.test(first.text), first);
    record('작업표시줄 밝기 테마 따라감', first.light === (win32.isTaskbarLight() === true), { dom: first.light, reg: win32.isTaskbarLight() });

    // 트레이 영역 폭이 바뀌면(아이콘 추가·제거) 글자 띠는 1초 틱마다 따라가므로 한 번만 재지 않고 기다린다
    const placedOk = (q, cssWidth) => q.r && q.info && q.r.right === q.info.notify.left - gap && q.r.top === q.info.taskbar.top &&
      q.r.bottom === q.info.taskbar.bottom && q.r.left >= q.info.rebar.right &&
      q.r.right - q.r.left === Math.ceil(cssWidth * scale);
    let p = placement(stripWin);
    await waitFor(() => { p = placement(stripWin); return placedOk(p, first.width); }, 3000, 250);
    record('자리: 트레이 영역 왼쪽에 붙음·높이 같음·아이콘 줄과 안 겹침', placedOk(p, first.width),
      { rect: p.r, info: p.info, cssWidth: first.width, scale });
    const tbH = p.info.taskbar.bottom - p.info.taskbar.top;
    const shotRect = (r) => ({ x: Math.max(0, r.left - 240), y: p.info.taskbar.top, width: p.info.taskbar.right - Math.max(0, r.left - 240), height: tbH });
    await shot('_strip-shot-initial.png', shotRect(p.r));

    // 값이 다 찬 상태(색 3단계·월간 전용 줄표)
    const light = win32.isTaskbarLight() === true;
    stripWin.webContents.send('strip-model', { rows: FAKE_ROWS, tooltip: '검사', light });
    await sleep(300);
    const filled = await dom();
    await waitFor(() => { p = placement(stripWin); return placedOk(p, filled.width); }, 3000, 250);
    record('값이 바뀌면 폭을 다시 맞춤(오른쪽 끝 고정)', placedOk(p, filled.width),
      { rect: p.r, cssWidth: filled.width, text: filled.text, highColor: filled.highColor });
    await shot('_strip-shot-values.png', shotRect(p.r));

    stripWin.webContents.send('strip-model', { rows: FAKE_ROWS, tooltip: '검사', light: !light });
    await sleep(600);
    const flipped = await dom();
    record('반대 테마 색 적용', flipped.light === !light && flipped.highColor !== filled.highColor, { highColor: flipped.highColor });
    stripWin.webContents.send('strip-model', { rows: FAKE_ROWS, tooltip: '검사', light });
    await sleep(600);

    // 왼쪽 클릭 = 예전 트레이 아이콘 클릭(위젯 카드 켜고 끄기)
    const widgetWin = findWin('widget.html');
    if (widgetWin) {
      const before = widgetWin.isVisible();
      await stripWin.webContents.executeJavaScript('window.stripAPI.click(); 1');
      await sleep(600);
      const after = widgetWin.isVisible();
      record('왼쪽 클릭으로 위젯 카드 토글', after !== before, { before, after });
      await stripWin.webContents.executeJavaScript('window.stripAPI.click(); 1');
      await sleep(400);
    } else {
      record('왼쪽 클릭으로 위젯 카드 토글', false, '위젯 창을 못 찾음');
    }

    // 트레이 아이콘이 없으니 메뉴는 글자 띠 오른쪽 클릭으로만 열린다 — 진짜 마우스 입력으로 여러 번 확인한다.
    // (한 번은 닫히고 한 번은 안 닫힌 적이 있어 반복한다. 바깥 클릭은 메뉴가 뜨자마자·잠시 뒤 모두 본다)
    // --no-mouse: 실제 위젯이 켜져 있을 때 쓴다 — 두 글자 띠가 같은 자리에 겹쳐 클릭이 실제 위젯으로 갈 수 있다
    if (process.argv.includes('--no-mouse')) {
      record('글자 띠가 떠 있으면 트레이 아이콘 없음', !V.hasTray());
    } else {
      record('글자 띠가 떠 있으면 트레이 아이콘 없음', !V.hasTray());
      const rounds = [];
      const taskbarHwnd = U.FindWindowW('Shell_TrayWnd', null);
      // 글자 띠 화면이 실제로 받은 마우스 이벤트 수 — 검사 스크립트가 직접 심는다(앱 코드는 그대로)
      await stripWin.webContents.executeJavaScript(`window.__dbg = { down: 0, up: 0, ctx: 0 };
        addEventListener('mousedown', () => { window.__dbg.down++; }, true);
        addEventListener('mouseup', () => { window.__dbg.up++; }, true);
        addEventListener('contextmenu', () => { window.__dbg.ctx++; }, true);
        1`);
      const dbg = async () => JSON.parse(await stripWin.webContents.executeJavaScript('JSON.stringify(window.__dbg)'));
      // 0.25초 다시 올리기를 켠 판·멈춘 판을 번갈아 — 창 순서 바꾸기가 오른쪽 클릭을 끊는지 한 번에 가른다
      const half = [
        { delay: 0, pause: false }, { delay: 800, pause: true }, { delay: 1500, pause: false },
        { delay: 0, pause: true }, { delay: 800, pause: false }, { delay: 1500, pause: true }
      ];
      const plan = [...half, ...half]; // 드물게(12번 중 1번꼴) 나는 실패를 잡으려고 12판
      for (const { delay, pause } of plan) {
        V.strip().setRaisePaused(pause);
        const ctxBefore = V.strip().debugState().contextCount;
        const hookBefore = V.strip().debugState().hookRightUps;
        p = placement(stripWin);
        const stripHwnd = win32.hwndOf(stripWin);
        const before = new Set(myVisibleWindows().map((w) => w.hwnd));
        const midY = Math.round((p.r.top + p.r.bottom) / 2);
        // 앞 판에서 작업표시줄을 누른 지 약 0.55초 뒤다 — 이때 글자 띠가 덮여 있으면 오른쪽 클릭이 작업표시줄로 간다
        const cx = Math.round((p.r.left + p.r.right) / 2);
        U.SetCursorPos(cx, midY);
        const coveredBeforeRightClick = isAbove(taskbarHwnd, stripHwnd);
        // 클릭 순간 커서 아래 창이 글자 띠인지(아니면 어느 창인지)
        const under = U.GetAncestor(U.WindowFromPoint(cx + midY * 4294967296), 2);
        const underWhat = under === stripHwnd ? '글자 띠' : `${classOf(under)}(${under === taskbarHwnd ? '작업표시줄' : '다른 창'})`;
        const ev0 = await dbg();
        const downOn = await clickAt(cx, midY, 'right');
        const downWhat = downOn.hwnd === stripHwnd ? '글자 띠' : downOn.cls;
        const opened = await waitFor(() => {
          const fresh = myVisibleWindows().filter((w) => !before.has(w.hwnd));
          return fresh.length ? fresh : null;
        }, 3000, 100);
        const ev1 = await dbg();
        const events = `down${ev1.down - ev0.down}/up${ev1.up - ev0.up}/ctx${ev1.ctx - ev0.ctx}`;
        await sleep(delay);
        // 메뉴가 떠 있는 동안 글자 띠를 다시 올려 메뉴 아랫부분을 가리면 안 된다
        const menuOnTop = opened ? isAbove(opened[0].hwnd, stripHwnd) : null;
        const pausedAtCheck = V.strip().debugState().raisePaused;
        // 앱 아이콘 줄 바로 오른쪽 빈 작업표시줄 — 메뉴·글자 띠와 겹치지 않는 자리
        const outX = p.info.rebar.right + 40;
        const menuRect = opened ? opened[0].rect : null;
        const outsideMenu = !menuRect || outX < menuRect.left || outX > menuRect.right || midY < menuRect.top || midY > menuRect.bottom;
        await clickAt(outX, midY, 'left');
        const closed = opened
          ? !!(await waitFor(() => opened.every((w) => !U.IsWindow(w.hwnd) || !U.IsWindowVisible(w.hwnd)), 3000, 100))
          : false;
        rounds.push({
          delay, pause, coveredBeforeRightClick, underWhat, downWhat, events, pausedAtCheck,
          openedClasses: opened ? opened.map((w) => `${w.cls} ${w.rect ? (w.rect.right - w.rect.left) + 'x' + (w.rect.bottom - w.rect.top) : ''}`) : [],
          reachedMain: V.strip().debugState().contextCount - ctxBefore,
          hookRightUps: V.strip().debugState().hookRightUps - hookBefore,
          opened: !!opened, menuOnTop, closed, outsideMenu, outX, menuRect
        });
        if (opened && !closed) {
          U.keybd_event(0x1B, 0, 0, 0);
          U.keybd_event(0x1B, 0, 2, 0);
          await sleep(500);
        }
        await sleep(400);
      }
      V.strip().setRaisePaused(false);
      U.SetCursorPos(cursor.readInt32LE(0), cursor.readInt32LE(4));
      record('글자 띠 오른쪽 클릭으로 메뉴 열림(실제 마우스 12번)', rounds.every((r) => r.opened), rounds);
      record('바깥을 누르면 메뉴 닫힘(12번)', rounds.every((r) => r.closed && r.outsideMenu), rounds);
      record('메뉴가 떠 있는 동안 글자 띠에 가려지지 않음', rounds.every((r) => r.menuOnTop !== false), rounds.map((r) => r.menuOnTop));
      record('작업표시줄을 누른 직후에도 글자 띠가 덮여 있지 않음', rounds.every((r) => !r.coveredBeforeRightClick), rounds.map((r) => r.coveredBeforeRightClick));
    }

    // 작업표시줄을 누르면 작업표시줄이 맨 위 무리 꼭대기로 올라와 글자 띠를 덮는다 — 1초 안에 다시 올라와야 한다
    {
      const taskbar = U.FindWindowW('Shell_TrayWnd', null);
      const stripHwnd = win32.hwndOf(stripWin);
      U.SetWindowPos(taskbar, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
      const covered = isAbove(taskbar, stripHwnd);
      await sleep(1500);
      record('작업표시줄이 위로 올라와도 1.5초 안에 글자 띠가 다시 위', covered && isAbove(stripHwnd, taskbar), { coveredRightAfter: covered });
    }

    // 전체화면 앱이 뜨면 숨고, 닫히면 돌아온다 — 잠깐 숨는 동안 트레이 아이콘은 돌아오지 않는다
    {
      const full = new BrowserWindow({ show: false, fullscreen: true, backgroundColor: '#000000' });
      await full.loadURL('data:text/html,<body style="background:#000"></body>');
      full.show();
      full.setAlwaysOnTop(true);
      full.focus();
      full.setAlwaysOnTop(false);
      const state = await waitFor(() => {
        const s = win32.getNotificationState();
        return layout.hideForNotificationState(s) ? s : null;
      }, 5000);
      record('전체화면 감지', state, { state, now: win32.getNotificationState() });
      record('전체화면일 때 숨음', await waitFor(() => !stripWin.isVisible(), 4000));
      await sleep(6500); // 트레이 아이콘을 되살리는 기준(5초)보다 오래 기다린다
      record('전체화면으로 6초 넘게 숨어도 트레이 아이콘은 안 돌아옴', !V.hasTray() && !stripWin.isVisible());
      full.destroy();
      record('전체화면이 닫히면 다시 보임', await waitFor(() => stripWin.isVisible(), 5000));
    }

    // 자리가 모자라 글자 띠를 못 띄우면 트레이 아이콘이 돌아오고, 자리가 나면 다시 빠진다
    {
      const s = V.strip();
      const real = win32.getTaskbarInfo();
      const t0 = Date.now();
      s.debugSetTaskbarOverride({ ...real, rebar: { ...real.rebar, right: real.notify.left - 5 } });
      const back = await waitFor(() => V.hasTray() && !stripWin.isVisible(), 9000, 100);
      const elapsed = Date.now() - t0;
      record('자리가 모자라면 글자 띠 숨고 트레이 아이콘 돌아옴', back, { hasTray: V.hasTray(), visible: stripWin.isVisible(), elapsed });
      // 순간적인 끊김에 아이콘이 들락날락하지 않도록 5초는 기다린 뒤에 돌아와야 한다(틱 횟수로 세던 때는 3.9초)
      record('트레이 아이콘은 5초 기다린 뒤에 돌아옴', back && elapsed >= 4900, { elapsed });
      s.debugSetTaskbarOverride(null);
      const again = await waitFor(() => stripWin.isVisible() && !V.hasTray(), 6000);
      record('자리가 다시 나면 글자 띠 뜨고 트레이 아이콘 빠짐', again, { hasTray: V.hasTray(), visible: stripWin.isVisible() });
    }

    // 메뉴로 끄고 켜기
    {
      V.applyTaskbarStrip(false);
      record('글자 띠 끄면 창 없어지고 트레이 아이콘 돌아옴', await waitFor(() => V.hasTray() && !findWin('strip.html'), 3000));
      V.applyTaskbarStrip(true);
      const w2 = await waitFor(() => {
        const w = findWin('strip.html');
        return w && w.isVisible() ? w : null;
      }, 8000);
      record('다시 켜면 글자 띠 뜨고 트레이 아이콘 빠짐', w2 && await waitFor(() => !V.hasTray(), 3000), { hasTray: V.hasTray() });
    }
  } catch (e) {
    result.errors.push(e && e.stack ? e.stack : String(e));
  } finally {
    U.SetCursorPos(cursor.readInt32LE(0), cursor.readInt32LE(4));
    result.pass = result.checks.every((c) => c.ok) && result.errors.length === 0;
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    app.quit();
  }
});
