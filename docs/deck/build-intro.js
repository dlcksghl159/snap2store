const pptxgen = require("pptxgenjs");

/*
  Snap2Store — 해커톤 발표 앞 3장 (표지 + 배경 2장).
  색은 제품이 실제로 쓰는 팔레트를 그대로 가져온다: 잉크·블루·네이버 그린.
  모티프는 제품의 히어로 한 줄(Snap → N Smartstore)과 둥근 카드.
*/
const INK = "191F28";
const INK_SOFT = "333D4B";
const MUTED = "4E5968";
const FAINT = "8B95A1";
const LINE = "E5E8EB";
const PAPER = "FFFFFF";
const SOFT = "F7F8FA";
const BLUE = "3160F0";
const GREEN = "03C75A";

const FONT = "Apple SD Gothic Neo";

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pres.author = "Snap2Store";
pres.title = "Snap2Store — YAI x OpenAI AGENT:24";

const W = 10;
const H = 5.625;

/*
  pptxgenjs 는 캔버스를 벗어난 좌표를 잘라 주지 않고 그대로 쓴다 — 도형이 슬라이드
  밖에 놓여도 조용히 성공한다. 이 환경엔 렌더러가 없어 눈으로 볼 수 없으므로,
  경계를 넘으면 빌드를 실패시킨다.

  한글은 대체로 전각이라 글자당 폭이 폰트 크기와 거의 같다. 그 근사로 한 줄이
  상자를 넘치는지도 같이 잡는다 (라틴 문자는 0.55배로 센다).
*/
function guard(slide, name) {
  const wrap = (fn, kind) => (opts) => {
    const { x = 0, y = 0, w = 0, h = 0 } = opts;
    if (x < 0 || y < 0 || x + w > W + 1e-6 || y + h > H + 1e-6) {
      throw new Error(`${name}: ${kind} 가 캔버스를 벗어남 (x=${x} y=${y} w=${w} h=${h})`);
    }
    return fn(opts);
  };
  const rawText = slide.addText.bind(slide);
  const rawShape = slide.addShape.bind(slide);
  slide.addShape = (type, opts) => wrap((o) => rawShape(type, o), "shape")(opts);
  slide.addText = (text, opts) => {
    wrap(() => {}, "text")(opts);
    const size = opts.fontSize ?? 18;
    const widest = String(text)
      .split("\n")
      .reduce((max, line) => {
        const units = [...line].reduce((sum, ch) => sum + (/[ᄀ-퟿　-〿]/.test(ch) ? 1 : 0.55), 0);
        return Math.max(max, units * size);
      }, 0);
    const avail = (opts.w - (opts.margin === 0 ? 0 : 0.2)) * 72;
    if (widest > avail) {
      console.warn(
        `  ⚠ ${name}: "${String(text).slice(0, 24)}…" 한 줄이 ${(widest / 72).toFixed(2)}in 로 상자(${opts.w}in)보다 넓음 — 줄바꿈될 수 있음`,
      );
    }
    return rawText(text, opts);
  };
  return slide;
}

/* ───────────────── 1. 표지 (다크) ───────────────── */
const s1 = guard(pres.addSlide(), "표지");
s1.background = { color: INK };

s1.addText("YAI  ×  OpenAI      AGENT:24", {
  x: 0.75, y: 0.62, w: 6, h: 0.3,
  fontFace: FONT, fontSize: 12, bold: true, color: FAINT, charSpacing: 3, margin: 0,
});

s1.addText("Snap2Store", {
  x: 0.75, y: 1.15, w: 8.5, h: 1.15,
  fontFace: FONT, fontSize: 60, bold: true, color: PAPER, charSpacing: -1.5, margin: 0,
});

// 제품의 히어로 한 줄을 그대로 표지에 세운다 — 읽는 문장이 아니라 보는 그림.
s1.addText("Snap", {
  x: 0.75, y: 2.5, w: 1.6, h: 0.62,
  fontFace: FONT, fontSize: 30, bold: true, color: PAPER, margin: 0, valign: "middle",
});
s1.addShape(pres.ShapeType.line, {
  x: 2.34, y: 2.81, w: 1.0, h: 0,
  line: { color: BLUE, width: 2.25, endArrowType: "triangle" },
});
s1.addShape(pres.ShapeType.roundRect, {
  x: 3.5, y: 2.58, w: 0.46, h: 0.46,
  fill: { color: GREEN }, rectRadius: 0.12, line: { color: GREEN, width: 0 },
});
s1.addText("N", {
  x: 3.5, y: 2.58, w: 0.46, h: 0.46,
  fontFace: FONT, fontSize: 20, bold: true, color: PAPER, align: "center", valign: "middle", margin: 0,
});
s1.addText("Smartstore", {
  x: 4.08, y: 2.5, w: 3.6, h: 0.62,
  fontFace: FONT, fontSize: 30, bold: true, color: PAPER, margin: 0, valign: "middle",
});

s1.addText("사진만 올리면 상품명 · 가격 · 상세페이지까지 만들어 스마트스토어에 등록합니다", {
  x: 0.75, y: 3.42, w: 8.2, h: 0.36,
  fontFace: FONT, fontSize: 15, color: "C3CAD4", margin: 0,
});

s1.addText("사람은 첫 입력 이후 아무것도 하지 않습니다", {
  x: 0.75, y: 4.42, w: 8.2, h: 0.36,
  fontFace: FONT, fontSize: 14, bold: true, color: BLUE, margin: 0,
});

s1.addNotes(
  "Snap2Store 입니다. 팔 물건을 사진 찍어 올리면 자율 에이전트가 네이버 스마트스토어 등록을 끝까지 수행합니다. 사람은 첫 입력 이후 아무것도 하지 않습니다.",
);

/* ───────────────── 2. 배경 ① — 열 칸 ───────────────── */
const s2 = guard(pres.addSlide(), "배경1");
s2.background = { color: PAPER };

// 줄바꿈은 폭에 맡기지 않고 직접 끊는다 — 좁은 칼럼에서 어디서 끊길지 모르는 제목은 사고다.
s2.addText("상품 하나를 살리려면\n열 칸이 전부 차야 합니다", {
  x: 0.62, y: 0.5, w: 4.9, h: 1.5,
  fontFace: FONT, fontSize: 28, bold: true, color: INK, charSpacing: -0.8,
  lineSpacing: 38, margin: 0,
});

s2.addText("하나라도 비면 상품이 노출되지 않거나\n등록 자체가 거절됩니다.", {
  x: 0.62, y: 2.12, w: 4.9, h: 0.7,
  fontFace: FONT, fontSize: 14, color: MUTED, lineSpacing: 22, margin: 0,
});

// 큰 숫자 콜아웃
s2.addText("10", {
  x: 0.62, y: 3.0, w: 1.3, h: 1.0,
  fontFace: FONT, fontSize: 66, bold: true, color: BLUE, margin: 0, valign: "middle",
});
s2.addText("개인 판매자가\n등록을 포기하는 이유", {
  x: 1.92, y: 3.12, w: 3.2, h: 0.8,
  fontFace: FONT, fontSize: 14, bold: true, color: INK_SOFT, lineSpacing: 21, margin: 0, valign: "middle",
});

// 열 칸 — 2열 × 5행 카드
const FIELDS = [
  "대표 이미지", "추가 컷",
  "상품명", "카테고리",
  "판매가", "상세페이지",
  "검색 태그", "원산지",
  "KC 인증", "정보제공고시",
];
const gx = 5.86;
const gy = 0.72;
const cw = 1.72;
const ch = 0.66;
const gap = 0.14;
FIELDS.forEach((label, i) => {
  const col = i % 2;
  const row = Math.floor(i / 2);
  const x = gx + col * (cw + gap);
  const y = gy + row * (ch + gap);
  s2.addShape(pres.ShapeType.roundRect, {
    x, y, w: cw, h: ch,
    fill: { color: SOFT }, rectRadius: 0.1, line: { color: LINE, width: 1 },
  });
  s2.addText(label, {
    x, y, w: cw, h: ch,
    fontFace: FONT, fontSize: 12.5, bold: true, color: INK_SOFT,
    align: "center", valign: "middle", margin: 0,
  });
});

s2.addNotes(
  "스마트스토어 상품 하나를 살리려면 이 열 칸이 전부 채워져야 합니다. 대표 이미지부터 정보제공고시까지. 개인 판매자는 바로 이 열 칸 때문에 등록을 포기합니다.",
);

/* ───────────────── 3. 배경 ② — 순서 ───────────────── */
const s3 = guard(pres.addSlide(), "배경2");
s3.background = { color: PAPER };

s3.addText("더 어려운 건 칸이 아니라 순서입니다", {
  x: 0.62, y: 0.5, w: 8.8, h: 0.55,
  fontFace: FONT, fontSize: 30, bold: true, color: INK, charSpacing: -0.8, margin: 0,
});

s3.addText("칸들은 서로 물려 있습니다. 앞을 정하지 못하면 뒤를 채울 수 없습니다.", {
  x: 0.62, y: 1.12, w: 8.8, h: 0.32,
  fontFace: FONT, fontSize: 14, color: MUTED, margin: 0,
});

// 의존 사슬 — 세 칸이 화살표로 이어진다
const CHAIN = [
  { t: "상품 정체", d: "이게 무슨 물건인가" },
  { t: "카테고리", d: "어느 매대에 놓이는가" },
  { t: "고시 · KC", d: "무엇을 표시해야 하는가" },
];
const bx = 0.62;
const by = 1.78;
const bw = 2.62;
const bh = 1.12;
const bgap = 0.44;
CHAIN.forEach((step, i) => {
  const x = bx + i * (bw + bgap);
  s3.addShape(pres.ShapeType.roundRect, {
    x, y: by, w: bw, h: bh,
    fill: { color: SOFT }, rectRadius: 0.12, line: { color: LINE, width: 1 },
  });
  s3.addText(step.t, {
    x: x + 0.22, y: by + 0.2, w: bw - 0.44, h: 0.36,
    fontFace: FONT, fontSize: 17, bold: true, color: INK, margin: 0,
  });
  s3.addText(step.d, {
    x: x + 0.22, y: by + 0.6, w: bw - 0.44, h: 0.32,
    fontFace: FONT, fontSize: 12, color: MUTED, margin: 0,
  });
  if (i < CHAIN.length - 1) {
    s3.addShape(pres.ShapeType.line, {
      x: x + bw + 0.08, y: by + bh / 2, w: bgap - 0.16, h: 0,
      line: { color: BLUE, width: 2, endArrowType: "triangle" },
    });
  }
});

s3.addText("시장에서 실제로 쓰는 어휘를 알아야 검색되는 상품명을 쓸 수 있고,\n카테고리가 정해져야 고시 유형과 KC 대상 여부가 나옵니다.", {
  x: 0.62, y: 3.15, w: 8.76, h: 0.7,
  fontFace: FONT, fontSize: 13.5, color: MUTED, lineSpacing: 22, margin: 0,
});

// 결론 카드 (다크)
s3.addShape(pres.ShapeType.roundRect, {
  x: 0.62, y: 4.2, w: 8.76, h: 0.92,
  fill: { color: INK }, rectRadius: 0.14, line: { color: INK, width: 0 },
});
s3.addText("이 의존 그래프를 사람 대신 밟는 것이, 이 에이전트의 일입니다.", {
  x: 1.0, y: 4.2, w: 8.0, h: 0.92,
  fontFace: FONT, fontSize: 17, bold: true, color: PAPER, valign: "middle", margin: 0,
});

s3.addNotes(
  "그런데 더 어려운 건 칸의 개수가 아니라 순서입니다. 상품 정체가 확정돼야 카테고리를 찾을 수 있고, 카테고리가 정해져야 고시 유형과 KC 대상 여부가 나옵니다. 이 의존 그래프를 사람 대신 밟는 것이 이 에이전트가 하는 일입니다.",
);

const out = process.argv[2] || "snap2store-intro.pptx";
pres.writeFile({ fileName: out }).then(() => console.log("wrote", out));
