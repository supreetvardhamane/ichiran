/**
 * 番組帳 · Anime Log
 * Watchlist + MAL/AniList import with cover enrichment
 */

(function () {
  "use strict";

  const STORAGE_KEY = "anime_log_v2";
  const JIKAN = "https://api.jikan.moe/v4";
  // Jikan: be polite — ~2.5 req/s safe
  const COVER_DELAY_MS = 400;

  const STATUS = {
    watching: { label: "Watching", jp: "視聴中", short: "Watching" },
    completed: { label: "Completed", jp: "完了", short: "Done" },
    planned: { label: "Plan to watch", jp: "見たい", short: "Queue" },
  };
  const STATUS_ORDER = ["watching", "completed", "planned"];

  const MAL_STATUS = {
    1: "watching",
    2: "completed",
    3: "planned",
    4: "planned",
    6: "planned",
  };

  const ANILIST_STATUS = {
    CURRENT: "watching",
    REPEATING: "watching",
    COMPLETED: "completed",
    PLANNING: "planned",
    PAUSED: "planned",
    DROPPED: "planned",
  };

  let animeList = [];
  let filter = "all";
  let sortBy = "updated";
  let searchQuery = "";
  let toastTimer = null;
  let lastDeleted = null; // { entry, index } — cleared once undo window passes
  let searchTimer = null;
  let searchAbort = null;
  let coverJob = null; // AbortController for cover fetch

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const board = $("#board");
  const emptyGlobal = $("#emptyGlobal");
  const searchInput = $("#searchInput");
  const sortSelect = $("#sortSelect");
  const modalOverlay = $("#modalOverlay");
  const importOverlay = $("#importOverlay");
  const animeForm = $("#animeForm");
  const modalTitle = $("#modalTitle");
  const modalKicker = $("#modalKicker");
  const toast = $("#toast");
  const searchResults = $("#searchResults");
  const dropzone = $("#dropzone");
  const importFile = $("#importFile");
  const importStatus = $("#importStatus");
  const coverProgress = $("#coverProgress");
  const coverProgressFill = $("#coverProgressFill");
  const coverProgressText = $("#coverProgressText");

  // ─── Utils ───
  function uid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      try {
        return crypto.randomUUID();
      } catch (_) {}
    }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 11);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function clampNum(val, min, max) {
    const n = Number(val);
    if (!Number.isFinite(n) || n < min) return 0;
    return Math.min(Math.floor(n), max);
  }

  function parseGenres(str) {
    if (!str) return [];
    if (Array.isArray(str)) {
      return str.map((g) => String(g).trim()).filter(Boolean).slice(0, 10);
    }
    return String(str)
      .split(/[,;/|]/)
      .map((g) => g.trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  function normalizeStatus(raw) {
    if (raw == null || raw === "") return "planned";
    const s = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, "");
    if (["watching", "current", "currentlywatching", "watch"].includes(s)) return "watching";
    if (["completed", "complete", "finished", "done", "watched"].includes(s)) return "completed";
    if (
      ["planned", "plantowatch", "ptw", "planning", "wanttowatch", "queue", "onhold", "paused", "dropped"].includes(s)
    ) {
      return "planned";
    }
    const n = Number(raw);
    if (Number.isFinite(n) && MAL_STATUS[n] != null) return MAL_STATUS[n];
    if (ANILIST_STATUS[String(raw).toUpperCase()]) return ANILIST_STATUS[String(raw).toUpperCase()];
    return "planned";
  }

  function pickMalId(item) {
    const raw =
      item.malId ??
      item.mal_id ??
      item.series_animedb_id ??
      item.seriesAnimeDbId ??
      item.anime_id ??
      item.media?.idMal ??
      null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function normalizeEntry(item) {
    const title =
      item.title ||
      item.series_title ||
      item.animeTitle ||
      item.name ||
      item.mediaTitle ||
      (item.media &&
        (item.media.title?.userPreferred ||
          item.media.title?.romaji ||
          item.media.title?.english)) ||
      "";
    if (!String(title).trim()) return null;

    const status = normalizeStatus(
      item.status ?? item.my_status ?? item.list_status ?? item.watchStatus ?? item.mediaListEntry?.status
    );

    let rating = item.rating ?? item.score ?? item.my_score ?? item.myScore ?? null;
    if (rating === "" || rating === 0 || rating === "0") rating = null;
    if (rating != null) {
      rating = Number(rating);
      if (rating > 10 && rating <= 100) rating = Math.round(rating / 10);
      if (!Number.isFinite(rating) || rating < 1) rating = null;
      else rating = Math.min(10, Math.max(1, Math.round(rating)));
    }

    const episodesWatched = clampNum(
      item.episodesWatched ??
        item.num_watched_episodes ??
        item.my_watched_episodes ??
        item.progress ??
        item.watched ??
        0,
      0,
      9999
    );
    const episodesTotal = clampNum(
      item.episodesTotal ?? item.series_episodes ?? item.episodes ?? item.media?.episodes ?? 0,
      0,
      9999
    );

    let genres = item.genres ?? item.genre ?? [];
    if (typeof genres === "string") genres = parseGenres(genres);
    else if (Array.isArray(genres)) {
      genres = genres
        .map((g) => (typeof g === "string" ? g : g?.name || g?.title || ""))
        .filter(Boolean);
    }

    const coverUrl =
      item.coverUrl ||
      item.image_url ||
      item.imageUrl ||
      item.coverImage ||
      item.media?.coverImage?.large ||
      item.media?.coverImage?.medium ||
      "";

    const now = Date.now();
    return {
      id: item.id && String(item.id).length < 80 ? String(item.id) : uid(),
      title: String(title).trim().slice(0, 160),
      status,
      rating,
      episodesWatched,
      episodesTotal,
      genres: parseGenres(genres),
      coverUrl: String(coverUrl || "").slice(0, 800),
      notes: String(item.notes || item.comments || item.my_comments || item.my_tags || "").slice(0, 600),
      malId: pickMalId(item),
      favorite: !!(item.favorite ?? item.isFavourite ?? item.is_favorite),
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
    };
  }

  function titleKey(t) {
    return String(t || "")
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]+/g, "");
  }

  // ─── Storage ───
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          animeList = parsed.map(normalizeEntry).filter(Boolean);
          return;
        }
      }
      const old = localStorage.getItem("animevault_v1");
      if (old) {
        const parsed = JSON.parse(old);
        if (Array.isArray(parsed) && parsed.length) {
          animeList = parsed.map(normalizeEntry).filter(Boolean);
          save();
          return;
        }
      }
      animeList = [];
    } catch (err) {
      console.error(err);
      animeList = [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(animeList));
      return true;
    } catch (err) {
      console.error(err);
      showToast("Could not save — storage full?");
      return false;
    }
  }

  // ─── CRUD ───
  function createAnime(data) {
    const entry = normalizeEntry({
      ...data,
      id: uid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (!entry) return null;
    animeList.unshift(entry);
    save();
    return entry;
  }

  function updateAnime(id, data) {
    const idx = animeList.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const entry = normalizeEntry({
      ...animeList[idx],
      ...data,
      id,
      malId: data.malId != null ? data.malId : animeList[idx].malId,
      createdAt: animeList[idx].createdAt,
      updatedAt: Date.now(),
    });
    if (!entry) return null;
    animeList[idx] = entry;
    save();
    return entry;
  }

  function deleteAnime(id) {
    animeList = animeList.filter((a) => a.id !== id);
    save();
  }

  function deleteAnimeWithUndo(id) {
    const index = animeList.findIndex((a) => a.id === id);
    if (index === -1) return;
    const entry = animeList[index];
    animeList.splice(index, 1);
    save();
    lastDeleted = { entry, index };
    render();
    showToast(`Removed "${entry.title}"`, {
      label: "Undo",
      onClick: () => {
        if (!lastDeleted) return;
        const { entry: restored, index: at } = lastDeleted;
        animeList.splice(Math.min(at, animeList.length), 0, restored);
        lastDeleted = null;
        save();
        render();
        showToast(`Restored "${restored.title}"`);
      },
    });
  }

  function toggleFavorite(id) {
    const item = animeList.find((a) => a.id === id);
    if (!item) return;
    item.favorite = !item.favorite;
    item.updatedAt = Date.now();
    save();
    return item.favorite;
  }

  function moveAnime(id, status) {
    const item = animeList.find((a) => a.id === id);
    if (!item || item.status === status) return;
    item.status = status;
    item.updatedAt = Date.now();
    if (status === "completed" && item.episodesTotal > 0) {
      item.episodesWatched = item.episodesTotal;
    }
    save();
  }

  // ─── Cover enrichment (Jikan) ───
  function needsCover(a) {
    return a && !a.coverUrl;
  }

  function showCoverProgress(done, total, label) {
    coverProgress.classList.remove("hidden");
    const pct = total ? Math.round((done / total) * 100) : 0;
    coverProgressFill.style.width = pct + "%";
    coverProgressText.textContent = label || `Fetching covers ${done}/${total}`;
  }

  function hideCoverProgress() {
    coverProgress.classList.add("hidden");
    coverProgressFill.style.width = "0%";
  }

  async function fetchCoverByMalId(malId, signal) {
    const res = await fetch(`${JIKAN}/anime/${malId}`, { signal });
    if (res.status === 429) {
      await sleep(1500);
      return fetchCoverByMalId(malId, signal);
    }
    if (!res.ok) throw new Error("jikan " + res.status);
    const json = await res.json();
    const d = json.data;
    if (!d) return null;
    return {
      coverUrl:
        d.images?.jpg?.large_image_url ||
        d.images?.jpg?.image_url ||
        d.images?.webp?.large_image_url ||
        "",
      episodesTotal: d.episodes || 0,
      genres: (d.genres || []).map((g) => g.name),
      title: d.title_english || d.title || null,
    };
  }

  async function fetchCoverByTitle(title, signal) {
    const url = `${JIKAN}/anime?q=${encodeURIComponent(title)}&limit=1&sfw=true`;
    const res = await fetch(url, { signal });
    if (res.status === 429) {
      await sleep(1500);
      return fetchCoverByTitle(title, signal);
    }
    if (!res.ok) throw new Error("jikan search " + res.status);
    const json = await res.json();
    const d = (json.data || [])[0];
    if (!d) return null;
    return {
      coverUrl:
        d.images?.jpg?.large_image_url ||
        d.images?.jpg?.image_url ||
        "",
      episodesTotal: d.episodes || 0,
      genres: (d.genres || []).map((g) => g.name),
      malId: d.mal_id || null,
    };
  }

  /**
   * Fill missing cover images (and optional metadata) for entries.
   * Prefers MAL id; falls back to title search.
   */
  async function enrichCovers(options = {}) {
    const { onlyIds = null, allowTitleSearch = true } = options;

    if (coverJob) {
      try {
        coverJob.abort();
      } catch (_) {}
    }
    coverJob = new AbortController();
    const { signal } = coverJob;

    let targets = animeList.filter(needsCover);
    if (onlyIds) {
      const set = new Set(onlyIds);
      targets = animeList.filter((a) => set.has(a.id) && needsCover(a));
    }

    // Prefer those with malId first (more accurate)
    targets.sort((a, b) => {
      const am = a.malId ? 0 : 1;
      const bm = b.malId ? 0 : 1;
      return am - bm;
    });

    if (!targets.length) {
      showToast("All covers are already set");
      return { filled: 0, failed: 0 };
    }

    let filled = 0;
    let failed = 0;
    const total = targets.length;
    showCoverProgress(0, total);

    for (let i = 0; i < targets.length; i++) {
      if (signal.aborted) break;
      const entry = targets[i];
      // re-find in live list (may have been edited)
      const live = animeList.find((a) => a.id === entry.id);
      if (!live || live.coverUrl) {
        showCoverProgress(i + 1, total);
        continue;
      }

      showCoverProgress(i, total, `Cover ${i + 1}/${total} · ${live.title.slice(0, 28)}`);

      try {
        let meta = null;
        if (live.malId) {
          meta = await fetchCoverByMalId(live.malId, signal);
        } else if (allowTitleSearch) {
          meta = await fetchCoverByTitle(live.title, signal);
        }

        if (meta && meta.coverUrl) {
          live.coverUrl = meta.coverUrl;
          if (!live.episodesTotal && meta.episodesTotal) {
            live.episodesTotal = meta.episodesTotal;
          }
          if ((!live.genres || !live.genres.length) && meta.genres?.length) {
            live.genres = meta.genres.slice(0, 8);
          }
          if (!live.malId && meta.malId) live.malId = meta.malId;
          live.updatedAt = Date.now();
          filled++;
          // live update card image if present
          updateCardCover(live.id, live.coverUrl);
        } else {
          failed++;
        }
      } catch (err) {
        if (err.name === "AbortError") break;
        console.warn("cover fail", live.title, err);
        failed++;
      }

      showCoverProgress(i + 1, total);
      save();
      await sleep(COVER_DELAY_MS);
    }

    hideCoverProgress();
    coverJob = null;
    render();
    return { filled, failed, total };
  }

  function updateCardCover(id, url) {
    const card = Array.from(board.querySelectorAll(".anime-card")).find((el) => el.dataset.id === id);
    if (!card) return;
    const art = card.querySelector(".card-art");
    if (!art) return;
    art.innerHTML = `<img src="${escapeAttr(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  }

  // ─── Filter / sort ───
  function getFiltered(status) {
    let list = animeList.filter((a) => a.status === status);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter((a) => {
        const hay = [a.title, a.notes, ...(a.genres || [])].join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    return sortList(list);
  }

  function sortList(list) {
    const copy = [...list];
    switch (sortBy) {
      case "title":
        copy.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "rating":
        copy.sort((a, b) => (b.rating || 0) - (a.rating || 0));
        break;
      case "added":
        copy.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        break;
      default:
        copy.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    copy.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
    return copy;
  }

  // ─── Render ───
  function render() {
    updateStats();
    board.innerHTML = "";
    board.classList.toggle("single-col", filter !== "all");

    const showStatuses = filter === "all" ? STATUS_ORDER : [filter];

    for (const status of STATUS_ORDER) {
      const items = getFiltered(status);
      const show = showStatuses.includes(status);
      const col = document.createElement("div");
      // minmax columns: show only active filter columns
      col.className = "column" + (show ? "" : " hidden-col");
      col.dataset.status = status;
      col.innerHTML = `
        <div class="column-head">
          <div class="column-title">
            <span class="jp-tag">${STATUS[status].jp}</span>
            ${STATUS[status].label}
          </div>
          <span class="column-count">${items.length}</span>
        </div>
        <div class="column-body"></div>
      `;
      const body = $(".column-body", col);
      if (!items.length) {
        body.innerHTML = `<p class="column-empty">Empty shelf · 空っぽ</p>`;
      } else {
        items.forEach((a) => body.appendChild(renderCard(a)));
      }
      board.appendChild(col);
    }

    const totalMatch = STATUS_ORDER.reduce((n, s) => n + getFiltered(s).length, 0);

    if (!animeList.length) {
      emptyGlobal.classList.remove("hidden");
      emptyGlobal.innerHTML =
        "Your list is empty. Hit <strong>Add Anime</strong> or <strong>Import</strong> to begin.";
      board.classList.add("hidden");
    } else if (searchQuery && totalMatch === 0) {
      emptyGlobal.classList.remove("hidden");
      emptyGlobal.innerHTML = `No matches for “${escapeHtml(searchQuery)}”.`;
      board.classList.add("hidden");
    } else {
      emptyGlobal.classList.add("hidden");
      board.classList.remove("hidden");
    }
  }

  function renderCard(anime) {
    const card = document.createElement("article");
    card.className = "anime-card" + (anime.favorite ? " is-favorite" : "");
    card.dataset.id = anime.id;

    const pct =
      anime.episodesTotal > 0
        ? Math.min(100, Math.round((anime.episodesWatched / anime.episodesTotal) * 100))
        : 0;

    const genres = (anime.genres || [])
      .slice(0, 3)
      .map((g) => `<span class="tag">${escapeHtml(g)}</span>`)
      .join("");

    // Horizontal layout: cover left (fixed width) + content right
    const art = anime.coverUrl
      ? `<img src="${escapeAttr(anime.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'" />
         <span class="card-art-fallback">桜</span>`
      : `<span class="card-art-fallback">桜</span>`;

    const moves = STATUS_ORDER.filter((s) => s !== anime.status)
      .map(
        (s) =>
          `<button type="button" class="chip" data-action="move" data-status="${s}">→ ${STATUS[s].short}</button>`
      )
      .join("");

    card.innerHTML = `
      <div class="card-row">
        <div class="card-art">${art}</div>
        <div class="card-main">
          <div class="card-title-row">
            <h3 class="card-title" title="${escapeAttr(anime.title)}">${escapeHtml(anime.title)}</h3>
            <button type="button" class="fav-btn${anime.favorite ? " active" : ""}" data-action="favorite" title="${anime.favorite ? "Unpin favorite" : "Mark as favorite"}">${anime.favorite ? "★" : "☆"}</button>
          </div>
          <div class="card-meta">
            ${anime.rating ? `<span class="card-score">★ ${anime.rating}</span>` : ""}
            ${
              anime.episodesTotal || anime.episodesWatched
                ? `<span class="card-eps">${anime.episodesWatched}${
                    anime.episodesTotal ? " / " + anime.episodesTotal : ""
                  } ep</span>`
                : ""
            }
          </div>
          ${anime.episodesTotal > 0 ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ""}
          ${genres ? `<div class="tags">${genres}</div>` : ""}
          ${anime.notes ? `<p class="card-notes">${escapeHtml(anime.notes)}</p>` : ""}
          <div class="card-actions">
            <button type="button" class="chip" data-action="edit">Edit</button>
            ${moves}
            <button type="button" class="chip danger" data-action="delete">Remove</button>
          </div>
        </div>
      </div>
    `;

    $$("[data-action]", card).forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === "edit") openModal(anime.id);
        else if (action === "delete") deleteAnimeWithUndo(anime.id);
        else if (action === "favorite") {
          const isFav = toggleFavorite(anime.id);
          render();
          showToast(isFav ? `Pinned "${anime.title}"` : `Unpinned "${anime.title}"`);
        } else if (action === "move") {
          moveAnime(anime.id, btn.dataset.status);
          showToast(`Moved → ${STATUS[btn.dataset.status].short}`);
          render();
        }
      });
    });

    return card;
  }

  function updateStats() {
    const counts = { watching: 0, completed: 0, planned: 0 };
    animeList.forEach((a) => {
      if (counts[a.status] != null) counts[a.status]++;
    });
    $("#statWatching").textContent = counts.watching;
    $("#statCompleted").textContent = counts.completed;
    $("#statPlanned").textContent = counts.planned;
    $("#statTotal").textContent = animeList.length;
  }

  // ─── Modals ───
  function openModal(id) {
    animeForm.reset();
    $("#animeId").value = "";
    hideSearchResults();

    if (id) {
      const anime = animeList.find((a) => a.id === id);
      if (!anime) return;
      modalTitle.textContent = "Edit Anime";
      modalKicker.textContent = "編集";
      $("#animeId").value = anime.id;
      $("#title").value = anime.title;
      $("#status").value = anime.status;
      $("#rating").value = anime.rating || "";
      $("#episodesWatched").value = anime.episodesWatched || "";
      $("#episodesTotal").value = anime.episodesTotal || "";
      $("#genres").value = (anime.genres || []).join(", ");
      $("#coverUrl").value = anime.coverUrl || "";
      $("#notes").value = anime.notes || "";
      animeForm.dataset.malId = anime.malId || "";
    } else {
      modalTitle.textContent = "Add Anime";
      modalKicker.textContent = "新規追加";
      animeForm.dataset.malId = "";
      if (filter !== "all" && STATUS[filter]) $("#status").value = filter;
    }

    modalOverlay.classList.remove("hidden");
    setTimeout(() => $("#title").focus(), 40);
  }

  function closeModal() {
    modalOverlay.classList.add("hidden");
    hideSearchResults();
    if (searchAbort) {
      try {
        searchAbort.abort();
      } catch (_) {}
      searchAbort = null;
    }
  }

  function closeSettingsMenu() {
    const menu = $("#settingsMenu");
    const btn = $("#settingsBtn");
    if (menu) menu.classList.add("hidden");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function pickRandomAnime() {
    const queue = animeList.filter((a) => a.status === "planned");
    if (!queue.length) {
      showToast("Your queue is empty — add something first");
      return;
    }
    const pick = queue[Math.floor(Math.random() * queue.length)];

    // Make sure we're looking at the Plan to Watch column, then reveal the pick
    if (filter !== "all" && filter !== "planned") {
      filter = "planned";
      $$(".nav-pill").forEach((p) => p.classList.toggle("active", p.dataset.filter === filter));
    }
    render();

    requestAnimationFrame(() => {
      const card = board.querySelector(`.anime-card[data-id="${pick.id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("pulse-highlight");
        setTimeout(() => card.classList.remove("pulse-highlight"), 2400);
      }
    });

    showToast(`How about: "${pick.title}"?`);
  }

  function openImport() {
    importStatus.classList.add("hidden");
    importStatus.textContent = "";
    importOverlay.classList.remove("hidden");
  }

  function closeImport() {
    importOverlay.classList.add("hidden");
  }

  // ─── Jikan title search (add form) ───
  function hideSearchResults() {
    searchResults.classList.add("hidden");
    searchResults.innerHTML = "";
  }

  async function searchAnimeAPI(query) {
    if (searchAbort) {
      try {
        searchAbort.abort();
      } catch (_) {}
    }
    searchAbort = new AbortController();
    searchResults.classList.remove("hidden");
    searchResults.innerHTML = `<div class="search-loading">Searching…</div>`;

    try {
      const url = `${JIKAN}/anime?q=${encodeURIComponent(query)}&limit=6&sfw=true`;
      const res = await fetch(url, { signal: searchAbort.signal });
      if (!res.ok) throw new Error("API " + res.status);
      const data = await res.json();
      const results = data.data || [];
      if (!results.length) {
        searchResults.innerHTML = `<div class="search-empty">No results — type freely and save.</div>`;
        return;
      }
      searchResults.innerHTML = "";
      results.forEach((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "search-hit";
        btn.setAttribute("role", "option");
        const img = item.images?.jpg?.image_url || "";
        const title = item.title_english || item.title || "Untitled";
        const year = item.year || item.aired?.prop?.from?.year || "";
        const eps = item.episodes || "?";
        btn.innerHTML = `
          ${
            img
              ? `<img src="${escapeAttr(img)}" alt="" referrerpolicy="no-referrer" />`
              : `<span style="width:36px;height:50px;background:#16101f;border-radius:4px;flex-shrink:0"></span>`
          }
          <span class="search-hit-info">
            <span class="search-hit-title">${escapeHtml(title)}</span>
            <span class="search-hit-meta">${year ? year + " · " : ""}${eps} ep</span>
          </span>
        `;
        btn.addEventListener("click", () => applySearchHit(item));
        searchResults.appendChild(btn);
      });
    } catch (err) {
      if (err.name === "AbortError") return;
      searchResults.innerHTML = `<div class="search-empty">Search offline — enter a title manually.</div>`;
    }
  }

  function applySearchHit(item) {
    const title = item.title_english || item.title || "";
    $("#title").value = title;
    if (item.episodes) $("#episodesTotal").value = item.episodes;
    if (item.genres?.length) {
      $("#genres").value = item.genres.map((g) => g.name).join(", ");
    }
    const img = item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || "";
    if (img) $("#coverUrl").value = img;
    if (item.mal_id) animeForm.dataset.malId = String(item.mal_id);
    hideSearchResults();
    showToast("Details filled — set status & save");
  }

  function showToast(msg, action) {
    toast.innerHTML = "";
    const msgEl = document.createElement("span");
    msgEl.className = "toast-msg";
    msgEl.textContent = msg;
    toast.appendChild(msgEl);

    if (action && action.label && action.onClick) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        clearTimeout(toastTimer);
        toast.classList.add("hidden");
        action.onClick();
      });
      toast.appendChild(btn);
    }

    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add("hidden");
      if (action) lastDeleted = null;
    }, action ? 5000 : 2800);
  }

  // ─── Export ───
  function exportData() {
    const blob = new Blob([JSON.stringify(animeList, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `anime-log-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Exported");
  }

  // ─── Import parsers ───
  function parseXML(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid XML");

    const animeNodes = doc.querySelectorAll("anime");
    if (animeNodes.length) {
      return Array.from(animeNodes).map((node) => {
        const get = (tag) => node.querySelector(tag)?.textContent?.trim() || "";
        return {
          title: get("series_title") || get("animeTitle"),
          my_status: get("my_status"),
          my_score: get("my_score"),
          my_watched_episodes: get("my_watched_episodes"),
          series_episodes: get("series_episodes"),
          series_animedb_id: get("series_animedb_id"),
          my_comments: get("my_comments"),
          my_tags: get("my_tags"),
        };
      });
    }

    const entries = doc.querySelectorAll("entry, item, animeEntry");
    if (entries.length) {
      return Array.from(entries).map((node) => {
        const get = (tag) => node.querySelector(tag)?.textContent?.trim() || "";
        return {
          title: get("title") || get("name") || get("series_title"),
          status: get("status") || get("my_status"),
          score: get("score") || get("my_score") || get("rating"),
          episodesWatched: get("progress") || get("watched") || get("my_watched_episodes"),
          episodesTotal: get("episodes") || get("series_episodes"),
          series_animedb_id: get("series_animedb_id") || get("mal_id") || get("id"),
        };
      });
    }

    throw new Error("No anime entries found in XML");
  }

  function parseJSON(text) {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.animeList)) return data.animeList;
    if (Array.isArray(data.anime)) return data.anime;
    if (Array.isArray(data.list)) return data.list;

    if (Array.isArray(data.lists)) {
      const out = [];
      data.lists.forEach((list) => {
        (list.entries || list.mediaList || []).forEach((e) => {
          out.push({
            ...e,
            status: e.status || list.name || list.status,
            title:
              e.title ||
              e.media?.title?.userPreferred ||
              e.media?.title?.romaji ||
              e.media?.title?.english,
            score: e.score,
            progress: e.progress,
            episodes: e.media?.episodes,
            coverImage: e.media?.coverImage?.large || e.media?.coverImage?.medium,
            genres: e.media?.genres,
            mal_id: e.media?.idMal,
          });
        });
      });
      if (out.length) return out;
    }

    if (Array.isArray(data.data?.MediaListCollection?.lists)) {
      return parseJSON(JSON.stringify({ lists: data.data.MediaListCollection.lists }));
    }

    if (data && typeof data === "object") {
      const vals = Object.values(data);
      if (vals.length && vals.every((v) => v && typeof v === "object" && (v.title || v.series_title))) {
        return vals;
      }
    }

    throw new Error("Unrecognized JSON format");
  }

  function parseCSV(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error("CSV needs a header row and data");

    const split = (line) => {
      const cells = [];
      let cur = "";
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else inQ = !inQ;
        } else if (ch === "," && !inQ) {
          cells.push(cur.trim());
          cur = "";
        } else cur += ch;
      }
      cells.push(cur.trim());
      return cells;
    };

    const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/[\s_]+/g, ""));
    const find = (...names) => {
      for (const n of names) {
        const i = headers.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };

    const iTitle = find("title", "seriestitle", "animetitle", "name", "anime");
    if (iTitle < 0) throw new Error("CSV missing a title column");

    const iStatus = find("status", "mystatus", "watchstatus", "liststatus");
    const iScore = find("score", "rating", "myscore");
    const iWatched = find("episodeswatched", "watched", "progress", "mywatchedepisodes", "eps");
    const iTotal = find("episodestotal", "episodes", "seriesepisodes", "totalepisodes");
    const iGenres = find("genres", "genre", "tags");
    const iNotes = find("notes", "comments", "comment");
    const iCover = find("coverurl", "image", "cover", "imageurl");
    const iMal = find("malid", "mal_id", "id", "seriesanimedbid");

    return lines.slice(1).map((line) => {
      const cells = split(line);
      return {
        title: cells[iTitle] || "",
        status: iStatus >= 0 ? cells[iStatus] : "",
        score: iScore >= 0 ? cells[iScore] : "",
        episodesWatched: iWatched >= 0 ? cells[iWatched] : "",
        episodesTotal: iTotal >= 0 ? cells[iTotal] : "",
        genres: iGenres >= 0 ? cells[iGenres] : "",
        notes: iNotes >= 0 ? cells[iNotes] : "",
        coverUrl: iCover >= 0 ? cells[iCover] : "",
        series_animedb_id: iMal >= 0 ? cells[iMal] : "",
      };
    });
  }

  function detectAndParse(text, fileName) {
    const name = (fileName || "").toLowerCase();
    const trimmed = text.trim();

    if (
      name.endsWith(".xml") ||
      trimmed.startsWith("<?xml") ||
      trimmed.startsWith("<myanimelist") ||
      trimmed.startsWith("<anime")
    ) {
      return parseXML(trimmed);
    }
    if (name.endsWith(".csv") || (trimmed.includes(",") && !trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      const first = trimmed.split(/\r?\n/)[0].toLowerCase();
      if (first.includes("title") || first.includes("anime") || name.endsWith(".csv")) {
        return parseCSV(trimmed);
      }
    }
    if (name.endsWith(".json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return parseJSON(trimmed);
    }
    try {
      return parseXML(trimmed);
    } catch (_) {}
    try {
      return parseJSON(trimmed);
    } catch (_) {}
    return parseCSV(trimmed);
  }

  function applyImport(rawItems, mode) {
    const cleaned = rawItems.map(normalizeEntry).filter(Boolean);
    if (!cleaned.length) throw new Error("No valid anime found in file");

    let addedIds = [];

    if (mode === "replace") {
      animeList = cleaned.map((e) => {
        const neu = { ...e, id: uid() };
        return neu;
      });
      addedIds = animeList.map((a) => a.id);
      save();
      render();
      return { total: cleaned.length, added: cleaned.length, skipped: 0, addedIds };
    }

    const existing = new Map(animeList.map((a) => [titleKey(a.title), a]));
    let added = 0;
    let skipped = 0;
    cleaned.forEach((entry) => {
      const key = titleKey(entry.title);
      if (existing.has(key)) {
        // upgrade malId / cover on existing if missing
        const ex = existing.get(key);
        let touched = false;
        if (!ex.malId && entry.malId) {
          ex.malId = entry.malId;
          touched = true;
        }
        if (!ex.coverUrl && entry.coverUrl) {
          ex.coverUrl = entry.coverUrl;
          touched = true;
        }
        if (touched) {
          ex.updatedAt = Date.now();
          addedIds.push(ex.id);
        }
        skipped++;
        return;
      }
      const neu = { ...entry, id: uid(), createdAt: Date.now(), updatedAt: Date.now() };
      animeList.unshift(neu);
      existing.set(key, neu);
      addedIds.push(neu.id);
      added++;
    });
    save();
    render();
    return { total: cleaned.length, added, skipped, addedIds };
  }

  async function handleImportFile(file) {
    if (!file) return;
    importStatus.classList.remove("hidden", "error");
    importStatus.textContent = `Reading ${file.name}…`;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = String(reader.result || "");
        const raw = detectAndParse(text, file.name);
        const mode = document.querySelector('input[name="importMode"]:checked')?.value || "merge";
        const result = applyImport(raw, mode);

        const needCovers = animeList.filter(
          (a) => result.addedIds.includes(a.id) && needsCover(a)
        ).length;

        importStatus.classList.remove("error");
        importStatus.textContent =
          mode === "replace"
            ? `Loaded ${result.added} titles. Fetching covers…`
            : `Added ${result.added}, skipped ${result.skipped}. Fetching covers…`;

        showToast(
          mode === "replace" ? `Loaded ${result.added}` : `Added ${result.added} · ${result.skipped} dups`
        );

        closeImport();

        // Auto-fetch posters for imported entries missing covers
        if (needCovers > 0 || animeList.some((a) => result.addedIds.includes(a.id) && needsCover(a))) {
          const { filled, failed } = await enrichCovers({
            onlyIds: result.addedIds,
            allowTitleSearch: true,
          });
          if (filled > 0) showToast(`Covers loaded: ${filled}${failed ? ` · ${failed} missed` : ""}`);
          else if (failed > 0) showToast("Could not load some covers — try Fetch missing covers");
        }
      } catch (err) {
        console.error(err);
        importStatus.classList.add("error");
        importStatus.textContent =
          "Import failed: " + (err.message || "unknown") + ". Use MAL XML, AniList JSON, or CSV.";
        showToast("Import failed");
      }
    };
    reader.onerror = () => {
      importStatus.classList.add("error");
      importStatus.textContent = "Could not read that file.";
    };
    reader.readAsText(file);
  }

  // ─── Events ───
  function bindEvents() {
    $("#addAnimeBtn").addEventListener("click", (e) => {
      e.preventDefault();
      openModal(null);
    });
    $("#fabAddBtn").addEventListener("click", (e) => {
      e.preventDefault();
      openModal(null);
    });
    $("#closeModal").addEventListener("click", closeModal);
    $("#cancelModal").addEventListener("click", closeModal);
    $("#importListBtn").addEventListener("click", openImport);
    $("#closeImport").addEventListener("click", closeImport);
    $("#exportBtn").addEventListener("click", exportData);
    $("#browseImportBtn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      importFile.click();
    });
    dropzone.addEventListener("click", (e) => {
      if (e.target.closest("#browseImportBtn")) return;
      importFile.click();
    });

    importFile.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleImportFile(file);
      e.target.value = "";
    });

    ["dragenter", "dragover"].forEach((ev) => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
      });
    });
    dropzone.addEventListener("drop", (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) handleImportFile(file);
    });

    $("#clearDataBtn").addEventListener("click", () => {
      closeSettingsMenu();
      if (!animeList.length) {
        showToast("List is already empty");
        return;
      }
      if (confirm("Delete your entire list from this browser?")) {
        if (coverJob) {
          try {
            coverJob.abort();
          } catch (_) {}
        }
        animeList = [];
        save();
        render();
        showToast("List cleared");
      }
    });

    $("#fetchCoversBtn").addEventListener("click", async () => {
      closeSettingsMenu();
      const missing = animeList.filter(needsCover).length;
      if (!missing) {
        showToast("All covers are already set");
        return;
      }
      showToast(`Fetching ${missing} covers…`);
      const { filled, failed } = await enrichCovers({ allowTitleSearch: true });
      showToast(`Done — ${filled} covers${failed ? `, ${failed} failed` : ""}`);
    });

    const settingsBtn = $("#settingsBtn");
    const settingsMenu = $("#settingsMenu");
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = settingsMenu.classList.contains("hidden");
      settingsMenu.classList.toggle("hidden", !willOpen);
      settingsBtn.setAttribute("aria-expanded", String(willOpen));
    });
    document.addEventListener("click", (e) => {
      if (!settingsMenu.classList.contains("hidden") && !e.target.closest(".settings-wrap")) {
        closeSettingsMenu();
      }
    });

    $("#pickRandomBtn").addEventListener("click", pickRandomAnime);

    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) closeModal();
    });
    importOverlay.addEventListener("click", (e) => {
      if (e.target === importOverlay) closeImport();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!importOverlay.classList.contains("hidden")) closeImport();
        else if (!modalOverlay.classList.contains("hidden")) closeModal();
        else closeSettingsMenu();
      }
    });

    animeForm.addEventListener("submit", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const title = ($("#title").value || "").trim();
        if (!title) {
          $("#title").focus();
          showToast("Title is required");
          return;
        }

        const malRaw = animeForm.dataset.malId;
        const payload = {
          title,
          status: $("#status").value || "planned",
          rating: $("#rating").value,
          episodesWatched: $("#episodesWatched").value,
          episodesTotal: $("#episodesTotal").value,
          genres: $("#genres").value,
          coverUrl: ($("#coverUrl").value || "").trim(),
          notes: $("#notes").value,
          malId: malRaw ? Number(malRaw) : null,
        };

        const id = ($("#animeId").value || "").trim();
        if (id) {
          if (!updateAnime(id, payload)) {
            showToast("Could not update");
            return;
          }
          showToast("Updated");
        } else {
          const created = createAnime(payload);
          if (!created) {
            showToast("Could not add");
            return;
          }
          showToast("Added");
          // if no cover but has mal id, fetch one
          if (!created.coverUrl && created.malId) {
            enrichCovers({ onlyIds: [created.id], allowTitleSearch: false });
          }
        }
        closeModal();
        render();
      } catch (err) {
        console.error(err);
        showToast("Something went wrong while saving");
      }
    });

    $("#title").addEventListener("input", () => {
      const q = $("#title").value.trim();
      clearTimeout(searchTimer);
      if (q.length < 2 || ($("#animeId").value || "").trim()) {
        hideSearchResults();
        return;
      }
      searchTimer = setTimeout(() => searchAnimeAPI(q), 450);
    });

    $("#title").addEventListener("blur", () => {
      setTimeout(() => {
        if (!searchResults.matches(":hover")) hideSearchResults();
      }, 200);
    });

    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value.trim();
      render();
    });

    sortSelect.addEventListener("change", () => {
      sortBy = sortSelect.value;
      render();
    });

    $$(".nav-pill").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".nav-pill").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        filter = tab.dataset.filter;
        render();
      });
    });

    $("#logoHome").addEventListener("click", (e) => {
      e.preventDefault();
      filter = "all";
      $$(".nav-pill").forEach((t) => t.classList.toggle("active", t.dataset.filter === "all"));
      render();
    });
  }

  function spawnPetals() {
    const layer = $("#sakuraLayer");
    if (!layer) return;
    for (let i = 0; i < 14; i++) {
      const p = document.createElement("span");
      p.className = "petal";
      p.style.left = Math.random() * 100 + "%";
      p.style.animationDuration = 8 + Math.random() * 12 + "s";
      p.style.animationDelay = Math.random() * 10 + "s";
      p.style.width = 7 + Math.random() * 8 + "px";
      p.style.height = p.style.width;
      p.style.opacity = String(0.3 + Math.random() * 0.4);
      layer.appendChild(p);
    }
  }

  function init() {
    try {
      load();
      bindEvents();
      spawnPetals();
      render();
      // quietly backfill covers for existing list without covers
      const missing = animeList.filter(needsCover).length;
      if (missing > 0 && missing <= 40) {
        setTimeout(() => {
          enrichCovers({ allowTitleSearch: true }).then(({ filled }) => {
            if (filled > 0) showToast(`${filled} covers loaded`);
          });
        }, 800);
      }
    } catch (err) {
      console.error(err);
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div style="padding:2rem;font-family:sans-serif">Failed to start: ${escapeHtml(err.message)}</div>`
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
