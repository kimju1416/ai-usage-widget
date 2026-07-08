// 앱 아이콘(icon.ico)과 트레이 아이콘(tray.png)을 순수 Node로 생성
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0;
  entry[1] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}


function pngFromPixels(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// widget.html 상단의 별(별표) 아이콘 — 크림색 둥근 사각형 배경 + 주황색 8방향 별표를 트레이 크기로 래스터화한다.
const STAR_BG = [238, 236, 225]; // #EEECE1
const STAR_COLOR = [217, 119, 87]; // #D97757
const STAR_LINES = [
  [12, 3, 12, 21],
  [3, 12, 21, 12],
  [5.8, 5.8, 18.2, 18.2],
  [5.8, 18.2, 18.2, 5.8]
];
const STAR_STROKE_W = 2.6;

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx, projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

function makeStarTrayPng(size) {
  const px = Buffer.alloc(size * size * 4);
  const margin = size * 0.06;
  const scale = (size - margin * 2) / 24;
  const offset = margin;
  const cornerR = size * 0.16;

  function inRoundedSquare(x, y) {
    const rx = Math.max(cornerR, Math.min(x, size - 1 - cornerR));
    const ry = Math.max(cornerR, Math.min(y, size - 1 - cornerR));
    const dx = x - rx, dy = y - ry;
    return dx * dx + dy * dy <= cornerR * cornerR;
  }

  for (let py = 0; py < size; py++) {
    for (let px_ = 0; px_ < size; px_++) {
      const i = (py * size + px_) * 4;
      if (!inRoundedSquare(px_, py)) { px[i + 3] = 0; continue; }

      const sx = (px_ + 0.5 - offset) / scale;
      const sy = (py + 0.5 - offset) / scale;
      const halfStroke = STAR_STROKE_W / 2;
      let onStar = false;
      for (const [x1, y1, x2, y2] of STAR_LINES) {
        if (distToSegment(sx, sy, x1, y1, x2, y2) <= halfStroke) { onStar = true; break; }
      }

      if (onStar) {
        px[i] = STAR_COLOR[0]; px[i + 1] = STAR_COLOR[1]; px[i + 2] = STAR_COLOR[2]; px[i + 3] = 255;
      } else {
        px[i] = STAR_BG[0]; px[i + 1] = STAR_BG[1]; px[i + 2] = STAR_BG[2]; px[i + 3] = 255;
      }
    }
  }

  return pngFromPixels(size, px);
}

// Codex 아이콘 — 파란 그라데이션 뭉게구름(울퉁불퉁한) 배경 + 흰색 ">_" 터미널 글리프
const CODEX_TOP = [124, 140, 255]; // 밝은 하늘색-보라
const CODEX_BOTTOM = [70, 60, 210]; // 짙은 남보라
const CODEX_GLYPH_LINES = [
  [7.5, 7.5, 12.5, 12.5],
  [12.5, 12.5, 7.5, 17.5],
  [13.5, 17.5, 19, 17.5]
];
const CODEX_STROKE_W = 2.6;

// 가운데를 꽉 채우는 큰 원(글리프가 절대 안 잘리도록) + 테두리에 덧붙인 작은 원들로 뭉게구름 실루엣을 만든다 (24x24 좌표계)
const CODEX_CLOUD_CIRCLES = [
  { cx: 12, cy: 12.5, r: 8.2 }, // 기본 원 — 중앙 전체를 덮음
  { cx: 7, cy: 6.2, r: 4 },
  { cx: 17, cy: 6.2, r: 4 },
  { cx: 12, cy: 4.3, r: 4.2 },
  { cx: 3.6, cy: 12.5, r: 3.6 },
  { cx: 20.4, cy: 12.5, r: 3.6 },
  { cx: 6.8, cy: 19, r: 3.8 },
  { cx: 17.2, cy: 19, r: 3.8 },
  { cx: 12, cy: 20.4, r: 3.4 }
];

function makeCodexPng(size) {
  const px = Buffer.alloc(size * size * 4);
  const scale = size / 24;

  function inCloud(sx, sy) {
    for (const c of CODEX_CLOUD_CIRCLES) {
      const dx = sx - c.cx, dy = sy - c.cy;
      if (dx * dx + dy * dy <= c.r * c.r) return true;
    }
    return false;
  }

  for (let py = 0; py < size; py++) {
    const t = py / (size - 1);
    const bg = [
      Math.round(CODEX_TOP[0] + (CODEX_BOTTOM[0] - CODEX_TOP[0]) * t),
      Math.round(CODEX_TOP[1] + (CODEX_BOTTOM[1] - CODEX_TOP[1]) * t),
      Math.round(CODEX_TOP[2] + (CODEX_BOTTOM[2] - CODEX_TOP[2]) * t)
    ];
    for (let px_ = 0; px_ < size; px_++) {
      const i = (py * size + px_) * 4;
      const sx = (px_ + 0.5) / scale;
      const sy = (py + 0.5) / scale;

      if (!inCloud(sx, sy)) { px[i + 3] = 0; continue; }

      let onGlyph = false;
      for (const [x1, y1, x2, y2] of CODEX_GLYPH_LINES) {
        if (distToSegment(sx, sy, x1, y1, x2, y2) <= CODEX_STROKE_W / 2) { onGlyph = true; break; }
      }

      if (onGlyph) {
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
      } else {
        px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2]; px[i + 3] = 255;
      }
    }
  }

  return pngFromPixels(size, px);
}

const dir = path.join(__dirname, 'assets');
fs.writeFileSync(path.join(dir, 'icon.ico'), makeIco(makeStarTrayPng(256)));
fs.writeFileSync(path.join(dir, 'icon.png'), makeStarTrayPng(256));
fs.writeFileSync(path.join(dir, 'tray.png'), makeStarTrayPng(32));

fs.writeFileSync(path.join(dir, 'codex-icon.ico'), makeIco(makeCodexPng(256)));
fs.writeFileSync(path.join(dir, 'codex-icon.png'), makeCodexPng(256));
fs.writeFileSync(path.join(dir, 'codex-tray.png'), makeCodexPng(32));

console.log('assets generated');
