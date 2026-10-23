// Authority agent link (A2A): SafeStop's agent talks to an authority's agent in a fixed machine language
// (a signed CAP 1.2 alert), over the open Agent2Agent protocol (official @a2a-js/sdk client).
// The authority's AGENT answers in milliseconds (received, verified, nearest unit prepared); its human
// OFFICER decides later (dispatch / call / decline). SafeStop shows each of those steps honestly and
// never says police are coming unless an officer actually decided so.
// Only runs if the traveller agreed to share with authorities (SHARE_WITH_AUTHORITIES=1).
import { Role, TaskState, type Message, type Part, type Task } from '@a2a-js/sdk';
import { ClientFactory, type Client } from '@a2a-js/sdk/client';
import { toCap, type CapStatus } from './cap.js';
import { addEvidence, type Incident } from './incident.js';
import type { Store } from './store.js';

export type AuthorityState = 'sending' | 'received' | 'prepared' | 'officer_calling' | 'dispatched' | 'declined' | 'closed' | 'failed';
export interface AuthorityLink {
  agentUrl: string; name: string; taskId: string | null; state: AuthorityState;
  sentAt: number; ackMs: number | null; unit: string | null; etaMin: number | null; note: string;
  /** Where the prepared/dispatched unit is (for the map), as the authority reported it. */
  unitPos?: { lat: number; lon: number } | null;
}

const TERMINAL = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_FAILED]);

const dataOf = (parts: Part[] | undefined) => {
  const c = parts?.find((p) => p.content?.$case === 'data')?.content;
  return c && c.$case === 'data' ? (c.value as Record<string, any>) : null;
};
const textOf = (parts: Part[] | undefined) => (parts ?? []).map((p) => (p.content?.$case === 'text' ? p.content.value : '')).filter(Boolean).join(' ');

/** Map the authority's A2A task to an honest SafeStop state (pure; tested). */
export function stateFromTask(t: Pick<Task, 'status'>): { state: AuthorityState; unit: string | null; etaMin: number | null; note: string; unitPos: { lat: number; lon: number } | null } {
  const d = dataOf(t.status?.message?.parts);
  const note = textOf(t.status?.message?.parts).slice(0, 200);
  const unit = d?.prepared?.unit?.name ?? null;
  const etaMin = typeof d?.prepared?.etaMin === 'number' ? d.prepared.etaMin : null;
  const u = d?.prepared?.unit;
  const unitPos = u && typeof u.lat === 'number' && typeof u.lon === 'number' ? { lat: u.lat, lon: u.lon } : null;
  switch (t.status?.state) {
    case TaskState.TASK_STATE_COMPLETED: return { state: 'dispatched', unit, etaMin, note, unitPos };
    // Only an officer's decision is "declined"; a technical rejection (e.g. signature) is "failed".
    case TaskState.TASK_STATE_REJECTED: return { state: d?.decision?.kind === 'decline' ? 'declined' : 'failed', unit: null, etaMin: null, note, unitPos: null };
    case TaskState.TASK_STATE_CANCELED: return { state: 'closed', unit, etaMin, note, unitPos };
    case TaskState.TASK_STATE_FAILED: return { state: 'failed', unit: null, etaMin: null, note, unitPos: null };
    case TaskState.TASK_STATE_WORKING:
      if (d?.decision?.kind === 'dispatch') return { state: 'dispatched', unit, etaMin, note, unitPos };
      return { state: d?.decision?.kind === 'call' ? 'officer_calling' : d?.stage === 'prepared' ? 'prepared' : 'received', unit, etaMin, note, unitPos };
    default: return { state: 'received', unit, etaMin, note, unitPos };
  }
}

export function attachAuthorities(store: Store, o: {
  agents: string[]; token?: string; sign: (payload: unknown) => Promise<string>; sender: string; status: CapStatus;
  consent: boolean; pollMs?: number; log?: (m: string) => void;
}) {
  const log = o.log ?? (() => {});
  if (!o.consent || !o.agents.length) return () => {};
  const factory = new ClientFactory();
  const clients = new Map<string, Promise<Client>>();
  const client = (url: string) => {
    let c = clients.get(url);
    if (!c) {
      c = factory.createFromUrl(url);
      c.catch(() => clients.delete(url));
      clients.set(url, c);
    }
    return c;
  };
  const headers: Record<string, string> = o.token ? { authorization: `Bearer ${o.token}` } : {};
  const lastSent = new Map<string, string>(); // incidentId|url -> what was last sent
  const busy = new Set<string>();

  const linkOf = (inc: Incident, url: string) => inc.authorities.find((a) => a.agentUrl === url);

  async function send(inc: Incident, url: string) {
    const key = `${inc.id}|${url}`;
    const fingerprint = `${inc.status}|${inc.playbook}|${inc.severity}|${inc.location?.lat.toFixed(3)},${inc.location?.lon.toFixed(3)}`;
    if (busy.has(key) || lastSent.get(key) === fingerprint) return;
    let link = linkOf(inc, url);
    const alert = toCap(inc, { sender: o.sender, status: o.status, at: store.now(), first: !link?.taskId });
    if (!alert) return;
    busy.add(key);
    lastSent.set(key, fingerprint);
    if (!link) {
      link = { agentUrl: url, name: url, taskId: null, state: 'sending', sentAt: store.now(), ackMs: null, unit: null, etaMin: null, note: '' };
      inc.authorities.push(link);
      store.timeline(inc, 'authority', `signed CAP alert sent to ${url}`);
      store.touch(inc.id);
    }
    const t0 = performance.now();
    try {
      const c = await client(url);
      link.name = (await c.getAgentCard?.())?.name ?? link.name;
      const message: Message = {
        // A finished A2A task (officer already decided) cannot take more messages: later news (e.g. "she is
        // safe") goes as a new task; the desk matches it to its case by the CAP identifier.
        role: Role.ROLE_USER, messageId: crypto.randomUUID(), taskId: link.taskId && !['dispatched', 'declined', 'closed', 'failed'].includes(link.state) ? link.taskId : '', contextId: '', extensions: [], metadata: {}, referenceTaskIds: [],
        parts: [
          { content: { $case: 'data', value: { jws: await o.sign(alert) } }, metadata: undefined, filename: '', mediaType: 'application/json' },
          { content: { $case: 'text', value: `${alert.info.headline}. ${alert.info.description}` }, metadata: undefined, filename: '', mediaType: 'text/plain' },
        ],
      };
      const res = await c.sendMessage({ tenant: '', message, configuration: undefined, metadata: {} }, { serviceParameters: headers });
      const ms = Math.round(performance.now() - t0);
      if ('status' in res) {
        const s = stateFromTask(res);
        // Keep the officer's decision visible: a later closing notice does not erase "dispatched".
        if (['dispatched', 'declined'].includes(link.state) && s.state === 'closed') {
          link.note = `${link.note} Desk told the alert is closed.`.trim();
          store.timeline(inc, 'authority', `${link.name}: told the alert is closed`);
          store.touch(inc.id);
          return;
        }
        link.taskId = res.id;
        if (link.ackMs === null) {
          link.ackMs = ms;
          addEvidence(inc, store.now(), 'tool', `authority ${link.name}: agent acknowledged in ${ms} ms (${s.state})`);
          store.timeline(inc, 'authority', `${link.name}: agent received and verified it in ${ms} ms${s.unit ? `; prepared ${s.unit}, ~${s.etaMin} min; waiting for officer` : ''}`);
        }
        Object.assign(link, s);
        store.touch(inc.id);
        if (!TERMINAL.has(res.status!.state)) void follow(inc, link);
      }
    } catch (e) {
      link.state = 'failed';
      link.note = (e as Error).message.slice(0, 120);
      lastSent.delete(key); // try again on the next change
      store.timeline(inc, 'authority', `${url}: could not deliver (${link.note})`);
      store.touch(inc.id);
      log(`authority ${url}: ${link.note}`);
    } finally {
      busy.delete(key);
    }
  }

  // Follow the authority's task until the officer decides (A2A GetTask).
  const following = new Set<string>();
  async function follow(inc: Incident, link: AuthorityLink) {
    const key = `${inc.id}|${link.agentUrl}`;
    if (following.has(key) || !link.taskId) return;
    following.add(key);
    try {
      const c = await client(link.agentUrl);
      for (;;) {
        await new Promise((r) => setTimeout(r, o.pollMs ?? 2000).unref?.());
        const t = await c.getTask({ tenant: '', id: link.taskId }, { serviceParameters: headers });
        const s = stateFromTask(t);
        const moved = JSON.stringify(s.unitPos) !== JSON.stringify(link.unitPos) || s.etaMin !== link.etaMin;
        if (moved && s.state === link.state && s.note === link.note) {
          // The unit is driving: update the map quietly (no timeline line per step).
          Object.assign(link, s);
          store.touch(inc.id);
        } else if (s.state !== link.state || s.note !== link.note) {
          Object.assign(link, s);
          store.timeline(inc, 'authority', `${link.name}: ${s.note || s.state}`);
          addEvidence(inc, store.now(), 'tool', `authority ${link.name}: ${s.state}`);
          store.touch(inc.id);
        }
        if (TERMINAL.has(t.status!.state)) return;
      }
    } catch (e) {
      log(`follow ${link.agentUrl}: ${(e as Error).message}`);
    } finally {
      following.delete(key);
    }
  }

  return store.on((e) => {
    if (e.to !== 'traveller') return;
    const inc = store.get(e.incident.id);
    if (!inc || !inc.location) return;
    for (const url of o.agents) void send(inc, url);
  });
}
