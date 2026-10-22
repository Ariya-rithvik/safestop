import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Facts, TEMPLATES, callWindow, expiryFor, vetQuestion, type Stop } from '../src/facts.js';
import type { Caller, CallOutcome } from '../src/calle.js';

const IST = (h: number, m = 0) => Date.UTC(2026, 9, 20, h, m) - 5.5 * 3_600_000; // 20 Oct 2026, h:m in India
const stop = (o: Partial<Stop> = {}): Stop => ({ id: 'n123', name: 'Indian Oil', kind: 'fuel', lat: 12.92, lon: 79.13, phone: '+919800000039', hours: null, optIn: 'demo', source: 'test', ...o });

function fakeCaller(result: Partial<CallOutcome> & { raw?: Record<string, unknown> }) {
  const placed: { phone: string; task: string; key: string }[] = [];
  const caller: Caller = {
    mode: 'live',
    async place(p) { placed.push({ phone: p.phone, task: p.task, key: p.incidentId }); await new Promise((r) => setTimeout(r, 5)); return { status: 'placed', callId: `call${placed.length}` }; },
    async poll() { return { status: 'completed', terminal: true, heard: true, willHelp: false, said: '', ...result }; },
  };
  return { caller, placed };
}
const until = async (pred: () => boolean) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > 2000) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };
const fast = { settleMs: 1, pollMs: 1, maxCallMs: 500 };

test('only factual, single, place questions get a call; "is it safe?" never does', () => {
  assert.match(vetQuestion('Is it safe to stop there at night?')!, /opinion/);
  assert.match(vetQuestion('Which is the best dhaba?')!, /opinion/);
  assert.match(vetQuestion('Are you open and do you have a toilet?')!, /one thing at a time/);
  assert.match(vetQuestion('Where is my order?')!, /about you/);
  assert.equal(vetQuestion('Do you sell diesel after midnight?'), null);
});

test('call window: unknown hours only 10 am - 9 pm local; registered 24/7 stops at any hour', () => {
  assert.equal(callWindow(stop(), IST(14)), null);
  assert.match(callWindow(stop(), IST(23))!, /outside 10 am - 9 pm/);
  assert.match(callWindow(stop(), IST(9, 59))!, /outside/);
  assert.equal(callWindow(stop({ hours: '24/7' }), IST(2)), null);
});

test('a firm yes outlasts a hedge; "open until 6" expires at 6 am', () => {
  const t = IST(20);
  assert.equal(expiryFor('unknown', 'open_now', t) - t, 3_600_000);
  assert.equal(expiryFor('yes', 'open_now', t) - t, 4 * 3_600_000);
  assert.equal(expiryFor('no', 'open_now', t) - t, 12 * 3_600_000);
  assert.equal(expiryFor('yes', 'open_until_6', t), IST(6) + 24 * 3_600_000, 'the next 6 am');
});

test('confirm before dialling; fifty askers make one call; the answer is shared; no second call while fresh', async () => {
  let now = IST(15);
  const { caller, placed } = fakeCaller({ raw: { reached_person: true, answer: 'yes', quote: 'Yes, we are open, 24 hours' }, transcript: 'AI: are you open right now? Staff: Yes, we are open, 24 hours.' });
  const f = new Facts([stop()], caller, { ...fast, now: () => now });
  const pre = await f.ask('n123', { templateId: 'open_now' }, false);
  assert.equal(pre.status, 'needs_confirmation');
  if (pre.status === 'needs_confirmation') {
    assert.match(pre.preview.disclosure, /I'm an AI assistant/);
    assert.equal(pre.preview.dialling.includes('9800000039'), false, 'the full number is not shown');
  }
  assert.equal(placed.length, 0, 'nothing dialled before confirmation');
  const many = await Promise.all(Array.from({ length: 50 }, () => f.ask('n123', { templateId: 'open_now' }, true)));
  assert.equal(placed.length, 1, 'one question = one call');
  assert.equal(many.filter((r) => r.status === 'calling').length, 1);
  assert.equal(many.filter((r) => r.status === 'in_flight').length, 49);
  assert.equal(placed[0].phone, '+919800000039', 'the registered number, not one from the request');
  assert.match(placed[0].task, /Never deny being an AI/);
  await until(() => f.fresh('n123', TEMPLATES.open_now.text) !== null);
  const again = await f.ask('n123', { templateId: 'open_now' }, true);
  assert.equal(again.status, 'fresh');
  if (again.status === 'fresh') assert.equal(again.fact.quote, 'Yes, we are open, 24 hours');
  assert.equal(placed.length, 1, 'later travellers get the stored answer: no call');
  const near = f.near(12.92, 79.13);
  assert.equal(near[0].facts.length, 1);
  assert.equal(JSON.stringify(near).includes('9800000039'), false, 'phone numbers never leave the server');
  now += 5 * 3_600_000; // expired
  assert.equal((await f.ask('n123', { templateId: 'open_now' }, false)).status, 'needs_confirmation');
});

test('a fact is stored only if it binds to the call: a person answered, the right number, the quote is in the transcript', async () => {
  const cases: Record<string, Partial<CallOutcome> & { raw: Record<string, unknown> }> = {
    voicemail: { raw: { reached_person: false, answer: 'unknown', quote: '' } },
    wrongNumber: { raw: { reached_person: true, answer: 'yes', quote: 'yes' }, phone: '+919999999999', transcript: 'yes' },
    madeUpQuote: { raw: { reached_person: true, answer: 'yes', quote: 'We have security guards all night' }, transcript: 'Staff: we close at ten.' },
  };
  for (const [name, r] of Object.entries(cases)) {
    const { caller } = fakeCaller(r);
    const f = new Facts([stop()], caller, { ...fast, now: () => IST(15) });
    await f.ask('n123', { templateId: 'open_now' }, true);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(f.fresh('n123', TEMPLATES.open_now.text), null, name);
  }
});

test('refusals: outside hours, opinion, daily cap, unknown stop', async () => {
  const { caller, placed } = fakeCaller({ raw: { reached_person: true, answer: 'yes', quote: 'yes' }, transcript: 'yes' });
  assert.equal((await new Facts([stop()], caller, { ...fast, now: () => IST(23) }).ask('n123', { templateId: 'open_now' }, true)).status, 'refused');
  const f = new Facts([stop(), stop({ id: 'n2' }), stop({ id: 'n3' })], caller, { ...fast, now: () => IST(15), dailyCap: 2 });
  assert.equal((await f.ask('n123', { custom: 'Is it safe for women?' }, true)).status, 'refused');
  assert.equal((await f.ask('n123', { templateId: 'open_now' }, true)).status, 'calling');
  assert.equal((await f.ask('n2', { templateId: 'open_now' }, true)).status, 'calling');
  const capped = await f.ask('n3', { templateId: 'open_now' }, true);
  assert.equal(capped.status, 'refused');
  assert.equal(placed.length, 2);
  assert.equal((await f.ask('nope', { templateId: 'open_now' }, true)).status, 'refused');
});
