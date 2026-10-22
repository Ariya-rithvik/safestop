// Real phone calls through the CALL-E Developer API (https://docs.heycall-e.com), the same channel and
// safety rails as FloodLens (AWS Environmental hackathon): a consenting-number allowlist, a hard call cap,
// and an idempotency key so a retried request can never become a second call.
// SIDE EFFECT: a placed call rings a real phone and spends credit. Dry-run mode logs the task instead.

export interface CallOutcome {
  status: string;
  terminal: boolean;
  /** A person answered and the whole message was read to them. */
  heard: boolean;
  /** They said they will help. */
  willHelp: boolean;
  /** What they said, in a few words (from the call agent). */
  said: string;
  /** Their plan, if they said yes (Care Call AI idea: turn a "yes" into a concrete next step). */
  action?: 'calling_her' | 'going_there' | 'calling_police' | 'other' | 'none';
  etaMin?: number | null;
  /** The whole structured result (for callers with their own schema). */
  raw?: Record<string, unknown>;
  /** The call transcript as plain text, when CALL-E provides it. */
  transcript?: string;
  /** The number actually dialled, when CALL-E reports it. */
  phone?: string;
}

export interface Caller {
  readonly mode: 'live' | 'dry_run';
  place(p: { incidentId: string; contactId: string; phone: string; task: string; resultSchema?: object }): Promise<{ status: 'placed' | 'dry_run' | 'skipped'; callId?: string; reason?: string }>;
  poll(callId: string): Promise<CallOutcome>;
}

export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['heard', 'will_help', 'said'],
  properties: {
    heard: { type: 'boolean', description: 'True if a person answered and the full message was read to them.' },
    will_help: { type: 'boolean', description: 'True only if the person clearly said they will help or will call her.' },
    said: { type: 'string', description: 'What the person said in reply, in under 15 words.' },
    action: { type: 'string', enum: ['calling_her', 'going_there', 'calling_police', 'other', 'none'], description: 'What they said they will do. "none" if they will not help or did not say.' },
    eta_min: { type: ['integer', 'null'], description: 'Minutes until they reach her, only if they are going there and said a time; else null.' },
  },
} as const;

const TERMINAL = /^(completed|complete|finished|succeeded|success|failed|error|cancell?ed|no_answer|no-answer|busy|expired)$/i;

export const toE164 = (phone: string) => {
  const p = phone.replace(/[\s()-]/g, '');
  return p.startsWith('+') ? p : `+91${p.slice(-10)}`;
};
const REGIONS: [string, string, string][] = [['+91', 'IN', 'en-IN'], ['+977', 'NP', 'en-US'], ['+1', 'US', 'en-US']];
const regionFor = (phone: string) => REGIONS.find(([pre]) => phone.startsWith(pre))?.slice(1) ?? ['IN', 'en-IN'];

/**
 * The call agent's instructions. Fixed wording: it reads the facts, asks one question, and is told never
 * to give advice or reassure anyone that the traveller is safe (pure; tested).
 */
export const LANGUAGES: Record<string, string> = { 'en-IN': 'Indian English', 'hi-IN': 'Hindi', 'ta-IN': 'Tamil' };

export function buildTask(m: { traveller: string; contact: string; startedAt: string; where: string; situation: string | null; language?: string }): string {
  const msg =
    `This is SafeStop, calling ${m.contact} for ${m.traveller}. ` +
    `${m.traveller} started a quiet safety alert at ${m.startedAt}${m.where ? `, ${m.where}` : ''}. ` +
    (m.situation ? `What she reported: ${m.situation}. ` : '') +
    `Her live status and location are in the SafeStop link you were sent.`;
  return (
    `You are an automated safety-alert line called SafeStop. Speak calmly and clearly in ${LANGUAGES[m.language ?? 'en-IN'] ?? 'Indian English'} (translate the message faithfully; keep names and numbers). ` +
    `Read this message exactly as written: "${msg}" ` +
    `Then ask exactly one question: "Can you help ${m.traveller} right now? Please say yes or no." ` +
    `If they say yes, ask one follow-up: "What will you do: call ${m.traveller}, go to her, or call the police? If you are going, about how many minutes?" ` +
    'Then say "Thank you, she will see that you are helping" and end the call. If they say no, say goodbye and end the call. ' +
    'Offer to repeat the message once if asked. Do not give any advice, do not say she is safe or in danger, do not guess what is happening, and do not answer other questions.'
  );
}

export function makeCaller(opts: { apiKey?: string; allowed?: string; maxCalls?: number; baseUrl?: string; dryRun?: boolean; fetchImpl?: typeof fetch; log?: (m: string) => void }): Caller {
  const log = opts.log ?? (() => {});
  const allowlist = (opts.allowed ?? '').split(',').map((n) => n.trim()).filter(Boolean).map(toE164);
  const maxCalls = opts.maxCalls ?? 10;
  let placed = 0;

  if (!opts.apiKey || opts.dryRun) {
    let n = 0;
    return {
      mode: 'dry_run',
      async place(p) {
        const phone = toE164(p.phone);
        if (allowlist.length && !allowlist.includes(phone)) return { status: 'skipped', reason: 'not on the allowlist' };
        log(`DRY RUN call to …${phone.slice(-2)}: ${p.task}`);
        return { status: 'dry_run', callId: `dry_${++n}` };
      },
      async poll() {
        return { status: 'dry_run', terminal: true, heard: false, willHelp: false, said: '' };
      },
    };
  }

  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? 'https://api.heycall-e.com';
  const req = (path: string, init: RequestInit = {}) =>
    f(base + path, { ...init, headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(30_000) });

  return {
    mode: 'live',
    async place(p) {
      const phone = toE164(p.phone);
      // With no allowlist nobody is called: a demo must never ring a number that did not consent.
      if (!allowlist.includes(phone)) return { status: 'skipped', reason: 'not on the allowlist' };
      if (placed >= maxCalls) return { status: 'skipped', reason: 'call limit reached' };
      const [region, locale] = regionFor(phone);
      const key = `safestop-${p.incidentId}-${p.contactId}`;
      const metadata = { incident_id: p.incidentId, contact_id: p.contactId };
      let res = await req('/v1/calls', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ task: p.task, recipients: [{ phones: [phone], region, locale }], result_schema: p.resultSchema ?? RESULT_SCHEMA, metadata }) });
      // Accounts on the newer API version take a single phone instead of a recipients list.
      if (res.status === 404 || res.status === 410) res = await req('/v2/calls', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ task: p.task, phone, region, result_schema: p.resultSchema ?? RESULT_SCHEMA, metadata }) });
      if (!res.ok) throw new Error(`CALL-E answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      placed++;
      const call = (await res.json()) as { call_id?: string; id?: string };
      return { status: 'placed', callId: call.call_id ?? call.id };
    },
    async poll(callId) {
      const res = await req(`/v1/calls/${encodeURIComponent(callId)}`);
      if (!res.ok) throw new Error(`CALL-E poll ${res.status}`);
      const r = (await res.json()) as { status?: string; structured_result?: Record<string, unknown> | null; transcript?: unknown; phone?: unknown; to?: unknown; recipients?: { phones?: string[] }[] };
      const s = (r.structured_result ?? {}) as { heard?: unknown; will_help?: unknown; said?: unknown };
      const tr = r.transcript;
      const transcript = typeof tr === 'string' ? tr : Array.isArray(tr) ? tr.map((x) => (typeof x === 'string' ? x : String((x as { text?: unknown; content?: unknown })?.text ?? (x as { content?: unknown })?.content ?? ''))).join(' ') : undefined;
      return {
        status: String(r.status ?? 'unknown'),
        terminal: TERMINAL.test(String(r.status ?? '')),
        heard: s.heard === true,
        willHelp: s.will_help === true,
        said: typeof s.said === 'string' ? s.said.slice(0, 120) : '',
        action: (['calling_her', 'going_there', 'calling_police', 'other', 'none'] as const).find((x) => x === (r.structured_result as { action?: unknown } | null)?.action),
        etaMin: (() => { const v = (r.structured_result as { eta_min?: unknown } | null)?.eta_min; return typeof v === 'number' && v >= 0 && v < 600 ? Math.round(v) : null; })(),
        raw: r.structured_result ?? undefined,
        transcript,
        phone: typeof r.phone === 'string' ? r.phone : typeof r.to === 'string' ? r.to : r.recipients?.[0]?.phones?.[0],
      };
    },
  };
}
