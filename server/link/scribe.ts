import { z } from "zod";
import { requestOpenAiJson, strictObject } from "../ai/openai-json.js";
import { env } from "../env.js";

/**
 * 노트 서기 — 폰 링크 중 판매자의 발화를 "그대로" 받아 적지 않는다.
 * 발화 하나하나를 프롬프트로 삼아, 지금까지의 메모 전체를 다시 써서 돌려준다.
 * 그래서 잡담은 버려지고, 번복("가격 2만5천으로 해줘")은 옛 내용을 고친다.
 *
 * 신뢰성 계약: 정리 호출이 실패해도 발화를 잃지 않는다 — 원문 이어붙이기로 폴백한다.
 * 화면(메모 칸)의 진실은 항상 onNote 로 내려간 마지막 전문이다.
 */

const NOTE_LIMIT = 2000;

const ScribeResult = z.object({ note: z.string() });

const SCRIBE_SYSTEM = `너는 중고 물건 판매자의 말을 스마트스토어 등록 메모로 정리하는 서기다.

규칙:
- 판매자가 말한 사실만 담는다: 물건 정체·브랜드·모델명, 상태·사용감·하자, 구성품, 크기/용량, 구매 시기, 희망 가격, 거래 방식.
- 상품과 무관한 잡담·추임새·혼잣말·중복은 버린다. 과장·추측·인사말 금지.
- 새 발화가 이전 내용을 정정하면 옛 내용을 고쳐 쓴다 (가격 번복, 구성품 정정 등).
- 결과는 메모 "전문"이다 — 유지할 것은 유지하고 새 정보를 통합해 전체를 다시 쓴다.
- 문체: 간결한 한국어 구를 " · " 로 잇는다. 300자 이내를 지향한다. 마크다운 금지.
- 판별할 정보가 아직 없으면 빈 문자열을 반환한다.`;

export interface NoteScribeOptions {
  /** 갱신된 메모 전문. utterance 는 이번 갱신을 만든 발화(디버그·표시용). */
  onNote: (note: string, utterance: string) => void;
  onLog?: (line: string) => void;
}

export class NoteScribe {
  private note = "";
  private queue: string[] = [];
  private busy = false;
  private closed = false;

  constructor(private readonly options: NoteScribeOptions) {}

  /** 세션 시작 시 데스크톱 메모 칸의 현재 내용을 출발점으로 삼는다. */
  seed(text: string): void {
    this.note = text.trim().slice(0, NOTE_LIMIT);
  }

  push(utterance: string): void {
    const trimmed = utterance.trim();
    if (!trimmed || this.closed) return;
    this.queue.push(trimmed);
    void this.drain();
  }

  close(): void {
    this.closed = true;
    this.queue = [];
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        // 정리 중에 연달아 들어온 발화는 한 번에 묶는다 — 호출 수·지연·경합을 줄인다.
        const batch = this.queue.splice(0).join("\n");
        await this.refine(batch);
      }
    } finally {
      this.busy = false;
    }
  }

  private async refine(utterance: string): Promise<void> {
    try {
      const result = await requestOpenAiJson({
        system: SCRIBE_SYSTEM,
        user: `[지금까지의 메모]\n${this.note || "(비어 있음)"}\n\n[새 발화]\n${utterance}`,
        schemaName: "seller_note",
        jsonSchema: strictObject({
          note: { type: "string", description: "갱신된 판매 메모 전문. 정보가 없으면 빈 문자열." },
        }),
        validator: ScribeResult,
        model: env.VOICE_SCRIBE_MODEL || undefined,
        reasoningEffort: "minimal",
      });
      if (this.closed) return;
      const next = result.note.trim().slice(0, NOTE_LIMIT);
      // 새 발화가 잡담뿐이면 모델이 기존 메모를 그대로 돌려준다 — 그때는 갱신을 쏘지 않는다.
      if (next === this.note) return;
      this.note = next;
      this.options.onNote(this.note, utterance);
    } catch (error) {
      this.options.onLog?.(
        `[scribe] 정리 실패 — 원문 이어붙이기로 폴백: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.closed) return;
      this.note = `${this.note ? `${this.note} ` : ""}${utterance}`.slice(0, NOTE_LIMIT);
      this.options.onNote(this.note, utterance);
    }
  }
}
