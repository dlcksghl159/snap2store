# showcase — 실런 산출물만 넣는다

이 폴더의 파일은 화면에 그대로 노출된다. **홍보용 가짜 데이터를 넣지 않는다.**
비어 있으면 랜딩 비네트의 해당 행이 비고, 리허설 드라이버는 "리허설 자산이 없습니다"를 띄운다.
그게 맞는 동작이다.

## `manifest.json` — 랜딩 자동 재생 비네트

실제 실행 결과물의 URL 을 가리킨다.

```json
{
  "photoUrl": "/showcase/run-01/photo.jpg",
  "mainUrl": "/showcase/run-01/main.jpg",
  "title": "노트북 거치대 알루미늄 6단 각도조절 접이식",
  "categoryPath": "디지털/가전>노트북액세서리>노트북받침대/쿨러",
  "salePrice": 24900,
  "sourceNote": "2026-08-01 실행으로 만들어진 산출물입니다."
}
```

이미지는 같은 폴더에 복사해 둔다 (`data/runtime/assets/{listingId}/` 에서 가져온다).

## `rehearsal.json` — 리허설 드라이버 (`?preview=`)

**녹화된 실런을 그대로 재생한다.** 합성 이벤트를 만들지 않는다.

```json
{
  "listing": { "...": "종착 시점의 ListingRecord 전문" },
  "events": [{ "seq": 1, "at": "...", "listingId": "...", "channel": "...", "label": "...", "payload": {}, "offsetMs": 0 }]
}
```

녹화 방법 — 런을 시작하기 직전에 SSE 를 파일로 받아 두고, 종착 후 레코드와 합친다.

```bash
curl -sN http://127.0.0.1:8788/api/stream > run.sse     # 업로드 직전에 시작
# … 등록이 끝나면 Ctrl-C …
node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const events = readFileSync("run.sse","utf8").split("\n")
    .filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
  const t0 = Date.parse(events[0].at);
  fetch("http://127.0.0.1:8788/api/listings").then(r=>r.json()).then(list => {
    const listing = list.find(l => l.id === events[0].listingId);
    writeFileSync("public/showcase/rehearsal.json", JSON.stringify({
      listing, events: events.map(e => ({ ...e, offsetMs: Date.parse(e.at) - t0 })),
    }));
  });
'
```

⚠ 리허설은 **심사 중 사용 금지**다. 발표 전 리허설과 디자인 QA 용도만이다.
화면에는 "녹화된 실런 재생 — 실제 에이전트 실행 아님"이 항상 표시된다.
