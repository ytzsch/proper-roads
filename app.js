{
  const PR = window.ProperRoads;
  const $ = id => document.getElementById(id);
  const GH = "https://graphhopper.com/api/1";
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

  function draw(std, pr, wps) {
    layer.clearLayers();
    const toLL = p => p.points.coordinates.map(c => [c[1], c[0]]);
    L.polyline(toLL(std), { color: css("--std"), weight: 5, opacity: .8, dashArray: "8 8" }).addTo(layer);
    const prLine = L.polyline(toLL(pr), { color: css("--pr"), weight: 6, opacity: .9 }).addTo(layer);
    wps.forEach((w, i) => L.marker([w.lat, w.lng], {
      icon: L.divIcon({ className: "wp-icon", html: String(i + 1), iconSize: [20, 20] }),
      title: "Waypoint " + (i + 1) + " (" + w.roadClass + " road)"
    }).addTo(layer));
    map.fitBounds(prLine.getBounds().extend(L.polyline(toLL(std)).getBounds()), { padding: [30, 30] });
  }

  // ---- Places ----
  const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
  const LATLNG = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

  const server = () => store.get("server", "").replace(/\/+$/, "");
  const usingOwn = () => !!server();

  async function geocode(text, key) {
    const q = text.trim();
    if (/^(here|my location)$/i.test(q) && here) return here;
    const m = q.match(LATLNG);
    if (m) return { lat: +m[1], lng: +m[2], label: q };
    if (POSTCODE.test(q)) {
      const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(q));
      if (r.ok) { const j = await r.json(); return { lat: j.result.latitude, lng: j.result.longitude, label: j.result.postcode }; }
    }
    if (usingOwn()) {
      const r = await fetch("https://nominatim.openstreetmap.org/search?" + new URLSearchParams({ q, format: "jsonv2", limit: "1", countrycodes: "gb" }));
      const hit = r.ok ? (await r.json())[0] : null;
      if (!hit) throw new Error("Couldn't find “" + q + "”. Try a postcode.");
      return { lat: +hit.lat, lng: +hit.lon, label: hit.name || hit.display_name.split(",")[0] };
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

  async function route(from, to, level, key) {
    const url = usingOwn() ? server() + "/route" : GH + "/route?key=" + encodeURIComponent(key);
    let r;
    try {
      r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(PR.routeBody(from, to, level)) });
    } catch (e) {
      throw new Error(usingOwn() ? "Can't reach your routing server. Is Tailscale on, and has the server finished building?" : "Couldn't reach GraphHopper. Check your connection.");
    }
    if (!r.ok) throw new Error(await ghError(r, "Routing failed."));
    const path = (await r.json()).paths?.[0];
    if (!path) throw new Error("No route found between those places.");
    return path;
  }

  // ---- Planning ----
  function showTolHint() { $("tolHint").textContent = PR.TOLERANCE[+$("tolerance").value].hint; }
  $("tolerance").addEventListener("input", showTolHint);
  showTolHint();

  async function plan(fromText, toText) {
    const key = store.get("key", "");
    if (!key && !usingOwn()) { status("Add your routing server (or a GraphHopper key) in Settings first.", true); openSettings(); return; }
    const level = +$("tolerance").value;
    $("goBtn").disabled = true; status("Finding routes…");
    try {
      const [from, to] = await Promise.all([geocode(fromText, key), geocode(toText, key)]);
      const [std, pr] = await Promise.all([route(from, to, null, key), route(from, to, level, key)]);
      const wps = PR.pickWaypoints(pr, std, +store.get("maxWp", 3));
      last = { fromText, toText, from, to, level };
      show(std, pr, wps, from, to);
      draw(std, pr, wps);
      status("");
      $("saveBtn").hidden = false;
    } catch (e) {
      status(e.message || "Something went wrong. Check your connection.", true);
    } finally { $("goBtn").disabled = false; }
  }

  function show(std, pr, wps, from, to) {
    const s = PR.laneStats(std), p = PR.laneStats(pr);
    $("stdTime").textContent = PR.fmtTime(std.time);
    $("stdDist").textContent = PR.fmtMiles(std.distance);
    $("prTime").textContent = PR.fmtTime(pr.time);
    $("prDist").textContent = PR.fmtMiles(pr.distance);
    const lanes = st => st.laneMetres < 200 ? "No lanes" : "<b>" + PR.fmtMiles(st.laneMetres) + "</b> of lanes";
    $("stdLanes").innerHTML = lanes(s);
    $("prLanes").innerHTML = lanes(p);

    const saved = s.laneMetres - p.laneMetres, extra = pr.distance - std.distance;
    $("verdict").textContent = saved < 400
      ? "The usual route already sticks to proper roads, so Google should be fine as it is."
      : "Skips " + PR.fmtMiles(saved) + " of lanes for " + (extra > 0 ? PR.fmtMiles(extra) + " extra." : "no extra distance.");
    $("gmaps").href = PR.googleMapsUrl(from, to, saved < 400 ? [] : wps);
    $("wpHint").textContent = saved < 400 || !wps.length
      ? "Opens Google Maps with no waypoints."
      : "Opens Google Maps with " + wps.length + " waypoint" + (wps.length > 1 ? "s" : "") +
        " on main roads to keep it off the lanes. Tap through them as stops.";
    $("results").hidden = false;
  }

  $("planForm").addEventListener("submit", e => { e.preventDefault(); plan($("from").value, $("to").value); });

  $("hereBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { status("This browser can't share your location.", true); return; }
    status("Getting your location…");
    navigator.geolocation.getCurrentPosition(
      pos => { here = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: "My location" }; $("from").value = "My location"; status(""); },
      () => status("Location was blocked. Type a postcode instead.", true),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ---- Saved journeys ----
  function renderSaved() {
    const list = store.get("saved", []);
    $("savedBox").hidden = !list.length;
    $("saved").innerHTML = "";
    list.forEach((j, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button"; b.className = "trip"; b.textContent = j.name;
      b.onclick = () => { $("from").value = j.fromText; $("to").value = j.toText; $("tolerance").value = j.level; showTolHint(); plan(j.fromText, j.toText); };
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
    if (!list.some(j => j.fromText === last.fromText && j.toText === last.toText)) list.unshift({ name, fromText: last.fromText, toText: last.toText, level: last.level });
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

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
