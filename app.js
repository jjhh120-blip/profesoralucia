const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.5.0/+esm";
const VERSION = "1.0.1";
let Anthropic = null; // loaded on first use, so the screen still works if the CDN is slow or blocked
const $ = (s) => document.querySelector(s);

/* ---------------- data ---------------- */
const MODES = [
  { id: "charla", es: "Charla", ko: "자유 대화", rule: "Natural conversation about the learner's life and interests." },
  { id: "rol", es: "Rol", ko: "롤플레이", rule: "Role-play the chosen scene. On the first turn of a scene put a one-line Korean scene description in task_ko, then stay in character." },
  { id: "rapido", es: "Rápido", ko: "순발력", rule: "Speed-translation drill. Each turn: in reply give the natural Spanish version of the learner's last attempt with brief praise; put the NEXT short Korean sentence to translate in task_ko. Increase difficulty gradually. Keep reply very short." },
  { id: "eco", es: "Eco", ko: "쉐도잉", rule: "Shadowing + substitution drill. Give one natural sentence in reply for the learner to repeat; once repeated, change one part (task_ko says in Korean what to change) and have them adapt it." },
  { id: "historia", es: "Historia", ko: "스토리텔링", rule: "Ask the learner to tell about their day/weekend/a memory in 3-5 sentences; ask follow-up questions to stretch it." },
  { id: "repaso", es: "Repaso", ko: "복습", rule: "Review quiz built ONLY from the learner's error log and learned phrases. One item per turn; task_ko holds the Korean prompt." },
];
const SCENES = ["카페에서 주문", "공항 체크인", "병원 진료", "친구 가족과 저녁식사", "헬스장에서 운동", "길 묻기", "호텔 체크인", "첫 만남 자기소개"];
const ERROR_TYPES = ["ser/estar", "gender", "conjugation", "tense", "preposition", "vocab", "word-order", "other"];

const DEFAULT_STORE = {
  settings: { level: "A2", variety: "es-MX", interests: "", goal: "", rate: 0.9, voice: "", model: "claude-opus-5-5" },
  errors: [], phrases: [], sessions: [],
};

const state = {
  mode: "charla", scene: SCENES[0], lang: "es", started: false, busy: false,
  history: [], words: 0, turns: 0, fixes: 0, sessErrors: [],
  store: structuredClone(DEFAULT_STORE),
};

/* ---------------- storage (this phone only) ---------------- */
function loadStore() {
  try {
    const v = JSON.parse(localStorage.getItem("profe-store") || "null");
    if (v) state.store = { ...DEFAULT_STORE, ...v, settings: { ...DEFAULT_STORE.settings, ...(v.settings || {}) } };
  } catch {}
}
function save() { try { localStorage.setItem("profe-store", JSON.stringify(state.store)); } catch {} }
function getKey() { try { return localStorage.getItem("profe-key") || ""; } catch { return ""; } }
function setKey(k) { try { k ? localStorage.setItem("profe-key", k) : localStorage.removeItem("profe-key"); } catch {} }

/* ---------------- Claude ---------------- */
let client = null, clientKey = "";
async function getClient() {
  const key = getKey();
  if (!key) return null;
  if (!Anthropic) {
    try { Anthropic = (await import(SDK_URL)).default; }
    catch { throw Object.assign(new Error("sdk"), { code: "sdk_load" }); }
  }
  if (!client || clientKey !== key) {
    // The key lives only on this device; the browser talks to the API directly.
    client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    clientKey = key;
  }
  return client;
}

const TURN_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    reply_ko: { type: "string" },
    task_ko: { type: "string" },
    correction: {
      type: "object",
      properties: {
        has_error: { type: "boolean" },
        wrong: { type: "string" },
        right: { type: "string" },
        note_ko: { type: "string" },
        type: { type: "string", enum: ERROR_TYPES },
        explicit: { type: "boolean" },
      },
      required: ["has_error", "wrong", "right", "note_ko", "type", "explicit"],
      additionalProperties: false,
    },
    starters: { type: "array", items: { type: "string" } },
    phrases: {
      type: "array",
      items: { type: "object", properties: { es: { type: "string" }, ko: { type: "string" } }, required: ["es", "ko"], additionalProperties: false },
    },
  },
  required: ["reply", "reply_ko", "task_ko", "correction", "starters", "phrases"],
  additionalProperties: false,
};

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    good: { type: "array", items: { type: "string" } },
    patterns: {
      type: "array",
      items: { type: "object", properties: { wrong: { type: "string" }, right: { type: "string" }, tip: { type: "string" } }, required: ["wrong", "right", "tip"], additionalProperties: false },
    },
    phrases: {
      type: "array",
      items: { type: "object", properties: { es: { type: "string" }, ko: { type: "string" } }, required: ["es", "ko"], additionalProperties: false },
    },
    next: { type: "string" },
  },
  required: ["good", "patterns", "phrases", "next"],
  additionalProperties: false,
};

const RULES = `You are Profe Lucía, a warm, patient, slightly playful Spanish conversation tutor. Your single goal: get this learner to SPEAK Spanish, more each session.

RULES
1. "reply" = max 1-2 SHORT Spanish sentences and it must END with a question or a clear task. The learner should talk more than you.
2. Never let them freeze. If they are silent, say "no sé", or seem stuck: rephrase simpler -> give sentence starters -> offer an A/B choice -> give a model sentence and ask them to repeat it.
3. If they answer in Korean or English: praise, give the Spanish version in reply ("En español: ...") and ask them to say it.
4. Correction = recast. Set correction.has_error=true ONLY when their Spanish had a real error, and give just the single most useful fix. If the same error repeated or meaning broke, set explicit=true and ask them in reply to say the corrected sentence again. Never correct correct Spanish. Their text comes from speech recognition: ignore missing accents, punctuation and capitalization, and likely mis-hearings. When has_error=false, fill wrong/right/note_ko with "" and type with "other".
5. Grammar explanations go in correction.note_ko, in Korean, 1-2 lines; compare with English only when it helps.
6. Use high-frequency chunks (me gustaría, lo que pasa es que, acabo de, tengo que...). Speak slightly above their speaking level.
7. Specific, honest praise. No emojis or markdown in reply: it is read aloud.
8. "starters": 0-3 Spanish sentence starters the learner could use to answer. "phrases": 0-2 useful chunks you used this turn, with Korean meaning. "task_ko": a Korean task line, or "".
9. Lines in [square brackets] in the learner's turn are notes from the app, not the learner's speech.`;

function profileBlock() {
  const s = state.store.settings, m = MODES.find((x) => x.id === state.mode);
  const errs = [...state.store.errors].sort((a, b) => b.count - a.count).slice(0, 8)
    .map((e) => `- "${e.wrong}" -> "${e.right}" (${e.type}, ${e.count}x)`).join("\n") || "(none yet)";
  const phrases = state.store.phrases.slice(-10).map((p) => `- ${p.es} (${p.ko})`).join("\n") || "(none yet)";
  return `LEARNER
Native Korean, understands English. Listening/reading about B1; speaking level ${s.level} - they freeze when speaking.
Variety: ${s.variety === "es-ES" ? "Spain Spanish" : "Latin American (Mexico) Spanish"}; use tú.
Interests: ${s.interests || "(unknown - ask)"}. Goal: ${s.goal || "(unknown)"}.

CURRENT MODE: ${m.es} - ${m.rule}${state.mode === "rol" ? `\nSCENE: ${state.scene}` : ""}

ERROR LOG (target these patterns subtly; in Repaso, quiz them):
${errs}

LEARNED PHRASES:
${phrases}`;
}

function usesFallback(model) { return model === "claude-opus-5-5" || model === "claude-sonnet-5-5"; }

async function askClaude({ system, messages, schema, maxTokens, effort }) {
  const c = await getClient();
  if (!c) throw Object.assign(new Error("no key"), { code: "no_key" });
  const model = state.store.settings.model;
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    cache_control: { type: "ephemeral" },
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  // Opus/Sonnet 5.5: if a safety classifier declines, the API retries on a fallback model.
  const res = usesFallback(model)
    ? await c.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    : await c.messages.create(params);
  if (res.stop_reason === "refusal") throw Object.assign(new Error("refusal"), { code: "refusal" });
  if (res.stop_reason === "max_tokens") throw Object.assign(new Error("max_tokens"), { code: "max_tokens" });
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

function errorCopy(e) {
  if (e?.code === "no_key") return "설정에서 Anthropic API 키를 넣어 주세요.";
  if (e?.code === "refusal") return "선생님이 이 내용에는 답하지 못했어요. 다른 말로 다시 해 볼까요?";
  if (e?.code === "max_tokens") return "답이 너무 길어져 끊겼어요. 한 번 더 보내 주세요.";
  if (e?.code === "sdk_load") return "선생님 연결 모듈을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.";
  const is = (name) => !!(Anthropic && Anthropic[name] && e instanceof Anthropic[name]);
  if (is("AuthenticationError")) return "API 키가 올바르지 않아요. 설정에서 키를 확인해 주세요.";
  if (is("PermissionDeniedError")) return "이 API 키로는 선택한 모델을 쓸 수 없어요. 설정에서 다른 모델을 골라 보세요.";
  if (is("RateLimitError")) return "요청이 많아 잠시 쉬어야 해요. 몇 초 뒤 다시 보내 주세요.";
  if (is("BadRequestError")) return "요청이 거절됐어요: " + (e.message || "").slice(0, 160);
  if (is("APIConnectionError")) return "인터넷 연결을 확인해 주세요.";
  if (is("APIError")) return "서버 오류가 났어요. 잠시 뒤 다시 보내 주세요.";
  if (e instanceof SyntaxError) return "선생님 답을 읽지 못했어요. 한 번 더 보내 주세요.";
  return "선생님 응답을 받지 못했어요. 다시 보내 주세요.";
}

/* ---------------- conversation ---------------- */
function pushUser(text) {
  const last = state.history[state.history.length - 1];
  if (last && last.role === "user") last.content += "\n" + text;
  else state.history.push({ role: "user", content: text });
}
function windowedHistory() {
  let h = state.history.slice(-30);
  while (h.length && h[0].role !== "user") h = h.slice(1);
  return h;
}

async function tutorTurn() {
  state.busy = true; setBusy();
  const th = note("Lucía가 생각 중…", "thinking");
  try {
    const d = await askClaude({
      system: [{ type: "text", text: RULES }, { type: "text", text: profileBlock() }],
      messages: windowedHistory(),
      schema: TURN_SCHEMA, maxTokens: 4000, effort: "low",
    });
    th.remove();
    const c = d.correction;
    if (c && c.has_error && c.wrong && c.right) {
      addFix(c); state.fixes++;
      const key = c.right.trim().toLowerCase();
      const ex = state.store.errors.find((e) => e.right.trim().toLowerCase() === key || e.wrong === c.wrong);
      if (ex) ex.count++;
      else state.store.errors.push({ wrong: c.wrong, right: c.right, type: c.type || "other", count: 1 });
      state.sessErrors.push(c);
    }
    for (const p of d.phrases || []) {
      if (p?.es && !state.store.phrases.some((x) => x.es === p.es)) state.store.phrases.push({ es: p.es, ko: p.ko || "" });
    }
    if (state.store.phrases.length > 300) state.store.phrases = state.store.phrases.slice(-300);
    state.history.push({ role: "assistant", content: d.reply + (d.task_ko ? `\n(과제: ${d.task_ko})` : "") });
    addTutor(d); renderMeter(); renderNotes(); save();
    speak(d.reply);
  } catch (e) {
    th.remove();
    note(errorCopy(e));
  } finally {
    state.busy = false; setBusy();
  }
}

function startSession() {
  if (!getKey()) { note(errorCopy({ code: "no_key" })); openSheet(); return; }
  state.started = true; state.history = []; state.words = 0; state.turns = 0; state.fixes = 0; state.sessErrors = [];
  $("#chat").innerHTML = ""; renderMeter();
  pushUser(state.store.errors.length
    ? "[세션 시작. 짧게 인사하고, 에러 로그 1순위 패턴을 노리는 짧은 복습 질문 하나로 시작하세요.]"
    : "[세션 시작. 짧게 인사하고 쉬운 개인적인 질문을 하세요.]");
  tutorTurn();
}

function send() {
  const t = $("#text"); const text = t.value.trim();
  if (!text || state.busy) return;
  if (!state.started) { state.started = true; state.history = []; $("#chat").innerHTML = ""; }
  t.value = ""; addMe(text);
  if (state.lang === "es") state.words += text.split(/\s+/).filter(Boolean).length;
  state.turns++; renderMeter();
  pushUser(state.lang === "ko" ? `[학습자가 한국어로 말함] ${text}` : text);
  tutorTurn();
}

function changeMode(note) {
  if (!state.started) return;
  pushUser(`[앱 알림: ${note}]`);
  tutorTurn();
}

async function endSession() {
  if (!state.started || state.busy || state.turns === 0) return;
  stopSpeak(); stopListening(false);
  const body = $("#reportBody"); body.textContent = "리포트를 만드는 중…"; $("#report").showModal();
  const summary = { date: new Date().toISOString().slice(0, 10), words: state.words, turns: state.turns, next: "" };
  let r = null;
  const transcript = state.history.map((h) => (h.role === "assistant" ? "PROFE: " : "ALUMNO: ") + h.content).join("\n");
  try {
    r = await askClaude({
      system: "You analyze a Spanish tutoring session for a Korean learner. Write every field in Korean except Spanish examples.",
      messages: [{ role: "user", content: `Speaking level: ${state.store.settings.level}\n\nTRANSCRIPT:\n${transcript}\n\nCORRECTIONS MADE:\n${JSON.stringify(state.sessErrors)}\n\ngood = 2 specific things they did well; patterns = up to 5 recurring errors with a short Korean tip; phrases = up to 5 useful expressions from today; next = one-line recommendation (mode/topic) for the next session.` }],
      schema: REPORT_SCHEMA, maxTokens: 8000, effort: "medium",
    });
  } catch {}
  body.innerHTML = "";
  const h = (t) => Object.assign(document.createElement("h4"), { textContent: t });
  const ul = (arr, fn) => { const u = document.createElement("ul"); arr.forEach((a) => u.append(Object.assign(document.createElement("li"), { textContent: fn(a) }))); return u; };
  body.append(Object.assign(document.createElement("p"), { textContent: `말한 스페인어 단어 ${state.words}개 · 내 턴 ${state.turns}번 · 교정 ${state.fixes}번` }));
  if (r) {
    summary.next = r.next || "";
    if (r.good?.length) body.append(h("잘한 점"), ul(r.good, (x) => x));
    if (r.patterns?.length) body.append(h("다시 볼 패턴"), ul(r.patterns, (p) => `${p.wrong} → ${p.right}${p.tip ? " · " + p.tip : ""}`));
    if (r.phrases?.length) {
      body.append(h("오늘의 표현"), ul(r.phrases, (p) => `${p.es} — ${p.ko}`));
      r.phrases.forEach((p) => { if (p?.es && !state.store.phrases.some((x) => x.es === p.es)) state.store.phrases.push({ es: p.es, ko: p.ko || "" }); });
    }
    if (r.next) body.append(h("다음 세션 추천"), Object.assign(document.createElement("p"), { textContent: r.next }));
  } else {
    body.append(Object.assign(document.createElement("p"), { className: "empty", textContent: "자세한 분석은 받지 못했지만 기록과 틀린 패턴은 저장됐어요." }));
  }
  state.store.sessions.push(summary);
  if (state.store.sessions.length > 200) state.store.sessions.shift();
  save(); renderNotes();
  state.started = false; renderWelcome();
}

/* ---------------- render ---------------- */
function renderModes() {
  const nav = $("#modes"); nav.innerHTML = "";
  for (const m of MODES) {
    const b = document.createElement("button"); b.className = "mode"; b.setAttribute("aria-pressed", String(m.id === state.mode));
    b.append(Object.assign(document.createElement("b"), { textContent: m.es }), m.ko);
    b.onclick = () => {
      if (state.mode === m.id || state.busy) return;
      state.mode = m.id; renderModes();
      changeMode(`모드를 '${m.es}'(으)로 바꿨어요. 새 모드를 시작하세요.${m.id === "rol" ? " 장면: " + state.scene : ""}`);
    };
    nav.append(b);
  }
  if (state.mode === "rol") {
    const s = document.createElement("select"); s.setAttribute("aria-label", "롤플레이 장면");
    for (const sc of SCENES) s.append(Object.assign(document.createElement("option"), { textContent: sc, selected: sc === state.scene }));
    s.onchange = () => { state.scene = s.value; if (!state.busy) changeMode(`새 장면: ${s.value}. 장면을 시작하세요.`); };
    nav.append(s);
  }
}
function renderMeter() { $("#mWords").textContent = state.words; $("#mTurns").textContent = state.turns; $("#mFix").textContent = state.fixes; }
function li(main, sub, extra) {
  const l = document.createElement("li");
  l.append(Object.assign(document.createElement("span"), { textContent: main }));
  if (sub) l.append(Object.assign(document.createElement("span"), { className: "k", textContent: sub }));
  if (extra) l.append(Object.assign(document.createElement("span"), { className: "cnt", textContent: extra }));
  return l;
}
function emptyLi(t) { return Object.assign(document.createElement("li"), { className: "empty", textContent: t }); }
function renderNotes() {
  const s = state.store.settings;
  $("#level").value = s.level; $("#variety").value = s.variety; $("#interests").value = s.interests; $("#goal").value = s.goal;
  $("#rate").value = s.rate; $("#rateVal").textContent = Number(s.rate).toFixed(2); $("#model").value = s.model;
  $("#apiKey").value = getKey();
  const el = $("#errList"); el.innerHTML = "";
  const errs = [...state.store.errors].sort((a, b) => b.count - a.count).slice(0, 15);
  if (!errs.length) el.append(emptyLi("대화하면서 틀린 패턴이 여기에 쌓이고, 복습 모드에서 다시 나와요."));
  errs.forEach((e) => el.append(li(e.right, "✗ " + e.wrong, `${e.type || "other"} · ${e.count}회`)));
  const pl = $("#phraseList"); pl.innerHTML = "";
  const ph = state.store.phrases.slice(-20).reverse();
  if (!ph.length) pl.append(emptyLi("선생님이 알려준 표현이 저장돼요."));
  ph.forEach((p) => pl.append(li(p.es, p.ko)));
  const sl = $("#sessList"); sl.innerHTML = "";
  const ss = state.store.sessions.slice(-8).reverse();
  if (!ss.length) sl.append(emptyLi("세션을 끝내면 기록이 남아요. 말한 단어 수가 늘어나는지 보세요."));
  ss.forEach((x) => sl.append(li(`${x.date} · ${x.words}단어 · ${x.turns}턴`, x.next || "")));
}
function scrollChat() { const c = $("#chat"); c.scrollTop = c.scrollHeight; }
function note(text, cls = "status") { const d = Object.assign(document.createElement("div"), { className: cls, textContent: text }); $("#chat").append(d); scrollChat(); return d; }
function addMe(text) {
  const w = Object.assign(document.createElement("div"), { className: "msg me" });
  w.append(Object.assign(document.createElement("div"), { className: "bubble", textContent: text }));
  $("#chat").append(w); scrollChat();
}
function addFix(c) {
  const f = Object.assign(document.createElement("div"), { className: "fix" });
  f.append(Object.assign(document.createElement("s"), { textContent: c.wrong }), Object.assign(document.createElement("div"), { className: "right", textContent: "→ " + c.right }));
  if (c.note_ko) f.append(Object.assign(document.createElement("div"), { textContent: c.note_ko }));
  $("#chat").append(f); scrollChat();
}
function addTutor(d, opts = {}) {
  const w = Object.assign(document.createElement("div"), { className: "msg tutor" });
  if (d.task_ko) {
    const t = Object.assign(document.createElement("div"), { className: "task" });
    t.append(Object.assign(document.createElement("small"), { textContent: "과제" }), d.task_ko); w.append(t);
  }
  const b = Object.assign(document.createElement("div"), { className: "bubble" });
  const ko = Object.assign(document.createElement("div"), { className: "ko", textContent: d.reply_ko || "", hidden: !opts.showKo });
  b.append(Object.assign(document.createElement("div"), { className: "es", textContent: d.reply || "" }), ko); w.append(b);
  const tl = Object.assign(document.createElement("div"), { className: "tools" });
  const k = Object.assign(document.createElement("button"), { textContent: ko.hidden ? "한국어 뜻 보기" : "뜻 숨기기" });
  k.onclick = () => { ko.hidden = !ko.hidden; k.textContent = ko.hidden ? "한국어 뜻 보기" : "뜻 숨기기"; };
  const p = Object.assign(document.createElement("button"), { textContent: "🔊 다시 듣기" }); p.onclick = () => speak(d.reply);
  const sl = Object.assign(document.createElement("button"), { textContent: "🐢 천천히" }); sl.onclick = () => speak(d.reply, 0.65);
  tl.append(k, p, sl); w.append(tl);
  if (d.starters?.length) {
    const st = Object.assign(document.createElement("div"), { className: "starters" });
    d.starters.slice(0, 3).forEach((s) => {
      const x = Object.assign(document.createElement("button"), { textContent: s });
      x.onclick = () => { const t = $("#text"); t.value = s.replace(/(…|\.\.\.)$/, "") + " "; t.focus(); };
      st.append(x);
    });
    w.append(st);
  }
  $("#chat").append(w); scrollChat();
}
function renderWelcome() {
  $("#chat").innerHTML = "";
  note("예시 대화 · 시작하면 사라져요", "tag");
  addTutor({ reply: "¡Hola! ¿Qué hiciste el fin de semana?", reply_ko: "안녕! 주말에 뭐 했어?", starters: ["El sábado yo…", "Fui a…"] }, { showKo: true });
  addMe("Yo voy a la gimnasio el sábado.");
  addFix({ wrong: "Yo voy a la gimnasio", right: "Fui al gimnasio el sábado.", note_ko: "지난 일은 과거형 fui. gimnasio는 남성 명사라 a + el = al." });
  addTutor({ reply: "¡Qué bien! ¿Y qué ejercicio hiciste?", reply_ko: "좋네! 어떤 운동 했어?" }, { showKo: true });
  const wrap = Object.assign(document.createElement("div"), { className: "cta" });
  const btn = Object.assign(document.createElement("button"), { className: "primary", textContent: "수업 시작하기" });
  btn.onclick = startSession;
  wrap.append(btn, Object.assign(document.createElement("div"), { className: "empty", textContent: getKey() ? "선생님이 먼저 인사해요. 🎤를 누르고 말한 뒤, 다시 누르면 보내져요." : "먼저 오른쪽 위 설정에서 Anthropic API 키를 넣어 주세요." }));
  $("#chat").append(wrap); scrollChat();
}

/* ---------------- voice out (TTS) ---------------- */
const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
let voices = [];
function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("es"));
  const sel = $("#voice"); const cur = state.store.settings.voice;
  sel.innerHTML = ""; sel.append(Object.assign(document.createElement("option"), { value: "", textContent: "기본 스페인어 목소리" }));
  voices.forEach((v) => sel.append(Object.assign(document.createElement("option"), { value: v.voiceURI, textContent: `${v.name} (${v.lang})`, selected: v.voiceURI === cur })));
}
function speak(text, rate) {
  if (!synth || !text) return;
  try {
    synth.cancel();
    const s = state.store.settings;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = s.variety; u.rate = rate || Number(s.rate) || 0.9;
    const v = voices.find((x) => x.voiceURI === s.voice) || voices.find((x) => x.lang.replace("_", "-") === s.variety);
    if (v) u.voice = v;
    synth.speak(u);
  } catch {}
}
function stopSpeak() { try { synth?.cancel(); } catch {} }

/* ---------------- voice in (STT) ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, wantListen = false, sendOnEnd = false, baseText = "", sessionText = "";
function startListening() {
  if (!SR || state.busy) return;
  stopSpeak();
  baseText = $("#text").value.trim(); sessionText = "";
  wantListen = true; sendOnEnd = false;
  runRecognizer();
  setMicUi(true);
}
function runRecognizer() {
  rec = new SR();
  rec.lang = state.lang === "es" ? state.store.settings.variety : "ko-KR";
  rec.continuous = true; rec.interimResults = true;
  rec.onresult = (e) => {
    let fin = "", interim = "";
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) fin += r[0].transcript + " "; else interim += r[0].transcript;
    }
    sessionText = fin.trim();
    $("#text").value = [baseText, sessionText, interim].filter(Boolean).join(" ");
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") { wantListen = false; $("#micNote").textContent = "마이크 권한이 꺼져 있어요. 브라우저 사이트 설정에서 마이크를 허용해 주세요."; }
    else if (e.error === "network") { wantListen = false; $("#micNote").textContent = "음성 인식에 인터넷 연결이 필요해요."; }
  };
  rec.onend = () => {
    baseText = [baseText, sessionText].filter(Boolean).join(" "); sessionText = "";
    if (wantListen) { try { runRecognizer(); return; } catch {} }
    setMicUi(false);
    $("#text").value = baseText;
    if (sendOnEnd && baseText) { sendOnEnd = false; send(); }
  };
  try { rec.start(); } catch { wantListen = false; setMicUi(false); }
}
function stopListening(andSend) {
  if (!rec) return;
  wantListen = false; sendOnEnd = andSend;
  try { rec.stop(); } catch {}
}
function setMicUi(live) {
  $("#mic").classList.toggle("live", live);
  $("#mic").setAttribute("aria-label", live ? "말하기 끝내고 보내기" : "말하기 시작");
  $("#micNote").textContent = live ? "듣는 중… 다 말하면 🎤를 다시 누르세요" : "";
}

/* ---------------- wiring ---------------- */
function setBusy() { $("#send").disabled = state.busy; $("#mic").disabled = !SR || (state.busy && !wantListen); }
function openSheet() { renderNotes(); $("#sheet").hidden = false; }
$("#openSheet").onclick = openSheet;
function closeSheet() {
  setKey($("#apiKey").value.trim());
  $("#sheet").hidden = true;
  if (!state.started) renderWelcome();
}
$("#closeSheet").onclick = closeSheet;
$("#closeSheet2").onclick = closeSheet;
$("#send").onclick = send;
$("#text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
$("#mic").onclick = () => (wantListen ? stopListening(true) : startListening());
$("#endBtn").onclick = endSession;
$("#closeReport").onclick = () => $("#report").close();
document.querySelectorAll("#langSeg button").forEach((b) => (b.onclick = () => {
  state.lang = b.dataset.l;
  document.querySelectorAll("#langSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
}));
function bind(id, key, cast = (v) => v) {
  $(id).addEventListener("change", () => { state.store.settings[key] = cast($(id).value); save(); });
}
bind("#level", "level"); bind("#variety", "variety"); bind("#interests", "interests"); bind("#goal", "goal");
bind("#model", "model"); bind("#voice", "voice"); bind("#rate", "rate", Number);
$("#rate").addEventListener("input", () => ($("#rateVal").textContent = Number($("#rate").value).toFixed(2)));
$("#apiKey").addEventListener("change", () => setKey($("#apiKey").value.trim()));

$("#exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify({ app: "profe-lucia", version: VERSION, ...state.store }, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `profe-lucia-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("#importFile").onchange = async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    const v = JSON.parse(await f.text());
    state.store = { ...DEFAULT_STORE, errors: v.errors || [], phrases: v.phrases || [], sessions: v.sessions || [], settings: { ...DEFAULT_STORE.settings, ...(v.settings || {}) } };
    save(); renderNotes(); loadVoices();
  } catch { alert("백업 파일을 읽지 못했어요."); }
  e.target.value = "";
};

loadStore();
$("#ver").textContent = VERSION;
if (!SR) $("#micNote").textContent = "이 브라우저는 음성 인식을 지원하지 않아요. 안드로이드 크롬에서 열어 주세요.";
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
renderModes(); renderMeter(); renderNotes(); renderWelcome(); setBusy();
if (!getKey()) openSheet();
window.__profeReady = true;

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
