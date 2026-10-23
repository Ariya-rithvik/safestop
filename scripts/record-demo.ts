// Records the demo video by driving the REAL running app (npm run patrol / stopagent / start must be up).
// Three browser windows are recorded at once (traveller, Meena's phone, patrol desk). Voices are Amazon Polly:
// narrator (Matthew), Priya (Kajal), the simulated Alexa+ (Joanna, speaking the app's real replies) and the
// patrol desk's scoped agent (Gregory, reading its real brief). ffmpeg composites demo/safestop-demo.mp4.
// If demo/stopcall-insert.mp4 exists (scripts/record-call.ts --stop: a real CALL-E call), it is spliced in after the station scene.
// Never shows the traveller key or contact tokens: they are only in the URLs, and video has no address bar.
//   npx tsx scripts/record-demo.ts            record + composite
//   npx tsx scripts/record-demo.ts --splice   only re-splice the call insert into the last recording
import { chromium, type Page } from 'playwright-core';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.SAFESTOP_URL ?? 'http://localhost:8790';
const DESK = process.env.DESK_URL ?? 'http://localhost:8792/desk';
const OUT = join(process.cwd(), 'demo');
const VO = join(OUT, 'vo');
mkdirSync(VO, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- voices ----------
const VOICES = { narrator: ['Matthew', 'en-US'], priya: ['Kajal', 'en-IN'], alexa: ['Joanna', 'en-US'], desk: ['Gregory', 'en-US'] } as const;
type Who = keyof typeof VOICES;
const ffprobe = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
function synth(who: Who, text: string): { file: string; dur: number } {
  const [voice, lang] = VOICES[who];
  const file = join(VO, `${who}-${createHash('sha1').update(voice + text).digest('hex').slice(0, 12)}.mp3`);
  if (!existsSync(file)) execFileSync('aws', ['polly', 'synthesize-speech', '--region', 'us-east-1', '--engine', 'neural', '--voice-id', voice, '--language-code', lang, '--output-format', 'mp3', '--text', text, file]);
  return { file, dur: ffprobe(file) };
}

// ---------- timeline (seconds from "go") ----------
type Clip = { file: string; at: number };
type Span = { at: number; end: number; text?: string; pane?: 'desk' | 'cont' };
const clips: Clip[] = [], caps: Span[] = [], spots: Span[] = [];
let go = 0;
const now = () => (Date.now() - go) / 1000;
const close = (list: Span[]) => { const l = list[list.length - 1]; if (l && l.end < 0) l.end = now(); };
/** Speak a line now (placed at this moment in the edit) and wait until it has been said. */
async function say(who: Who, text: string, at = now()) {
  const { file, dur } = synth(who, text);
  clips.push({ file, at });
  const wait = (at + dur + 0.35 - now()) * 1000;
  if (wait > 0) await sleep(wait);
}
const cap = (text: string) => { close(caps); caps.push({ at: now(), end: -1, text }); };
const spot = (pane: 'desk' | 'cont' | null) => { close(spots); if (pane) spots.push({ at: now(), end: -1, pane }); };

type Pages = { trav: Page; cont: Page; desk: Page };
/** Type to the simulated Alexa+ and return its real reply (from /api/assistant) and when it appeared. */
async function ask(p: Page, text: string) {
  const resP = p.waitForResponse((r) => r.url().endsWith('/api/assistant'), { timeout: 20000 });
  await p.fill('#sayText', text);
  await p.click('#sayForm button.primary');
  const body = await (await resP).json();
  return { reply: String(body.reply ?? ''), tool: String(body.tool ?? ''), at: now() };
}
/** Priya speaks to Alexa; Alexa answers aloud with the app's real reply (except the quiet SOS, which stays on screen). */
async function talk(p: Page, spoken: string, typed: string) {
  await say('priya', spoken);
  const r = await ask(p, typed);
  // Alexa speaks the start of the real reply (the full text stays on screen).
  const parts = r.reply.match(/[^.!?;]+[.!?;]*/g) ?? [r.reply];
  let line = '';
  for (const x of parts) { if (line && line.length + x.length > 220) break; line += x; }
  line = line.trim().replace(/;$/, '.');
  if (r.tool !== 'quiet_sos' && line) await say('alexa', line, r.at + 0.4);
  return r;
}
const scrollPanel = (p: Page, sel: string) => p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), sel);

type Scene = { id: string; run: (p: Pages) => Promise<void> };
const SCENES: Scene[] = [
  { id: 'intro', run: async () => { await say('narrator', 'SafeStop Relay Network. A quiet roadside S O S, for Alexa plus.'); await sleep(700); } },
  { id: 'drive', run: async () => {
    cap('11 pm · NH48 · Priya drives alone into Vellore (simulated drive on the real road)');
    await say('narrator', 'Eleven p m, on N H 48. Priya is driving alone into Vellore. A white car has been following her for ten kilometres.');
  } },
  { id: 'sos', run: async ({ trav, cont }) => {
    cap('Safe word to Alexa → Alexa stays silent (on-screen reply) → family alerted in milliseconds');
    await talk(trav, 'Alexa, pineapple. A white Innova, T N zero nine, A B one two three four, is following me.', 'pineapple, a white Innova TN 09 AB 1234 is following me');
    await cont.waitForSelector('#alertBox:not(.hidden)', { timeout: 15000 });
    await say('narrator', "Pineapple is her safe word. Alexa replies on screen only, and her family's phones already have the alert.");
  } },
  { id: 'machine', run: async ({ trav, desk }) => {
    spot('desk');
    cap('Police can’t talk at machine speed → their desk runs a SCOPED AI agent · agent ↔ agent in machine language (signed CAP 1.2 over A2A)');
    await desk.waitForSelector('button[data-k=dispatch]', { timeout: 15000 });
    await scrollPanel(trav, '#incident');
    await say('narrator', "Police can't talk at machine speed, so the desk runs a scoped A I agent. SafeStop's agent speaks to it in machine language: a signed CAP alert, verified in milliseconds.");
    cap('The desk agent briefs the human officer in plain words (scope: verify · prepare · brief, never dispatch)');
    // The desk page's own brief text for the newest case (same function its Speak button uses).
    const text = await desk.evaluate(() => { const w = window as any; const c = [...w.__cases.values()].pop(); return c ? (w.briefFor(c) as string) : null; }).catch(() => null)
      ?? 'New signed alert, signature verified. Nearest unit prepared. Dispatch is your decision.';
    await say('desk', text);
    await say('narrator', 'It can brief. It can never dispatch.');
    spot(null);
  } },
  { id: 'ladder', run: async ({ trav }) => {
    cap('Nobody tapped “I’m on it” → the escalation agent phones Ravi (AI call via CALL-E). Dry run here: CALL-E declines emergency calls by policy');
    await say('narrator', 'Nobody has tapped yet, so the escalation agent phones her brother Ravi, an A I call through CALL E.');
    await trav.waitForFunction(() => /dry run|Phoning now|Said yes/.test(document.querySelector('#chain')?.textContent ?? ''), null, { timeout: 45000 }).catch(() => {});
    await say('narrator', 'We tried it live: CALL E declines emergency calls by policy. SafeStop shows that honestly, and tells her to call one one two.');
  } },
  { id: 'meena', run: async ({ cont }) => {
    spot('cont');
    cap('Meena taps “I’m on it” and answers with a plan → her car appears on every map');
    await cont.click('#ack');
    await cont.waitForSelector('#planBox:not(.hidden)');
    await sleep(900);
    await cont.click('[data-plan=going_there]');
    await cont.waitForSelector('#shareBox:not(.hidden)');
    await sleep(600);
    await cont.check('#share');
    await say('narrator', "Her sister Meena taps I'm on it, and answers with a plan: coming, twenty minutes. Her car appears on every map.");
    spot(null);
  } },
  { id: 'dispatch', run: async ({ desk }) => {
    cap('Agents act in milliseconds; the human officer decides → only then does the unit drive to her');
    await sleep(800);
    await desk.click('button[data-k=dispatch]');
    await say('narrator', 'The officer decides. Only then does the unit move, and everyone watches it drive to her.');
    await sleep(1500);
  } },
  { id: 'status', run: async ({ trav }) => {
    cap('Alexa only says what is true: who has seen it, who is coming, and when');
    await scrollPanel(trav, '#sayForm');
    await talk(trav, 'Alexa, did anyone see it?', 'Did anyone see it?');
    await sleep(800);
  } },
  { id: 'stop', run: async ({ trav }) => {
    cap('Machine-first: the fuel station runs its own AI agent → asked agent-to-agent, signed, in ms. No phone rings');
    await scrollPanel(trav, '#stops');
    await talk(trav, 'Alexa, is the Indian Oil ahead open?', 'Is the Indian Oil ahead open?');
    await scrollPanel(trav, '#stops');
    await say('narrator', 'The station runs its own agent, so SafeStop asks it agent to agent, in milliseconds. No phone rings.');
  } },
  { id: 'safe', run: async ({ trav }) => {
    cap('Closing takes two requests → a private, tamper-evident report only she can open');
    await scrollPanel(trav, '#hero');
    await talk(trav, "Alexa, I'm safe now.", "I'm safe now");
    await say('priya', "Yes, I'm safe.");
    await ask(trav, "Yes, I'm safe");
    await trav.waitForFunction(() => !!document.querySelector('a[href^="/report"]'), null, { timeout: 15000 });
    await trav.evaluate(() => (location.href = (document.querySelector('a[href^="/report"]') as HTMLAnchorElement).href));
    await say('narrator', 'Closing takes two requests. Then a private, tamper evident report. The model only labels her words; rules decide every action.');
  } },
  { id: 'outro', run: async () => {
    close(caps);
    await say('narrator', 'SafeStop rings a human, not a database. The desk, station and drive are simulated. The protocols are real.');
    await sleep(800);
  } },
];

const FONT = "C\\:/Windows/Fonts/segoeui.ttf", BOLD = "C\\:/Windows/Fonts/segoeuib.ttf";
const VID = join(OUT, 'raw');
const MARKS = join(OUT, 'marks.json');

if (!process.argv.includes('--splice')) {
  // ---------- record the real app ----------
  const profile = JSON.parse(readFileSync('data/profile.json', 'utf8'));
  const meena = profile.contacts.find((c: any) => c.name === 'Meena');
  rmSync(VID, { recursive: true, force: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
  const mk = async (name: string, w: number, h: number) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, recordVideo: { dir: join(VID, name), size: { width: w, height: h } }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    return { ctx, page, started: Date.now() };
  };
  const D = await mk('desk', 960, 765);
  await D.page.goto(DESK);
  // Let the recorder read the desk's own brief for a case (the page keeps cases in a closure).
  await D.page.evaluate(() => { const es = new EventSource('/desk/events'); const m = new Map(); (window as any).__cases = m; es.onmessage = (e) => { const c = JSON.parse(e.data); m.set(c.alert.identifier, c); }; });
  const C = await mk('cont', 960, 765);
  C.page.on('dialog', (d) => d.accept('20'));
  await C.page.goto(`${BASE}/contact/${meena.token}`);
  await C.page.click('#arm').catch(() => {});
  const T = await mk('trav', 1280, 1080);
  await T.page.goto(`${BASE}/traveller#${profile.travellerKey}`);
  // The settings sit in a closed <details>: set them the way the page's own change handler expects.
  await T.page.evaluate(() => {
    (document.getElementById('speak') as HTMLInputElement).checked = false; // Alexa's voice is added in the edit
    const sel = document.getElementById('locMode') as HTMLSelectElement;
    sel.value = 'drive';
    sel.dispatchEvent(new Event('change'));
  });
  await sleep(5000); // tiles load, the car starts moving
  const pages: Pages = { trav: T.page, cont: C.page, desk: D.page };

  go = Date.now();
  const marks: { id: string; at: number; len: number }[] = [];
  for (const s of SCENES) {
    const at = now();
    try { await s.run(pages); } catch (e) { console.log(`scene ${s.id}: ${(e as Error).message.split('\n')[0]}`); }
    marks.push({ id: s.id, at, len: now() - at });
    console.log(`scene ${s.id} at ${at.toFixed(1)}s (${(now() - at).toFixed(1)}s)`);
  }
  close(caps); close(spots);
  const total = now();
  const closedAt: Record<string, number> = {};
  for (const [n, x] of [['trav', T], ['cont', C], ['desk', D]] as const) { closedAt[n] = Date.now(); await x.ctx.close(); }
  await browser.close();
  const videoOf = (name: string) => { const dir = join(VID, name); const f = readdirSync(dir).find((n) => n.endsWith('.webm'))!; const to = join(VID, `${name}.webm`); renameSync(join(dir, f), to); return to; };
  // Sync each pane from its real video length: a recording ends when its context closed.
  const durOf = (f: string) => {
    const log = spawnSync('ffmpeg', ['-i', f, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const m = [...log.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop()!;
    return +m[1] * 3600 + +m[2] * 60 + +m[3];
  };
  const files = { trav: videoOf('trav'), cont: videoOf('cont'), desk: videoOf('desk') };
  const offs: Record<string, number> = {};
  for (const [n, f] of Object.entries(files)) offs[n] = Math.max(0, durOf(f) - (closedAt[n] - go) / 1000);
  console.log('pane offsets', offs, 'naive', { trav: (go - T.started) / 1000, cont: (go - C.started) / 1000, desk: (go - D.started) / 1000 });
  const off = (x: { started: number }) => (x === T ? offs.trav : x === C ? offs.cont : offs.desk);

  // ---------- composite ----------
  const wrap = (t: string, n: number) => {
    const out: string[] = [];
    let line = '';
    for (const w of t.split(' ')) {
      if ((line + ' ' + w).trim().length > n) { out.push(line.trim()); line = w; } else line += ' ' + w;
    }
    out.push(line.trim());
    return out;
  };
  let nf = 0;
  const tf = (text: string) => { const f = join(VO, `t${nf++}.txt`); writeFileSync(f, text); return f.replace(/\\/g, '/').replace(':', '\\:'); };
  const en = (a: number, b: number) => `enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`;
  const vf: string[] = [];
  vf.push(`color=c=0x05080C:s=1920x1080:r=30:d=${total.toFixed(2)}[bg]`);
  vf.push(`[0:v]trim=start=${off(T).toFixed(2)},setpts=PTS-STARTPTS,fps=30[t]`);
  vf.push(`[1:v]trim=start=${off(C).toFixed(2)},setpts=PTS-STARTPTS,fps=30,split[c0][c1]`, `[c0]scale=640:510[c]`, `[c1]scale=1280:1020[cb]`);
  vf.push(`[2:v]trim=start=${off(D).toFixed(2)},setpts=PTS-STARTPTS,fps=30,split[d0][d1]`, `[d0]scale=640:510[d]`, `[d1]scale=1280:1020[db]`);
  let chain = `[bg][t]overlay=0:0:shortest=1[a1];[a1][c]overlay=1280:30[a2];[a2][d]overlay=1280:570[a3]`;
  // Close-ups: the desk or Meena's phone fills the big pane while it is the subject.
  let k = 3;
  for (const s of spots) {
    chain += `;[a${k}][${s.pane === 'desk' ? 'db' : 'cb'}]overlay=0:60:${en(s.at, s.end)}[a${k + 1}]`;
    k++;
  }
  // overlay inputs can only be used once each: split per use
  const deskUses = spots.filter((s) => s.pane === 'desk').length, contUses = spots.filter((s) => s.pane === 'cont').length;
  if (deskUses > 1 || contUses > 1) throw new Error('one close-up per pane supported');
  if (!deskUses) vf.push('[db]nullsink'); if (!contUses) vf.push('[cb]nullsink');
  chain += `;[a${k}]`;
  const draws = [
    `drawtext=fontfile='${BOLD}':text='MEENA (trusted contact) · her phone':x=1292:y=6:fontsize=17:fontcolor=0x5BE38A`,
    `drawtext=fontfile='${BOLD}':text='HIGHWAY PATROL DESK · SIMULATED':x=1292:y=546:fontsize=17:fontcolor=0xFFC247`,
    `drawbox=x=1280:y=540:w=640:h=2:color=0x1F2A38:t=fill`,
  ];
  for (const s of spots) {
    const label = s.pane === 'desk' ? 'CLOSE-UP · HIGHWAY PATROL DESK (SIMULATED) · its scoped AI agent' : 'CLOSE-UP · MEENA’S PHONE (trusted contact)';
    draws.push(`drawbox=x=0:y=0:w=1280:h=60:color=0x05080C:t=fill:${en(s.at, s.end)}`, `drawtext=fontfile='${BOLD}':textfile='${tf(label)}':x=24:y=17:fontsize=24:fontcolor=${s.pane === 'desk' ? '0xFFC247' : '0x5BE38A'}:${en(s.at, s.end)}`);
  }
  for (const c of caps) {
    const lines = wrap(c.text!, 84);
    draws.push(`drawbox=x=0:y=984:w=1280:h=96:color=0x05080C@0.92:t=fill:${en(c.at, c.end)}`, `drawbox=x=0:y=984:w=1280:h=3:color=0x2FD3F5:t=fill:${en(c.at, c.end)}`);
    lines.forEach((line, i) => draws.push(`drawtext=fontfile='${FONT}':textfile='${tf(line)}':x=(1280-text_w)/2:y=${lines.length === 1 ? 1018 : 998 + i * 38}:fontsize=27:fontcolor=white:${en(c.at, c.end)}`));
  }
  const card = (m: { at: number; len: number }, title: string, sub: string, sub2: string) => [
    `drawbox=x=0:y=0:w=1920:h=1080:color=0x05080C@0.86:t=fill:${en(m.at, m.at + m.len)}`,
    `drawtext=fontfile='${BOLD}':textfile='${tf(title)}':x=(w-text_w)/2:y=400:fontsize=78:fontcolor=white:${en(m.at, m.at + m.len)}`,
    `drawtext=fontfile='${FONT}':textfile='${tf(sub)}':x=(w-text_w)/2:y=510:fontsize=34:fontcolor=0x2FD3F5:${en(m.at, m.at + m.len)}`,
    `drawtext=fontfile='${FONT}':textfile='${tf(sub2)}':x=(w-text_w)/2:y=580:fontsize=24:fontcolor=0x9AA6B6:${en(m.at, m.at + m.len)}`,
  ];
  const mk2 = (id: string) => marks.find((m) => m.id === id)!;
  draws.push(...card(mk2('intro'), 'SafeStop Relay Network', 'A quiet roadside SOS for Alexa+', 'Real MCP server (2025-11-25) · A2A agents · signed CAP 1.2 · CALL-E AI phone ladder'));
  draws.push(...card(mk2('outro'), 'SafeStop rings a human, not a database.', 'Patrol desk, station agent and drive are SIMULATED · the protocols are real', 'Voices: Amazon Polly · not an emergency service · in danger call 112'));
  chain += draws.join(',') + '[v]';
  vf.push(chain);
  clips.forEach((c, i) => vf.push(`[${3 + i}:a]adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[s${i}]`));
  vf.push(`${clips.map((_, i) => `[s${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,volume=1.5,apad[aud]`);
  const script = join(OUT, 'filter.txt');
  writeFileSync(script, vf.join(';\n'));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', files.trav, '-i', files.cont, '-i', files.desk, ...clips.flatMap((c) => ['-i', c.file]),
    '-filter_complex_script', script, '-map', '[v]', '-map', '[aud]', '-t', total.toFixed(2), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k', join(OUT, 'main.mp4')], { stdio: 'inherit' });
  writeFileSync(MARKS, JSON.stringify({ marks, total }, null, 2));
  console.log(`main take: demo/main.mp4 (${total.toFixed(1)} s)`);
}

// ---------- splice the real call (if recorded) after the ladder scene ----------
const { marks, total } = JSON.parse(readFileSync(MARKS, 'utf8')) as { marks: { id: string; at: number; len: number }[]; total: number };
const insert = join(OUT, 'stopcall-insert.mp4');
const final = join(OUT, 'safestop-demo.mp4');
if (existsSync(insert)) {
  const l = marks.find((m) => m.id === 'stop')!;
  const cut = (l.at + l.len).toFixed(2);
  const fc = `[0:v]split[ma][mb];[0:a]asplit[na][nb];[ma]trim=0:${cut},setpts=PTS-STARTPTS,setsar=1[v0];[na]atrim=0:${cut},asetpts=PTS-STARTPTS[a0];[1:v]setpts=PTS-STARTPTS,fps=30,format=yuv420p,setsar=1[v1];[1:a]aresample=48000,asetpts=PTS-STARTPTS[a1];[mb]trim=start=${cut},setpts=PTS-STARTPTS,setsar=1[v2];[nb]atrim=start=${cut},asetpts=PTS-STARTPTS[a2];[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', join(OUT, 'main.mp4'), '-i', insert, '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', final], { stdio: 'inherit' });
  console.log(`done: demo/safestop-demo.mp4 (main ${total.toFixed(1)} s + real call insert)`);
} else {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', join(OUT, 'main.mp4'), '-c', 'copy', final]);
  console.log(`done: demo/safestop-demo.mp4 (${total.toFixed(1)} s, no call insert yet)`);
}
