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

  window.SSMap = {
    dot, pin, me, stop, unit,
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
