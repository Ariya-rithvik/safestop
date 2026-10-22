// Seeds data/places-cache.json from a real Overpass answer saved earlier (test/overpass-vellore.json),
// stamped with the time that file was captured, so the demo spot still shows real places when the
// public Overpass servers are down. Usage: npx tsx scripts/seed-places.ts
import { mkdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { parseOverpass } from '../src/places.js';
const file = 'test/overpass-vellore.json';
const at = statSync(file).mtimeMs;
const from = { lat: 12.9165, lon: 79.1325 };
mkdirSync('data', { recursive: true });
const cachePath = 'data/places-cache.json';
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
cache['12.92,79.13'] = { at, places: parseOverpass(JSON.parse(readFileSync(file, 'utf8')), from) };
writeFileSync(cachePath, JSON.stringify(cache));
console.log(`seeded ${cache['12.92,79.13'].places.length} places captured ${new Date(at).toISOString()}`);
