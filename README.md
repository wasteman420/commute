# Commute

A single-page commute dashboard. Live tram, rail, tube and bus departures
for the Arena → East Croydon / Beckenham Junction → Victoria → South Kensington
route. Static HTML/CSS/JS; no build step, no framework, no service worker.

## Run locally

From the repo root:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>.

The page works without any keys for tram, tube and bus data. National Rail
needs a Darwin token (see below).

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Choose `main` and `/ (root)`.
4. Save. The site will be live at `https://<your-user>.github.io/<repo>/`.

The repo can be public — no secrets are baked into the source. The TfL app
key and Darwin token live only in your browser's `localStorage`, entered
through the in-app settings panel.

## Tokens

### Darwin token (for National Rail)

Free. Issued by National Rail Open LDBWS:

<https://lite.realtime.nationalrail.co.uk/OpenLDBWSRegistration>

Format: a UUID. Paste it into the **Settings → Darwin token** field.
Without it the rail columns show a placeholder linking back to settings.

### TfL app key (optional)

The TfL Unified API works unauthenticated; an app key only matters under
heavy load. To get one:

<https://api-portal.tfl.gov.uk/>

Sign up, create a new "API product" subscription, copy the primary key,
paste into **Settings → TfL app key**.

## Configuration

The tunable constants (fallback journey times, platform-transfer minutes,
refresh cadences) are at the top of `app.js` in the `CONFIG` object. Edit
in place; no rebuild needed.

```js
TRAM_FALLBACK_ARENA_TO_ECR_MIN: 9,   // used only if vehicleId match fails
TRAM_FALLBACK_ARENA_TO_BKJ_MIN: 8,
TRANSFER_ECR_TRAM_TO_RAIL_MIN: 4,
TRANSFER_BKJ_TRAM_TO_RAIL_MIN: 2,
TRANSFER_VIC_TO_BUS_MIN: 4,
TRANSFER_VIC_TO_TUBE_MIN: 5,
TFL_REFRESH_MS: 60_000,
HUXLEY_REFRESH_MS: 90_000,
DEPARTURE_COUNT: 5,
```

## Add to Home Screen

The page is a minimal PWA (manifest + meta tags only — deliberately no
service worker, so every load fetches fresh data).

- **iOS Safari**: share sheet → Add to Home Screen.
- **Android Chrome**: menu → Add to Home screen / Install app.

It launches fullscreen with the dark theme matching the in-app palette.

## Data sources

- **TfL Unified API** (`api.tfl.gov.uk`) — trams, tube, bus, line status.
  CORS-friendly. Optional `app_key` query param.
- **Huxley2** (`huxley2.azurewebsites.net`) — CORS-friendly REST wrapper
  around National Rail's Darwin SOAP API.

## Notes

- The Arena tram stop ID is discovered dynamically the first time and
  cached in `localStorage`. **Settings → Clear cache** wipes it.
- Bus stop NaPTAN IDs are deliberately **not** cached — the 52 bus column
  hits `/Line/52/Arrivals` and filters in JavaScript, because earlier
  attempts to pin a Victoria bus stop ID returned Underground arrivals.
- Victoria tube arrivals are filtered for `district`/`circle` westbound in
  JavaScript, not via TfL's `?lineIds=` param, which leaks Victoria-line
  trains at hub stops.
- Live tram journey times are computed by matching the `vehicleId` of an
  Arena arrival against arrivals at ECR or BKJ. When matched, the row
  shows the live journey time and live mainline-platform ETA. When not
  matched (vehicle too far out, no prediction yet) the row falls back to
  the configured constant and the journey-time chip is dimmed with a `~`
  prefix.
