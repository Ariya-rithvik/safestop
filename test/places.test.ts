import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { overpassQuery, parseOverpass, placesLookup } from '../src/places.js';

// A real Overpass answer for 8 km around NH48 near Vellore, saved 2026-10-19 (data (c) OpenStreetMap contributors, ODbL).
const real = JSON.parse(readFileSync(new URL('./overpass-vellore.json', import.meta.url), 'utf8'));
const from = { lat: 12.9165, lon: 79.1325 };

test('parses a real Overpass answer: nearest first, max 3 per kind, all labelled unverified', () => {
  const places = parseOverpass(real, from);
  assert.ok(places.length > 0);
  assert.ok(places.some((p) => p.kind === 'police'));
  for (let i = 1; i < places.length; i++) assert.ok(places[i - 1].distanceM <= places[i].distanceM);
  for (const k of ['police', 'hospital', 'fuel', 'toll_booth']) assert.ok(places.filter((p) => p.kind === k).length <= 3);
  assert.ok(places.every((p) => p.verified === false && p.source === 'OpenStreetMap'));
});

test('odd input gives an empty list; nodes, ways (center) and unknown tags handled', () => {
  assert.deepEqual(parseOverpass(null, from), []);
  const p = parseOverpass({ elements: [
    { type: 'way', center: { lat: 12.92, lon: 79.13 }, tags: { amenity: 'fuel', name: 'HP', opening_hours: '24/7' } },
    { type: 'node', lat: 12.9, lon: 79.1, tags: { shop: 'bakery' } },
    { type: 'node', tags: { amenity: 'police' } },
  ] }, from);
  assert.deepEqual(p.map((x) => [x.kind, x.name, x.open24h]), [['fuel', 'HP', true]]);
  assert.match(overpassQuery(12.9165, 79.1325), /around:8000,12\.91650,79\.13250/);
});

test('lookup returns null (not an empty list) when Overpass is unreachable', async () => {
  const look = placesLookup(async () => { throw new Error('offline'); });
  assert.equal(await look(12.9, 79.1), null);
});

test('when Overpass fails, the saved answer for the same area is used and says how old it is', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const cache = join(mkdtempSync(join(tmpdir(), 'pl-')), 'c.json');
  let t = 1_000_000;
  let up = true;
  const look = placesLookup(async () => { if (!up) throw new Error('down'); return real; }, cache, () => t);
  const first = await look(from.lat, from.lon);
  assert.equal(first![0].asOf, 1_000_000);
  up = false;
  t += 3 * 3_600_000;
  const again = placesLookup(async () => { throw new Error('down'); }, cache, () => t); // fresh process, same file
  const saved = await again(from.lat, from.lon);
  assert.ok(saved && saved.length === first!.length);
  assert.equal(saved![0].asOf, 1_000_000, 'carries its real age');
  t += 15 * 86_400_000;
  assert.equal(await again(from.lat, from.lon), null, 'too old: say we do not know');
});
