// Coordinator: owns the incident records, runs the agents in a fixed order and tells every connected
// screen what changed. Order is the safety rule: SOS + contact alerts first, then triage, then places.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { understand, type Llm } from './understand.js';
import { PLAYBOOKS } from './playbooks.js';
import {
  addEvidence, addRelayOffer, contactUpdate, disableRelay, distanceM, enableRelay, incidentView, quietSos, relayActive, relayNotice,
  resolve, safetyTriage, setPlan, updateLocation, type Incident, type LatLon, type TrustedContact,
} from './incident.js';

export interface Profile { traveller: string; contacts: TrustedContact[] }
export interface Helper { id: string; name: string; lat: number; lon: number; at: number; optedIn: boolean }

export type Event =
  | { to: 'traveller'; incident: ReturnType<typeof incidentView> }
  | { to: 'contact'; contactId: string; incident: ReturnType<typeof incidentView> }
  | { to: 'helper'; helperId: string; notice: ReturnType<typeof relayNotice> | { incidentId: string; closed: true } };

const HELPER_FRESH_MS = 3 * 60_000;

export class Store {
  readonly incidents = new Map<string, Incident>();
  readonly helpers = new Map<string, Helper>();
  private listeners = new Set<(e: Event) => void>();
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Model for the understanding agent (null = rules only). Never on the SOS path. */
  llm: Llm | null = null;
  /** Resolves when the latest understanding finished (tests, evals). */
  lastUnderstanding: Promise<void> = Promise.resolve();

  constructor(readonly profile: Profile, private dataDir: string, readonly now: () => number = Date.now) {
    mkdirSync(dataDir, { recursive: true });
  }

  on(fn: (e: Event) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The newest open incident, if any (what "my SOS" means to the traveller and to Alexa). */
  current(): Incident | null {
    let best: Incident | null = null;
    for (const i of this.incidents.values()) if (i.status === 'open' && (!best || i.createdAt > best.createdAt)) best = i;
    return best;
  }

  get(id: string): Incident | null {
    return this.incidents.get(id) ?? null;
  }

  // ---------- agents, in order ----------

  /** Quiet SOS. Returns at once; one open incident at a time (a second trigger reuses it). */
  sos(trigger: Incident['trigger'], location?: LatLon | null, said?: string, pressedAt?: number | null): Incident {
    const at = this.now();
    let inc = this.current();
    if (!inc) {
      // A pressedAt from the phone is trusted only if it is in the past and less than 6 hours old.
      const pressed = pressedAt && pressedAt <= at && at - pressedAt < 6 * 3_600_000 ? pressedAt : null;
      inc = quietSos({ traveller: this.profile.traveller, contacts: this.profile.contacts, at, trigger, location, pressedAt: pressed });
      this.incidents.set(inc.id, inc);
      this.persist(inc, 'sos');
    } else if (location) {
      updateLocation(inc, location);
    }
    this.publish(inc); // contacts are alerted before triage runs
    if (said) this.say(inc.id, said);
    return inc;
  }

  say(id: string, text: string): Incident | null {
    const inc = this.get(id);
    if (!inc || inc.status !== 'open') return inc;
    safetyTriage(inc, text, this.now());
    this.publish(inc);
    // Understanding runs after the alert is out and after the instant keyword triage; it can refine, never delay.
    this.lastUnderstanding = understand(text, this.llm).then((u) => {
      if (inc.status !== 'open') return;
      const at = this.now();
      if (u.playbook && u.playbook !== inc.playbook) {
        inc.playbook = u.playbook;
        this.timeline(inc, 'understanding', `playbook: ${PLAYBOOKS[u.playbook].title}`);
      }
      inc.severity = u.severity;
      inc.facts = Object.fromEntries(Object.entries(u.facts).filter(([, v]) => v));
      inc.understoodBy = u.source;
      this.timeline(inc, 'understanding', `severity ${u.severity} (${u.source}${u.raised ? ', raised by rules' : ''})`);
      addEvidence(inc, at, 'understanding', JSON.stringify({ playbook: u.playbook, severity: u.severity, facts: inc.facts, source: u.source }));
      this.publish(inc);
    });
    return inc;
  }

  location(id: string, loc: LatLon): Incident | null {
    const inc = this.get(id);
    if (!inc || inc.status !== 'open') return inc;
    updateLocation(inc, loc);
    this.publish(inc);
    return inc;
  }

  contact(token: string, state: 'delivered' | 'acknowledged'): Incident | null {
    const c = this.profile.contacts.find((x) => x.token === token);
    const inc = this.current();
    if (!c || !inc) return inc;
    if (contactUpdate(inc, c.id, state, this.now())) this.publish(inc);
    return inc;
  }

  relay(id: string, enable: boolean): Incident | null {
    const inc = this.get(id);
    if (!inc || inc.status !== 'open') return inc;
    const at = this.now();
    if (!enable) {
      disableRelay(inc, at, 'traveller turned it off');
      this.notifyHelpersClosed(inc);
    } else {
      enableRelay(inc, at);
      inc.relay!.notified = this.notifyHelpers(inc);
      clearTimeout(this.expiryTimers.get(inc.id));
      const t = setTimeout(() => {
        if (inc.relay?.enabled) {
          disableRelay(inc, this.now(), 'expired after 15 minutes');
          this.notifyHelpersClosed(inc);
          this.publish(inc);
        }
      }, Math.max(0, inc.relay!.expiresAt - at));
      t.unref?.();
      this.expiryTimers.set(inc.id, t);
    }
    this.publish(inc);
    return inc;
  }

  offer(id: string, helperId: string, text: string): boolean {
    const inc = this.get(id);
    const h = this.helpers.get(helperId);
    if (!inc || !h) return false;
    const o = addRelayOffer(inc, h.name, text, this.now());
    if (o) this.publish(inc);
    return !!o;
  }

  plan(token: string, action: 'calling_her' | 'going_there' | 'calling_police' | 'other', etaMin: number | null): Incident | null {
    const c = this.profile.contacts.find((x) => x.token === token);
    const inc = this.current();
    if (!c || !inc) return inc;
    if (setPlan(inc, c.id, action, etaMin, this.now(), 'page')) this.publish(inc);
    return inc;
  }

  resolve(id: string, by: 'traveller' | 'contact', cancelled = false): Incident | null {
    const inc = this.get(id);
    if (!inc) return null;
    resolve(inc, by, this.now(), cancelled);
    clearTimeout(this.expiryTimers.get(inc.id));
    this.notifyHelpersClosed(inc);
    this.persist(inc, inc.status);
    this.publish(inc);
    return inc;
  }

  // ---------- nearby travellers (opt-in) ----------

  helperUpdate(h: Helper): void {
    this.helpers.set(h.id, h);
    // A helper who arrives while a relay is running near them hears about it too.
    const inc = this.current();
    if (inc && relayActive(inc, this.now()) && this.near(inc, h)) {
      this.emit({ to: 'helper', helperId: h.id, notice: relayNotice(inc, h) });
    }
  }

  helperGone(id: string): void {
    this.helpers.delete(id);
  }

  private near(inc: Incident, h: Helper): boolean {
    return h.optedIn && !!inc.location && this.now() - h.at < HELPER_FRESH_MS && distanceM(inc.location, h) <= (inc.relay?.radiusM ?? 1000);
  }

  private notifyHelpers(inc: Incident): number {
    let n = 0;
    for (const h of this.helpers.values()) {
      if (!this.near(inc, h)) continue;
      this.emit({ to: 'helper', helperId: h.id, notice: relayNotice(inc, h) });
      n++;
    }
    return n;
  }

  private notifyHelpersClosed(inc: Incident): void {
    for (const h of this.helpers.values()) this.emit({ to: 'helper', helperId: h.id, notice: { incidentId: inc.id, closed: true } });
  }

  // ---------- plumbing ----------

  /** One audit line per MCP tool call: in data/audit.jsonl, and in the open incident's evidence chain. */
  audit(tool: string, decision: string, detail = '', incidentId?: string): void {
    const at = this.now();
    try {
      appendFileSync(join(this.dataDir, 'audit.jsonl'), JSON.stringify({ at, tool, decision, detail: detail.slice(0, 200) }) + '\n');
    } catch {
      /* best effort */
    }
    const inc = (incidentId && this.get(incidentId)) || this.current();
    if (inc) {
      addEvidence(inc, at, 'tool', `${tool}: ${decision}${detail ? ` (${detail.slice(0, 120)})` : ''}`);
      this.timeline(inc, 'policy', `${tool}: ${decision}`);
    }
  }

  /** Re-publish an incident after an agent changed it. */
  touch(id: string): void {
    const inc = this.get(id);
    if (inc) this.publish(inc);
  }

  timeline(inc: Incident, agent: Incident['timeline'][number]['agent'], text: string): void {
    inc.timeline.push({ at: this.now(), agent, text });
  }


  private publish(inc: Incident): void {
    const view = incidentView(inc);
    this.emit({ to: 'traveller', incident: view });
    for (const c of inc.contacts) this.emit({ to: 'contact', contactId: c.contactId, incident: view });
  }

  private emit(e: Event): void {
    for (const fn of this.listeners) fn(e);
  }

  private persist(inc: Incident, event: string): void {
    try {
      appendFileSync(join(this.dataDir, 'incidents.jsonl'), JSON.stringify({ event, at: this.now(), incident: incidentView(inc), evidence: inc.evidence }) + '\n');
    } catch {
      /* disk full etc.: the live incident still works */
    }
  }
}
