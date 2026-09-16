# Claude Usage Bar for Android

참고 저장소의 사용량 조회 방식을 안드로이드로 확장한 앱입니다.

## 기능

- Claude와 Codex를 각각 로그인하고 표시 여부를 선택
- 상태바 숫자형 알림과 알림 펼침 화면에 5시간/주간 사용량 표시
- 각 한도의 리셋 정보 표시
- 1분마다 로그인 세션의 사용량 화면을 다시 읽어 자동 갱신
- 로그인 세션은 서비스별 Android WebView 쿠키 저장소에 보관

## 사용법

1. `ClaudeUsageBar-debug.apk`를 설치합니다.
2. 앱에서 알림 권한을 허용합니다.
3. 표시할 서비스의 로그인 버튼을 눌러 로그인합니다.
4. `상단바 숫자 표시 및 자동 갱신`에서 Claude/Codex를 개별적으로 켭니다.

## 빌드

Android Studio에서 이 폴더를 열거나 Android SDK와 Gradle 8.7 환경에서 `assembleDebug`를 실행합니다.

주의: Claude와 Codex의 사용량 페이지 구조가 바뀌면 파서 수정이 필요할 수 있습니다. APK는 디버그 서명 빌드입니다.
