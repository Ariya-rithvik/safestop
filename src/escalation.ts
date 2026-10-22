// Escalation agent: "page everyone free, phone only when it's worth it" (the rule from recovery-agent).
// After an SOS, every trusted contact is paged at once. If nobody has acknowledged after a grace period,
// contacts are phoned one at a time through CALL-E until someone says yes. It stops the moment anyone
// acknowledges, by page or by phone, and never phones a contact twice for the same incident.
import { anyAcknowledged, noteCall, contactUpdate, setPlan, type Incident } from './incident.js';
import { buildTask, type Caller } from './calle.js';
import { PLAYBOOKS } from './playbooks.js';
import type { Store } from './store.js';

export interface LadderOptions {
  /** Wait this long for a page acknowledgement before the first call. */
  graceMs: number;
  /** CALL-E needs about a minute before a call has a result. */
  settleMs: number;
  pollMs: number;
  /** Give up on one call after this long and move to the next contact. */
  maxCallMs: number;
  /** Pause between finishing one contact and starting the next. */
  gapMs: number;
}

export const DEFAULT_LADDER: LadderOptions = { graceMs: 30_000, settleMs: 60_000, pollMs: 8_000, maxCallMs: 4 * 60_000, gapMs: 2_000 };

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms).unref?.());

export function attachEscalation(store: Store, caller: Caller, opts: Partial<LadderOptions> = {}, log: (m: string) => void = () => {}) {
  const o = { ...DEFAULT_LADDER, ...opts };
  const started = new Set<string>();
  const now = () => store.now();

  const stillNeeded = (inc: Incident) => inc.status === 'open' && !anyAcknowledged(inc);

  const finish = (inc: Incident, state: 'done' | 'exhausted') => {
    inc.ladder.state = state;
    store.touch(inc.id);
  };

  async function run(id: string) {
    const first = store.get(id);
    if (first) {
      first.ladder.nextAt = now() + o.graceMs;
      store.touch(id);
    }
    await sleep(o.graceMs);
    const called = new Set<string>();
    for (;;) {
      const inc = store.get(id);
      if (!inc) return;
      if (!stillNeeded(inc)) return finish(inc, 'done');
      // Next contact, in the order the traveller listed them, who has a phone number and was not called yet.
      const next = store.profile.contacts.find((c) => c.phone && !called.has(c.id) && inc.contacts.find((a) => a.contactId === c.id)?.state !== 'acknowledged');
      if (!next) {
        inc.ladder.state = 'exhausted';
        store.timeline(inc, 'escalation', 'no contact has confirmed yet; traveller told to call 112');
        return store.touch(inc.id);
      }
      called.add(next.id);
      inc.ladder = { state: 'calling', step: inc.ladder.step + 1, nextAt: null };
      const task = buildTask({
        traveller: inc.traveller, contact: next.name,
        startedAt: new Date(inc.createdAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
        where: inc.location ? 'and shared her location' : '',
        situation: inc.playbook ? PLAYBOOKS[inc.playbook].title.toLowerCase() : null,
        language: next.language,
      });
      let placed: Awaited<ReturnType<Caller['place']>>;
      try {
        placed = await caller.place({ incidentId: inc.id, contactId: next.id, phone: next.phone!, task });
      } catch (e) {
        log(`call to ${next.name} failed: ${(e as Error).message}`);
        noteCall(inc, next.id, 'failed', now());
        store.touch(inc.id);
        await sleep(o.gapMs);
        continue;
      }
      if (placed.status === 'skipped') {
        log(`call to ${next.name} skipped: ${placed.reason}`);
        continue;
      }
      if (placed.status === 'dry_run') {
        noteCall(inc, next.id, 'dry_run', now());
        store.touch(inc.id);
        await sleep(o.gapMs);
        continue;
      }
      noteCall(inc, next.id, 'calling', now());
      store.touch(inc.id);
      const outcome = await waitForCall(placed.callId!);
      const cur = store.get(id);
      if (!cur) return;
      if (outcome?.willHelp) {
        noteCall(cur, next.id, 'confirmed', now(), outcome.said);
        contactUpdate(cur, next.id, 'acknowledged', now(), 'call');
        if (outcome.action && outcome.action !== 'none') setPlan(cur, next.id, outcome.action, outcome.etaMin ?? null, now(), 'call');
        return finish(cur, 'done');
      }
      noteCall(cur, next.id, outcome?.heard ? 'heard' : 'no_answer', now(), outcome?.said ?? '');
      store.touch(cur.id);
      await sleep(o.gapMs);
    }
  }

  async function waitForCall(callId: string) {
    const t0 = Date.now();
    await sleep(o.settleMs);
    while (Date.now() - t0 < o.maxCallMs) {
      try {
        const r = await caller.poll(callId);
        if (r.terminal) return r;
      } catch (e) {
        log(`poll ${callId}: ${(e as Error).message}`);
      }
      await sleep(o.pollMs);
    }
    return null;
  }

  // Start a ladder for every new open incident.
  return store.on((e) => {
    if (e.to !== 'traveller' || e.incident.status !== 'open' || started.has(e.incident.id)) return;
    started.add(e.incident.id);
    void run(e.incident.id).catch((err) => log(`escalation error: ${(err as Error).message}`));
  });
}
