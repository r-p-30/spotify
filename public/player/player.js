let player;
let deviceId;
let isPlaying = false;

const progressBar = document.getElementById("progressBar");
const currentTimeEl = document.getElementById("currentTime");
const totalTimeEl = document.getElementById("totalTime");

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec < 10 ? "0" + sec : sec}`;
}

const token = localStorage.getItem("access_token");
if (!token) {
  alert("No access token found. Please login first.");
  window.location.href = "/";
}

// --- LOGOUT ---
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  localStorage.removeItem("access_token");
  localStorage.removeItem("code_verifier");
  window.location.href = "/";
});

// Initialize Spotify Web Playback SDK
window.onSpotifyWebPlaybackSDKReady = () => {
  player = new Spotify.Player({
    name: "Local Web Player",
    getOAuthToken: (cb) => {
      cb(token);
    },
    volume: 0.5,
  });

  player.addListener("ready", ({ device_id }) => {
    deviceId = device_id;
    console.log("Ready with Device ID", device_id);

    loadLikedSongs();
    loadUserPlaylists();
  });

  player.addListener("player_state_changed", (state) => {
    if (!state) return;

    const position = state.position;
    const duration = state.duration;

    progressBar.value = (position / duration) * 100;
    currentTimeEl.textContent = formatTime(position);
    totalTimeEl.textContent = formatTime(duration);
  });

  player.connect();
};

// --- Controls ---
const playPauseBtn = document.getElementById("playPauseBtn");
document.getElementById("prevBtn").onclick = prev;
document.getElementById("nextBtn").onclick = next;
document.getElementById("shuffleBtn").onclick = toggleShuffle;
playPauseBtn.onclick = () => {
  if (isPlaying) pause();
  else play();
};

// --- Playback functions ---
function play(uris) {
  fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token },
    body: uris ? JSON.stringify({ uris }) : undefined,
  }).then(() => {
    isPlaying = true;
    updatePlayPauseButton(true);
  });
}

function pause() {
  fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token },
  }).then(() => {
    isPlaying = false;
    updatePlayPauseButton(false);
  });
}

function next() {
  fetch(`https://api.spotify.com/v1/me/player/next?device_id=${deviceId}`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
  });
}

function prev() {
  fetch(`https://api.spotify.com/v1/me/player/previous?device_id=${deviceId}`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
  });
}

function toggleShuffle() {
  fetch(
    `https://api.spotify.com/v1/me/player/shuffle?state=true&device_id=${deviceId}`,
    {
      method: "PUT",
      headers: { Authorization: "Bearer " + token },
    }
  );
}

// --- UI Updates ---
function updatePlayPauseButton(isPlaying) {
  const icon = playPauseBtn.querySelector("i");
  icon.className = isPlaying ? "fas fa-pause" : "fas fa-play";
}

function updateCurrentTrackInfo(track) {
  if (!track) return;
  document.getElementById("trackName").textContent = track.name;
  document.getElementById("trackArtist").textContent = track.artists
    .map((a) => a.name)
    .join(", ");
  document.getElementById("trackImage").src = track.album.images[0]?.url || "";
}

// Fetch liked songs
async function loadLikedSongs() {
  const ul = document.getElementById("playlistList");

  const data = await fetch("https://api.spotify.com/v1/me/tracks?limit=50", {
    headers: { Authorization: "Bearer " + token },
  }).then((res) => res.json());

  const li = document.createElement("li");
  li.className = "playlist-item";
  li.textContent = "💖 Liked Songs";

  const trackList = document.createElement("ul");
  trackList.className = "playlist-tracks";
  trackList.style.display = "none";
  li.appendChild(trackList);

  li.onclick = () => {
    if (trackList.style.display === "none") {
      trackList.innerHTML = "";
      trackList.style.display = "block";

      data.items.forEach((item) => {
        const trackLi = document.createElement("li");
        trackLi.textContent = `${item.track.name} - ${item.track.artists
          .map((a) => a.name)
          .join(", ")}`;
        trackLi.onclick = (ev) => {
          ev.stopPropagation();
          play([item.track.uri]);
        };
        trackList.appendChild(trackLi);
      });
    } else {
      trackList.style.display = "none";
    }
  };

  ul.prepend(li); // show Liked Songs at the top
}

// --- Load Playlists with individual search and shuffle ---
async function loadUserPlaylists() {
  const ul = document.getElementById("playlistList");
  ul.innerHTML = "";

  const data = await fetch("https://api.spotify.com/v1/me/playlists", {
    headers: { Authorization: "Bearer " + token },
  }).then((res) => res.json());

  data.items.forEach((pl) => {
    const li = document.createElement("li");
    li.className = "playlist-item";

    // Playlist header container
    const headerDiv = document.createElement("div");
    headerDiv.className = "playlist-header";

    // Playlist name (cropped if too long)
    const nameSpan = document.createElement("span");
    nameSpan.className = "playlist-name";
    nameSpan.textContent = pl.name;
    nameSpan.title = pl.name; // full name on hover
    headerDiv.appendChild(nameSpan);

    // Shuffle button
    const shuffleBtn = document.createElement("button");
    shuffleBtn.innerHTML = '<i class="fas fa-random"></i>';
    shuffleBtn.className = "btn-shuffle-playlist";
    headerDiv.appendChild(shuffleBtn);

    li.appendChild(headerDiv);

    // Search input
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search tracks...";
    searchInput.className = "playlist-search";
    li.appendChild(searchInput);

    // Track container
    const trackList = document.createElement("ul");
    trackList.className = "playlist-tracks";
    li.appendChild(trackList);

    // Click shuffle
    shuffleBtn.onclick = (ev) => {
      ev.stopPropagation();
      fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token },
        body: JSON.stringify({
          context_uri: pl.uri,
          offset: { position: Math.floor(Math.random() * pl.tracks.total) },
          position_ms: 0,
        }),
      });
      isPlaying = true;
      updatePlayPauseButton(true);
    };

    // Expand playlist and load tracks
    nameSpan.onclick = async () => {
      if (trackList.style.display === "none" || !trackList.innerHTML) {
        trackList.innerHTML = "<li>Loading...</li>";
        trackList.style.display = "block";

        const tracksData = await fetch(
          `https://api.spotify.com/v1/playlists/${pl.id}/tracks`,
          {
            headers: { Authorization: "Bearer " + token },
          }
        ).then((res) => res.json());

        trackList.innerHTML = "";
        tracksData.items.forEach((item) => {
          const trackLi = document.createElement("li");
          trackLi.textContent = `${item.track.name} - ${item.track.artists
            .map((a) => a.name)
            .join(", ")}`;
          trackLi.onclick = (ev) => {
            ev.stopPropagation();
            play([item.track.uri]);
          };
          trackList.appendChild(trackLi);
        });
      } else {
        trackList.style.display = "none";
      }
    };

    // Playlist search filter
    searchInput.oninput = () => {
      const filter = searchInput.value.toLowerCase();
      const tracks = trackList.querySelectorAll("li");
      tracks.forEach((t) => {
        t.style.display = t.textContent.toLowerCase().includes(filter)
          ? "block"
          : "none";
      });
    };

    ul.appendChild(li);
  });
}

document.getElementById("searchBtn").onclick = async () => {
  const query = document.getElementById("searchInput").value.trim();
  if (!query) return;

  const loader = document.getElementById("loader");
  loader.hidden = false;

  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(
      query
    )}&type=track,playlist&limit=10`,
    {
      headers: { Authorization: "Bearer " + token },
    }
  );
  const data = await res.json();
  loader.hidden = true;

  const ul = document.getElementById("searchResults");
  ul.innerHTML = "";

  // Tracks
  if (data.tracks) {
    data.tracks.items.forEach((track) => {
      const li = document.createElement("li");
      li.textContent = `${track.name} - ${track.artists
        .map((a) => a.name)
        .join(", ")}`;
      li.onclick = () => play([track.uri]);
      ul.appendChild(li);
    });
  }

  // Playlists
  if (data.playlists) {
    data.playlists.items.forEach((pl) => {
      const li = document.createElement("li");
      li.textContent = `🎵 ${pl.name}`;
      li.onclick = () => {
        // Play the playlist first track
        fetch(`https://api.spotify.com/v1/playlists/${pl.id}/tracks`, {
          headers: { Authorization: "Bearer " + token },
        })
          .then((res) => res.json())
          .then((d) => {
            if (d.items.length) play([d.items[0].track.uri]);
          });
      };
      ul.appendChild(li);
    });
  }
};

progressBar.oninput = (e) => {
  const percent = e.target.value;
  const newPosition = (percent / 100) * player._options.track_window.current_track.duration_ms;

  fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${Math.floor(newPosition)}&device_id=${deviceId}`, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token }
  });
};
