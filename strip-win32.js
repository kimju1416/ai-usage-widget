// 작업표시줄 글자 띠에 쓰는 Win32 호출(koffi).
// - 작업표시줄·트레이 영역 자리 재기, 전체화면 여부, 작업표시줄 밝기 테마, 글자 띠 창을 맨 위로 유지
// 불러오기에 실패하면(koffi 누락, Windows가 아님 등) available()이 false가 되고 글자 띠만 못 쓴다 — 위젯 본체와는 무관하다.
// 여기서 부르는 함수는 전부 다른 프로세스에 메시지를 보내지 않는다(탐색기가 멈춰도 우리 앱이 같이 멈추지 않게).

let api = null;
let loadError = null;

function load() {
  if (api || loadError) return api;
  if (process.platform !== 'win32') {
    loadError = new Error('Windows 전용 기능');
    return null;
  }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const shell32 = koffi.load('shell32.dll');
    const advapi32 = koffi.load('advapi32.dll');
    api = {
      FindWindowW: user32.func('intptr __stdcall FindWindowW(str16, str16)'),
      FindWindowExW: user32.func('intptr __stdcall FindWindowExW(intptr, intptr, str16, str16)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr, _Out_ void*)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr, intptr, int, int, int, int, uint)'),
      SHQueryUserNotificationState: shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int*)'),
      RegGetValueW: advapi32.func('long __stdcall RegGetValueW(intptr, str16, str16, uint, void*, _Out_ void*, _Inout_ uint*)')
    };
  } catch (e) {
    loadError = e;
    api = null;
  }
  return api;
}

function available() {
  return !!load();
}

function lastLoadError() {
  return loadError ? String(loadError.message || loadError) : '';
}

function readRect(hwnd) {
  const a = load();
  if (!a || !hwnd) return null;
  const buf = Buffer.alloc(16);
  if (!a.GetWindowRect(hwnd, buf)) return null;
  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12)
  };
}

// 주 작업표시줄(Shell_TrayWnd)과 그 안의 트레이~시계 묶음(TrayNotifyWnd), 앱 아이콘 줄(ReBarWindow32) 자리 — 전부 물리 픽셀
function getTaskbarInfo() {
  const a = load();
  if (!a) return null;
  const tray = a.FindWindowW('Shell_TrayWnd', null);
  if (!tray) return null;
  const notify = a.FindWindowExW(tray, 0, 'TrayNotifyWnd', null);
  const rebar = a.FindWindowExW(tray, 0, 'ReBarWindow32', null);
  return {
    taskbar: readRect(tray),
    notify: notify ? readRect(notify) : null,
    rebar: rebar ? readRect(rebar) : null
  };
}

// 전체화면 앱·발표 모드 등을 알려주는 값(QUERY_USER_NOTIFICATION_STATE). 실패하면 null
function getNotificationState() {
  const a = load();
  if (!a) return null;
  const out = [0];
  const hr = a.SHQueryUserNotificationState(out);
  return hr === 0 ? out[0] : null;
}

// (HKEY)(LONG)0x80000001 — 64비트에서는 부호 확장된 값이어야 한다
const HKEY_CURRENT_USER = -2147483647;
const RRF_RT_REG_DWORD = 0x10;

// 작업표시줄이 밝은 테마인지(설정 → 개인 설정 → 색 → «기본 Windows 모드»). 값이 없거나 못 읽으면 null
function isTaskbarLight() {
  const a = load();
  if (!a) return null;
  const data = Buffer.alloc(4);
  const size = [4];
  const rc = a.RegGetValueW(
    HKEY_CURRENT_USER,
    'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
    'SystemUsesLightTheme',
    RRF_RT_REG_DWORD,
    null,
    data,
    size
  );
  if (rc !== 0) return null;
  return data.readUInt32LE(0) === 1;
}

const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;

// 작업표시줄을 누르면 작업표시줄이 맨 위 무리의 꼭대기로 올라와 글자 띠를 덮는다 — 주기적으로 다시 올린다.
// rect를 주면 자리·크기도 물리 픽셀 그대로 맞춘다(배율 환산을 거치지 않아 어긋날 여지가 없다).
function placeTopmost(hwnd, rect) {
  const a = load();
  if (!a || !hwnd) return false;
  if (rect) {
    return a.SetWindowPos(hwnd, HWND_TOPMOST, rect.x, rect.y, rect.width, rect.height, SWP_NOACTIVATE);
  }
  return a.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

module.exports = {
  load,
  available,
  lastLoadError,
  readRect,
  getTaskbarInfo,
  getNotificationState,
  isTaskbarLight,
  placeTopmost,
  hwndOf
};
