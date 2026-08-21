# leftover

**API 연동 데모**

| | 내용 | 파일 |
|---|---|---|
| 1 | 내 위치 주변 스팟 수집 | `spots.ts` |
| 2 | 실시간 데이터 붙이기 | `realtime.ts` |
| 3 | 여러 스팟을 도는 경로 + 길안내 | `directions.ts` |

---

## 실행

```bash
npm install
npm run dev        
# → http://localhost:3000
```

| 명령 | 내용 |
|---|---|
| `npm run dev` | 서버 + 화면. 저장하면 자동 재시작 |
| `npm run spots` | `spots.ts` 만 실행, 콘솔 출력 |
| `npm run realtime` | `realtime.ts` 만 실행 |
| `npm run directions` | `directions.ts` 만 실행 |
| `npm run typecheck` | `tsc --noEmit` |

`.env` 키 4개
```bash
KAKAO_REST_KEY=      # 장소검색, 길찾기
KAKAO_JS_KEY=        # 지도
DATA_GO_KR_KEY=      # 관광정보, 날씨
SEOUL_API_KEY=       # 실시간 혼잡도
```

---

## 구조
```
leftover/
├─ .env             
├─ package.json
├─ tsconfig.json
│
├─ server.ts          HTML 서빙 + /api/* 를 모듈 함수로 연결
├─ index.html         화면 전부 (탭 · 리스트 · 지도 · Inspector)
│
├─ spots.ts           1
├─ realtime.ts        2
└─ directions.ts      3
```


### 동작 흐름

```
브라우저 (localhost:3000)
    │  fetch('/api/spots')          same-origin, CORS 없음
    ↓
server.ts (Node)
    │  fetch('https://dapi.kakao.com/...')   Node라 CORS 없음
    ↓
카카오 / 공공데이터포털 / 서울시 / OSRM
```

- 브라우저에서 외부 API를 직접 못 부름. CORS로 막히고 REST 키도 노출됨. 서버를 끼워 해결
- REST 키는 브라우저까지 안감. `KAKAO_JS_KEY`만 예외 — 지도 SDK용이라 HTML에 주입해야 함
- `server.ts`에 API 호출 로직 없음. `import` 로 함수만 가져와 URL에 연결


## 사용한 API

| API | 파일 | 키 | 용도 |
|---|---|---|---|
| 카카오 로컬 | `spots.ts` | `KAKAO_REST_KEY` | 카페 · 문화시설 · 관광명소 |
| 한국관광공사 TourAPI | `spots.ts` | `DATA_GO_KR_KEY` | 관광지 · 문화시설 · 행사 |
| 기상청 단기예보 | `realtime.ts` | `DATA_GO_KR_KEY` | 기온 · 하늘상태 · 강수확률 |
| 서울 실시간 도시데이터 | `realtime.ts` | `SEOUL_API_KEY` | 혼잡도 + 도착 시점 예측 |
| OSRM (FOSSGIS) | `directions.ts` | 불필요 | 도보 경로 · 길안내 |
| 카카오모빌리티 | `directions.ts` | `KAKAO_REST_KEY` | 자동차 경로 · 길안내 |
| 카카오맵 JS SDK | `index.html` | `KAKAO_JS_KEY` | 지도 렌더링 |

---

## 기능별

### spots.ts — 주변 스팟

두 API를 병렬로 6번 호출.

```
카카오 로컬   CE7 카페 · CT1 문화시설 · AT4 관광명소
TourAPI      12 관광지 · 14 문화시설 · 15 축제/공연/행사
```

- 응답 필드가 다름 (`x/y` vs `mapx/mapy`) → `Spot` 하나로 정규화
- 이름 같고 100m 안이면 중복 제거, 거리순 정렬
- **함정**: TourAPI는 결과 없을 때 `items` 가 빈 문자열로 옴

### realtime.ts — 실시간

API 모두 좌표를 그대로 안 받아서 변환이 필요.

- **기상청** — 위경도 → 격자 `(nx, ny)` 변환 (`toGrid`). 발표 시각이 02·05·08·11·14·17·20·23시뿐이라 가장 최근 발표분을 고르기 (`latestBase`)
- **서울 실시간** — 좌표가 아니라 「강남역」 같은 장소명으로만 조회. 지점 좌표표를 두고 가장 가까운 곳으로 매핑 (`nearestSpot`). 현재 12곳
- 응답에 `FCST_PPLTN` 이 같이 와서 **몇 시간 뒤 예측 혼잡도**도 나옴

### directions.ts — 길찾기 + 길안내

카카오모빌리티는 자동차만 가능. 도보 REST API가 없어서 OSRM 사용.

```
도보    GET  routing.openstreetmap.de/routed-foot/route/v1/foot/{좌표들}
자동차  GET  apis-navi.kakaomobility.com/v1/directions            (지점 2개)
        POST apis-navi.kakaomobility.com/v1/waypoints/directions  (3개 이상)
```

- 지점이 여러 개면 두 API 모두 **구간(leg)별로 쪼개서** 응답 → 구간마다 색·소요시간 분리
- 출발지 = 도착지로 주면 한 바퀴 돌아 복귀하는 코스
- 경로 좌표 형식이 다름 — 카카오는 `vertexes` 평면 배열, OSRM은 GeoJSON
- 안내 문구도 다름 — 카카오는 한국어 그대로, OSRM은 `maneuver` 영문을 변환

같은 코스 비교:
```
도보    15.0km  200분  길안내 64단계
자동차  18.5km   79분  길안내 31단계
```

도보가 3.5km 짧다.

### server.ts

```ts
const ROUTES = {
  '/api/spots':      q => getSpots(num(q,'lat'), num(q,'lng'), num(q,'radius', 1000)),
  '/api/realtime':   q => getRealtime(num(q,'lat'), num(q,'lng')),
  '/api/directions': q => getDirections(str(q,'points'), q.get('mode') ?? 'walk'),
};
```

- URL → 모듈 함수 매핑.
- 부팅 시 `.env` 키 검사
- `index.html` 을 요청마다 읽어 `__KAKAO_JS_KEY__` 치환 → HTML은 새로고침만으로 반영

### index.html

프레임워크·빌드 없음. 순수 HTML + vanilla JS.

- 1/2/3 탭, 스팟 리스트, 카카오 지도, API Inspector
- 스팟을 누른 **순서가 방문 순서**. 순번 뱃지 + 구간별 색 + 방향 화살표
- API Inspector가 요청을 2단계로 표시 (브라우저 → server.ts, server.ts → 외부 API). 서비스키는 `***` 로 가림

---

## 알아둘 것
- **카카오맵 JS SDK 도메인 등록 필수.** `앱 설정 → 플랫폼 키 → JavaScript 키 → JavaScript SDK 도메인` 에 `http://localhost:3000`. 등록안하면 지도 안뜸
- **OSRM 공개 서버는 데모용.** FOSSGIS 무료 운영이라 호출이 몰리면 차단될 수 있음
- **혼잡도는 서울 12곳 기준.** 그 밖 좌표는 가장 가까운 지점으로 매핑되고 거리가 같이 표시됨

---

# 다음

**스팟 다양성** — 도심에서 카페가 상위 독식 (강남역 1km 44개 중 38개). 골목·산책로는 "점"이 아니라 "선"이라 장소 검색 API에 없음

1. 카테고리별 쿼터 — 거리순 정렬 대신 카테고리마다 상위 N개씩
2. TourAPI 소분류 `cat1/2/3` + `contentTypeId=28`(레포츠)
3. 카카오 키워드 검색 — "산책로", "둘레길", "전통시장"
4. 서울시 산책로·둘레길 데이터셋

다양한 데이터와 조합을 통해 다양한 스팟을 뽑아내야 풍부한 서비스가 될 듯

**역산 스케줄러** — 아직 명확하게 없음.

**실시간 복잡도 측정하기**
서울시에서 제공하는 혼잡도는 어떻게 제공하는가.
-> 아마 기지국의 스마트폰 수를 계산해서 제공하는 것 같다
-> 우리가 얻을 수는 없는 데이터

다만 서울에서 혼잡도를 제공하니까 역산해서 할 수 있지 않을까?
시간, 날씨, 행사-축제, 반경 내 카페 음식점 수, 도로속도 등을 서울시 혼잡도를 통해 상관분석하기 -> 회귀/분류 모델 -> 오차 측정

모델을 구현해서 외부에서 적용하기

간단한 방법으로는 대중교통 하차 인원을 통해 혼잡도 측정하기

어떻게 지역 혼잡도를 측정할 수 있을까?
더 나아가 카페등 해당 장소의 복잡도도 측정이 가능할까?