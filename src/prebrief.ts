// Pre-brief agent: the moment an alert opens, SafeStop's agent asks every nearby stop that runs its OWN AI
// agent, machine to machine, "open now?" and "someone on site?". No phone rings and no person is disturbed,
// so it needs no confirmation. By the time a human (her family, the desk officer) first looks, the nearest
// open, staffed stop is already on their screen, with the answering agent's signed words and the time.
// Stops without an agent are never phoned from here: phoning stays a deliberate, one-at-a-time choice.
import type { Facts } from './facts.js';
import type { Store } from './store.js';
import { addEvidence } from './incident.js';

export interface PrebriefStop { stopId: string; name: string; distanceM: number; open: 'yes' | 'no' | 'unknown' | null; staffed: 'yes' | 'no' | 'unknown' | null; quote: string; ms: number }
export interface Prebrief { at: number; ms: number; asked: number; stops: PrebriefStop[]; best: PrebriefStop | null }

export function attachPrebrief(store: Store, facts: Facts, opts: { radiusM?: number; max?: number; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const started = new Set<string>();

  async function run(id: string) {
    const inc = store.get(id);
    const loc = inc?.location;
    if (!inc || !loc) return;
    const t0 = performance.now();
    const near = facts.near(loc.lat, loc.lon, opts.radiusM ?? 20_000).filter((s) => s.hasAgent).slice(0, opts.max ?? 5);
    if (!near.length) return;
    store.timeline(inc, 'prebrief', `asking ${near.length} nearby ${near.length === 1 ? 'stop' : 'stops'} with their own AI agent, machine to machine (no phone, no person disturbed)`);
    const stops = await Promise.all(near.map(async (s): Promise<PrebriefStop> => {
      const a0 = performance.now();
      const [o, st] = await Promise.all([facts.ask(s.id, { templateId: 'open_now' }, false), facts.ask(s.id, { templateId: 'staffed_now' }, false)]);
      // Only agent answers (or a fresh stored one) count here; anything that would need a phone call is left alone.
      const ans = (r: Awaited<ReturnType<Facts['ask']>>) => ('fact' in r && r.fact ? r.fact : null);
      const fo = ans(o), fs = ans(st);
      return { stopId: s.id, name: s.name, distanceM: s.distanceM, open: fo?.answer ?? null, staffed: fs?.answer ?? null, quote: fo?.quote ?? fs?.quote ?? '', ms: Math.round(performance.now() - a0) };
    }));
    const cur = store.get(id);
    if (!cur || cur.status !== 'open') return;
    const ok = stops.filter((s) => s.open === 'yes').sort((a, b) => (b.staffed === 'yes' ? 1 : 0) - (a.staffed === 'yes' ? 1 : 0) || a.distanceM - b.distanceM);
    const brief: Prebrief = { at: store.now(), ms: Math.round(performance.now() - t0), asked: near.length, stops, best: ok[0] ?? null };
    cur.prebrief = brief;
    const b = brief.best;
    store.timeline(cur, 'prebrief', b
      ? `ready before any human looked (${brief.ms} ms): nearest open${b.staffed === 'yes' ? ', staffed' : ''} stop ${b.name}, ${(b.distanceM / 1000).toFixed(1)} km. Its agent: "${b.quote}"`
      : `ready in ${brief.ms} ms: no stop agent confirmed it is open`);
    addEvidence(cur, store.now(), 'tool', `prebrief: ${stops.map((s) => `${s.name} open=${s.open} staffed=${s.staffed}`).join('; ')}`);
    store.touch(id);
    log(`prebrief ${id}: ${brief.ms} ms, best ${b?.name ?? 'none'}`);
  }

  return store.on((e) => {
    if (e.to !== 'traveller' || e.incident.status !== 'open' || started.has(e.incident.id) || !e.incident.location) return;
    started.add(e.incident.id);
    void run(e.incident.id).catch((err) => log(`prebrief error: ${(err as Error).message}`));
  });
}
