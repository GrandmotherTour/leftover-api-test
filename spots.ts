// 주변 스팟 수집
// 카카오 로컬: 카페, 문화시설, 관광명소
// TourAPI: 관광지, 문화시설, 행사
// 응답 필드가 서로 다름 (x/y vs mapx/mapy) → Spot 하나로 정규화

const KAKAO_LOCAL = 'https://dapi.kakao.com/v2/local/search/category.json';
const TOUR_LOCATION = 'https://apis.data.go.kr/B551011/KorService2/locationBasedList2';

// 카카오 카테고리 그룹 코드
const KAKAO_CATEGORIES = [
  { code: 'CE7', label: '카페' },
  { code: 'CT1', label: '문화시설' },
  { code: 'AT4', label: '관광명소' },
];

// TourAPI 콘텐츠 타입 ID
const TOUR_TYPES = [
  { id: 12, label: '관광지' },
  { id: 14, label: '문화시설' },
  { id: 15, label: '축제·공연·행사' },
];

// 두 API 결과를 담는 공통 형태
export type Spot = {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  distance: number;      // m
  address: string;
  source: 'kakao' | 'tour';
  url?: string;
  image?: string;
};

export type SpotsResult = {
  spots: Spot[];
  raw: { kakao: unknown[]; tour: unknown[] };
  requested: string[];
};


// ###############################################################

// 서비스키 가리기 (브라우저로 새어나가지 않게)
function mask(url: string): string {
  return url.replace(/(serviceKey=)[^&]+/, '$1***');
}


// ###############################################################

// fetch + JSON 파싱. 실패 원인
// 공공데이터포털은 에러 시 XML 을 뱉기도 함
async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e: any) {
    throw new Error(`네트워크 실패 — ${mask(url)}  (${e.cause?.code ?? e.message})`);
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 이 아닌 응답 (HTTP ${res.status}) — ${mask(url)}\n${text.slice(0, 300)}`);
  }
}


// ###############################################################

// 이름 단순화 (공백, 기호 제거)
function normalize(name: string): string {
  return name.replace(/[\s()（）·・\-_,.]/g, '').toLowerCase();
}


// ###############################################################

// 두 좌표 사이 거리 (m)
function distanceBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}


// ###############################################################

// 카카오 로컬 - 카테고리 3종 병렬 조회
async function fetchKakao(lat: number, lng: number, radius: number) {
  const requested: string[] = [];
  const raw: unknown[] = [];
  const spots: Spot[] = [];

  await Promise.all(KAKAO_CATEGORIES.map(async ({ code, label }) => {
    const url = `${KAKAO_LOCAL}?${new URLSearchParams({
      category_group_code: code,
      x: String(lng),
      y: String(lat),
      radius: String(Math.min(radius, 20000)),
      size: '15',
      sort: 'distance',
    })}`;
    requested.push(url);

    const json = await fetchJson(url, {
      headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` },
    });
    if (json.errorType) throw new Error(`카카오 로컬: ${json.message}`);
    raw.push(json);

    for (const d of json.documents ?? []) {
      spots.push({
        id: `kakao-${d.id}`,
        name: d.place_name,
        category: label,
        lat: Number(d.y),
        lng: Number(d.x),
        distance: Number(d.distance),
        address: d.road_address_name || d.address_name,
        source: 'kakao',
        url: d.place_url,
      });
    }
  }));

  return { spots, raw, requested };
}


// ###############################################################

// TourAPI - 결과 없으면 items 가 빈 문자열로 옴
function tourItems(json: any): any[] {
  const items = json?.response?.body?.items;
  if (!items || typeof items === 'string') return [];
  return Array.isArray(items.item) ? items.item : [items.item];
}


// ###############################################################

// TourAPI - 콘텐츠 타입 3종 병렬 조회
async function fetchTour(lat: number, lng: number, radius: number) {
  const requested: string[] = [];
  const raw: unknown[] = [];
  const spots: Spot[] = [];

  await Promise.all(TOUR_TYPES.map(async ({ id, label }) => {
    const url = `${TOUR_LOCATION}?${new URLSearchParams({
      serviceKey: process.env.DATA_GO_KR_KEY!,
      numOfRows: '15',
      pageNo: '1',
      MobileOS: 'ETC',
      MobileApp: 'leftover',
      _type: 'json',
      mapX: String(lng),
      mapY: String(lat),
      radius: String(Math.min(radius, 20000)),
      contentTypeId: String(id),
      arrange: 'E',            // 거리순
    })}`;
    requested.push(mask(url));

    const json = await fetchJson(url);
    const code = json?.response?.header?.resultCode;
    if (code && code !== '0000') {
      throw new Error(`TourAPI: ${json.response.header.resultMsg}`);
    }
    raw.push(json);

    for (const it of tourItems(json)) {
      spots.push({
        id: `tour-${it.contentid}`,
        name: it.title,
        category: label,
        lat: Number(it.mapy),
        lng: Number(it.mapx),
        distance: Math.round(Number(it.dist)),
        address: it.addr1 ?? '',
        source: 'tour',
        image: it.firstimage || undefined,
      });
    }
  }));

  return { spots, raw, requested };
}


// ###############################################################

// 이름 같고 100m 안이면 같은 장소로 보고 하나만
function dedupe(spots: Spot[]): Spot[] {
  const kept: Spot[] = [];

  for (const s of spots) {
    const dup = kept.find(k =>
      normalize(k.name) === normalize(s.name) &&
      distanceBetween(k.lat, k.lng, s.lat, s.lng) < 100
    );
    if (!dup) kept.push(s);
  }
  return kept;
}


// ###############################################################

// 두 API 결과를 모아 거리순으로
export async function getSpots(lat: number, lng: number, radius: number): Promise<SpotsResult> {
  const [kakao, tour] = await Promise.all([
    fetchKakao(lat, lng, radius),
    fetchTour(lat, lng, radius),
  ]);

  const spots = dedupe([...kakao.spots, ...tour.spots])
    .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .sort((a, b) => a.distance - b.distance);

  return {
    spots,
    raw: { kakao: kakao.raw, tour: tour.raw },
    requested: [...kakao.requested, ...tour.requested],
  };
}


// ###############################################################

// 단독 실행
if (import.meta.url === `file://${process.argv[1]}`) {
  const [lat = 37.4979, lng = 127.0276, radius = 1000] = process.argv.slice(2).map(Number);

  getSpots(lat, lng, radius).then(r => {
    console.log(`\n요청한 URL ${r.requested.length}개`);
    r.requested.forEach(u => console.log('  ' + u));

    console.log(`\n스팟 ${r.spots.length}개 (카카오 ${r.spots.filter(s => s.source === 'kakao').length} · TourAPI ${r.spots.filter(s => s.source === 'tour').length})\n`);
    for (const s of r.spots.slice(0, 20)) {
      console.log(`  ${String(s.distance).padStart(5)}m  [${s.source === 'kakao' ? '카카오 ' : 'Tour  '}] ${s.category.padEnd(8)} ${s.name}`);
    }
  }).catch(e => { console.error('✗', e.message); process.exit(1); });
}
