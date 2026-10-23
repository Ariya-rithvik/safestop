// Records the demo video by driving the REAL running app (npm run patrol / stopagent / start must be up).
// Three browser windows are recorded at once (traveller, Meena's phone, patrol desk), narrated with
// Amazon Polly (Kajal), and composited with ffmpeg into demo/safestop-demo.mp4.
// Never shows the traveller key or contact tokens: they are only in the URLs, and video has no address bar.
//   npx tsx scripts/record-demo.ts
import { chromium, type Page } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.SAFESTOP_URL ?? 'http://localhost:8790';
const DESK = process.env.DESK_URL ?? 'http://localhost:8792/desk';
const OUT = join(process.cwd(), 'demo');
const VO = join(OUT, 'vo');
mkdirSync(VO, { recursive: true });

const profile = JSON.parse(readFileSync('data/profile.json', 'utf8'));
const meena = profile.contacts.find((c: any) => c.name === 'Meena');

type Scene = { id: string; say: string; cap: string; min?: number; act?: (p: Pages) => Promise<void> };
type Pages = { trav: Page; cont: Page; desk: Page };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alexa = async (p: Page, text: string) => {
  await p.fill('#sayText', text);
  await p.click('#sayForm button.primary');
};
const scrollPanel = (p: Page, sel: string) => p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), sel);

const SCENES: Scene[] = [
  { id: 'intro', min: 5, cap: 'SafeStop Relay Network', say: 'SafeStop Relay Network. A quiet roadside S O S, built for Alexa plus.' },
  { id: 'drive', min: 6, cap: '11 pm · NH48 · Priya is driving alone into Vellore (simulated drive on the real road)', say: 'Eleven p m, on N H 48. Priya is driving alone into Vellore, and a white car keeps following her.' },
  {
    id: 'sos', cap: 'She says a harmless safe word to Alexa → family screens alerted in milliseconds, before any AI runs',
    say: "She says a harmless safe word to Alexa. Pineapple. That is the S O S. Her family's screens have it in milliseconds, before any A I even runs.",
    act: async ({ trav, cont }) => {
      await alexa(trav, 'pineapple, a white Innova TN 09 AB 1234 is following me');
      await cont.waitForSelector('#alertBox:not(.hidden)', { timeout: 15000 });
    },
  },
  {
    id: 'patrol', cap: 'Agent-to-agent: signed CAP 1.2 alert over A2A → patrol desk agent verifies + prepares the nearest unit',
    say: "At the same moment, SafeStop's agent sends the highway patrol desk's agent a signed CAP alert, the format India's disaster authority uses. It is verified, and the nearest unit is prepared, in milliseconds.",
    act: async ({ trav, desk }) => {
      await desk.waitForSelector('button[data-k=dispatch]', { timeout: 15000 });
      await scrollPanel(trav, '#incident');
    },
  },
  {
    id: 'ladder', min: 12, cap: 'Nobody tapped yet → escalation agent phones Ravi through CALL-E, in his language (dry run in this video)',
    say: 'Nobody has tapped yet. So the escalation agent counts down, then phones her brother Ravi through CALL E, in his language. In this recording it is a dry run.',
    act: async ({ trav }) => {
      await trav.waitForFunction(() => /dry run|Phoning now|Said yes/.test(document.querySelector('#chain')?.textContent ?? ''), null, { timeout: 45000 });
    },
  },
  {
    id: 'meena', min: 12, cap: 'Meena taps “I’m on it” and answers with a plan → her car appears on every map',
    say: "Her sister Meena taps I'm on it, and answers with a plan. Priya now sees: Meena is coming to you, about twenty minutes. Meena's car appears on every map.",
    act: async ({ cont }) => {
      await cont.click('#ack');
      await cont.waitForSelector('#planBox:not(.hidden)');
      await sleep(1200);
      await cont.click('[data-plan=going_there]');
      await cont.waitForSelector('#shareBox:not(.hidden)');
      await sleep(800);
      await cont.check('#share');
    },
  },
  {
    id: 'dispatch', min: 16, cap: 'Agents act in milliseconds; the human officer decides. Only then does the unit drive to her',
    say: 'Agents act in milliseconds, but a human officer decides. Only after the officer clicks dispatch does the patrol unit move, and everyone watches it drive to her.',
    act: async ({ desk }) => {
      await sleep(1500);
      await desk.click('button[data-k=dispatch]');
    },
  },
  {
    id: 'stop', min: 9, cap: 'Machine-first: the fuel station has its own AI agent → asked agent-to-agent, signed, in ms. No phone rings',
    say: "When the other side is also an A I, SafeStop skips human language. It asks the fuel station's own agent, signed, in milliseconds. No phone rings.",
    act: async ({ trav }) => {
      await scrollPanel(trav, '#stops');
      await sleep(600);
      await alexa(trav, 'Is the Indian Oil ahead open?');
      await sleep(2500);
      await scrollPanel(trav, '#stops');
    },
  },
  {
    id: 'feed', min: 9, cap: 'Ten small agents, one incident record · the model only labels her words, rules decide · 10/10 injections blocked',
    say: 'Ten small agents share one incident record. The model only labels her words; rules decide every action. Ten out of ten injection attempts were blocked.',
    act: async ({ trav }) => { await scrollPanel(trav, '#timeline'); },
  },
  {
    id: 'safe', min: 10, cap: 'Closing takes two requests → a private, tamper-evident report only she can open',
    say: 'Closing an alert takes two requests. Then she gets a private, tamper evident report that only she can open.',
    act: async ({ trav }) => {
      await scrollPanel(trav, '#hero');
      await alexa(trav, "I'm safe now");
      await sleep(2500);
      await alexa(trav, "Yes, I'm safe");
      await trav.waitForFunction(() => !!document.querySelector('a[href^="/report"]'), null, { timeout: 15000 });
      await sleep(2500);
      await trav.evaluate(() => (location.href = (document.querySelector('a[href^="/report"]') as HTMLAnchorElement).href));
      await sleep(7000);
    },
  },
  { id: 'outro', min: 9, cap: 'SafeStop rings a human, not a database', say: 'SafeStop rings a human, not a database. The patrol desk, the station agent and the drive are simulated. The protocols are real.' },
];

// ---------- 1. voice-over (Amazon Polly, Kajal, en-IN) ----------
const ffprobe = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const dur: Record<string, number> = {};
for (const s of SCENES) {
  const f = join(VO, `${s.id}.mp3`), txt = join(VO, `${s.id}.txt`);
  if (!existsSync(f) || !existsSync(txt) || readFileSync(txt, 'utf8') !== s.say) {
    execFileSync('aws', ['polly', 'synthesize-speech', '--region', 'us-east-1', '--engine', 'neural', '--voice-id', 'Kajal', '--language-code', 'en-IN', '--output-format', 'mp3', '--text', s.say, f]);
    writeFileSync(txt, s.say);
  }
  dur[s.id] = ffprobe(f);
}
console.log('voice-over ready:', Object.entries(dur).map(([k, v]) => `${k} ${v.toFixed(1)}s`).join(', '));

// ---------- 2. record the real app ----------
const VID = join(OUT, 'raw');
rmSync(VID, { recursive: true, force: true });
const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const mk = async (name: string, w: number, h: number) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, recordVideo: { dir: join(VID, name), size: { width: w, height: h } }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  return { ctx, page, started: Date.now() };
};
const D = await mk('desk', 960, 765);
await D.page.goto(DESK);
const C = await mk('cont', 960, 765);
C.page.on('dialog', (d) => d.accept('20'));
await C.page.goto(`${BASE}/contact/${meena.token}`);
await C.page.click('#arm').catch(() => {});
const T = await mk('trav', 1280, 1080);
await T.page.goto(`${BASE}/traveller#${profile.travellerKey}`);
// The settings sit in a closed <details>: set them the way the page's own change handler expects.
await T.page.evaluate(() => {
  (document.getElementById('speak') as HTMLInputElement).checked = false;
  const sel = document.getElementById('locMode') as HTMLSelectElement;
  sel.value = 'drive';
  sel.dispatchEvent(new Event('change'));
});
await sleep(5000); // tiles load, the car starts moving
const pages: Pages = { trav: T.page, cont: C.page, desk: D.page };

const go = Date.now();
const marks: { id: string; at: number; len: number }[] = [];
for (const s of SCENES) {
  const at = (Date.now() - go) / 1000;
  const need = Math.max((dur[s.id] ?? 0) + 0.8, s.min ?? 0) * 1000;
  const t0 = Date.now();
  try { await s.act?.(pages); } catch (e) { console.log(`scene ${s.id}: ${(e as Error).message.split('\n')[0]}`); }
  const left = need - (Date.now() - t0);
  if (left > 0) await sleep(left);
  marks.push({ id: s.id, at, len: (Date.now() - go) / 1000 - at });
  console.log(`scene ${s.id} at ${at.toFixed(1)}s (${marks[marks.length - 1].len.toFixed(1)}s)`);
}
const total = (Date.now() - go) / 1000;
await T.page.screenshot({ path: join(OUT, 'last-traveller.png') });
await C.page.screenshot({ path: join(OUT, 'last-contact.png') });
await D.page.screenshot({ path: join(OUT, 'last-desk.png') });
for (const x of [T, C, D]) await x.ctx.close();
await browser.close();

const videoOf = (name: string) => { const dir = join(VID, name); const f = readdirSync(dir).find((n) => n.endsWith('.webm'))!; const to = join(VID, `${name}.webm`); renameSync(join(dir, f), to); return to; };
const off = (x: { started: number }) => Math.max(0, (go - x.started) / 1000);

// ---------- 3. composite ----------
const FONT = "C\\:/Windows/Fonts/segoeui.ttf", BOLD = "C\\:/Windows/Fonts/segoeuib.ttf";
const wrap = (t: string, n = 68) => {
  const out: string[] = [];
  let line = '';
  for (const w of t.split(' ')) {
    if ((line + ' ' + w).trim().length > n) { out.push(line.trim()); line = w; } else line += ' ' + w;
  }
  out.push(line.trim());
  return out.join('\n');
};
const capFile = (id: string, text: string) => { const f = join(VO, `${id}.cap`); writeFileSync(f, text); return f.replace(/\\/g, '/').replace(':', '\\:'); };
const vf: string[] = [];
vf.push(`color=c=0x05080C:s=1920x1080:r=30:d=${total.toFixed(2)}[bg]`);
vf.push(`[0:v]trim=start=${off(T).toFixed(2)},setpts=PTS-STARTPTS,fps=30[t]`);
vf.push(`[1:v]trim=start=${off(C).toFixed(2)},setpts=PTS-STARTPTS,fps=30,scale=640:510[c]`);
vf.push(`[2:v]trim=start=${off(D).toFixed(2)},setpts=PTS-STARTPTS,fps=30,scale=640:510[d]`);
let chain = `[bg][t]overlay=0:0:shortest=1[a1];[a1][c]overlay=1280:30[a2];[a2][d]overlay=1280:570[a3];[a3]`;
const draws = [
  `drawtext=fontfile='${BOLD}':text='MEENA (trusted contact) · her phone':x=1292:y=6:fontsize=17:fontcolor=0x5BE38A`,
  `drawtext=fontfile='${BOLD}':text='HIGHWAY PATROL DESK · SIMULATED':x=1292:y=546:fontsize=17:fontcolor=0xFFC247`,
  `drawbox=x=1280:y=540:w=640:h=2:color=0x1F2A38:t=fill`,
];
for (const m of marks) {
  const s = SCENES.find((x) => x.id === m.id)!;
  if (m.id === 'intro' || m.id === 'outro') continue;
  const en = `enable='between(t,${m.at.toFixed(2)},${(m.at + m.len).toFixed(2)})'`;
  // A caption strip across the bottom of the traveller view; one drawtext per line (no newline glyphs).
  draws.push(`drawbox=x=0:y=984:w=1280:h=96:color=0x05080C@0.9:t=fill:${en}`, `drawbox=x=0:y=984:w=1280:h=3:color=0x2FD3F5:t=fill:${en}`);
  wrap(s.cap, 84).split('\n').forEach((line, i, all) => {
    const y = all.length === 1 ? 1018 : 998 + i * 38;
    draws.push(`drawtext=fontfile='${FONT}':textfile='${capFile(`${m.id}${i}`, line)}':x=(1280-text_w)/2:y=${y}:fontsize=27:fontcolor=white:${en}`);
  });
}
const intro = marks.find((m) => m.id === 'intro')!, outro = marks.find((m) => m.id === 'outro')!;
const card = (k: string, m: { at: number; len: number }, title: string, sub: string, sub2: string) => {
  const en = `enable='between(t,${m.at.toFixed(2)},${(m.at + m.len).toFixed(2)})'`;
  return [
    `drawbox=x=0:y=0:w=1920:h=1080:color=0x05080C@0.86:t=fill:${en}`,
    `drawtext=fontfile='${BOLD}':textfile='${capFile(k + 't', title)}':x=(w-text_w)/2:y=400:fontsize=78:fontcolor=white:${en}`,
    `drawtext=fontfile='${FONT}':textfile='${capFile(k + 's', sub)}':x=(w-text_w)/2:y=510:fontsize=34:fontcolor=0x2FD3F5:${en}`,
    `drawtext=fontfile='${FONT}':textfile='${capFile(k + 's2', sub2)}':x=(w-text_w)/2:y=580:fontsize=24:fontcolor=0x9AA6B6:${en}`,
  ];
};
draws.push(...card('intro', intro, 'SafeStop Relay Network', 'A quiet roadside SOS for Alexa+', 'Real MCP server (2025-11-25) · A2A agents · signed CAP 1.2 · CALL-E phone ladder'));
draws.push(...card('outro', outro, 'SafeStop rings a human, not a database.', 'Patrol desk, station agent and drive are SIMULATED · the protocols are real', 'Not an emergency service · in danger call 112 · github.com/Ariya-rithvik/safestop'));
chain += draws.join(',') + '[v]';
vf.push(chain);
const audioIn = marks.map((m, i) => `[${3 + i}:a]adelay=${Math.round(m.at * 1000 + 300)}|${Math.round(m.at * 1000 + 300)}[v${i}]`);
vf.push(...audioIn, `${marks.map((_, i) => `[v${i}]`).join('')}amix=inputs=${marks.length}:normalize=0,apad[aud]`);
const script = join(OUT, 'filter.txt');
writeFileSync(script, vf.join(';\n'));
const args = ['-y', '-i', videoOf('trav'), '-i', videoOf('cont'), '-i', videoOf('desk'), ...marks.flatMap((m) => ['-i', join(VO, `${m.id}.mp3`)]),
  '-filter_complex_script', script, '-map', '[v]', '-map', '[aud]', '-t', total.toFixed(2), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', join(OUT, 'safestop-demo.mp4')];
execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
console.log(`done: demo/safestop-demo.mp4 (${total.toFixed(1)} s)`);
