// Codex 사용량 읽기 검사 — main.js의 CODEX_EXTRACT_SCRIPT를 그대로 꺼내 화면 글자에 돌린다.
//   node tools/codex-extract-test.js            (이 저장소의 main.js)
//   node tools/codex-extract-test.js <파일.js>   (다른 파일의 CODEX_EXTRACT_SCRIPT — 예: TD2 main/aiusage.js)
// 2026-10 ChatGPT 설정 개편(라벨 «5시간 단위 한도»·초기화 줄이 퍼센트 앞)으로 Codex가 «…»에서 멈춘 사고의 재발 방지.
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'main.js');
const src = fs.readFileSync(file, 'utf-8');
const m = src.match(/const CODEX_EXTRACT_SCRIPT = `([\s\S]*?)`;\r?\n/);
if (!m) { console.error('CODEX_EXTRACT_SCRIPT를 못 찾았다: ' + file); process.exit(1); }
const script = new Function('return `' + m[1] + '`')();

function run(text) {
  global.document = { body: { innerText: text }, querySelector: () => null };
  return eval(script);
}

let fail = 0;
function ok(cond, name, detail) {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  → ' + detail));
  if (!cond) fail++;
}

// ① 예전 화면: 라벨 / N% / 남음 / 초기화 줄(퍼센트 뒤)
const OLD = ['사용량', '5시간 사용 한도', '69%', '남음', '4시간 2분 후 초기화', '주간 사용 한도', '88%', '남음', '9월 25일 초기화'].join('\n');
let r = run(OLD);
ok(r.ok && r.session.pct === 31 && r.weekly.pct === 12 && r.session.reset === '4시간 2분 후 초기화' && r.weekly.reset === '9월 25일 초기화',
  '예전 화면(퍼센트 뒤 초기화)', JSON.stringify(r));

// ② 예전 화면인데 5시간 0%라 초기화 줄이 없는 경우 — 다음 라벨을 초기화로 읽으면 안 된다(v1.0.24)
r = run(['5시간 사용 한도', '100%', '남음', '주간 사용 한도', '88%', '남음', '9월 25일 초기화'].join('\n'));
ok(r.ok && r.session.pct === 0 && r.session.reset === '' && r.weekly.reset === '9월 25일 초기화',
  '예전 화면(5시간 0%·초기화 줄 없음 → 빈칸)', JSON.stringify(r));

// ③ 새 화면(2026-10 실측 /settings/usage?tab=overview): 라벨 → 초기화 줄 → N% 남음, 그 뒤 크레딧·«사용 한도 초기화» 문구가 이어진다
const NEW = [
  '플랜 사용 한도', 'Codex, Work, 워크스페이스 에이전트, Excel용 ChatGPT에서 사용량을 공유합니다. Chat 대화는 포함되지 않습니다. 사용량을 늘리려면', '플랜을 업그레이드', '하세요.',
  '5시간 단위 한도', '초기화까지 5시간 0분 남았습니다', '100% 남음',
  '주간 사용 한도', '초기화까지 5일 6시간 남았습니다', '69% 남음',
  '크레딧', '사용 한도에 도달해도 Work와 Codex를 계속 사용하려면 크레딧을 구매하거나 자동 충전을 켜세요. 자세히 알아보세요.', '0크레딧 남음', '현재 잔액', '추가', '자동 충전',
  '사용 한도 초기화', '초기화를 사용해 5시간 한도나 주간 한도, 또는 두 한도를 모두 복원하세요', '사용 가능', '1', '내역', '전체 재설정(주간 + 5시간)', '10월 30일 만료', '초기화 사용'
].join('\n');
r = run(NEW);
ok(r.ok && r.session.pct === 0 && r.weekly.pct === 31, '새 화면(개요 탭) 5시간 0% · 주간 31%', JSON.stringify(r));
ok(r.session.reset === '5시간 0분 후 초기화' && r.weekly.reset === '5일 6시간 후 초기화', '새 화면 초기화 글자 «N 후 초기화»', JSON.stringify(r));

// ④ 새 화면에서 주간 초기화 줄이 빠져도 아래쪽 «사용 한도 초기화»·«초기화를 사용해 5시간…» 문구를 가져오면 안 된다
r = run(['5시간 단위 한도', '초기화까지 3시간 1분 남았습니다', '40% 남음', '주간 사용 한도', '69% 남음', '크레딧', '0크레딧 남음', '사용 한도 초기화', '초기화를 사용해 5시간 한도나 주간 한도를 복원하세요'].join('\n'));
ok(r.ok && r.session.reset === '3시간 1분 후 초기화' && r.weekly.pct === 31 && r.weekly.reset === '', '초기화 줄 없는 주간은 빈칸(아래 문구를 안 가져온다)', JSON.stringify(r));

// ⑤ 사용량 분석 탭(예전 주소가 넘어가던 곳) — «N% 남음»이 없으니 못 읽는 게 맞다
const ANALYTICS = ['사용 내역', '개요', '사용량 분석', '플랜 사용 내역', '기능별', '5시간 한도', '기간\t한도 사용률', '9월 30일 오후 11:38 ~ 10월 1일 오전 4:38', '\t14%', '작업', '13.9%', '더 보기', '주간 한도', '기간\t한도 사용률', '9월 26일 ~ 10월 3일', '\t25.8%', '9월 23일~26일', '\t100%'].join('\n');
r = run(ANALYTICS);
ok(!r.ok && !r.needsLogin && r.session === null && r.weekly === null, '사용량 분석 탭은 ok=false (값을 지어내지 않는다)', JSON.stringify(r));

// ⑥ 월간 한도 하나만 있는 플랜
r = run(['월간 사용 한도', '초기화까지 12일 3시간 남았습니다', '20% 남음'].join('\n'));
ok(r.ok && r.session === null && r.weekly && r.weekly.pct === 80, '월간 한도만 있는 플랜은 주간 자리에', JSON.stringify(r));

// ⑦ 영어 화면(실측 못 함 — 예전·새 두 배치를 모두 읽는지만 본다)
r = run(['5-hour usage limit', '80% remaining', 'Resets at 3:00 PM', 'Weekly usage limit', '55% remaining', 'Resets Oct 8'].join('\n'));
ok(r.ok && r.session.pct === 20 && r.weekly.pct === 45 && /3:00/.test(r.session.reset), '영어(퍼센트 뒤 초기화)', JSON.stringify(r));
r = run(['5-hour limit', 'Resets in 5 hours 0 minutes', '100% left', 'Weekly usage limit', 'Resets in 5 days', '69% left'].join('\n'));
ok(r.ok && r.session.pct === 0 && r.weekly.pct === 31 && /5 hours/.test(r.session.reset), '영어(퍼센트 앞 초기화)', JSON.stringify(r));

// ⑧ 로그인 화면
const LOGIN = '로그인 또는 회원가입\n이메일 주소\n계속';
r = run(LOGIN);
global.document.querySelector = () => null;
ok(!r.ok && r.needsLogin, '로그인 화면은 needsLogin', JSON.stringify(r));

// ⑨ 같은 글자를 두 번 돌려도 같다(전역 정규식 lastIndex 상태가 안 남는다)
ok(JSON.stringify(run(NEW)) === JSON.stringify(run(NEW)), '두 번 돌려도 같은 결과', '결과가 달라졌다');

console.log(fail ? `\n${fail}개 실패` : '\n전부 통과');
process.exit(fail ? 1 : 0);
