import { useEffect, useRef, useState } from "react";
import {
  EYE_TUNING,
  isPhoneClass,
  useEyeLive,
  usePhoneEye,
  type EyeTuning,
} from "./phone-eye";

/**
 * 폰 아이 실험실 — `http://localhost:5173/?eye=1`
 *
 * 자동 감지는 "되나 안 되나"를 말로 정할 수 없다. 실제 맥북 카메라 앞에 실제 폰을 들고
 * 숫자를 봐야 한다. 이 화면은 그 숫자를 전부 꺼내 놓고, 기준선을 라이브로 흔들어 보게 한다.
 *
 * 심사·시연에는 쓰지 않는다. 튜닝 전용이다.
 */
export function EyeLab() {
  const [tuning, setTuning] = useState<EyeTuning>(EYE_TUNING);
  const [model, setModel] = useState<"lite0" | "lite2">("lite0");
  const [running, setRunning] = useState(false);
  const [spots, setSpots] = useState(0);
  const [lastSpotAt, setLastSpotAt] = useState<string>("—");

  const eye = usePhoneEye({
    enabled: running,
    model,
    tuning,
    onSpot: () => {
      setSpots((count) => count + 1);
      setLastSpotAt(new Date().toLocaleTimeString("ko-KR"));
      // 실험실에서는 한 번 울린 뒤에도 계속 보고 싶다 — 바로 다시 무장한다.
      // (폰을 내렸다 들어야 다음이 울린다 — 재무장 규칙은 그대로 살아 있다.)
      window.setTimeout(() => setRunning(true), 60);
      setRunning(false);
    },
  });

  return (
    <div className="lab">
      <header className="lab-top">
        <h1>폰 아이 실험실</h1>
        <p>
          맥북 카메라 앞에 핸드폰을 들어 보이세요. 아래 숫자가 판정의 전부입니다 —
          초록 박스가 <b>인정된 후보</b>, 회색은 탈락입니다.
        </p>
        <div className="lab-actions">
          <button type="button" className="lab-btn" onClick={() => setRunning((on) => !on)}>
            {running ? "정지" : "카메라 켜기"}
          </button>
          <label className="lab-model">
            모델
            <select value={model} onChange={(event) => setModel(event.target.value as typeof model)}>
              <option value="lite0">EfficientDet-Lite0 (빠름 · 기본)</option>
              <option value="lite2">EfficientDet-Lite2 (정확 · 받아야 함)</option>
            </select>
          </label>
          <span className={`lab-status is-${eye.status}`}>{statusLabel(eye.status)}</span>
          <span className="lab-spots">
            발화 <b>{spots}</b>회 · 마지막 {lastSpotAt}
          </span>
        </div>
        {eye.error ? (
          <div className="lab-error">
            {eye.error}
            {model === "lite2" ? (
              <>
                {" "}
                Lite2 는 저장소에 넣지 않습니다 — <code>npm run vision:lite2</code> 로 먼저
                받으세요.
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="lab-body">
        <Viewfinder eye={eye} tuning={tuning} />
        <aside className="lab-side">
          <ChargeMeter eye={eye} />
          <Readout eye={eye} tuning={tuning} />
          <Sliders tuning={tuning} onChange={setTuning} />
        </aside>
      </div>
    </div>
  );
}

function Viewfinder({
  eye,
  tuning,
}: {
  eye: ReturnType<typeof usePhoneEye>;
  tuning: EyeTuning;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const live = useEyeLive(eye);

  useEffect(() => {
    const node = videoRef.current;
    if (!node) return;
    node.srcObject = eye.stream;
    if (eye.stream) void node.play().catch(() => undefined);
  }, [eye.stream]);

  return (
    <div className="lab-view">
      <video ref={videoRef} muted playsInline className="lab-video" />
      {!eye.stream ? <div className="lab-view-empty">카메라 꺼짐</div> : null}
      <div className="lab-boxes">
        {live.sightings.map((sighting, index) => (
          <div
            key={`${sighting.label}-${index}`}
            className={`lab-box ${sighting.counts ? "counts" : ""}`}
            style={{
              left: `${sighting.box.x * 100}%`,
              top: `${sighting.box.y * 100}%`,
              width: `${sighting.box.w * 100}%`,
              height: `${sighting.box.h * 100}%`,
            }}
          >
            <span>
              {sighting.label} {(sighting.score * 100).toFixed(0)}% ·{" "}
              {(sighting.area * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
      <div className="lab-gate">
        점수 ≥ {tuning.minScore.toFixed(2)} · 면적 ≥ {(tuning.minArea * 100).toFixed(1)}% ·{" "}
        {tuning.holdMs}ms 유지
      </div>
    </div>
  );
}

function ChargeMeter({ eye }: { eye: ReturnType<typeof usePhoneEye> }) {
  const live = useEyeLive(eye);
  return (
    <div className="lab-charge">
      <div className="lab-charge-bar">
        <i style={{ transform: `scaleX(${live.charge})` }} />
      </div>
      <span>
        확신 {(live.charge * 100).toFixed(0)}%
        {live.rearming ? " · 폰을 내려야 다시 무장합니다" : ""}
      </span>
    </div>
  );
}

function Readout({
  eye,
  tuning,
}: {
  eye: ReturnType<typeof usePhoneEye>;
  tuning: EyeTuning;
}) {
  const live = useEyeLive(eye);
  if (live.sightings.length === 0) {
    return <div className="lab-readout empty">보이는 것 없음</div>;
  }
  return (
    <table className="lab-readout">
      <thead>
        <tr>
          <th>클래스</th>
          <th>점수</th>
          <th>면적</th>
          <th>탈락 사유</th>
        </tr>
      </thead>
      <tbody>
        {live.sightings.map((sighting, index) => (
          <tr key={`${sighting.label}-${index}`} className={sighting.counts ? "counts" : ""}>
            <td>{sighting.label}</td>
            <td className="mono">{(sighting.score * 100).toFixed(0)}%</td>
            <td className="mono">{(sighting.area * 100).toFixed(1)}%</td>
            <td>{rejectReason(sighting, tuning)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Sliders({
  tuning,
  onChange,
}: {
  tuning: EyeTuning;
  onChange: (next: EyeTuning) => void;
}) {
  const set = (key: keyof EyeTuning) => (event: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...tuning, [key]: Number(event.target.value) });

  return (
    <div className="lab-sliders">
      <label>
        <span>
          최소 점수 <b className="mono">{tuning.minScore.toFixed(2)}</b>
        </span>
        <input
          type="range"
          min={0.1}
          max={0.9}
          step={0.01}
          value={tuning.minScore}
          onChange={set("minScore")}
        />
      </label>
      <label>
        <span>
          최소 면적 <b className="mono">{(tuning.minArea * 100).toFixed(1)}%</b>
        </span>
        <input
          type="range"
          min={0.002}
          max={0.3}
          step={0.002}
          value={tuning.minArea}
          onChange={set("minArea")}
        />
      </label>
      <label>
        <span>
          유지 시간 <b className="mono">{tuning.holdMs}ms</b>
        </span>
        <input
          type="range"
          min={100}
          max={2500}
          step={50}
          value={tuning.holdMs}
          onChange={set("holdMs")}
        />
      </label>
      <label>
        <span>
          추론 주기 <b className="mono">{tuning.strideMs}ms</b>
        </span>
        <input
          type="range"
          min={30}
          max={400}
          step={10}
          value={tuning.strideMs}
          onChange={set("strideMs")}
        />
      </label>
      <button type="button" className="lab-btn ghost" onClick={() => onChange(EYE_TUNING)}>
        기본값으로
      </button>
    </div>
  );
}

function rejectReason(
  sighting: { label: string; score: number; area: number; counts: boolean },
  tuning: EyeTuning,
): string {
  if (sighting.counts) return "인정";
  if (!isPhoneClass(sighting.label)) return "폰 클래스 아님";
  if (sighting.score < tuning.minScore) return "점수 낮음";
  if (sighting.area < tuning.minArea) return "너무 작음(멀다)";
  return "—";
}

function statusLabel(status: string): string {
  const table: Record<string, string> = {
    off: "꺼짐",
    opening: "여는 중…",
    watching: "지켜보는 중",
    denied: "권한 거부됨",
    unavailable: "사용 불가",
  };
  return table[status] ?? status;
}

export function eyeLabRequested(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("eye") === "1";
}
