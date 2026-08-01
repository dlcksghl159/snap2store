/**
 * 스튜디오 효과음 — 에셋 없이 WebAudio 로 합성한다.
 * 전부 사용자 제스처(버튼 클릭) 이후에만 재생되므로 자동재생 정책과 충돌하지 않는다.
 * AudioContext 를 못 만들거나 suspended 면 조용히 포기한다 — 소리는 장식이지 기능이 아니다.
 */

let context: AudioContext | null = null;

function ensureContext(): AudioContext | null {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
    return context.state === "closed" ? null : context;
  } catch {
    return null;
  }
}

function envelope(ctx: AudioContext, at: number, peak: number, attack: number, release: number): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + release);
  gain.connect(ctx.destination);
  return gain;
}

/** 모니터 점화 — 낮은 스윕이 부드럽게 차오른다. */
export function sfxPowerOn(): void {
  const ctx = ensureContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, now);
  osc.frequency.exponentialRampToValueAtTime(520, now + 0.42);
  osc.connect(envelope(ctx, now, 0.055, 0.06, 0.48));
  osc.start(now);
  osc.stop(now + 0.6);
}

/** 전원 오프 — 점화의 역방향, 더 짧게. */
export function sfxPowerOff(): void {
  const ctx = ensureContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(420, now);
  osc.frequency.exponentialRampToValueAtTime(110, now + 0.3);
  osc.connect(envelope(ctx, now, 0.05, 0.02, 0.34));
  osc.start(now);
  osc.stop(now + 0.42);
}

/** 리프 셔터 — 필터 노이즈 두 번(개방·폐쇄)이 20ms 간격으로. */
export function sfxShutter(): void {
  const ctx = ensureContext();
  if (!ctx) return;
  const now = ctx.currentTime;

  const burst = (at: number, freq: number, peak: number) => {
    const length = Math.floor(ctx.sampleRate * 0.05);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = 1.4;
    source.connect(filter);
    filter.connect(envelope(ctx, at, peak, 0.004, 0.06));
    source.start(at);
  };

  burst(now, 2400, 0.12);
  burst(now + 0.045, 1500, 0.08);
}
