// Replay drill: one night drive on a real road, run through the real SafeStop server.
// - Road: Krishnagiri -> Vellore, real geometry from OpenStreetMap (OSRM route, evals/route-krishnagiri-vellore.json).
// - SIMULATED: the traveller's phone, a 2 km dead zone, the three contacts and the nearby travellers.
// - Real: the server, its agents, the escalation ladder, the WebSockets, the relay privacy rules.
// Time runs 20x faster; every time printed is converted back to real-world seconds.
// Usage: npm run drill
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { distanceM, verifyEvidence } from '../src/incident.js';
import type { Caller } from '../src/calle.js';
import { createDesk, unitsOnRoute } from '../patrol/patrol.js';

const SCALE = 20;
const S = (realSeconds: number) => (realSeconds * 1000) / SCALE; // real-world seconds -> drill ms
const toReal = (ms: number) => (ms * SCALE) / 1000;
const SPEED_KMH = 70;

const route = JSON.parse(readFileSync('evals/route-krishnagiri-vellore.json', 'utf8')) as { distance_m: number; refs: string[]; coordinates: [number, number][]; source: string };
const pts = route.coordinates.map(([lon, lat]) => ({ lat, lon }));
const cum = [0];
for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distanceM(pts[i - 1], pts[i]));
const at = (km: number) => {
  const m = km * 1000;
  const i = Math.max(1, cum.findIndex((c) => c >= m));
  const f = (m - cum[i - 1]) / Math.max(1, cum[i] - cum[i - 1]);
  return { lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * f, lon: pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * f };
};

// Simulated CALL-E: Ravi does not pick up; Meena answers and says yes.
const answers: Record<string, { heard: boolean; willHelp: boolean; said: string }> = {
  c1: { heard: false, willHelp: false, said: '' },
  c2: { heard: true, willHelp: true, said: 'yes, I am calling her now' },
};
const callTimes: { who: string; ms: number }[] = [];
const caller: Caller = {
  mode: 'live',
  async place(p) { callTimes.push({ who: p.contactId, ms: performance.now() }); return { status: 'placed', callId: p.contactId }; },
  async poll(id) { return { status: 'completed', terminal: true, ...answers[id] }; },
};

// SIMULATED highway patrol desk (A2A agent); its officer decides 40 s after the alert arrives.
let safestopBase = '';
const desk = createDesk({ port: 0, token: 'drill_token', units: unitsOnRoute(route.coordinates), webDir: 'patrol', safestopJwks: async () => (await (await fetch(`${safestopBase}/.well-known/jwks.json`)).json()) as { keys: any[] } });
const deskPort = await desk.listen();

const app = createApp({
  profile: {
    traveller: 'Priya',
    contacts: [
      { id: 'c1', name: 'Ravi', token: 'tok_drill_ravi1', phone: '+919800000001' },
      { id: 'c2', name: 'Meena', token: 'tok_drill_meena', phone: '+919800000002' },
      { id: 'c3', name: 'Arjun', token: 'tok_drill_arjun' },
    ],
  },
  dataDir: mkdtempSync(join(tmpdir(), 'drill-')), webDir: tmpdir(), travellerKey: 'key_drill_1234', places: async () => [],
  authorities: { agents: [`http://localhost:${deskPort}`], token: 'drill_token', consent: true, pollMs: S(2) },
  caller, ladder: { graceMs: S(30), settleMs: S(45), pollMs: S(8), maxCallMs: S(240), gapMs: S(2) },
});
const port = await app.listen(0, '127.0.0.1');
safestopBase = `http://127.0.0.1:${port}`;
const url = (q: string) => `ws://127.0.0.1:${port}/ws?${q}`;
const open = (q: string) => new Promise<WebSocket>((ok) => { const w = new WebSocket(url(q)); w.once('open', () => ok(w)); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The traveller's phone: SOS goes into an outbox and is sent only when there is signal.
const priya = await open('role=traveller&key=key_drill_1234');
const outbox: object[] = [];
let signal = true;
const flush = () => { if (signal) while (outbox.length) priya.send(JSON.stringify(outbox.shift())); };

// Two contacts have the page open; Arjun never opens it. Nobody taps.
const firstPage: Record<string, number> = {};
for (const [name, tok] of [['Ravi', 'tok_drill_ravi1'], ['Meena', 'tok_drill_meena']]) {
  const w = await open(`role=contact&token=${tok}`);
  w.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'incident' && m.incident.status === 'open' && !firstPage[name]) firstPage[name] = performance.now(); });
}

// Nearby SafeStop users (opted in), positioned on the same road.
const SOS_KM = 61;
const helpers = [
  { name: 'Arun', km: SOS_KM + 0.4 },
  { name: 'Kavya', km: SOS_KM - 0.7 },
  { name: 'Far away', km: SOS_KM + 3 },
];
const notified: string[] = [];
let leak = false;
for (const h of helpers) {
  const w = await open('role=helper');
  w.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'relay' && !m.notice.closed) { notified.push(h.name); if (/Priya|\d{2}\.\d{3}/.test(JSON.stringify(m))) leak = true; }
  });
  w.send(JSON.stringify({ t: 'where', where: at(h.km), optIn: true, name: h.name }));
}
await sleep(100);

// Drive: the dead zone is km 60-62; she presses SOS at km 61.
const dzMs = S(((2 / SPEED_KMH) * 3600) / 2); // half of the 2 km dead zone remains after km 61
signal = false;
const pressed = performance.now();
outbox.push({ t: 'sos', cid: 'drill1', pressedAt: Date.now(), where: { ...at(SOS_KM), accuracyM: 15 } });
flush();
await sleep(dzMs);
signal = true;
const signalBack = performance.now();
let serverAt = 0;
priya.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'ack' && !serverAt) serverAt = performance.now(); });
flush();
await sleep(S(3));
priya.send(JSON.stringify({ t: 'relay', enable: true }));
// The officer (human, simulated) decides 40 real-world seconds after the desk received it.
void (async () => { while (!desk.cases.size) await sleep(10); await sleep(S(40)); await desk.decide([...desk.cases.keys()][0], 'dispatch'); })();
// Let the ladder run: grace, Ravi's call (no answer), Meena's call (yes).
const inc = () => app.store.current();
const t0 = performance.now();
let dispatchedAt = 0;
while ((inc()?.ladder.state !== 'done' || !dispatchedAt) && performance.now() - t0 < S(600)) { if (!dispatchedAt && inc()?.authorities[0]?.state === 'dispatched') dispatchedAt = performance.now(); await sleep(20); }
const i = inc()!;
const meena = i.contacts.find((c) => c.name === 'Meena')!;
const delivered = serverAt || signalBack;

const sec = (ms: number) => `${toReal(ms).toFixed(0)} s`;
console.log(`\nSafeStop drill · simulated drive on a real road: Krishnagiri -> Vellore, ${(route.distance_m / 1000).toFixed(0)} km (${route.source}; refs ${route.refs.join(', ')})`);
console.log('Simulated: the phone, a 2 km dead zone, three contacts (Ravi does not answer, Meena says yes, Arjun never opens the link), three nearby SafeStop users. Real: the server, agents, ladder, sockets.\n');
console.log(`- SOS pressed at km ${SOS_KM}, inside the dead zone: kept on the phone ${sec(signalBack - pressed)}, delivered ${((delivered - signalBack) / 1000 * SCALE).toFixed(1)} s after signal returned; the record says "pressed ${sec(signalBack - pressed)} earlier without signal".`);
console.log(`- Contacts with the page open had it ${((Math.max(...Object.values(firstPage)) - delivered) / 1000 * SCALE).toFixed(1)} s after delivery (Ravi, Meena). Nobody tapped.`);
console.log(`- Escalation: Ravi phoned at +${sec(callTimes[0].ms - delivered)} (no answer); Meena phoned at +${sec(callTimes[1].ms - delivered)}; she said yes, acknowledged ${meena.channel === 'call' ? 'by phone' : '?'}; ladder stopped (Arjun, page-only, was never phoned).`);
console.log(`- Nearby relay: ${notified.length} of ${helpers.length} SafeStop users asked (${notified.join(', ')}; the one 3 km away was not). Name or coordinates in what they received: ${leak ? 'YES (FAIL)' : 'none'}.`);
const auth = i.authorities[0];
console.log(`- Highway patrol desk (SIMULATED, A2A + signed CAP): its agent verified the alert and prepared ${auth?.unit ?? '?'} in ${auth?.ackMs ?? '?'} ms (real, not scaled); the officer (simulated human) dispatched at +${dispatchedAt ? sec(dispatchedAt - delivered) : '?'}. Machine acknowledgement vs first human phone confirmation: ${auth?.ackMs} ms vs ${sec(callTimes[1].ms - delivered + S(45))}.`);
console.log(`- Evidence chain: ${i.evidence.length} entries, hash chain verified: ${verifyEvidence(i)}.`);
await app.close();
await desk.close();
process.exit(0);
