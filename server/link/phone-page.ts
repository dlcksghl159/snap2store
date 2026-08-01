import { isValidLinkCode } from "./protocol.js";

/**
 * 폰 카메라 페이지 — 빌드 파이프라인에 넣지 않는다(/stream 과 같은 원칙).
 * 프론트 빌드가 깨져도 폰 링크는 살아 있어야 하고, 폰이 받는 것은 이 파일 하나가 전부다.
 *
 * 규칙: 아래 인라인 스크립트에는 백틱·\${ 를 쓰지 않는다 — 바깥 템플릿 리터럴과 충돌한다.
 */

export function renderPhonePage(rawCode: string): string {
  const code = isValidLinkCode(rawCode) ? rawCode : "";
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<meta name="theme-color" content="#0b0c10" />
<meta name="color-scheme" content="dark" />
<title>Snap2Store 카메라</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23101319'/%3E%3Ccircle cx='32' cy='30' r='13' fill='none' stroke='%23ffb454' stroke-width='5'/%3E%3Ccircle cx='32' cy='30' r='4.5' fill='%23ffb454'/%3E%3Crect x='18' y='46' width='28' height='5' rx='2.5' fill='%23ffffff'/%3E%3C/svg%3E" />
<style>
  :root {
    --bg: #0b0c10;
    --panel: rgba(255, 255, 255, 0.06);
    --line: rgba(255, 255, 255, 0.12);
    --text: #f2f4f8;
    --dim: rgba(242, 244, 248, 0.62);
    --faint: rgba(242, 244, 248, 0.4);
    --blue: #3160f0;
    --green: #3ccb8b;
    --amber: #ffb454;
    --red: #ff5d52;
    --sat: env(safe-area-inset-top, 0px);
    --sab: env(safe-area-inset-bottom, 0px);
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: "Pretendard Variable", Pretendard, "Apple SD Gothic Neo", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    word-break: keep-all;
    overflow: hidden;
    position: fixed;
    inset: 0;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
  }
  button { font: inherit; color: inherit; border: 0; background: none; padding: 0; cursor: pointer; }
  [hidden] { display: none !important; }

  @keyframes rise { from { opacity: 0; transform: translate3d(0, 14px, 0); } to { opacity: 1; transform: none; } }
  @keyframes breathe { 0%, 100% { opacity: 0.45; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }
  @keyframes flashfx { 0% { opacity: 0; } 18% { opacity: 0.94; } 100% { opacity: 0; } }
  @keyframes barjump { 0%, 100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── 게이트 ── */
  #gate {
    position: absolute; inset: 0;
    display: grid; place-items: center;
    padding: calc(var(--sat) + 22px) 26px calc(var(--sab) + 30px);
    background:
      radial-gradient(120% 60% at 12% -6%, rgba(49, 96, 240, 0.22), transparent 60%),
      radial-gradient(110% 55% at 96% 108%, rgba(199, 125, 255, 0.14), transparent 62%),
      var(--bg);
  }
  .gate-card { width: min(430px, 100%); display: grid; gap: 14px; text-align: center; justify-items: center; }
  .brand { display: inline-flex; align-items: baseline; gap: 8px; font-weight: 800; font-size: 16px; letter-spacing: -0.02em; animation: rise 480ms var(--ease) both; }
  .brand em { font-style: normal; font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: var(--faint); }
  .gate-glyph { width: 88px; height: 88px; border-radius: 28px; background: var(--panel); border: 1px solid var(--line); display: grid; place-items: center; margin-top: 6px; animation: rise 480ms var(--ease) 40ms both; }
  .gate-glyph svg { display: block; }
  #gate h1 { margin: 4px 0 0; font-size: 26px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.25; animation: rise 480ms var(--ease) 90ms both; }
  #gate .lede { margin: 0; font-size: 14.5px; line-height: 1.65; color: var(--dim); animation: rise 480ms var(--ease) 140ms both; }
  .code-chip { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 7px 14px; font-size: 12px; font-weight: 700; color: var(--dim); animation: rise 480ms var(--ease) 180ms both; }
  .code-chip b { font-family: ui-monospace, Menlo, monospace; font-size: 13px; letter-spacing: 0.34em; margin-right: -0.34em; color: var(--text); }
  #startBtn {
    margin-top: 10px; width: 100%; max-width: 340px;
    border-radius: 18px; padding: 18px 24px;
    background: var(--blue); color: #fff; font-size: 17px; font-weight: 800;
    transition: transform 120ms var(--ease), background 160ms ease;
    animation: rise 480ms var(--ease) 230ms both;
  }
  #startBtn:active { transform: scale(0.97); }
  #startBtn:disabled { opacity: 0.55; }
  .gate-hint { font-size: 12px; color: var(--faint); animation: rise 480ms var(--ease) 280ms both; }
  .gate-error { border-radius: 14px; border: 1px solid rgba(255, 93, 82, 0.4); background: rgba(255, 93, 82, 0.12); color: #ffb4ae; font-size: 13.5px; font-weight: 600; line-height: 1.55; padding: 12px 16px; }

  /* 코드 직접 입력 — QR 없이 들어온 경우 */
  #codeEntry { width: 100%; max-width: 340px; display: grid; gap: 9px; justify-items: stretch; animation: rise 480ms var(--ease) 180ms both; }
  #codeEntry label { font-size: 12.5px; font-weight: 600; color: var(--dim); }
  #codeInput {
    width: 100%; border-radius: 16px; border: 1.5px solid var(--line); background: var(--panel);
    color: var(--text); padding: 15px 12px; text-align: center;
    font-family: ui-monospace, Menlo, monospace; font-size: 24px; font-weight: 600;
    letter-spacing: 0.42em; text-transform: uppercase; caret-color: var(--blue); outline: none;
  }
  #codeInput:focus { border-color: var(--blue); }
  #codeInput::placeholder { color: rgba(242, 244, 248, 0.22); letter-spacing: 0.42em; }
  #codeGo { border-radius: 14px; padding: 13px; background: rgba(255, 255, 255, 0.09); border: 1px solid var(--line); font-size: 14.5px; font-weight: 700; transition: transform 120ms var(--ease); }
  #codeGo:active { transform: scale(0.97); }

  /* ── 라이브 ── */
  #live { position: absolute; inset: 0; background: #000; }
  #vf { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
  .vf-grid { position: absolute; inset: 0; pointer-events: none; opacity: 0.16;
    background:
      linear-gradient(to right, transparent calc(33.33% - 0.5px), rgba(255,255,255,0.55) 33.33%, transparent calc(33.33% + 0.5px)),
      linear-gradient(to right, transparent calc(66.66% - 0.5px), rgba(255,255,255,0.55) 66.66%, transparent calc(66.66% + 0.5px)),
      linear-gradient(to bottom, transparent calc(33.33% - 0.5px), rgba(255,255,255,0.55) 33.33%, transparent calc(33.33% + 0.5px)),
      linear-gradient(to bottom, transparent calc(66.66% - 0.5px), rgba(255,255,255,0.55) 66.66%, transparent calc(66.66% + 0.5px));
  }
  .bar-top {
    position: absolute; top: 0; left: 0; right: 0; z-index: 4;
    display: flex; align-items: center; gap: 8px;
    padding: calc(var(--sat) + 12px) 16px 30px;
    background: linear-gradient(rgba(6, 7, 10, 0.66), rgba(6, 7, 10, 0));
  }
  .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 7px 12px; font-size: 12px; font-weight: 700; background: rgba(10, 12, 16, 0.55); border: 1px solid var(--line); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  .pill-live { color: #fff; }
  .pill-live i { width: 7px; height: 7px; border-radius: 999px; background: var(--red); animation: breathe 1.6s ease-in-out infinite; }
  #connState { color: var(--dim); transition: color 200ms ease; }
  #connState.ok { color: var(--green); }
  #connState.warn { color: var(--amber); }
  /* 종료는 셔터 오른쪽에 앉는다 — 촬영을 끝내는 손가락은 이미 거기에 있다.
     흰 원(셔터)과 헷갈리지 않게 속을 채우지 않고, 체크 하나로만 말한다. */
  #endBtn {
    justify-self: center; width: 58px; height: 58px; border-radius: 999px;
    display: grid; place-items: center; color: #fff;
    background: rgba(10, 12, 16, 0.5); border: 1px solid rgba(255, 255, 255, 0.36);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    transition: transform 120ms var(--ease), background 180ms ease, border-color 180ms ease;
  }
  #endBtn:active { transform: scale(0.92); background: rgba(60, 203, 139, 0.3); border-color: var(--green); }

  .caption {
    position: absolute; left: 14px; right: 14px; bottom: calc(var(--sab) + 148px); z-index: 4;
    display: none; justify-content: center; pointer-events: none;
  }
  .caption span {
    max-width: 100%; border-radius: 14px; padding: 9px 14px;
    background: rgba(8, 9, 12, 0.62); border: 1px solid var(--line);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--text);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .caption.dim span { color: var(--dim); font-weight: 500; }
  .caption.show { display: flex; }

  .bar-bottom {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 4;
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
    padding: 26px 26px calc(var(--sab) + 22px);
    background: linear-gradient(rgba(6, 7, 10, 0), rgba(6, 7, 10, 0.7));
  }
  .shots { display: inline-flex; align-items: center; gap: 10px; justify-self: start; }
  .shots img { width: 46px; height: 46px; border-radius: 12px; object-fit: cover; border: 1px solid rgba(255, 255, 255, 0.35); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45); }
  .shots b { font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .shots u { text-decoration: none; font-size: 11px; color: var(--faint); font-weight: 600; display: block; }

  #shutter { position: relative; width: 78px; height: 78px; border-radius: 999px; justify-self: center; }
  #shutter::before { content: ""; position: absolute; inset: 0; border-radius: 999px; border: 4px solid #fff; opacity: 0.92; }
  #shutter i { position: absolute; inset: 7px; border-radius: 999px; background: #fff; transition: transform 110ms var(--ease), background 160ms ease; }
  #shutter:active i { transform: scale(0.8); }
  #shutter:disabled i { background: rgba(255, 255, 255, 0.34); }
  #shutter:disabled::before { opacity: 0.4; }

  /* 마이크는 상태이지 동작이 아니다 — 상단 바의 다른 표시등 옆으로 올린다. */
  .mic { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 7px 12px; background: rgba(10, 12, 16, 0.55); border: 1px solid var(--line); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  .mic .bars { display: inline-flex; align-items: flex-end; gap: 2.5px; height: 14px; }
  .mic .bars i { width: 3px; height: 100%; border-radius: 2px; background: var(--green); transform: scaleY(0.35); transform-origin: bottom; }
  .mic.on .bars i { animation: barjump 900ms ease-in-out infinite; }
  .mic.on .bars i:nth-child(2) { animation-delay: 140ms; }
  .mic.on .bars i:nth-child(3) { animation-delay: 280ms; }
  .mic span { font-size: 11.5px; font-weight: 700; color: var(--dim); }
  .mic.off { opacity: 0.45; }
  .mic.off .bars i { background: var(--faint); }

  #flash { position: absolute; inset: 0; z-index: 6; background: #fff; opacity: 0; pointer-events: none; }
  #flash.go { animation: flashfx 300ms ease-out both; }

  #toast { position: absolute; left: 50%; bottom: calc(var(--sab) + 128px); transform: translateX(-50%); z-index: 8; border-radius: 12px; background: rgba(8, 9, 12, 0.86); border: 1px solid var(--line); color: var(--text); font-size: 13px; font-weight: 600; padding: 10px 16px; max-width: 84vw; text-align: center; }

  /* ── 종료 ── */
  #done { position: absolute; inset: 0; display: grid; place-items: center; padding: 26px; background: var(--bg); }
  .done-card { display: grid; gap: 12px; justify-items: center; text-align: center; }
  .done-glyph { width: 78px; height: 78px; border-radius: 999px; background: rgba(60, 203, 139, 0.14); border: 1px solid rgba(60, 203, 139, 0.4); color: var(--green); display: grid; place-items: center; animation: rise 480ms var(--ease) both; }
  #done h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.03em; animation: rise 480ms var(--ease) 60ms both; }
  #done p { margin: 0; color: var(--dim); font-size: 14.5px; line-height: 1.6; animation: rise 480ms var(--ease) 110ms both; }
  #done p b { color: var(--text); }
  #againBtn { margin-top: 8px; border-radius: 14px; border: 1px solid var(--line); padding: 12px 22px; font-size: 14px; font-weight: 700; color: var(--dim); animation: rise 480ms var(--ease) 160ms both; }
  /* 웹이 메모를 정리하는 동안 — 폰은 "끝났다"가 아니라 "넘어갔다"를 보여준다. */
  #done.is-working .done-glyph { color: var(--dim); background: rgba(255, 255, 255, 0.05); border-color: var(--line); }
  #done.is-working .done-glyph svg { display: none; }
  #done.is-working .done-glyph::after { content: ""; width: 28px; height: 28px; border-radius: 999px; border: 2.5px solid rgba(255, 255, 255, 0.16); border-top-color: #fff; animation: spin 900ms linear infinite; }
  #done.is-failed .done-glyph { color: var(--amber); background: rgba(247, 144, 9, 0.14); border-color: rgba(247, 144, 9, 0.4); }
  /* 등록된 상품으로 가는 문 — 데스크톱의 자동 새 탭은 팝업 차단에 막힐 수 있지만,
     이 순간 폰은 이미 손에 들려 있다. 여기서 여는 게 제일 확실하다. */
  #openBtn { margin-top: 4px; display: inline-block; border-radius: 14px; padding: 14px 24px; font-size: 15px; font-weight: 800; color: #06121f; background: var(--green); text-decoration: none; animation: rise 480ms var(--ease) both; }
  #openBtn:active { transform: scale(0.97); }
</style>
</head>
<body>

<div id="gate">
  <div class="gate-card">
    <span class="brand">Snap2Store<em>스튜디오 카메라</em></span>
    <span class="gate-glyph" aria-hidden="true">
      <svg width="42" height="42" viewBox="0 0 24 24" fill="none">
        <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1-1.6A1 1 0 0 1 9.5 4h5a1 1 0 0 1 .85.4L16.3 6h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z" stroke="#7a9cff" stroke-width="1.4"/>
        <circle cx="12" cy="12.4" r="3.2" stroke="#7a9cff" stroke-width="1.4"/>
      </svg>
    </span>
    <h1>이 폰이 카메라가 됩니다</h1>
    <span class="code-chip" id="codeChip"><b id="codeText"></b></span>
    <div id="codeEntry" hidden>
      <label for="codeInput">세션 코드</label>
      <input id="codeInput" inputmode="latin" autocapitalize="characters" autocomplete="one-time-code"
             autocorrect="off" spellcheck="false" maxlength="6" placeholder="ABC234" />
      <button id="codeGo" type="button">코드로 입장</button>
    </div>
    <div id="gateError" class="gate-error" hidden></div>
    <button id="startBtn" type="button">카메라 연결</button>
    <span class="gate-hint" id="gateHint">카메라·마이크 권한을 허용해 주세요</span>
  </div>
</div>

<div id="live" hidden>
  <video id="vf" autoplay playsinline muted></video>
  <div class="vf-grid" aria-hidden="true"></div>
  <header class="bar-top">
    <span class="pill pill-live"><i></i>LIVE</span>
    <span class="pill" id="connState">연결 중…</span>
    <div class="mic off" id="mic">
      <span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
      <span id="micLabel">준비 중</span>
    </div>
  </header>
  <div class="caption" id="caption"><span id="captionText"></span></div>
  <footer class="bar-bottom">
    <div class="shots" id="shots">
      <span><b id="shotCount">0</b><u>담긴 사진</u></span>
    </div>
    <button id="shutter" type="button" aria-label="촬영"><i></i></button>
    <button id="endBtn" type="button" aria-label="촬영 마치고 등록">
      <svg width="26" height="26" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5 6.2 11.7 13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </footer>
  <div id="flash"></div>
  <div id="toast" hidden></div>
</div>

<div id="done" hidden>
  <div class="done-card">
    <span class="done-glyph" aria-hidden="true">
      <svg width="34" height="34" viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6.2 11.7 13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <h1 id="doneTitle">웹으로 넘겼어요</h1>
    <p id="doneNote">이제 폰은 내려놓으셔도 돼요</p>
    <a id="openBtn" href="#" target="_blank" rel="noreferrer" hidden>등록된 상품 보기 ↗</a>
    <button id="againBtn" type="button">다시 촬영</button>
  </div>
</div>

<script>
(function () {
  "use strict";
  var SESSION_CODE = ${JSON.stringify(code)};
  var params = new URLSearchParams(location.search);
  var SIM = params.has("sim");

  var els = {};
  ["gate", "gateError", "startBtn", "codeText", "codeChip", "codeEntry", "codeInput", "codeGo",
   "gateHint", "live", "vf", "connState", "endBtn",
   "caption", "captionText", "shotCount", "shots", "shutter", "mic", "micLabel",
   "flash", "toast", "done", "doneTitle", "doneNote", "openBtn", "againBtn"].forEach(function (id) {
    els[id] = document.getElementById(id);
  });

  var state = {
    ws: null, wsReady: false, ended: false, parked: false, streaming: false,
    stream: null, actx: null, wakeLock: null,
    frameSeq: 0, photoSeq: 0, audioSeq: 0,
    shots: 0, trayMax: 10, trayFull: false,
    pumpTimer: 0, heartbeatTimer: 0, encodeBusy: false,
    netTier: 0, pressure: 0, goodSince: 0, lastFrameAt: 0,
    videoMode: "auto", encoder: null, codec: null, rafId: 0,
    forceKey: true, encodeSize: null, framesSinceKey: 0,
    retries: 0, captionTimer: 0, toastTimer: 0,
    lastThumbUrl: null, micOff: false
  };

  els.codeText.textContent = SESSION_CODE || "------";

  function fail(message) {
    els.gateError.textContent = message;
    els.gateError.hidden = false;
    els.startBtn.disabled = false;
  }

  if (!SESSION_CODE) {
    // QR 없이 들어온 경우 — 코드 6자리를 직접 받아 입장한다.
    els.codeChip.hidden = true;
    els.startBtn.hidden = true;
    els.gateHint.textContent = "웹 화면의 QR 아래에 코드가 함께 표시돼 있어요";
    els.codeEntry.hidden = false;
    var CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
    var enter = function () {
      var value = (els.codeInput.value || "").toUpperCase().replace(/\\s/g, "");
      if (!CODE_RE.test(value)) {
        fail("코드가 올바르지 않아요 — 6자리를 다시 확인해 주세요 (0·1·O·I 는 쓰이지 않습니다).");
        return;
      }
      location.href = "/phone?s=" + value + (SIM ? "&sim=1" : "");
    };
    els.codeGo.addEventListener("click", enter);
    els.codeInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") enter();
    });
    els.codeInput.addEventListener("input", function () {
      els.gateError.hidden = true;
      var value = els.codeInput.value.toUpperCase();
      if (els.codeInput.value !== value) els.codeInput.value = value;
    });
  } else if (!window.isSecureContext && !SIM && location.hostname !== "localhost") {
    fail("보안 연결(HTTPS)이 아니라 카메라를 열 수 없습니다. QR 의 주소 그대로 접속해 주세요.");
    els.startBtn.disabled = true;
  }

  /* ── 시작 ── */
  els.startBtn.addEventListener("click", function () {
    els.startBtn.disabled = true;
    els.gateError.hidden = true;
    start().catch(function (error) {
      var name = error && error.name;
      if (name === "NotAllowedError") {
        fail("카메라·마이크 권한이 거절됐어요. 브라우저 설정에서 허용한 뒤 다시 눌러 주세요.");
      } else if (name === "NotFoundError") {
        fail("사용할 수 있는 카메라를 찾지 못했습니다.");
      } else {
        fail("카메라를 여는 데 실패했습니다: " + (error && error.message ? error.message : error));
      }
    });
  });

  async function start() {
    await openCamera();
    connect();
    startPump();
    startAudio();
    requestWakeLock();
  }

  async function openCamera() {
    if (SIM) {
      state.stream = makeSimStream();
    } else {
      state.stream = await navigator.mediaDevices.getUserMedia({
        // 최고 프레임을 요청한다 — 기기가 30 만 주면 30 이 상한이지만, 파이프라인은 그대로 나른다.
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 120 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    }
    els.vf.srcObject = state.stream;
    try { await els.vf.play(); } catch (e) { /* 제스처 직후라 대부분 통과 */ }

    els.gate.hidden = true;
    els.done.hidden = true;
    els.live.hidden = false;
    state.streaming = true;
  }

  /** 촬영 재개 — 세션·WS 는 살아 있으므로 카메라와 펌프만 다시 연다. */
  async function relink() {
    if (!state.parked) return;
    state.parked = false;
    state.forceKey = true;
    state.framesSinceKey = 0;
    state.lastFrameAt = 0;
    state.encodeBusy = false;
    try {
      await openCamera();
    } catch (error) {
      state.parked = true;
      toast("카메라를 다시 열지 못했어요 — 권한을 확인해 주세요");
      return;
    }
    sendMsg({ t: "relink" });
    startPump();
    startAudio();
    requestWakeLock();
  }

  /* ── WebSocket ── */
  function wsUrl() {
    var proto = location.protocol === "https:" ? "wss" : "ws";
    return proto + "://" + location.host + "/link?role=phone&code=" + encodeURIComponent(SESSION_CODE);
  }

  function connect() {
    if (state.ended) return;
    var ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    state.ws = ws;

    ws.onopen = function () {
      state.wsReady = true;
      state.retries = 0;
      setConn("웹과 연결됨", "ok");
      // 하트비트 — Cloudflare 터널은 protocol ping/pong 을 끝단까지 넘기지 않는다.
      // 서버의 생존 판정이 보는 것은 "수신 트래픽"이므로 JSON 으로 직접 친다.
      window.clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = window.setInterval(function () {
        if (state.wsReady && state.ws && state.ws.readyState === 1) {
          try { state.ws.send(JSON.stringify({ t: "ping" })); } catch (e) {}
        }
      }, 10000);
    };

    ws.onmessage = function (event) {
      if (typeof event.data !== "string") return;
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      handleMessage(msg);
    };

    ws.onclose = function () {
      state.wsReady = false;
      window.clearInterval(state.heartbeatTimer);
      if (state.ended) return;
      if (state.retries >= 20) {
        setConn("연결 끊김", "warn");
        toast("웹과의 연결이 끊어졌습니다. 웹에서 세션을 다시 열어 주세요.");
        return;
      }
      setConn("재연결 중…", "warn");
      var delay = Math.min(4000, 400 * Math.pow(1.6, state.retries));
      state.retries += 1;
      setTimeout(connect, delay);
    };

    ws.onerror = function () { /* onclose 가 따른다 */ };
  }

  function handleMessage(msg) {
    switch (msg.t) {
      case "welcome":
        setConn(msg.peer ? "웹과 연결됨" : "웹 화면 대기 중…", msg.peer ? "ok" : "warn");
        if (msg.voice === "unavailable") setMic("off", "음성 꺼짐");
        else if (!state.micOff) setMic("idle", "듣는 중");
        break;
      case "peer":
        if (msg.role === "desktop") {
          setConn(msg.state === "joined" ? "웹과 연결됨" : "웹 화면 대기 중…", msg.state === "joined" ? "ok" : "warn");
          // 데스크톱이 새로 들어오면 디코더가 맨몸 — 코덱 정보와 키프레임부터 다시 준다.
          if (msg.state === "joined" && state.videoMode === "video" && !!state.codec && !!state.encodeSize) {
            sendMsg({ t: "video-config", codec: state.codec, width: state.encodeSize.w, height: state.encodeSize.h });
            state.forceKey = true;
          }
        }
        break;
      case "need-key":
        state.forceKey = true;
        break;
      case "force-jpeg":
        // 데스크톱에 WebCodecs 디코더가 없다 — 스틸 펌프로 내려간다.
        switchToJpeg("desktop has no decoder");
        break;
      case "tray":
        state.shots = typeof msg.count === "number" ? msg.count : state.shots;
        state.trayMax = typeof msg.max === "number" ? msg.max : state.trayMax;
        state.trayFull = Boolean(msg.full);
        els.shotCount.textContent = String(state.shots);
        els.shutter.disabled = state.trayFull;
        if (state.trayFull) toast("트레이가 가득 찼어요 (" + state.trayMax + "장)");
        break;
      case "voice":
        handleVoice(msg);
        break;
      case "end":
        finish(false);
        break;
      case "handoff":
        showHandoff(msg.state, msg.url);
        break;
      case "resume":
        // 웹이 "다시 폰을 들어 보였다"고 알려온다 — QR 재스캔 없이 카메라만 다시 연다.
        if (state.parked) void relink();
        break;
      default:
        break;
    }
  }

  function setConn(text, tone) {
    els.connState.textContent = text;
    els.connState.className = "pill" + (tone ? " " + tone : "");
  }

  /* ── 바이너리 전송: [kind u8][seq u32 LE][payload] ── */
  function sendFrame(kind, seq, payloadBuffer) {
    if (!state.wsReady || !state.ws || state.ws.readyState !== 1) return false;
    if (kind === 1 && state.ws.bufferedAmount > 250000) return false; // 라이브만 드랍 허용
    var payload = new Uint8Array(payloadBuffer);
    var out = new Uint8Array(5 + payload.byteLength);
    out[0] = kind;
    new DataView(out.buffer).setUint32(1, seq >>> 0, true);
    out.set(payload, 5);
    state.ws.send(out.buffer);
    return true;
  }

  /**
   * WYSIWYG 크롭 — 뷰파인더(object-fit: cover)가 화면에 실제로 보여 주는 영역만 계산한다.
   * 라이브 프레임과 셔터가 전부 이 크롭을 쓰므로 "폰에서 보는 것 = 웹에 뜨는 것 = 찍히는 것".
   */
  function viewfinderRect() {
    var vw = els.vf.videoWidth, vh = els.vf.videoHeight;
    var cw = els.vf.clientWidth || window.innerWidth;
    var ch = els.vf.clientHeight || window.innerHeight;
    if (!vw || !vh || !cw || !ch) return null;
    var screenAspect = cw / ch;
    var videoAspect = vw / vh;
    var sx = 0, sy = 0, sw = vw, sh = vh;
    if (videoAspect > screenAspect) {
      sw = Math.max(2, Math.round(vh * screenAspect));
      sx = Math.floor((vw - sw) / 2);
    } else if (videoAspect < screenAspect) {
      sh = Math.max(2, Math.round(vw / screenAspect));
      sy = Math.floor((vh - sh) / 2);
    }
    return { sx: sx, sy: sy, sw: sw, sh: sh };
  }

  /* ── 라이브 스트림 ──────────────────────────────────────────
     1순위: WebCodecs 하드웨어 인코더(H.264, 안되면 VP8) — 프레임당 수 KB 라 60fps 가 가능하다.
     미지원 기기·인코더 오류·데스크톱 디코더 부재 시 JPEG 스틸 펌프로 자동 폴백한다.
     양쪽 모두 업링크 적응 사다리를 쓴다 — "멈춘 고화질"보다 "흐르는 저화질"이 낫다. */
  var pumpCanvas = document.createElement("canvas");
  var pumpCtx = pumpCanvas.getContext("2d");

  var JPEG_TIERS = [
    { width: 900, quality: 0.55, intervalMs: 80 },
    { width: 720, quality: 0.45, intervalMs: 100 },
    { width: 560, quality: 0.35, intervalMs: 125 }
  ];
  // tier0 fps 120 = 인위적 상한 제거일 뿐, 실제 상한은 카메라 센서(웹 API 로 최대 60)와
  // 폰 rAF 주기다. 기기가 주는 만큼 그대로 나른다.
  var VIDEO_TIERS = [
    { long: 960, bitrate: 4500000, fps: 120 },
    { long: 720, bitrate: 1800000, fps: 30 },
    { long: 540, bitrate: 900000, fps: 24 }
  ];

  function sendMsg(obj) {
    if (state.ws && state.wsReady && state.ws.readyState === 1) {
      try { state.ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  /** 소켓 적체를 보고 사다리를 오르내린다. true = 이번 프레임은 보내지 말 것. */
  function ladderStep(now, tierCount, skipThreshold, goodThreshold) {
    var buffered = state.ws && state.ws.readyState === 1 ? state.ws.bufferedAmount : 0;
    if (buffered > skipThreshold) {
      state.goodSince = 0;
      state.pressure += 1;
      if (state.pressure >= 6 && state.netTier < tierCount - 1) {
        state.netTier += 1;
        state.pressure = 0;
        return "retier";
      }
      return "skip";
    }
    if (buffered < goodThreshold) {
      if (!state.goodSince) state.goodSince = now;
      else if (now - state.goodSince > 6000 && state.netTier > 0) {
        state.netTier -= 1;
        state.goodSince = now;
        return "retier";
      }
      if (state.pressure > 0) state.pressure -= 1;
    } else {
      state.goodSince = 0;
    }
    return "send";
  }

  function startPump() {
    if (typeof window.VideoEncoder === "function" && state.videoMode === "auto") {
      probeCodec().then(function (codec) {
        if (codec) { state.videoMode = "video"; startVideoPump(); }
        else { state.videoMode = "jpeg"; startJpegPump(); }
      });
      return;
    }
    // 재연결 — 코덱 협상은 이미 끝나 있다. 인코더는 죽었을 수 있으니 새로 세운다.
    if (state.videoMode === "video" && state.codec) {
      startVideoPump();
      return;
    }
    state.videoMode = "jpeg";
    startJpegPump();
  }

  /* ── WebCodecs 경로 ── */

  function probeCodec() {
    var candidates = ["avc1.42E01F", "vp8"];
    var index = 0;
    function tryNext() {
      if (index >= candidates.length) return Promise.resolve(null);
      var codec = candidates[index++];
      var config = { codec: codec, width: 1280, height: 720, bitrate: 2000000, framerate: 30 };
      if (codec.indexOf("avc1") === 0) config.avc = { format: "annexb" };
      return window.VideoEncoder.isConfigSupported(config).then(function (result) {
        if (result && result.supported) { state.codec = codec; return codec; }
        return tryNext();
      }, function () { return tryNext(); });
    }
    return tryNext();
  }

  function onEncodedChunk(chunk) {
    var out = new Uint8Array(1 + chunk.byteLength);
    out[0] = chunk.type === "key" ? 1 : 0;
    chunk.copyTo(out.subarray(1));
    state.frameSeq += 1;
    sendFrame(4, state.frameSeq, out.buffer);
  }

  function configureEncoder(w, h) {
    var tier = VIDEO_TIERS[state.netTier];
    if (!state.encoder) {
      state.encoder = new window.VideoEncoder({
        output: onEncodedChunk,
        error: function (error) {
          // 인코더가 죽으면 조용히 JPEG 로 내려간다 — 화면이 멎는 것보다 낫다.
          switchToJpeg("encoder error: " + (error && error.message ? error.message : error));
        }
      });
    }
    var config = {
      codec: state.codec, width: w, height: h,
      bitrate: tier.bitrate, framerate: tier.fps, latencyMode: "realtime"
    };
    if (state.codec.indexOf("avc1") === 0) config.avc = { format: "annexb" };
    state.encoder.configure(config);
    state.encodeSize = { w: w, h: h };
    state.forceKey = true;
    state.framesSinceKey = 0;
    sendMsg({ t: "video-config", codec: state.codec, width: w, height: h });
  }

  function startVideoPump() {
    var tick = function () {
      if (state.ended || state.videoMode !== "video") return;
      state.rafId = window.requestAnimationFrame(tick);
      if (!state.streaming || !state.wsReady || document.hidden) return;
      var tier = VIDEO_TIERS[state.netTier];
      var now = Date.now();
      if (now - state.lastFrameAt < 1000 / tier.fps - 3) return;
      var rect = viewfinderRect();
      if (!rect) return;

      var verdict = ladderStep(now, VIDEO_TIERS.length, 300000, 80000);
      if (verdict === "skip") return;

      // H.264 는 짝수 치수를 요구한다.
      var scale = Math.min(1, VIDEO_TIERS[state.netTier].long / Math.max(rect.sw, rect.sh));
      var w = Math.max(2, Math.floor((rect.sw * scale) / 2) * 2);
      var h = Math.max(2, Math.floor((rect.sh * scale) / 2) * 2);
      if (!state.encoder || !state.encodeSize || state.encodeSize.w !== w || state.encodeSize.h !== h || verdict === "retier") {
        try { configureEncoder(w, h); } catch (error) { switchToJpeg("configure 실패"); return; }
      }
      if (state.encoder.encodeQueueSize > 2) return; // 인코더가 밀리면 입력을 거른다

      if (pumpCanvas.width !== w || pumpCanvas.height !== h) { pumpCanvas.width = w; pumpCanvas.height = h; }
      pumpCtx.drawImage(els.vf, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
      var keyFrame = state.forceKey || state.framesSinceKey >= tier.fps * 2;
      try {
        var frame = new window.VideoFrame(pumpCanvas, { timestamp: now * 1000 });
        state.encoder.encode(frame, { keyFrame: keyFrame });
        frame.close();
      } catch (error) {
        switchToJpeg("encode 실패");
        return;
      }
      state.framesSinceKey = keyFrame ? 0 : state.framesSinceKey + 1;
      state.forceKey = false;
      state.lastFrameAt = now;
    };
    state.rafId = window.requestAnimationFrame(tick);
  }

  function switchToJpeg(reason) {
    if (state.videoMode === "jpeg") return;
    state.videoMode = "jpeg";
    window.cancelAnimationFrame(state.rafId);
    if (state.encoder) { try { state.encoder.close(); } catch (e) {} state.encoder = null; }
    state.netTier = 0; state.pressure = 0; state.goodSince = 0;
    startJpegPump();
  }

  /* ── JPEG 폴백 경로 ── */

  function startJpegPump() {
    window.clearInterval(state.pumpTimer);
    state.pumpTimer = window.setInterval(function () {
      if (!state.streaming || !state.wsReady || document.hidden || state.encodeBusy) return;
      var tier = JPEG_TIERS[state.netTier] || JPEG_TIERS[JPEG_TIERS.length - 1];
      var now = Date.now();
      if (now - state.lastFrameAt < tier.intervalMs) return;
      var rect = viewfinderRect();
      if (!rect) return;

      if (ladderStep(now, JPEG_TIERS.length, 250000, 60000) === "skip") return;
      tier = JPEG_TIERS[state.netTier];

      var scale = Math.min(1, tier.width / Math.max(rect.sw, rect.sh));
      var w = Math.max(2, Math.round(rect.sw * scale)), h = Math.max(2, Math.round(rect.sh * scale));
      if (pumpCanvas.width !== w || pumpCanvas.height !== h) { pumpCanvas.width = w; pumpCanvas.height = h; }
      pumpCtx.drawImage(els.vf, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
      state.lastFrameAt = now;
      state.encodeBusy = true;
      pumpCanvas.toBlob(function (blob) {
        if (!blob) { state.encodeBusy = false; return; }
        blob.arrayBuffer().then(function (buffer) {
          state.frameSeq += 1;
          sendFrame(1, state.frameSeq, buffer);
          state.encodeBusy = false;
        }, function () { state.encodeBusy = false; });
      }, "image/jpeg", tier.quality);
    }, 40);
  }

  /* ── 셔터 ── */
  els.shutter.addEventListener("click", function () {
    if (!state.streaming || state.trayFull) return;
    var id = ++state.photoSeq;
    els.flash.classList.remove("go");
    void els.flash.offsetWidth;
    els.flash.classList.add("go");
    if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) {} }
    if (state.ws && state.wsReady) state.ws.send(JSON.stringify({ t: "shutter", id: id }));

    capturePhoto().then(function (blob) {
      return normalizePhoto(blob);
    }).then(function (blob) {
      if (!blob) {
        if (state.ws && state.wsReady) state.ws.send(JSON.stringify({ t: "photo-fail", id: id }));
        toast("사진을 저장하지 못했어요");
        return;
      }
      showThumb(blob);
      return blob.arrayBuffer().then(function (buffer) { sendFrame(2, id, buffer); });
    }).catch(function () {
      if (state.ws && state.wsReady) state.ws.send(JSON.stringify({ t: "photo-fail", id: id }));
    });
  });

  /**
   * 셔터 원본 정규화 — 기기별 원본(4~12MB)을 그대로 쏘면 느린 업링크에서 라이브가
   * 수 초 얼어붙는다. 서버 파이프라인이 어차피 긴 변 2400px 로 줄이므로
   * 2000px · 0.85 재인코드는 산출물 품질을 깎지 않는다.
   */
  function normalizePhoto(blob) {
    if (!blob || typeof createImageBitmap !== "function") return Promise.resolve(blob);
    return createImageBitmap(blob).then(function (bitmap) {
      var long = Math.max(bitmap.width, bitmap.height);
      var scale = Math.min(1, 2000 / long);
      if (scale === 1 && blob.size <= 1200000) { bitmap.close(); return blob; }
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return new Promise(function (resolve) {
        canvas.toBlob(function (out) { resolve(out || blob); }, "image/jpeg", 0.85);
      });
    }).catch(function () { return blob; });
  }

  function capturePhoto() {
    // 셔터는 "뷰파인더에 보이는 그대로"를 저장한다. ImageCapture.takePhoto 원본은
    // 화각·비율이 화면과 달라 폰과 웹의 그림이 어긋난다 — 스트림 프레임을 뷰파인더
    // 크롭으로 풀해상 캡처하는 쪽이 정확하고, 기기별 멈춤 문제도 없다.
    var vw = els.vf.videoWidth, vh = els.vf.videoHeight;
    if (!vw || !vh) return Promise.resolve(null);
    var rect = viewfinderRect() || { sx: 0, sy: 0, sw: vw, sh: vh };
    var canvas = document.createElement("canvas");
    canvas.width = rect.sw;
    canvas.height = rect.sh;
    canvas.getContext("2d").drawImage(els.vf, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
    return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", 0.92); });
  }

  function showThumb(blob) {
    if (state.lastThumbUrl) URL.revokeObjectURL(state.lastThumbUrl);
    state.lastThumbUrl = URL.createObjectURL(blob);
    // 첫 촬영 전에는 썸네일 요소 자체가 없다 — src 없는 이미지 태그를 마크업에 두지 않고,
    // 촬영 blob URL 이 생긴 지금 이 시점에 만들어 바로 채운다.
    var thumb = document.getElementById("lastShotImg");
    if (!thumb) {
      thumb = document.createElement("img");
      thumb.id = "lastShotImg";
      thumb.alt = "";
      els.shots.insertBefore(thumb, els.shots.firstChild);
    }
    thumb.src = state.lastThumbUrl;
    thumb.animate(
      [{ transform: "scale(0.6)", opacity: 0.4 }, { transform: "scale(1)", opacity: 1 }],
      { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
  }

  /* ── 오디오 → PCM16 24kHz mono ── */
  async function startAudio() {
    var track = state.stream && state.stream.getAudioTracks ? state.stream.getAudioTracks()[0] : null;
    if (!track) { state.micOff = true; setMic("off", SIM ? "시뮬 모드" : "마이크 없음"); return; }
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      state.actx = new Ctor({ sampleRate: 24000 });
      await state.actx.resume();
      var source = state.actx.createMediaStreamSource(new MediaStream([track]));
      var workletSource =
        "class PcmChunker extends AudioWorkletProcessor {" +
        "  constructor() { super(); this.parts = []; this.total = 0; }" +
        "  process(inputs) {" +
        "    var channel = inputs[0] && inputs[0][0];" +
        "    if (channel) {" +
        "      this.parts.push(new Float32Array(channel));" +
        "      this.total += channel.length;" +
        "      if (this.total >= 2400) {" + // 24kHz 기준 100ms
        "        var all = new Float32Array(this.total); var offset = 0;" +
        "        for (var i = 0; i < this.parts.length; i++) { all.set(this.parts[i], offset); offset += this.parts[i].length; }" +
        "        this.parts = []; this.total = 0;" +
        "        this.port.postMessage(all, [all.buffer]);" +
        "      }" +
        "    }" +
        "    return true;" +
        "  }" +
        "}" +
        "registerProcessor('pcm-chunker', PcmChunker);";
      var moduleUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
      await state.actx.audioWorklet.addModule(moduleUrl);
      URL.revokeObjectURL(moduleUrl);
      var node = new AudioWorkletNode(state.actx, "pcm-chunker");
      node.port.onmessage = function (event) {
        var f32 = event.data;
        var resampled = state.actx.sampleRate === 24000 ? f32 : resampleLinear(f32, state.actx.sampleRate, 24000);
        var pcm = floatToPcm16(resampled);
        state.audioSeq += 1;
        sendFrame(3, state.audioSeq, pcm.buffer);
      };
      source.connect(node);
      // destination 에 연결하지 않는다 — 스피커로 에코가 나가면 안 된다.
      setMic("idle", "듣는 중");
    } catch (error) {
      state.micOff = true;
      setMic("off", "음성 사용 불가");
    }
  }

  function resampleLinear(input, fromRate, toRate) {
    var ratio = fromRate / toRate;
    var length = Math.floor(input.length / ratio);
    var output = new Float32Array(length);
    for (var i = 0; i < length; i++) {
      var position = i * ratio;
      var index = Math.floor(position);
      var frac = position - index;
      var a = input[index] || 0;
      var b = index + 1 < input.length ? input[index + 1] : a;
      output[i] = a + (b - a) * frac;
    }
    return output;
  }

  function floatToPcm16(input) {
    var output = new Int16Array(input.length);
    for (var i = 0; i < input.length; i++) {
      var sample = Math.max(-1, Math.min(1, input[i]));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  function setMic(mode, label) {
    els.micLabel.textContent = label;
    els.mic.className = "mic" + (mode === "on" ? " on" : mode === "off" ? " off" : "");
  }

  /* ── 음성 이벤트 → 자막 ── */
  var captionBuffer = "";
  function handleVoice(msg) {
    if (msg.kind === "speech") {
      if (!state.micOff) setMic(msg.active ? "on" : "idle", msg.active ? "받아 적는 중" : "듣는 중");
      if (msg.active) captionBuffer = "";
      return;
    }
    if (msg.kind === "unavailable") { state.micOff = true; setMic("off", "음성 꺼짐"); return; }
    if (msg.kind === "delta") {
      captionBuffer += msg.text || "";
      showCaption(captionBuffer, true);
      return;
    }
    if (msg.kind === "final") {
      captionBuffer = "";
      showCaption(msg.text || "", false);
      window.clearTimeout(state.captionTimer);
      state.captionTimer = window.setTimeout(function () {
        els.caption.classList.remove("show");
      }, 2600);
    }
  }

  function showCaption(text, interim) {
    if (!text) return;
    window.clearTimeout(state.captionTimer);
    els.captionText.textContent = text;
    els.caption.classList.add("show");
    els.caption.classList.toggle("dim", Boolean(interim));
  }

  /* ── 종료 = 파킹 ──
     카메라·마이크·펌프만 내리고 WS 는 살려 둔다. "다시 연결"이 QR 재스캔 없이
     같은 세션으로 즉시 복귀한다. */
  els.endBtn.addEventListener("click", function () { finish(true); });
  els.againBtn.addEventListener("click", function () { void relink(); });

  function finish(byMe) {
    if (state.parked) return;
    state.parked = true;
    if (byMe) sendMsg({ t: "end" });
    stopCapture();
    els.done.classList.remove("is-working", "is-failed");
    els.openBtn.hidden = true;
    els.doneTitle.textContent = "웹으로 넘겼어요";
    els.doneNote.textContent = "사진 " + state.shots + "장 · 이제 폰은 내려놓으셔도 돼요";
    els.live.hidden = true;
    els.gate.hidden = true;
    els.done.hidden = false;
  }

  /* ── 넘긴 뒤의 진행 ──
     종료를 누르면 웹은 말과 사진을 함께 읽고 그대로 등록까지 간다. 폰에서 보면
     아무 일도 일어나지 않은 것처럼 보이므로, 그 진행을 여기로 되받아 보여준다. */
  function showHandoff(phase, url) {
    if (!phase || els.done.hidden) return;
    els.done.classList.toggle("is-working", phase === "reading" || phase === "registering");
    els.done.classList.toggle("is-failed", phase === "failed");
    if (phase === "reading") {
      els.doneTitle.textContent = "말과 사진을 함께 읽는 중";
      els.doneNote.textContent = "사진 " + state.shots + "장으로 등록 메모를 씁니다";
    } else if (phase === "registering") {
      els.doneTitle.textContent = "등록하는 중";
      els.doneNote.textContent = "에이전트가 상품을 만들고 있어요";
    } else if (phase === "done") {
      els.doneTitle.textContent = "등록이 끝났어요";
      els.doneNote.textContent = "스마트스토어에 올라갔습니다";
      if (url) {
        els.openBtn.href = url;
        els.openBtn.hidden = false;
      }
    } else if (phase === "failed") {
      els.doneTitle.textContent = "등록을 시작하지 못했어요";
      els.doneNote.textContent = "웹 화면에서 확인해 주세요";
    }
  }

  function stopCapture() {
    state.streaming = false;
    window.clearInterval(state.pumpTimer);
    window.cancelAnimationFrame(state.rafId);
    if (state.encoder) { try { state.encoder.close(); } catch (e) {} state.encoder = null; }
    state.encodeSize = null;
    if (state.stream) state.stream.getTracks().forEach(function (track) { try { track.stop(); } catch (e) {} });
    state.stream = null;
    els.vf.srcObject = null;
    if (state.actx) { try { state.actx.close(); } catch (e) {} state.actx = null; }
    if (state.wakeLock) { try { state.wakeLock.release(); } catch (e) {} state.wakeLock = null; }
  }

  /* ── 잠금 방지 ── */
  async function requestWakeLock() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        state.wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (e) { /* 조명이 꺼질 뿐 치명적이지 않다 */ }
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !state.ended) requestWakeLock();
  });

  /* ── 토스트 ── */
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () { els.toast.hidden = true; }, 2600);
  }

  /* ── 시뮬 스트림 (QA: /phone?s=CODE&sim=1) ── */
  function makeSimStream() {
    var canvas = document.createElement("canvas");
    canvas.width = 1280; canvas.height = 720;
    var ctx = canvas.getContext("2d");
    var t = 0;
    window.setInterval(function () {
      t += 0.016;
      var gradient = ctx.createLinearGradient(0, 0, 1280, 720);
      gradient.addColorStop(0, "hsl(" + ((t * 26) % 360) + " 45% 16%)");
      gradient.addColorStop(1, "hsl(" + ((t * 26 + 90) % 360) + " 42% 30%)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1280, 720);
      ctx.save();
      ctx.translate(640 + Math.sin(t) * 140, 380 + Math.cos(t * 0.7) * 46);
      ctx.rotate(Math.sin(t * 0.5) * 0.08);
      ctx.fillStyle = "#ece6da";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-150, -95, 300, 190, 22); else ctx.rect(-150, -95, 300, 190);
      ctx.fill();
      ctx.fillStyle = "#20242c";
      ctx.font = "700 30px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("SIM CAMERA", 0, 8);
      ctx.font = "500 17px system-ui";
      ctx.fillText(new Date().toLocaleTimeString(), 0, 42);
      ctx.restore();
    }, 33);
    return canvas.captureStream(30);
  }
})();
</script>
</body>
</html>`;
}
