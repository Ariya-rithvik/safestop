// Quick check: an SOS makes the pre-brief agent ask nearby stop agents before anyone looks. Closes the alert after.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync('data/profile.json', 'utf8'));
const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage({ viewport: { width: 1280, height: 1000 } });
await pg.goto(`http://localhost:8790/traveller#${p.travellerKey}`);
await pg.evaluate(() => { const s = document.getElementById('locMode'); s.value = 'sim:12.9165,79.1325'; s.dispatchEvent(new Event('change')); (document.getElementById('speak')).checked = false; });
await pg.waitForTimeout(2500);
const ask = async (text) => { await pg.fill('#sayText', text); await pg.click('#sayForm button.primary'); await pg.waitForTimeout(1500); };
await ask('pineapple');
await pg.waitForTimeout(3000);
await pg.evaluate(() => document.querySelector('#prebrief')?.scrollIntoView({ block: 'center' }));
console.log('PREBRIEF:', (await pg.textContent('#prebrief'))?.replace(/\s+/g, ' '));
await pg.screenshot({ path: 'demo/prebrief-check.png' });
await ask("I'm safe now");
await ask("Yes, I'm safe");
await b.close();
