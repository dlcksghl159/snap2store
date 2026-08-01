import { useEffect, useRef, type CSSProperties } from "react";
import { useEyeLive, type PhoneEyeApi } from "./phone-eye";

/**
 * 폰 아이 초대장 — 랜딩 덱 우측 상단의 작은 뷰파인더 + 한 줄.
 *
 * ⚠ 이 컴포넌트의 존재 이유는 **발견 가능성**이다. 아이콘만 두던 시절의 치명적 결함:
 * 사람들은 "노트북 카메라에 핸드폰을 들어 보인다"는 발상 자체를 하지 못한다. 아무리 예쁜
 * 픽토그램도 없는 개념을 가르치지는 못한다.
 *
 * 그래서 두 겹으로 말한다.
 * 1. **거울.** 맥 카메라 화면을 그대로 작게 보여준다. 자기 모습이 보이는 순간
 *    "이 카메라가 지금 나를 보고 있다"가 설명 없이 전달된다 — 고지이자 초대다.
 * 2. **한 줄.** 그래도 첫 동작은 말로 시켜야 한다 — "핸드폰을 들어 보이세요".
 *    글자를 줄이는 것과 아무도 모르는 동작을 방치하는 것은 다른 문제다.
 *
 * 한때 폰 모양 점선 표적을 겹쳤다가 뺐다. 얼굴 위에 격자가 얹힌 꼴이라 화면이 지저분해졌고,
 * 정작 무엇을 하라는지는 옆의 한 줄이 이미 말하고 있었다.
 *
 * 폰이 보이면 이 원이 **제자리에서 1.5배로 뽀잉 커진다**. 확신 링이 차오르고, 다 차면
 * QR 이 열린다.
 *
 * ⚠ 한때 화면 전체를 덮는 확대 무대를 만들었다가 걷어냈다. 카메라 하나 알아본 것에
 * 화면을 통째로 내주는 건 사건의 크기에 안 맞는다 — 과시로 읽히고 부담스럽다.
 * 알림은 알림의 크기로 한다.
 */
export function EyeBadge({ eye, parked = false }: { eye: PhoneEyeApi; parked?: boolean }) {
  const live = useEyeLive(eye);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const node = videoRef.current;
    if (!node) return;
    node.srcObject = eye.stream;
    if (eye.stream) void node.play().catch(() => undefined);
  }, [eye.stream]);

  if (eye.status !== "opening" && eye.status !== "watching") return null;

  const opening = eye.status === "opening";
  const seeing = live.charge > 0.02;
  const say = opening
    ? "카메라 여는 중…"
    : live.rearming
      ? "폰을 내렸다 다시 들어 보이세요"
      : seeing
        ? "그대로 잠깐만요"
        : parked
          ? // 이미 붙어 있는 폰이다 — 재스캔이 아니라 그 폰의 카메라가 다시 열린다.
            "핸드폰을 들어 보이면 다시 촬영해요"
          : "핸드폰을 들어 보이세요";

  return (
    <div
      className={`eye${seeing ? " is-seeing" : ""}${opening ? " is-opening" : ""}`}
      style={{ "--charge": live.charge } as CSSProperties}
      title="맥 카메라가 켜져 있어요 — 핸드폰을 들어 보이면 촬영용 QR 이 저절로 열립니다"
    >
      <span className="eye-view">
        {/* 거울상이어야 한다 — 좌우가 뒤집힌 화면에서는 자기 손을 못 따라간다. */}
        <video ref={videoRef} className="eye-cam" muted playsInline />
        <span className="eye-ring" aria-hidden />
      </span>
      <span className="eye-say" aria-live="polite">
        {say}
      </span>
    </div>
  );
}
