// Shared map helper (Leaflet + OpenStreetMap tiles). Loaded after leaflet.min.js.
// Every map shows the attribution OpenStreetMap requires.
(function () {
  const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  const dot = (color, size = 16, ring = '#fff') =>
    L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid ${ring};box-shadow:0 1px 4px rgba(0,0,0,.6)"></span>` });
  const pin = (color, label) =>
    L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<span style="display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:${color};color:#08111a;font:800 12px system-ui;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6)">${label}</span>` });

  const me = (alert) =>
    L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: `<span class="me-dot${alert ? ' alert' : ''}"><i></i></span>` });
  const stop = (color) =>
    L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<span class="stop-pin" style="--c:${color}"><svg viewBox="0 0 24 24"><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M5 11h10M15 8h2l2 2v7a1.5 1.5 0 0 1-3 0v-3h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` });
  const unit = (live) =>
    L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<span class="unit-pin${live ? ' live' : ''}"><svg viewBox="0 0 24 24"><path d="M3 16v-3l2-5h14l2 5v3M3 16h18M3 16v2h3v-2M18 16v2h3v-2M7 12h10M10 5h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` });

  // A car seen from above, rotated to its heading (degrees, 0 = north).
  const car = (color, heading = 0, glow = false) =>
    L.divIcon({ className: 'car-m', iconSize: [34, 34], iconAnchor: [17, 17], html: `<span class="car${glow ? ' glow' : ''}" style="--c:${color};transform:rotate(${Math.round(heading)}deg)"><svg viewBox="0 0 24 40" aria-hidden="true"><rect x="2" y="2" width="20" height="36" rx="7" fill="var(--c)" stroke="#fff" stroke-width="2"/><rect x="5" y="9" width="14" height="7" rx="2" fill="#0b1118" opacity=".85"/><rect x="5" y="27" width="14" height="5" rx="2" fill="#0b1118" opacity=".6"/><rect x="4" y="2.5" width="4" height="2.5" rx="1" fill="#fff8c8"/><rect x="16" y="2.5" width="4" height="2.5" rx="1" fill="#fff8c8"/></svg></span>` });
  const bearing = (a, b) => {
    const r = (d) => (d * Math.PI) / 180;
    const y = Math.sin(r(b[1] - a[1])) * Math.cos(r(b[0]));
    const x = Math.cos(r(a[0])) * Math.sin(r(b[0])) - Math.sin(r(a[0])) * Math.cos(r(b[0])) * Math.cos(r(b[1] - a[1]));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  };
  const km = (a, b) => {
    const r = (d) => (d * Math.PI) / 180;
    const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  };

  window.SSMap = {
    dot, pin, me, stop, unit, car, bearing, km,
    /** Cars that keep their marker between updates, so they glide and turn instead of jumping. */
    fleet(map) {
      const cars = new Map();
      let seen = new Set();
      return {
        set(key, ll, color, o = {}) {
          seen.add(key);
          let c = cars.get(key);
          if (!c) {
            c = { ll, heading: o.heading ?? 0, sig: '' };
            c.marker = L.marker(ll, { zIndexOffset: o.z ?? 500, keyboard: false }).addTo(map);
            cars.set(key, c);
          } else if (km(c.ll, ll) > 0.003) {
            c.heading = o.heading ?? bearing(c.ll, ll);
            c.marker.setLatLng(ll);
            c.ll = ll;
          }
          const sig = `${color}|${!!o.glow}`;
          if (sig !== c.sig) { c.sig = sig; c.marker.setIcon(car(color, c.heading, o.glow)); }
          const el = c.marker.getElement()?.querySelector('.car');
          if (el) el.style.transform = `rotate(${Math.round(c.heading)}deg)`;
          if (o.tip) {
            if (c.marker.getTooltip() && c.tipPermanent === !!o.permanent) c.marker.setTooltipContent(o.tip);
            else { c.marker.unbindTooltip(); c.marker.bindTooltip(o.tip, { permanent: !!o.permanent, direction: 'top', offset: [0, -14], className: 'tip' }); c.tipPermanent = !!o.permanent; }
          }
          return c.marker;
        },
        /** Remove cars not set since the last sweep. */
        sweep() {
          for (const [k, c] of cars) if (!seen.has(k)) { c.marker.remove(); cars.delete(k); }
          seen = new Set();
        },
        get: (key) => cars.get(key),
      };
    },
    /** Points along the route with cumulative distance (km), for simulated drives. */
    async routeTrack() {
      const pts = await this.routePoints();
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + km(pts[i - 1], pts[i]));
      const at = (d) => {
        d = Math.max(0, Math.min(cum[cum.length - 1], d));
        let i = 1;
        while (i < cum.length - 1 && cum[i] < d) i++;
        const f = cum[i] === cum[i - 1] ? 0 : (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
        const a = pts[i - 1], b = pts[i];
        return { ll: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearing(a, b) };
      };
      const nearest = (ll) => { let best = 0, bd = Infinity; for (let i = 0; i < pts.length; i++) { const d = km(pts[i], ll); if (d < bd) { bd = d; best = i; } } return cum[best]; };
      return { pts, length: cum[cum.length - 1], at, nearest };
    },
    async routePoints() {
      const r = await (await fetch('/api/route')).json();
      return (r.coordinates || []).map(([lon, lat]) => [lat, lon]);
    },
    async glowRoute(map) {
      try {
        const r = await (await fetch('/api/route')).json();
        if (!r.coordinates) return null;
        const pts = r.coordinates.map(([lon, lat]) => [lat, lon]);
        L.polyline(pts, { color: '#2FD3F5', weight: 12, opacity: 0.12, interactive: false }).addTo(map);
        return L.polyline(pts, { color: '#2FD3F5', weight: 3.5, opacity: 0.9 }).addTo(map).bindTooltip('Your road (OpenStreetMap route)');
      } catch {
        return null;
      }
    },
    create(el, center = [12.9165, 79.1325], zoom = 12) {
      const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(center, zoom);
      L.tileLayer(TILE, { maxZoom: 19, attribution: ATTR }).addTo(map);
      return map;
    },
    async route(map) {
      try {
        const r = await (await fetch('/api/route')).json();
        if (!r.coordinates) return null;
        return L.polyline(r.coordinates.map(([lon, lat]) => [lat, lon]), { color: '#2FD3F5', weight: 4, opacity: 0.7 }).addTo(map).bindTooltip('Your road (OpenStreetMap)');
      } catch {
        return null;
      }
    },
  };
})();
