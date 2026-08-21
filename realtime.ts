// 실시간 데이터 붙이기
// 기상청: 위경도를 격자(nx, ny)로 바꿔야 조회됨
// 서울 실시간: 좌표가 아니라 장소명으로만 조회됨 → 가장 가까운 지점 매핑 필요

const KMA = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst';
const SEOUL = 'http://openapi.seoul.go.kr:8088';

// 서울 실시간 도시데이터 지점 (좌표는 매핑용 근사값)
const SEOUL_SPOTS = [
  { name: '강남역',            lat: 37.4979, lng: 127.0276 },
  { name: '홍대입구역(2호선)',  lat: 37.5568, lng: 126.9237 },
  { name: '광화문·덕수궁',      lat: 37.5720, lng: 126.9769 },
  { name: '성수카페거리',       lat: 37.5445, lng: 127.0557 },
  { name: '여의도한강공원',      lat: 37.5285, lng: 126.9327 },
  { name: '경복궁',            lat: 37.5796, lng: 126.9770 },
  { name: '명동 관광특구',      lat: 37.5637, lng: 126.9850 },
  { name: '이태원 관광특구',     lat: 37.5345, lng: 126.9946 },
  { name: '잠실 관광특구',      lat: 37.5133, lng: 127.1000 },
  { name: '서울숲공원',         lat: 37.5444, lng: 127.0374 },
  { name: '인사동',            lat: 37.5735, lng: 126.9855 },
  { name: '북촌한옥마을',       lat: 37.5826, lng: 126.9830 },
];

// 하늘상태 코드
const SKY: Record<string, string> = { '1': '맑음', '3': '구름많음', '4': '흐림' };

// 강수형태 코드 (0이 아니면 비/눈)
const PTY: Record<string, string> = { '0': '', '1': '비', '2': '비/눈', '3': '눈', '4': '소나기' };

export type RealtimeResult = {
  weather: { temp: number | null; sky: string; pop: number | null; baseTime: string; grid: { nx: number; ny: number } };
  congestion: { area: string; level: string; message: string; population: string; forecast: { time: string; level: string } | null } | null;
  raw: { weather: unknown; congestion: unknown };
  requested: string[];
};


// ###############################################################

// 서비스키 가리기
function mask(url: string): string {
  return url
    .replace(/(serviceKey=)[^&]+/, '$1***')
    .replace(new RegExp(`/${process.env.SEOUL_API_KEY}/`), '/***/');
}


// ###############################################################

// fetch + JSON 파싱. 실패 원인
async function fetchJson(url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url);
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

// 기상청 - 위경도를 격자(nx, ny)로 변경
// Lambert Conformal Conic 투영. 기상청 격자_위경도 배포표와 같은 값
function toGrid(lat: number, lng: number): { nx: number; ny: number } {
  const RE = 6371.00877, GRID = 5.0;
  const SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const DEGRAD = Math.PI / 180.0;

  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD, slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD, olat = OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (sf ** sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / (ro ** sn);

  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = re * sf / (ra ** sn);
  let theta = lng * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}


// ###############################################################

// 가장 최근 발표된 예보 시각
// 단기예보는 02, 05, 08, 11, 14, 17, 20, 23시 발표
function latestBase(): { base_date: string; base_time: string } {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);   // UTC → KST
  const hh = kst.getUTCHours(), mm = kst.getUTCMinutes();

  const slots = [23, 20, 17, 14, 11, 8, 5, 2];
  const hit = slots.find(h => hh > h || (hh === h && mm >= 15));

  if (hit === undefined) {                              // 새벽 02:15 이전 → 어제 23시
    kst.setUTCDate(kst.getUTCDate() - 1);
    return { base_date: ymd(kst), base_time: '2300' };
  }
  return { base_date: ymd(kst), base_time: String(hit).padStart(2, '0') + '00' };
}


// ###############################################################

function ymd(d: Date): string {
  return d.getUTCFullYear()
    + String(d.getUTCMonth() + 1).padStart(2, '0')
    + String(d.getUTCDate()).padStart(2, '0');
}


// ###############################################################

// 기상청 - 가장 이른 예보 시각의 기온, 하늘상태, 강수확률
async function fetchWeather(lat: number, lng: number) {
  const grid = toGrid(lat, lng);
  const base = latestBase();

  const url = `${KMA}?${new URLSearchParams({
    serviceKey: process.env.DATA_GO_KR_KEY!,
    numOfRows: '60', pageNo: '1', dataType: 'JSON',
    base_date: base.base_date, base_time: base.base_time,
    nx: String(grid.nx), ny: String(grid.ny),
  })}`;

  const json = await fetchJson(url);
  const code = json?.response?.header?.resultCode;
  if (code !== '00') throw new Error(`기상청: ${json?.response?.header?.resultMsg ?? '응답 이상'}`);

  const items: any[] = json.response.body.items.item ?? [];
  const first = items[0]?.fcstTime;                     // 가장 가까운 예보 시각만 본다
  const at = items.filter(i => i.fcstTime === first);
  const pick = (c: string) => at.find(i => i.category === c)?.fcstValue ?? null;

  const pty = PTY[pick('PTY') ?? '0'] ?? '';
  const sky = SKY[pick('SKY') ?? ''] ?? '-';

  return {
    weather: {
      temp: pick('TMP') !== null ? Number(pick('TMP')) : null,
      sky: pty || sky,                                  // 비가 오면 하늘상태보다 강수형태가 중요
      pop: pick('POP') !== null ? Number(pick('POP')) : null,
      baseTime: `${base.base_date} ${base.base_time} 발표`,
      grid,
    },
    raw: json,
    url: mask(url),
  };
}


// ###############################################################

// 좌표에서 가장 가까운 지점
function nearestSpot(lat: number, lng: number) {
  return SEOUL_SPOTS
    .map(s => ({ ...s, distance: distanceBetween(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => a.distance - b.distance)[0];
}


// ###############################################################

// 서울 실시간 - 현재 혼잡도 + 도착 시점 예측
async function fetchCongestion(lat: number, lng: number) {
  const near = nearestSpot(lat, lng);
  const url = `${SEOUL}/${process.env.SEOUL_API_KEY}/json/citydata_ppltn/1/5/${encodeURIComponent(near.name)}`;

  const json = await fetchJson(url);
  const row = json['SeoulRtd.citydata_ppltn']?.[0];
  if (!row) return { congestion: null, raw: json, url: mask(url) };

  const fc = row.FCST_PPLTN?.[0];

  return {
    congestion: {
      area: `${row.AREA_NM} (${near.distance}m)`,
      level: row.AREA_CONGEST_LVL,
      message: row.AREA_CONGEST_MSG,
      population: `${Number(row.AREA_PPLTN_MIN).toLocaleString()}~${Number(row.AREA_PPLTN_MAX).toLocaleString()}명 · ${row.PPLTN_TIME} 기준`,
      forecast: fc ? { time: fc.FCST_TIME.slice(11, 16), level: fc.FCST_CONGEST_LVL } : null,
    },
    raw: json,
    url: mask(url),
  };
}


// ###############################################################

// 날씨 + 실시간 혼잡도
export async function getRealtime(lat: number, lng: number): Promise<RealtimeResult> {
  const [w, c] = await Promise.all([
    fetchWeather(lat, lng),
    fetchCongestion(lat, lng),
  ]);

  return {
    weather: w.weather,
    congestion: c.congestion,
    raw: { weather: w.raw, congestion: c.raw },
    requested: [w.url, c.url],
  };
}


// ###############################################################

// 단독 실행
if (import.meta.url === `file://${process.argv[1]}`) {
  const [lat = 37.4979, lng = 127.0276] = process.argv.slice(2).map(Number);

  getRealtime(lat, lng).then(r => {
    console.log('\n요청한 URL');
    r.requested.forEach(u => console.log('  ' + u));

    console.log(`\n날씨   ${r.weather.temp}°C · ${r.weather.sky} · 강수확률 ${r.weather.pop}%`);
    console.log(`       격자 nx=${r.weather.grid.nx} ny=${r.weather.grid.ny} · ${r.weather.baseTime}`);

    if (r.congestion) {
      console.log(`\n혼잡도 ${r.congestion.area} — ${r.congestion.level}`);
      console.log(`       ${r.congestion.population}`);
      if (r.congestion.forecast) {
        console.log(`       ${r.congestion.forecast.time} 예측 → ${r.congestion.forecast.level}`);
      }
    }
    console.log();
  }).catch(e => { console.error('✗', e.message); process.exit(1); });
}
