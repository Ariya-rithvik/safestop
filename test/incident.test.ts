import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addRelayOffer, contactUpdate, distanceM, enableRelay, incidentView, quietSos, relayActive, relayNotice, resolve,
  safetyTriage, verifyEvidence, RELAY_TTL_MS,
} from '../src/incident.js';
import { PLAYBOOKS, PLAYBOOK_IDS, triage } from '../src/playbooks.js';

const contacts = [
  { id: 'c1', name: 'Ravi', token: 'tok1' },
  { id: 'c2', name: 'Meena', token: 'tok2' },
];
const here = { lat: 12.9165, lon: 79.1325, accuracyM: 15, at: 1000 }; // NH48 near Vellore

test('quiet SOS: incident exists and every contact is "sent" at the same instant, before anything else', () => {
  const inc = quietSos({ traveller: 'Priya', contacts, at: 1000, trigger: 'quiet_button', location: here });
  assert.equal(inc.status, 'open');
  assert.deepEqual(inc.contacts.map((c) => [c.name, c.state, c.sentAt]), [['Ravi', 'sent', 1000], ['Meena', 'sent', 1000]]);
  assert.equal(inc.playbook, null, 'triage has not run yet: SOS never waits for it');
  assert.equal(inc.timeline[0].agent, 'coordinator');
  assert.ok(verifyEvidence(inc));
});

test('contact states only move forward and never claim more than happened', () => {
  const inc = quietSos({ traveller: 'Priya', contacts, at: 1000, trigger: 'voice' });
  assert.equal(contactUpdate(inc, 'c1', 'delivered', 1200), true);
  assert.equal(contactUpdate(inc, 'c1', 'delivered', 1300), false, 'no duplicate');
  assert.equal(contactUpdate(inc, 'c1', 'acknowledged', 1500), true);
  assert.equal(contactUpdate(inc, 'c1', 'delivered', 1600), false, 'no going back');
  assert.equal(contactUpdate(inc, 'nobody', 'delivered', 1600), false);
  // A tap without a separate delivery receipt still implies the alert arrived.
  assert.equal(contactUpdate(inc, 'c2', 'acknowledged', 1700), true);
  assert.equal(inc.contacts[1].deliveredAt, 1700);
  assert.deepEqual(inc.contacts.map((c) => c.state), ['acknowledged', 'acknowledged']);
});

test('triage picks the right playbook from what people actually say, in English and Hindi', () => {
  assert.equal(triage('someone threw an egg at my windshield'), 'object_thrown');
  assert.equal(triage('a man is waving me down saying his car broke down'), 'suspicious_breakdown');
  assert.equal(triage('there are stones on the road and nobody around'), 'road_obstruction');
  assert.equal(triage('a guy says he is police but no uniform'), 'authority_claim');
  assert.equal(triage('the same car has been following me for 10 km'), 'followed');
  assert.equal(triage('कोई मेरा पीछा कर रहा है'), 'followed');
  assert.equal(triage('lovely weather today'), null);
  const inc = quietSos({ traveller: 'Priya', contacts, at: 1, trigger: 'voice' });
  assert.equal(safetyTriage(inc, 'a car is chasing me', 5), 'followed');
  assert.equal(inc.playbook, 'followed');
});

test('playbooks: five, each with steps and 112, and never accuse anyone of a crime', () => {
  assert.equal(PLAYBOOK_IDS.length, 5);
  for (const id of PLAYBOOK_IDS) {
    const p = PLAYBOOKS[id];
    assert.ok(p.steps.length >= 3, id);
    assert.ok(p.call.some((c) => c.number === '112'), `${id} offers 112`);
    const all = [p.title, p.say, ...p.steps].join(' ').toLowerCase();
    assert.doesNotMatch(all, /\b(robber|robbery|thief|thieves|criminal|gang|loot|dacoit)\b/, `${id} makes no crime claims`);
  }
  assert.ok(PLAYBOOKS.suspicious_breakdown.call.some((c) => c.number === '1033'), 'NHAI 1033 for breakdowns');
});

test('nearby relay: opt-in, expires after 15 minutes, strangers see a distance band but no name or coordinates', () => {
  const inc = quietSos({ traveller: 'Priya', contacts, at: 1000, trigger: 'quiet_button', location: here });
  assert.equal(relayActive(inc, 1000), false, 'off until the traveller opts in');
  assert.equal(addRelayOffer(inc, 'Arun', 'I am at the toll plaza', 1100), null);
  enableRelay(inc, 2000);
  assert.equal(relayActive(inc, 2000 + RELAY_TTL_MS - 1), true);
  assert.equal(relayActive(inc, 2000 + RELAY_TTL_MS), false, 'expires');
  const notice = relayNotice(inc, { lat: 12.9200, lon: 79.1325 });
  assert.equal(notice.label, 'Unverified');
  assert.equal(notice.band, 'about 300-600 m away');
  const shown = JSON.stringify(notice);
  assert.doesNotMatch(shown, /Priya|12\.91|79\.13/, 'no name, no coordinates');
  assert.ok(addRelayOffer(inc, 'Arun', 'I can wait at the fuel station', 2500));
  assert.equal(inc.relay!.offers.length, 1);
});

test('resolution: only the traveller can confirm safe; closing ends the relay; evidence chain detects edits', () => {
  const inc = quietSos({ traveller: 'Priya', contacts, at: 1000, trigger: 'mcp', location: here });
  enableRelay(inc, 1100);
  resolve(inc, 'contact', 5000);
  assert.equal(inc.status, 'resolved');
  assert.equal(inc.safeConfirmedAt, null, 'a contact closing it is not the traveller saying she is safe');
  assert.equal(relayActive(inc, 5001), false);
  const inc2 = quietSos({ traveller: 'Priya', contacts, at: 1000, trigger: 'mcp' });
  resolve(inc2, 'traveller', 6000);
  assert.equal(inc2.safeConfirmedAt, 6000);
  assert.ok(verifyEvidence(inc2));
  inc2.evidence[0].text = 'edited later';
  assert.equal(verifyEvidence(inc2), false);
  const view = incidentView(inc);
  assert.equal(JSON.stringify(view).includes('tok1'), false, 'contact tokens never leave the server');
});

test('distance', () => {
  assert.ok(Math.abs(distanceM({ lat: 12.9165, lon: 79.1325 }, { lat: 12.9255, lon: 79.1325 }) - 1001) < 5);
});
