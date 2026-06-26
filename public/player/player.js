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

    loadLikedSongs();
    loadUserPlaylists();
    syncShuffleState();
    startTokenRefreshTimer();
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
async function playContext({ contextUri, uris, offset = 0 }) {
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

  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/me/player/shuffle?state=${newState}&device_id=${deviceId}`,
    {
      method: "PUT",
    }
  );

  if (res.ok) {
    setShuffleUI(newState);
    setTimeout(loadQueueView, 600);
  } else {
    const err = await res.json();
    alert(`Shuffle failed: ${err.error.message}`);
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
}

function setShuffleUI(state) {
  isShuffle = state;
  const btn = document.getElementById("shuffleBtn");
  btn.classList.toggle("shuffle-active", state);
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
  const trackId = track.uri.split(":")[2];
  checkTrackLiked(trackId).then(liked => {
    document.getElementById("likeCurrentBtn").classList.toggle("liked", liked);
  });
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

    // On first load: if nothing is actively playing, show first track + seed queue
    if (!currentTrackUri && selectedPlaylist.tracks.length > 0) {
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

  // Silently fetch all remaining pages in background so shuffle includes every track.
  // Spotify doesn't support context_uri for Liked Songs, so we must supply all URIs.
  loadRemainingLikedSongs();
}

async function loadRemainingLikedSongs() {
  const session = ++likedSongsLoadSession;
  let url = nextTracksUrl;
  while (url) {
    if (session !== likedSongsLoadSession) return; // user switched away — abort
    try {
      const res = await fetchWithAuth(url);
      const data = await res.json();
      if (session !== likedSongsLoadSession) return;
      url = data.next;
      nextTracksUrl = data.next;
      const newTracks = data.items.map(i => i.track).filter(Boolean);
      selectedPlaylist.tracks.push(...newTracks);
      renderTrackList(newTracks, true);
    } catch (err) {
      console.error("Background liked songs load failed:", err);
      return;
    }
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
    if (res.ok) {
      document.getElementById("likeCurrentBtn").classList.remove("liked");
      showToast("Removed from Liked Songs");
    }
  } else {
    const res = await fetchWithAuth(`https://api.spotify.com/v1/me/tracks?ids=${trackId}`, { method: "PUT", body: JSON.stringify([trackId]) });
    if (res.ok) {
      document.getElementById("likeCurrentBtn").classList.add("liked");
      showToast("Added to Liked Songs");
    }
  }
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

function showToast(message) {
  const toast = document.getElementById("toastMsg");
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2500);
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
  upcoming.forEach(track => {
    const li = buildTrackRow(track, () => playContext({ uris: [track.uri] }));
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
    const items = [
      ...(data.currently_playing ? [{ ...data.currently_playing, _isCurrent: true }] : []),
      ...(data.queue || []),
    ].filter(Boolean);
    if (!items.length) {
      content.innerHTML = '<p class="queue-placeholder">Queue is empty.</p>';
      return;
    }
    items.forEach(track => {
      const li = buildTrackRow(track, () => {
        if (!track._isCurrent) playContext({ uris: [track.uri] });
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

document.getElementById("flipBackBtn").addEventListener("click", (e) => {
  e.stopPropagation();
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
    document.getElementById("likeCurrentBtn").classList.add("liked");
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
    document.getElementById("likeCurrentBtn").classList.remove("liked");
    showToast("Removed from Liked Songs");
  }
  closeContextMenu();
});
