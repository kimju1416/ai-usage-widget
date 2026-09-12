// 작업표시줄 글자 띠 순수 계산 검사. 실행: node tools/strip-test.js → STRIP_TEST_OK
const assert = require('assert');
const L = require('../strip-layout');

let count = 0;
function check(name, fn) {
  try {
    fn();
    count += 1;
  } catch (e) {
    console.error(`실패: ${name}\n${e.message}`);
    process.exit(1);
  }
}

check('단계 경계', () => {
  assert.strictEqual(L.levelOf(0), 'low');
  assert.strictEqual(L.levelOf(49), 'low');
  assert.strictEqual(L.levelOf(50), 'mid');
  assert.strictEqual(L.levelOf(79), 'mid');
  assert.strictEqual(L.levelOf(80), 'high');
  assert.strictEqual(L.levelOf(100), 'high');
  assert.strictEqual(L.levelOf(null), 'none');
  assert.strictEqual(L.levelOf(NaN), 'none');
  assert.strictEqual(L.levelOf('82'), 'none');
});

check('칸 내용', () => {
  assert.deepStrictEqual(L.cellFor(null, 'session'), { text: '…', level: 'none' });
  assert.deepStrictEqual(L.cellFor({ needsLogin: true }, 'session'), { text: '로그인', level: 'none' });
  assert.deepStrictEqual(L.cellFor({ ok: true, session: null }, 'session'), { text: '—', level: 'none' });
  assert.deepStrictEqual(L.cellFor({ ok: true, session: { pct: 82.4 } }, 'session'), { text: '82', level: 'high' });
  assert.deepStrictEqual(L.cellFor({ ok: true, weekly: { pct: 130 } }, 'weekly'), { text: '100', level: 'high' });
  assert.deepStrictEqual(L.cellFor({ ok: true, weekly: { pct: -5 } }, 'weekly'), { text: '0', level: 'low' });
  assert.deepStrictEqual(L.cellFor({ ok: true, weekly: { pct: null } }, 'weekly'), { text: '—', level: 'none' });
});

check('두 줄 모델 — Codex 월간 전용(5시간 없음)', () => {
  const lastData = {
    claude: { ok: true, session: { pct: 82 }, weekly: { pct: 91 } },
    codex: { ok: true, session: null, weekly: { pct: 40 } },
    gemini: null
  };
  const m = L.buildStripModel(lastData, [{ key: 'claude', label: 'Claude' }, { key: 'codex', label: 'Codex' }]);
  assert.strictEqual(m.rows.length, 2);
  assert.strictEqual(m.rows[0].label, '5시간');
  assert.strictEqual(m.rows[1].label, '주간');
  assert.deepStrictEqual(m.rows[0].cells, [
    { name: 'Claude', text: '82', level: 'high' },
    { name: 'Codex', text: '—', level: 'none' }
  ]);
  assert.deepStrictEqual(m.rows[1].cells, [
    { name: 'Claude', text: '91', level: 'high' },
    { name: 'Codex', text: '40', level: 'low' }
  ]);
  assert.deepStrictEqual(L.buildStripModel(null, null).rows[0].cells, []);
});

// 2026-09-13 이 PC 실측(배율 150%, 2560×1600): tools/probe-taskbar.js
const PC150 = {
  taskbar: { left: 0, top: 1528, right: 2560, bottom: 1600 },
  notify: { left: 2048, top: 1528, right: 2560, bottom: 1600 },
  rebar: { left: 83, top: 1528, right: 683, bottom: 1600 },
  monitor: { left: 0, top: 0, right: 2560, bottom: 1600 }
};

check('배치 — 150% 실측값', () => {
  const r = L.computeStripRect({ ...PC150, width: 200 * 1.5, gap: 4 * 1.5 });
  assert.deepStrictEqual(r, { visible: true, rect: { x: 1742, y: 1528, width: 300, height: 72 } });
  // 오른쪽 끝이 트레이 영역 왼쪽에서 간격만큼 떨어지고, 앱 아이콘 줄과 겹치지 않는다
  assert.strictEqual(r.rect.x + r.rect.width, PC150.notify.left - 6);
  assert.ok(r.rect.x >= PC150.rebar.right);
});

check('배치 — 100% 1920×1080', () => {
  const r = L.computeStripRect({
    taskbar: { left: 0, top: 1032, right: 1920, bottom: 1080 },
    notify: { left: 1500, top: 1032, right: 1920, bottom: 1080 },
    rebar: { left: 60, top: 1032, right: 900, bottom: 1080 },
    monitor: { left: 0, top: 0, right: 1920, bottom: 1080 },
    width: 199.4,
    gap: 4
  });
  assert.deepStrictEqual(r, { visible: true, rect: { x: 1296, y: 1032, width: 200, height: 48 } });
});

check('숨김 사유', () => {
  const reason = (patch) => L.computeStripRect({ ...PC150, width: 300, gap: 6, ...patch }).reason;
  assert.strictEqual(reason({ taskbar: { left: 0, top: 1598, right: 2560, bottom: 1670 } }), 'taskbar-hidden');
  assert.strictEqual(reason({ rebar: { left: 83, top: 1528, right: 1900, bottom: 1600 } }), 'no-room');
  assert.strictEqual(reason({ taskbar: { left: 0, top: 0, right: 2560, bottom: 72 } }), 'not-bottom');
  assert.strictEqual(reason({ taskbar: { left: 0, top: 0, right: 72, bottom: 1600 } }), 'not-horizontal');
  assert.strictEqual(reason({ notify: null }), 'no-taskbar');
  assert.strictEqual(reason({ taskbar: null }), 'no-taskbar');
  assert.strictEqual(reason({ width: 0 }), 'no-size');
  // 앱 아이콘 줄을 못 찾았으면 작업표시줄 왼쪽 끝까지만 본다
  assert.strictEqual(L.computeStripRect({ ...PC150, rebar: null, width: 300, gap: 6 }).visible, true);
  assert.strictEqual(reason({ rebar: null, width: 2100 }), 'no-room');
});

check('전체화면 판정', () => {
  for (const s of [2, 3, 4, 7]) assert.strictEqual(L.hideForNotificationState(s), true, `state ${s}`);
  for (const s of [1, 5, 6, null, undefined]) assert.strictEqual(L.hideForNotificationState(s), false, `state ${s}`);
});

check('실제 창 자리 비교', () => {
  const want = { x: 1742, y: 1528, width: 300, height: 72 };
  assert.strictEqual(L.sameRect({ left: 1742, top: 1528, right: 2042, bottom: 1600 }, want), true);
  assert.strictEqual(L.sameRect({ left: 1742, top: 1528, right: 2043, bottom: 1600 }, want), false);
  assert.strictEqual(L.sameRect(null, want), false);
});

check('트레이 아이콘 대신 여부', () => {
  assert.strictEqual(L.presenceForReason(null), 'present');
  assert.strictEqual(L.presenceForReason('fullscreen'), 'present');
  assert.strictEqual(L.presenceForReason('taskbar-hidden'), 'present');
  assert.strictEqual(L.presenceForReason('no-size'), 'pending');
  for (const r of ['no-room', 'not-bottom', 'not-horizontal', 'no-taskbar', '알 수 없는 사유']) {
    assert.strictEqual(L.presenceForReason(r), 'absent', r);
  }
});

console.log(`STRIP_TEST_OK (${count}묶음)`);
