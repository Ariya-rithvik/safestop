import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createDesk, nearestUnit, unitsOnRoute } from '../patrol/patrol.js';
import { capXml, makeSigner, toCap, verifySigned } from '../src/cap.js';
import { quietSos, incidentView } from '../src/incident.js';
import { statusSentence } from '../src/mcp.js';

const route = JSON.parse(readFileSync('evals/route-krishnagiri-vellore.json', 'utf8')).coordinates as [number, number][];
const units = unitsOnRoute(route);
const [lon, lat] = route[Math.floor(route.length * 0.4)]; // a point on the real road, near HP-12
const until = async (pred: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function setup(consent = true, token = 'auth_demo_token') {
  let safestop = '';
  const desk = createDesk({ port: 0, token, units, webDir: 'patrol', safestopJwks: async () => (await (await fetch(`${safestop}/.well-known/jwks.json`)).json()) as { keys: any[] } });
  const deskPort = await desk.listen();
  const app = createApp({
    profile: { traveller: 'Priya', contacts: [{ id: 'c1', name: 'Ravi', token: 'tok_ravi_auth1' }] },
    dataDir: mkdtempSync(join(tmpdir(), 'auth-')), webDir: tmpdir(), travellerKey: 'key_auth_12345', places: async () => [],
    authorities: { agents: [`http://localhost:${deskPort}`], token, consent, pollMs: 30 },
  });
  const port = await app.listen(0, '127.0.0.1');
  safestop = `http://127.0.0.1:${port}`;
  return { app, desk, close: async () => { await app.close(); await desk.close(); } };
}

test('CAP 1.2: the incident as a standard alert; certainty never above "Possible"; XML with the CAP namespace', () => {
  const inc = quietSos({ traveller: 'Priya', contacts: [], at: Date.parse('2026-10-19T17:30:00Z'), trigger: 'mcp', location: { lat: 12.9165, lon: 79.1325, accuracyM: 20, at: 1 } });
  inc.playbook = 'followed';
  inc.severity = 'high';
  inc.facts = { vehicle: 'white Innova', plate: 'TN 09 AB 1234' };
  const a = toCap(inc, { sender: 'safestop@test', status: 'Exercise', at: Date.parse('2026-10-19T17:30:01Z'), first: true })!;
  assert.deepEqual([a.status, a.msgType, a.scope, a.info.urgency, a.info.severity, a.info.certainty], ['Exercise', 'Alert', 'Restricted', 'Immediate', 'Severe', 'Possible']);
  assert.equal(a.sent, '2026-10-19T17:30:01+00:00');
  assert.deepEqual(a.info.area.circle, ['12.91650,79.13250 0.1']);
  assert.match(a.info.description, /plate: TN 09 AB 1234/);
  assert.match(capXml(a), /^<\?xml[^>]+>\n<alert xmlns="urn:oasis:names:tc:emergency:cap:1\.2">/);
  assert.equal(toCap({ ...inc, location: null }, { sender: 's', status: 'Exercise', at: 1, first: true }), null, 'nothing to act on without a location');
});

test('signatures: a changed alert or a stranger key does not verify', async () => {
  const s = await makeSigner();
  const other = await makeSigner();
  const inc = quietSos({ traveller: 'Priya', contacts: [], at: 1, trigger: 'mcp', location: { lat: 12.9, lon: 79.1, accuracyM: 10, at: 1 } });
  const jws = await s.sign(toCap(inc, { sender: 'x', status: 'Exercise', at: 1, first: true }));
  assert.equal((await verifySigned(jws, s.jwks)).identifier, `safestop-${inc.id}`);
  const [h, p, sig] = jws.split('.');
  const forged = [h, Buffer.from(Buffer.from(p, 'base64url').toString().replace('12.9', '13.9')).toString('base64url'), sig].join('.');
  await assert.rejects(verifySigned(forged, s.jwks));
  await assert.rejects(verifySigned(jws, other.jwks), 'signed by someone else');
});

test('A2A: the patrol agent answers in milliseconds and prepares; only the officer dispatches; honest states throughout', async () => {
  const s = await setup();
  try {
    const inc = s.app.store.sos('mcp', { lat, lon, accuracyM: 15, at: Date.now() });
    await until(() => inc.authorities[0]?.state === 'prepared');
    const link = inc.authorities[0];
    assert.equal(link.name, 'Highway Patrol Desk (SIMULATED)');
    assert.ok(link.ackMs !== null && link.ackMs < 1000, `machine acknowledgement in ${link.ackMs} ms`);
    assert.match(link.unit ?? '', /HP-12/, 'nearest simulated unit on the real road');
    assert.match(statusSentence(incidentView(inc)), /Highway Patrol Desk \(SIMULATED\) has received it; an officer has not decided yet/);
    // Nothing is dispatched until a human decides.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(inc.authorities[0].state, 'prepared');
    const [deskCase] = [...s.desk.cases.values()];
    assert.equal(deskCase.decision, null);
    // The officer dispatches.
    assert.equal(await s.desk.decide(deskCase.alert.identifier, 'dispatch'), true);
    await until(() => inc.authorities[0].state === 'dispatched');
    assert.match(statusSentence(incidentView(inc)), /an officer at Highway Patrol Desk \(SIMULATED\) dispatched Highway patrol HP-12 \(simulated\), about \d+ minutes away/);
    // She confirms safe: the desk is told (CAP Cancel) and closes its case.
    s.app.store.resolve(inc.id, 'traveller');
    await until(() => deskCase.closed);
    assert.ok(inc.evidence.some((e) => /agent acknowledged in \d+ ms/.test(e.text)));
  } finally {
    await s.close();
  }
});

test('A2A: officer declines -> SafeStop says so and points to 112; no consent -> no authority is contacted', async () => {
  const s = await setup();
  try {
    const inc = s.app.store.sos('mcp', { lat, lon, accuracyM: 15, at: Date.now() });
    await until(() => inc.authorities[0]?.state === 'prepared');
    await s.desk.decide([...s.desk.cases.values()][0].alert.identifier, 'decline');
    await until(() => inc.authorities[0].state === 'declined');
    assert.match(statusSentence(incidentView(inc)), /declined, so please call 112/);
  } finally {
    await s.close();
  }
  const n = await setup(false);
  try {
    const inc = n.app.store.sos('mcp', { lat, lon, accuracyM: 15, at: Date.now() });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(inc.authorities.length, 0);
    assert.equal(n.desk.cases.size, 0);
  } finally {
    await n.close();
  }
});

test('A2A: a caller without the token, or an alert not signed by SafeStop, is refused', async () => {
  const s = await setup();
  try {
    const inc = s.app.store.sos('mcp', { lat, lon, accuracyM: 15, at: Date.now() });
    await until(() => inc.authorities[0]?.state === 'prepared');
    const url = inc.authorities[0].agentUrl;
    const noToken = await fetch(url + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }) });
    assert.equal(noToken.status, 401);
    const other = await makeSigner();
    const forged = await other.sign(toCap({ ...quietSos({ traveller: 'X', contacts: [], at: 1, trigger: 'mcp' }), location: { lat, lon, accuracyM: 5, at: 1 } }, { sender: 'evil', status: 'Actual', at: 1, first: true }));
    const { ClientFactory } = await import('@a2a-js/sdk/client');
    const { Role } = await import('@a2a-js/sdk');
    const c = await new ClientFactory().createFromUrl(url);
    const res = await c.sendMessage({ tenant: '', configuration: undefined, metadata: {}, message: { role: Role.ROLE_USER, messageId: 'm1', taskId: '', contextId: '', extensions: [], metadata: {}, referenceTaskIds: [], parts: [{ content: { $case: 'data', value: { jws: forged } }, metadata: undefined, filename: '', mediaType: 'application/json' }] } }, { serviceParameters: { authorization: 'Bearer auth_demo_token' } });
    assert.ok('status' in res);
    assert.match(JSON.stringify(res.status), /Signature did not verify/);
    assert.equal(s.desk.cases.size, 1, 'the forged alert created no case');
  } finally {
    await s.close();
  }
});

test('nearest unit uses the real road positions', () => {
  const n = nearestUnit(units, lat, lon)!;
  assert.equal(n.unit.id, 'HP-12');
  assert.ok(n.etaMin >= 1);
});
