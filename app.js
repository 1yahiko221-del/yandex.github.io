const API_BASE = "https://yandex-sync-backend.onrender.com";

const urlParams = new URLSearchParams(window.location.search);
let roomId = urlParams.get('room');
if (!roomId) {
    roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    window.history.replaceState({}, '', `?room=${roomId}`);
}
document.getElementById('roomIdDisplay').textContent = roomId;

const WS_URL = API_BASE.replace("https://", "wss://").replace("http://", "ws://") + `/ws/${roomId}`;

let ws = null;
let isSyncing = false;
let localQueue = [];
let localCurrentIndex = -1;
let lastVolume = 1;
let currentTrack = null;
let repeatMode = 'off'; // off | all | one
let shuffleMode = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
const QUEUE_CACHE_KEY = 'syncMusicQueueCache';

const clientId = Math.random().toString(36).substring(2, 10);

// --- Громкость в localStorage ---
const VOLUME_KEY = 'syncMusicVolume';
const MUTED_KEY = 'syncMusicMuted';

function loadVolumeSettings() {
    let vol = parseFloat(localStorage.getItem(VOLUME_KEY));
    if (isNaN(vol)) vol = 1;
    vol = Math.max(0, Math.min(1, vol));

    const muted = localStorage.getItem(MUTED_KEY) === '1';

    let last = parseFloat(localStorage.getItem(VOLUME_KEY + '_last'));
    if (isNaN(last) || last <= 0) last = vol > 0 ? vol : 1;

    return { vol, muted, last };
}

function saveVolumeSettings() {
    const audio = document.getElementById("audio");
    localStorage.setItem(VOLUME_KEY, String(audio.volume));
    localStorage.setItem(MUTED_KEY, audio.volume === 0 ? '1' : '0');
    if (audio.volume > 0) {
        localStorage.setItem(VOLUME_KEY + '_last', String(audio.volume));
    }
}

function applyVolumeSettings() {
    const audio = document.getElementById("audio");
    const slider = document.getElementById("volumeSlider");
    const { vol, muted, last } = loadVolumeSettings();

    const effective = muted ? 0 : vol;
    audio.volume = effective;
    slider.value = effective;
    lastVolume = muted ? last : vol;
}

// --- Имя пользователя ---
const NAME_KEY = 'syncMusicUserName';
function getUserName() {
    return localStorage.getItem(NAME_KEY) || '';
}
function setUserName(name) {
    localStorage.setItem(NAME_KEY, name);
    updateUserNameLabel();
}
function updateUserNameLabel() {
    const el = document.getElementById('userNameLabel');
    if (!el) return;
    const name = getUserName();
    el.textContent = name || 'Гость';
    document.getElementById('userBtn').classList.toggle('has-name', !!name);
}
function editUserName() {
    document.getElementById('nameInput').value = getUserName();
    document.getElementById('nameModal').style.display = 'flex';
    setTimeout(() => document.getElementById('nameInput').focus(), 50);
}
function closeNameModal() {
    document.getElementById('nameModal').style.display = 'none';
}
function saveName() {
    const val = document.getElementById('nameInput').value.trim();
    if (!val) {
        showToast("Введи имя");
        return;
    }
    setUserName(val);
    closeNameModal();
    showToast(`👤 Привет, ${val}!`);
    renderQueue();
}

// --- Тосты ---
function showToast(text, duration = 2000) {
    const toast = document.getElementById('toast');
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

// --- Библиотека ---
function getLibrary() {
    try { return JSON.parse(localStorage.getItem('syncMusicLibrary') || '[]'); }
    catch { return []; }
}
function saveLibrary(lib) {
    localStorage.setItem('syncMusicLibrary', JSON.stringify(lib));
}
function isLiked(trackId) {
    return getLibrary().some(t => String(t.id) === String(trackId));
}
function toggleLike(track) {
    const lib = getLibrary();
    const idx = lib.findIndex(t => String(t.id) === String(track.id));
    if (idx >= 0) {
        lib.splice(idx, 1);
        showToast(`Удалено из библиотеки`);
    } else {
        lib.push({
            id: track.id,
            title: track.title,
            artist: track.artist,
            cover: track.cover || '',
        });
        showToast(`❤️ Добавлено в библиотеку`);
    }
    saveLibrary(lib);
    renderLibrary();
    // Если поиск открыт — перерисуем и его, чтобы лайк отразился
    if (searchResultsEl.style.display !== 'none') {
        renderSearchDropdown(currentSearchResults);
    }
    renderQueue();
    updatePlayerLike();
}
function likeCurrentTrack() {
    if (!currentTrack) return;
    toggleLike(currentTrack);
}

// --- Локальный кэш очереди (быстрый UI при плохом соединении) ---
function cacheQueue() {
    try {
        localStorage.setItem(QUEUE_CACHE_KEY, JSON.stringify({
            queue: localQueue,
            current_index: localCurrentIndex,
            saved_at: Date.now()
        }));
    } catch (_) {}
}
function loadCachedQueue() {
    try {
        const data = JSON.parse(localStorage.getItem(QUEUE_CACHE_KEY) || 'null');
        if (data && Array.isArray(data.queue) && !localQueue.length) {
            localQueue = data.queue;
            localCurrentIndex = Number.isInteger(data.current_index) ? data.current_index : -1;
            renderQueue();
        }
    } catch (_) {}
}

// --- WebSocket ---
function connectWS() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        reconnectAttempts = 0;
        setStatus("🟢 Подключено");
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        showToast("Соединение восстановлено", 1400);
    };
    ws.onclose = () => {
        setStatus("🟠 Переподключение…");
        if (!reconnectTimer) {
            const delay = Math.min(15000, 1500 * Math.pow(1.6, reconnectAttempts++));
            reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWS(); }, delay);
        }
    };
    ws.onerror = () => setStatus("⚠️ Ошибка");

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        const audio = document.getElementById("audio");

        if (msg.type === "full_state") {
            localQueue = msg.queue || [];
            localCurrentIndex = msg.current_index ?? -1;
            repeatMode = msg.repeat_mode || 'off';
            shuffleMode = !!msg.shuffle;
            cacheQueue();
            renderQueue();
            updateModeButtons();
            if (msg.track) {
                loadTrackState(msg.track, msg.index, msg.current_time, msg.is_playing);
            }
        } else if (msg.type === "queue_update") {
            localQueue = msg.queue || [];
            localCurrentIndex = msg.current_index ?? -1;
            cacheQueue();
            renderQueue();
        } else if (msg.type === "room_settings") {
            repeatMode = msg.repeat_mode || 'off';
            shuffleMode = !!msg.shuffle;
            updateModeButtons();
        } else if (msg.type === "play_track") {
            playTrackFromQueue(msg.track, msg.index, msg.time || 0);
        } else if (msg.type === "play") {
            isSyncing = true;
            audio.currentTime = msg.time || 0;
            audio.play().catch(() => {}).finally(() => { isSyncing = false; });
        } else if (msg.type === "pause") {
            isSyncing = true;
            audio.pause();
            isSyncing = false;
        } else if (msg.type === "seek") {
            isSyncing = true;
            audio.currentTime = msg.time;
            isSyncing = false;
        }
    };
}

function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        msg.sender = clientId;
        ws.send(JSON.stringify(msg));
    }
}
function setStatus(text) {
    document.getElementById("status").textContent = text;
}
function copyRoomLink() {
    const link = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    navigator.clipboard.writeText(link).then(() => {
        showToast("🔗 Ссылка скопирована!");
    }).catch(() => {
        prompt("Скопируй ссылку вручную:", link);
    });
}

// --- Поиск в хедере ---
const searchInput = document.getElementById("searchInput");
const searchResultsEl = document.getElementById("searchResults");
const searchClear = document.getElementById("searchClear");
const searchWrap = document.getElementById("searchWrap");

let searchDebounce = null;
let currentSearchResults = [];
let searchRequestId = 0;

function openSearchResults() {
    searchResultsEl.style.display = 'block';
}
function closeSearchResults() {
    searchResultsEl.style.display = 'none';
}
function clearSearch() {
    searchInput.value = '';
    currentSearchResults = [];
    searchResultsEl.innerHTML = '';
    searchClear.style.display = 'none';
    closeSearchResults();
}

async function performSearch(query) {
    const reqId = ++searchRequestId;
    searchResultsEl.innerHTML = `<div class="search-loader"><div class="spinner"></div>Ищу…</div>`;
    openSearchResults();

    try {
        const res = await fetch(`${API_BASE}/api/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // Если за время запроса пользователь набрал ещё — игнорируем
        if (reqId !== searchRequestId) return;
        currentSearchResults = data.tracks || [];
        renderSearchDropdown(currentSearchResults);
    } catch (e) {
        if (reqId !== searchRequestId) return;
        console.error("Search error:", e);
        searchResultsEl.innerHTML = `<div class="search-empty">Ошибка: ${escapeHtml(e.message)}</div>`;
    }
}

function renderSearchDropdown(tracks) {
    if (!tracks || tracks.length === 0) {
        searchResultsEl.innerHTML = `<div class="search-empty">Ничего не найдено</div>`;
        return;
    }

    searchResultsEl.innerHTML = '';
    tracks.forEach((track) => {
        const div = document.createElement("div");
        div.className = "track";

        const cover = track.cover
            ? `<img class="track-cover" src="${track.cover}" alt="" loading="lazy" draggable="false">`
            : `<div class="track-cover"></div>`;

        const artist = track.artist + (track.duration ? ` · ${track.duration}с` : "");

        div.innerHTML = `${cover}<div class="track-info"><div class="track-title">${escapeHtml(track.title)}</div><div class="track-artist">${escapeHtml(artist)}</div></div>`;

        const actions = document.createElement("div");
        actions.className = "track-actions";

        const liked = isLiked(track.id);
        const likeBtn = document.createElement("button");
        likeBtn.className = "btn-icon" + (liked ? " liked" : "");
        likeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
        likeBtn.onclick = (e) => { e.stopPropagation(); toggleLike(track); };
        actions.appendChild(likeBtn);

        const addBtn = document.createElement("button");
        addBtn.className = "btn btn-primary btn-small";
        addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;
        addBtn.onclick = (e) => { e.stopPropagation(); addToQueue(track); };
        actions.appendChild(addBtn);

        div.appendChild(actions);

        // Клик по треку в выпадашке = добавить в очередь
        div.addEventListener("click", () => {
            addToQueue(track);
        });

        searchResultsEl.appendChild(div);
    });
}

// input: debounce
searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim();
    searchClear.style.display = q ? "flex" : "none";

    if (searchDebounce) clearTimeout(searchDebounce);

    if (!q) {
        currentSearchResults = [];
        searchResultsEl.innerHTML = '';
        closeSearchResults();
        return;
    }

    searchDebounce = setTimeout(() => performSearch(q), 400);
});

// Enter — мгновенный поиск
searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        if (searchDebounce) clearTimeout(searchDebounce);
        const q = searchInput.value.trim();
        if (q) performSearch(q);
    } else if (e.key === "Escape") {
        closeSearchResults();
        searchInput.blur();
    }
});

// Клик вне поиска — закрыть выпадашку
document.addEventListener("click", (e) => {
    if (!searchWrap.contains(e.target)) {
        closeSearchResults();
    }
});

// --- Рендер треков ---
function renderTracks(container, tracks, options = {}) {
    const {
        showIndex = false,
        showRemove = false,
        showLike = false,
        showAdd = false,
        draggable = false,
        showAddedBy = false,
    } = options;

    container.innerHTML = "";
    if (!tracks || tracks.length === 0) {
        container.innerHTML = '<div class="empty"><p>Ничего не найдено</p></div>';
        return;
    }
    tracks.forEach((track, i) => {
        const div = document.createElement("div");
        div.className = "track";
        div.dataset.index = i;
        if (i === localCurrentIndex && showIndex) div.classList.add("current");

        const cover = track.cover
            ? `<img class="track-cover" src="${track.cover}" alt="" loading="lazy" draggable="false">`
            : `<div class="track-cover"></div>`;

        let titleHtml = showIndex ? `${i + 1}. ${track.title}` : track.title;
        if (i === localCurrentIndex && showIndex) {
            titleHtml = `<span class="eq"><span></span><span></span><span></span></span> ${titleHtml}`;
        }

        let artist = track.artist + (track.duration ? ` · ${track.duration}с` : "");

        if (showAddedBy && track.added_by) {
            artist += ` · <span class="added-by">добавил: ${escapeHtml(track.added_by)}</span>`;
        }

        const handleHtml = draggable
            ? `<div class="track-drag-handle" data-handle="1">
                   <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                       <path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                   </svg>
               </div>`
            : "";

        div.innerHTML = `${handleHtml}${cover}<div class="track-info"><div class="track-title">${titleHtml}</div><div class="track-artist">${artist}</div></div>`;

        const actions = document.createElement("div");
        actions.className = "track-actions";

        if (showLike) {
            const liked = isLiked(track.id);
            const likeBtn = document.createElement("button");
            likeBtn.className = "btn-icon" + (liked ? " liked" : "");
            likeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
            likeBtn.onclick = (e) => { e.stopPropagation(); toggleLike(track); };
            actions.appendChild(likeBtn);
        }

        if (showAdd) {
            const addBtn = document.createElement("button");
            addBtn.className = "btn btn-primary btn-small";
            addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;
            addBtn.onclick = (e) => { e.stopPropagation(); addToQueue(track); };
            actions.appendChild(addBtn);
        }

        if (showRemove) {
            const removeBtn = document.createElement("button");
            removeBtn.className = "btn-icon";
            removeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
            removeBtn.onclick = (e) => { e.stopPropagation(); send({ type: "remove_from_queue", index: i }); };
            actions.appendChild(removeBtn);
        }

        div.appendChild(actions);

        setupInteractions(div, i, {
            draggable,
            onClick: () => {
                if (showIndex) send({ type: "play_track_manual", index: i });
                else addToQueue(track);
            },
        });

        container.appendChild(div);
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// --- Единый обработчик: клик vs drag ---
function setupInteractions(el, index, { draggable, onClick }) {
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let moved = false;
    let pointerId = null;

    const CLICK_THRESHOLD = 10;

    const onPointerDown = (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        if (e.target.closest("button")) return;

        startX = e.clientX;
        startY = e.clientY;
        moved = false;
        dragging = false;
        pointerId = e.pointerId;

        const isHandleStart = !!e.target.closest('[data-handle="1"]');
        if (draggable && isHandleStart) {
            dragging = true;
            el.classList.add("dragging");
            if (navigator.vibrate) navigator.vibrate(20);
        }

        document.addEventListener("pointermove", onPointerMove, { passive: false });
        document.addEventListener("pointerup", onPointerUp);
        document.addEventListener("pointercancel", onPointerUp);
    };

    const onPointerMove = (e) => {
        if (e.pointerId !== pointerId) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (!dragging) {
            if (dist > CLICK_THRESHOLD) moved = true;
            return;
        }

        e.preventDefault();
        moved = true;

        const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
        const trackBelow = elemBelow?.closest('.track');
        document.querySelectorAll('.track.drag-over').forEach(t => t.classList.remove('drag-over'));
        if (trackBelow && trackBelow !== el) {
            trackBelow.classList.add('drag-over');
        }
    };

    const onPointerUp = (e) => {
        if (e.pointerId !== pointerId) return;

        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.removeEventListener("pointercancel", onPointerUp);

        if (dragging) {
            el.classList.remove("dragging");
            document.querySelectorAll('.track.drag-over').forEach(t => t.classList.remove('drag-over'));

            const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
            const trackBelow = elemBelow?.closest('.track');

            if (trackBelow && trackBelow !== el) {
                const toIndex = parseInt(trackBelow.dataset.index, 10);
                if (!isNaN(toIndex) && toIndex !== index) {
                    send({ type: "reorder_queue", from: index, to: toIndex });
                }
            }
        } else if (!moved) {
            onClick();
        }

        dragging = false;
        moved = false;
        pointerId = null;
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("dragstart", (e) => e.preventDefault());
}

function renderQueue() {
    renderTracks(document.getElementById("queue"), localQueue, {
        showIndex: true,
        showRemove: true,
        draggable: true,
        showAddedBy: true,
    });
}
function renderLibrary() {
    const lib = getLibrary();
    const container = document.getElementById("library");
    if (lib.length === 0) {
        container.innerHTML = `<div class="empty">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" opacity="0.3"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            <p>Библиотека пуста</p>
            <span>Лайкай треки, чтобы сохранить их</span>
        </div>`;
        return;
    }
    renderTracks(container, lib, { showRemove: true });
}

function addToQueue(track) {
    const name = getUserName();
    if (!name) {
        editUserName();
        showToast("Сначала введи имя — потом добавляй треки");
        return;
    }
    send({
        type: "add_to_queue",
        track_id: String(track.id),
        title: track.title,
        artist: track.artist,
        cover: track.cover || "",
        added_by: name,
    });
    showToast(`➕ ${track.title}`);
}
function addAllLibraryToQueue() {
    const lib = getLibrary();
    if (lib.length === 0) {
        showToast("Библиотека пуста");
        return;
    }
    const name = getUserName();
    if (!name) {
        editUserName();
        showToast("Сначала введи имя");
        return;
    }
    lib.forEach(track => {
        send({
            type: "add_to_queue",
            track_id: String(track.id),
            title: track.title,
            artist: track.artist,
            cover: track.cover || "",
            added_by: name,
        });
    });
    showToast(`Добавлено треков: ${lib.length}`);
}

// --- Вкладки ---
function switchTab(tab) {
    document.getElementById('tabQueue').classList.toggle('active', tab === 'queue');
    document.getElementById('tabLibrary').classList.toggle('active', tab === 'library');
    document.getElementById('queueView').style.display = tab === 'queue' ? 'block' : 'none';
    document.getElementById('libraryView').style.display = tab === 'library' ? 'block' : 'none';
}

// --- Плеер ---
function loadTrackState(track, index, time, isPlaying) {
    const audio = document.getElementById("audio");
    audio.src = track.url;
    audio.currentTime = time || 0;

    applyVolumeSettings();

    currentTrack = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        cover: track.cover || '',
    };

    document.getElementById("nowPlaying").textContent = track.title;
    document.getElementById("playerArtist").textContent = track.artist;

    const coverEl = document.getElementById("playerCover");
    if (track.cover) {
        coverEl.src = track.cover;
        coverEl.style.display = "block";
    } else {
        coverEl.style.display = "none";
    }

    document.getElementById("player").classList.add("visible");
    localCurrentIndex = index;
    renderQueue();
    updatePlayerLike();

    if (isPlaying) {
        isSyncing = true;
        const p = audio.play();
        if (p && typeof p.finally === "function") {
            p.catch(err => console.warn("Autoplay blocked:", err))
             .finally(() => { isSyncing = false; });
        } else {
            isSyncing = false;
        }
    }
}

function playTrackFromQueue(track, index, time = 0) {
    loadTrackState(track, index, time, true);
}

function updatePlayerLike() {
    const btn = document.getElementById("playerLikeBtn");
    if (!currentTrack) {
        btn.classList.remove("liked");
        btn.querySelector("svg").setAttribute("fill", "none");
        return;
    }
    const liked = isLiked(currentTrack.id);
    btn.classList.toggle("liked", liked);
    btn.querySelector("svg").setAttribute("fill", liked ? "currentColor" : "none");
}
function togglePlay() {
    const audio = document.getElementById("audio");
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
}
function nextTrack() { send({ type: "next_track" }); }
function prevTrack() { send({ type: "prev_track" }); }

function cycleRepeat() {
    const modes = ['off', 'all', 'one'];
    const next = modes[(modes.indexOf(repeatMode) + 1) % modes.length];
    repeatMode = next;
    updateModeButtons();
    send({ type: 'set_repeat', mode: next });
    showToast(next === 'off' ? '🔁 Повтор: выкл.' : next === 'all' ? '🔁 Повтор очереди' : '🔂 Повтор трека');
}
function toggleShuffle() {
    shuffleMode = !shuffleMode;
    updateModeButtons();
    send({ type: 'set_shuffle', enabled: shuffleMode });
    showToast(shuffleMode ? '🔀 Перемешивание включено' : '🔀 Перемешивание выключено');
}
function updateModeButtons() {
    const r = document.getElementById('repeatBtn');
    const sh = document.getElementById('shuffleBtn');
    if (r) {
        r.classList.toggle('active', repeatMode !== 'off');
        r.title = repeatMode === 'one' ? 'Повтор трека' : repeatMode === 'all' ? 'Повтор очереди' : 'Повтор выключен';
        r.innerHTML = repeatMode === 'one' ? '🔂' : '🔁';
    }
    if (sh) {
        sh.classList.toggle('active', shuffleMode);
        sh.title = shuffleMode ? 'Выключить перемешивание' : 'Перемешать следующую песню';
    }
}

// --- Мини-режим ---
function toggleCollapse() {
    const player = document.getElementById("player");
    player.classList.toggle("collapsed");
}

// --- Прогресс + seek ---
const progressContainer = document.getElementById("progressContainer");
const progressBar = document.getElementById("progressBar");
const currentTimeEl = document.getElementById("currentTime");
const totalTimeEl = document.getElementById("totalTime");
const playIcon = document.getElementById("playIcon");
const pauseIcon = document.getElementById("pauseIcon");

let isSeeking = false;
let seekPointerId = null;

function seekFromEvent(clientX) {
    const audio = document.getElementById("audio");
    if (!audio.duration) return;
    const rect = progressContainer.getBoundingClientRect();
    let percent = (clientX - rect.left) / rect.width;
    percent = Math.max(0, Math.min(1, percent));
    const newTime = percent * audio.duration;

    audio.currentTime = newTime;
    progressBar.style.width = `${percent * 100}%`;
    currentTimeEl.textContent = formatTime(newTime);

    return newTime;
}

progressContainer.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const audio = document.getElementById("audio");
    if (!audio.duration) return;

    isSeeking = true;
    seekPointerId = e.pointerId;
    progressContainer.setPointerCapture(e.pointerId);
    seekFromEvent(e.clientX);
    e.preventDefault();
});

progressContainer.addEventListener("pointermove", (e) => {
    if (!isSeeking || e.pointerId !== seekPointerId) return;
    seekFromEvent(e.clientX);
    e.preventDefault();
});

function endSeek(e) {
    if (!isSeeking || e.pointerId !== seekPointerId) return;
    const newTime = seekFromEvent(e.clientX);
    isSeeking = false;
    seekPointerId = null;
    if (typeof newTime === "number") {
        send({ type: "seek", time: newTime });
    }
}

progressContainer.addEventListener("pointerup", endSeek);
progressContainer.addEventListener("pointercancel", endSeek);

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

const audio = document.getElementById("audio");

audio.addEventListener("timeupdate", () => {
    if (isSeeking) return;
    const percent = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    progressBar.style.width = `${percent}%`;
    currentTimeEl.textContent = formatTime(audio.currentTime);
    totalTimeEl.textContent = formatTime(audio.duration);
});
audio.addEventListener("loadedmetadata", () => {
    totalTimeEl.textContent = formatTime(audio.duration);
});
audio.addEventListener("play", () => {
    playIcon.style.display = "none";
    pauseIcon.style.display = "block";
    if (!isSyncing) send({ type: "play", time: audio.currentTime });
});
audio.addEventListener("pause", () => {
    playIcon.style.display = "block";
    pauseIcon.style.display = "none";
    if (!isSyncing) send({ type: "pause", time: audio.currentTime });
});
audio.addEventListener("ended", () => {
    send({ type: "track_ended", expected_index: localCurrentIndex });
});
audio.addEventListener("loadstart", () => {
    const { vol, muted } = loadVolumeSettings();
    audio.volume = muted ? 0 : vol;
});

// --- Громкость ---
const volumeSlider = document.getElementById("volumeSlider");

volumeSlider.addEventListener("input", () => {
    audio.volume = parseFloat(volumeSlider.value);
    if (audio.volume > 0) lastVolume = audio.volume;
    saveVolumeSettings();
});

function toggleMute() {
    if (audio.volume > 0) {
        lastVolume = audio.volume;
        audio.volume = 0;
        volumeSlider.value = 0;
        saveVolumeSettings();
        showToast("🔇 Звук выключен");
    } else {
        audio.volume = lastVolume > 0 ? lastVolume : 1;
        volumeSlider.value = audio.volume;
        saveVolumeSettings();
        showToast("🔊 Звук включён");
    }
}

// --- Ripple-эффект ---
document.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn");
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    btn.style.setProperty("--x", `${e.clientX - rect.left}px`);
    btn.style.setProperty("--y", `${e.clientY - rect.top}px`);
});

// --- Enter / Escape в модалке имени ---
document.getElementById("nameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveName();
    if (e.key === "Escape") closeNameModal();
});
document.getElementById("nameModal").addEventListener("click", (e) => {
    if (e.target.id === "nameModal") closeNameModal();
});

// --- Горячие клавиши ---
document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    switch (e.code) {
        case "Space":
            e.preventDefault();
            togglePlay();
            break;
        case "ArrowRight":
            e.preventDefault();
            nextTrack();
            break;
        case "ArrowLeft":
            e.preventDefault();
            prevTrack();
            break;
        case "KeyM":
            e.preventDefault();
            toggleMute();
            break;
        case "KeyL":
            e.preventDefault();
            likeCurrentTrack();
            showToast("❤️ Лайк");
            break;
        case "KeyC":
            e.preventDefault();
            toggleCollapse();
            break;
        case "KeyR":
            e.preventDefault();
            cycleRepeat();
            break;
        case "KeyS":
            e.preventDefault();
            toggleShuffle();
            break;
        case "ArrowUp":
            e.preventDefault();
            audio.volume = Math.min(1, audio.volume + 0.1);
            volumeSlider.value = audio.volume;
            if (audio.volume > 0) lastVolume = audio.volume;
            saveVolumeSettings();
            break;
        case "ArrowDown":
            e.preventDefault();
            audio.volume = Math.max(0, audio.volume - 0.1);
            volumeSlider.value = audio.volume;
            saveVolumeSettings();
            break;
    }
});

// --- Подсказка горячих клавиш ---
const hint = document.createElement("div");
hint.className = "kbd-hint";
hint.innerHTML = "⌨ Space · ← → · M · L · C · R · S · ↑ ↓";
document.body.appendChild(hint);

// --- Инициализация ---
applyVolumeSettings();
loadCachedQueue();
updateModeButtons();
updateUserNameLabel();
renderLibrary();
connectWS();

if (!getUserName()) {
    setTimeout(() => {
        if (!getUserName()) editUserName();
    }, 800);
}
