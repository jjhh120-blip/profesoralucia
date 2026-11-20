# Profe Lucía — 프로젝트 안내 (Claude용)

안드로이드 폰에 설치해서 쓰는 스페인어 회화 선생님 PWA. 사용자는 한국어 화자이며 주로 폰에서 피드백을 주고 수정을 요청한다.

## 구조
- `index.html` — 화면 마크업과 CSS (빌드 단계 없음, 정적 파일)
- `app.js` — 앱 로직 (ES module). Claude 호출은 jsDelivr의 `@anthropic-ai/sdk` 브라우저 빌드 사용
- `sw.js` — 서비스 워커 (network-first). 파일을 추가하면 `SHELL` 목록과 `CACHE` 이름도 갱신
- `manifest.webmanifest`, `icons/` — 설치용 정보
- `docs/tutor-prompt-v1.md` — 선생님 프롬프트 설계 원본

## 규칙
- 배포: `main` 브랜치에 push하면 GitHub Pages가 1~2분 안에 자동 반영 → https://jjhh120-blip.github.io/profesoralucia/
- 수정할 때마다 `app.js`의 `VERSION`을 올린다 (설정 화면 하단에 표시되어 폰에서 반영 여부를 확인할 수 있음).
- API 키는 폰의 localStorage에만 있다. 키나 개인 학습 기록을 저장소에 절대 커밋하지 않는다.
- 선생님 동작(말투, 교정 방식, 모드)은 `app.js`의 `RULES`, `MODES`, `TURN_SCHEMA`에서 바꾼다.
- 음성 인식/합성은 브라우저 내장 Web Speech API (안드로이드 크롬 기준).
- 사용자에게는 한국어로 답한다.
