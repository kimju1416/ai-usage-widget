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

// failed: 값이 한 번도 안 들어온 채 읽기가 연달아 실패한 서비스 — «…»(곧 올 것) 대신 «확인 필요»
function cellFor(data, field, failed) {
  if (!data) return { text: failed ? '확인 필요' : '…', level: 'none' };
  if (data.needsLogin) return { text: '로그인', level: 'none' };
  const metric = data[field];
  // 일부 플랜은 5시간 한도가 아예 없다(Codex 월간 전용 등) — 빈칸 대신 줄표
  if (!metric || typeof metric.pct !== 'number' || !Number.isFinite(metric.pct)) return { text: '—', level: 'none' };
  const pct = Math.max(0, Math.min(100, Math.round(metric.pct)));
  return { text: String(pct), level: levelOf(pct) };
}

// providers: [{ key, label }] — 켜 둔 서비스만, 표시 순서대로
function buildStripModel(lastData, providers, failed) {
  const list = Array.isArray(providers) ? providers : [];
  return {
    rows: ROWS.map((row) => ({
      label: row.label,
      cells: list.map((p) => ({ name: p.label, ...cellFor(lastData ? lastData[p.key] : null, row.field, !!(failed && failed[p.key])) }))
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

// ── 마우스 올리면 뜨는 안내 창: 초기화까지 남은 시간 (v1.0.27) ──
// 서비스·플랜·언어마다 «2시간 13분 후 재설정» «(목) 오후 9:00» «2026. 11. 18. 오후 3:12» «Sep 27, 4:32 PM» 등 제각각이라
// 날짜·시각을 읽어 한 모양으로 쓴다(TD2 renderer/js/aiusage.js aiuParseWhen과 같은 규칙).
// 🔴 못 읽으면 지어내지 않고 받은 글자를 다듬어 그대로 쓴다. base = 그 글자를 읽어 온 시각(상대 시간 기준).
const WD = '일월화수목금토';
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const EWD = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseResetWhen(raw, base) {
  const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!t || t === '-' || !/\d/.test(t)) return null;
  const now = base instanceof Date ? base : new Date(base || Date.now());
  // ① 남은 시간(«2시간 13분 후» «3일 후» «in 2 hr 13 min»)
  const rd = t.match(/(\d+)\s*(?:일|days?\b)/i);
  const rh = t.match(/(\d+)\s*(?:시간|hrs?\b|hours?\b|h\b)/i);
  const rm = t.match(/(\d+)\s*(?:분|mins?\b|minutes?\b|m\b)/i);
  const relWord = /후|뒤|남음|남았|\bin\b|left|remaining/i.test(t);
  const hasDate = /\d{4}\s*[.\-/년]|\d{1,2}\s*월\s*\d{1,2}\s*일|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}/i.test(t);
  if ((rh || rm || (rd && relWord)) && !hasDate && !/\d{1,2}:\d{2}/.test(t)) {
    const ms = ((rd ? +rd[1] * 24 : 0) + (rh ? +rh[1] : 0)) * 3600e3 + (rm ? +rm[1] : 0) * 60e3;
    if (ms > 0) return { at: new Date(now.getTime() + ms), time: true };
  }
  // ② 날짜
  let y = null, mo = null, d = null, m;
  if ((m = t.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  if (mo === null && (m = t.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/))) { mo = +m[1]; d = +m[2]; }
  if (mo === null && (m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})\b/i))) { mo = MON[m[1].toLowerCase()]; d = +m[2]; }
  // ③ 시각(«오후 4:32» «4:32 PM» «16:32» «16시 32분»)
  let hh = null, mi = 0;
  if ((m = t.match(/(오전|오후)?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i))) {
    hh = +m[2]; mi = +m[3];
    const pm = m[1] === '오후' || /pm/i.test(m[4] || '');
    const am = m[1] === '오전' || /am/i.test(m[4] || '');
    if (pm && hh < 12) hh += 12;
    if (am && hh === 12) hh = 0;
  } else if ((m = t.match(/(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/))) {
    hh = +m[2]; mi = m[3] ? +m[3] : 0;
    if (m[1] === '오후' && hh < 12) hh += 12;
    if (m[1] === '오전' && hh === 12) hh = 0;
  }
  if (mo !== null) {
    if (y === null) { y = now.getFullYear(); if (new Date(y, mo - 1, d, 23, 59) < now) y++; } // 해가 없으면 앞으로 올 날
    return { at: new Date(y, mo - 1, d, hh === null ? 0 : hh, mi), time: hh !== null };
  }
  // ④ 요일만(«화요일 오후 6:00» «(목) 오후 9:00» «Tue 4:32 PM») — 앞으로 올 그 요일
  let wd = -1;
  if ((m = t.match(/([일월화수목금토])요일/)) || (m = t.match(/\(\s*([일월화수목금토])\s*\)/))) wd = WD.indexOf(m[1]);
  else if ((m = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i))) wd = EWD[m[1].toLowerCase()];
  if (wd >= 0) {
    const at = new Date(now);
    at.setHours(hh === null ? 0 : hh, mi, 0, 0);
    let add = (wd - now.getDay() + 7) % 7;
    if (add === 0 && at <= now) add = 7;
    at.setDate(at.getDate() + add);
    return { at, time: hh !== null };
  }
  // ⑤ 시각만(«오후 4:32») — 오늘 그 시각, 지났으면 내일
  if (hh !== null) {
    const at = new Date(now);
    at.setHours(hh, mi, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    return { at, time: true };
  }
  return null;
}

// 못 읽은 초기화 글자를 짧게 다듬기만 한다(숫자는 그대로)
function tidyReset(raw) {
  let t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!t || t === '-' || !/\d/.test(t)) return '';
  t = t.replace(/^(?:resets?|재설정|초기화)\s*(?:in|at|on)?\s*[:：]?\s*/i, '')
    .replace(/\s*(?:에|에서)?\s*(?:재설정|초기화)(?:됨|됩니다)?\.?$/, '')
    .trim();
  return t.length > 22 ? t.slice(0, 21) + '…' : t;
}

// 남은 시간 → «2시간 13분» «3일 4시간» «12분» «곧»
function formatLeft(ms) {
  if (!(ms > 0)) return '곧';
  const totalMin = Math.ceil(ms / 60000);
  const dd = Math.floor(totalMin / 1440);
  const hh = Math.floor((totalMin % 1440) / 60);
  const mm = totalMin % 60;
  if (dd) return `${dd}일${hh ? ' ' + hh + '시간' : ''}`;
  if (hh) return `${hh}시간${mm ? ' ' + mm + '분' : ''}`;
  return `${mm}분`;
}

// 초기화 시각 → 오늘이면 «16:30», 아니면 «15(토) 9:00», 시각이 없으면 «15(토)»
function formatAt(p, now) {
  const a = p.at;
  const sameDay = a.getFullYear() === now.getFullYear() && a.getMonth() === now.getMonth() && a.getDate() === now.getDate();
  const clock = `${a.getHours()}:${String(a.getMinutes()).padStart(2, '0')}`;
  if (!p.time) return `${a.getDate()}(${WD[a.getDay()]})`;
  return sameDay ? `오늘 ${clock}` : `${a.getDate()}(${WD[a.getDay()]}) ${clock}`;
}

// 한 칸: { left: '2시간 13분', at: '오늘 16:30' } · 못 읽으면 { left: '', at: '<받은 글자>' }
function resetInfo(raw, base, now) {
  now = now instanceof Date ? now : new Date(now || Date.now());
  const p = parseResetWhen(raw, base || now);
  if (!p) return { left: '', at: tidyReset(raw) };
  return { left: formatLeft(p.at.getTime() - now.getTime()), at: formatAt(p, now) };
}

// 안내 창 내용 — 서비스마다 5시간·주간 한 줄씩
function buildHoverModel(lastData, providers, failed, now) {
  const list = Array.isArray(providers) ? providers : [];
  now = now instanceof Date ? now : new Date(now || Date.now());
  return {
    services: list.map((p) => {
      const data = lastData ? lastData[p.key] : null;
      let note = '';
      if (!data) note = failed && failed[p.key] ? '값을 읽지 못했어요' : '불러오는 중';
      else if (data.needsLogin) note = '로그인이 필요해요 — 눌러서 로그인';
      const rows = [];
      if (!note) {
        for (const row of ROWS) {
          const metric = data[row.field];
          if (!metric || typeof metric.pct !== 'number' || !Number.isFinite(metric.pct)) continue;
          const pct = Math.max(0, Math.min(100, Math.round(metric.pct)));
          rows.push({ label: row.label, pct, level: levelOf(pct), ...resetInfo(metric.reset, data._at, now) });
        }
        if (!rows.length) note = '표시할 한도가 없어요';
      }
      return { name: p.label, note, rows };
    })
  };
}

module.exports = {
  parseResetWhen,
  tidyReset,
  formatLeft,
  resetInfo,
  buildHoverModel,
  ROWS,
  levelOf,
  cellFor,
  buildStripModel,
  computeStripRect,
  hideForNotificationState,
  presenceForReason,
  sameRect
};
