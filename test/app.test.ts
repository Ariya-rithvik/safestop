import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.js';
import { route } from '../src/assistant.js';

type Msg = Record<string, any>;
class Sock {
  msgs: Msg[] = [];
  waiters: { pred: (m: Msg) => boolean; ok: (m: Msg) => void }[] = [];
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.ok(m); }
    });
  }
  static open(url: string) {
    const ws = new WebSocket(url);
    const s = new Sock(ws);
    return new Promise<Sock>((ok, fail) => { ws.once('open', () => ok(s)); ws.once('error', fail); });
  }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  next(pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
    const f = this.msgs.find(pred);
    if (f) { this.msgs.splice(this.msgs.indexOf(f), 1); return Promise.resolve(f); }
    return new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('timeout; got ' + JSON.stringify(this.msgs.slice(-3)))), ms);
      this.waiters.push({ pred, ok: (m) => { clearTimeout(t); this.msgs.splice(this.msgs.indexOf(m), 1); ok(m); } });
    });
  }
}

const here = { lat: 12.9165, lon: 79.1325 };

async function setup(mcpToken?: string) {
  const app = createApp({
    profile: { traveller: 'Priya', contacts: [{ id: 'c1', name: 'Ravi', token: 'tok_ravi_123456' }, { id: 'c2', name: 'Meena', token: 'tok_meena_12345' }] },
    dataDir: mkdtempSync(join(tmpdir(), 'ss-')), webDir: join(tmpdir(), 'none'), travellerKey: 'key_test_1234',
    places: async () => [{ kind: 'police', label: 'Police', name: 'Bagayam Police Station', lat: 12.9, lon: 79.13, distanceM: 1800, open24h: null, source: 'OpenStreetMap', verified: false }],
    mcpToken,
  });
  const port = await app.listen(0, '127.0.0.1');
  return { app, port, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
}

async function mcpClient(base: string, token?: string) {
  const c = new Client({ name: 'test-alexa', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined));
  return c;
}
const text = (r: any) => r.content.map((c: any) => c.text).join(' ');

test('MCP: protocol 2025-11-25 over Streamable HTTP, eight tools, quiet_sos alerts contacts first', async () => {
  const s = await setup();
  try {
    assert.equal(LATEST_PROTOCOL_VERSION, '2025-11-25');
    const ravi = await Sock.open(`${s.ws}?role=contact&token=tok_ravi_123456`);
    await ravi.next((m) => m.t === 'hello');
    const c = await mcpClient(s.http);
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['cancel_sos', 'check_stop_ahead', 'im_safe', 'quiet_sos', 'roadside_guidance', 'safe_places_nearby', 'share_with_nearby_travellers', 'sos_status']);
    const r = await c.callTool({ name: 'quiet_sos', arguments: { situation: 'a man says he is police but has no uniform', latitude: here.lat, longitude: here.lon } });
    assert.match(text(r), /I've alerted Ravi and Meena\. You can stay inside and check first.*112/);
    const alert = await ravi.next((m) => m.t === 'incident');
    assert.equal(alert.incident.contacts[0].state, 'sent');
    // Ravi's screen confirms it received the alert, then he taps "I'm on it".
    ravi.send({ t: 'received' });
    await ravi.next((m) => m.t === 'incident' && m.incident.contacts[0].state === 'delivered');
    assert.match(text(await c.callTool({ name: 'sos_status', arguments: {} })), /reached Ravi's phone; it is sent to Meena but not confirmed yet/);
    ravi.send({ t: 'ack' });
    await ravi.next((m) => m.t === 'incident' && m.incident.contacts[0].state === 'acknowledged');
    assert.match(text(await c.callTool({ name: 'sos_status', arguments: {} })), /Ravi has seen it and is responding/);
    assert.match(text(await c.callTool({ name: 'safe_places_nearby', arguments: { latitude: here.lat, longitude: here.lon } })), /not verified: Police Bagayam Police Station, 1\.8 km/);
    // Silencing an alert takes two requests: one misheard word cannot switch it off.
    assert.match(text(await c.callTool({ name: 'im_safe', arguments: {} })), /say "I'm safe" once more/);
    assert.match(text(await c.callTool({ name: 'im_safe', arguments: {} })), /Glad you are safe/);
    const closed = await ravi.next((m) => m.t === 'incident' && m.incident.status === 'resolved');
    assert.ok(closed.incident.safeConfirmedAt, 'contacts see the traveller confirmed safe');
    await c.close();
    ravi.ws.close();
  } finally {
    await s.app.close();
  }
});

test('MCP: a token is required when configured', async () => {
  const s = await setup('mcp_secret_token');
  try {
    const res = await fetch(s.http + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    assert.equal(res.status, 401);
    const c = await mcpClient(s.http, 'mcp_secret_token');
    assert.equal((await c.listTools()).tools.length, 8);
    await c.close();
  } finally {
    await s.app.close();
  }
});

test('nearby relay over sockets: opt-in only, stranger sees no name or coordinates, offer reaches the traveller labelled unverified', async () => {
  const s = await setup();
  try {
    const priya = await Sock.open(`${s.ws}?role=traveller&key=key_test_1234`);
    await priya.next((m) => m.t === 'hello');
    const arun = await Sock.open(`${s.ws}?role=helper`);
    await arun.next((m) => m.t === 'hello');
    arun.send({ t: 'where', where: { lat: 12.9200, lon: 79.1325 }, optIn: true, name: 'Arun' });
    const far = await Sock.open(`${s.ws}?role=helper`);
    await far.next((m) => m.t === 'hello');
    far.send({ t: 'where', where: { lat: 13.0827, lon: 80.2707 }, optIn: true, name: 'Chennai' });
    priya.send({ t: 'sos', where: { lat: here.lat, lon: here.lon, accuracyM: 12 } });
    const inc = await priya.next((m) => m.t === 'incident');
    assert.equal(inc.incident.relay, null, 'no relay until she opts in');
    priya.send({ t: 'relay', enable: true });
    const notice = await arun.next((m) => m.t === 'relay');
    assert.equal(notice.notice.label, 'Unverified');
    assert.equal(notice.notice.band, 'about 300-600 m away');
    assert.doesNotMatch(JSON.stringify(notice), /Priya|12\.91|79\.13/);
    assert.equal(far.msgs.some((m) => m.t === 'relay'), false, 'a traveller 150 km away is not asked');
    const withRelay = await priya.next((m) => m.t === 'incident' && m.incident.relay?.enabled);
    assert.equal(withRelay.incident.relay.notified, 1);
    arun.send({ t: 'offer', incidentId: notice.notice.incidentId, text: 'I am at the HP pump 400 m ahead, can wait there' });
    assert.equal((await arun.next((m) => m.t === 'offer_result')).ok, true);
    const offered = await priya.next((m) => m.t === 'incident' && m.incident.relay?.offers.length === 1);
    assert.equal(offered.incident.relay.label, 'Unverified');
    priya.send({ t: 'cancel' });
    assert.deepEqual((await arun.next((m) => m.t === 'relay' && m.notice.closed)).notice.closed, true, 'strangers are told it is over');
    for (const x of [priya, arun, far]) x.ws.close();
  } finally {
    await s.app.close();
  }
});

test('simulated Alexa+: goes through MCP; SOS intent wins; bad keys and bad messages are refused', async () => {
  const s = await setup();
  try {
    const ask = (t: string, key = 'key_test_1234') =>
      fetch(s.http + '/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json', 'x-traveller-key': key }, body: JSON.stringify({ text: t, latitude: here.lat, longitude: here.lon }) });
    assert.equal((await ask('hello', 'wrong')).status, 401);
    const g = await (await ask('something hit my windshield')).json();
    assert.deepEqual([g.intent, g.tool], ['roadside_guidance', 'roadside_guidance'], 'no alert without asking');
    const sos = await (await ask('pineapple')).json();
    assert.deepEqual([sos.intent, sos.tool], ['quiet_sos', 'quiet_sos'], 'the safe word starts an SOS');
    assert.match(sos.reply, /alerted Ravi and Meena/);
    const more = await (await ask('a car is following me')).json();
    assert.equal(more.tool, 'quiet_sos', 'during an SOS, describing the situation updates it');
    assert.equal(more.data.playbook.id, 'followed');
    const st = await (await ask('did anyone see it')).json();
    assert.equal(st.tool, 'sos_status');
    const bad = await Sock.open(`${s.ws}?role=traveller&key=key_test_1234`);
    await bad.next((m) => m.t === 'hello');
    bad.send({ t: 'sos', extra: 1 });
    assert.equal((await bad.next((m) => m.t === 'error')).error, 'bad message');
    bad.ws.close();
    const denied = new WebSocket(`${s.ws}?role=traveller&key=nope`);
    await new Promise<void>((ok) => denied.on('error', () => ok()));
  } finally {
    await s.app.close();
  }
});

test('intent routing', () => {
  assert.equal(route('Alexa, pineapple', false), 'quiet_sos');
  assert.equal(route('alert my family', false), 'quiet_sos');
  assert.equal(route('मदद करो', false), 'quiet_sos');
  assert.equal(route('someone is waving me down', false), 'roadside_guidance');
  assert.equal(route('someone is waving me down', true), 'quiet_sos');
  assert.equal(route("I'm safe now", true), 'im_safe');
  assert.equal(route('cancel, it was a mistake', true), 'cancel_sos');
  assert.equal(route('where is the nearest police station', true), 'safe_places_nearby');
  assert.equal(route('ask nearby travellers', true), 'share_with_nearby_travellers');
  assert.equal(route('stop sharing', true), 'stop_sharing');
  assert.equal(route('what is the weather', false), 'unknown');
});
