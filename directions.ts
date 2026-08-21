// 길찾기 + 길안내
// 도보: OSRM (카카오가 도보가 없음)
// 자동차: 카카오모빌리티

const KAKAO_NAVI = 'https://apis-navi.kakaomobility.com/v1/directions';
const KAKAO_NAVI_WAYPOINTS = 'https://apis-navi.kakaomobility.com/v1/waypoints/directions';
const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';

// 경유지 최대 개수 (API 쿼터)
const MAX_WAYPOINTS = 30;

// 카카오 길찾기 실패 코드
const RESULT_MSG: Record<number, string> = {
  101: '경로를 찾을 수 없습니다',
  102: '출발지와 도착지가 동일 지점입니다',
  103: '경로 탐색 결과가 없습니다',
  104: '출발지와 도착지가 너무 가깝습니다',
  105: '출발지가 도로 주변이 아닙니다',
  106: '도착지가 도로 주변이 아닙니다',
  107: '경유지가 도로 주변이 아닙니다',
};

// OSRM 방향 지시어 → 한국어
const MODIFIER: Record<string, string> = {
  'left': '좌회전',        'right': '우회전',
  'sharp left': '급좌회전', 'sharp right': '급우회전',
  'slight left': '좌측 방향', 'slight right': '우측 방향',
  'straight': '직진',      'uturn': '유턴',
};

export type Mode = 'walk' | 'car';

// 지점과 지점 사이 한 구간
export type Leg = {
  from: number;
  to: number;
  distance: number;      // m
  duration: number;      // 초
  path: { lat: number; lng: number }[];
};

// 길안내 한 줄
export type Guide = {
  leg: number;           // 몇 번째 구간에 속하는지 (0부터)
  text: string;
  distance: number;      // 이 지시 이후 진행할 거리 (m)
  lat: number;
  lng: number;
};

export type DirectionsResult = {
  mode: Mode;
  path: { lat: number; lng: number }[];
  legs: Leg[];
  guides: Guide[];
  duration: number;      // 초, 전체
  distance: number;      // m,  전체
  arriveAt: string;      // 지금 출발했을 때 최종 도착 시각 (HH:MM)
  raw: unknown;
  requested: string[];
};


// ###############################################################

// fetch + JSON 파싱. 실패 원인
async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e: any) {
    throw new Error(`네트워크 실패 — ${url}  (${e.cause?.code ?? e.message})`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 이 아닌 응답 (HTTP ${res.status}) — ${url}\n${text.slice(0, 300)}`);
  }
}


// ###############################################################

// 경도,위도 좌표 값으로 변경
function parsePoints(raw: string): { x: number; y: number }[] {
  const points = raw.split('|').map((p, i) => {
    const [x, y] = p.split(',').map(Number);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      throw new Error(`${i + 1}번째 지점 형식이 잘못됐습니다: "${p}" (경도,위도 로 주세요)`);
    }
    return { x, y };
  });

  if (points.length < 2) throw new Error('지점이 2개 이상 필요합니다');
  if (points.length - 2 > MAX_WAYPOINTS) {
    throw new Error(`경유지는 최대 ${MAX_WAYPOINTS}개입니다 (지금 ${points.length - 2}개)`);
  }
  return points;
}


// ###############################################################

// 초 뒤의 시각을 HH:MM 으로 변경
function arriveAt(seconds: number): string {
  const t = new Date(Date.now() + seconds * 1000 + 9 * 3600 * 1000);   // KST
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}


// ###############################################################

// 도보 · OSRM
// OSRM maneuver 를 한국어 안내 문구로 변경
function osrmGuideText(m: any, road: string): string {
  const dir = MODIFIER[m.modifier] ?? '';
  const where = road ? `${road}(으)로 ` : '';

  switch (m.type) {
    case 'depart':      return road ? `${road} 방향으로 출발` : '출발';
    case 'arrive':      return '도착';
    case 'turn':        return where + (dir || '진행');
    case 'new name':    return where + '계속 직진';
    case 'continue':    return where + (dir || '계속 직진');
    case 'end of road': return '길 끝에서 ' + (dir || '진행');
    case 'fork':        return '갈림길에서 ' + (dir || '진행');
    case 'merge':       return where + '합류';
    case 'roundabout':
    case 'rotary':      return '회전교차로 진입';
    case 'roundabout turn': return '회전교차로에서 ' + (dir || '진행');
    default:            return where + (dir || m.type);
  }
}


// ###############################################################

// 도보 경로 - OSRM
async function callWalk(points: { x: number; y: number }[]) {
  const coords = points.map(p => `${p.x},${p.y}`).join(';');
  const url = `${OSRM_FOOT}/${coords}?overview=false&geometries=geojson&steps=true`;

  const json = await fetchJson(url, { headers: { 'User-Agent': 'leftover-demo' } });
  if (json.code !== 'Ok') {
    throw new Error(`도보 경로 실패: ${json.code} ${json.message ?? ''}`);
  }

  const route = json.routes[0];
  const legs: Leg[] = [];
  const guides: Guide[] = [];

  route.legs.forEach((leg: any, i: number) => {
    const path: { lat: number; lng: number }[] = [];

    for (const step of leg.steps ?? []) {
      for (const [lng, lat] of step.geometry?.coordinates ?? []) {
        path.push({ lat, lng });
      }
      const m = step.maneuver;
      guides.push({
        leg: i,
        text: osrmGuideText(m, step.name ?? ''),
        distance: Math.round(step.distance),
        lng: m.location[0],
        lat: m.location[1],
      });
    }

    legs.push({ from: i, to: i + 1, distance: Math.round(leg.distance), duration: Math.round(leg.duration), path });
  });

  return {
    json, legs, guides,
    distance: Math.round(route.distance),
    duration: Math.round(route.duration),
    requested: [`GET ${url}`],
  };
}


// 자동차 · 카카오모빌리티


// ###############################################################

// 한 구간의 좌표를 펼치기
function sectionPath(section: any): { lat: number; lng: number }[] {
  const path: { lat: number; lng: number }[] = [];

  for (const road of section.roads ?? []) {
    const v: number[] = road.vertexes ?? [];
    for (let i = 0; i + 1 < v.length; i += 2) {
      path.push({ lng: v[i], lat: v[i + 1] });
    }
  }
  return path;
}


// ###############################################################

// 자동차 경로
async function callCar(points: { x: number; y: number }[]) {
  let json: any, requested: string[];

  if (points.length === 2) {
    const url = `${KAKAO_NAVI}?${new URLSearchParams({
      origin: `${points[0].x},${points[0].y}`,
      destination: `${points[1].x},${points[1].y}`,
      priority: 'RECOMMEND',
    })}`;
    json = await fetchJson(url, { headers: { Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` } });
    requested = [`GET ${url}`];
  } else {
    const body = {
      origin: points[0],
      destination: points[points.length - 1],
      waypoints: points.slice(1, -1),
      priority: 'RECOMMEND',
    };
    json = await fetchJson(KAKAO_NAVI_WAYPOINTS, {
      method: 'POST',
      headers: {
        Authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    requested = [`POST ${KAKAO_NAVI_WAYPOINTS}\n${JSON.stringify(body)}`];
  }

  if (json.errorType) throw new Error(`카카오모빌리티: ${json.msg ?? json.message}`);

  const route = json.routes?.[0];
  if (!route) throw new Error('경로 응답이 비어 있습니다');
  if (route.result_code !== 0) {
    throw new Error(`길찾기 실패 (${route.result_code}): ${RESULT_MSG[route.result_code] ?? route.result_msg}`);
  }

  const sections: any[] = route.sections ?? [];
  const legs: Leg[] = [];
  const guides: Guide[] = [];

  sections.forEach((s, i) => {
    legs.push({ from: i, to: i + 1, distance: s.distance, duration: s.duration, path: sectionPath(s) });

    // 카카오 안내 문구 한국어 그대로
    for (const g of s.guides ?? []) {
      guides.push({ leg: i, text: g.guidance || g.name, distance: g.distance, lat: g.y, lng: g.x });
    }
  });

  return {
    json, legs, guides,
    distance: route.summary.distance,
    duration: route.summary.duration,
    requested,
  };
}


// ###############################################################

// 여러 지점을 순서대로 도는 경로와 길안내.
export async function getDirections(points: string, mode: Mode = 'walk'): Promise<DirectionsResult> {
  if (mode !== 'walk' && mode !== 'car') {
    throw new Error(`mode 는 walk 또는 car 여야 합니다 (받은 값: ${mode})`);
  }

  const parsed = parsePoints(points);
  const r = mode === 'walk' ? await callWalk(parsed) : await callCar(parsed);

  return {
    mode,
    path: r.legs.flatMap(l => l.path),
    legs: r.legs,
    guides: r.guides,
    duration: r.duration,
    distance: r.distance,
    arriveAt: arriveAt(r.duration),
    raw: r.json,
    requested: r.requested,
  };
}


// ###############################################################

// 단독 실행 
if (import.meta.url === `file://${process.argv[1]}`) {
  // 기본값: 강남역 → 코엑스 → 서울숲 → 강남역 복귀
  const points = process.argv[2]
    ?? '127.0276,37.4979|127.0587,37.5126|127.0374,37.5444|127.0276,37.4979';
  const mode = (process.argv[3] as Mode) ?? 'walk';

  getDirections(points, mode).then(r => {
    console.log(`\n[${r.mode === 'walk' ? '도보' : '자동차'}]  ${r.requested[0].split('\n')[0]}`);

    console.log(`\n구간 ${r.legs.length}개`);
    r.legs.forEach(l => {
      console.log(`  ${l.from} → ${l.to}   ${(l.distance / 1000).toFixed(1)}km  ${Math.round(l.duration / 60)}분  (좌표 ${l.path.length}점)`);
    });

    console.log(`\n길안내 ${r.guides.length}줄 — 앞 8줄`);
    r.guides.slice(0, 8).forEach(g => {
      console.log(`  [구간${g.leg + 1}] ${String(g.distance).padStart(5)}m  ${g.text}`);
    });

    console.log(`\n총 ${(r.distance / 1000).toFixed(1)}km · ${Math.round(r.duration / 60)}분 · 도착 ${r.arriveAt}\n`);
  }).catch(e => { console.error('✗', e.message); process.exit(1); });
}
