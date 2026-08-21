// index.html 서빙 + /api/* 를 각 모듈 함수로 연결
// API 호출 로직 없음. spots.ts / realtime.ts / directions.ts 안에 있음

import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

import { getSpots } from './spots.ts';
import { getRealtime } from './realtime.ts';
import { getDirections } from './directions.ts';

const PORT = 3000;
const REQUIRED_ENV = ['KAKAO_REST_KEY', 'KAKAO_JS_KEY', 'DATA_GO_KR_KEY', 'SEOUL_API_KEY'];

// 파라미터가 잘못된 요청 (500 아니라 400으로 구분)
class BadRequest extends Error {}


// ###############################################################

// .env 키 검사. 하나라도 비면 종료
function requireEnv(): void {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length === 0) return;

  console.error('✗ .env 에 다음 키가 없습니다:', missing.join(', '));
  console.error('  실행:  npm run dev   (내부적으로 --env-file=.env 사용)');
  process.exit(1);
}


// ###############################################################

// 쿼리에서 숫자 꺼내기 (없으면 fallback, 그것도 없으면 400)
function num(q: URLSearchParams, key: string, fallback?: number): number {
  const raw = q.get(key);
  if (raw === null) {
    if (fallback !== undefined) return fallback;
    throw new BadRequest(`쿼리 파라미터 '${key}' 가 필요합니다`);
  }
  const n = Number(raw);
  if (Number.isNaN(n)) throw new BadRequest(`'${key}' 가 숫자가 아닙니다: ${raw}`);
  return n;
}


// ###############################################################

// 쿼리에서 문자열 꺼내기 (없으면 400)
function str(q: URLSearchParams, key: string): string {
  const raw = q.get(key);
  if (!raw) throw new BadRequest(`쿼리 파라미터 '${key}' 가 필요합니다`);
  return raw;
}


// URL → 모듈 함수. API 추가 시 여기 한 줄만
const ROUTES: Record<string, (q: URLSearchParams) => Promise<unknown>> = {
  '/api/spots':      q => getSpots(num(q, 'lat'), num(q, 'lng'), num(q, 'radius', 1000)),
  '/api/realtime':   q => getRealtime(num(q, 'lat'), num(q, 'lng')),
  '/api/directions': q => getDirections(str(q, 'points'), (q.get('mode') as any) ?? 'walk'),
};


// ###############################################################

// index.html 읽어서 지도 SDK 키 주입 (요청마다 새로 읽음)
async function sendHtml(res: ServerResponse): Promise<void> {
  const html = (await readFile('./index.html', 'utf-8'))
    .replace('__KAKAO_JS_KEY__', process.env.KAKAO_JS_KEY!);

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}


// ###############################################################

// JSON 응답 전송
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}


// ###############################################################

// 요청 한 줄 로그
function log(path: string, status: number, ms: number, err?: unknown): void {
  const line = `${String(status).padEnd(4)} ${path.padEnd(28)} ${ms}ms`;
  err ? console.error(line, '·', String(err)) : console.log(line);
}


// ###############################################################

// / 는 HTML, /api/* 는 ROUTES, 나머지는 404
async function handle(req: { url?: string; headers: { host?: string } }, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const { pathname, searchParams } = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (pathname === '/') {
    await sendHtml(res);
    return log(pathname, 200, Date.now() - started);
  }

  const route = ROUTES[pathname];
  if (!route) {
    sendJson(res, 404, { error: `알 수 없는 경로: ${pathname}` });
    return log(pathname, 404, Date.now() - started);
  }

  try {
    const data = await route(searchParams);
    sendJson(res, 200, data);
    log(pathname, 200, Date.now() - started);
  } catch (e) {
    const status = e instanceof BadRequest ? 400 : 500;
    sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
    log(pathname, status, Date.now() - started, e);
  }
}


// 시작
requireEnv();

createServer(handle)
  .listen(PORT, () => console.log(`\n  leftover → http://localhost:${PORT}\n`))
  .on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') console.error(`✗ 포트 ${PORT} 가 이미 사용 중입니다`);
    else console.error(e);
    process.exit(1);
  });
