{
  const PR = window.ProperRoads;
  // If the page and this script come from different versions (cached page), missing
  // elements get a detached stand-in instead of crashing the app.
  const $ = id => document.getElementById(id) || document.createElement("div");
  const GH = "https://graphhopper.com/api/1";
  const CODE_VERSION = "24", RELEASED = "25 Nov 2026";
  const store = {
    get(k, d) { try { const v = localStorage.getItem("pr-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("pr-" + k, JSON.stringify(v)); } catch (e) {} }
  };

  let here = null;      // {lat,lng} from the device
  let last = null;      // last planned journey
  const status = (t, err) => { $("status").textContent = t || ""; $("status").className = "status" + (err ? " err" : ""); };

  // ---- Map ----
  const map = L.map("map", { zoomControl: true }).setView([51.53, -2.5], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors · Routing by GraphHopper"
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  function draw(std, options, sel, wps) {
    layer.clearLayers();
    const toLL = p => p.points.coordinates.map(c => [c[1], c[0]]);
    const bounds = L.latLngBounds([]);
    L.polyline(toLL(std), { color: css("--std"), weight: 5, opacity: .8, dashArray: "8 8" }).addTo(layer);
    bounds.extend(L.polyline(toLL(std)).getBounds());
    // unselected options first (thin, tappable), selected on top
    options.forEach((p, i) => {
      if (i === sel) return;
      const l = L.polyline(toLL(p), { color: css("--pr"), weight: 4, opacity: .35 }).addTo(layer);
      l.on("click", () => select(i));
      bounds.extend(l.getBounds());
    });
    const prLine = L.polyline(toLL(options[sel]), { color: css("--pr"), weight: 7, opacity: .95 }).addTo(layer);
    bounds.extend(prLine.getBounds());
    let n = 0;
    wps.forEach(w => {
      if (w.stop) return;
      n++;
      L.marker([w.lat, w.lng], {
        icon: L.divIcon({ className: "wp-icon", html: String(n), iconSize: [20, 20] }),
        title: "Pin " + n + " (" + w.roadClass + " road)"
      }).addTo(layer);
    });
    const pin = (pt, cls, txt, title) => L.marker([pt.lat, pt.lng], {
      icon: L.divIcon({ className: "end-pin " + cls, html: txt, iconSize: [26, 26] }), title, zIndexOffset: 1000
    }).addTo(layer);
    pin(current.from, "start", "S", "Start: " + current.from.label);
    pin(current.to, "finish", "F", "Finish: " + current.to.label);
    if (current.via) pin(current.via, "stop", "⚡", "Stop: " + current.via.label);
    map.fitBounds(bounds, { padding: [30, 30] });
  }

  // ---- Places ----
  const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
  const LATLNG = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

  const server = () => store.get("server", "").replace(/\/+$/, "");
  const usingOwn = () => !!server();

  async function geocode(text, key, field) {
    const q = text.trim();
    const pk = field && picked[field];
    if (pk && pk.text === q) return pk;
    if (/^(here|my location)$/i.test(q) && here) return here;
    const saved = store.get("places", []).find(p => p.name.toLowerCase() === q.toLowerCase());
    if (saved) return { lat: saved.lat, lng: saved.lng, label: saved.name };
    const m = q.match(LATLNG);
    if (m) return { lat: +m[1], lng: +m[2], label: q };
    if (POSTCODE.test(q)) {
      const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(q));
      if (r.ok) { const j = (await r.json()).result; return { lat: j.latitude, lng: j.longitude, label: [j.postcode, j.admin_ward, j.admin_district].filter(Boolean).join(", ") }; }
    }
    if (usingOwn()) {
      const r = await fetch("https://nominatim.openstreetmap.org/search?" + new URLSearchParams({ q, format: "jsonv2", limit: "1", countrycodes: "gb" }));
      const hit = r.ok ? (await r.json())[0] : null;
      if (!hit) throw new Error("Couldn't find “" + q + "”. Try a postcode.");
      return { lat: +hit.lat, lng: +hit.lon, label: String(hit.display_name || hit.name || q).split(",").slice(0, 3).map(x => x.trim()).join(", ") };
    }
    const r = await fetch(GH + "/geocode?" + new URLSearchParams({ q, locale: "en", limit: "1", key }));
    if (!r.ok) throw new Error(await ghError(r, "Couldn't look up “" + q + "”."));
    const hit = (await r.json()).hits?.[0];
    if (!hit) throw new Error("Couldn't find “" + q + "”. Try a postcode.");
    return { lat: hit.point.lat, lng: hit.point.lng, label: [hit.name, hit.city].filter(Boolean).join(", ") };
  }

  async function ghError(r, fallback) {
    if (r.status === 401) return "The GraphHopper key was refused. Check it in Settings.";
    if (r.status === 429) return "GraphHopper's free daily limit is used up. Try again tomorrow.";
    try { const j = await r.json(); return j.message || fallback; } catch (e) { return fallback; }
  }

  // Returns all paths the server gives back. alt=true asks for up to 3 alternatives.
  async function route(from, to, level, key, priority, alt, via) {
    const url = usingOwn() ? server() + "/route" : GH + "/route?key=" + encodeURIComponent(key);
    const body = PR.routeBody(from, to, level, priority, via, typeof level === "number" ? store.get("avoids", []) : null);
    if (alt && !via) Object.assign(body, PR.ALTERNATIVES); // alternatives only work for A→B
    let r;
    try {
      r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error(usingOwn() ? "Can't reach your routing server. Is Tailscale on, and has the server finished building?" : "Couldn't reach GraphHopper. Check your connection.");
    }
    if (!r.ok) {
      if (alt && !via) return route(from, to, level, key, priority, false, via); // fall back to a single route
      throw new Error(await ghError(r, "Routing failed."));
    }
    const paths = (await r.json()).paths || [];
    if (!paths.length) throw new Error("No route found between those places.");
    return paths;
  }

  // ---- Planning ----
  function showTolHint() { $("tolHint").textContent = PR.TOLERANCE[+$("tolerance").value].hint; }
  function showPriHint() { $("priHint").textContent = PR.PRIORITY[+$("priority").value].hint; }
  // Three-way tap buttons (no sliders: dragging near the screen edge triggers Android's back gesture).
  function syncSeg(id) {
    const v = $(id).value;
    document.querySelectorAll('.seg[data-for="' + id + '"] button').forEach(b => {
      const on = b.dataset.v === v;
      b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on));
    });
    (id === "tolerance" ? showTolHint : showPriHint)();
  }
  function setSeg(id, v) { $(id).value = String(v); syncSeg(id); }
  document.querySelectorAll(".seg").forEach(seg => seg.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const id = seg.dataset.for;
    if ($(id).value === b.dataset.v) return;
    setSeg(id, b.dataset.v); store.set(id, +b.dataset.v);
    // A route is on screen: re-plan straight away with the new setting.
    if (current && !$("goBtn").disabled) plan($("from").value, $("to").value);
  }));
  setSeg("tolerance", store.get("tolerance", 1));
  setSeg("priority", store.get("priority", 0));

  async function plan(fromText, toText) {
    const key = store.get("key", "");
    if (!key && !usingOwn()) { status("Add your routing server (or a GraphHopper key) in Settings first.", true); openSettings(); return; }
    const level = +$("tolerance").value, priority = +$("priority").value;
    $("goBtn").disabled = true; status("Finding routes…");
    try {
      const viaText = !$("viaField").hidden ? $("via").value.trim() : "";
      const [from, to, via] = await Promise.all([geocode(fromText, key, "from"), geocode(toText, key, "to"), viaText ? geocode(viaText, key, "via") : null]);
      setPicked("from", fromText.trim(), from); setPicked("to", toText.trim(), to);
      if (via) setPicked("via", viaText, via);
      $("journey").textContent = from.label + "  →  " + (via ? via.label + "  →  " : "") + to.label;
      const [stdPaths, options, shortcut] = await Promise.all([
        route(from, to, null, key, 0, false, via),
        route(from, to, level, key, priority, true, via),
        // Google-style shortcut route, only for placing pins; failure is fine.
        route(from, to, "shortcut", key, 0, false, via).catch(() => null)
      ]);
      last = { fromText, toText, viaText, from, to, via, level, priority };
      current = { std: stdPaths[0], shortcut: shortcut && shortcut[0], options: PR.rankOptions(options, priority), from, to, via };
      addRecent(last);
      clearChargers();
      select(0);
      status("");
      $("saveBtn").hidden = false;
      $("savePlaceBtn").hidden = store.get("places", []).some(p => p.name.toLowerCase() === toText.trim().toLowerCase());
    } catch (e) {
      status(e.message || "Something went wrong. Check your connection.", true);
    } finally { $("goBtn").disabled = false; }
  }

  // How many pins to send: Auto scales with distance (about one per 10 miles), 3 to 9 in total,
  // keeping one slot for a stop if there is one.
  // One-off: people on the old fixed default of 3 move to Auto.
  if (!store.get("maxWpMigrated", false)) { if (+store.get("maxWp", 3) === 3) store.set("maxWp", "auto"); store.set("maxWpMigrated", true); }

  // Long trips are opened in Google Maps as parts, each with its own 9 waypoints,
  // so pins stay close enough together (about every 6-7 miles) to hold Google to the route.
  function legsFor(path) {
    const miles = path.distance / 1609.344;
    return miles > 70 ? Math.min(3, Math.ceil(miles / 60)) : 1;
  }

  function pinBudget(path, hasStop) {
    const legs = legsFor(path);
    if (legs > 1) return legs * 10 - 1 - (hasStop ? 1 : 0);
    const v = String(store.get("maxWp", "auto"));
    const miles = path.distance / 1609.344;
    let n = v === "auto" ? Math.min(9, Math.max(3, Math.round(miles / 10))) : +v || 3;
    if (hasStop) n = Math.min(n, 8);
    return n;
  }

  let current = null;
  const LETTERS = "ABC";

  function select(i) {
    if (!current) return;
    if (current.sel !== undefined && current.sel !== i) clearChargers();
    current.sel = i;
    const pr = current.options[i];
    // Shortcut route first: it's the "urgent" comparison.
    const others = (current.shortcut ? [current.shortcut] : []).concat([current.std], current.options.filter((_, j) => j !== i));
    const urgent = current.shortcut ? 1 : 0;
    let wps;
    if (current.via) {
      const viaAt = PR.alongRoute(pr, current.via);
      wps = PR.pickWaypoints(pr, others, pinBudget(pr, true), { avoidAt: [viaAt], urgent })
        .concat([{ lat: current.via.lat, lng: current.via.lng, roadClass: "stop", at: viaAt, stop: true }])
        .sort((a, b) => a.at - b.at);
    } else wps = PR.pickWaypoints(pr, others, pinBudget(pr, false), { urgent });
    show(current.std, pr, wps, current.from, current.to);
    draw(current.std, current.options, i, wps);
    renderOptions();
  }

  function renderOptions() {
    const box = $("options"), { options, sel } = current;
    box.hidden = options.length < 2;
    box.innerHTML = "";
    if (options.length < 2) return;
    options.forEach((p, i) => {
      const st = PR.laneStats(p);
      const b = document.createElement("button");
      b.type = "button"; b.className = "opt" + (i === sel ? " on" : "");
      b.setAttribute("aria-pressed", String(i === sel));
      b.innerHTML = "<span class=\"letter\">" + LETTERS[i] + "</span><span class=\"o-main\">" + PR.fmtTime(p.time) +
        "</span><span class=\"o-sub\">" + PR.fmtMiles(p.distance) + " · " + (st.laneMetres < 200 ? "no lanes" : PR.fmtMiles(st.laneMetres) + " lanes") + "</span>";
      b.onclick = () => select(i);
      box.append(b);
    });
  }

  // Split pins into Google Maps parts: each part ends at a pin, the next part starts there.
  function splitLegs(wps, from, to, legs) {
    if (legs < 2 || wps.length < legs) return [{ from, to, wps }];
    const n = wps.length, cuts = [];
    for (let L = 1; L < legs; L++) cuts.push(Math.round((n + 1) * L / legs) - 1);
    const parts = [];
    let start = from, prev = -1;
    cuts.forEach(c => { parts.push({ from: start, to: wps[c], wps: wps.slice(prev + 1, c) }); start = wps[c]; prev = c; });
    parts.push({ from: start, to, wps: wps.slice(prev + 1) });
    return parts;
  }

  function show(std, pr, wps, from, to) {
    const s = PR.laneStats(std), p = PR.laneStats(pr);
    $("stdTime").textContent = PR.fmtTime(std.time);
    $("stdDist").textContent = PR.fmtMiles(std.distance);
    $("prTitle").textContent = current && current.options.length > 1 ? "Proper roads · " + LETTERS[current.sel] : "Proper roads";
    $("prTime").textContent = PR.fmtTime(pr.time);
    $("prDist").textContent = PR.fmtMiles(pr.distance);
    const lanes = st => st.laneMetres < 200 ? "No lanes" : "<b>" + PR.fmtMiles(st.laneMetres) + "</b> of lanes";
    $("stdLanes").innerHTML = lanes(s);
    $("prLanes").innerHTML = lanes(p);

    const saved = s.laneMetres - p.laneMetres, extra = pr.distance - std.distance;
    $("verdict").textContent = saved < 400
      ? "Little difference from the usual route here, but Google may still pick lanes, so the route is pinned anyway."
      : "Skips " + PR.fmtMiles(saved) + " of lanes for " + (extra > 0 ? PR.fmtMiles(extra) + " extra." : "no extra distance.");
    const legs = splitLegs(wps, from, to, legsFor(pr));
    $("gmaps").href = PR.googleMapsUrl(from, to, wps.slice(0, 9));
    $("gmaps").hidden = legs.length > 1;
    $("legs").innerHTML = "";
    $("legs").hidden = legs.length < 2;
    if (legs.length > 1) {
      let startMi = 0;
      legs.forEach((leg, k) => {
        const endMi = k === legs.length - 1 ? pr.distance / 1609.344 : leg.to.at / 1609.344;
        const a = document.createElement("a");
        a.className = "primary go"; a.target = "_blank"; a.rel = "noopener";
        a.href = PR.googleMapsUrl(leg.from, leg.to, leg.wps);
        a.innerHTML = "Part " + (k + 1) + " of " + legs.length + " in Google Maps <small></small>";
        a.querySelector("small").textContent = "miles " + Math.round(startMi) + " to " + Math.round(endMi);
        $("legs").append(a);
        startMi = endMi;
      });
    }
    $("wpHint").textContent = !wps.length
      ? "Short trip, so it opens Google Maps with no waypoints."
      : (() => {
          const pins = wps.filter(w => !w.stop).length, stop = wps.some(w => w.stop);
          const parts = legsFor(pr);
          if (parts > 1) return "Long trip, so it opens in " + parts + " parts with " + pins + " pins in total" + (stop ? " plus your stop" : "") +
            ". When Google says you've arrived at the end of a part, come back and open the next.";
          return "Opens Google Maps with " + (stop ? "your stop and " : "") + pins + " pin" + (pins === 1 ? "" : "s") +
            " on main roads to hold it to this route. Tap through them as stops.";
        })();
    $("results").hidden = false;
  }

  $("planForm").addEventListener("submit", e => { e.preventDefault(); plan($("from").value, $("to").value); });

  $("hereBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { status("This browser can't share your location.", true); return; }
    status("Getting your location…");
    navigator.geolocation.getCurrentPosition(
      pos => { here = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: "My location" }; $("from").value = "My location"; setPicked("from", "My location", here); status(""); },
      () => status("Location was blocked. Type a postcode instead.", true),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ---- Picking places: suggestions as you type ----
  const picked = { from: null, to: null };
  function setPicked(field, text, place) {
    picked[field] = place ? Object.assign({}, place, { text }) : null;
    showMatched(field);
  }
  function showMatched(field) {
    const el = $(field + "Matched"), p = picked[field];
    el.hidden = !p;
    if (p) el.textContent = "✓ " + (p.label || p.text);
  }

  const BRISTOL = { lat: 51.5, lon: -2.5 };
  const GB_BBOX = "-8.7,49.8,1.8,60.9";
  const photonLabel = pr => {
    const first = pr.name || [pr.housenumber, pr.street].filter(Boolean).join(" ") || pr.postcode;
    const rest = [pr.street && pr.name ? pr.street : null, pr.city || pr.town || pr.village || pr.district, pr.county]
      .filter((x, i, a) => x && x !== first && a.indexOf(x) === i);
    return [first].concat(rest).join(", ");
  };

  async function suggestions(q) {
    const ql = q.toLowerCase(), out = [];
    store.get("places", []).filter(p => p.name.toLowerCase().includes(ql))
      .forEach(p => out.push({ text: p.name, label: p.name, sub: "Saved place", lat: p.lat, lng: p.lng }));
    if (q.length < 3) return out;
    try {
      if (/^[A-Z]{1,2}\d/i.test(q)) {
        const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(q) + "/autocomplete?limit=5");
        const j = r.ok ? await r.json() : {};
        (j.result || []).forEach(pc => out.push({ text: pc, label: pc, sub: "Postcode", postcode: pc }));
      }
      if (out.length < 6) {
        const r = await fetch("https://photon.komoot.io/api/?" + new URLSearchParams({ q, limit: "6", lang: "en", lat: BRISTOL.lat, lon: BRISTOL.lon, bbox: GB_BBOX }));
        const j = r.ok ? await r.json() : { features: [] };
        j.features.forEach(f => {
          const label = photonLabel(f.properties);
          if (!out.some(o => o.label === label)) out.push({
            text: label.split(",")[0], label, sub: (f.properties.osm_value || "").replace(/_/g, " "),
            lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0]
          });
        });
      }
    } catch (e) { /* suggestions are a nicety; typing still works */ }
    return out.slice(0, 8);
  }

  function setupSuggest(field) {
    const input = $(field), list = $(field + "Sugg");
    let timer = null, items = [], active = -1, seq = 0;
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
    const render = () => {
      list.innerHTML = "";
      items.forEach((it, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option"); li.id = field + "-opt-" + i;
        if (i === active) li.className = "on";
        li.innerHTML = "<b></b><span></span>";
        li.firstChild.textContent = it.label; li.lastChild.textContent = it.sub || "";
        li.addEventListener("mousedown", e => { e.preventDefault(); choose(i); });
        list.append(li);
      });
      list.hidden = !items.length;
      input.setAttribute("aria-expanded", String(!!items.length));
      input.setAttribute("aria-activedescendant", active >= 0 ? field + "-opt-" + active : "");
    };
    async function choose(i) {
      const it = items[i]; if (!it) return;
      close();
      input.value = it.text;
      if (it.postcode) {
        try {
          const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(it.postcode));
          const j = (await r.json()).result;
          setPicked(field, it.text, { lat: j.latitude, lng: j.longitude, label: [j.postcode, j.admin_ward, j.admin_district].filter(Boolean).join(", ") });
        } catch (e) { setPicked(field, null); }
      } else setPicked(field, it.text, { lat: it.lat, lng: it.lng, label: it.label });
    }
    input.addEventListener("input", () => {
      setPicked(field, null);
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { close(); return; }
      const mine = ++seq;
      timer = setTimeout(async () => {
        const res = await suggestions(q);
        if (mine !== seq || document.activeElement !== input) return; // stale, or they've moved on
        items = res; active = -1; render();
      }, 350);
    });
    input.addEventListener("keydown", e => {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(active); }
      else if (e.key === "Escape") close();
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
  }
  setupSuggest("from"); setupSuggest("to");

  // ---- Stop on the way ----
  function showStop(on) {
    $("viaField").hidden = !on; $("addStopBtn").hidden = on;
    if (!on) { $("via").value = ""; setPicked("via", null); $("viaHint").hidden = true; }
  }
  $("addStopBtn").addEventListener("click", () => { showStop(true); $("via").focus(); });
  $("removeStopBtn").addEventListener("click", () => showStop(false));
  setupSuggest("via");

  function useAsStop(c) {
    showStop(true);
    $("via").value = c.name;
    setPicked("via", c.name, { lat: c.lat, lng: c.lng, label: c.name + (c.kw ? " (" + c.kw + " kW)" : "") });
    $("viaHint").hidden = false;
    map.closePopup();
    plan($("from").value, $("to").value);
  }

  // ---- Chargers on the route ----
  const chargerLayer = L.layerGroup().addTo(map);
  let chargers = null; // fetched list for the current route
  function clearChargers() {
    chargerLayer.clearLayers(); chargers = null;
    $("chargersBtn").textContent = "Show chargers on this route";
    $("rapidWrap").hidden = true; $("chargerStatus").textContent = "";
  }

  function routeBounds(path) {
    let s = 90, w = 180, n = -90, e = -180;
    for (const [x, y] of path.points.coordinates) { s = Math.min(s, y); n = Math.max(n, y); w = Math.min(w, x); e = Math.max(e, x); }
    const pad = 0.02;
    return { s: s - pad, w: w - pad, n: n + pad, e: e + pad };
  }

  async function fetchChargers(b) {
    const key = store.get("ocmKey", "");
    if (key) {
      const r = await fetch("https://api.openchargemap.io/v3/poi/?" + new URLSearchParams({
        output: "json", countrycode: "GB", maxresults: "800", compact: "true", verbose: "false", key,
        boundingbox: "(" + b.n + "," + b.w + "),(" + b.s + "," + b.e + ")"
      }));
      if (!r.ok) throw new Error("Open Charge Map refused the request. Check the key in Settings.");
      return (await r.json()).map(p => ({
        name: p.AddressInfo?.Title || "Charger", lat: p.AddressInfo?.Latitude, lng: p.AddressInfo?.Longitude,
        kw: Math.round(Math.max(0, ...(p.Connections || []).map(c => c.PowerKW || 0))) || null,
        points: (p.Connections || []).reduce((a, c) => a + (c.Quantity || 1), 0) || null,
        operator: p.OperatorsReference || null, source: "Open Charge Map"
      })).filter(c => c.lat && c.lng);
    }
    const q = "[out:json][timeout:25];(node[\"amenity\"=\"charging_station\"](" + b.s + "," + b.w + "," + b.n + "," + b.e + ");" +
      "way[\"amenity\"=\"charging_station\"](" + b.s + "," + b.w + "," + b.n + "," + b.e + "););out center tags;";
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: q }) });
    if (!r.ok) throw new Error("Couldn't load chargers just now. Try again in a minute.");
    return (await r.json()).elements.map(el => {
      const t = el.tags || {};
      const kws = Object.keys(t).filter(k => /output$/.test(k)).map(k => parseFloat(t[k])).filter(x => !isNaN(x));
      return {
        name: t.name || t.operator || t.brand || "Charger", lat: el.lat ?? el.center?.lat, lng: el.lon ?? el.center?.lon,
        kw: kws.length ? Math.round(Math.max(...kws)) : null, points: +t.capacity || null,
        operator: t.operator || t.brand || t.network || null, source: "OpenStreetMap"
      };
    }).filter(c => c.lat && c.lng);
  }

  function renderChargers() {
    chargerLayer.clearLayers();
    if (!chargers) return;
    const rapid = $("rapidOnly").checked;
    const list = chargers.filter(c => !rapid || (c.kw && c.kw >= 50));
    list.forEach(c => {
      const el = document.createElement("div"); el.className = "ch-pop";
      const h = document.createElement("b"); h.textContent = c.name; el.append(h);
      const meta = document.createElement("div"); meta.className = "ch-meta";
      meta.textContent = [c.kw ? c.kw + " kW max" : "Power unknown", c.points ? c.points + " connectors" : null, c.operator,
        (c.off / 1609.344).toFixed(1) + " mi off route"].filter(Boolean).join(" · ");
      el.append(meta);
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "primary"; btn.textContent = "Stop here";
      btn.onclick = () => useAsStop(c); el.append(btn);
      const note = document.createElement("div"); note.className = "ch-note"; note.textContent = "Data: " + c.source; el.append(note);
      L.marker([c.lat, c.lng], {
        icon: L.divIcon({ className: "ch-icon" + (c.kw >= 50 ? " rapid" : ""), html: "⚡", iconSize: [22, 22] }),
        title: c.name
      }).bindPopup(el).addTo(chargerLayer);
    });
    $("chargerStatus").textContent = list.length
      ? list.length + " charger" + (list.length > 1 ? "s" : "") + " within a mile of the route. Tap one on the map to see details and stop there."
      : rapid ? "No rapid chargers found near this route. Untick Rapid only to see slower ones." : "No chargers found near this route.";
  }

  $("chargersBtn").addEventListener("click", async () => {
    if (!current) return;
    if (chargers) { clearChargers(); return; }
    const pr = current.options[current.sel];
    $("chargerStatus").textContent = "Finding chargers…";
    try {
      const all = await fetchChargers(routeBounds(pr));
      chargers = PR.nearRoute(pr, all, 1609);
      $("chargersBtn").textContent = "Hide chargers";
      $("rapidWrap").hidden = false;
      renderChargers();
    } catch (e) { $("chargerStatus").textContent = e.message || "Couldn't load chargers."; }
  });
  $("rapidOnly").addEventListener("change", renderChargers);

  // ---- Recent routes ----
  const fmtWhen = t => {
    const d = new Date(t), now = new Date();
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) return "Today " + time;
    if (new Date(now - 864e5).toDateString() === d.toDateString()) return "Yesterday " + time;
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + " " + time;
  };
  function addRecent(j) {
    const list = store.get("recent", []).filter(r => !(r.fromText === j.fromText && r.toText === j.toText && (r.viaText || "") === (j.viaText || "")));
    list.unshift({ fromText: j.fromText, toText: j.toText, viaText: j.viaText || "", level: j.level, priority: j.priority,
      from: j.from, to: j.to, via: j.via || null, at: Date.now() });
    store.set("recent", list.slice(0, 10)); renderRecent();
  }
  function renderRecent() {
    const list = store.get("recent", []);
    $("recentBox").hidden = !list.length;
    $("recent").innerHTML = "";
    list.forEach(r => {
      const li = document.createElement("li");
      const b = document.createElement("button"); b.type = "button"; b.className = "trip";
      b.innerHTML = "<span></span><small></small>";
      b.firstChild.textContent = (r.from?.label || r.fromText) + " → " + (r.via ? (r.via.label || r.viaText) + " → " : "") + (r.to?.label || r.toText);
      b.lastChild.textContent = fmtWhen(r.at);
      b.onclick = () => {
        $("from").value = r.fromText; $("to").value = r.toText;
        if (r.from) setPicked("from", r.fromText.trim(), r.from);
        if (r.to) setPicked("to", r.toText.trim(), r.to);
        if (r.viaText) { showStop(true); $("via").value = r.viaText; if (r.via) setPicked("via", r.viaText, r.via); } else showStop(false);
        setSeg("tolerance", r.level); setSeg("priority", r.priority || 0);
        plan(r.fromText, r.toText);
      };
      li.append(b); $("recent").append(li);
    });
  }
  renderRecent();

  // ---- Marked spots (from the app-icon shortcut) ----
  const markLayer = L.layerGroup().addTo(map);
  function renderMarks() {
    const list = store.get("marks", []);
    $("marksCount").textContent = list.length ? "(" + list.length + ")" : "";
    $("marks").innerHTML = "";
    if (!list.length) { const li = document.createElement("li"); li.className = "hint"; li.textContent = "None yet."; $("marks").append(li); }
    list.forEach((m, i) => {
      const li = document.createElement("li"); li.className = "row";
      const t = document.createElement("span"); t.textContent = fmtWhen(m.at);
      const show = document.createElement("button"); show.type = "button"; show.className = "ghost small"; show.textContent = "Show";
      show.onclick = () => {
        markLayer.clearLayers();
        L.circleMarker([m.lat, m.lng], { radius: 9, color: "#b42318", weight: 3, fillOpacity: .2 }).addTo(markLayer);
        map.setView([m.lat, m.lng], 16);
        status("Tap the lane near the red circle to avoid it.");
        if (window.innerWidth <= 760) document.getElementById("map").scrollIntoView({ behavior: "smooth" });
      };
      const del = document.createElement("button"); del.type = "button"; del.className = "del"; del.textContent = "✕";
      del.setAttribute("aria-label", "Remove marked spot");
      del.onclick = () => { const l = store.get("marks", []); l.splice(i, 1); store.set("marks", l); markLayer.clearLayers(); renderMarks(); };
      li.append(t, show, del); $("marks").append(li);
    });
  }
  function markHere(fromShortcut) {
    if (!navigator.geolocation) { status("This phone can't share its location here.", true); return; }
    status("Marking this spot…");
    navigator.geolocation.getCurrentPosition(pos => {
      const list = store.get("marks", []);
      list.unshift({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy), at: Date.now() });
      store.set("marks", list.slice(0, 50)); renderMarks();
      status("Spot marked. Deal with it later under Marked spots." + (fromShortcut ? " You can close the app." : ""));
    }, () => status("Couldn't get your location. Allow location for this app and try again.", true), { enableHighAccuracy: true, timeout: 15000 });
  }
  $("markNowBtn").addEventListener("click", () => markHere(false));
  renderMarks();
  if (new URLSearchParams(location.search).has("mark")) {
    try { history.replaceState(history.state, "", location.pathname); } catch (e) {}
    $("marksBox").open = true;
    markHere(true);
  }

  // ---- Avoided roads ----
  const avoidLayer = L.layerGroup().addTo(map);
  function renderAvoids() {
    const list = store.get("avoids", []);
    $("avoidCount").textContent = list.length ? "(" + list.length + ")" : "";
    $("avoids").innerHTML = ""; avoidLayer.clearLayers();
    if (!list.length) { const li = document.createElement("li"); li.className = "hint"; li.textContent = "None yet."; $("avoids").append(li); }
    list.forEach((a, i) => {
      L.circle([a.lat, a.lng], { radius: 40, color: "#b42318", weight: a.all ? 3 : 2, fillOpacity: a.all ? .3 : .15, dashArray: a.all ? null : "4 4" }).addTo(avoidLayer);
      const li = document.createElement("li"); li.className = "row";
      const t = document.createElement("span"); t.textContent = (a.name || ("Near " + a.lat.toFixed(4) + ", " + a.lng.toFixed(4))) + (a.all ? " · whole road" : "");
      const show = document.createElement("button"); show.type = "button"; show.className = "ghost small"; show.textContent = "Show";
      show.onclick = () => map.setView([a.lat, a.lng], 16);
      const del = document.createElement("button"); del.type = "button"; del.className = "del"; del.textContent = "✕";
      del.setAttribute("aria-label", "Stop avoiding this road");
      del.onclick = () => { const l = store.get("avoids", []); l.splice(i, 1); store.set("avoids", l); renderAvoids(); };
      li.append(t, show, del); $("avoids").append(li);
    });
  }
  async function nameRoad(lat, lng) {
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/reverse?" + new URLSearchParams({ lat, lon: lng, format: "jsonv2", zoom: "17" }));
      const j = await r.json();
      const a = j.address || {};
      return [a.road, a.village || a.hamlet || a.town || a.suburb].filter(Boolean).join(", ") || null;
    } catch (e) { return null; }
  }
  map.on("click", e => {
    const el = document.createElement("div"); el.className = "ch-pop";
    // Add a stop here (works at any zoom).
    const hasStop = !$("viaField").hidden && $("via").value.trim();
    const st = document.createElement("button"); st.type = "button"; st.className = "primary";
    st.textContent = hasStop ? "Make this the stop instead" : "Add a stop here";
    st.onclick = async () => {
      map.closePopup();
      const { lat, lng } = e.latlng;
      const name = (await nameRoad(lat, lng)) || "Stop on the map";
      showStop(true);
      $("via").value = name;
      setPicked("via", name, { lat: +lat.toFixed(6), lng: +lng.toFixed(6), label: name });
      $("viaHint").hidden = true;
      if ($("from").value.trim() && $("to").value.trim()) plan($("from").value, $("to").value);
      else status("Stop added. Fill in From and To, then Find proper route.");
    };
    el.append(st);
    if (map.getZoom() < 13) {
      const z = document.createElement("div"); z.className = "ch-meta"; z.textContent = "Zoom in further to avoid a lane here.";
      el.append(z);
      L.popup().setLatLng(e.latlng).setContent(el).openOn(map);
      return;
    }
    const b = document.createElement("button"); b.type = "button"; b.className = "ghost"; b.textContent = "Avoid this lane";
    const n = document.createElement("div"); n.className = "ch-meta"; n.textContent = "Minor roads within about 40 m of this spot. A and B roads stay usable.";
    const b2 = document.createElement("button"); b2.type = "button"; b2.className = "ghost"; b2.textContent = "Avoid this road, even an A or B road";
    const n2 = document.createElement("div"); n2.className = "ch-meta"; n2.textContent = "For B roads that are really lanes. Tap mid-road, away from junctions.";
    const sep = document.createElement("hr"); sep.className = "pop-sep";
    el.append(sep, b, n, b2, n2);
    const pop = L.popup().setLatLng(e.latlng).setContent(el).openOn(map);
    const add = async all => {
      const { lat, lng } = e.latlng;
      const list = store.get("avoids", []);
      list.push({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), at: Date.now(), all });
      store.set("avoids", list); renderAvoids(); map.closePopup(pop); markLayer.clearLayers();
      status("Lane avoided." + (current ? " Re-planning…" : ""));
      if (current) plan($("from").value, $("to").value);
      const name = await nameRoad(lat, lng);
      if (name) { const l = store.get("avoids", []); const it = l.find(x => x.lat === +lat.toFixed(6) && x.lng === +lng.toFixed(6)); if (it) { it.name = name; store.set("avoids", l); renderAvoids(); } }
    };
    b.onclick = () => add(false);
    b2.onclick = () => add(true);
  });
  renderAvoids();

  // ---- Saved places ----
  function renderPlaces() {
    const list = store.get("places", []);
    $("places").innerHTML = "";
    list.forEach((p, i) => {
      const chip = document.createElement("span"); chip.className = "chip";
      const b = document.createElement("button"); b.type = "button"; b.textContent = p.name;
      b.title = "Go to " + p.name;
      b.onclick = () => { $("to").value = p.name; setPicked("to", p.name, { lat: p.lat, lng: p.lng, label: p.name }); };
      const x = document.createElement("button"); x.type = "button"; x.className = "x"; x.textContent = "✕";
      x.setAttribute("aria-label", "Remove " + p.name);
      x.onclick = () => { const l = store.get("places", []); l.splice(i, 1); store.set("places", l); renderPlaces(); };
      chip.append(b, x); $("places").append(chip);
    });
  }
  $("savePlaceBtn").addEventListener("click", () => {
    $("savePlaceBox").hidden = false;
    $("placeName").value = last && last.to.label && !/^-?\d/.test(last.to.label) ? last.to.label : "";
    $("placeName").focus();
  });
  $("placeOk").addEventListener("click", () => {
    const name = $("placeName").value.trim();
    if (!name || !last) return;
    const list = store.get("places", []).filter(p => p.name.toLowerCase() !== name.toLowerCase());
    list.push({ name, lat: last.to.lat, lng: last.to.lng });
    list.sort((a, b) => a.name.localeCompare(b.name));
    store.set("places", list); renderPlaces();
    $("savePlaceBox").hidden = true; $("savePlaceBtn").hidden = true;
    $("to").value = name; status("Saved “" + name + "”.");
  });
  $("placeName").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("placeOk").click(); } });
  $("swapBtn").addEventListener("click", () => {
    const f = $("from").value, pf = picked.from;
    $("from").value = $("to").value; $("to").value = f;
    picked.from = picked.to; picked.to = pf;
    showMatched("from"); showMatched("to");
  });
  renderPlaces();

  // ---- Saved journeys ----
  function renderSaved() {
    const list = store.get("saved", []);
    $("savedBox").hidden = !list.length;
    $("saved").innerHTML = "";
    list.forEach((j, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button"; b.className = "trip"; b.textContent = j.name;
      b.onclick = () => { $("from").value = j.fromText; $("to").value = j.toText; setSeg("tolerance", j.level); setSeg("priority", j.priority || 0);
        if (j.viaText) { showStop(true); $("via").value = j.viaText; if (j.viaPlace) setPicked("via", j.viaText, j.viaPlace); } else showStop(false); plan(j.fromText, j.toText); };
      const d = document.createElement("button");
      d.type = "button"; d.className = "del"; d.textContent = "✕"; d.setAttribute("aria-label", "Remove " + j.name);
      d.onclick = () => { const l = store.get("saved", []); l.splice(i, 1); store.set("saved", l); renderSaved(); };
      li.append(b, d); $("saved").append(li);
    });
  }
  $("saveBtn").addEventListener("click", () => {
    if (!last) return;
    const list = store.get("saved", []);
    const name = (last.from.label || last.fromText) + " → " + (last.via ? (last.via.label || last.viaText) + " → " : "") + (last.to.label || last.toText);
    if (!list.some(j => j.fromText === last.fromText && j.toText === last.toText && (j.viaText || "") === (last.viaText || ""))) list.unshift({ name, fromText: last.fromText, toText: last.toText, level: last.level, priority: last.priority, viaText: last.viaText || "",
      viaPlace: last.via ? { lat: last.via.lat, lng: last.via.lng, label: last.via.label } : null });
    store.set("saved", list.slice(0, 20)); renderSaved(); status("Saved.");
  });
  renderSaved();

  // ---- Settings ----
  function openSettings() {
    $("apiKey").value = store.get("key", "");
    $("server").value = store.get("server", "");
    $("ocmKey").value = store.get("ocmKey", "");
    $("maxWp").value = String(store.get("maxWp", "auto"));
    $("settings").showModal();
  }
  $("settingsBtn").addEventListener("click", openSettings);
  $("settings").addEventListener("close", () => {
    if ($("settings").returnValue !== "save") return;
    store.set("key", $("apiKey").value.trim());
    store.set("server", $("server").value.trim());
    store.set("ocmKey", $("ocmKey").value.trim());
    store.set("maxWp", $("maxWp").value === "auto" ? "auto" : +$("maxWp").value);
    status("Settings saved.");
  });
  if (!store.get("key", "") && !store.get("server", "")) status("Start by adding your routing server in Settings.");

  // Version check: page and code should match. If not, the phone has a half-updated copy.
  {
    const pageV = document.querySelector('meta[name="app-version"]')?.getAttribute("content") || "?";
    const el = document.getElementById("version");
    if (el) {
      el.textContent = pageV === CODE_VERSION
        ? "Version " + CODE_VERSION + " · " + RELEASED
        : "Version mismatch (page " + pageV + ", code " + CODE_VERSION + "). Close the app fully and reopen it.";
      el.classList.toggle("warn", pageV !== CODE_VERSION);
    }
  }

  // Back-swipe guard: the first back gesture is caught and warned about; a second one within 3s leaves.
  {
    let armedAt = 0;
    try { history.pushState({ guard: 1 }, ""); } catch (e) {}
    window.addEventListener("popstate", () => {
      if (Date.now() - armedAt < 3000) { history.back(); return; }
      armedAt = Date.now();
      try { history.pushState({ guard: 1 }, ""); } catch (e) {}
      status("Swipe back again to close Proper Roads.");
      setTimeout(() => { if ($("status").textContent.startsWith("Swipe back")) status(""); }, 3000);
    });
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
