/**
 * 세컨드 화면 — 빌드 파이프라인에 넣지 않는다.
 * Express 가 문자열 상수로 직접 응답하는 단일 HTML이다: Vite 빌드 실패가 게이트를 죽이면 안 된다.
 *
 * 스펙 요구사항(03 §6)을 전부 유지한 채 심사 가독성을 위한 세 가지를 더했다:
 *  · 채널 칩이 실시간 건수를 세고, 클릭하면 그 채널만 남긴다(필터)
 *  · 위로 스크롤하면 자동 스크롤이 멈추고 "새 이벤트 N" 알약이 뜬다 — 심사 중 한 줄을 붙잡고 읽을 수 있다
 *  · 새 행은 좌측에서 4px 밀려 들어오며 채널색 광선이 1회 스쳐 지나간다 (prefers-reduced-motion 이면 없음)
 */
export const STREAM_PAGE_HTML = String.raw`<!doctype html><html lang="ko"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="dark"/>
<title>Snap2Store — Raw API Stream</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23101319'/%3E%3Ccircle cx='32' cy='30' r='13' fill='none' stroke='%23ffb454' stroke-width='5'/%3E%3Ccircle cx='32' cy='30' r='4.5' fill='%23ffb454'/%3E%3Crect x='18' y='46' width='28' height='5' rx='2.5' fill='%23ffffff'/%3E%3C/svg%3E"/>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0c0f15;color:#d7dce2;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;}
header{position:sticky;top:0;z-index:2;background:rgba(12,15,21,.94);backdrop-filter:blur(6px);border-bottom:1px solid rgba(255,255,255,.09);padding:12px 18px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;}
header b{color:#fff;font-size:13px;letter-spacing:.12em;display:flex;align-items:baseline;}
header b i{font-style:normal;color:#ffb454;margin-left:10px;font-size:10.5px;letter-spacing:.2em;font-weight:600;}
#stat{color:#8d95a5;font-size:11px;display:flex;align-items:center;gap:7px;}
#dot{width:6px;height:6px;border-radius:50%;background:#4b5560;flex:0 0 auto;}
#dot.on{background:#2bd07e;box-shadow:0 0 0 0 rgba(43,208,126,.55);animation:pulse 2.4s var(--e) infinite;}
#dot.off{background:#ff5c4d;}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(43,208,126,.5)}70%{box-shadow:0 0 0 7px rgba(43,208,126,0)}100%{box-shadow:0 0 0 0 rgba(43,208,126,0)}}
#legend{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;}
#legend span{font-size:9.5px;letter-spacing:.08em;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:3px 8px;cursor:pointer;user-select:none;transition:background .16s ease,border-color .16s ease,opacity .16s ease;display:inline-flex;gap:6px;align-items:center;}
#legend span:hover{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.24);}
#legend span.mute{opacity:.3;}
#legend span u{text-decoration:none;color:#727c88;font-size:9.5px;min-width:1ch;text-align:right;}
#feed{padding:12px 18px 56px;}
.ev{display:flex;gap:10px;padding:3.5px 0;border-bottom:1px solid rgba(255,255,255,.045);align-items:baseline;position:relative;}
.ev.in{animation:slide .34s var(--e) both;}
.ev.in::before{content:"";position:absolute;inset:-1px auto -1px -18px;width:2px;background:currentColor;opacity:.85;animation:fade .9s var(--e) forwards;}
@keyframes slide{from{opacity:0;transform:translate3d(-4px,0,0)}to{opacity:1;transform:none}}
@keyframes fade{to{opacity:0}}
.t{color:#4b5560;flex:0 0 62px;}
.ch{flex:0 0 92px;font-weight:700;}
.openai_raw{color:#6e9bff;}
.tool_call{color:#ffb454;}
.tool_result{color:#2bd07e;}
.milestone{color:#4fc3dd;}
.status{color:#8d95a5;}
.image{color:#d78cff;}
.error{color:#ff5c4d;}
.lb{color:#e6e9ee;flex:0 0 auto;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pl{color:#727c88;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
#jump{position:fixed;left:50%;bottom:22px;transform:translate3d(-50%,14px,0);opacity:0;pointer-events:none;background:#1b2029;border:1px solid rgba(255,255,255,.16);color:#e6e9ee;border-radius:999px;padding:7px 15px;font-size:11px;letter-spacing:.04em;cursor:pointer;transition:opacity .2s ease,transform .28s var(--e);z-index:3;}
#jump.show{opacity:1;transform:translate3d(-50%,0,0);pointer-events:auto;}
#jump:hover{background:#242a35;}
:root{--e:cubic-bezier(.22,1,.36,1);}
@media (prefers-reduced-motion:reduce){*,*::before{animation:none!important;transition-duration:.01ms!important;}}
@media (max-width:640px){.lb{max-width:26%}.ch{flex:0 0 76px}#legend{width:100%;margin-left:0}}
</style></head><body>
<header><b>SNAP2STORE<i>RAW API STREAM</i></b><span id="stat"><span id="dot"></span><span id="statText">connecting…</span></span>
<div id="legend">
<span class="tool_call" data-ch="tool_call">tool_call<u>0</u></span><span class="tool_result" data-ch="tool_result">tool_result<u>0</u></span><span class="openai_raw" data-ch="openai_raw">openai_raw<u>0</u></span><span class="image" data-ch="image">image<u>0</u></span><span class="milestone" data-ch="milestone">milestone<u>0</u></span><span class="status" data-ch="status">status<u>0</u></span><span class="error" data-ch="error">error<u>0</u></span>
</div>
</header>
<div id="feed"></div>
<button id="jump" type="button">새 이벤트 <span id="pending">0</span> ↓</button>
<script>
var feed=document.getElementById("feed"),statText=document.getElementById("statText"),dot=document.getElementById("dot");
var jump=document.getElementById("jump"),pendingEl=document.getElementById("pending");
var n=0,pending=0,stick=true,seen=Object.create(null),counts=Object.create(null),muted=Object.create(null);

Array.prototype.forEach.call(document.querySelectorAll("#legend span"),function(chip){
  chip.addEventListener("click",function(){
    var ch=chip.getAttribute("data-ch");
    muted[ch]=!muted[ch];
    chip.classList.toggle("mute",!!muted[ch]);
    Array.prototype.forEach.call(feed.children,function(row){
      if(row.getAttribute("data-ch")===ch)row.style.display=muted[ch]?"none":"";
    });
  });
});

function atBottom(){return window.innerHeight+window.scrollY>=document.body.offsetHeight-40;}
window.addEventListener("scroll",function(){
  stick=atBottom();
  if(stick){pending=0;jump.classList.remove("show");}
},{passive:true});
jump.addEventListener("click",function(){stick=true;pending=0;jump.classList.remove("show");window.scrollTo(0,document.body.scrollHeight);});

function bump(ch){
  counts[ch]=(counts[ch]||0)+1;
  var chip=document.querySelector('#legend span[data-ch="'+ch+'"] u');
  if(chip)chip.textContent=counts[ch]>9999?"9k+":String(counts[ch]);
}

var es=new EventSource("/api/stream");
es.onopen=function(){dot.className="on";statText.textContent="live";};
es.onerror=function(){dot.className="off";statText.textContent="reconnecting…";};
es.addEventListener("live",function(m){
  var e;try{e=JSON.parse(m.data);}catch(err){return;}
  // 재연결 시 서버가 백로그를 재전송한다 — seq 로 중복을 건다.
  if(typeof e.seq==="number"){if(seen[e.seq])return;seen[e.seq]=1;}
  n++;statText.textContent="live · "+n.toLocaleString()+" events";
  bump(e.channel);

  var row=document.createElement("div");
  row.className="ev in "+e.channel;
  row.setAttribute("data-ch",e.channel);
  if(muted[e.channel])row.style.display="none";
  var t=document.createElement("span");t.className="t";t.textContent=String(e.at).slice(11,19);
  var ch=document.createElement("span");ch.className="ch "+e.channel;ch.textContent=e.channel;
  var lb=document.createElement("span");lb.className="lb";lb.textContent=e.label;
  var pl=document.createElement("span");pl.className="pl";
  try{pl.textContent=e.payload==null?"":JSON.stringify(e.payload);}catch(err){pl.textContent="";}
  row.appendChild(t);row.appendChild(ch);row.appendChild(lb);row.appendChild(pl);
  feed.appendChild(row);
  if(feed.childElementCount>800)feed.removeChild(feed.firstChild);

  if(stick){window.scrollTo(0,document.body.scrollHeight);}
  else{pending++;pendingEl.textContent=pending>999?"999+":String(pending);jump.classList.add("show");}
});
</script></body></html>`;
