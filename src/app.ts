import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store, type Profile } from './store.js';
import { buildMcpServer } from './mcp.js';
import { assistant } from './assistant.js';
import type { Place } from './places.js';
import { incidentView, verifyEvidence } from './incident.js';
import { makeCaller, type Caller } from './calle.js';
import { attachEscalation, type LadderOptions } from './escalation.js';
import { Policy } from './policy.js';
import type { Llm } from './understand.js';
import { makeSigner, type CapStatus } from './cap.js';
import { attachAuthorities } from './authority.js';
import { attachPrebrief } from './prebrief.js';
import { TEMPLATES, type Facts, type TemplateId } from './facts.js';
import { readFileSync as readSync, existsSync as exists } from 'node:fs';

export interface AppOptions {
  profile: Profile;
  dataDir: string;
  webDir: string;
  places: (lat: number, lon: number) => Promise<Place[] | null>;
  /** Bearer token Alexa+/MCP clients must send. Unset = open (local demo only). */
  mcpToken?: string;
  /** Key the traveller's page uses (in its link). */
  travellerKey: string;
  now?: () => number;
  log?: (m: string) => void;
  /** Phone calls for the escalation ladder (CALL-E). Default: dry run, no calls. */
  caller?: Caller;
  ladder?: Partial<LadderOptions>;
  /** Model for the understanding agent (after the SOS only). Default: rules only. */
  llm?: Llm | null;
  /** Authority agents (A2A) to send signed CAP alerts to, only with the traveller's consent. */
  /** Confirmed stops ahead (call once, share with everyone). */
  facts?: Facts;
  /** Route geometry for the maps (GeoJSON-like [lon, lat][]). */
  routeFile?: string;
  authorities?: { agents: string[]; token?: string; consent: boolean; status?: CapStatus; sender?: string; pollMs?: number };
}

const MAX_BODY = 16 * 1024;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const loc = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).nullable().optional() });
const TravellerMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('sos'), where: loc.optional(), said: z.string().max(500).optional(), cid: z.string().max(40).optional(), pressedAt: z.number().optional() }).strict(),
  z.object({ t: z.literal('say'), text: z.string().min(1).max(500) }).strict(),
  z.object({ t: z.literal('where'), where: loc }).strict(),
  z.object({ t: z.literal('relay'), enable: z.boolean() }).strict(),
  z.object({ t: z.literal('safe') }).strict(),
  z.object({ t: z.literal('cancel') }).strict(),
]);
const ContactMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('received') }).strict(),
  z.object({ t: z.literal('ack') }).strict(),
  z.object({ t: z.literal('where'), where: loc }).strict(),
  z.object({ t: z.literal('plan'), action: z.enum(['calling_her', 'going_there', 'calling_police', 'other']), etaMin: z.number().int().min(0).max(600).nullable().optional() }).strict(),
]);
const HelperMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('where'), where: loc, optIn: z.boolean(), name: z.string().min(1).max(40) }).strict(),
  z.object({ t: z.literal('offer'), incidentId: z.string().max(40), text: z.string().min(1).max(200) }).strict(),
]);
const AssistantReq = z.object({ text: z.string().min(1).max(500), latitude: z.number().optional(), longitude: z.number().optional() }).strict();

export function createApp(opts: AppOptions) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const store = new Store(opts.profile, opts.dataDir, now);
  attachEscalation(store, opts.caller ?? makeCaller({ dryRun: true }), opts.ladder, log);
  store.llm = opts.llm ?? null;
  const policy = new Policy(now);
  const signer = makeSigner('safestop-1', join(opts.dataDir, 'signing-key.json'));
  if (opts.authorities) {
    const a = opts.authorities;
    attachAuthorities(store, { agents: a.agents, token: a.token, consent: a.consent, status: a.status ?? 'Exercise', sender: a.sender ?? 'safestop@localhost', pollMs: a.pollMs, sign: async (p) => (await signer).sign(p), log });
  }
  const webRoot = resolve(opts.webDir);
  let mcpUrl: URL | null = null;
  let ask: ReturnType<typeof assistant> | null = null;

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((ok, fail) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          fail(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
      req.on('error', fail);
    });
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;

      // ---- MCP (the Alexa+ integration) ----
      if (p === '/mcp') {
        if (opts.mcpToken) {
          const auth = req.headers.authorization ?? '';
          if (!same(auth, `Bearer ${opts.mcpToken}`)) return json(res, 401, { error: 'unauthorized' });
        }
        if (req.method !== 'POST') return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null });
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
        }
        // Stateless Streamable HTTP: a fresh server + transport per request, all sharing one store.
        const mcp = buildMcpServer({ store, places: opts.places, policy, now, facts: opts.facts });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // ---- simulated Alexa+ (talks to /mcp like Alexa would) ----
      if (p === '/api/assistant' && req.method === 'POST') {
        if (!same(String(req.headers['x-traveller-key'] ?? ''), opts.travellerKey)) return json(res, 401, { error: 'unauthorized' });
        const parsed = AssistantReq.safeParse(JSON.parse(await readBody(req) || 'null'));
        if (!parsed.success) return json(res, 400, { error: 'bad request' });
        if (!ask) ask = assistant(mcpUrl!, opts.mcpToken);
        const turn = await ask(parsed.data.text, { sosActive: !!store.current(), latitude: parsed.data.latitude, longitude: parsed.data.longitude });
        log(`assistant: "${turn.said}" -> ${turn.tool ?? turn.intent} (${turn.ms} ms)`);
        return json(res, 200, turn);
      }

      if (p === '/api/places' && req.method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json(res, 400, { error: 'lat/lon' });
        return json(res, 200, { places: await opts.places(lat, lon), source: 'OpenStreetMap contributors (ODbL)', verified: false });
      }

      // After-incident report: only the traveller (her key) can open it; she decides whether to share it.
      const rep = /^\/api\/incident\/(inc_[a-f0-9]{12})\/report$/.exec(p);
      if (rep && req.method === 'GET') {
        if (!same(String(req.headers['x-traveller-key'] ?? ''), opts.travellerKey)) return json(res, 401, { error: 'unauthorized' });
        const inc = store.get(rep[1]);
        if (!inc) return json(res, 404, { error: 'not found' });
        return json(res, 200, { incident: incidentView(inc), evidence: inc.evidence, verified: verifyEvidence(inc) });
      }
      if (p === '/api/incidents' && req.method === 'GET') {
        if (!same(String(req.headers['x-traveller-key'] ?? ''), opts.travellerKey)) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, { incidents: [...store.incidents.values()].map((i) => ({ id: i.id, createdAt: i.createdAt, status: i.status })).reverse() });
      }

      // ---- confirmed stops ahead ----
      if (p === '/api/route' && req.method === 'GET') {
        if (!opts.routeFile || !exists(opts.routeFile)) return json(res, 404, { error: 'no route' });
        const r = JSON.parse(readSync(opts.routeFile, 'utf8'));
        return json(res, 200, { source: r.source, coordinates: r.coordinates });
      }
      if (p === '/api/stops' && req.method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!opts.facts || !Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 200, { stops: [], templates: TEMPLATES });
        return json(res, 200, { stops: opts.facts.near(lat, lon), templates: TEMPLATES });
      }
      const askM = /^\/api\/stops\/([a-z0-9]{2,24})\/ask$/.exec(p);
      if (askM && req.method === 'POST') {
        if (!same(String(req.headers['x-traveller-key'] ?? ''), opts.travellerKey)) return json(res, 401, { error: 'unauthorized' });
        if (!opts.facts) return json(res, 404, { error: 'no stops' });
        const b = z.object({ templateId: z.string().max(40).optional(), custom: z.string().max(200).optional(), confirm: z.boolean().optional() }).strict().safeParse(JSON.parse((await readBody(req)) || 'null'));
        if (!b.success) return json(res, 400, { error: 'bad request' });
        const r = await opts.facts.ask(askM[1], { templateId: b.data.templateId as TemplateId | undefined, custom: b.data.custom }, b.data.confirm === true);
        log(`stop ask ${askM[1]}: ${r.status}`);
        // 428 Precondition Required: nothing is dialled until the traveller confirms this exact preview.
        return json(res, r.status === 'needs_confirmation' ? 428 : 200, r);
      }

      if (p === '/.well-known/jwks.json') return json(res, 200, (await signer).jwks);
      if (p === '/api/health') return json(res, 200, { ok: true, contacts: opts.profile.contacts.map((c) => c.name), traveller: opts.profile.traveller });

      // ---- pages ----
      const page = p === '/' ? 'index.html' : p === '/traveller' ? 'traveller.html' : p.startsWith('/contact/') ? 'contact.html' : p === '/nearby' ? 'nearby.html' : p === '/report' ? 'report.html' : p.slice(1);
      const file = resolve(webRoot, page);
      if (!file.startsWith(webRoot + sep)) return json(res, 404, { error: 'not found' });
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(data);
      } catch {
        json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      log(`http error: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });

  // ---- live screens ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const travellers = new Set<WebSocket>();
  if (opts.facts) attachPrebrief(store, opts.facts, { log });
  if (opts.facts) opts.facts.onFact = (f) => { for (const ws of travellers) send(ws, { t: 'fact', fact: f }); };
  const contacts = new Map<WebSocket, string>(); // ws -> contactId
  const helpers = new Map<WebSocket, string>(); // ws -> helperId
  const send = (ws: WebSocket, m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

  store.on((e) => {
    if (e.to === 'traveller') {
      for (const ws of travellers) send(ws, { t: 'incident', incident: e.incident });
    } else if (e.to === 'contact') {
      for (const [ws, id] of contacts) if (id === e.contactId) send(ws, { t: 'incident', incident: e.incident });
    } else {
      for (const [ws, id] of helpers) if (id === e.helperId) send(ws, { t: 'relay', notice: e.notice });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const role = url.searchParams.get('role');
    const ok =
      (role === 'traveller' && same(url.searchParams.get('key') ?? '', opts.travellerKey)) ||
      (role === 'contact' && opts.profile.contacts.some((c) => same(c.token, url.searchParams.get('token') ?? ''))) ||
      role === 'helper';
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, role!, url.searchParams));
  });

  function attach(ws: WebSocket, role: string, q: URLSearchParams) {
    ws.on('error', (e) => log(`ws error: ${e.message}`));
    const cur = () => store.current();
    if (role === 'traveller') {
      travellers.add(ws);
      const inc = cur();
      send(ws, { t: 'hello', traveller: opts.profile.traveller, contacts: opts.profile.contacts.map((c) => c.name), incident: inc ? viewOf(inc.id) : null });
      ws.on('message', (d) => {
        const m = parse(TravellerMsg, d);
        if (!m) return send(ws, { t: 'error', error: 'bad message' });
        const at = now();
        const where = 'where' in m && m.where ? { lat: m.where.lat, lon: m.where.lon, accuracyM: m.where.accuracyM ?? null, at } : null;
        if (m.t === 'sos') {
          store.sos('quiet_button', where, m.said, m.pressedAt ?? null);
          // The phone keeps the SOS in its outbox until this arrives: only then does it say "sent".
          if (m.cid) send(ws, { t: 'ack', cid: m.cid });
        }
        const inc = cur();
        if (!inc) return;
        if (m.t === 'say') store.say(inc.id, m.text);
        else if (m.t === 'where' && where) store.location(inc.id, where);
        else if (m.t === 'relay') store.relay(inc.id, m.enable);
        else if (m.t === 'safe') store.resolve(inc.id, 'traveller');
        else if (m.t === 'cancel') store.resolve(inc.id, 'traveller', true);
      });
      ws.on('close', () => travellers.delete(ws));
    } else if (role === 'contact') {
      const token = q.get('token')!;
      const c = opts.profile.contacts.find((x) => x.token === token)!;
      contacts.set(ws, c.id);
      const inc = cur();
      send(ws, { t: 'hello', contact: c.name, traveller: opts.profile.traveller, incident: inc ? viewOf(inc.id) : null });
      ws.on('message', (d) => {
        const m = parse(ContactMsg, d);
        if (!m) return;
        // "delivered" only when this screen says it received the alert, never just because we sent it.
        if (m.t === 'where') store.contactWhere(token, m.where);
        else if (m.t === 'plan') store.plan(token, m.action, m.etaMin ?? null);
        else store.contact(token, m.t === 'received' ? 'delivered' : 'acknowledged');
      });
      ws.on('close', () => contacts.delete(ws));
    } else {
      const id = 'h_' + randomBytes(6).toString('hex');
      helpers.set(ws, id);
      send(ws, { t: 'hello', helperId: id });
      ws.on('message', (d) => {
        const m = parse(HelperMsg, d);
        if (!m) return;
        if (m.t === 'where') store.helperUpdate({ id, name: m.name.trim(), lat: m.where.lat, lon: m.where.lon, at: now(), optedIn: m.optIn });
        else send(ws, { t: 'offer_result', ok: store.offer(m.incidentId, id, m.text) });
      });
      ws.on('close', () => {
        helpers.delete(ws);
        store.helperGone(id);
      });
    }
  }

  const viewOf = (id: string) => {
    const inc = store.get(id);
    return inc ? incidentView(inc) : null;
  };

  return {
    store,
    server,
    listen(port: number, host?: string) {
      return new Promise<number>((ok) =>
        server.listen(port, host, () => {
          const a = server.address();
          const actual = typeof a === 'object' && a ? a.port : port;
          mcpUrl = new URL(`http://127.0.0.1:${actual}/mcp`);
          ok(actual);
        }),
      );
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      return new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

function parse<T>(schema: z.ZodType<T>, d: unknown): T | null {
  try {
    const r = schema.safeParse(JSON.parse(String(d)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
