// Confirmed stops ahead (idea from Local Atlas, winner of Amazon's Agents for Humans hackathon):
// SafeStop is mostly a system for NOT calling. A roadside stop (fuel station, dhaba, toll plaza) is phoned
// once with one factual question; the answer becomes a dated fact with the staff member's own words and
// an expiry, and every traveller on that road reads it without another call.
//   - A fresh stored answer is served instead of calling (the common case).
//   - Opinions ("is it safe?"), compound and account-specific questions are refused.
//   - A stop is called only inside 10:00-21:00 local time, unless it registered as open 24/7.
//   - One question = one call, even if many travellers ask at once; a daily cap.
//   - The number dialled comes from the stop's own opt-in registration, never from the request.
//   - Nothing is dialled until the traveller confirms the exact preview.
//   - Never part of an SOS: during an alert, only facts already stored are shown.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { distanceM } from './incident.js';
import type { Caller } from './calle.js';
import { Role, TaskState, type Part } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { verifyJws } from './cap.js';

export const STOPQUERY = 'safestop.stopquery/1';
const STOPQUERY_SKILL = 'answer_stop_question';

export interface Stop {
  id: string; name: string; kind: 'fuel' | 'toll_plaza' | 'dhaba' | 'restaurant';
  lat: number; lon: number;
  /** Server-side only: the number the stop registered. Never sent to a browser. */
  phone: string;
  /** As stated by the stop when it opted in; null = unknown (then only called 10:00-21:00). */
  hours: '24/7' | null;
  /** 'owner' = the stop registered itself; 'demo' = a real map place whose number is our test phone. */
  optIn: 'owner' | 'demo';
  source: string;
  /** If the stop runs its own AI agent (A2A), SafeStop asks it machine-to-machine instead of phoning. */
  agentUrl?: string;
}

export const TEMPLATES = {
  open_now: { text: 'Are you open right now?', short: 'Open now?' },
  open_until_6: { text: 'Will you stay open until 6 in the morning tonight?', short: 'Open until 6 am?' },
  staffed_now: { text: 'Is someone working on site right now?', short: 'Staff on site?' },
  lit_parking: { text: 'Is your forecourt or parking area lit at night?', short: 'Lit parking?' },
  womens_restroom: { text: "Do you have a women's restroom that is open now?", short: "Women's restroom?" },
} as const;
export type TemplateId = keyof typeof TEMPLATES;

export interface Fact {
  stopId: string; question: string; templateId: TemplateId | 'custom';
  answer: 'yes' | 'no' | 'unknown';
  /** The staff member's own words. */
  quote: string;
  collectedAt: number; expiresAt: number;
  callId: string;
  /** The quote was found in the call's own transcript (call) or the answer's signature verified (agent). */
  quoteChecked: boolean;
  /** How it was asked: a phone call in human language, or agent-to-agent in a machine protocol. */
  via?: 'call' | 'agent';
  /** For agent answers: how long the machine exchange took. */
  ms?: number;
}

export type AskResult =
  | { status: 'fresh'; fact: Fact }
  | { status: 'answered'; fact: Fact }
  | { status: 'refused'; reason: string }
  | { status: 'needs_confirmation'; preview: { stop: string; question: string; opening: string; disclosure: string; dialling: string } }
  | { status: 'calling'; callId: string }
  | { status: 'in_flight' };

const OPINION = /\b(safe|unsafe|danger(ous)?|best|good|bad|nice|clean|dirty|worth|recommend|trust(worthy)?|friendly|honest)\b/i;
const COMPOUND = /\?.*\?|\b(and|or|also|plus)\b|,\s*(is|are|do|does|can|will)\b/i;
const ACCOUNT = /\b(my (order|booking|card|car|vehicle|account)|reservation|refund)\b/i;

/** Is this a question one phone call can answer as a fact? (pure; tested) */
export function vetQuestion(q: string): string | null {
  const t = q.trim();
  if (t.length < 8 || t.length > 120) return 'Ask one short question.';
  if (OPINION.test(t)) return 'That asks for an opinion. SafeStop only asks facts (open? staffed? lit?), and never asks a place to say it is "safe".';
  if (COMPOUND.test(t)) return 'Ask one thing at a time: two questions in one get half an answer.';
  if (ACCOUNT.test(t)) return 'That is about you, not about the place.';
  return null;
}

/** Hour in the stop's local time (India, IST, no DST). */
const istHour = (ms: number) => new Date(ms + 5.5 * 3_600_000).getUTCHours();

/** May we phone this stop now? (pure; tested) */
export function callWindow(stop: Stop, now: number, demoAnytime = false): string | null {
  if (stop.hours === '24/7') return null;
  // A demo registration is answered by our own test phone, not station staff: quiet hours may be relaxed for it.
  if (demoAnytime && stop.optIn === 'demo') return null;
  const h = istHour(now);
  return h >= 10 && h < 21 ? null : 'It is outside 10 am - 9 pm at this stop and it has not said it is open 24 hours, so SafeStop will not ring it now.';
}

/** How long an answer stays true: a firm yes outlasts a hedge (pure; tested). */
export function expiryFor(answer: Fact['answer'], templateId: Fact['templateId'], now: number): number {
  if (answer === 'unknown') return now + 60 * 60_000;
  if (answer === 'no') return now + 12 * 3_600_000;
  if (templateId === 'open_until_6') {
    // until the next 06:00 IST
    const ist = new Date(now + 5.5 * 3_600_000);
    const next6 = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + (ist.getUTCHours() >= 6 ? 1 : 0), 6) - 5.5 * 3_600_000;
    return next6;
  }
  return now + (templateId === 'lit_parking' || templateId === 'womens_restroom' ? 24 : 4) * 3_600_000;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

export const FACT_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reached_person', 'answer', 'quote'],
  properties: {
    reached_person: { type: 'boolean', description: 'True only if a person at the business answered and heard the question.' },
    answer: { type: 'string', enum: ['yes', 'no', 'unknown'], description: 'Their answer to the one question. "unknown" if they did not know or would not say.' },
    quote: { type: 'string', description: 'Their exact words answering the question, verbatim, under 25 words.' },
  },
} as const;

export function buildFactTask(stop: Stop, question: string) {
  const opening = `Hi, is now a good moment for one quick question about your ${stop.kind === 'fuel' ? 'fuel station' : stop.kind === 'toll_plaza' ? 'toll plaza' : 'place'}?`;
  const disclosure = "Thank you. I'm an AI assistant, calling for a traveller on the highway who couldn't ring you themselves.";
  const task =
    `You are an AI calling ${stop.name}. Open with exactly: "${opening}" and wait for a yes. Then say: "${disclosure}" ` +
    `Then ask exactly one question: "${question}" You may ask at most one clarifying follow-up. "I don't know" is a valid answer. ` +
    'Never deny being an AI if asked. Do not book, order or promise anything, do not ask for personal details, and do not ask about anything else. ' +
    'If you reach voicemail, hang up without leaving a message. Thank them and end the call.';
  return { opening, disclosure, task };
}

export class Facts {
  private facts = new Map<string, Fact>(); // stopId|question -> fact
  private inFlight = new Map<string, string>(); // key -> callId
  private day = { date: '', used: 0 };
  /** Called when a new fact is stored (the server pushes it to every traveller's screen). */
  onFact: ((f: Fact) => void) | null = null;

  constructor(
    readonly stops: Stop[],
    private caller: Caller,
    private o: { file?: string; dailyCap?: number; now?: () => number; settleMs?: number; pollMs?: number; maxCallMs?: number; log?: (m: string) => void; demoAnytime?: boolean; onFact?: (f: Fact) => void } = {},
  ) {
    if (o.file && existsSync(o.file)) {
      try {
        for (const f of JSON.parse(readFileSync(o.file, 'utf8')) as Fact[]) this.facts.set(`${f.stopId}|${norm(f.question)}`, f);
      } catch {
        /* start empty */
      }
    }
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** Stops near a point, with their fresh facts (phone numbers are never included). */
  near(lat: number, lon: number, radiusM = 30_000) {
    const t = this.now();
    return this.stops
      .map((s) => ({ s, d: distanceM({ lat, lon }, s) }))
      .filter((x) => x.d <= radiusM)
      .sort((a, b) => a.d - b.d)
      .map(({ s, d }) => ({
        id: s.id, name: s.name, kind: s.kind, lat: s.lat, lon: s.lon, distanceM: d, hours: s.hours, optIn: s.optIn, source: s.source, hasAgent: !!s.agentUrl,
        facts: [...this.facts.values()].filter((f) => f.stopId === s.id && f.expiresAt > t).sort((a, b) => b.collectedAt - a.collectedAt),
      }));
  }

  fresh(stopId: string, question: string): Fact | null {
    const f = this.facts.get(`${stopId}|${norm(question)}`);
    return f && f.expiresAt > this.now() ? f : null;
  }

  /** The gauntlet, then (only with confirm) one call. */
  async ask(stopId: string, q: { templateId?: TemplateId; custom?: string }, confirm: boolean): Promise<AskResult> {
    const stop = this.stops.find((s) => s.id === stopId);
    if (!stop) return { status: 'refused', reason: 'Unknown stop.' };
    const templateId = q.templateId && q.templateId in TEMPLATES ? q.templateId : null;
    const question = templateId ? TEMPLATES[templateId].text : (q.custom ?? '').trim();
    if (!templateId) {
      const bad = vetQuestion(question);
      if (bad) return { status: 'refused', reason: bad };
    }
    const fact = this.fresh(stopId, question);
    if (fact) return { status: 'fresh', fact };
    const key = `${stopId}|${norm(question)}`;
    if (this.inFlight.has(key)) return { status: 'in_flight' };
    // Machine first: if the stop has its own AI agent, the two agents skip human language entirely.
    // No phone rings, no staff are disturbed, nothing is paid, so no confirmation or call window applies.
    if (stop.agentUrl && templateId) {
      this.inFlight.set(key, 'agent');
      try {
        const viaAgent = await this.askAgent(stop, templateId, question);
        if (viaAgent) {
          this.facts.set(key, viaAgent);
          this.save();
          this.onFact?.(viaAgent);
          return { status: 'answered', fact: viaAgent };
        }
      } finally {
        this.inFlight.delete(key);
      }
      // No agent, no such skill, unreachable, or the answer did not verify: fall back to a phone call.
    }
    const win = callWindow(stop, this.now(), this.o.demoAnytime);
    if (win) return { status: 'refused', reason: win };
    const today = new Date(this.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    if (this.day.date !== today) this.day = { date: today, used: 0 };
    if (this.day.used >= (this.o.dailyCap ?? 10)) return { status: 'refused', reason: "Today's call budget is used up; stored answers are still shown." };
    const { opening, disclosure, task } = buildFactTask(stop, question);
    if (!confirm) return { status: 'needs_confirmation', preview: { stop: stop.name, question, opening, disclosure, dialling: `the number ${stop.name} registered (…${stop.phone.slice(-2)})` } };
    // Reserve before any await, so fifty simultaneous askers produce one call.
    this.day.used++;
    this.inFlight.set(key, 'pending');
    try {
      const placed = await this.caller.place({ incidentId: `fact-${stop.id}-${Math.floor(this.now() / 1_800_000)}-${norm(question).slice(0, 30).replace(/ /g, '-')}`, contactId: stop.id, phone: stop.phone, task, resultSchema: FACT_RESULT_SCHEMA });
      if (placed.status === 'skipped') {
        this.inFlight.delete(key);
        this.day.used--;
        return { status: 'refused', reason: `Not called: ${placed.reason}.` };
      }
      const callId = placed.callId!;
      this.inFlight.set(key, callId);
      void this.collect(stop, question, templateId ?? 'custom', callId, key);
      return { status: 'calling', callId };
    } catch (e) {
      this.inFlight.delete(key);
      this.day.used--;
      return { status: 'refused', reason: `The call could not be placed (${(e as Error).message.slice(0, 80)}).` };
    }
  }

  /** Agent-to-agent: one structured question over A2A, one signed structured answer. null = use the phone. */
  private async askAgent(stop: Stop, templateId: TemplateId, question: string): Promise<Fact | null> {
    const t0 = performance.now();
    // One overall deadline for the machine exchange, cleared as soon as it is done.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const client = await new ClientFactory().createFromUrl(stop.agentUrl!);
      const card = await client.getAgentCard();
      if (!card.skills?.some((s) => s.id === STOPQUERY_SKILL)) {
        this.o.log?.(`${stop.name}: agent has no ${STOPQUERY_SKILL} skill; using the phone`);
        return null;
      }
      const res = await client.sendMessage({
        tenant: '', configuration: undefined, metadata: {},
        message: { role: Role.ROLE_USER, messageId: crypto.randomUUID(), taskId: '', contextId: '', extensions: [], metadata: {}, referenceTaskIds: [],
          parts: [{ content: { $case: 'data', value: { proto: STOPQUERY, stopId: stop.id, templateId } }, metadata: undefined, filename: '', mediaType: 'application/json' }] },
      }, { signal: ctl.signal });
      if (!('status' in res) || res.status?.state !== TaskState.TASK_STATE_COMPLETED) return null;
      const c = (res.status.message?.parts as Part[] | undefined)?.find((p) => p.content?.$case === 'data')?.content;
      const d = (c && c.$case === 'data' ? c.value : null) as { jws?: string } | null;
      if (!d?.jws) return null;
      const jwks = (await (await fetch(`${stop.agentUrl}/.well-known/jwks.json`, { signal: ctl.signal })).json()) as { keys: any[] };
      const v = await verifyJws<{ proto: string; stopId: string; templateId: string; answer: Fact['answer']; statement: string; observedAt: string }>(d.jws, jwks);
      const age = this.now() - Date.parse(v.observedAt);
      if (v.proto !== STOPQUERY || v.stopId !== stop.id || v.templateId !== templateId || !['yes', 'no', 'unknown'].includes(v.answer) || !(age > -60_000 && age < 5 * 60_000)) {
        this.o.log?.(`${stop.name}: agent answer did not bind (stop/question/time); using the phone`);
        return null;
      }
      const now = this.now();
      const ms = Math.round(performance.now() - t0);
      this.o.log?.(`${stop.name}: answered agent-to-agent in ${ms} ms (${v.answer})`);
      // A system's live state can change any minute; machine answers are cheap, so they expire fast.
      return { stopId: stop.id, question, templateId, answer: v.answer, quote: String(v.statement).slice(0, 200), collectedAt: now, expiresAt: now + 15 * 60_000, callId: res.id, quoteChecked: true, via: 'agent', ms };
    } catch (e) {
      this.o.log?.(`${stop.name}: agent not reachable (${(e as Error).message.slice(0, 60)}); using the phone`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Wait for the call, then publish a fact only if it binds to this call. */
  private async collect(stop: Stop, question: string, templateId: Fact['templateId'], callId: string, key: string) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());
    try {
      await sleep(this.o.settleMs ?? 60_000);
      const t0 = Date.now();
      while (Date.now() - t0 < (this.o.maxCallMs ?? 5 * 60_000)) {
        const r = await this.caller.poll(callId).catch(() => null);
        if (r?.terminal) {
          const s = (r.raw ?? {}) as { reached_person?: boolean; answer?: string; quote?: string };
          // Bind to this call: completed, the number we meant, a person reached, an answer quoted.
          const rightNumber = !r.phone || r.phone.replace(/\s/g, '') === stop.phone.replace(/\s/g, '');
          if (!rightNumber || s.reached_person !== true || !s.quote || !['yes', 'no', 'unknown'].includes(s.answer ?? '')) {
            this.o.log?.(`fact not stored for ${stop.name}: ${!rightNumber ? 'wrong number' : 'no person / no quote'}`);
            return;
          }
          const quoteChecked = !!r.transcript && norm(r.transcript).includes(norm(s.quote));
          if (r.transcript && !quoteChecked) {
            this.o.log?.(`fact not stored for ${stop.name}: quote not in transcript`);
            return;
          }
          const now = this.now();
          const fact: Fact = { stopId: stop.id, question, templateId, answer: s.answer as Fact['answer'], quote: s.quote.slice(0, 200), collectedAt: now, expiresAt: expiryFor(s.answer as Fact['answer'], templateId, now), callId, quoteChecked, via: 'call' };
          this.facts.set(key, fact);
          this.save();
          this.o.onFact?.(fact);
          this.onFact?.(fact);
          return;
        }
        await sleep(this.o.pollMs ?? 8_000);
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  private save() {
    if (!this.o.file) return;
    try {
      writeFileSync(this.o.file, JSON.stringify([...this.facts.values()].filter((f) => f.expiresAt > this.now())));
    } catch {
      /* best effort */
    }
  }
}

/** Real fuel stations near Vellore from OpenStreetMap (Nominatim), registered for the DEMO with the test number. */
export function demoStops(nominatimFile: string, demoPhone: string, max = 3): Stop[] {
  if (!existsSync(nominatimFile) || !demoPhone) return [];
  const { places } = JSON.parse(readFileSync(nominatimFile, 'utf8')) as { places: { osm_type: string; osm_id: number; name: string; lat: string; lon: string; type: string }[] };
  return places
    .filter((p) => p.type === 'fuel' && p.name)
    .slice(0, max)
    .map((p) => ({
      id: `${p.osm_type[0]}${p.osm_id}`, name: p.name, kind: 'fuel' as const, lat: Number(p.lat), lon: Number(p.lon),
      phone: demoPhone, hours: null, optIn: 'demo' as const, // hours unknown: only called 10 am - 9 pm
      source: 'OpenStreetMap place; demo registration (the station has not opted in; a test phone answers as the station)',
    }));
}
