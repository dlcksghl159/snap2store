import { useEyeLive, type PhoneEyeApi } from "./phone-eye";

/**
 * 폰 아이 배지 — 랜딩 CTA 아래 한 줄.
 *
 * 두 가지 일을 한다.
 * 1. **고지.** 맥북 카메라가 돌고 있다는 사실을 사용자가 알아야 한다. 조용히 켜 두는 건
 *    기능이 아니라 사고다.
 * 2. **초대.** "들어 보이면 열린다"를 말해 주고, 확신이 차오르는 걸 게이지로 보여준다.
 *    이게 없으면 QR 이 난데없이 튀어나온 것처럼 느껴진다 — 마법이 아니라 오작동으로 읽힌다.
 *
 * 뜨거운 값(charge)은 useEyeLive 로만 읽는다 — 이 한 줄만 초당 11번 다시 그려지고
 * 랜딩의 나머지는 가만히 있는다.
 */
export function EyeBadge({ eye }: { eye: PhoneEyeApi }) {
  const live = useEyeLive(eye);

  if (eye.status === "off") return null;

  if (eye.status === "denied" || eye.status === "unavailable") {
    return (
      <p className="eye-badge is-mute">
        자동 감지 꺼짐 — 위 버튼으로 연결하세요.
      </p>
    );
  }

  const opening = eye.status === "opening";
  const seeing = live.charge > 0.02;

  return (
    <div className={`eye-badge ${seeing ? "is-seeing" : ""}`} aria-live="polite">
      <span className="eye-dot" aria-hidden />
      <span className="eye-copy">
        {opening
          ? "자동 감지 준비 중…"
          : live.rearming
            ? "핸드폰을 내렸다 다시 들어 보이세요"
            : seeing
              ? "핸드폰이 보입니다 — 그대로 잠깐"
              : "카메라에 핸드폰을 들어 보이면 바로 열려요"}
      </span>
      {/* 게이지는 차오를 때만 존재한다 — 0 인 채로 놓아 두면 빈 트랙이 괘선처럼 읽힌다. */}
      {seeing ? (
        <span className="eye-gauge" aria-hidden>
          <i style={{ transform: `scaleX(${live.charge})` }} />
        </span>
      ) : null}
    </div>
  );
}
