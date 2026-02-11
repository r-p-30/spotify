// GLOBAL STATE
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
let nextTracksUrl = null;
let isLoadingMore = false;
let progressInterval;
let isDraggingProgress = false;
let currentTrackUri = null;


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
})();

// LOGOUT
document.getElementById("logoutBtn")?.addEventListener("click", () => {
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
  });

  player.addListener("player_state_changed", (state) => {
    if (!state) return;

    isPlaying = !state.paused;
    updatePlayPauseButton(isPlaying);
    
    // Update highlight
    if (state.track_window.current_track) {
      currentTrackUri = state.track_window.current_track.uri;
      highlightCurrentTrack();
    }

    updateCurrentTrackInfo(state.track_window.current_track);
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
document.getElementById("likeBtn").onclick = toggleLike;


playPauseBtn.onclick = async () => {
  if (!player) return;

  const state = await player.getCurrentState();
  if (!state) {
    // No active playback on this device, start from the top of the selected playlist
    playContext({
      contextUri: selectedPlaylist.contextUri,
      offset: 0,
    });
  } else {
    player.togglePlay();
  }
};

// PLAYBACK
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

// SHUFFLE
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

  trackNameEl.textContent = track.name;
  trackArtistEl.textContent = track.artists.map(a => a.name).join(", ");
  trackImageEl.src = track.album.images[0]?.url || "";

  checkIfLiked(track.id);
}

// TOGGLE LIKE
async function toggleLike() {
  if (!currentTrackUri) return;

  const trackId = currentTrackUri.split(":").pop();
  const btn = document.getElementById("likeBtn");
  const isLiked = btn.classList.contains("active");

  // Optimistic update
  btn.classList.toggle("active");
  const icon = btn.querySelector("i");
  icon.className = isLiked ? "far fa-heart" : "fas fa-heart";

  const method = isLiked ? "DELETE" : "PUT";
  
  try {
    const res = await fetchWithAuth(`https://api.spotify.com/v1/me/tracks?ids=${trackId}`, {
      method: method,
    });

    if (!res.ok) {
       throw new Error("Failed to update like status");
    }

    // Refresh liked songs list if we are currently viewing it
    if (selectedPlaylistName === "Liked Songs") {
        loadLikedSongs(); // Reload to reflect changes
    }

  } catch (err) {
    console.error("Like toggle failed", err);
    // Revert on failure
    btn.classList.toggle("active");
    icon.className = isLiked ? "fas fa-heart" : "far fa-heart";
    alert("Failed to update like status");
  }
}

async function checkIfLiked(trackId) {
  if (!trackId) return;

  try {
    const res = await fetchWithAuth(`https://api.spotify.com/v1/me/tracks/contains?ids=${trackId}`);
    const [isLiked] = await res.json();
    
    const btn = document.getElementById("likeBtn");
    const icon = btn.querySelector("i");

    if (isLiked) {
      btn.classList.add("active");
      icon.className = "fas fa-heart";
    } else {
      btn.classList.remove("active");
      icon.className = "far fa-heart";
    }

  } catch (err) {
    console.error("Failed to check like status", err);
  }
}

// LIKED SONGS
async function loadLikedSongs() {
  selectedPlaylistName = "Liked Songs";

  const res = await fetchWithAuth("https://api.spotify.com/v1/me/tracks?limit=50");

  const data = await res.json();
  nextTracksUrl = data.next;

  selectedPlaylist = {
    name: "Liked Songs",
    tracks: data.items.map(i => i.track),
    contextUri: "spotify:user:me:collection",
  };

  renderSelectedPlaylist();
  renderPlaylistSidebar();
  
  // Reset scroll to top
  document.querySelector(".selected-playlist").scrollTop = 0;
}

// Infinite Scroll Listener
const playlistContainer = document.querySelector(".selected-playlist");
if (playlistContainer) {
  playlistContainer.addEventListener("scroll", (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    if (scrollTop + clientHeight >= scrollHeight - 50) {
      loadMoreTracks();
    }
  });
} else {
  console.error("Could not find .selected-playlist element to attach scroll listener");
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

  // Render "Liked Songs" Card
  if (selectedPlaylistName !== "Liked Songs") {
    const li = createPlaylistCard({
      name: "Liked Songs",
      images: [] // No image, will handle in createPlaylistCard
    }, true);
    li.onclick = loadLikedSongs;
    ul.appendChild(li);
  }

  // Render User Playlists
  cachedPlaylists.forEach(pl => {
    if (pl.name === selectedPlaylistName) return;

    const li = createPlaylistCard(pl);
    li.onclick = () => selectPlaylist(pl);
    ul.appendChild(li);
  });
}

function createPlaylistCard(pl, isLikedSongs = false) {
  const li = document.createElement("li");
  li.className = "playlist-card";
  li.title = pl.name; // Tooltip for full name

  const imgDiv = document.createElement("div");
  imgDiv.className = "playlist-card-img";
  
  if (isLikedSongs) {
    imgDiv.innerHTML = '<i class="fas fa-heart" style="font-size: 2rem; color: #fff;"></i>';
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
    imgDiv.innerHTML = '<i class="fas fa-music" style="font-size: 2rem; color: #fff;"></i>';
    imgDiv.style.background = "#333";
    imgDiv.style.display = "flex";
    imgDiv.style.alignItems = "center";
    imgDiv.style.justifyContent = "center";
  }

  const nameDiv = document.createElement("div");
  nameDiv.className = "playlist-name";
  nameDiv.textContent = pl.name;

  li.appendChild(imgDiv);
  li.appendChild(nameDiv);

  return li;
}

async function selectPlaylist(pl) {
  selectedPlaylistName = pl.name;

  const res = await fetchWithAuth(
    `https://api.spotify.com/v1/playlists/${pl.id}/tracks?limit=50`
  );

  const data = await res.json();
  nextTracksUrl = data.next;

  selectedPlaylist = {
    name: pl.name,
    tracks: data.items.map(i => i.track),
    contextUri: pl.uri,
  };

  renderSelectedPlaylist();
  renderPlaylistSidebar();
  
  // Reset scroll to top
  document.querySelector(".selected-playlist").scrollTop = 0;
}

// SELECTED PLAYLIST VIEW
function renderSelectedPlaylist() {
  document.getElementById("selectedPlaylistName").textContent = selectedPlaylist.name;
  renderTrackList(selectedPlaylist.tracks);
}

function renderTrackList(tracks, append = false) {
  const ul = document.getElementById("selectedPlaylistTracks");
  if (!append) ul.innerHTML = "";

  tracks.forEach((track, idx) => {
    const li = document.createElement("li");
    li.textContent = `${track.name} - ${track.artists.map(a => a.name).join(", ")}`;
    li.dataset.uri = track.uri;

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
