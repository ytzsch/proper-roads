# Proper Roads

Shortest sensible route without the narrow, slow national-speed-limit lanes. It works out a "proper roads" route and then hands it to Google Maps with a few waypoints that keep Google on the main roads.

## How it works

1. Looks up both places. UK postcodes go through postcodes.io, and anything else through GraphHopper geocoding. You can also type `lat,lng`.
2. Asks GraphHopper for two routes:
   - **Usual**: the normal car route, which is roughly what Google picks.
   - **Proper roads**: the same request with a custom model. Lanes (OSM `unclassified`, `track`, `service`) get a realistic speed of 20–30mph instead of 60, the router is told to avoid them, and roads tagged narrower than 3.5 m are penalised.
3. Compares the two, showing miles of lanes on each and the time and distance cost.
4. Where the proper route leaves the usual one, it pins the middle of each detour, preferring A and B roads. Long detours are split so that each roughly 8 km stretch can have its own pin.
5. **Open in Google Maps** opens Google Maps with those pins as waypoints, so Google still handles navigation and traffic.

The lane tolerance slider (Relaxed, Balanced, Strict) changes how hard lanes are avoided. All the tuning is in `customModel()` in `routing.js`.

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `style.css` | Look and layout |
| `routing.js` | Route logic: custom models, lane stats, waypoint picking, Google Maps link. It has no DOM code, so it runs in Node for testing |
| `app.js` | UI: map, forms, saved journeys, settings |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Installable app bits |

## Setup

The app is on GitHub Pages. Routing runs on your own GraphHopper server, because GraphHopper.com's free plan doesn't allow custom models.

### Routing server (Proxmox)

In the Proxmox web UI, select the node, open **Shell** and paste:

```
bash -c "$(curl -fsSL https://raw.githubusercontent.com/ytzsch/proper-roads/main/server/install.sh)"
```

This creates a Debian 12 container called `graphhopper` (4 cores, 8 GB RAM, 32 GB disk, starts on boot). Inside the container it installs Java 17, GraphHopper 10.2 and the Great Britain map. It also sets up a service and a monthly map refresh, then joins Tailscale with Tailscale Serve so the server gets a private HTTPS address.

- The first start builds the routing graph, which takes about 30 to 60 minutes. To watch it, run `pct enter <id>` and then `journalctl -u graphhopper -f`.
- If Tailscale asks you to enable HTTPS certificates, follow its link.

### App

Open https://ytzsch.github.io/proper-roads/ on your phone (with Tailscale on), tap the gear, paste the `https://graphhopper.<tailnet>.ts.net` address and save.

## Known limits (v1)

- Google Maps treats waypoints as stops, so you tap "continue" at each one. Google Maps on a phone copes best with about 3.
- Between waypoints, Google can still choose its own way. If a lane sneaks back in, try Strict, or raise the waypoint count in Settings.
- OSM's road classes are a good proxy for "narrow lane", but they aren't perfect. Width tags are patchy.
- The GraphHopper free plan has a daily request limit. Each plan uses 2 routes and up to 2 lookups.

## Ideas for later

- Learn real speeds from your own drives
- Profiles: beautiful drives, historic drives, driver's roads, towing, fords
- "Make it a day out" detours with a pub or tearoom stop
- Shared and saved drives
