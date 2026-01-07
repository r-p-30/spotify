/*********************************
 * GLOBAL STATE
 *********************************/
let player;
let deviceId;
let isPlaying = false;
let isShuffle = false;

let selectedPlaylist = {
  name: "Liked Songs",
  tracks: [],
  contextUri: "spotify:user:me:collection",
};

let selectedPlaylistName = "Liked Songs";

/*********************************
 * AUTH
 *********************************/
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
})();

/*********************************
 * LOGOUT
 *********************************/
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  localStorage.clear();
  window.location.href = "/";
});

/*********************************
 * SPOTIFY SDK INIT (CRITICAL FIX)
 *********************************/
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
  });

  player.addListener("player_state_changed", (state) => {
    if (!state) return;

    isPlaying = !state.paused;
    updatePlayPauseButton(isPlaying);
    updateCurrentTrackInfo(state.track_window.current_track);
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

/*********************************
 * CONTROLS
 *********************************/
const playPauseBtn = document.getElementById("playPauseBtn");

// GLOBAL SEARCH
document.getElementById("searchBtn").onclick = performGlobalSearch;
document.getElementById("searchInput").addEventListener("keyup", (e) => {
  if (e.key === "Enter") performGlobalSearch();
});

async function performGlobalSearch() {
  const query = document.getElementById("searchInput").value;
  if (!query) return;

  const loader = document.getElementById("loader");
  const resultsFunc = document.getElementById("searchResults");
  
  loader.hidden = false;
  resultsFunc.innerHTML = "";
  resultsFunc.classList.remove("active");

  try {
    const res = await fetchWithAuth(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=20`);
    
    const data = await res.json();
    loader.hidden = true;

    if (!data.tracks || data.tracks.items.length === 0) {
      alert("No tracks found");
      return;
    }

    resultsFunc.classList.add("active");
    data.tracks.items.forEach(track => {
      const li = document.createElement("li");
      li.textContent = `${track.name} - ${track.artists.map(a => a.name).join(", ")}`;
      li.onclick = () => {
        playContext({ uris: [track.uri] }); // Play single track using uris
        resultsFunc.classList.remove("active");
        document.getElementById("searchInput").value = "";
      };
      resultsFunc.appendChild(li);
    });

  } catch (err) {
    console.error("Search failed", err);
    loader.hidden = true;
  }
}

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
  if (isPlaying) pause();
  else {
    playContext({
      contextUri: selectedPlaylist.contextUri,
      offset: 0,
    });
  }
};

/*********************************
 * PLAYBACK
 *********************************/
async function playContext({ contextUri, uris, offset = 0 }) {
  if (!deviceId) return;

  const body = {};
  
  if (uris) {
    body.uris = uris;
    body.offset = { position: offset };
  } else if (contextUri === "spotify:user:me:collection") {
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
  updatePlayPauseButton(true);
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
    });
  }, 200);
}

/*********************************
 * SHUFFLE
 *********************************/
async function toggleShuffle(override) {
  const newState = !isShuffle;

  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/me/player/shuffle?state=${newState}&device_id=${deviceId}`,
    {
      method: "PUT",
    }
  );

  if (res.ok) {
    setShuffleUI(newState);
  } else {
    const err = await res.json();
    alert(`Shuffle failed: ${err.error.message}`);
  }
}

async function syncShuffleState() {
  const res = await fetchWithAuth("https://api.spotify.com/v1/me/player");

  // Spotify returns 204 when nothing is playing
  if (res.status === 204) {
    console.log("No active playback session yet");
    return;
  }

  if (!res.ok) {
    console.warn("Failed to fetch player state:", res.status);
    return;
  }

  const data = await res.json();

  if (typeof data.shuffle_state === "boolean") {
    setShuffleUI(data.shuffle_state);
  }
}

/*********************************
 * UI
 *********************************/
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

  trackNameEl.textContent = track.name;
  trackArtistEl.textContent = track.artists.map(a => a.name).join(", ");
  trackImageEl.src = track.album.images[0]?.url || "";
}

/*********************************
 * LIKED SONGS
 *********************************/
async function loadLikedSongs() {
  selectedPlaylistName = "Liked Songs";

  const res = await fetchWithAuth("https://api.spotify.com/v1/me/tracks?limit=50");

  const data = await res.json();

  selectedPlaylist = {
    name: "Liked Songs",
    tracks: data.items.map(i => i.track),
    contextUri: "spotify:user:me:collection",
  };

  renderSelectedPlaylist();
  renderPlaylistSidebar();
}

/*********************************
 * PLAYLISTS
 *********************************/
let cachedPlaylists = [];

async function loadUserPlaylists() {
  const res = await fetchWithAuth("https://api.spotify.com/v1/me/playlists");

  const data = await res.json();
  cachedPlaylists = data.items;

  renderPlaylistSidebar();
}

function renderPlaylistSidebar() {
  const ul = document.getElementById("playlistList");
  ul.innerHTML = "";

  if (selectedPlaylistName !== "Liked Songs") {
    const li = document.createElement("li");
    li.textContent = "Liked Songs";
    li.onclick = loadLikedSongs;
    ul.appendChild(li);
  }

  cachedPlaylists.forEach(pl => {
    if (pl.name === selectedPlaylistName) return;

    const li = document.createElement("li");
    li.textContent = pl.name;
    li.onclick = () => selectPlaylist(pl);
    ul.appendChild(li);
  });
}

async function selectPlaylist(pl) {
  selectedPlaylistName = pl.name;

  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/playlists/${pl.id}/tracks`
  );

  const data = await res.json();

  selectedPlaylist = {
    name: pl.name,
    tracks: data.items.map(i => i.track),
    contextUri: pl.uri,
  };

  renderSelectedPlaylist();
  renderPlaylistSidebar();
}

/*********************************
 * SELECTED PLAYLIST VIEW
 *********************************/
function renderSelectedPlaylist() {
  document.getElementById("selectedPlaylistName").textContent = selectedPlaylist.name;
  renderTrackList(selectedPlaylist.tracks);
}

function renderTrackList(tracks) {
  const ul = document.getElementById("selectedPlaylistTracks");
  ul.innerHTML = "";

  tracks.forEach((track, idx) => {
    const li = document.createElement("li");
    li.textContent = `${track.name} - ${track.artists.map(a => a.name).join(", ")}`;

    li.onclick = () => {
      // Find original index in full playlist to play correct track
      const originalIdx = selectedPlaylist.tracks.findIndex(t => t.uri === track.uri);
      playContext({
        contextUri: selectedPlaylist.contextUri,
        offset: originalIdx !== -1 ? originalIdx : 0,
      });

      // Clear search and restore filtered list
      const playlistSearchInput = document.getElementById("playlistSearchInput");
      if (playlistSearchInput.value) {
        playlistSearchInput.value = "";
        renderTrackList(selectedPlaylist.tracks);
      }
    };

    ul.appendChild(li);
  });
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
  return res;
}
