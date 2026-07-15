# 桜 Ichiran — 番組帳

A calm, minimal watchlist for anime you're watching, have finished, and plan to watch. Named after *ichiran* (一覧) — "an overview, a list at a glance."

Everything lives in your browser. No account, no server, no tracking — your list is yours.

![status](https://img.shields.io/badge/status-active-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Three-column board** — Watching / Completed / Plan to Watch, with live counts and progress bars per entry
- **MyAnimeList-powered search** — start typing a title and pull in cover art, episode count, and genres automatically
- **Import** from MyAnimeList XML export, AniList JSON export, CSV, or a Cour JSON backup
- **Export** your whole list as a JSON backup any time
- **Favorites** — pin the shows you care about most to the top of their column
- **Undo-able delete** — remove an entry with one tap, undo it for a few seconds after
- **"Pick something" button** — can't decide what to start next? Get a random pick from your queue
- **Fetch missing covers** — backfill poster art for anything imported without one
- **Fully responsive** — same experience on desktop and phone
- **Sort and search** across title, genre, and notes

## Running it locally

```bash
git clone https://github.com/<your-username>/cour.git
cd cour
python3 -m http.server 8080
```

Open **http://localhost:8080** — a local server is required so cover art can load correctly (opening `index.html` directly from disk will block the API requests).

## Importing your existing list

**From MyAnimeList:**
1. Go to [MAL → Export](https://myanimelist.net/panel.php?go=export)
2. Export your anime list as XML
3. Drop the file into Cour's Import modal — covers fetch automatically afterward

**From AniList:** export your list as JSON from AniList's settings, then import the same way.

**From a spreadsheet:** import a CSV with columns for title, status, score, episodes, and genres.

If some posters don't load automatically after import, use **Fetch missing covers** from the settings (⚙) menu.

## Data & privacy

Your list is stored entirely in this browser's `localStorage` under a single key — nothing is sent anywhere except:
- Requests to the public [Jikan API](https://jikan.moe/) (an unofficial MyAnimeList API) when searching titles or fetching cover art

Clearing your browser data will erase your list, so export a backup periodically if it matters to you.

## Tech

Plain HTML, CSS, and JavaScript — no framework, no build step, no dependencies to install. Fonts are M PLUS Rounded 1c (UI) and Shippori Mincho (accents), loaded from Google Fonts.

## Design

Neo-Japanese minimal: night-sky backdrop, drifting sakura petals, warm vermillion + gold accents against deep ink tones. Poster-forward cards, restrained palette, room to breathe.

## License

MIT — do whatever you'd like with it.
