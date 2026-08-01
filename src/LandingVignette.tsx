import { useEffect, useMemo, useState } from "react";

/**
 * 랜딩 자동 재생 비네트 — "사진 한 장 → 등록안 조립 → 스마트스토어"를 4페이즈로 반복 재생한다.
 * 스테이지와 같은 시각 언어(미니 브라우저 틀 + 슬롯 장착)를 미리 보여줘,
 * 관객이 데모 본편을 읽는 법을 랜딩에서 학습하게 한다.
 *
 * ⚠ 여기 쓰는 이미지·값은 전부 실제 파이프라인 산출물이어야 한다. 홍보용 가짜 데이터 금지.
 *   `public/showcase/manifest.json` 에 실런 결과물을 넣는다. 자산이 없으면 가짜로 채우지 않고
 *   해당 행을 비운다 — 빈 슬롯도 자리를 잡고 있어야 레이아웃 구멍으로 읽히지 않는다.
 */

type Phase = "photo" | "build" | "stamp" | "rest";

const PHASE_MS: Record<Phase, number> = { photo: 2600, build: 4600, stamp: 2600, rest: 1500 };
const ORDER: Phase[] = ["photo", "build", "stamp", "rest"];

const CAPTION: Record<Phase, string> = {
  photo: "방금 찍은 사진 한 장을 올리면",
  build: "에이전트가 등록안을 통째로 조립하고",
  stamp: "규정 검증을 거쳐 스마트스토어에 등록합니다",
  rest: "규정 검증을 거쳐 스마트스토어에 등록합니다",
};

/** 상품 등록을 해본 적 없는 사람은 "칸이 몇 개나 되는지"를 모른다. */
const FIELDS = [
  "대표 이미지",
  "추가 컷",
  "상품명",
  "카테고리",
  "판매가",
  "상세페이지",
  "검색 태그",
  "원산지",
  "KC",
  "고시",
];

interface ShowcaseManifest {
  photoUrl?: string;
  mainUrl?: string;
  title?: string;
  categoryPath?: string;
  salePrice?: number;
  sourceNote?: string;
}

export function LandingVignette() {
  const [manifest, setManifest] = useState<ShowcaseManifest | null>(null);
  const reduced = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const [phase, setPhase] = useState<Phase>(reduced ? "stamp" : "photo");

  useEffect(() => {
    let cancelled = false;
    void fetch("/showcase/manifest.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: ShowcaseManifest | null) => {
        if (!cancelled && data) setManifest(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // prefers-reduced-motion 이면 재생하지 않고 stamp 프레임으로 고정한다.
  useEffect(() => {
    if (reduced) return;
    const timer = window.setTimeout(() => {
      setPhase((current) => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]);
    }, PHASE_MS[phase]);
    return () => window.clearTimeout(timer);
  }, [phase, reduced]);

  const showPhoto = phase !== "rest";
  const built = phase === "build" || phase === "stamp" || phase === "rest";
  const stamped = phase === "stamp" || phase === "rest";

  return (
    <figure className="vig" aria-label="등록 과정 미리보기">
      <div className="vig-chrome">
        <div className="vig-dots">
          <i />
          <i />
          <i />
        </div>
        <span className="vig-url">smartstore.naver.com</span>
      </div>

      <div className="vig-body">
        <div className={`vig-photo ${showPhoto ? "" : "is-idle"}`}>
          {phase === "photo" && manifest?.photoUrl ? (
            <img src={manifest.photoUrl} alt="올린 사진" />
          ) : built && manifest?.mainUrl ? (
            <img src={manifest.mainUrl} alt="생성된 대표 이미지" />
          ) : (
            <span className="vig-empty">
              {phase === "photo" ? "올린 사진" : "대표 이미지"}
            </span>
          )}
        </div>

        <div className="vig-fields">
          {FIELDS.map((field, index) => (
            <div
              key={field}
              className={`vig-field ${built ? "on" : ""}`}
              style={{ "--i": index } as React.CSSProperties}
            >
              <i aria-hidden>{built ? "✓" : ""}</i>
              {field}
            </div>
          ))}
        </div>
      </div>

      <figcaption className="vig-caption">
        <span key={CAPTION[phase]}>{CAPTION[phase]}</span>
        {stamped ? <span className="vig-stamp">등록 완료</span> : null}
      </figcaption>
      <p className="vig-note">
        {manifest?.sourceNote ??
          (manifest
            ? "실제 실행으로 만들어진 산출물입니다."
            : "실런 산출물을 public/showcase/ 에 넣으면 여기에 표시됩니다 — 가짜 데이터는 넣지 않습니다.")}
      </p>
    </figure>
  );
}
