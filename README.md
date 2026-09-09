# Draftor

Frontend-only Dota 2 draft assistant for captains-mode style 5v5 lineups.

## What it does

- Loads hero metadata from OpenDota in the browser, with a bundled local fallback.
- Lets you build the enemy team with five fixed role slots.
- Generates your five-role lineup automatically from the enemy draft.
- Scores recommendations with a deterministic model that balances counter value, synergy, and position fit.
- Uses a role-first constraint for support slots: non-carry support heroes are selected before counter strength is considered. A carry is only used if no eligible support hero exists.
- Prioritizes counter pressure against enemy cores in order: hard carry, mid lane, off lane, then soft and hard support.
- Shows whether the bundled local dataset matches the current Dota 2 patch.

## Run

```bash
npm run dev
```

Open the printed localhost URL in your browser.

## Deploy

This is a static site and can be deployed to GitHub Pages. Push the repository
to GitHub, set **Settings -> Pages -> Source** to **GitHub Actions**, then push
to `main`. The workflow in `.github/workflows/deploy.yml` publishes the site
automatically.

## Data sources

- `GET https://api.opendota.com/api/heroStats`
- `GET https://api.opendota.com/api/heroes/{hero_id}/matchups`
- `GET https://api.opendota.com/api/constants/patch`

The local dataset patch is declared in `data/local-manifest.json`. OpenDota's
latest patch is compared against it when the app starts. If the patch endpoint
is unavailable, the UI marks the live version as unverified instead of claiming
the local data is current.

The local hero fallback is stored in `data/local-heroes.json`. Matchup requests
fall back to `data/local-matchups.json`, which stores Valve's ranked hero matrix.
The app uses the all-ranks bucket and converts each `enemy_win_rate` entry into
the candidate hero's counter rate at runtime.

## Notes

- No backend required.
- No ML model required.
- The current UI is optimized for 5v5 draft evaluation, not single-hero counters.
