# ⛩️ 桜 Ichiran (一覧)

> **A calm, minimal anime watchlist that lives entirely in your browser.**

**Ichiran** (一覧) is a lightweight anime tracker for keeping up with what you're watching, what you've finished, and what you want to watch next. Built with plain HTML, CSS and JavaScript, it focuses on simplicity, speed and privacy—no accounts, no backend and no unnecessary clutter.

Everything is stored locally in your browser, so your watchlist stays yours.


## ✨ Features

* 🎬 **Three-column watchlist** — Organise anime into **Watching**, **Completed**, and **Plan to Watch**
* 📊 **Progress tracking** — Episode progress bars and live counters
* 🔍 **Smart anime search** — Search directly from **MyAnimeList** using the Jikan API
* 🖼️ **Automatic cover art** — Fetch posters, genres and episode counts instantly
* 📥 **Import existing lists**

  * MyAnimeList (XML)
  * AniList (JSON)
  * CSV
  * Cour JSON backups
* 📤 **Export backups** — Download your complete watchlist as JSON anytime
* ⭐ **Favorites** — Pin your favourite anime to the top
* ↩️ **Undo delete** — Accidentally removed something? Restore it within a few seconds
* 🎲 **Random picker** — Can't decide what to watch? Let Ichiran choose from your queue
* 🖼️ **Fetch missing covers** after importing
* 📱 **Responsive design** for desktop and mobile
* 🔎 **Search & filter** by title, genre and notes


## 🚀 Running Locally

Clone the repository

```bash
git clone https://github.com/supreetvardhamane/ichiran.git
```

Move into the project

```bash
cd ichiran
```

Start a local server

```bash
python3 -m http.server 8080
```

Then open:

```
http://localhost:8080
```

> **Note:** A local server is required because browsers block some API requests when opening `index.html` directly from the file system.


## 📥 Import Your Existing Library

Ichiran supports importing from multiple sources.

### 📺 MyAnimeList

1. Go to **MyAnimeList → Export**
2. Export your anime list as XML
3. Import it into Ichiran
4. Covers will be fetched automatically

### 📚 AniList

Export your library as **JSON** from AniList settings and import it into Ichiran.

### 📄 CSV

Import spreadsheets containing:

* Title
* Status
* Score
* Episodes
* Genres

If some posters are missing after importing, open **Settings (⚙)** and select **Fetch Missing Covers**.


## 🔒 Privacy

Your data never leaves your device.

Ichiran stores everything in your browser using **localStorage**.

The only network requests made are to the **Jikan API**, which is used for searching anime and retrieving poster artwork.

If you clear your browser data, your watchlist will be removed, so exporting occasional backups is recommended.


## 🛠 Tech Stack

* HTML5
* CSS3
* Vanilla JavaScript
* Jikan API
* LocalStorage

**Fonts**

* M PLUS Rounded 1c
* Shippori Mincho


## 🎨 Design Philosophy

Inspired by modern Japanese minimalism, Ichiran combines a calm night-sky aesthetic with subtle sakura petals, warm vermillion highlights and clean typography.

The interface stays out of the way so the focus remains on your anime collection.


## 📄 License

Released under the **MIT License**.

Feel free to use it, modify it and build upon it.


## ⭐ Support

If you enjoy the project, consider giving it a **⭐ on GitHub**.

It helps more than you might think 😊
