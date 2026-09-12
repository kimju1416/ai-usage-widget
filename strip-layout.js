// 작업표시줄 글자 띠 — 순수 계산만 모은 파일.
// electron·koffi 없이 node만으로 검사할 수 있도록 창·Win32 코드와 떼어 둔다(tools/strip-test.js).

const ROWS = [
  { field: 'session', label: '5시간' },
  { field: 'weekly', label: '주간' }
];

// 위젯과 같은 기준: 쓴 비율이 높을수록 경고색
function levelOf(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'none';
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'mid';
  return 'low';
}

function cellFor(data, field) {
  if (!data) return { text: '…', level: 'none' };
  if (data.needsLogin) return { text: '로그인', level: 'none' };
  const metric = data[field];
  // 일부 플랜은 5시간 한도가 아예 없다(Codex 월간 전용 등) — 빈칸 대신 줄표
  if (!metric || typeof metric.pct !== 'number' || !Number.isFinite(metric.pct)) return { text: '—', level: 'none' };
  const pct = Math.max(0, Math.min(100, Math.round(metric.pct)));
  return { text: String(pct), level: levelOf(pct) };
}

// providers: [{ key, label }] — 켜 둔 서비스만, 표시 순서대로
function buildStripModel(lastData, providers) {
  const list = Array.isArray(providers) ? providers : [];
  return {
    rows: ROWS.map((row) => ({
      label: row.label,
      cells: list.map((p) => ({ name: p.label, ...cellFor(lastData ? lastData[p.key] : null, row.field) }))
    }))
  };
}

// 글자 띠를 놓을 자리. 좌표는 전부 물리 픽셀, monitor는 주 모니터 전체 영역.
// 트레이~시계 묶음(notify) 바로 왼쪽에 오른쪽 끝을 붙이고, 앱 아이콘 줄(rebar)과 겹치면 띄우지 않는다.
function computeStripRect({ taskbar, notify, rebar, monitor, width, gap }) {
  if (!taskbar || !notify || !monitor) return { visible: false, reason: 'no-taskbar' };
  if (!(width > 0)) return { visible: false, reason: 'no-size' };
  const tbWidth = taskbar.right - taskbar.left;
  const tbHeight = taskbar.bottom - taskbar.top;
  if (tbWidth <= 0 || tbHeight <= 0 || tbWidth < tbHeight) return { visible: false, reason: 'not-horizontal' };
  const monHeight = monitor.bottom - monitor.top;
  if (taskbar.top < monitor.top + monHeight / 2) return { visible: false, reason: 'not-bottom' };
  // 자동 숨김으로 내려가 있으면 화면에 걸친 높이가 몇 픽셀뿐이다
  const onScreen = Math.min(taskbar.bottom, monitor.bottom) - taskbar.top;
  if (onScreen < tbHeight * 0.9) return { visible: false, reason: 'taskbar-hidden' };
  const right = notify.left - Math.round(gap || 0);
  const left = right - Math.ceil(width);
  const hasRebar = rebar && rebar.right > rebar.left;
  const floor = Math.max(taskbar.left, hasRebar ? rebar.right : taskbar.left);
  if (left < floor) return { visible: false, reason: 'no-room' };
  return { visible: true, rect: { x: left, y: taskbar.top, width: right - left, height: tbHeight } };
}

// SHQueryUserNotificationState: 2 전체화면 앱, 3 D3D 전체화면(게임), 4 발표 모드, 7 스토어 앱 전체화면
// 이때 작업표시줄은 가려지는데 글자 띠만 영상·슬라이드 위에 남으면 안 된다.
const HIDE_STATES = new Set([2, 3, 4, 7]);
function hideForNotificationState(state) {
  return HIDE_STATES.has(state);
}

// 글자 띠가 트레이 아이콘 역할을 대신하고 있는지(reason: 숨은 사유, 떠 있으면 null)
// - present: 떠 있거나 잠깐 숨은 것(전체화면·작업표시줄 자동 숨김) — 이때는 작업표시줄 자체가 안 보여 아이콘도 쓸 수 없다
// - absent : 이 PC·상황에서 띄울 수 없음 — 아이콘까지 없으면 메뉴를 열 곳이 사라지므로 아이콘을 되살린다
// - pending: 아직 글자 폭을 못 잼(켠 직후)
const TRANSIENT_REASONS = new Set(['fullscreen', 'taskbar-hidden']);
function presenceForReason(reason) {
  if (!reason) return 'present';
  if (reason === 'no-size') return 'pending';
  return TRANSIENT_REASONS.has(reason) ? 'present' : 'absent';
}

function sameRect(actual, want) {
  return !!(actual && want &&
    actual.left === want.x &&
    actual.top === want.y &&
    actual.right - actual.left === want.width &&
    actual.bottom - actual.top === want.height);
}

module.exports = {
  ROWS,
  levelOf,
  cellFor,
  buildStripModel,
  computeStripRect,
  hideForNotificationState,
  presenceForReason,
  sameRect
};
