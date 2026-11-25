// Routing logic for Proper Roads. No DOM here, so it can be tested in Node.
(function (root) {
  const MINOR = new Set(["unclassified", "track", "service"]);
  // Where pins may go. Primary/secondary are usually single carriageway: ideal.
  // Trunk roads are often dual carriageway (Google may snap to the other side), motorways never.
  const MAJOR_RANK = { primary: 3, secondary: 3, trunk: 1.5, tertiary: 1 };

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

  // Small octagon (radius r metres) around a point, as GeoJSON coordinates.
  function octagon(lat, lng, r) {
    const k = Math.PI / 180, dLat = r / 111320, dLng = r / (111320 * Math.cos(lat * k)), ring = [];
    for (let i = 0; i <= 8; i++) { const a = (i % 8) * Math.PI / 4; ring.push([+(lng + dLng * Math.cos(a)).toFixed(6), +(lat + dLat * Math.sin(a)).toFixed(6)]); }
    return [ring];
  }

  function customModel(level, priority, avoids) {
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
    // Personal avoid list: never use minor roads inside these spots (main roads through them still allowed).
    if (avoids && avoids.length) {
      m.areas = { type: "FeatureCollection", features: avoids.map((a, i) => ({
        type: "Feature", id: "avoid" + i, properties: {}, geometry: { type: "Polygon", coordinates: octagon(a.lat, a.lng, 40) }
      })) };
      const inAny = "(" + avoids.map((_, i) => "in_avoid" + i).join(" || ") + ")";
      m.priority.push({ if: inAny + " && road_class != MOTORWAY && road_class != TRUNK && road_class != PRIMARY && road_class != SECONDARY", multiply_by: 0.01 });
    }
    return m;
  }

  function routeBody(from, to, level, priority, via, avoids) {
    const pts = [from].concat(via ? [via] : [], [to]);
    const body = {
      profile: "car",
      points: pts.map(p => [p.lng, p.lat]),
      points_encoded: false,
      instructions: false,
      locale: "en",
      details: ["road_class", "road_class_link"]
    };
    if (level != null) { body["ch.disable"] = true; body.custom_model = customModel(level, priority, avoids); }
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

  // Whether each point is on a slip road / link road.
  function linkPerPoint(path) {
    const n = path.points.coordinates.length, out = new Array(n).fill(false);
    for (const [a, b, v] of (path.details && path.details.road_class_link) || []) {
      if (v) for (let i = a; i < b && i < n; i++) out[i] = true;
    }
    return out;
  }

  // Bearing in degrees from a to b.
  function bearing(a, b) {
    const k = Math.PI / 180, y = Math.sin((b[0] - a[0]) * k) * Math.cos(b[1] * k);
    const x = Math.cos(a[1] * k) * Math.sin(b[1] * k) - Math.sin(a[1] * k) * Math.cos(b[1] * k) * Math.cos((b[0] - a[0]) * k);
    return (Math.atan2(y, x) / k + 360) % 360;
  }

  // Flag resampled points that are bad places for a pin: slip roads, near a junction
  // (road class changes), or near a bend/roundabout. Google tends to loop at those.
  function markUnsafe(S, links, coordsLen, keep) {
    const turn = new Array(S.length).fill(0);
    for (let i = 1; i < S.length - 1; i++) {
      let d = Math.abs(bearing(S[i - 1].p, S[i].p) - bearing(S[i].p, S[i + 1].p));
      turn[i] = d > 180 ? 360 - d : d;
    }
    S.forEach((s, i) => {
      let bad = !!(links && links[s.idx]);
      for (let j = Math.max(0, i - keep); j <= Math.min(S.length - 1, i + keep) && !bad; j++) {
        if (S[j].c !== s.c) bad = true;                 // junction with a different class of road nearby
        if (turn[j] > 30) bad = true;                   // sharp bend or roundabout nearby
        if (links && links[S[j].idx]) bad = true;       // slip road nearby
      }
      s.bad = bad;
    });
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
    const out = [{ p: coords[0], c: cls[0], at: 0, idx: 0 }];
    let run = 0, at = 0;
    for (let i = 1; i < coords.length; i++) {
      const d = dist(coords[i - 1], coords[i]);
      run += d; at += d;
      if (run >= step || i === coords.length - 1) { out.push({ p: coords[i], c: cls[i - 1], at, idx: i - 1 }); run = 0; }
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
  // `others` is the usual route plus the other options: anywhere the chosen route
  // splits from any of them is a place Google could wander off, so pin it there.
  function pickWaypoints(prPath, others, max, opts) {
    const o = Object.assign({ threshold: 250, step: 150, avoidAt: [] }, opts || {});
    const nearAvoid = at => o.avoidAt.some(a => Math.abs(a - at) < 1500);
    const list = (Array.isArray(others) ? others : [others]).filter(Boolean);
    const prS = resample(prPath.points.coordinates, classPerPoint(prPath), o.step);
    markUnsafe(prS, linkPerPoint(prPath), prPath.points.coordinates.length, 2); // ±300 m clear
    const lines = list.map(p => resample(p.points.coordinates, classPerPoint(p), 50).map(s => s.p));
    const total = prS[prS.length - 1].at;
    prS.forEach(s => { s.d = lines.length ? Math.max(...lines.map(l => distToLine(s.p, l))) : 0; });

    const runs = [];
    let cur = null;
    prS.forEach((s, i) => {
      const edge = s.at < 300 || total - s.at < 300 || nearAvoid(s.at); // never pin right by the ends or a stop
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
      // best-ranked, junction-free spot on a main road near the middle of this stretch
      let best = null, bestScore = -Infinity;
      for (const s of run) {
        const rank = MAJOR_RANK[s.c] || 0;
        const score = (s.bad ? -5000 : 0) + rank * 1000 - Math.abs(s.at - mid) / 10;
        if (score > bestScore) { bestScore = score; best = s; }
      }
      return { point: best || centre, score: peak.d * run.length };
    });

    let chosen = picks.sort((a, b) => b.score - a.score).slice(0, max).map(x => x.point);

    // Google's own route isn't our "usual" one, so always pin the chosen route:
    // fill any spare slots with evenly spaced points on main roads, away from existing pins.
    const spare = max - chosen.length;
    if (spare > 0 && total > 3000) {
      const n = Math.min(spare, Math.max(1, Math.floor(total / 8000)));
      for (let k = 1; k <= n; k++) {
        const target = total * k / (n + 1);
        let best = null, bestScore = -Infinity;
        for (const s of prS) {
          if (s.at < 500 || total - s.at < 500 || nearAvoid(s.at)) continue;
          if (chosen.some(c => Math.abs(c.at - s.at) < Math.min(4000, total / (max * 2)))) continue;
          const score = (s.bad ? -5000 : 0) + (MAJOR_RANK[s.c] || 0) * 1000 - Math.abs(s.at - target) / 5;
          if (score > bestScore) { bestScore = score; best = s; }
        }
        if (best) chosen.push(best);
      }
    }
    return chosen.sort((a, b) => a.at - b.at)
      .map(s => ({ lat: s.p[1], lng: s.p[0], roadClass: s.c, at: s.at }));
  }

  // How far along a route (metres) the point nearest to `pt` is.
  function alongRoute(path, pt) {
    const S = resample(path.points.coordinates, classPerPoint(path), 50);
    let best = S[0], bd = Infinity;
    for (const s of S) { const d = dist(s.p, [pt.lng, pt.lat]); if (d < bd) { bd = d; best = s; } }
    return best.at;
  }

  // Points (e.g. chargers) within `maxM` metres of a route, with how far along it they sit.
  function nearRoute(path, items, maxM) {
    const S = resample(path.points.coordinates, classPerPoint(path), 300);
    const line = S.map(s => s.p);
    return items.map(it => {
      const p = [it.lng, it.lat];
      let at = 0, bd = Infinity;
      for (const s of S) { const d = dist(s.p, p); if (d < bd) { bd = d; at = s.at; } }
      return Object.assign({}, it, { off: distToLine(p, line), at });
    }).filter(it => it.off <= maxM).sort((a, b) => a.at - b.at);
  }

  // Ask the server for up to 3 genuinely different routes.
  const ALTERNATIVES = {
    algorithm: "alternative_route",
    "alternative_route.max_paths": 3,
    "alternative_route.max_weight_factor": 1.4,
    "alternative_route.max_share_factor": 0.6,
    "lm.disable": true
  };

  // Order options by what the person asked for: quickest by time, shortest by distance,
  // balanced by a blend. Lane miles count against every option.
  function rankOptions(paths, priority) {
    const score = p => {
      const lanes = laneStats(p).laneMetres;
      const t = p.time / 1000, d = p.distance;
      const base = priority === 2 ? d / 13.4 : priority === 1 ? (t + d / 13.4) / 2 : t; // 13.4 m/s ≈ 30mph
      return base + lanes / 5;
    };
    return paths.slice().sort((a, b) => score(a) - score(b));
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

  const api = { TOLERANCE, PRIORITY, ALTERNATIVES, rankOptions, markUnsafe, linkPerPoint, alongRoute, nearRoute, customModel, routeBody, dist, laneStats, classPerPoint, pickWaypoints, googleMapsUrl, fmtTime, fmtMiles };
  if (typeof module !== "undefined") module.exports = api; else root.ProperRoads = api;
})(this);
