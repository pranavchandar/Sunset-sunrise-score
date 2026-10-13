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

## Run it locally

```bash
ADMIN_TOKEN=choose-a-long-secret npm start   # http://localhost:3000, admin at /admin
npm test                                      # scoring, sun/geo, stats, API and storage tests
```

- Node 18 or newer. There are no dependencies.
- Locally, ratings go to `data/feedback.json` and tuned weights to `data/config.json`. You can change the folder with `DATA_DIR`.
- If `ADMIN_TOKEN` is not set, the server prints a random token at startup.

## Deploy for free on Render

The app and its API run as one Node web service on Render's free plan. The free plan's disk is wiped on every restart, so ratings are saved to your GitHub repo instead: a separate `sky-data` branch holds `data/feedback.json` and `data/config.json`, and every rating becomes a commit there.

1. **Make sure the code is on `main`.** Render deploys from the repo's default branch.
2. **Create a GitHub token.** Go to GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
   - Repository access: **Only select repositories** → this repo.
   - Permissions: **Contents → Read and write**. Nothing else.
   - Pick an expiry you're comfortable with. When it expires, ratings stop saving until you paste a new token into Render.
3. **Create the service.** On [render.com](https://render.com): New → **Blueprint** → connect this repo. Render reads `render.yaml`.
4. When asked for `GITHUB_TOKEN`, paste the token. Leave the other values as they are.
5. Deploy. The first start creates the `sky-data` branch.
6. **Get your admin password.** Open the service's **Environment** tab and copy `ADMIN_TOKEN` (Render generated it). Log in at `https://<your-app>.onrender.com/admin`.

Things to know about the free plan:

- The app sleeps after about 15 minutes without visitors. The next visit takes roughly 30–60 seconds to wake it.
- Ratings are safe while it sleeps. The server only confirms a rating after GitHub has saved it. If saving fails, the browser keeps the rating and retries later.
- `/api/health` shows whether storage is `github` or `file`. The admin page shows where ratings are stored.
- Never set `GITHUB_BRANCH` to the branch Render deploys from, or every rating would trigger a redeploy. The server refuses to start if it's set to the default branch.
- Each rating is about 1 KB. Files over 1 MB are read through GitHub's raw API (up to 100 MB). If the file ever grows very large, export it from the admin page and trim old ratings.

If the GitHub token is wrong, the app still runs and shows predictions, but ratings can't be saved yet. The browser keeps them and retries. The Render log and the admin page explain what's wrong:

- **`403 … can read … but not write`**: edit the token on GitHub (Settings → Developer settings → Fine-grained tokens → your token → Repository permissions) and set **Contents** to **Read and write**. The server reconnects by itself within a minute. No redeploy is needed.
- **`401`**: the token is invalid or expired. Paste a new one into Render's Environment tab; Render restarts the app.

Environment variables:

| Variable | Purpose |
|---|---|
| `ADMIN_TOKEN` | Password for `/admin` |
| `GITHUB_TOKEN`, `GITHUB_REPO` | Turn on GitHub storage (`owner/name`) |
| `GITHUB_BRANCH` | Data branch, default `sky-data` |
| `DATA_DIR` | Folder for file storage when GitHub storage is off |
| `PORT` | Set by the host |

The `public/` folder still works as a static site (for example, GitHub Pages) if you only want predictions. Ratings then stay in each visitor's browser.

## How the score works

| Component | Weight | Rule |
|---|---|---|
| Cloud Canvas (best of three places clouds can light up, see below) | 35 | 0 at 0%, ramps to 1 at 30%, stays at 1 up to 70%, falls to 0 at 100% |
| Light Path (horizon cloud toward the sun, HZ) | 30 | `(1 − HZ/100)^1.5` |
| Open Sky (low cloud overhead) | 15 | `1 − low/100` |
| Air Clarity (aerosol optical depth, AOD) | 10 | 0.8 below 0.1; 1 from 0.1 to 0.3; falls to 0.3 at 0.6; 0.1 above 0.6 |
| Dry Air (humidity and visibility) | 10 | −0.5 if RH > 85%; −0.5 if visibility < 5 km |

- **Cloud Canvas** takes the best of three places:
  - **Overhead:** max(high, mid).
  - **Toward the sun:** max(high, mid) 50–100 km toward the sun, ×0.6. This is a lit band near the horizon, pretty but less than a whole lit sky.
  - **Opposite the sun:** max(low, mid) 30–60 km away from the sun, ×0.4. This rises to ×0.6 for towering clouds, using the forecast's convective energy (CAPE, up to 1000 J/kg). These clouds catch the golden light side-on.

  All three need light to get through: their points are scaled by the Light Path factor.
- **HZ** is the weighted mean of `low + ½·mid` at 50, 100 and 200 km along the sun's azimuth, with weights 0.4, 0.35 and 0.25.
- **Modifiers:**
  - Rain at peak: ×0.3.
  - Clearing storm: +10.
  - Total cloud above 95%: score capped at 15.
  - Canvas limit: with little low cloud overhead, the score is capped at 35 + 65 × canvas factor. A sky with no clouds anywhere is capped at 35 (Empty Canvas). Less canvas means a lower cap, shown as Thin Canvas, Horizon Band or Side Glow depending on where the clouds are.
  - High Ground (observer altitude 150–1500 m): up to +6.
- **Departure from the handover spec.** Canvas points are multiplied by the Light Path factor, because sunlight has to cross the horizon before it can light the clouds overhead. Without this gate, "50% cirrus + 80% low cloud on the horizon" scores 73. The spec requires it to score below 45; with the gate it scores 41. Turn it off with `horizon.gatesCanvas` in `public/js/config.js`.

All weights and thresholds live in `public/js/config.js`. The scorer (`public/js/scoring.js`) is a pure function.

## Files

```
server.js              static files + feedback/admin API (no dependencies)
storage.js             file or GitHub-branch storage for ratings and weights
render.yaml            Render free-plan blueprint
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
