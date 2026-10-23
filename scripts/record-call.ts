// Records a REAL CALL-E escalation call for the demo (SafeStop must run WITHOUT DRY_RUN, with a valid key and
// the contact's number on CALL_ALLOWED_NUMBERS). Nobody taps "I'm on it", so after 30 s the ladder phones Ravi.
// Answer and say e.g. "Yes, I'm coming, about 20 minutes". Waiting time is fast-forwarded (and labelled).
// Output: demo/call-insert.mp4 (1920x1080), spliced into the main video by scripts/record-demo.ts --splice.
//   npx tsx scripts/record-call.ts
import { chromium, type Page } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.SAFESTOP_URL ?? 'http://localhost:8790';
const OUT = join(process.cwd(), 'demo');
const VO = join(OUT, 'vo');
const VID = join(OUT, 'raw-call');
mkdirSync(VO, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VOICES = { narrator: ['Matthew', 'en-US'], priya: ['Kajal', 'en-IN'] } as const;
const synth = (who: keyof typeof VOICES, text: string) => {
  const [voice, lang] = VOICES[who];
  const file = join(VO, `${who}-${createHash('sha1').update(voice + text).digest('hex').slice(0, 12)}.mp3`);
  if (!existsSync(file)) execFileSync('aws', ['polly', 'synthesize-speech', '--region', 'us-east-1', '--engine', 'neural', '--voice-id', voice, '--language-code', lang, '--output-format', 'mp3', '--text', text, file]);
  return { file, dur: Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim()) };
};

const profile = JSON.parse(readFileSync('data/profile.json', 'utf8'));
rmSync(VID, { recursive: true, force: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: VID, size: { width: 1920, height: 1080 } }, colorScheme: 'dark' });
const p: Page = await ctx.newPage();
const started = Date.now();
await p.goto(`${BASE}/traveller#${profile.travellerKey}`);
await p.evaluate(() => {
  (document.getElementById('speak') as HTMLInputElement).checked = false;
  const sel = document.getElementById('locMode') as HTMLSelectElement;
  sel.value = 'sim:12.9165,79.1325';
  sel.dispatchEvent(new Event('change'));
});
await sleep(4000);
const go = Date.now();
const t = () => (Date.now() - go) / 1000;
const clips: { file: string; at: number }[] = [];
const say = async (who: keyof typeof VOICES, text: string) => { const s = synth(who, text); clips.push({ file: s.file, at: t() }); await sleep(s.dur * 1000 + 300); };

const STOP = process.argv.includes('--stop');
const chain = () => p.textContent(STOP ? '#stops' : '#chain').then((x) => x ?? '');
let sosAt: number, callAt: number, doneAt: number, yes: boolean, result: string;
if (STOP) {
  // A REAL CALL-E AI call that CALL-E allows: one question to a stop, answer shared with every traveller.
  await p.evaluate(() => document.querySelector('#stops')?.scrollIntoView({ block: 'start' }));
  await say('narrator', 'Now a real A I phone call. This station has no agent of its own, so SafeStop phones it once, through CALL E, and shares the answer with every traveller.');
  sosAt = t();
  const btn = p.locator('.stopcard').filter({ hasNotText: 'Indian Oil' }).first().locator('[data-q=open_now]');
  await btn.click();
  await p.waitForSelector('#dlgYes', { timeout: 15000 });
  await sleep(4500); // let viewers read the one-question script
  await p.click('#dlgYes');
  await p.waitForFunction(() => /Calling now/.test(document.querySelector('#stops')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  callAt = t();
  console.log(`calling at ${callAt.toFixed(1)} s — answer the phone as the station`);
  await p.waitForFunction(() => /by phone/.test(document.querySelector('#stops')?.textContent ?? ''), null, { timeout: 330000 }).catch(() => {});
  doneAt = t();
  result = await chain();
  yes = /by phone/.test(result);
  await p.evaluate(() => document.querySelector('#stops')?.scrollIntoView({ block: 'start' }));
  await sleep(2500);
  await say('narrator', yes ? 'The station answered a real call. Its exact words and the time are saved, and the next traveller who asks gets this answer without another call.' : 'The call did not get an answer, and SafeStop says so plainly.');
} else {
  await say('narrator', 'This call is real. Same alert, and this time nobody taps.');
  await say('priya', 'Alexa, pineapple.');
  await p.fill('#sayText', 'pineapple');
  await p.click('#sayForm button.primary');
  sosAt = t();
  await sleep(4000);
  await p.evaluate(() => document.querySelector('#incident')?.scrollIntoView({ block: 'start' }));
  await p.waitForFunction(() => /Phoning now|Call failed|dry run/.test(document.querySelector('#chain')?.textContent ?? ''), null, { timeout: 60000 });
  callAt = t();
  if (/dry run/.test(await chain())) throw new Error('SafeStop is in DRY_RUN mode: restart it without DRY_RUN for a real call');
  console.log(`calling at ${callAt.toFixed(1)} s — answer the phone`);
  await p.waitForFunction(() => /Said yes|didn.t say yes|Didn.t answer|Call failed/.test(document.querySelector('#chain')?.textContent ?? ''), null, { timeout: 330000 });
  doneAt = t();
  result = await chain();
  await sleep(2500);
  yes = /Said yes/.test(result);
  await say('narrator', yes ? "Ravi said yes on the phone, and his answer became a plan Priya can see. The ladder stops at the first yes." : 'The call did not get a yes, so SafeStop says so plainly and moves down the ladder.');
}
console.log(`call result at ${doneAt.toFixed(1)} s: ${result.replace(/\s+/g, ' ').slice(0, 200)}`);
await sleep(1500);
const end = t();
await ctx.close();
await browser.close();
// tidy up: close the test alert (two requests, as the policy requires)
if (!STOP) for (const text of ["I'm safe now", "Yes, I'm safe"]) await fetch(`${BASE}/api/assistant`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-traveller-key': profile.travellerKey }, body: JSON.stringify({ text }) }).catch(() => {});

// ---------- edit: fast-forward the waits ----------
const off = (go - started) / 1000;
const raw = join(VID, readdirSync(VID).find((n) => n.endsWith('.webm'))!);
type Seg = { a: number; b: number; speed: number; label?: string };
const segs: Seg[] = [
  { a: 0, b: sosAt + 3, speed: 1 },
  { a: sosAt + 3, b: callAt - 1, speed: STOP ? 1 : 6, label: STOP ? undefined : '▶▶ 6× · waiting 30 s for anyone to tap “I’m on it”' },
  { a: callAt - 1, b: callAt + 4, speed: 1 },
  { a: callAt + 4, b: doneAt - 2, speed: Math.max(1, (doneAt - 2 - (callAt + 4)) / 10), label: STOP ? '▶▶ fast-forward · REAL phone call in progress (CALL-E AI agent ↔ the station)' : '▶▶ fast-forward · REAL phone call in progress (CALL-E AI agent ↔ Ravi)' },
  { a: doneAt - 2, b: end, speed: 1 },
].filter((s) => s.b > s.a + 0.2);
const outAt = (x: number) => { let o = 0; for (const s of segs) { if (x >= s.b) o += (s.b - s.a) / s.speed; else { if (x > s.a) o += (x - s.a) / s.speed; break; } } return o; };
const FONT = "C\\:/Windows/Fonts/segoeui.ttf", BOLD = "C\\:/Windows/Fonts/segoeuib.ttf";
let nf = 0;
const tf = (text: string) => { const f = join(VO, `c${nf++}.txt`); writeFileSync(f, text); return f.replace(/\\/g, '/').replace(':', '\\:'); };
const vf: string[] = [];
segs.forEach((s, i) => vf.push(`[0:v]trim=start=${(off + s.a).toFixed(2)}:end=${(off + s.b).toFixed(2)},setpts=(PTS-STARTPTS)/${s.speed.toFixed(3)},fps=30[g${i}]`));
const total = outAt(end);
let chainV = `${segs.map((_, i) => `[g${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[cv];[cv]`;
const draws = [
  `drawbox=x=0:y=0:w=1920:h=64:color=0x2A0A0A:t=fill`,
  `drawtext=fontfile='${BOLD}':textfile='${tf(STOP ? 'REAL CALL · CALL-E Developer API → our test phone, answering as the station (demo registration) · number hidden' : 'REAL CALL · CALL-E Developer API → our consenting test phone (number hidden) · contact “Ravi” is played by us')}':x=(w-text_w)/2:y=18:fontsize=26:fontcolor=0xFF8B7B`,
];
for (const s of segs) if (s.label) {
  const a = outAt(s.a), b = outAt(s.b);
  draws.push(`drawbox=x=0:y=984:w=1920:h=96:color=0x05080C@0.92:t=fill:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`, `drawtext=fontfile='${FONT}':textfile='${tf(s.label)}':x=(w-text_w)/2:y=1014:fontsize=30:fontcolor=0xFFC247:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`);
}
chainV += draws.join(',') + '[v]';
vf.push(chainV);
clips.forEach((c, i) => { const ms = Math.round(outAt(c.at) * 1000); vf.push(`[${1 + i}:a]adelay=${ms}|${ms}[s${i}]`); });
vf.push(`${clips.map((_, i) => `[s${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,volume=1.5,apad[aud]`);
writeFileSync(join(OUT, 'filter-call.txt'), vf.join(';\n'));
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, ...clips.flatMap((c) => ['-i', c.file]), '-filter_complex_script', join(OUT, 'filter-call.txt'), '-map', '[v]', '-map', '[aud]', '-t', total.toFixed(2),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k', join(OUT, STOP ? 'stopcall-insert.mp4' : 'call-insert.mp4')], { stdio: 'inherit' });
console.log(`done: demo/${STOP ? 'stopcall' : 'call'}-insert.mp4 (${total.toFixed(1)} s; call ${yes ? 'said yes' : 'no yes'})`);
