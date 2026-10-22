import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { attachEscalation } from '../src/escalation.js';
import { buildTask, makeCaller, type Caller, type CallOutcome } from '../src/calle.js';
import { incidentView } from '../src/incident.js';
import { statusSentence } from '../src/mcp.js';

const fast = { graceMs: 30, settleMs: 5, pollMs: 5, maxCallMs: 200, gapMs: 1 };
const profile = () => ({
  traveller: 'Priya',
  contacts: [
    { id: 'c1', name: 'Ravi', token: 't1', phone: '+919800000001' },
    { id: 'c2', name: 'Meena', token: 't2', phone: '+919800000002' },
    { id: 'c3', name: 'Arjun', token: 't3' }, // no phone: paged only, never called
  ],
});

function fakeCaller(answers: Record<string, Partial<CallOutcome>>) {
  const calls: { phone: string; task: string; contactId: string }[] = [];
  const caller: Caller = {
    mode: 'live',
    async place(p) {
      calls.push({ phone: p.phone, task: p.task, contactId: p.contactId });
      return { status: 'placed', callId: p.contactId };
    },
    async poll(id) {
      return { status: 'completed', terminal: true, heard: false, willHelp: false, said: '', ...answers[id] };
    },
  };
  return { caller, calls };
}

const until = async (pred: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('ladder: nobody taps, so contacts are phoned in order; the first "yes" on a call acknowledges and stops it', async () => {
  const store = new Store(profile(), mkdtempSync(join(tmpdir(), 'esc-')));
  const { caller, calls } = fakeCaller({ c1: { heard: true, willHelp: false, said: 'who is this' }, c2: { heard: true, willHelp: true, said: 'yes I am calling her now' } });
  attachEscalation(store, caller, fast);
  const inc = store.sos('voice', { lat: 12.9, lon: 79.1, accuracyM: 10, at: Date.now() });
  await until(() => inc.ladder.state === 'done');
  assert.deepEqual(calls.map((c) => c.contactId), ['c1', 'c2'], 'Ravi first, then Meena; Arjun has no phone');
  const [ravi, meena, arjun] = inc.contacts;
  assert.equal(ravi.state, 'sent', 'Ravi heard the call but did not say yes: not acknowledged');
  assert.equal(ravi.call?.state, 'heard');
  assert.deepEqual([meena.state, meena.channel, meena.call?.state], ['acknowledged', 'call', 'confirmed']);
  assert.equal(arjun.call, null);
  assert.match(statusSentence(incidentView(inc)), /Meena \(said yes on a phone call\) has seen it/);
});

test('ladder: a tap on the page during the grace period means nobody is phoned', async () => {
  const store = new Store(profile(), mkdtempSync(join(tmpdir(), 'esc-')));
  const { caller, calls } = fakeCaller({});
  attachEscalation(store, caller, fast);
  const inc = store.sos('quiet_button');
  store.contact('t3', 'acknowledged');
  await until(() => inc.ladder.state === 'done');
  assert.equal(calls.length, 0);
});

test('ladder: nobody confirms anywhere, so it says so and points to 112; each contact is called at most once', async () => {
  const store = new Store(profile(), mkdtempSync(join(tmpdir(), 'esc-')));
  const { caller, calls } = fakeCaller({});
  attachEscalation(store, caller, fast);
  const inc = store.sos('voice');
  await until(() => inc.ladder.state === 'exhausted');
  assert.equal(calls.length, 2);
  assert.deepEqual(inc.contacts.slice(0, 2).map((c) => c.call?.state), ['no_answer', 'no_answer']);
  assert.match(statusSentence(incidentView(inc)), /nobody has confirmed yet, so please call 112/);
  assert.equal(JSON.stringify(incidentView(inc)).includes('+9198'), false, 'phone numbers never reach a screen');
});

test('ladder: a closed incident stops before the next call', async () => {
  const store = new Store(profile(), mkdtempSync(join(tmpdir(), 'esc-')));
  const { caller, calls } = fakeCaller({});
  attachEscalation(store, caller, { ...fast, graceMs: 40 });
  const inc = store.sos('voice');
  store.resolve(inc.id, 'traveller');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls.length, 0);
});

test('CALL-E client: allowlist, call cap, idempotency key, v2 fallback, and dry run (FloodLens rails)', async () => {
  const sent: { url: string; key: string | null; body: any }[] = [];
  let v1Gone = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    sent.push({ url, key: h['Idempotency-Key'] ?? null, body: init.body ? JSON.parse(String(init.body)) : null });
    if (v1Gone && url.endsWith('/v1/calls')) return new Response('gone', { status: 410 });
    return new Response(JSON.stringify({ call_id: 'call_1', status: 'completed', structured_result: { heard: true, will_help: true, said: 'yes' } }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = makeCaller({ apiKey: 'k', allowed: '98000 00001', maxCalls: 2, fetchImpl });
  assert.equal(c.mode, 'live');
  assert.deepEqual(await c.place({ incidentId: 'i1', contactId: 'c9', phone: '+919999999999', task: 't' }), { status: 'skipped', reason: 'not on the allowlist' });
  assert.equal(sent.length, 0, 'a number that did not consent is never even sent to CALL-E');
  assert.equal((await c.place({ incidentId: 'i1', contactId: 'c1', phone: '9800000001', task: 't' })).status, 'placed');
  assert.equal(sent[0].key, 'safestop-i1-c1');
  assert.deepEqual(sent[0].body.recipients, [{ phones: ['+919800000001'], region: 'IN', locale: 'en-IN' }]);
  v1Gone = true;
  assert.equal((await c.place({ incidentId: 'i2', contactId: 'c1', phone: '+919800000001', task: 't' })).status, 'placed');
  assert.ok(sent.at(-1)!.url.endsWith('/v2/calls'));
  assert.equal(sent.at(-1)!.body.phone, '+919800000001');
  assert.deepEqual(await c.place({ incidentId: 'i3', contactId: 'c1', phone: '+919800000001', task: 't' }), { status: 'skipped', reason: 'call limit reached' });
  const o = await c.poll('call_1');
  assert.deepEqual([o.terminal, o.heard, o.willHelp], [true, true, true]);
  const none = makeCaller({ allowed: '9800000001' });
  assert.equal(none.mode, 'dry_run', 'no key: dry run, never a call');
  assert.equal((await none.place({ incidentId: 'i', contactId: 'c', phone: '9800000001', task: 't' })).status, 'dry_run');
  assert.equal((await makeCaller({ apiKey: 'k', fetchImpl }).place({ incidentId: 'i', contactId: 'c', phone: '9800000001', task: 't' })).status, 'skipped', 'live with an empty allowlist calls nobody');
});

test('call script: reads facts, asks one question, never reassures or advises', () => {
  const task = buildTask({ traveller: 'Priya', contact: 'Ravi', startedAt: '11:04 pm', where: 'and shared her location', situation: 'you think you are being followed' });
  const message = /"([^"]+)"/.exec(task)![1];
  assert.match(message, /Priya started a quiet safety alert at 11:04 pm/);
  assert.doesNotMatch(message, /\b(is safe|is fine|danger|robber|attack|police are)\b/i);
  assert.match(task, /do not say she is safe or in danger/);
  assert.match(task, /Can you help Priya right now\? Please say yes or no\./);
});

test('a "yes" on the call becomes a plan she can see; calls follow each contact\'s language', async () => {
  const p = profile();
  (p.contacts[0] as any).language = 'ta-IN';
  const store = new Store(p, mkdtempSync(join(tmpdir(), 'esc-')));
  const { caller, calls } = fakeCaller({ c1: { heard: true, willHelp: true, said: 'yes I am coming', action: 'going_there', etaMin: 20 } as any });
  attachEscalation(store, caller, fast);
  const inc = store.sos('voice', { lat: 12.9, lon: 79.1, accuracyM: 10, at: Date.now() });
  await until(() => inc.ladder.state === 'done');
  assert.match(calls[0].task, /Speak calmly and clearly in Tamil/);
  assert.match(calls[0].task, /What will you do: call Priya, go to her, or call the police\?/);
  assert.deepEqual([inc.contacts[0].plan?.action, inc.contacts[0].plan?.etaMin, inc.contacts[0].plan?.via], ['going_there', 20, 'call']);
  assert.match(statusSentence(incidentView(inc)), /Ravi is coming to you, about 20 minutes away/);
});

test('a contact can only set a plan after acknowledging', () => {
  const store = new Store(profile(), mkdtempSync(join(tmpdir(), 'esc-')));
  const inc = store.sos('quiet_button');
  store.plan('t2', 'calling_police', null);
  assert.equal(inc.contacts[1].plan, null);
  store.contact('t2', 'acknowledged');
  store.plan('t2', 'calling_police', null);
  assert.equal((inc.contacts[1].plan as { action: string } | null)?.action, 'calling_police');
  assert.match(statusSentence(incidentView(inc)), /Meena is calling the police/);
});
