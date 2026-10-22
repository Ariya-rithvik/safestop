import { existsSync, readFileSync, writeFileSync } from 'node:fs';
// Safe places nearby from OpenStreetMap (Overpass API; data (c) OpenStreetMap contributors, ODbL).
// Everything is labelled unverified: OSM can be out of date and a place may be closed at night.
import { distanceM } from './incident.js';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const PLACE_KINDS = { police: 'Police', hospital: 'Hospital', fuel: 'Fuel station', toll_booth: 'Toll plaza' } as const;
export type PlaceKind = keyof typeof PLACE_KINDS;

export interface Place { kind: PlaceKind; label: string; name: string; lat: number; lon: number; distanceM: number; open24h: boolean | null; source: 'OpenStreetMap'; verified: false; /** When this OSM data was fetched (it may be a saved copy when Overpass is down). */ asOf?: number }

export function overpassQuery(lat: number, lon: number, radiusM = 8000): string {
  const a = `(around:${radiusM},${lat.toFixed(5)},${lon.toFixed(5)})`;
  return `[out:json][timeout:15];(nwr["amenity"="police"]${a};nwr["amenity"="hospital"]${a};nwr["amenity"="fuel"]${a};nwr["barrier"="toll_booth"]${a};);out center 60;`;
}

/** Places from an Overpass JSON answer, nearest first, at most `max` per kind (pure; tested). */
export function parseOverpass(json: unknown, from: { lat: number; lon: number }, max = 3): Place[] {
  const els = (json as { elements?: unknown[] })?.elements;
  if (!Array.isArray(els)) return [];
  const out: Place[] = [];
  for (const e of els as { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[]) {
    const tags = e.tags ?? {};
    const kind: PlaceKind | null = tags.amenity === 'police' ? 'police' : tags.amenity === 'hospital' ? 'hospital' : tags.amenity === 'fuel' ? 'fuel' : tags.barrier === 'toll_booth' ? 'toll_booth' : null;
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (!kind || typeof lat !== 'number' || typeof lon !== 'number') continue;
    const hours = tags.opening_hours;
    out.push({
      kind, label: PLACE_KINDS[kind], name: (tags.name ?? tags['name:en'] ?? PLACE_KINDS[kind]).slice(0, 80), lat, lon,
      distanceM: distanceM(from, { lat, lon }), open24h: hours ? hours.trim() === '24/7' : null, source: 'OpenStreetMap', verified: false,
    });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  const per = new Map<PlaceKind, number>();
  return out.filter((p) => {
    const n = per.get(p.kind) ?? 0;
    per.set(p.kind, n + 1);
    return n < max;
  });
}

/**
 * Live lookup. Answers are kept on disk; when Overpass is down (it often is), the last answer for the
 * same area is used and carries its `asOf` time so the user is told how old it is. null = nothing at all.
 */
export function placesLookup(fetchJson: (url: string, body: string) => Promise<unknown> = defaultFetch, cacheFile?: string, now: () => number = Date.now) {
  type Entry = { at: number; places: Place[] };
  const mem = new Map<string, Entry>();
  if (cacheFile && existsSync(cacheFile)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, Entry>)) mem.set(k, v);
    } catch {
      /* unreadable cache: start empty */
    }
  }
  const save = () => {
    if (!cacheFile) return;
    try {
      writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(mem)));
    } catch {
      /* best effort */
    }
  };
  const near = (lat: number, lon: number, e: Entry) => e.places.map((p) => ({ ...p, asOf: e.at, distanceM: distanceM({ lat, lon }, p) })).sort((a, b) => a.distanceM - b.distanceM);
  return async (lat: number, lon: number): Promise<Place[] | null> => {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = mem.get(key);
    if (hit && now() - hit.at < 30 * 60_000) return near(lat, lon, hit);
    try {
      const places = parseOverpass(await fetchJson(OVERPASS_URL, 'data=' + encodeURIComponent(overpassQuery(lat, lon))), { lat, lon });
      const e = { at: now(), places };
      mem.set(key, e);
      save();
      return near(lat, lon, e);
    } catch {
      return hit && now() - hit.at < 14 * 86_400_000 ? near(lat, lon, hit) : null;
    }
  };
}

async function defaultFetch(url: string, body: string): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      method: 'POST', body, signal: ctl.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'SafeStopRelay/0.1 (hackathon demo)' },
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
