// One incident record shared by every agent. Agents are plain deterministic functions that change
// the record and append to its timeline; nothing here calls an AI or the network.
import { createHash, randomBytes } from 'node:crypto';
import { PLAYBOOKS, triage, type PlaybookId } from './playbooks.js';

export const AGENTS = ['coordinator', 'quiet_sos', 'safety_triage', 'contact', 'escalation', 'nearby_relay', 'evidence', 'resolution', 'policy', 'understanding', 'authority', 'prebrief'] as const;
export type Agent = (typeof AGENTS)[number];

/** Honest delivery states: "sent" (we pushed it), "delivered" (their screen received it), "acknowledged" (they tapped). */
export type ContactState = 'sent' | 'delivered' | 'acknowledged';
export type IncidentStatus = 'open' | 'resolved' | 'cancelled';

export interface LatLon { lat: number; lon: number; accuracyM: number | null; at: number }
/** phone stays on the server: it is used only by the escalation agent and never sent to any screen. */
export interface TrustedContact { id: string; name: string; token: string; phone?: string; /** Language for phone calls, e.g. ta-IN (Care Call AI: per-person communication rules). */ language?: string }
export type CallState = 'calling' | 'heard' | 'no_answer' | 'failed' | 'confirmed' | 'dry_run';
export interface ContactAlert {
  contactId: string; name: string; state: ContactState; sentAt: number; deliveredAt: number | null; ackAt: number | null;
  /** How they acknowledged: tapped the page, or said yes on a phone call. */
  channel: 'page' | 'call' | null;
  call: { state: CallState; at: number; said: string } | null;
  /** What they said they will do (by phone or by tapping), so she knows what help looks like. */
  plan: { action: 'calling_her' | 'going_there' | 'calling_police' | 'other'; etaMin: number | null; at: number; via: 'call' | 'page' } | null;
  /** Live position of a contact who is on the way to her (shared by them, only while going there). */
  pos: { lat: number; lon: number; at: number } | null;
}
export interface RelayOffer { id: string; from: string; at: number; text: string }
export interface EvidenceEntry { at: number; kind: 'trigger' | 'location' | 'note' | 'playbook' | 'contact' | 'relay' | 'resolution' | 'tool' | 'understanding'; text: string; hash: string }

export interface Incident {
  id: string;
  traveller: string;
  createdAt: number;
  trigger: 'quiet_button' | 'voice' | 'mcp';
  /** When the traveller pressed it on her phone (may be earlier than createdAt if she had no signal). */
  pressedAt: number | null;
  status: IncidentStatus;
  location: LatLon | null;
  playbook: PlaybookId | null;
  contacts: ContactAlert[];
  relay: { enabled: boolean; radiusM: number; expiresAt: number; notified: number; offers: RelayOffer[] } | null;
  /** Escalation ladder: page everyone, then phone contacts one by one until someone confirms. */
  ladder: { state: 'waiting' | 'calling' | 'done' | 'exhausted'; step: number; /** When the next phone call will be placed if nobody acknowledges. */ nextAt?: number | null };
  /** From the understanding agent (model proposes, rules can only raise). Facts go to trusted contacts only. */
  severity: 'low' | 'medium' | 'high' | null;
  facts: { vehicle?: string | null; plate?: string | null; direction?: string | null; people?: string | null };
  understoodBy: string | null;
  /** Authority agents (A2A) that received the signed CAP alert, and what their humans decided. */
  authorities: import('./authority.js').AuthorityLink[];
  /** What agents asked other agents before any human looked (nearest open, staffed stop). */
  prebrief?: import('./prebrief.js').Prebrief | null;
  evidence: EvidenceEntry[];
  timeline: { at: number; agent: Agent; text: string }[];
  resolvedAt: number | null;
  safeConfirmedAt: number | null;
}

export const RELAY_RADIUS_M = 1000;
export const RELAY_TTL_MS = 15 * 60_000;

const newId = (p: string) => p + randomBytes(6).toString('hex');

function log(inc: Incident, at: number, agent: Agent, text: string) {
  inc.timeline.push({ at, agent, text });
}

/** Evidence agent: an append-only, hash-chained log, so later edits would be visible. */
export function addEvidence(inc: Incident, at: number, kind: EvidenceEntry['kind'], text: string): EvidenceEntry {
  const prev = inc.evidence.at(-1)?.hash ?? 'genesis';
  const hash = createHash('sha256').update(`${prev}|${at}|${kind}|${text}`).digest('hex');
  const e = { at, kind, text, hash };
  inc.evidence.push(e);
  log(inc, at, 'evidence', `logged ${kind}`);
  return e;
}

export function verifyEvidence(inc: Incident): boolean {
  let prev = 'genesis';
  for (const e of inc.evidence) {
    const h = createHash('sha256').update(`${prev}|${e.at}|${e.kind}|${e.text}`).digest('hex');
    if (h !== e.hash) return false;
    prev = h;
  }
  return true;
}

/**
 * Quiet SOS agent. Runs first and alone: the incident exists and every trusted contact is "sent"
 * before triage, place lookups or any assistant reply happen.
 */
export function quietSos(opts: { traveller: string; contacts: TrustedContact[]; at: number; trigger: Incident['trigger']; location?: LatLon | null; pressedAt?: number | null }): Incident {
  const inc: Incident = {
    id: newId('inc_'), traveller: opts.traveller, createdAt: opts.at, trigger: opts.trigger, pressedAt: opts.pressedAt ?? null, status: 'open',
    location: opts.location ?? null, playbook: null, contacts: [], relay: null, ladder: { state: 'waiting', step: 0 }, severity: null, facts: {}, understoodBy: null, authorities: [], evidence: [], timeline: [],
    resolvedAt: null, safeConfirmedAt: null,
  };
  log(inc, opts.at, 'coordinator', `SOS received (${opts.trigger})`);
  for (const c of opts.contacts) {
    inc.contacts.push({ contactId: c.id, name: c.name, state: 'sent', sentAt: opts.at, deliveredAt: null, ackAt: null, channel: null, call: null, plan: null, pos: null });
    log(inc, opts.at, 'quiet_sos', `alert sent to ${c.name}`);
  }
  const waited = opts.pressedAt && opts.at - opts.pressedAt > 2000 ? `; pressed ${Math.round((opts.at - opts.pressedAt) / 1000)} s earlier with no signal` : '';
  if (waited) log(inc, opts.at, 'quiet_sos', `pressed ${Math.round((opts.at - opts.pressedAt!) / 1000)} s ago without signal; delivered now`);
  addEvidence(inc, opts.at, 'trigger', `SOS by ${opts.traveller} via ${opts.trigger}${waited}`);
  if (inc.location) addEvidence(inc, opts.at, 'location', fmtLoc(inc.location));
  return inc;
}

/** Safety triage agent: pick a playbook from what the traveller said. Never delays or blocks the SOS. */
export function safetyTriage(inc: Incident, text: string, at: number): PlaybookId | null {
  const id = triage(text);
  if (id && id !== inc.playbook) {
    inc.playbook = id;
    log(inc, at, 'safety_triage', `playbook: ${PLAYBOOKS[id].title}`);
    addEvidence(inc, at, 'playbook', `${id} (from: "${text.slice(0, 200)}")`);
  }
  return id;
}

/** Contact agent: only moves forward (sent -> delivered -> acknowledged), never claims more than happened. */
export function contactUpdate(inc: Incident, contactId: string, state: 'delivered' | 'acknowledged', at: number, channel: 'page' | 'call' = 'page'): boolean {
  const c = inc.contacts.find((x) => x.contactId === contactId);
  if (!c) return false;
  const order: ContactState[] = ['sent', 'delivered', 'acknowledged'];
  if (order.indexOf(state) <= order.indexOf(c.state)) return false;
  if (state === 'acknowledged' && c.deliveredAt === null) c.deliveredAt = at; // a tap implies it arrived
  if (state === 'delivered') c.deliveredAt = at;
  else {
    c.ackAt = at;
    c.channel = channel;
  }
  c.state = state;
  log(inc, at, 'contact', `${c.name}: ${state}${state === 'acknowledged' ? ` (${channel === 'call' ? 'said yes on a phone call' : "tapped I'm on it"})` : ''}`);
  addEvidence(inc, at, 'contact', `${c.name} ${state} via ${channel}`);
  return true;
}

export function updateLocation(inc: Incident, loc: LatLon): void {
  inc.location = loc;
  addEvidence(inc, loc.at, 'location', fmtLoc(loc));
}

/** Escalation agent: record what happened on a phone call, without claiming more than the call agent reported. */
export function noteCall(inc: Incident, contactId: string, state: CallState, at: number, said = ''): void {
  const c = inc.contacts.find((x) => x.contactId === contactId);
  if (!c) return;
  c.call = { state, at, said: said.slice(0, 120) };
  const words: Record<CallState, string> = {
    calling: `calling ${c.name}`, heard: `${c.name} heard the call but did not confirm`, no_answer: `${c.name} did not answer the call`,
    failed: `call to ${c.name} failed`, confirmed: `${c.name} said yes on the call`, dry_run: `would call ${c.name} (dry run, no call placed)`,
  };
  log(inc, at, 'escalation', words[state] + (said ? `: "${said.slice(0, 80)}"` : ''));
  addEvidence(inc, at, 'contact', `call ${c.name}: ${state}${said ? ` "${said.slice(0, 80)}"` : ''}`);
}

const PLAN_WORDS = { calling_her: 'will call her', going_there: 'is going to her', calling_police: 'is calling the police', other: 'is helping' } as const;

/** Record a contact's plan ("going to her, ~20 min"). Only after they acknowledged. */
export function setPlan(inc: Incident, contactId: string, action: NonNullable<ContactAlert['plan']>['action'], etaMin: number | null, at: number, via: 'call' | 'page'): boolean {
  const c = inc.contacts.find((x) => x.contactId === contactId);
  if (!c || c.state !== 'acknowledged') return false;
  c.plan = { action, etaMin: action === 'going_there' && etaMin !== null && etaMin >= 0 && etaMin < 600 ? Math.round(etaMin) : null, at, via };
  log(inc, at, 'contact', `${c.name} ${PLAN_WORDS[action]}${c.plan.etaMin !== null ? `, about ${c.plan.etaMin} min` : ''}`);
  addEvidence(inc, at, 'contact', `${c.name} plan: ${action}${c.plan.etaMin !== null ? ` eta ${c.plan.etaMin} min` : ''} via ${via}`);
  return true;
}

/** True once any trusted contact has acknowledged (by page or call): the ladder stops calling. */
export const anyAcknowledged = (inc: Incident) => inc.contacts.some((c) => c.state === 'acknowledged');

/** Nearby relay agent: opt-in only, 1 km, expires after 15 minutes. */
export function enableRelay(inc: Incident, at: number): void {
  if (inc.status !== 'open') return;
  inc.relay = { enabled: true, radiusM: RELAY_RADIUS_M, expiresAt: at + RELAY_TTL_MS, notified: inc.relay?.notified ?? 0, offers: inc.relay?.offers ?? [] };
  log(inc, at, 'nearby_relay', 'traveller opted in to the nearby relay (1 km, 15 min)');
  addEvidence(inc, at, 'relay', 'relay enabled');
}

export function relayActive(inc: Incident, now: number): boolean {
  return !!inc.relay?.enabled && inc.status === 'open' && now < inc.relay.expiresAt;
}

export function disableRelay(inc: Incident, at: number, why: string): void {
  if (!inc.relay?.enabled) return;
  inc.relay.enabled = false;
  log(inc, at, 'nearby_relay', `relay off: ${why}`);
}

export function addRelayOffer(inc: Incident, from: string, text: string, at: number): RelayOffer | null {
  if (!relayActive(inc, at)) return null;
  const o = { id: newId('off_'), from: from.slice(0, 40), at, text: text.slice(0, 200) };
  inc.relay!.offers.push(o);
  log(inc, at, 'nearby_relay', `offer from ${o.from} (unverified)`);
  addEvidence(inc, at, 'relay', `offer from ${o.from}: ${o.text}`);
  return o;
}

/** Resolution agent. "Safe" only counts when the traveller says so. */
export function resolve(inc: Incident, by: 'traveller' | 'contact', at: number, cancelled = false): void {
  if (inc.status !== 'open') return;
  inc.status = cancelled ? 'cancelled' : 'resolved';
  inc.resolvedAt = at;
  if (by === 'traveller' && !cancelled) inc.safeConfirmedAt = at;
  disableRelay(inc, at, 'incident closed');
  log(inc, at, 'resolution', cancelled ? `cancelled by ${by}` : by === 'traveller' ? 'traveller confirmed safe' : `closed by contact (traveller has not confirmed safe)`);
  addEvidence(inc, at, 'resolution', `${inc.status} by ${by}`);
}

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.asin(Math.sqrt(h)));
}

/** What a nearby stranger may see: no name, no coordinates, only a rough distance band. */
export function relayNotice(inc: Incident, helper: { lat: number; lon: number } | null): { incidentId: string; band: string; label: 'Unverified'; expiresAt: number; playbook: string | null } {
  let band = 'within about 1 km';
  if (inc.location && helper) {
    const d = distanceM(inc.location, helper);
    band = d < 300 ? 'very close (under 300 m)' : d < 600 ? 'about 300-600 m away' : 'about 600 m - 1 km away';
  }
  return { incidentId: inc.id, band, label: 'Unverified', expiresAt: inc.relay?.expiresAt ?? 0, playbook: inc.playbook ? PLAYBOOKS[inc.playbook].title : null };
}

const fmtLoc = (l: LatLon) => `${l.lat.toFixed(5)},${l.lon.toFixed(5)}${l.accuracyM !== null ? ` ±${l.accuracyM} m` : ''}`;

/** The incident as the traveller and their trusted contacts see it (contact tokens never leave the server). */
export function incidentView(inc: Incident) {
  return {
    id: inc.id, traveller: inc.traveller, createdAt: inc.createdAt, pressedAt: inc.pressedAt, status: inc.status, trigger: inc.trigger,
    location: inc.location, playbook: inc.playbook ? PLAYBOOKS[inc.playbook] : null,
    contacts: inc.contacts.map(({ contactId, name, state, sentAt, deliveredAt, ackAt, channel, call, plan, pos }) => ({ contactId, name, state, sentAt, deliveredAt, ackAt, channel, call, plan, pos })),
    ladder: inc.ladder, authorities: inc.authorities.map((a) => ({ ...a })), prebrief: inc.prebrief ?? null, severity: inc.severity, facts: inc.facts, understoodBy: inc.understoodBy,
    relay: inc.relay && { enabled: inc.relay.enabled, expiresAt: inc.relay.expiresAt, notified: inc.relay.notified, offers: inc.relay.offers, label: 'Unverified' as const },
    timeline: inc.timeline.slice(-40), resolvedAt: inc.resolvedAt, safeConfirmedAt: inc.safeConfirmedAt,
    evidence: { entries: inc.evidence.length, intact: verifyEvidence(inc) },
  };
}
