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
let reconnectTimer = null;
let localQueue = [];
let localCurrentIndex = -1;
let lastVolume = 1;
let currentTrack = null;
let lastSearchResults = [];

const clientId = Math.random().toString(36).substring(2, 10);

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
    renderSearchResults(lastSearchResults);
    renderQueue();
    updatePlayerLike();
}
function likeCurrentTrack() {
    if (!currentTrack) return;
    toggleLike(currentTrack);
}

// --- WebSocket ---
function connectWS() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        setStatus("🟢 Подключено");
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };
    ws.onclose = () => {
        setStatus("🔴 Отключено");
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWS(); }, 3000);
        }
    };
    ws.onerror = () => setStatus("⚠️ Ошибка");

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        const audio = document.getElementById("audio");

        if (msg.type === "full_state") {
            localQueue = msg.queue || [];
            localCurrentIndex = msg.current_index ?? -1;
            renderQueue();
            if (msg.track) {
                loadTrackState(msg.track, msg.index, msg.current_time, msg.is_playing);
            }
        } else if (msg.type === "queue_update") {
            localQueue = msg.queue || [];
            localCurrentIndex = msg.current_index ?? -1;
            renderQueue();
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

// --- Поиск ---
async function search() {
    const query = document.getElementById("searchInput").value.trim();
    if (!query) return;

    try {
        const res = await fetch(`${API_BASE}/api/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        lastSearchResults = data.tracks || [];
        renderSearchResults(lastSearchResults);
    } catch (e) {
        console.error("Search error:", e);
        document.getElementById("results").innerHTML = `<div class="empty"><p>Ошибка</p><span>${e.message}</span></div>`;
    }
}

// --- Рендер треков ---
function renderTracks(container, tracks, options = {}) {
    const {
        showIndex = false,
        showRemove = false,
        showLike = false,
        showAdd = false,
        draggable = false,
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

        const artist = track.artist + (track.duration ? ` · ${track.duration}с` : "");

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

        // Обработчик кликов и drag через единый pointer-механизм
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

// --- Единый обработчик: клик vs drag ---
// ВАЖНО: drag стартует ТОЛЬКО за ручку (.track-drag-handle) — и на ПК, и на тач.
// Клик по телу трека / кнопкам больше не превращается в перетаскивание.
function setupInteractions(el, index, { draggable, onClick }) {
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let moved = false;
    let pointerId = null;

    const CLICK_THRESHOLD = 10; // px — если палец сдвинулся меньше, это клик

    const onPointerDown = (e) => {
        // ПКМ или средняя кнопка — игнорируем
        if (e.pointerType === "mouse" && e.button !== 0) return;

        // Клик по кнопке (лайк / удалить / добавить) — не перехватываем
        if (e.target.closest("button")) return;

        startX = e.clientX;
        startY = e.clientY;
        moved = false;
        dragging = false;
        pointerId = e.pointerId;

        // Drag возможен только за ручку
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
            // Просто отмечаем, что пользователь сдвинул палец — тогда это не клик
            if (dist > CLICK_THRESHOLD) moved = true;
            return;
        }

        e.preventDefault();
        moved = true;

        // Подсветка цели
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
            // Завершаем drag
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
            // Это был клик — обрабатываем сами
            onClick();
        }

        dragging = false;
        moved = false;
        pointerId = null;
    };

    el.addEventListener("pointerdown", onPointerDown);
    // Отключаем нативный drag у картинок
    el.addEventListener("dragstart", (e) => e.preventDefault());
}

function renderSearchResults(tracks) {
    renderTracks(document.getElementById("results"), tracks, { showLike: true, showAdd: true });
}
function renderQueue() {
    renderTracks(document.getElementById("queue"), localQueue, {
        showIndex: true,
        showRemove: true,
        draggable: true,
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
    send({
        type: "add_to_queue",
        track_id: String(track.id),
        title: track.title,
        artist: track.artist,
        cover: track.cover || "",
    });
    showToast(`➕ Добавлено в очередь`);
}
function addAllLibraryToQueue() {
    const lib = getLibrary();
    if (lib.length === 0) {
        showToast("Библиотека пуста");
        return;
    }
    lib.forEach(track => addToQueue(track));
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
        audio.play().catch(err => console.warn("Autoplay blocked:", err)).finally(() => { isSyncing = false; });
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

// --- Мини-режим ---
function toggleCollapse() {
    const player = document.getElementById("player");
    player.classList.toggle("collapsed");
}

// --- Прогресс ---
const progressContainer = document.getElementById("progressContainer");
const progressBar = document.getElementById("progressBar");
const currentTimeEl = document.getElementById("currentTime");
const totalTimeEl = document.getElementById("totalTime");
const playIcon = document.getElementById("playIcon");
const pauseIcon = document.getElementById("pauseIcon");

progressContainer.addEventListener("click", (e) => {
    const audio = document.getElementById("audio");
    if (!audio.duration) return;
    const rect = progressContainer.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newTime = percent * audio.duration;
    audio.currentTime = newTime;
    send({ type: "seek", time: newTime });
});

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

const audio = document.getElementById("audio");

audio.addEventListener("timeupdate", () => {
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
audio.addEventListener("ended", () => send({ type: "track_ended" }));

// --- Громкость ---
const volumeSlider = document.getElementById("volumeSlider");
volumeSlider.addEventListener("input", () => {
    audio.volume = parseFloat(volumeSlider.value);
    if (audio.volume > 0) lastVolume = audio.volume;
});
function toggleMute() {
    if (audio.volume > 0) {
        lastVolume = audio.volume;
        audio.volume = 0;
        volumeSlider.value = 0;
        showToast("🔇 Звук выключен");
    } else {
        audio.volume = lastVolume;
        volumeSlider.value = lastVolume;
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

// --- Enter для поиска ---
document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") search();
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
        case "ArrowUp":
            e.preventDefault();
            audio.volume = Math.min(1, audio.volume + 0.1);
            volumeSlider.value = audio.volume;
            break;
        case "ArrowDown":
            e.preventDefault();
            audio.volume = Math.max(0, audio.volume - 0.1);
            volumeSlider.value = audio.volume;
            break;
    }
});

// --- Подсказка горячих клавиш ---
const hint = document.createElement("div");
hint.className = "kbd-hint";
hint.innerHTML = "⌨ Space · ← → · M · L · C · ↑ ↓";
document.body.appendChild(hint);

// --- Инициализация ---
renderLibrary();
connectWS();
