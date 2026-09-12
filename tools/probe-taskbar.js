// 이 PC의 작업표시줄 실제 좌표를 잰다(물리 픽셀). 실행: npx electron tools/probe-taskbar.js
// Electron은 DPI 인식 프로세스라 GetWindowRect가 물리 좌표를 준다(node로 돌리면 논리 좌표가 섞여 틀린다).
const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const win32 = require('../strip-win32');

app.whenReady().then(() => {
  const d = screen.getPrimaryDisplay();
  const out = {
    available: win32.available(),
    loadError: win32.lastLoadError(),
    info: win32.getTaskbarInfo(),
    notificationState: win32.getNotificationState(),
    taskbarLight: win32.isTaskbarLight(),
    display: { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor }
  };
  fs.writeFileSync(path.join(__dirname, '_probe.json'), JSON.stringify(out, null, 2));
  app.quit();
});
