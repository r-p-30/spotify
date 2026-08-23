// GLOBAL STATE
let player;
let deviceId;
let isPlaying = false;
let isShuffle = false;
let hasStartedPlayback = false;
let isLoadingPlaylist = false;
let tokenRefreshTimer = null;

let selectedPlaylist = {
  name: "Liked Songs",
  tracks: [],
  contextUri: "spotify:user:me:collection",
};

let selectedPlaylistName = "Liked Songs";
let nextTracksUrl = null;
let isLoadingMore = false;
let likedSongsLoadSession = 0; // incremented to cancel stale background loads
let progressInterval;
let isDraggingProgress = false;
let currentTrackUri = null;
let currentTrackObject = null;
let cachedPlaylists = [];
// Ordered URIs from the last fetched queue — used so clicking a queue track
// preserves the remainder of the queue instead of starting a single-song context
let cachedQueueUris = [];

// NOW PLAYING MODE state (declared early so overlay hooks in updateCurrentTrackInfo can reference them)
let isNowPlayingMode = false;
let npUserScrolled = false;
let npIsProgrammaticScroll = false;
let npParsedLyrics = [];
let npIsPlainLyrics = false;
let npLyricsTrackUri = null;

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  event.preventDefault();
});

// AUTH
let token = localStorage.getItem("access_token");

(async () => {
  if (!token) {
    const hasRefresh = localStorage.getItem("refresh_token");
    if (hasRefresh && window.refreshAccessToken) {
      console.log("No access token, attempting refresh...");
      const success = await window.refreshAccessToken();
      if (success) {
        token = localStorage.getItem("access_token");
      } else {
        alert("Session expired. Please login again.");
        window.location.href = "/";
      }
    } else {
      alert("No access token found. Please login first.");
      window.location.href = "/";
    }
  }
})().catch(err => {
  console.error("Startup failed:", err);
  window.location.href = "/";
});

// LOGOUT
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  clearInterval(progressInterval);
  clearInterval(tokenRefreshTimer);
  player?.disconnect();
  localStorage.clear();
  window.location.href = "/";
});

// SPOTIFY SDK INIT
window.onSpotifyWebPlaybackSDKReady = function () {
  player = new Spotify.Player({
    name: "Local Web Player",
    getOAuthToken: (cb) => cb(token),
    volume: 0.5,
  });

  player.addListener("ready", ({ device_id }) => {
    deviceId = device_id;
    console.log("Spotify Player Ready:", device_id);

    // Restore active session first; loadLikedSongs falls back to default if nothing is playing
    restorePlaybackSession().then(() => {
      loadLikedSongs();
      loadUserPlaylists();
    });
    syncShuffleState();
    startTokenRefreshTimer();

    // Register OS media key handlers (forward / back buttons on system widget)
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("previoustrack", () => prev());
      navigator.mediaSession.setActionHandler("nexttrack",     () => next());
      navigator.mediaSession.setActionHandler("play",  () => playPauseBtn.click());
      navigator.mediaSession.setActionHandler("pause", () => playPauseBtn.click());
    }
  });

  player.addListener("not_ready", ({ device_id }) => {
    console.warn("Player went offline, device:", device_id);
    deviceId = null;
    setTimeout(() => player.connect(), 1000);
  });

  player.addListener("authentication_error", ({ message }) => {
    console.error("SDK auth error:", message);
    window.refreshAccessToken?.().then(ok => {
      if (ok) {
        token = localStorage.getItem("access_token");
        player.connect();
      } else {
        window.location.href = "/";
      }
    });
  });

  player.addListener("initialization_error", ({ message }) => {
    console.error("SDK init error:", message);
  });

  player.addListener("account_error", ({ message }) => {
    console.error("SDK account error:", message);
    alert("Spotify Premium is required. " + message);
  });

  player.addListener("player_state_changed", (state) => {
    if (!state) return;

    isPlaying = !state.paused;
    if (isPlaying) hasStartedPlayback = true;
    updatePlayPauseButton(isPlaying);

    // Only update track UI when the track actually changes
    if (state.track_window.current_track) {
      const newUri = state.track_window.current_track.uri;
      const trackChanged = newUri !== currentTrackUri;
      currentTrackUri = newUri;
      highlightCurrentTrack();

      if (trackChanged) {
        updateCurrentTrackInfo(state.track_window.current_track);

        // Keep OS media widget in sync with the current track
        updateMediaSessionMetadata(state.track_window.current_track);

        const lyricsSection = document.getElementById("lyricsSection");
        if (lyricsSection.classList.contains("open")) {
          userScrolledLyrics = false;
          fetchLyrics(state.track_window.current_track);
        }

        // Refresh queue whenever track changes (natural end or manual skip)
        setTimeout(loadQueueView, 600);
      }
    }

    updateProgressState(state);

    // Keep a lightweight snapshot in localStorage so a page refresh can resume
    // from the exact same track and position.
    savePlaybackSnapshot(state);
  });

  player.connect();
};

window.onload = async () => {
  const token = localStorage.getItem("access_token");
  if (!token) return;

  try {
    const res = await fetchWithAuth("https://api.spotify.com/v1/me");
    const user = await res.json();
    if (user.product !== "premium") {
      alert("Spotify Premium is required for the Web Playback SDK. Please upgrade.");
    }
  } catch (err) {
    console.error("Failed to check user product:", err);
  }
};

// CONTROLS
const playPauseBtn = document.getElementById("playPauseBtn");

// GLOBAL SEARCH
document.getElementById("searchBtn").onclick = performGlobalSearch;
document.getElementById("searchInput").addEventListener("keyup", (e) => {
  if (e.key === "Enter") performGlobalSearch();
  if (e.key === "Escape" || document.getElementById("searchInput").value === "") {
    document.getElementById("searchResults").classList.remove("active");
  }
});

async function performGlobalSearch() {
  const query = document.getElementById("searchInput").value.trim();
  if (!query) return;

  const loader = document.getElementById("loader");
  const wrap = document.getElementById("searchResultsWrap");

  loader.hidden = false;
  wrap.classList.remove("active");
  document.getElementById("searchResults").innerHTML = "";

  try {
    const res = await fetchWithAuth(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track,album,artist,playlist&limit=20`
    );
    const data = await res.json();
    loader.hidden = true;

    searchData = {
      tracks: data.tracks?.items || [],
      albums: data.albums?.items || [],
      artists: data.artists?.items || [],
      playlists: data.playlists?.items || [],
    };

    // Reset to tracks tab
    document.querySelectorAll(".s-tab").forEach(t => t.classList.toggle("active", t.dataset.type === "tracks"));
    renderSearchTab("tracks");
    wrap.classList.add("active");

  } catch (err) {
    console.error("Search failed", err);
    loader.hidden = true;
  }
}

function renderSearchTab(type) {
  const ul = document.getElementById("searchResults");
  ul.innerHTML = "";
  const items = searchData[type] || [];

  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "search-empty";
    li.textContent = `No ${type} found.`;
    ul.appendChild(li);
    return;
  }

  if (type === "tracks") {
    searchResultTracks = items;
    items.forEach((track, idx) => {
      const li = buildTrackRow(track, () => {
        playContext({ uris: searchResultTracks.map(t => t.uri), offset: idx });
        document.getElementById("searchResultsWrap").classList.remove("active");
        document.getElementById("searchInput").value = "";
      });
      li.classList.add("search-result-row");
      ul.appendChild(li);
    });

  } else if (type === "albums") {
    items.forEach(album => {
      const li = document.createElement("li");
      li.className = "track-row search-result-row";
      const thumb = document.createElement("img");
      thumb.src = album.images?.[2]?.url || album.images?.[0]?.url || "";
      thumb.className = "track-thumb";
      thumb.alt = "";
      const info = document.createElement("div");
      info.className = "track-info-text";
      const name = document.createElement("span");
      name.className = "track-name";
      name.textContent = album.name;
      const sub = document.createElement("span");
      sub.className = "track-artist";
      sub.textContent = (album.artists?.map(a => a.name).join(", ") || "") + " · Album";
      info.appendChild(name);
      info.appendChild(sub);
      li.appendChild(thumb);
      li.appendChild(info);
      li.addEventListener("click", () => {
        playContext({ contextUri: album.uri });
        document.getElementById("searchResultsWrap").classList.remove("active");
        document.getElementById("searchInput").value = "";
      });
      ul.appendChild(li);
    });

  } else if (type === "artists") {
    items.forEach(artist => {
      const li = document.createElement("li");
      li.className = "track-row search-result-row";
      const thumb = document.createElement("img");
      thumb.src = artist.images?.[2]?.url || artist.images?.[0]?.url || "";
      thumb.className = "track-thumb track-thumb--round";
      thumb.alt = "";
      const info = document.createElement("div");
      info.className = "track-info-text";
      const name = document.createElement("span");
      name.className = "track-name";
      name.textContent = artist.name;
      const sub = document.createElement("span");
      sub.className = "track-artist";
      sub.textContent = `Artist · ${(artist.followers?.total || 0).toLocaleString()} followers`;
      info.appendChild(name);
      info.appendChild(sub);
      li.appendChild(thumb);
      li.appendChild(info);
      li.addEventListener("click", async () => {
        document.getElementById("searchResultsWrap").classList.remove("active");
        document.getElementById("searchInput").value = "";
        const r = await fetchWithAuth(`https://api.spotify.com/v1/artists/${artist.id}/top-tracks?market=from_token`);
        if (!r.ok) { showToast("Couldn't load artist tracks"); return; }
        const d = await r.json();
        if (!d.tracks?.length) { showToast("No tracks found"); return; }
        selectedPlaylist = { name: artist.name, tracks: d.tracks, contextUri: `spotify:artist:${artist.id}`, total: d.tracks.length };
        selectedPlaylistName = artist.name;
        nextTracksUrl = null;
        renderSelectedPlaylist();
        renderPlaylistSidebar();
        showToast(`Loaded top tracks for ${artist.name}`);
      });
      ul.appendChild(li);
    });

  } else if (type === "playlists") {
    items.forEach(pl => {
      const li = document.createElement("li");
      li.className = "track-row search-result-row";
      const thumb = document.createElement("img");
      thumb.src = pl.images?.[0]?.url || "";
      thumb.className = "track-thumb";
      thumb.alt = "";
      const info = document.createElement("div");
      info.className = "track-info-text";
      const name = document.createElement("span");
      name.className = "track-name";
      name.textContent = pl.name;
      const sub = document.createElement("span");
      sub.className = "track-artist";
      sub.textContent = `Playlist · ${pl.tracks?.total || 0} tracks`;
      info.appendChild(name);
      info.appendChild(sub);
      li.appendChild(thumb);
      li.appendChild(info);
      li.addEventListener("click", () => {
        document.getElementById("searchResultsWrap").classList.remove("active");
        document.getElementById("searchInput").value = "";
        selectPlaylist(pl);
      });
      ul.appendChild(li);
    });
  }
}

// Search tab clicks
document.querySelectorAll(".s-tab").forEach(tab => {
  tab.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".s-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    renderSearchTab(tab.dataset.type);
  });
});

// PLAYLIST SEARCH
document.getElementById("playlistSearchInput").addEventListener("input", (e) => {
  const term = e.target.value.toLowerCase();
  const filtered = selectedPlaylist.tracks.filter(t =>
    t.name.toLowerCase().includes(term) ||
    t.artists.some(a => a.name.toLowerCase().includes(term))
  );
  renderTrackList(filtered);
});

document.getElementById("prevBtn").onclick = prev;
document.getElementById("nextBtn").onclick = next;
document.getElementById("shuffleBtn").onclick = toggleShuffle;



playPauseBtn.onclick = () => {
  if (isPlaying) {
    pause();
  } else if (hasStartedPlayback) {
    fetchWithAuth(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: "PUT",
      body: JSON.stringify({}),
    }).then(async res => {
      if (res.ok) {
        isPlaying = true;
        updatePlayPauseButton(true);
      } else {
        const err = await res.json();
        console.error("Resume failed:", err);
      }
    }).catch(err => console.error("Resume error:", err));
  } else {
    playContext({ contextUri: selectedPlaylist.contextUri, offset: 0 });
  }
};

// SHARED LOADER
function loaderHTML() {
  return '<div class="loader-dots"><span></span><span></span><span></span></div>';
}

// PLAYBACK
async function playContext({ contextUri, uris, offset = 0, positionMs = 0 }) {
  if (!deviceId) { showToast("Player not ready — try again in a moment"); return; }

  const body = {};

  if (uris) {
    body.uris = uris;
    body.offset = { position: offset };
  } else if (contextUri === "spotify:user:me:collection" || contextUri?.startsWith("spotify:artist:")) {
    body.uris = selectedPlaylist.tracks.map(t => t.uri);
    body.offset = { position: offset };
  } else {
    body.context_uri = contextUri;
    body.offset = { position: offset };
  }

  // Start at exact position (no separate seek needed, avoids the 0→position jump)
  if (positionMs > 0) body.position_ms = positionMs;

  const res = await fetchWithAuth(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json();
    alert(`Playback failed: ${err.error.message}`);
    return;
  }

  isPlaying = true;
  hasStartedPlayback = true;
  updatePlayPauseButton(true);
  setTimeout(loadQueueView, 800);
  // If lyrics panel is open and showing stale/no-playback result, re-fetch
  const lyricsSection = document.getElementById("lyricsSection");
  if (lyricsSection.classList.contains("open")) {
    lyricsTrackUri = null; // force re-fetch even if URI matches
    setTimeout(() => { if (currentTrackObject) fetchLyrics(currentTrackObject); }, 500);
  }
}

async function pause() {
  const res = await fetchWithAuth(`https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`, {
    method: "PUT",
  });

  if (!res.ok) {
    const err = await res.json();
    alert(`Pause failed: ${err.error.message}`);
    return;
  }

  isPlaying = false;
  updatePlayPauseButton(false);
}

async function next() {
  const res = await fetchWithAuth(`https://api.spotify.com/v1/me/player/next?device_id=${deviceId}`, {
    method: "POST",
  });

  if (!res.ok) {
    const err = await res.json();
    alert(`Skip failed: ${err.error.message}`);
    return;
  }

  resumeAfterSkip();
}

async function prev() {
  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/me/player/previous?device_id=${deviceId}`,
    {
      method: "POST",
    }
  );

  if (!res.ok) {
    const err = await res.json();
    alert(`Prev failed: ${err.error.message}`);
    return;
  }

  resumeAfterSkip();
}

function resumeAfterSkip() {
  setTimeout(() => {
    fetchWithAuth(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: "PUT",
    }).then(async res => {
      if (!res.ok) {
        const err = await res.json();
        console.error("Resume failed:", err);
      }
    }).catch(err => console.error("resumeAfterSkip network error:", err));
  }, 200);
}

// SHUFFLE
async function toggleShuffle() {
  const newState = !isShuffle;

  // For URI-based contexts (Liked Songs, artist top tracks) Spotify doesn't
  // maintain a server-side context — we must send all URIs ourselves.
  // When enabling shuffle, fetch any pages the user hasn't scrolled to yet
  // so Spotify gets the full track list for true randomness.
  const isUriBased =
    selectedPlaylist.contextUri === "spotify:user:me:collection" ||
    selectedPlaylist.contextUri?.startsWith("spotify:artist:");

  if (newState && isUriBased && nextTracksUrl) {
    showToast("Fetching all tracks for shuffle…");
    await fetchAllRemainingUris();
  }

  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/me/player/shuffle?state=${newState}&device_id=${deviceId}`,
    { method: "PUT" }
  );

  if (res.ok) {
    setShuffleUI(newState);

    // Re-issue playContext with the now-complete URI list.
    if (newState && isUriBased) {
      const allUris = selectedPlaylist.tracks.map(t => t.uri);
      const currentIdx = currentTrackUri ? allUris.indexOf(currentTrackUri) : 0;
      await playContext({
        uris: allUris,
        offset: currentIdx !== -1 ? currentIdx : 0,
      });
    }

    setTimeout(loadQueueView, 600);
  } else {
    const err = await res.json();
    alert(`Shuffle failed: ${err.error.message}`);
  }
}

// Fetches all remaining paginated pages and appends URIs to selectedPlaylist.tracks.
// Called only on shuffle — preserves lazy pagination for normal browsing.
async function fetchAllRemainingUris() {
  let url = nextTracksUrl;
  const isLikedSongs = selectedPlaylist.contextUri === "spotify:user:me:collection";
  while (url) {
    try {
      const res = await fetchWithAuth(url);
      const data = await res.json();
      url = data.next;
      nextTracksUrl = data.next;
      const newTracks = isLikedSongs
        ? data.items.map(i => i.track).filter(Boolean)
        : data.items.map(i => i.track).filter(Boolean);
      selectedPlaylist.tracks.push(...newTracks);
      // Append rows so the list is consistent if the user scrolls later
      renderTrackList(newTracks, true);
    } catch (err) {
      console.error("fetchAllRemainingUris failed:", err);
      break;
    }
  }
}

async function syncShuffleState() {
  const res = await fetchWithAuth("https://api.spotify.com/v1/me/player");
  if (res.status === 204) { console.log("No active playback session yet"); return; }
  if (!res.ok) { console.warn("Failed to fetch player state:", res.status); return; }
  const data = await res.json();
  if (typeof data.shuffle_state === "boolean") setShuffleUI(data.shuffle_state);
  // repeat removed
}

// UI
function updatePlayPauseButton(state) {
  playPauseBtn.querySelector("i").className = state
    ? "fas fa-pause"
    : "fas fa-play";
  // Keep overlay in sync
  if (typeof npSyncPlayPause === "function") npSyncPlayPause(state);
}

// Keep the OS media widget (system tray / lock screen) in sync
function updateMediaSessionMetadata(track) {
  if (!("mediaSession" in navigator) || !track) return;

  const artwork = (track.album.images || []).map(img => ({
    src: img.url,
    sizes: `${img.width || 512}x${img.height || 512}`,
    type: "image/jpeg",
  }));

  navigator.mediaSession.metadata = new MediaMetadata({
    title:  track.name,
    artist: track.artists.map(a => a.name).join(", "),
    album:  track.album.name,
    artwork,
  });
}

function setShuffleUI(state) {
  isShuffle = state;
  const btn = document.getElementById("shuffleBtn");
  btn.classList.toggle("shuffle-active", state);
  // Keep overlay in sync
  if (typeof npSyncShuffle === "function") npSyncShuffle(state);
}

function updateCurrentTrackInfo(track) {
  const trackNameEl = document.getElementById("trackName");
  const trackArtistEl = document.getElementById("trackArtist");
  const trackImageEl = document.getElementById("trackImage");

  if (!track) return;
  currentTrackObject = track;

  // Flip back to player side when track changes
  document.getElementById("trackCard").classList.remove("flipped");

  // Update image immediately — no fade animation on image (avoids blink on rapid state events)
  trackImageEl.src = track.album.images[0]?.url || "";

  // Fade text only
  trackNameEl.classList.add("changing");
  trackArtistEl.classList.add("changing");

  setTimeout(() => {
    const artistStr = track.artists.map(a => a.name).join(", ");
    trackNameEl.textContent = track.name;
    trackNameEl.title = track.name;
    trackArtistEl.textContent = artistStr;
    trackArtistEl.title = artistStr;
    trackNameEl.classList.remove("changing");
    trackArtistEl.classList.remove("changing");
  }, 150);

  // Show action buttons and sync like state
  document.getElementById("nowPlayingActions").classList.add("active");
  document.getElementById("shareCurrentBtn").hidden = false;
  const trackId = track.uri.split(":")[2];
  checkTrackLiked(trackId).then(liked => syncLikeButtons(liked));

  // Keep Now Playing overlay in sync
  if (typeof npSyncTrack === "function") {
    npSyncTrack(track);
    // Reset overlay lyrics for the new track
    npLyricsTrackUri = null;
    npParsedLyrics = [];
    npUserScrolled = false;
    if (isNowPlayingMode && typeof npSyncLyrics === "function") npSyncLyrics();
  }
}

// LIKED SONGS
async function loadLikedSongs() {
  if (isLoadingPlaylist) return;
  isLoadingPlaylist = true;
  try {
    selectedPlaylistName = "Liked Songs";

    const res = await fetchWithAuth("https://api.spotify.com/v1/me/tracks?limit=50");

    const data = await res.json();
    nextTracksUrl = data.next;

    selectedPlaylist = {
      name: "Liked Songs",
      tracks: data.items.map(i => i.track).filter(Boolean),
      contextUri: "spotify:user:me:collection",
      total: data.total,
    };

    renderSelectedPlaylist();
    renderPlaylistSidebar();
    document.getElementById("selectedPlaylistTracks").scrollTop = 0;

    // On first load: only show the first-track placeholder if nothing is being restored.
    // hasStartedPlayback is set true by restorePlaybackSession before we run.
    if (!hasStartedPlayback && selectedPlaylist.tracks.length > 0) {
      const first = selectedPlaylist.tracks[0];
      currentTrackUri = first.uri;
      updateCurrentTrackInfo(first);
      updatePlayPauseButton(false); // keep paused state
      highlightCurrentTrack();
      renderInitialQueue(selectedPlaylist.tracks);
    }
  } finally {
    isLoadingPlaylist = false;
  }

}

// Infinite Scroll Listener — attached to the actual scrollable list
const playlistContainer = document.getElementById("selectedPlaylistTracks");
if (playlistContainer) {
  playlistContainer.addEventListener("scroll", (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    if (scrollTop + clientHeight >= scrollHeight - 50) {
      loadMoreTracks();
    }
  });
} else {
  console.error("Could not find #selectedPlaylistTracks to attach scroll listener");
}

async function loadMoreTracks() {
  if (!nextTracksUrl) {
    return;
  }
  if (isLoadingMore) {
    return;
  }

  isLoadingMore = true;

  try {
    const res = await fetchWithAuth(nextTracksUrl);
    const data = await res.json();

    nextTracksUrl = data.next;
    const newTracks = data.items.map(i => i.track);

    selectedPlaylist.tracks.push(...newTracks);

    renderTrackList(newTracks, true); // Append mode
  } catch (err) {
    console.error("Failed to load more songs:", err);
  } finally {
    isLoadingMore = false;
  }
}

// PLAYLISTS
async function loadUserPlaylists() {
  const res = await fetchWithAuth("https://api.spotify.com/v1/me/playlists");

  const data = await res.json();
  cachedPlaylists = data.items;

  renderPlaylistSidebar();
}

function renderPlaylistSidebar() {
  const ul = document.getElementById("playlistList");
  ul.innerHTML = "";

  // Render "Liked Songs" Card
  if (selectedPlaylistName !== "Liked Songs") {
    const li = createPlaylistCard({
      name: "Liked Songs",
      images: [] // No image, will handle in createPlaylistCard
    }, true, async () => {
      await loadLikedSongs();
      playContext({ contextUri: "spotify:user:me:collection", offset: 0 });
    });
    li.onclick = loadLikedSongs;
    ul.appendChild(li);
  }

  // Render User Playlists
  cachedPlaylists.forEach(pl => {
    if (pl.name === selectedPlaylistName) return;

    const li = createPlaylistCard(pl, false, async () => {
      await selectPlaylist(pl);
      playContext({ contextUri: pl.uri, offset: 0 });
    });
    li.onclick = () => selectPlaylist(pl);
    ul.appendChild(li);
  });
}

function createPlaylistCard(pl, isLikedSongs = false, onPlay = null) {
  const li = document.createElement("li");
  li.className = "playlist-card";
  li.title = pl.name; // Tooltip for full name

  const imgDiv = document.createElement("div");
  imgDiv.className = "playlist-card-img";

  if (isLikedSongs) {
    imgDiv.innerHTML = '<i class="fas fa-heart" style="font-size: 1.1rem; color: #fff;"></i>';
    imgDiv.style.background = "linear-gradient(135deg, #450af5, #c4efd9)";
    imgDiv.style.display = "flex";
    imgDiv.style.alignItems = "center";
    imgDiv.style.justifyContent = "center";
  } else if (pl.images && pl.images.length > 0) {
    const img = document.createElement("img");
    img.src = pl.images[0].url;
    img.alt = pl.name;
    imgDiv.appendChild(img);
  } else {
    // Fallback for no image
    imgDiv.innerHTML = '<i class="fas fa-music" style="font-size: 1.1rem; color: #fff;"></i>';
    imgDiv.style.background = "#333";
    imgDiv.style.display = "flex";
    imgDiv.style.alignItems = "center";
    imgDiv.style.justifyContent = "center";
  }

  const nameDiv = document.createElement("div");
  nameDiv.className = "playlist-name";
  nameDiv.textContent = pl.name;

  const playBtn = document.createElement("button");
  playBtn.className = "playlist-play-btn";
  playBtn.innerHTML = '<i class="fas fa-play"></i>';
  playBtn.title = "Play";
  imgDiv.style.position = "relative";
  if (onPlay) {
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onPlay();
    });
  }
  imgDiv.appendChild(playBtn);

  li.appendChild(imgDiv);
  li.appendChild(nameDiv);

  return li;
}

async function selectPlaylist(pl) {
  if (isLoadingPlaylist) return;
  isLoadingPlaylist = true;
  likedSongsLoadSession++; // cancel any in-progress liked songs background load
  try {
    selectedPlaylistName = pl.name;

    const res = await fetchWithAuth(
      `https://api.spotify.com/v1/playlists/${pl.id}/tracks?limit=50`
    );

    const data = await res.json();
    nextTracksUrl = data.next;

    selectedPlaylist = {
      name: pl.name,
      tracks: data.items.map(i => i.track).filter(Boolean),
      contextUri: pl.uri,
      total: data.total,
    };

    renderSelectedPlaylist();
    renderPlaylistSidebar();
    document.getElementById("selectedPlaylistTracks").scrollTop = 0;
  } finally {
    isLoadingPlaylist = false;
  }
}

// SELECTED PLAYLIST VIEW
function renderSelectedPlaylist() {
  document.getElementById("selectedPlaylistName").textContent = selectedPlaylist.name;
  renderTrackList(selectedPlaylist.tracks);
  updatePlaylistCount(selectedPlaylist.total ?? selectedPlaylist.tracks.length);
}

function updatePlaylistCount(total) {
  const badge = document.getElementById("playlistTrackCount");
  badge.textContent = total ? `${total.toLocaleString()} songs` : "";
  badge.style.display = total ? "" : "none";
}

function buildTrackRow(track, onPlay) {
  const li = document.createElement("li");
  li.className = "track-row";
  li.dataset.uri = track.uri;

  const thumb = document.createElement("img");
  thumb.src = track.album?.images[2]?.url || track.album?.images[0]?.url || "";
  thumb.className = "track-thumb";
  thumb.alt = "";

  const info = document.createElement("div");
  info.className = "track-info-text";
  const name = document.createElement("span");
  name.className = "track-name";
  name.textContent = track.name;
  const artist = document.createElement("span");
  artist.className = "track-artist";
  artist.textContent = track.artists.map(a => a.name).join(", ");
  info.appendChild(name);
  info.appendChild(artist);

  const dur = document.createElement("span");
  dur.className = "track-duration";
  dur.textContent = formatTime(track.duration_ms);

  const menuBtn = document.createElement("button");
  menuBtn.className = "track-menu-btn";
  menuBtn.textContent = "⋯";
  menuBtn.title = "More options";
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openTrackContextMenu(e, track);
  });

  li.appendChild(thumb);
  li.appendChild(info);
  li.appendChild(dur);
  li.appendChild(menuBtn);
  li.addEventListener("click", onPlay);

  return li;
}

function renderTrackList(tracks, append = false) {
  const ul = document.getElementById("selectedPlaylistTracks");
  if (!append) ul.innerHTML = "";

  tracks.forEach((track) => {
    if (!track) return;
    const li = buildTrackRow(track, () => {
      const originalIdx = selectedPlaylist.tracks.findIndex(t => t.uri === track.uri);
      playContext({
        contextUri: selectedPlaylist.contextUri,
        offset: originalIdx !== -1 ? originalIdx : 0,
      });
      const playlistSearchInput = document.getElementById("playlistSearchInput");
      if (playlistSearchInput.value) {
        playlistSearchInput.value = "";
        renderTrackList(selectedPlaylist.tracks);
      }
    });
    ul.appendChild(li);
  });

  if (currentTrackUri) highlightCurrentTrack();
}

function highlightCurrentTrack() {
  const lis = document.querySelectorAll("#selectedPlaylistTracks li");
  lis.forEach(li => {
    if (li.dataset.uri === currentTrackUri) {
      li.classList.add("playing");
    } else {
      li.classList.remove("playing");
    }
  });
}

// LYRICS
let parsedLyrics = [];
let isPlainLyrics = false;
let lyricsTrackUri = null;
let userScrolledLyrics = false;
let isProgrammaticScroll = false;

// SEARCH
let searchData = {};
let searchResultTracks = [];

// RECOMMENDATIONS
let lastRecommendedTrackId = null;

function parseLRC(lrcString) {
  const lines = lrcString.split("\n");
  const result = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;
  lines.forEach(line => {
    timeRegex.lastIndex = 0;
    const times = [];
    let m;
    while ((m = timeRegex.exec(line)) !== null) {
      const ms = parseInt(m[1], 10) * 60000 + parseInt(m[2], 10) * 1000 + parseInt(m[3].padEnd(3, "0"), 10);
      times.push(ms);
    }
    const text = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "").trim();
    if (text && times.length > 0) times.forEach(t => result.push({ time: t, text }));
  });
  return result.sort((a, b) => a.time - b.time);
}

async function fetchLyrics(track) {
  if (!track || lyricsTrackUri === track.uri) return;
  lyricsTrackUri = track.uri;

  const container = document.getElementById("lyricsContainer");
  container.innerHTML = loaderHTML();
  document.getElementById("jumpToCurrentBtn").hidden = true;

  const artist = encodeURIComponent(track.artists[0]?.name || "");
  const name = encodeURIComponent(track.name);
  const album = encodeURIComponent(track.album?.name || "");
  const duration = Math.round((track.duration_ms || 0) / 1000);

  try {
    const res = await fetch(
      `https://lrclib.net/api/get?artist_name=${artist}&track_name=${name}&album_name=${album}&duration=${duration}`
    );
    if (!res.ok) {
      container.innerHTML = '<p class="lyrics-placeholder">Lyrics not found for this track.</p>';
      parsedLyrics = [];
      return;
    }
    const data = await res.json();
    if (data.syncedLyrics) {
      isPlainLyrics = false;
      parsedLyrics = parseLRC(data.syncedLyrics);
      renderSyncedLyrics();
    } else if (data.plainLyrics) {
      isPlainLyrics = true;
      parsedLyrics = [];
      renderPlainLyrics(data.plainLyrics);
    } else {
      container.innerHTML = '<p class="lyrics-placeholder">No lyrics available.</p>';
      parsedLyrics = [];
    }
  } catch (err) {
    console.error("Lyrics fetch error:", err);
    container.innerHTML = '<p class="lyrics-placeholder">Could not load lyrics.</p>';
    parsedLyrics = [];
  }
}

function renderSyncedLyrics() {
  document.getElementById("jumpToCurrentBtn").hidden = false;
  const container = document.getElementById("lyricsContainer");
  container.innerHTML = "";
  parsedLyrics.forEach((line, i) => {
    const p = document.createElement("p");
    p.className = "lyrics-line";
    p.textContent = line.text;
    p.dataset.index = i;
    container.appendChild(p);
  });
}

function renderPlainLyrics(text) {
  document.getElementById("jumpToCurrentBtn").hidden = true;
  const container = document.getElementById("lyricsContainer");
  container.innerHTML = "";
  text.split("\n").forEach(line => {
    const p = document.createElement("p");
    p.className = "lyrics-line";
    p.textContent = line || " ";
    container.appendChild(p);
  });
}

function scrollLyricsToActive(smooth = true) {
  const activeLine = document.querySelector("#lyricsContainer .lyrics-line.active");
  if (!activeLine) return;

  const container = document.getElementById("lyricsContainer");
  // getBoundingClientRect gives viewport-relative coords; subtract container's top
  // then add current scrollTop to get the element's position within the scroll container
  const containerRect = container.getBoundingClientRect();
  const lineRect = activeLine.getBoundingClientRect();
  const lineScrollTop = lineRect.top - containerRect.top + container.scrollTop;
  const target = lineScrollTop - (container.clientHeight / 2) + (activeLine.offsetHeight / 2);

  isProgrammaticScroll = true;
  container.scrollTo({ top: Math.max(0, target), behavior: smooth ? "smooth" : "instant" });
  setTimeout(() => { isProgrammaticScroll = false; }, 600);
}

function updateLyricsHighlight(positionMs) {
  if (!parsedLyrics.length || isPlainLyrics) return;
  const section = document.getElementById("lyricsSection");
  if (!section.classList.contains("open")) return;

  let activeIdx = 0;
  for (let i = 0; i < parsedLyrics.length; i++) {
    if (parsedLyrics[i].time <= positionMs) activeIdx = i;
    else break;
  }

  const lines = document.querySelectorAll("#lyricsContainer .lyrics-line");
  lines.forEach((el, i) => el.classList.toggle("active", i === activeIdx));

  // Only auto-scroll if user hasn't manually scrolled
  if (!userScrolledLyrics) scrollLyricsToActive();
}

// Detect manual scrolls on the lyrics container
document.getElementById("lyricsContainer").addEventListener("scroll", () => {
  if (!isProgrammaticScroll) {
    userScrolledLyrics = true;
  }
}, { passive: true });

document.getElementById("jumpToCurrentBtn").addEventListener("click", () => {
  userScrolledLyrics = false;
  scrollLyricsToActive();
});

document.getElementById("lyricsBtn").addEventListener("click", () => {
  const section = document.getElementById("lyricsSection");
  const isOpen = section.classList.toggle("open");
  if (isOpen) {
    userScrolledLyrics = false;
    player.getCurrentState().then(state => {
      const track = state?.track_window?.current_track || currentTrackObject;
      if (track) fetchLyrics(track);
    });
  }
});

document.getElementById("lyricsCloseBtn").addEventListener("click", () => {
  document.getElementById("lyricsSection").classList.remove("open");
});

// NOW-PLAYING CARD ACTIONS
document.getElementById("likeCurrentBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!currentTrackUri) return;
  const trackId = currentTrackUri.split(":")[2];
  const liked = await checkTrackLiked(trackId);
  if (liked) {
    const res = await fetchWithAuth(`https://api.spotify.com/v1/me/tracks?ids=${trackId}`, { method: "DELETE" });
    if (res.ok) { syncLikeButtons(false); showToast("Removed from Liked Songs"); }
  } else {
    const res = await fetchWithAuth(`https://api.spotify.com/v1/me/tracks?ids=${trackId}`, { method: "PUT", body: JSON.stringify([trackId]) });
    if (res.ok) { syncLikeButtons(true); showToast("Added to Liked Songs"); }
  }
});

document.getElementById("shareCurrentBtn").addEventListener("click", () => {
  if (!currentTrackUri) return;
  const trackId = currentTrackUri.split(":")[2];
  const link = `https://open.spotify.com/track/${trackId}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast("Song link copied!");
  }).catch(() => {
    showToast("Copy failed — link: " + link);
  });
});

document.getElementById("moreCurrentBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!currentTrackUri) return;
  const menu = document.getElementById("nowPlayingContextMenu");
  closeContextMenu();
  menu.classList.add("visible");
  const x = Math.min(e.clientX, window.innerWidth - 220);
  const y = Math.min(e.clientY, window.innerHeight - 180);
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  const trackId = currentTrackUri.split(":")[2];
  checkTrackLiked(trackId).then(liked => {
    document.getElementById("ctxNpAddToLiked").hidden = liked;
    document.getElementById("ctxNpRemoveFromLiked").hidden = !liked;
  });
});

document.getElementById("ctxNpCopyLink").addEventListener("click", () => {
  if (!currentTrackUri) return;
  const trackId = currentTrackUri.split(":")[2];
  const link = `https://open.spotify.com/track/${trackId}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast("Song link copied!");
  }).catch(() => {
    showToast("Couldn't copy — try manually: " + link);
  });
  closeContextMenu();
});

// CONTEXT MENU
let activeContextTrack = null;

function openTrackContextMenu(event, track) {
  activeContextTrack = track;
  closeContextMenu();
  const menu = document.getElementById("trackContextMenu");
  menu.classList.add("visible");

  const x = Math.min(event.clientX, window.innerWidth - 220);
  const y = Math.min(event.clientY, window.innerHeight - 150);
  menu.style.left = x + "px";
  menu.style.top = y + "px";

  checkTrackLiked(track.id).then(liked => {
    document.getElementById("ctxAddToLiked").hidden = liked;
    document.getElementById("ctxRemoveFromLiked").hidden = !liked;
  });
}

function closeContextMenu() {
  ["trackContextMenu", "playlistSubmenu", "nowPlayingContextMenu"].forEach(id => {
    document.getElementById(id).classList.remove("visible");
  });
}

document.addEventListener("click", (e) => {
  closeContextMenu();
  const searchSection = document.querySelector(".search");
  const searchWrap = document.getElementById("searchResultsWrap");
  if (!searchSection.contains(e.target) && !searchWrap.contains(e.target)) {
    searchWrap.classList.remove("active");
  }
});

document.getElementById("ctxAddToLiked").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!activeContextTrack) return;
  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/me/tracks?ids=${activeContextTrack.id}`,
    { method: "PUT", body: JSON.stringify([activeContextTrack.id]) }
  );
  showToast(res.ok ? "Added to Liked Songs" : "Failed to add to Liked Songs");
  closeContextMenu();
});

document.getElementById("ctxRemoveFromLiked").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!activeContextTrack) return;
  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/me/tracks?ids=${activeContextTrack.id}`,
    { method: "DELETE" }
  );
  showToast(res.ok ? "Removed from Liked Songs" : "Failed to remove");
  closeContextMenu();
});

document.getElementById("ctxAddToPlaylist").addEventListener("click", (e) => {
  e.stopPropagation();
  const sub = document.getElementById("playlistSubmenu");
  const list = document.getElementById("playlistSubmenuList");
  list.innerHTML = "";

  cachedPlaylists.forEach(pl => {
    const li = document.createElement("li");
    li.textContent = pl.name;
    li.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!activeContextTrack) return;
      const res = await fetchWithAuth(
        `https://api.spotify.com/v1/playlists/${pl.id}/tracks`,
        { method: "POST", body: JSON.stringify({ uris: [activeContextTrack.uri] }) }
      );
      showToast(res.ok ? `Added to ${pl.name}` : "Failed to add to playlist");
      closeContextMenu();
    });
    list.appendChild(li);
  });

  const mainMenu = document.getElementById("trackContextMenu");
  sub.classList.add("visible");
  sub.style.left = (parseInt(mainMenu.style.left) + 205) + "px";
  sub.style.top = mainMenu.style.top;
});

async function checkTrackLiked(trackId) {
  try {
    const res = await fetchWithAuth(`https://api.spotify.com/v1/me/tracks/contains?ids=${trackId}`);
    if (!res.ok) return false;
    const data = await res.json();
    return data[0] === true;
  } catch {
    return false;
  }
}

// Sync BOTH like buttons (main card + NP overlay) to the same liked state.
function syncLikeButtons(liked) {
  const mainBtn  = document.getElementById("likeCurrentBtn");
  const overlayBtn = document.getElementById("npLikeBtn");

  // Icon: outline heart = not liked, solid heart = liked
  [mainBtn, overlayBtn].forEach(btn => {
    if (!btn) return;
    const icon = btn.querySelector("i");
    if (icon) {
      icon.className = liked ? "fas fa-heart" : "far fa-heart";
    }
  });

  // CSS classes
  mainBtn?.classList.toggle("liked", liked);
  overlayBtn?.classList.toggle("np-liked", liked);

  // Tooltip text
  const label = liked ? "Remove from Liked Songs" : "Add to Liked Songs";
  if (mainBtn) mainBtn.title = label;
  if (overlayBtn) overlayBtn.title = label;
}

function showToast(message) {
  const toast = document.getElementById("toastMsg");
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2500);
}

// ============================================================
// PLAYBACK SESSION RESTORE (on page refresh)
// ============================================================

/**
 * Saves a compact snapshot of the current playback state to localStorage.
 * Called on every player_state_changed so a refresh can pick up exactly where
 * we left off. For proper Spotify contexts (playlists/albums) we save the URI;
 * for Liked Songs / artist top tracks we save up to 50 URIs from the current
 * position onward so the queue survives the restore.
 */
function savePlaybackSnapshot(state) {
  const track = state.track_window?.current_track;
  if (!track) return;
  try {
    const isLikedOrArtist =
      !selectedPlaylist.contextUri ||
      selectedPlaylist.contextUri === "spotify:user:me:collection" ||
      selectedPlaylist.contextUri.startsWith("spotify:artist:");

    const trackOffset = selectedPlaylist.tracks.findIndex(t => t.uri === track.uri);

    const snap = {
      trackUri:    track.uri,
      positionMs:  state.position,
      paused:      state.paused,
      contextUri:  isLikedOrArtist ? null : selectedPlaylist.contextUri,
      trackOffset,
      // For Liked Songs / artist: save up to 50 URIs from this track onward
      // so the restored queue isn't just a single repeated song.
      queueUris: isLikedOrArtist && trackOffset >= 0
        ? selectedPlaylist.tracks.slice(trackOffset, trackOffset + 50).map(t => t.uri)
        : null,
    };
    localStorage.setItem("pb_snapshot", JSON.stringify(snap));
  } catch { /* localStorage full — skip silently */ }
}

/**
 * On page load, reads the saved snapshot and resumes playback:
 * - Proper Spotify context (playlist/album) → playContext with contextUri + offset
 * - Liked Songs / artist top tracks        → playContext with saved queue URIs
 * Position is passed directly in the play request (no separate seek / jump).
 * Falls through harmlessly if no snapshot exists.
 */
async function restorePlaybackSession() {
  const raw = localStorage.getItem("pb_snapshot");
  if (!raw) return;

  let snap;
  try { snap = JSON.parse(raw); } catch { return; }
  if (!snap?.trackUri) return;

  console.log("[restore] Resuming from snapshot:", snap.trackUri, "@", snap.positionMs, "ms", snap.paused ? "(paused)" : "(playing)");

  // Guard loadLikedSongs() first-track placeholder without setting currentTrackUri.
  // If we set currentTrackUri here, player_state_changed sees trackChanged=false
  // and skips updateCurrentTrackInfo — leaving the UI at "No song playing".
  hasStartedPlayback = true;

  try {
    if (snap.contextUri) {
      // Full Spotify context — restores the correct track order and queue
      const offset = snap.trackOffset >= 0 ? snap.trackOffset : 0;
      await playContext({ contextUri: snap.contextUri, offset, positionMs: snap.positionMs });
    } else {
      // Liked Songs / artist — use saved queue URIs so UP NEXT is populated correctly
      const uris = snap.queueUris?.length ? snap.queueUris : [snap.trackUri];
      await playContext({ uris, positionMs: snap.positionMs });
    }

    // If the page was refreshed while paused, pause after the play request settles
    if (snap.paused) {
      await new Promise(r => setTimeout(r, 800));
      await pause();
    }

  } catch (err) {
    console.warn("[restore] Restore failed — falling back to default init:", err);
    hasStartedPlayback = false;
  }
}

function startTokenRefreshTimer() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = setInterval(async () => {
    const expiry = parseInt(localStorage.getItem("token_expiry") || "0", 10);
    if (expiry - Date.now() < 5 * 60 * 1000) {
      console.log("Token near expiry, refreshing proactively...");
      const ok = await window.refreshAccessToken?.();
      if (ok) {
        token = localStorage.getItem("access_token");
      } else {
        clearInterval(tokenRefreshTimer);
        window.location.href = "/";
      }
    }
  }, 4 * 60 * 1000);
}

async function fetchWithAuth(url, options = {}) {
  options.headers = { ...options.headers, Authorization: "Bearer " + token };
  let res = await fetch(url, options);

  if (res.status === 401 && window.refreshAccessToken) {
    console.log("Token expired, attempting refresh...");
    if (await window.refreshAccessToken()) {
      token = localStorage.getItem("access_token");
      options.headers.Authorization = "Bearer " + token;
      res = await fetch(url, options);
    } else {
      console.error("Session expired completely");
      window.location.href = "/";
    }
  }

  if (res.status === 404 && url.includes("/me/player")) {
    const errBody = await res.clone().json().catch(() => ({}));
    if (errBody?.error?.reason === "NO_ACTIVE_DEVICE" || errBody?.error?.message?.includes("Device")) {
      console.warn("Device not found, reconnecting...");
      await new Promise(resolve => {
        player.connect().then(resolve);
        setTimeout(resolve, 3000);
      });
      const retryUrl = deviceId ? url.replace(/device_id=[^&]+/, `device_id=${deviceId}`) : url;
      res = await fetch(retryUrl, options);
    }
  }

  return res;
}

function updateProgressState(state) {
  if (isDraggingProgress) return;

  const { position, duration } = state;
  updateProgressUI(position, duration);

  clearInterval(progressInterval);

  if (!state.paused) {
    let currentPosition = position;
    progressInterval = setInterval(() => {
      currentPosition += 1000;
      if (currentPosition > duration) {
        currentPosition = duration;
        clearInterval(progressInterval);
      }
      if (!isDraggingProgress) {
        updateProgressUI(currentPosition, duration);
        updateLyricsHighlight(currentPosition);
      }
    }, 1000);
  }
}

function updateProgressUI(position, duration) {
  const progressBar = document.getElementById("progressBar");
  const currentTimeEl = document.getElementById("currentTime");
  const totalDurationEl = document.getElementById("totalDuration");

  const progressPercent = (position / duration) * 100 || 0;
  progressBar.value = progressPercent;
  progressBar.style.background = `linear-gradient(to right, #fff ${progressPercent}%, rgba(255,255,255,0.2) ${progressPercent}%)`;

  currentTimeEl.textContent = formatTime(position);
  totalDurationEl.textContent = formatTime(duration);

  // Mirror to Now Playing overlay
  try {
    if (isNowPlayingMode && typeof npUpdateProgressUI === "function") {
      npUpdateProgressUI(position, duration);
      if (typeof npUpdateLyricsHighlight === "function") npUpdateLyricsHighlight(position);
    }
  } catch (e) {
    // never let overlay errors break the main progress/lyrics loop
  }
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Progress Bar Interactions
const progressBar = document.getElementById("progressBar");
progressBar.addEventListener("input", () => {
  isDraggingProgress = true;
});


progressBar.addEventListener("change", async (e) => {
  isDraggingProgress = false;
  const seekPercent = e.target.value;

  const state = await player.getCurrentState();
  if (state) {
    const duration = state.duration;
    const seekPos = (seekPercent / 100) * duration;
    player.seek(seekPos);
    updateProgressUI(seekPos, duration);
  }
});


// ============================================================
// ADD TO QUEUE
// ============================================================
async function addToQueue(trackUri) {
  if (!deviceId) { showToast("No active device"); return false; }
  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}&device_id=${deviceId}`,
    { method: "POST" }
  );
  const ok = res.ok || res.status === 204;
  showToast(ok ? "Added to queue" : "Failed to add to queue");
  if (ok) setTimeout(loadQueueView, 400);
  return ok;
}

document.getElementById("ctxAddToQueue").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!activeContextTrack) return;
  await addToQueue(activeContextTrack.uri);
  closeContextMenu();
});

// ============================================================
// QUEUE VIEW
// ============================================================
// Queue is always visible — refresh button only
document.getElementById("queueRefreshBtn").addEventListener("click", loadQueueView);

function renderInitialQueue(tracks) {
  const content = document.getElementById("queueContent");
  content.innerHTML = "";
  const upcoming = tracks.slice(1, 15); // show next 14 tracks
  if (!upcoming.length) {
    content.innerHTML = '<p class="queue-placeholder">Nothing in queue.</p>';
    return;
  }
  // Cache URIs so clicking any row plays from that point with the full tail
  cachedQueueUris = tracks.map(t => t.uri);
  upcoming.forEach((track, idx) => {
    // idx is 0-based within `upcoming`, which starts at tracks[1]
    const originalIdx = idx + 1;
    const li = buildTrackRow(track, () =>
      playContext({ uris: cachedQueueUris.slice(originalIdx) })
    );
    content.appendChild(li);
  });
}

async function loadQueueView() {
  const content = document.getElementById("queueContent");
  content.innerHTML = loaderHTML();
  try {
    const res = await fetchWithAuth("https://api.spotify.com/v1/me/player/queue");
    if (!res.ok) throw new Error("Failed");
    const data = await res.json();
    content.innerHTML = "";

    const currentTrack = data.currently_playing
      ? { ...data.currently_playing, _isCurrent: true }
      : null;
    const upcomingTracks = (data.queue || []).filter(Boolean);

    const items = [
      ...(currentTrack ? [currentTrack] : []),
      ...upcomingTracks,
    ];

    if (!items.length) {
      content.innerHTML = '<p class="queue-placeholder">Queue is empty.</p>';
      cachedQueueUris = [];
      return;
    }

    // Cache the full ordered URI list (current + upcoming) so clicks preserve the queue tail
    cachedQueueUris = items.map(t => t.uri);

    items.forEach((track, idx) => {
      const li = buildTrackRow(track, async () => {
        if (track._isCurrent) return; // clicking the current track does nothing

        // Skip forward via repeated /next calls so Spotify's internal history
        // is preserved — hitting ⏮ afterwards correctly goes back to the
        // previous track instead of losing the old queue context.
        // idx 0 is the current track, so idx already equals the number of skips needed.
        const skipsNeeded = idx;
        for (let i = 0; i < skipsNeeded; i++) {
          await fetchWithAuth(
            `https://api.spotify.com/v1/me/player/next?device_id=${deviceId}`,
            { method: "POST" }
          );
          // Small delay so Spotify registers each skip before the next
          if (i < skipsNeeded - 1) await new Promise(r => setTimeout(r, 150));
        }
        resumeAfterSkip();
      });
      if (track._isCurrent) li.classList.add("queue-current");
      content.appendChild(li);
    });
  } catch {
    content.innerHTML = '<p class="queue-placeholder">Could not load queue.</p>';
  }
}

// ============================================================
// SECTION TABS (Playlists / Recently Played / Recommendations)
// ============================================================
document.querySelectorAll(".sec-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".sec-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    ["playlistList", "recentlyPlayedList", "recommendedList"].forEach(id => {
      document.getElementById(id).classList.toggle("tab-hidden", id !== tab.dataset.target);
    });
    if (tab.dataset.target === "recentlyPlayedList") loadRecentlyPlayed();
    if (tab.dataset.target === "recommendedList") loadRecommendations();
  });
});

// ============================================================
// RECENTLY PLAYED
// ============================================================
async function loadRecentlyPlayed() {
  const list = document.getElementById("recentlyPlayedList");
  list.innerHTML = loaderHTML();
  try {
    const res = await fetchWithAuth("https://api.spotify.com/v1/me/player/recently-played?limit=50");
    if (!res.ok) throw new Error("Failed");
    const data = await res.json();
    list.innerHTML = "";
    (data.items || []).forEach(item => {
      if (!item.track) return;
      const li = buildTrackRow(item.track, () => {
        playContext({ uris: [item.track.uri] });
      });
      list.appendChild(li);
    });
    if (!list.children.length) list.innerHTML = '<li class="rec-placeholder">No history found.</li>';
  } catch {
    list.innerHTML = '<li class="rec-placeholder">Could not load history.</li>';
  }
}

// ============================================================
// RECOMMENDATIONS ("More Like This")
// ============================================================
async function loadRecommendations() {
  const container = document.getElementById("recommendedList");
  if (!currentTrackUri) {
    container.innerHTML = '<p class="rec-placeholder">Play a song to get recommendations.</p>';
    return;
  }
  container.innerHTML = loaderHTML();

  try {
    const trackId = currentTrackUri.split(":")[2];
    if (lastRecommendedTrackId === trackId && container.querySelectorAll(".track-row").length > 0) return;
    lastRecommendedTrackId = trackId;

    // Get current track to find artist
    const trackRes = await fetchWithAuth(`https://api.spotify.com/v1/tracks/${trackId}`);
    if (!trackRes.ok) throw new Error("track");
    const trackData = await trackRes.json();
    const artistId = trackData.artists[0]?.id;
    const artistName = trackData.artists[0]?.name || "this artist";
    if (!artistId) throw new Error("no artist");

    // Get related artists (up to 5) — endpoint may be unavailable, fall through gracefully
    const relRes = await fetchWithAuth(`https://api.spotify.com/v1/artists/${artistId}/related-artists`);
    const relatedArtists = relRes.ok ? ((await relRes.json()).artists?.slice(0, 5) || []) : [];

    let tracks = [];
    if (relatedArtists.length) {
      // Fetch top 4 tracks from each related artist in parallel
      const nestedTracks = await Promise.all(
        relatedArtists.map(a =>
          fetchWithAuth(`https://api.spotify.com/v1/artists/${a.id}/top-tracks?market=from_token`)
            .then(r => r.ok ? r.json() : { tracks: [] })
            .then(d => (d.tracks || []).slice(0, 4))
        )
      );
      tracks = nestedTracks.flat().filter(Boolean);
    }

    // Fallback: show artist's own top tracks
    if (!tracks.length) {
      const topRes = await fetchWithAuth(`https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=from_token`);
      tracks = topRes.ok ? (await topRes.json()).tracks || [] : [];
    }

    if (!tracks.length) { container.innerHTML = '<p class="rec-placeholder">No recommendations found.</p>'; return; }

    container.innerHTML = `<p class="rec-label">Similar to ${artistName}</p>`;
    tracks.forEach((track, idx) => {
      const li = buildTrackRow(track, () => playContext({ uris: tracks.map(t => t.uri), offset: idx }));
      container.appendChild(li);
    });

  } catch (err) {
    console.error("Recommendations error:", err);
    container.innerHTML = '<p class="rec-placeholder">Could not load recommendations.</p>';
  }
}

// ============================================================
// AUDIO FEATURES CARD FLIP
// ============================================================
document.getElementById("trackImage").addEventListener("click", () => {
  if (!currentTrackUri) return;
  document.getElementById("trackCard").classList.add("flipped");
  fetchAudioFeatures(currentTrackUri.split(":")[2]);
});

document.querySelector(".flip-card-back").addEventListener("click", () => {
  document.getElementById("trackCard").classList.remove("flipped");
});

async function fetchAudioFeatures(trackId) {
  const content = document.getElementById("audioFeaturesContent");
  content.innerHTML = loaderHTML();
  try {
    // audio-features is restricted for new apps — fetch track + artist info instead
    const [trackRes,] = await Promise.all([
      fetchWithAuth(`https://api.spotify.com/v1/tracks/${trackId}`),
    ]);
    if (!trackRes.ok) throw new Error("track");
    const track = await trackRes.json();

    const artistId = track.artists[0]?.id;
    let artist = null;
    if (artistId) {
      const aRes = await fetchWithAuth(`https://api.spotify.com/v1/artists/${artistId}`);
      if (aRes.ok) artist = await aRes.json();
    }

    renderTrackStats(track, artist);
  } catch (err) {
    console.error("Stats error:", err);
    content.innerHTML = '<p class="af-placeholder">Could not load stats.</p>';
  }
}

function renderTrackStats(track, artist) {
  const mins = Math.floor(track.duration_ms / 60000);
  const secs = Math.floor((track.duration_ms % 60000) / 1000).toString().padStart(2, "0");
  const releaseYear = track.album?.release_date?.slice(0, 4) || "—";
  const albumType = (track.album?.album_type || "").replace(/^\w/, c => c.toUpperCase());
  const popularity = track.popularity ?? 0;
  const genres = artist?.genres?.slice(0, 3) || [];

  document.getElementById("audioFeaturesContent").innerHTML = `
    <div class="af-quick-stats">
      <div class="af-quick-stat">
        <span class="af-qs-value">${mins}:${secs}</span>
        <span class="af-qs-label">Duration</span>
      </div>
      <div class="af-quick-stat">
        <span class="af-qs-value">${releaseYear}</span>
        <span class="af-qs-label">Released</span>
      </div>
      <div class="af-quick-stat">
        <span class="af-qs-value">${albumType || "—"}</span>
        <span class="af-qs-label">Type</span>
      </div>
    </div>
    <div class="af-bars">
      <div class="af-bar-row">
        <span class="af-bar-label">Popularity</span>
        <div class="af-bar-track"><div class="af-bar-fill" style="width:${popularity}%;background:#2e7bff"></div></div>
        <span class="af-bar-pct">${popularity}</span>
      </div>
      ${artist ? `<div class="af-bar-row">
        <span class="af-bar-label">Artist fans</span>
        <div class="af-bar-track"><div class="af-bar-fill" style="width:${Math.min(100, Math.round((artist.popularity ?? 0)))}%;background:#6bcb77"></div></div>
        <span class="af-bar-pct">${artist.popularity ?? 0}</span>
      </div>` : ""}
    </div>
    ${genres.length ? `<div class="af-genres">${genres.map(g => `<span class="af-genre-tag">${g}</span>`).join("")}</div>` : ""}
    ${track.explicit ? '<p class="af-explicit"><i class="fas fa-exclamation-circle"></i> Explicit</p>' : ""}
  `;
}

// ============================================================
// NOW-PLAYING CONTEXT MENU HANDLERS
// ============================================================
document.getElementById("ctxMoreLikeThis").addEventListener("click", async (e) => {
  e.stopPropagation();
  closeContextMenu();
  // Switch to recommendations tab
  document.querySelectorAll(".sec-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.target === "recommendedList");
  });
  ["playlistList", "recentlyPlayedList"].forEach(id => { document.getElementById(id).classList.add("tab-hidden"); });
  document.getElementById("recommendedList").classList.remove("tab-hidden");
  lastRecommendedTrackId = null; // force reload
  await loadRecommendations();
  document.querySelector(".playlists").scrollIntoView({ behavior: "smooth" });
});

document.getElementById("ctxNpAddToQueue").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!currentTrackUri) return;
  closeContextMenu();
  await addToQueue(currentTrackUri);
});

document.getElementById("ctxNpAddToLiked").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!currentTrackUri) return;
  const trackId = currentTrackUri.split(":")[2];
  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/me/tracks?ids=${trackId}`,
    { method: "PUT", body: JSON.stringify([trackId]) }
  );
  if (res.ok) {
    syncLikeButtons(true);
    showToast("Added to Liked Songs");
  }
  closeContextMenu();
});

document.getElementById("ctxNpRemoveFromLiked").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!currentTrackUri) return;
  const trackId = currentTrackUri.split(":")[2];
  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/me/tracks?ids=${trackId}`,
    { method: "DELETE" }
  );
  if (res.ok) {
    syncLikeButtons(false);
    showToast("Removed from Liked Songs");
  }
  closeContextMenu();
});

// ============================================================
// NOW PLAYING MODE (Car Mode / Full-screen Widget)
// ============================================================

// --- Open / close ---
function openNowPlayingMode() {
  isNowPlayingMode = true;
  const overlay = document.getElementById("nowPlayingOverlay");
  overlay.classList.add("active");
  document.getElementById("nowPlayingModeBtn").classList.add("np-mode-active");

  // Sync current track data into overlay immediately
  if (currentTrackObject) {
    npSyncTrack(currentTrackObject);
  }

  // Load lyrics into overlay (reuse parsedLyrics if already fetched, else fetch)
  npSyncLyrics();

  // Sync play/pause state
  npSyncPlayPause(isPlaying);

  // Sync shuffle
  npSyncShuffle(isShuffle);

  // Prevent body scroll
  document.body.style.overflow = "hidden";
}

function closeNowPlayingMode() {
  isNowPlayingMode = false;
  const overlay = document.getElementById("nowPlayingOverlay");
  overlay.classList.remove("active");
  document.getElementById("nowPlayingModeBtn").classList.remove("np-mode-active");
  document.body.style.overflow = "";
}

document.getElementById("nowPlayingModeBtn").addEventListener("click", () => {
  if (isNowPlayingMode) {
    closeNowPlayingMode();
  } else {
    openNowPlayingMode();
  }
});

document.getElementById("npCloseBtn").addEventListener("click", closeNowPlayingMode);

// Escape key to close
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isNowPlayingMode) closeNowPlayingMode();
});

// --- Sync track metadata into overlay ---
function npSyncTrack(track) {
  if (!track) return;

  const imgUrl = track.album?.images?.[0]?.url || "";
  document.getElementById("npTrackImage").src = imgUrl;
  document.getElementById("npTrackName").textContent = track.name;
  document.getElementById("npTrackArtist").textContent =
    track.artists?.map(a => a.name).join(", ") || "";

  // Ambient background = blurred album art
  const bgBlur = document.getElementById("npBgBlur");
  bgBlur.style.backgroundImage = imgUrl ? `url(${imgUrl})` : "none";

  // Extract dominant color for the glow halo
  npExtractDominantColor(imgUrl);

  // Sync like button (both main card + overlay via shared helper)
  const trackId = track.uri?.split(":")?.[2];
  if (trackId) {
    checkTrackLiked(trackId).then(liked => syncLikeButtons(liked));
  }
}

// --- Extract dominant color from album art (canvas trick) ---
function npExtractDominantColor(imgUrl) {
  if (!imgUrl) return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, 8, 8);
      const data = ctx.getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2];
      }
      const px = data.length / 4;
      r = Math.round(r / px);
      g = Math.round(g / px);
      b = Math.round(b / px);
      // Boost saturation — make it more vivid for the glow
      const color = `rgb(${Math.min(255, r * 1.4)},${Math.min(255, g * 1.4)},${Math.min(255, b * 1.4)})`;
      document.getElementById("npAlbumGlow").style.background = color;
    } catch (err) {
      // Canvas CORS fail — leave default glow
    }
  };
  img.src = imgUrl;
}

// --- Play / Pause sync ---
function npSyncPlayPause(playing) {
  const icon = document.getElementById("npPlayPauseBtn").querySelector("i");
  icon.className = playing ? "fas fa-pause" : "fas fa-play";
}

// --- Shuffle sync ---
function npSyncShuffle(state) {
  document.getElementById("npShuffleBtn").classList.toggle("np-shuffle-active", state);
}

// --- Overlay controls ---
document.getElementById("npPlayPauseBtn").addEventListener("click", () => {
  document.getElementById("playPauseBtn").click();
});

document.getElementById("npPrevBtn").addEventListener("click", () => prev());
document.getElementById("npNextBtn").addEventListener("click", () => next());

document.getElementById("npShuffleBtn").addEventListener("click", () => {
  document.getElementById("shuffleBtn").click();
});

document.getElementById("npLikeBtn").addEventListener("click", async () => {
  document.getElementById("likeCurrentBtn").click();
  // syncLikeButtons is called inside the main click handler — no extra work needed
});

// --- Progress bar in overlay ---
const npProgressBar = document.getElementById("npProgressBar");
npProgressBar.addEventListener("input", () => {
  isDraggingProgress = true;
});
npProgressBar.addEventListener("change", async (e) => {
  isDraggingProgress = false;
  const seekPercent = e.target.value;
  const state = await player.getCurrentState();
  if (state) {
    const seekPos = (seekPercent / 100) * state.duration;
    player.seek(seekPos);
    npUpdateProgressUI(seekPos, state.duration);
  }
});

function npUpdateProgressUI(position, duration) {
  const pct = (position / duration) * 100 || 0;
  npProgressBar.value = pct;
  npProgressBar.style.background =
    `linear-gradient(to right, rgba(255,255,255,0.85) ${pct}%, rgba(255,255,255,0.15) ${pct}%)`;
  document.getElementById("npCurrentTime").textContent = formatTime(position);
  document.getElementById("npTotalDuration").textContent = formatTime(duration);
}

// --- Lyrics in overlay ---
async function npSyncLyrics() {
  // If overlay lyrics are already for this track, just re-render and scroll
  if (npLyricsTrackUri === currentTrackUri && npParsedLyrics.length) {
    npRenderSyncedLyrics();
    return;
  }
  if (npLyricsTrackUri === currentTrackUri && npIsPlainLyrics) {
    return; // already showing
  }

  // If the main panel already has lyrics for this track, clone them
  if (lyricsTrackUri === currentTrackUri && parsedLyrics.length) {
    npParsedLyrics = parsedLyrics;
    npIsPlainLyrics = isPlainLyrics;
    npLyricsTrackUri = currentTrackUri;
    if (npIsPlainLyrics) {
      npRenderPlainLyricsFromMain();
    } else {
      npRenderSyncedLyrics();
    }
    document.getElementById("npJumpBtn").hidden = npIsPlainLyrics;
    return;
  }

  // Fetch fresh
  if (!currentTrackObject) {
    document.getElementById("npLyricsContainer").innerHTML =
      '<p class="np-lyrics-placeholder">Play a song to see lyrics.</p>';
    return;
  }

  npLyricsTrackUri = currentTrackUri;
  document.getElementById("npLyricsContainer").innerHTML = loaderHTML();
  document.getElementById("npJumpBtn").hidden = true;

  const track = currentTrackObject;
  const artist = encodeURIComponent(track.artists[0]?.name || "");
  const name = encodeURIComponent(track.name);
  const album = encodeURIComponent(track.album?.name || "");
  const duration = Math.round((track.duration_ms || 0) / 1000);

  try {
    const res = await fetch(
      `https://lrclib.net/api/get?artist_name=${artist}&track_name=${name}&album_name=${album}&duration=${duration}`
    );
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    if (data.syncedLyrics) {
      npIsPlainLyrics = false;
      npParsedLyrics = parseLRC(data.syncedLyrics);
      npRenderSyncedLyrics();
      document.getElementById("npJumpBtn").hidden = false;
    } else if (data.plainLyrics) {
      npIsPlainLyrics = true;
      npParsedLyrics = [];
      npRenderPlainLyrics(data.plainLyrics);
      document.getElementById("npJumpBtn").hidden = true;
    } else {
      document.getElementById("npLyricsContainer").innerHTML =
        '<p class="np-lyrics-placeholder">No lyrics available.</p>';
    }
  } catch {
    document.getElementById("npLyricsContainer").innerHTML =
      '<p class="np-lyrics-placeholder">Lyrics not found for this track.</p>';
  }
}

function npRenderSyncedLyrics() {
  const container = document.getElementById("npLyricsContainer");
  container.innerHTML = "";
  npParsedLyrics.forEach((line, i) => {
    const p = document.createElement("p");
    p.className = "np-lyrics-line";
    p.textContent = line.text;
    p.dataset.index = i;
    container.appendChild(p);
  });
}

function npRenderPlainLyrics(text) {
  const container = document.getElementById("npLyricsContainer");
  container.innerHTML = "";
  text.split("\n").forEach(line => {
    const p = document.createElement("p");
    p.className = "np-lyrics-line";
    p.textContent = line || " ";
    container.appendChild(p);
  });
}

function npRenderPlainLyricsFromMain() {
  // Copy DOM children from main lyrics container
  const src = document.getElementById("lyricsContainer");
  const dst = document.getElementById("npLyricsContainer");
  dst.innerHTML = src.innerHTML;
  // Replace class names to use np- prefix
  dst.querySelectorAll(".lyrics-line").forEach(el => {
    el.classList.remove("lyrics-line");
    el.classList.add("np-lyrics-line");
  });
}

// --- Lyric highlighting in overlay ---
function npUpdateLyricsHighlight(positionMs) {
  if (!isNowPlayingMode || !npParsedLyrics.length || npIsPlainLyrics) return;

  let activeIdx = 0;
  for (let i = 0; i < npParsedLyrics.length; i++) {
    if (npParsedLyrics[i].time <= positionMs) activeIdx = i;
    else break;
  }

  const lines = document.querySelectorAll("#npLyricsContainer .np-lyrics-line");
  lines.forEach((el, i) => {
    el.classList.toggle("np-active", i === activeIdx);
    el.classList.toggle("np-near", i === activeIdx - 1 || i === activeIdx + 1);
  });

  if (!npUserScrolled) npScrollLyricsToActive();
}

function npScrollLyricsToActive() {
  const activeLine = document.querySelector("#npLyricsContainer .np-lyrics-line.np-active");
  if (!activeLine) return;

  const container = document.getElementById("npLyricsContainer");
  const containerRect = container.getBoundingClientRect();
  const lineRect = activeLine.getBoundingClientRect();
  const lineScrollTop = lineRect.top - containerRect.top + container.scrollTop;
  const target = lineScrollTop - (container.clientHeight / 2) + (activeLine.offsetHeight / 2);

  npIsProgrammaticScroll = true;
  container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  setTimeout(() => { npIsProgrammaticScroll = false; }, 700);
}

document.getElementById("npLyricsContainer").addEventListener("scroll", () => {
  if (!npIsProgrammaticScroll) npUserScrolled = true;
}, { passive: true });

document.getElementById("npJumpBtn").addEventListener("click", () => {
  npUserScrolled = false;
  npScrollLyricsToActive();
});

// (overlay hooks are embedded directly in the original functions above)

