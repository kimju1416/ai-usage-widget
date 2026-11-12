// 글자 띠 마우스 올림 안내 창 — 초기화까지 남은 시간 계산 검사(node tools/hover-test.js)
const assert = require('assert');
const L = require('../strip-layout');
const now = new Date(2026, 10, 12, 15, 0); // 2026-11-12(목) 15:00
const cases = [
  ['3시간 12분 후 재설정', '3시간 12분', '오늘 18:12'],
  ['재설정: (목) 오후 9:00', '6시간', '오늘 21:00'],
  ['(토) 오전 9:00에 재설정', '1일 18시간', '14(토) 9:00'],
  ['5시간 0분 후 초기화', '5시간', '오늘 20:00'],
  ['2026. 11. 18. 오후 3:12', '6일', '18(수) 15:12'],
  ['Resets in 2 hr 5 min', '2시간 5분', '오늘 17:05'],
  ['Resets Sat 9:00 AM', '1일 18시간', '14(토) 9:00'],
  ['오후 4:30에 재설정', '1시간 30분', '오늘 16:30'],
  ['45분 후 재설정', '45분', '오늘 15:45'],
  ['-', '', ''],
  ['주간 사용 한도', '', ''],            // Codex 0%일 때 다음 줄 제목이 끼어드는 경우 — 숫자 없으면 비움
  ['이상한 글자 7', '', '이상한 글자 7']  // 못 읽으면 지어내지 않고 받은 글자 그대로
];
for (const [raw, left, at] of cases) assert.deepStrictEqual(L.resetInfo(raw, now, now), { left, at }, raw);
// 읽은 뒤 10분 지나면 상대 시간도 10분 줄어야 한다
assert.strictEqual(L.resetInfo('3시간 12분 후 재설정', now, new Date(now.getTime() + 600000)).left, '3시간 2분');
assert.strictEqual(L.formatLeft(0), '곧');
const m = L.buildHoverModel(
  { claude: { ok: true, session: { pct: 12, reset: '3시간 12분 후 재설정' }, weekly: null, _at: now.getTime() }, codex: { needsLogin: true } },
  [{ key: 'claude', label: 'Claude' }, { key: 'codex', label: 'Codex' }, { key: 'gemini', label: 'Gemini' }],
  { gemini: true }, now);
assert.strictEqual(m.services[0].rows.length, 1);
assert.strictEqual(m.services[1].note.startsWith('로그인'), true);
assert.strictEqual(m.services[2].note, '값을 읽지 못했어요');
console.log(`HOVER_TEST_OK (${cases.length + 5}가지)`);
