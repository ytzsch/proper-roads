// Routing logic for Proper Roads. No DOM here, so it can be tested in Node.
(function (root) {
  const MINOR = new Set(["unclassified", "track", "service"]);
  const MAJOR_RANK = { trunk: 3, primary: 3, secondary: 2, motorway: 1, tertiary: 1 };

  // Lane tolerance: 0 relaxed, 1 balanced, 2 strict.
  // speed: realistic lane speeds instead of the 60mph national limit (km/h).
  // priority: how much the router dislikes a road class (1 = no penalty).
  const TOLERANCE = [
    { name: "Relaxed", hint: "Lanes only when they save real time. Slows lanes to a realistic 30mph.",
      laneKmh: 48, unclassified: 0.5, minorOther: 0.2, tertiary: 1, narrow: 0.3 },
    { name: "Balanced", hint: "Avoids lanes unless the main-road route is much longer. Lanes treated as 25mph.",
      laneKmh: 40, unclassified: 0.2, minorOther: 0.05, tertiary: 0.9, narrow: 0.1 },
    { name: "Strict", hint: "Stays on A and B roads wherever possible, and avoids narrow C roads too.",
      laneKmh: 32, unclassified: 0.05, minorOther: 0.02, tertiary: 0.6, narrow: 0.02 }
  ];

  // Route priority: how much each extra km costs (seconds per km).
  // Quickest leaves GraphHopper's default; higher values favour shorter routes.
  const PRIORITY = [
    { name: "Quickest", hint: "The fastest journey on proper roads.", distance: null },
    { name: "Balanced", hint: "Cuts out long detours that only save a minute or two.", distance: 150 },
    { name: "Shortest", hint: "The most direct route on proper roads, even if it's a bit slower.", distance: 400 }
  ];

  function customModel(level, priority) {
    const t = TOLERANCE[level] || TOLERANCE[1];
    const d = (PRIORITY[priority] || PRIORITY[0]).distance;
    const m = {
      speed: [
        { if: "road_class == UNCLASSIFIED || road_class == TRACK || road_class == SERVICE", limit_to: t.laneKmh },
        { if: "road_class == TERTIARY", limit_to: t.laneKmh + 24 }
      ],
      priority: [
        { if: "road_class == UNCLASSIFIED", multiply_by: t.unclassified },
        { if: "road_class == TRACK || road_class == SERVICE", multiply_by: t.minorOther },
        { if: "road_class == TERTIARY", multiply_by: t.tertiary },
        { if: "max_width < 3.5", multiply_by: t.narrow }
      ]
    };
    if (d != null) m.distance_influence = d;
    return m;
  }

  function routeBody(from, to, level, priority) {
    const body = {
      profile: "car",
      points: [[from.lng, from.lat], [to.lng, to.lat]],
      points_encoded: false,
      instructions: false,
      locale: "en",
      details: ["road_class"]
    };
    if (level != null) { body["ch.disable"] = true; body.custom_model = customModel(level, priority); }
    return body;
  }

  // Metres between two [lng,lat] points (equirectangular, fine at road scale).
  function dist(a, b) {
    const R = 6371000, k = Math.PI / 180;
    const x = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k);
    const y = (b[1] - a[1]) * k;
    return Math.sqrt(x * x + y * y) * R;
  }

  // Distance from point p to segment ab, in metres.
  function distToSeg(p, a, b) {
    const k = Math.PI / 180, c = Math.cos(p[1] * k), R = 6371000;
    const ax = (a[0] - p[0]) * c * k * R, ay = (a[1] - p[1]) * k * R;
    const bx = (b[0] - p[0]) * c * k * R, by = (b[1] - p[1]) * k * R;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    let t = len ? -(ax * dx + ay * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    return Math.sqrt(x * x + y * y);
  }

  // Road class for every point index, from GraphHopper's details.
  function classPerPoint(path) {
    const n = path.points.coordinates.length, out = new Array(n).fill("other");
    for (const [a, b, v] of (path.details && path.details.road_class) || []) {
      for (let i = a; i < b && i < n; i++) out[i] = String(v).toLowerCase();
    }
    return out;
  }

  // Share of the route's distance spent on minor lanes.
  function laneStats(path) {
    const c = path.points.coordinates, cls = classPerPoint(path);
    let lanes = 0, total = 0;
    for (let i = 0; i < c.length - 1; i++) {
      const d = dist(c[i], c[i + 1]);
      total += d;
      if (MINOR.has(cls[i])) lanes += d;
    }
    return { laneMetres: lanes, totalMetres: total, laneShare: total ? lanes / total : 0 };
  }

  // Resample a line so points are roughly `step` metres apart, keeping road class.
  function resample(coords, cls, step) {
    const out = [{ p: coords[0], c: cls[0], at: 0 }];
    let run = 0, at = 0;
    for (let i = 1; i < coords.length; i++) {
      const d = dist(coords[i - 1], coords[i]);
      run += d; at += d;
      if (run >= step || i === coords.length - 1) { out.push({ p: coords[i], c: cls[i - 1], at }); run = 0; }
    }
    return out;
  }

  function distToLine(p, line) {
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
      const d = distToSeg(p, line[i], line[i + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  // Pick a few points on the proper route that stop Google cutting down lanes.
  // Look for stretches where the proper route leaves the usual one, and pin the
  // middle of each, preferring a spot on an A or B road.
  function pickWaypoints(prPath, stdPath, max, opts) {
    const o = Object.assign({ threshold: 250, step: 150 }, opts || {});
    const prS = resample(prPath.points.coordinates, classPerPoint(prPath), o.step);
    const stdLine = resample(stdPath.points.coordinates, classPerPoint(stdPath), 50).map(s => s.p);
    const total = prS[prS.length - 1].at;
    prS.forEach(s => { s.d = distToLine(s.p, stdLine); });

    const runs = [];
    let cur = null;
    prS.forEach((s, i) => {
      const edge = s.at < 500 || total - s.at < 500; // never pin right by the ends
      if (s.d > o.threshold && !edge) { (cur = cur || []).push(s); }
      else if (cur) { runs.push(cur); cur = null; }
      if (i === prS.length - 1 && cur) runs.push(cur);
    });

    // Long detours get split so each ~8 km stretch can have its own pin.
    const chunks = [];
    runs.forEach(run => {
      const len = run[run.length - 1].at - run[0].at;
      const n = Math.max(1, Math.ceil(len / 8000)), size = Math.ceil(run.length / n);
      for (let i = 0; i < run.length; i += size) chunks.push(run.slice(i, i + size));
    });

    const picks = chunks.map(run => {
      const peak = run.reduce((a, b) => (b.d > a.d ? b : a));
      const mid = (run[0].at + run[run.length - 1].at) / 2;
      const centre = run.reduce((a, b) => (Math.abs(b.at - mid) < Math.abs(a.at - mid) ? b : a));
      // best-ranked major road near the middle of this stretch
      let best = null, bestScore = -Infinity;
      for (const s of run) {
        const rank = MAJOR_RANK[s.c] || 0;
        if (!rank) continue;
        const score = rank * 1000 - Math.abs(s.at - mid) / 10;
        if (score > bestScore) { bestScore = score; best = s; }
      }
      return { point: best || centre, score: peak.d * run.length };
    });

    return picks.sort((a, b) => b.score - a.score).slice(0, max)
      .map(x => x.point).sort((a, b) => a.at - b.at)
      .map(s => ({ lat: s.p[1], lng: s.p[0], roadClass: s.c }));
  }

  const ll = p => p.lat.toFixed(6) + "," + p.lng.toFixed(6);

  function googleMapsUrl(from, to, waypoints) {
    let u = "https://www.google.com/maps/dir/?api=1&travelmode=driving" +
      "&origin=" + encodeURIComponent(ll(from)) + "&destination=" + encodeURIComponent(ll(to));
    if (waypoints && waypoints.length) u += "&waypoints=" + encodeURIComponent(waypoints.map(ll).join("|"));
    return u;
  }

  function fmtTime(ms) {
    const m = Math.round(ms / 60000);
    return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min";
  }
  const fmtMiles = metres => (metres / 1609.344).toFixed(1) + " miles";

  const api = { TOLERANCE, PRIORITY, customModel, routeBody, dist, laneStats, classPerPoint, pickWaypoints, googleMapsUrl, fmtTime, fmtMiles };
  if (typeof module !== "undefined") module.exports = api; else root.ProperRoads = api;
})(this);
