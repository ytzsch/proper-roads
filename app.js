{
  const PR = window.ProperRoads;
  // If the page and this script come from different versions (cached page), missing
  // elements get a detached stand-in instead of crashing the app.
  const $ = id => document.getElementById(id) || document.createElement("div");
  const GH = "https://graphhopper.com/api/1";
  const CODE_VERSION = "9", RELEASED = "25 Nov 2026";
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
    wps.forEach((w, i) => L.marker([w.lat, w.lng], {
      icon: L.divIcon({ className: "wp-icon", html: String(i + 1), iconSize: [20, 20] }),
      title: "Waypoint " + (i + 1) + " (" + w.roadClass + " road)"
    }).addTo(layer));
    const pin = (pt, cls, txt, title) => L.marker([pt.lat, pt.lng], {
      icon: L.divIcon({ className: "end-pin " + cls, html: txt, iconSize: [26, 26] }), title, zIndexOffset: 1000
    }).addTo(layer);
    pin(current.from, "start", "S", "Start: " + current.from.label);
    pin(current.to, "finish", "F", "Finish: " + current.to.label);
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
  async function route(from, to, level, key, priority, alt) {
    const url = usingOwn() ? server() + "/route" : GH + "/route?key=" + encodeURIComponent(key);
    const body = PR.routeBody(from, to, level, priority);
    if (alt) Object.assign(body, PR.ALTERNATIVES);
    let r;
    try {
      r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error(usingOwn() ? "Can't reach your routing server. Is Tailscale on, and has the server finished building?" : "Couldn't reach GraphHopper. Check your connection.");
    }
    if (!r.ok) {
      if (alt) return route(from, to, level, key, priority, false); // fall back to a single route
      throw new Error(await ghError(r, "Routing failed."));
    }
    const paths = (await r.json()).paths || [];
    if (!paths.length) throw new Error("No route found between those places.");
    return paths;
  }

  // ---- Planning ----
  function showTolHint() { $("tolHint").textContent = PR.TOLERANCE[+$("tolerance").value].hint; }
  function showPriHint() { $("priHint").textContent = PR.PRIORITY[+$("priority").value].hint; }
  $("tolerance").value = store.get("tolerance", 1);
  $("priority").value = store.get("priority", 0);
  $("tolerance").addEventListener("input", () => { showTolHint(); store.set("tolerance", +$("tolerance").value); });
  $("priority").addEventListener("input", () => { showPriHint(); store.set("priority", +$("priority").value); });
  showTolHint(); showPriHint();

  async function plan(fromText, toText) {
    const key = store.get("key", "");
    if (!key && !usingOwn()) { status("Add your routing server (or a GraphHopper key) in Settings first.", true); openSettings(); return; }
    const level = +$("tolerance").value, priority = +$("priority").value;
    $("goBtn").disabled = true; status("Finding routes…");
    try {
      const [from, to] = await Promise.all([geocode(fromText, key, "from"), geocode(toText, key, "to")]);
      setPicked("from", fromText.trim(), from); setPicked("to", toText.trim(), to);
      $("journey").textContent = from.label + "  →  " + to.label;
      const [stdPaths, options] = await Promise.all([route(from, to, null, key), route(from, to, level, key, priority, true)]);
      last = { fromText, toText, from, to, level, priority };
      current = { std: stdPaths[0], options: PR.rankOptions(options, priority), from, to };
      select(0);
      status("");
      $("saveBtn").hidden = false;
      $("savePlaceBtn").hidden = store.get("places", []).some(p => p.name.toLowerCase() === toText.trim().toLowerCase());
    } catch (e) {
      status(e.message || "Something went wrong. Check your connection.", true);
    } finally { $("goBtn").disabled = false; }
  }

  let current = null;
  const LETTERS = "ABC";

  function select(i) {
    if (!current) return;
    current.sel = i;
    const pr = current.options[i];
    const others = [current.std].concat(current.options.filter((_, j) => j !== i));
    const wps = PR.pickWaypoints(pr, others, +store.get("maxWp", 3));
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
    $("gmaps").href = PR.googleMapsUrl(from, to, wps);
    $("wpHint").textContent = !wps.length
      ? "Short trip, so it opens Google Maps with no waypoints."
      : "Opens Google Maps with " + wps.length + " waypoint" + (wps.length > 1 ? "s" : "") +
        " on main roads to hold it to this route. Tap through them as stops. Google should show one route, not several.";
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
      b.onclick = () => { $("from").value = j.fromText; $("to").value = j.toText; $("tolerance").value = j.level; $("priority").value = j.priority || 0; showTolHint(); showPriHint(); plan(j.fromText, j.toText); };
      const d = document.createElement("button");
      d.type = "button"; d.className = "del"; d.textContent = "✕"; d.setAttribute("aria-label", "Remove " + j.name);
      d.onclick = () => { const l = store.get("saved", []); l.splice(i, 1); store.set("saved", l); renderSaved(); };
      li.append(b, d); $("saved").append(li);
    });
  }
  $("saveBtn").addEventListener("click", () => {
    if (!last) return;
    const list = store.get("saved", []);
    const name = (last.from.label || last.fromText) + " → " + (last.to.label || last.toText);
    if (!list.some(j => j.fromText === last.fromText && j.toText === last.toText)) list.unshift({ name, fromText: last.fromText, toText: last.toText, level: last.level, priority: last.priority });
    store.set("saved", list.slice(0, 20)); renderSaved(); status("Saved.");
  });
  renderSaved();

  // ---- Settings ----
  function openSettings() {
    $("apiKey").value = store.get("key", "");
    $("server").value = store.get("server", "");
    $("maxWp").value = String(store.get("maxWp", 3));
    $("settings").showModal();
  }
  $("settingsBtn").addEventListener("click", openSettings);
  $("settings").addEventListener("close", () => {
    if ($("settings").returnValue !== "save") return;
    store.set("key", $("apiKey").value.trim());
    store.set("server", $("server").value.trim());
    store.set("maxWp", +$("maxWp").value);
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

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
