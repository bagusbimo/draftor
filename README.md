# Draftor

Frontend-only Dota 2 draft assistant for captains-mode style 5v5 lineups.

## What it does

- Loads hero metadata from OpenDota in the browser, with a bundled local fallback.
- Lets you build the enemy team with five fixed role slots.
- Generates your five-role lineup automatically from the enemy draft.
- Scores recommendations with a deterministic model that balances counter value, synergy, and position fit.
- Adds ability-specific counter explanations from a bundled Dota 2 Wiki snapshot; the browser never depends on Fandom at runtime.
- Uses a role-first constraint for support slots: non-carry support heroes are selected before counter strength is considered. A carry is only used if no eligible support hero exists.
- Prioritizes counter pressure against enemy cores in order: hard carry, mid lane, off lane, then soft and hard support.
- Shows whether the bundled local dataset matches the current Dota 2 patch.

## Data Mode

Use the **Matchup data** switch in the top-right corner:

- **Auto** uses OpenDota first and falls back to the bundled local dataset.
- **OpenDota** uses live OpenDota hero and matchup data only.
- **Local** uses the bundled hero and matchup files without requesting OpenDota.

The selected mode is saved in the browser for the next visit. Scraped counter
reasons remain bundled and are used in every mode.

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

## Refresh Counter Reasons

Counter explanations can be refreshed from the Dota 2 Wiki through its
MediaWiki API. This is a build-time operation and is not required to run the
browser app. Run it from the project root with network access:

```bash
yarn scrape:counters --patch=7.41e
```

This updates `data/counter-reasons.json`. The `--patch` value labels the local
snapshot, so replace `7.41e` when refreshing for a newer Dota 2 patch. The
scraper keeps source URLs for attribution, rate-limits requests, and stores
only concise extracted reasons.
It enumerates `Category:Counters`, reads each `/Counters` page, extracts the
`hero label` sections and ability-aware bullet points, then stores the result
as a static asset. The generated snapshot should be refreshed when the local
patch data is refreshed.

## Data sources

- `GET https://api.opendota.com/api/heroStats`
- `GET https://api.opendota.com/api/heroes/{hero_id}/matchups`
- `GET https://api.opendota.com/api/constants/patch`
- Dota 2 Wiki / Fandom counter pages, captured at build time in `data/counter-reasons.json`

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
