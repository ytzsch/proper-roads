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

1. **Get a GraphHopper key.** Sign up for the free plan at graphhopper.com, then create a key under API Keys.
2. **Create the repo.** Make a new repo `proper-roads` on GitHub and upload these files to the root.
3. **Turn on Pages.** In the repo, go to Settings → Pages → Deploy from a branch → `main` / root. The app will be at https://ytzsch.github.io/proper-roads/
4. **On your phone**, open that link, tap the gear, paste your key, then add it to your home screen.

The key is stored only in your browser, not in the repo.

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
