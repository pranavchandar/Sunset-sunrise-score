# Sky Score

Sky Score predicts how vibrant the next sunrises and sunsets will be. Each event gets a score from 0 to 100, and a game-style breakdown explains the score. People rate what they actually saw, and an admin dashboard turns those ratings into better weights.

- **Fresh prediction on every page load.** It uses free, keyless [Open-Meteo](https://open-meteo.com/) weather and air-quality models. Sun position is computed on the device.
- **Default location:** Perungudi, Chennai. You can change it by search, by GPS (altitude included, if the device shares it) or from saved spots.
- **Sky Stats (the reasoning).** Five RPG-style stats, each with a level from 0 to 10 and its points:
  - Cloud Canvas
  - Light Path
  - Open Sky
  - Air Clarity
  - Dry Air

  It also shows:
  - Buffs, debuffs and caps: Clearing Storm, Rain Curse, Overcast Lid, Empty Canvas and High Ground.
  - A running score tally.
  - The MVP (the stat that earned the most points) and the Nemesis (the stat that cost the most).
  - A horizon radar showing cloud along the sun's line at 50, 100 and 200 km.
- **Extras:**
  - Peak-color window, golden hour and blue hour.
  - "Face W (263°)" compass, plus a live phone compass.
  - Confidence bars that drop with lead time.
  - "▲ 6 since your last look" trend.
  - Calendar (.ics) export, share, an in-tab reminder, photo tips and Chennai local notes.
- **Feedback loop:**
  - Rate recent skies from 1 to 5 stars, with tags and a note. Each rating is stored with the full prediction snapshot.
  - Ratings earn XP, levels and badges (Sky Scout).
  - Ratings made while offline are queued and synced later.
- **Admin page (`/admin`):**
  - Accuracy KPIs: hit rate, mean error, bias and correlation.
  - Predicted-vs-rated scatter, rating histogram and a calibration table.
  - CSV and JSON export, and deleting individual ratings.
  - **Suggested weights** from a ridge regression over the ratings. You can apply them live with one click, or reset them.

## Run it

```bash
ADMIN_TOKEN=choose-a-long-secret npm start   # http://localhost:3000, admin at /admin
npm test                                      # scoring, sun/geo, stats and API tests
```

- Node 18 or newer. There are no dependencies.
- Ratings go to `data/feedback.json` and tuned weights to `data/config.json`. You can change the folder with `DATA_DIR`.
- If `ADMIN_TOKEN` is not set, the server prints a random token at startup.

The `public/` folder also works as a static site (for example, GitHub Pages). Predictions work without the server. Ratings are then kept in the browser's outbox until a server is reachable, and the default weights are used.

## How the score works

| Component | Weight | Rule |
|---|---|---|
| Cloud Canvas (max of high and mid cloud overhead, HM) | 35 | 0 at 0%, ramps to 1 at 30%, stays at 1 up to 70%, falls to 0 at 100% |
| Light Path (horizon cloud toward the sun, HZ) | 30 | `(1 − HZ/100)^1.5` |
| Open Sky (low cloud overhead) | 15 | `1 − low/100` |
| Air Clarity (aerosol optical depth, AOD) | 10 | 0.8 below 0.1; 1 from 0.1 to 0.3; falls to 0.3 at 0.6; 0.1 above 0.6 |
| Dry Air (humidity and visibility) | 10 | −0.5 if RH > 85%; −0.5 if visibility < 5 km |

- **HZ** is the weighted mean of `low + ½·mid` at 50, 100 and 200 km along the sun's azimuth, with weights 0.4, 0.35 and 0.25.
- **Modifiers:**
  - Rain at peak: ×0.3.
  - Clearing storm: +10.
  - Total cloud above 95%: score capped at 15.
  - Clear sky: score capped at 35.
  - High Ground (observer altitude 150–1500 m): up to +6.
- **Departure from the handover spec.** Canvas points are multiplied by the Light Path factor, because sunlight has to cross the horizon before it can light the clouds overhead. Without this gate, "50% cirrus + 80% low cloud on the horizon" scores 73. The spec requires it to score below 45; with the gate it scores 41. Turn it off with `horizon.gatesCanvas` in `public/js/config.js`.

All weights and thresholds live in `public/js/config.js`. The scorer (`public/js/scoring.js`) is a pure function.

## Files

```
server.js              static files + feedback/admin API (no dependencies)
public/index.html      app shell
public/js/app.js       UI
public/js/data.js      Open-Meteo fetch → scored events
public/js/scoring.js   pure scoring + explanations
public/js/sun.js       solar position, golden/blue hour, horizon dip
public/js/geo.js       great-circle destination, compass names
public/js/stats.js     admin analytics + weight suggestion
public/js/store.js     localStorage + Sky Scout XP/badges
public/admin.html      admin dashboard
test/                  node:test suites
```

## Limitations

- Model cloud cover is a percentage over a grid several kilometers wide. It can't see cloud texture.
- Low-cloud forecasts are often wrong.
- Skill drops sharply beyond 48 hours.
- Expect roughly a 70% hit rate. The score is a guide, not a guarantee.
