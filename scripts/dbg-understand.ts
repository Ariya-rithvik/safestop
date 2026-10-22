// Debug helper: shows the raw model answer and whether it passes the schema.
import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l); if (m) process.env[m[1]] = m[2]; }
const { llmChain, SYSTEM, ModelAnswer } = await import('../src/understand.js');
const llm = llmChain(process.env)!;
for (const t of process.argv.slice(2)) {
  try {
    const raw = await llm(SYSTEM, t);
    let issues = 'OK';
    try {
      const p = ModelAnswer.safeParse(JSON.parse(raw.replace(/^```(json)?|```$/g, '').trim()));
      if (!p.success) issues = JSON.stringify(p.error.issues.map((i) => `${i.path.join('.')}:${i.code}`));
    } catch (e) { issues = 'JSON: ' + (e as Error).message; }
    console.log(t.slice(0, 30), '=>', raw.slice(0, 220).replace(/\n/g, ' '), '|', issues);
  } catch (e) {
    console.log(t.slice(0, 30), 'ERR', (e as Error).message);
  }
}
