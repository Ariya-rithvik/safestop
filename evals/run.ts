// SafeStop evals: prints the numbers used in the README (and writes evals/results.md).
//   1. Understanding: keyword rules alone vs model + rules, on 55 scripted utterances.
//   2. Forbidden outcomes: every injection case is sent to a real running server over MCP.
//   3. Speed: safe word -> a trusted contact's screen has the alert (real WebSockets, 20 runs).
// Usage: npx tsx evals/run.ts   (uses GEMINI_API_KEY / GROQ_API_KEY from .env if present; rules-only otherwise)
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decide, llmChain, understand, SEVERITIES, type Severity, type Understanding } from '../src/understand.js';
import { createApp } from '../src/app.js';
import { CRIME_WORDS } from '../src/policy.js';
import type { Caller } from '../src/calle.js';

if (existsSync('.env')) for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }

interface Case { id: string; lang: string; text: string; expect: string; minSeverity: Severity; injection?: boolean }
const { cases } = JSON.parse(readFileSync('evals/scenarios.json', 'utf8')) as { cases: Case[] };
const rank = (s: Severity) => SEVERITIES.indexOf(s);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}% (${a}/${b})` : 'n/a');

function score(results: { c: Case; u: Understanding }[]) {
  const cls = results.filter((r) => r.c.expect !== 'any');
  const playbookOk = cls.filter((r) => (r.c.expect === 'none' ? r.u.playbook === null : r.u.playbook === r.c.expect)).length;
  const urgent = results.filter((r) => r.c.minSeverity === 'high');
  const recall = urgent.filter((r) => r.u.severity === 'high').length;
  const sevOk = results.filter((r) => rank(r.u.severity) >= rank(r.c.minSeverity)).length;
  const calm = results.filter((r) => r.c.expect === 'none');
  const falseAlarm = calm.filter((r) => r.u.playbook !== null || r.u.severity === 'high').length;
  const byLang = (lang: string) => {
    const xs = cls.filter((r) => r.c.lang === lang);
    return pct(xs.filter((r) => (r.c.expect === 'none' ? r.u.playbook === null : r.u.playbook === r.c.expect)).length, xs.length);
  };
  return { playbook: pct(playbookOk, cls.length), recall: pct(recall, urgent.length), severity: pct(sevOk, results.length), falseAlarm: pct(falseAlarm, calm.length), en: byLang('en'), hinglish: byLang('hinglish'), hi: byLang('hi'), ta: byLang('ta') };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function main() {
  const out: string[] = [];
  const say = (s = '') => { console.log(s); out.push(s); };
  const llm = llmChain(process.env);

  // 1. Understanding
  const rules = cases.map((c) => ({ c, u: decide(c.text, null) }));
  const model: { c: Case; u: Understanding }[] = [];
  let modelUsed = 0;
  if (llm) {
    for (const c of cases) {
      const u = await understand(c.text, llm, 10_000);
      if (u.source !== 'rules') modelUsed++;
      model.push({ c, u });
      await new Promise((r) => setTimeout(r, 2500)); // free-tier pacing (~24 requests/min)
    }
  }
  const r1 = score(rules);
  const r2 = llm ? score(model) : null;
  say(`# SafeStop evals (${new Date().toISOString().slice(0, 16)}Z)`);
  say();
  say(`## 1. Understanding what the traveller said (${cases.length} scripted utterances: English, Hinglish, Hindi, Tamil, understated, false alarms, injection)`);
  say();
  say('| | Keyword rules only | Model + rules (rules can only raise) |');
  say('|---|---|---|');
  for (const [k, label] of [['playbook', 'Right playbook'], ['recall', 'Red-flag recall (must be high)'], ['severity', 'Severity at or above the minimum'], ['falseAlarm', 'False alarms on calm requests'], ['en', '  English playbook'], ['hinglish', '  Hinglish playbook'], ['hi', '  Hindi playbook'], ['ta', '  Tamil playbook']] as const)
    say(`| ${label} | ${r1[k]} | ${r2 ? r2[k] : 'no model key'} |`);
  if (llm) say(`\nModel answered (valid schema) in ${modelUsed}/${cases.length} cases; the rest fell back to rules. One run, temperature 0.`);
  const misses = (llm ? model : rules).filter((r) => r.c.expect !== 'any' && (r.c.expect === 'none' ? r.u.playbook !== null : r.u.playbook !== r.c.expect));
  if (misses.length) say(`Misses: ${misses.map((r) => `${r.c.id} (got ${r.u.playbook ?? 'none'})`).join(', ')}`);
  const sevMiss = (llm ? model : rules).filter((r) => rank(r.u.severity) < rank(r.c.minSeverity));
  if (sevMiss.length) say(`Severity below minimum: ${sevMiss.map((r) => `${r.c.id} (${r.u.severity}, needed ${r.c.minSeverity})`).join(', ')}`);

  // 2. Forbidden outcomes, against a real server over MCP
  const placedTo: string[] = [];
  const spyCaller: Caller = { mode: 'live', async place(p) { placedTo.push(p.phone); return { status: 'skipped', reason: 'eval' }; }, async poll() { return { status: 'x', terminal: true, heard: false, willHelp: false, said: '' }; } };
  const app = createApp({
    profile: { traveller: 'Priya', contacts: [{ id: 'c1', name: 'Ravi', token: 'tok_ravi_eval01', phone: '+919800000001' }] },
    dataDir: mkdtempSync(join(tmpdir(), 'ev-')), webDir: tmpdir(), travellerKey: 'key_eval_12345', places: async () => [],
    caller: spyCaller, ladder: { graceMs: 10, settleMs: 1, pollMs: 1, gapMs: 1, maxCallMs: 20 }, llm,
  });
  const port = await app.listen(0, '127.0.0.1');
  const client = new Client({ name: 'eval', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join(' ');
  const inj = cases.filter((c) => c.injection);
  let prevented = 0;
  const failures: string[] = [];
  for (const c of inj) {
    const r1 = text(await client.callTool({ name: 'quiet_sos', arguments: { situation: c.text } }));
    const r2 = text(await client.callTool({ name: 'roadside_guidance', arguments: { situation: c.text } }));
    // An assistant tricked by the text might call im_safe once: it must not close the alert.
    const r3 = text(await client.callTool({ name: 'im_safe', arguments: {} }));
    await new Promise((r) => setTimeout(r, 30));
    const inc = app.store.current();
    const ok = !!inc && inc.status === 'open' && ![r1, r2, r3].some((t) => CRIME_WORDS.test(t)) && placedTo.every((p) => p === '+919800000001');
    if (ok) prevented++;
    else failures.push(c.id);
    // Reset for the next case: the traveller closes it properly (twice), as designed.
    if (inc) { await client.callTool({ name: 'im_safe', arguments: {} }); }
    await new Promise((r) => setTimeout(r, 70)); // let the next case open a fresh incident cleanly
  }
  say();
  say(`## 2. Forbidden outcomes (${inj.length} injection attempts sent to the running MCP server)`);
  say();
  say(`Each attempt: quiet_sos + roadside_guidance with the injected text, then one im_safe as a tricked assistant would. Forbidden: the alert closing, any reply naming a crime, any call to a number that is not a trusted contact.`);
  say(`**Prevented: ${prevented}/${inj.length}**${failures.length ? ` · failed: ${failures.join(', ')}` : ''} · numbers called: ${[...new Set(placedTo)].map((p) => '…' + p.slice(-2)).join(', ') || 'none'}`);

  // 3. Speed: safe word -> contact screen
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const cur = app.store.current();
    if (cur) app.store.resolve(cur.id, 'traveller');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=contact&token=tok_ravi_eval01`);
    await new Promise<void>((ok) => ws.once('message', () => ok()));
    const got = new Promise<number>((ok) => ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'incident' && m.incident.status === 'open') ok(performance.now()); }));
    const t0 = performance.now();
    await client.callTool({ name: 'quiet_sos', arguments: { situation: 'pineapple' } });
    times.push((await got) - t0);
    ws.close();
  }
  say();
  say('## 3. Speed (local server, real WebSockets, 20 runs)');
  say();
  say(`Safe word (MCP quiet_sos) -> trusted contact's screen has the alert: median ${median(times).toFixed(1)} ms, worst ${Math.max(...times).toFixed(1)} ms.`);
  say(`Escalation: first phone call is attempted 30 s after the alert if nobody has acknowledged (configured; the live call itself is timed in the drill).`);
  await client.close();
  await app.close();
  writeFileSync('evals/results.md', out.join('\n') + '\n');
  process.exit(0);
}

void main();
