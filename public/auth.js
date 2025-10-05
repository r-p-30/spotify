const clientId = "244de89a12e446b99a60bdd0892d75ff"; // Spotify client ID
const redirectUri = "http://127.0.0.1:3000/callback";
const scopes = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "streaming",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read"
].join(" ");

// --- LOGIN ---
document.getElementById("loginBtn")?.addEventListener("click", async () => {
  const codeVerifier = generateRandomString(128);
  localStorage.setItem("code_verifier", codeVerifier);

  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.append("client_id", clientId);
  authUrl.searchParams.append("response_type", "code");
  authUrl.searchParams.append("redirect_uri", redirectUri);
  authUrl.searchParams.append("scope", scopes);
  authUrl.searchParams.append("code_challenge_method", "S256");
  authUrl.searchParams.append("code_challenge", codeChallenge);

  window.location.href = authUrl.toString();
});

// --- HELPER FUNCTIONS ---
function generateRandomString(length) {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

async function generateCodeChallenge(codeVerifier) {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// --- HANDLE REDIRECT (CALLBACK) ---
if (window.location.search.includes("code=")) {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const codeVerifier = localStorage.getItem("code_verifier");

  if (!codeVerifier) {
    alert("Code verifier not found. Please login again.");
    window.location.href = "/";
  } else {
    fetch("http://localhost:3000/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
    })
      .then(res => res.json())
      .then(data => {
        if (!data.access_token) {
          console.error("Token request failed:", data);
          alert("Failed to get access token. Check console for details.");
          return;
        }

        localStorage.setItem("access_token", data.access_token);
        localStorage.removeItem("code_verifier"); // no longer needed
        window.location.href = "/player/player.html"; // redirect to player page
      })
      .catch(err => {
        console.error("Token request error:", err);
        alert("Error fetching access token. Check console.");
      });
  }
}
