import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Facts, TEMPLATES, type Stop } from '../src/facts.js';
import { answerFromState, createStopAgent, type StationState } from '../stops/agent.js';
import type { Caller } from '../src/calle.js';
import { Agent, setGlobalDispatcher } from 'undici';

// Short-lived connections, so no pooled socket is still open when the test runner exits (Windows libuv assert).
setGlobalDispatcher(new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1, pipelining: 0 }));
// Let the closed sockets finish closing before the runner force-exits (Windows libuv teardown assert).
after(() => new Promise((r) => setTimeout(r, 300)));

const state: StationState = { open24h: true, openNow: true, staffOnDuty: 2, litForecourt: true, womensRestroomOpen: false };
const stop = (o: Partial<Stop> = {}): Stop => ({ id: 'w155', name: 'Indian Oil', kind: 'fuel', lat: 12.92, lon: 79.13, phone: '+919800000039', hours: null, optIn: 'demo', source: 'test', ...o });
function spyCaller() {
  const placed: string[] = [];
  const caller: Caller = { mode: 'live', async place(p) { placed.push(p.phone); return { status: 'placed', callId: 'c1' }; }, async poll() { return { status: 'x', terminal: true, heard: false, willHelp: false, said: '' }; } };
  return { caller, placed };
}

test('the station agent answers the standard questions from its own state', () => {
  assert.deepEqual(answerFromState('open_until_6', state), { answer: 'yes', statement: 'Open 24 hours, including until 6 am.' });
  assert.deepEqual(answerFromState('staffed_now', state), { answer: 'yes', statement: '2 staff on duty now.' });
  assert.equal(answerFromState('womens_restroom', state).answer, 'no');
  assert.equal(answerFromState('anything else', state).answer, 'unknown');
});

test('machine first: a stop with an AI agent is asked agent-to-agent, signed, in milliseconds; no phone call, no confirmation', async () => {
  const agent = await createStopAgent({ port: 0, stopId: 'w155', name: 'Indian Oil', state });
  try {
    const { caller, placed } = spyCaller();
    const f = new Facts([stop({ agentUrl: agent.url })], caller, { now: () => Date.now() });
    const r = await f.ask('w155', { templateId: 'open_until_6' }, false);
    assert.equal(r.status, 'answered', 'no "confirm before dialling" step: nothing is dialled');
    if (r.status === 'answered') {
      assert.deepEqual([r.fact.via, r.fact.answer, r.fact.quote, r.fact.quoteChecked], ['agent', 'yes', 'Open 24 hours, including until 6 am.', true]);
      assert.ok((r.fact.ms ?? 1e9) < 2000, `answered in ${r.fact.ms} ms`);
    }
    assert.equal(placed.length, 0, 'no phone call');
    assert.equal((await f.ask('w155', { templateId: 'open_until_6' }, false)).status, 'fresh', 'shared with the next traveller');
    // Custom questions are not in the machine protocol: they still go to a person, by phone.
    assert.ok(['needs_confirmation', 'refused'].includes((await f.ask('w155', { custom: 'Do you sell diesel after midnight?' }, false)).status), 'took the phone path, not the machine one');
  } finally {
    await agent.close();
  }
});

test('if the agent is down, or answers for a different stop, SafeStop falls back to the phone (human language)', async () => {
  const { caller } = spyCaller();
  const IST15 = Date.UTC(2026, 9, 20, 15) - 5.5 * 3_600_000;
  const down = new Facts([stop({ agentUrl: 'http://127.0.0.1:9' })], caller, { now: () => IST15 });
  assert.equal((await down.ask('w155', { templateId: 'open_now' }, false)).status, 'needs_confirmation');
  const wrong = await createStopAgent({ port: 0, stopId: 'someone-else', name: 'Other', state });
  try {
    const f = new Facts([stop({ agentUrl: wrong.url })], caller, { now: () => IST15 });
    assert.equal((await f.ask('w155', { templateId: 'open_now' }, false)).status, 'needs_confirmation', 'an answer that does not bind to this stop is not trusted');
    assert.equal(f.fresh('w155', TEMPLATES.open_now.text), null);
  } finally {
    await wrong.close();
  }
});
