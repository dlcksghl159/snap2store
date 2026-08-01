export class CommerceApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly code: string | null;

  constructor(status: number, method: string, path: string, body: string) {
    let code: string | null = null;
    try {
      const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      /* 본문이 JSON 이 아니면 코드 없음 */
    }
    super(`커머스 API ${status} ${method} ${path}${code ? ` (${code})` : ""}`);
    this.name = "CommerceApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
    this.code = code;
  }
}

/**
 * 응답을 받지 못한 실패. `requestMayHaveBeenSent` 가 true 면
 * 서버에 도달했을 수 있으므로 절대 재전송하지 않는다.
 */
export class CommerceTransportError extends Error {
  readonly method: string;
  readonly path: string;
  readonly requestMayHaveBeenSent: boolean;

  constructor(method: string, path: string, cause: unknown, requestMayHaveBeenSent: boolean) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`커머스 API 전송 실패 ${method} ${path}: ${detail}`);
    this.name = "CommerceTransportError";
    this.method = method;
    this.path = path;
    this.requestMayHaveBeenSent = requestMayHaveBeenSent;
    this.cause = cause;
  }
}

/**
 * 유사상품 검색 불가. "정당하게 결과가 0건"과 구분되어야 상위 폴백이 올바르게 동작한다.
 * 장애를 빈 결과로 위장하지 않는다.
 */
export class ShoppingSearchUnavailableError extends Error {
  constructor(reason: string) {
    super(`유사상품 검색을 사용할 수 없습니다: ${reason}`);
    this.name = "ShoppingSearchUnavailableError";
  }
}
