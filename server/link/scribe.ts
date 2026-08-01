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

/**
 * 마감 정리 — 촬영을 마치는 순간 딱 한 번, 말과 **찍은 사진**을 함께 읽는다.
 *
 * 서기는 세션 내내 소리만 듣는다. 그래서 "이거 텀블러인데" 한 마디가 잘못 들리면
 * 그대로 메모가 되고, 그 메모는 등록 전체를 오염시킨다. 마감에서는 사진이 옆에 있다 —
 * 말이 물건과 맞는지 대조할 수 있고, 사진에만 있는 사실(색·구성품·흠집)을 붙일 수 있다.
 *
 * 위계는 하나다: **사진이 사실, 말은 의도.** 어긋나면 사진을 믿고, 말에 쓸 게 없으면
 * 빈 메모를 돌려준다 — 사진은 어차피 에이전트가 직접 다시 본다. 틀린 메모보다 빈 메모가 낫다.
 */
const FINALIZE_SYSTEM = `너는 물건을 파는 사람의 말과, 그 사람이 방금 찍은 사진을 함께 보고 스마트스토어 등록 메모를 완성하는 서기다.

[사진과 말의 위계]
- 사진은 사실이고, 말은 잘못 들렸을 수 있다. 둘이 어긋나면 사진을 믿는다.
- 사진 속 물건과 말이 아예 다른 물건을 가리키면 그 말은 잘못 들어온 것으로 보고 버린다.
- 가격·거래 방식·구매 시기·사용 기간은 사진으로 알 수 없다 — 말에서만 온다.

[담을 것]
물건 정체·브랜드·모델명, 사진에서 분명히 보이는 색상·재질·구성품·상태(흠집·사용감), 크기/용량, 구매 시기, 희망 가격, 거래 방식.

[버릴 것]
잡담·추임새·인사말·혼잣말·중복, 사진에도 말에도 없는 추측, 과장.

[빈 메모를 돌려주는 경우]
- 말에 쓸 정보가 하나도 없다 (잡담뿐이거나, 사진 속 물건과 전혀 맞지 않는다).
- 이때 사진만 보고 메모를 지어내지 않는다. 빈 문자열을 돌려준다.

[문체]
간결한 한국어 구를 " · " 로 잇는다. 300자 이내. 마크다운 금지.`;

export interface FinalizeNoteInput {
  /** 음성으로 받아 적힌 지금까지의 메모. */
  note: string;
  /** 촬영한 사진의 data URL. 비어 있으면 대조할 것이 없다. */
  imageUrls: string[];
}

export async function finalizeSellerNote(input: FinalizeNoteInput): Promise<string> {
  const note = input.note.trim().slice(0, NOTE_LIMIT);
  if (input.imageUrls.length === 0) return note;

  const result = await requestOpenAiJson({
    system: FINALIZE_SYSTEM,
    user: `[말로 받아 적은 메모]\n${note || "(비어 있음)"}\n\n[방금 찍은 사진 ${input.imageUrls.length}장]\n사진 속 물건과 위 메모가 같은 물건인지 먼저 확인하고, 메모 전문을 다시 써라.`,
    imageUrls: input.imageUrls,
    schemaName: "final_seller_note",
    jsonSchema: strictObject({
      note: {
        type: "string",
        description: "사진과 말을 함께 읽고 완성한 메모 전문. 쓸 정보가 없으면 빈 문자열.",
      },
    }),
    validator: ScribeResult,
  });
  return result.note.trim().slice(0, NOTE_LIMIT);
}

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
