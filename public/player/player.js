let player;
let deviceId;

const token = localStorage.getItem("access_token");
if (!token) {
  alert("No access token found. Please login first.");
  window.location.href = "/";
}

// --- LOGOUT ---
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  localStorage.removeItem("access_token");
  localStorage.removeItem("code_verifier");
  window.location.href = "/"; // back to login page
});

// Initialize Spotify Web Playback SDK
window.onSpotifyWebPlaybackSDKReady = () => {
  player = new Spotify.Player({
    name: "Local Web Player",
    getOAuthToken: cb => { cb(token); },
    volume: 0.5
  });

  player.addListener("ready", ({ device_id }) => {
    deviceId = device_id;
    console.log("Ready with Device ID", device_id);

    loadUserPlaylists();
  });

  player.connect();
};

// Basic playback controls
document.getElementById("playBtn").onclick = () => play();
document.getElementById("pauseBtn").onclick = () => pause();
document.getElementById("nextBtn").onclick = () => next();
document.getElementById("prevBtn").onclick = () => prev();
document.getElementById("shuffleBtn").onclick = () => toggleShuffle();

// Playback functions
function play(uris) {
  fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token },
    body: uris ? JSON.stringify({ uris }) : undefined
  });
}
function pause() {
  fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`, { method: "PUT", headers: { Authorization: "Bearer " + token } });
}
function next() {
  fetch(`https://api.spotify.com/v1/me/player/next?device_id=${deviceId}`, { method: "POST", headers: { Authorization: "Bearer " + token } });
}
function prev() {
  fetch(`https://api.spotify.com/v1/me/player/previous?device_id=${deviceId}`, { method: "POST", headers: { Authorization: "Bearer " + token } });
}
function toggleShuffle() {
  fetch(`https://api.spotify.com/v1/me/player/shuffle?state=true&device_id=${deviceId}`, { method: "PUT", headers: { Authorization: "Bearer " + token } });
}

// Load user playlists
function loadUserPlaylists() {
  fetch("https://api.spotify.com/v1/me/playlists", {
    headers: { Authorization: "Bearer " + token }
  })
  .then(res => res.json())
  .then(data => {
    const ul = document.getElementById("playlistList");
    ul.innerHTML = "";
    data.items.forEach(pl => {
      const li = document.createElement("li");
      li.textContent = pl.name;
      li.onclick = () => playPlaylist(pl.id);
      ul.appendChild(li);
    });
  });
}

// Play a playlist
function playPlaylist(playlistId) {
  fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
    headers: { Authorization: "Bearer " + token }
  })
  .then(res => res.json())
  .then(data => {
    const uris = data.items.map(item => item.track.uri);
    play(uris);
  });
}

// Search tracks/playlists
document.getElementById("searchBtn").onclick = () => {
  const query = document.getElementById("searchInput").value;
  fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track,playlist&limit=10`, {
    headers: { Authorization: "Bearer " + token }
  })
  .then(res => res.json())
  .then(data => {
    const ul = document.getElementById("searchResults");
    ul.innerHTML = "";

    if(data.tracks) {
      data.tracks.items.forEach(track => {
        const li = document.createElement("li");
        li.textContent = track.name + " - " + track.artists.map(a => a.name).join(", ");
        li.onclick = () => play([track.uri]);
        ul.appendChild(li);
      });
    }
    if(data.playlists) {
      data.playlists.items.forEach(pl => {
        const li = document.createElement("li");
        li.textContent = "🎵 " + pl.name;
        li.onclick = () => playPlaylist(pl.id);
        ul.appendChild(li);
      });
    }
  });
};
