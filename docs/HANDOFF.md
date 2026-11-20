# 인계 문서 — Profe Lucía (2026-11-20 기준, v1.0.1)

새 대화(세션)에서 이 프로젝트를 이어받을 때 가장 먼저 읽는 문서. 사용자에게는 **한국어**로 답한다.

## 1. 무엇을, 왜 만드나
- 사용자: 한국어 화자. 스페인어 듣기·읽기는 B1 정도지만 **말하려 하면 한 마디도 안 나옴**.
- 목표: 광고에서 본 AI 회화 앱처럼, 나만의 **말문 트기 스페인어 회화 선생님**. 설명은 한국어(필요하면 영어 비교), 대화는 스페인어.
- 사용자는 **주로 안드로이드 폰**에서 쓰고, 써 보면서 준 피드백을 **폰에서 바로** 앱에 반영하길 원함 → GitHub 저장소 + GitHub Pages + Claude Code(클라우드)로 수정하는 흐름.

## 2. 지금 상태
- 저장소: https://github.com/jjhh120-blip/profesoralucia (공개, 기본 브랜치 `main`)
- 배포: GitHub Pages, `main`의 `/(root)` → **https://jjhh120-blip.github.io/profesoralucia/**. push 후 30초~2분 안에 반영됨.
- 현재 버전: **1.0.1** (`app.js`의 `VERSION`; 설정 화면 맨 아래에 표시됨)
- 사용자가 폰에서 설치하고 설정 화면, 수업 시작 버튼이 정상으로 보이는 것까지 확인함.
- **아직 확인 못 함**: 실제 API 키로 한 대화 결과, 안드로이드 음성 인식과 음성 합성 품질, 세션 리포트, 백업/불러오기. 사용자의 첫 사용 피드백을 기다리는 중.

## 3. 구조 (빌드 단계 없는 정적 PWA)
| 파일 | 역할 |
|---|---|
| `index.html` | 마크업과 CSS 전부. 디자인 토큰은 `:root`에 있음(초록 `--verde`, 노랑 교정 `--sol`). 앱 스크립트가 로드되지 않으면 빨간 오류 배너를 띄우는 인라인 스크립트 포함 |
| `app.js` | 앱 로직 (ES module). 선생님 규칙 `RULES`, 모드 `MODES`, 장면 `SCENES`, 응답 스키마 `TURN_SCHEMA`/`REPORT_SCHEMA` |
| `sw.js` | 서비스 워커, network-first. 같은 출처 GET만 캐시하고 API 호출은 건드리지 않음. 파일을 추가하면 `SHELL` 목록을 갱신하고 `CACHE` 이름을 올릴 것 (현재 `profe-lucia-v2`) |
| `manifest.webmanifest`, `icons/` | 설치 정보, 아이콘(192/512/maskable PNG + SVG) |
| `docs/tutor-prompt-v1.md` | 선생님 프롬프트 설계 원본 (Claude 앱 프로젝트 지침용으로도 쓸 수 있음) |
| `.nojekyll` | Pages가 Jekyll 처리를 하지 않게 함 |

### 동작 흐름
1. 🎤 → 브라우저 내장 `SpeechRecognition` (스페인어는 `es-MX`/`es-ES`, 한국어 토글은 `ko-KR`). continuous 모드이고, 끊기면 자동으로 재시작함. 다시 누르면 멈추고 전송.
2. 전송 → `askClaude()`가 `@anthropic-ai/sdk@1.5.0`(jsDelivr `+esm`, **처음 쓸 때 동적 import**)로 Messages API 호출.
   - `system` = `RULES` + `profileBlock()`(레벨, 스페인어 종류, 관심사, 목표, 현재 모드, 에러 로그 상위 8개, 최근 표현 10개)
   - `messages` = 대화 기록(최근 30개, user로 시작하도록 조정). 앱 알림은 `[대괄호]`로 user 턴에 넣고, user 턴이 연달아 오면 하나로 합침.
   - `output_config: { effort: "low", format: { type: "json_schema", schema: TURN_SCHEMA } }`, 최상위 `cache_control: {type:"ephemeral"}`
   - Opus 5.5 / Sonnet 5.5는 `client.beta.messages.create` + `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"` (안전 필터가 거절하면 다른 모델로 재시도). Haiku 5.5는 일반 `messages.create`.
   - `stop_reason`이 `refusal`/`max_tokens`면 따로 처리하고, 오류는 `errorCopy()`에서 한국어 안내로 바꿈.
3. 응답 → 교정 카드, 선생님 말풍선(한국어 뜻은 기본으로 숨김), 문장 첫머리 버튼, 과제 박스를 그리고 `speechSynthesis`로 읽어 줌.
4. 저장: `localStorage`의 `profe-store`(설정, errors, phrases, sessions)와 `profe-key`(API 키). **폰에만 있음.** 설정 화면에 JSON 백업 저장/불러오기 기능이 있음.
5. 세션 끝내기 → effort `medium`으로 리포트 생성(잘한 점, 패턴, 표현, 다음 추천).

## 4. 결정한 것과 이유 (뒤집기 전에 사용자와 상의)
- **네이티브 앱 대신 PWA**: 폰에서 수정 → push → 바로 반영되는 흐름이 핵심이라서. 나중에 Play 스토어용으로 필요해지면 TWA(Bubblewrap)로 감쌀 수 있음.
- **공개 저장소**: 무료 GitHub Pages를 쓰려면 필요. 비밀값은 저장소에 없음.
- **API 키는 사용자 폰에만 저장**하고 브라우저에서 API를 직접 호출(`dangerouslyAllowBrowser: true`). 서버가 없음. 키나 학습 기록은 **절대 커밋하지 말 것.**
- **기본 모델 Opus 5.5**: 사용자가 직접 고름. 설정에서 Sonnet 5.5나 Haiku 5.5로 바꿀 수 있음.
- **effort low**: 회화는 응답 속도가 중요해서.
- claude.ai 아티팩트 버전(https://claude.ai/artifact/HPNfvW1ZnfVNRWDiEc1jqj)은 첫 프로토타입. 폰 앱에서는 아티팩트 런타임(dictation, tts, sample)을 쓸 수 없어서 이 PWA로 옮김. 지금은 PWA가 기준.
- git 커밋 작성자는 `jjhh120-blip <jjhh120-blip@users.noreply.github.com>` (공개 저장소에 개인 이메일이 드러나지 않게). 커밋 끝에는 Co-Authored-By Claude 줄을 붙임.

## 5. 알려진 위험과 먼저 볼 곳
- **실제 키로 검증 안 된 부분**: `fallbacks: "default"` + `output_config.format`(json_schema) + `cache_control` 조합. 잘못된 키로는 401까지만 확인함. 사용자가 "요청이 거절됐어요: …"를 보고하면 이 파라미터 조합부터 의심할 것(예: 400이면 fallbacks를 빼 보거나 beta가 아닌 일반 호출로 바꿔 보기).
- 안드로이드 크롬의 continuous 음성 인식은 중간에 끊기거나 같은 말이 중복될 수 있음. `runRecognizer()`의 재시작 로직을 볼 것.
- 스페인어 TTS 목소리는 기기마다 다름. 설정에서 목소리를 고를 수 있음.
- SDK는 `1.5.0`으로 고정. 올릴 때는 배포된 지 2주 이상 된 버전으로.

## 6. 다음 할 일 후보 (사용자 피드백 순서로 정할 것)
1. 첫 실사용 피드백 반영: 오류 문구, 음성 인식 품질, 선생님 말 길이와 교정 빈도
2. 응답 지연 줄이기: 스트리밍으로 받아서 말풍선 먼저 보여주기, 또는 기본 모델/effort 조정 제안
3. 간격 반복(SRS) 복습: 틀린 패턴을 날짜 기반으로 다시 출제
4. Rápido 모드 5초 타이머, 장면 추가
5. 발음 평가(외부 서비스 필요. 비용과 키 관리를 먼저 상의할 것)
6. 기기 간 기록 동기화(지금은 백업 파일로만 가능)
7. 사용량과 대략의 비용 표시

## 7. 작업 규칙
- 앱을 바꿀 때마다 `app.js`의 `VERSION`을 올리고, 캐시할 파일 목록이 바뀌면 `sw.js`의 `CACHE`도 올린다.
- `main`에 push하면 곧바로 사용자 폰에 반영되므로, push 전에 브라우저에서 한 번 띄워 콘솔 오류가 없는지 확인한다(폰 크기 375×812 기준).
- 사용자가 확인할 방법: 앱을 완전히 닫았다가 다시 열고, 설정 맨 아래 버전 번호를 본다.
