// PKCE HELPERS

function generateRandomString(length = 128) {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

async function generateCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return base64;
}

// AUTH FLOW LOGIC

const loginBtn = document.getElementById("loginBtn");

const CONFIG_URL = "/config";
const TOKEN_URL = "/token";

(async function init() {
  const params = new URLSearchParams(window.location.search);

  // Handle callback 
  if (params.has("code")) {
    await handleCallback(params.get("code"));
    return;
  }

  // Attach login button
  if (loginBtn) {
    loginBtn.addEventListener("click", login);
  }
})();

async function getConfig() {
  const res = await fetch(CONFIG_URL);
  if (!res.ok) throw new Error("Failed to load config");
  return res.json();
}

async function login() {
  try {
    const cfg = await getConfig();

    const codeVerifier = generateRandomString(128);
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    localStorage.setItem("pkce_code_verifier", codeVerifier);

    const authUrl = new URL("https://accounts.spotify.com/authorize");
    authUrl.searchParams.set("client_id", cfg.clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", cfg.redirectUri);
    authUrl.searchParams.set("scope", cfg.scopes);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("code_challenge", codeChallenge);

    window.location.href = authUrl.toString();
  } catch (err) {
    console.error("Login failed:", err);
    alert("Could not start login. Check console.");
  }
}

async function handleCallback(code) {
  const codeVerifier = localStorage.getItem("pkce_code_verifier");
  if (!codeVerifier) {
    alert("Missing PKCE verifier. Login again.");
    window.location.href = "/";
    return;
  }

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: codeVerifier })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Token exchange failed:", data);
      alert("Token exchange failed. Check console.");
      window.location.href = "/";
      return;
    }

    localStorage.setItem("access_token", data.access_token);
    if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
    localStorage.removeItem("pkce_code_verifier");

    window.location.href = "/player/player.html";
  } catch (err) {
    console.error("Callback error:", err);
    alert("Authentication failed.");
    window.location.href = "/";
  }
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem("refresh_token");
  if (!refreshToken) return false;

  try {
    const res = await fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        grant_type: "refresh_token", 
        refresh_token: refreshToken 
      })
    });
    
    const data = await res.json();
    if (res.ok && data.access_token) {
      console.log("Token refreshed successfully");
      localStorage.setItem("access_token", data.access_token);
      if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
      return true;
    }
    console.error("Failed to refresh token", data);
  } catch (err) {
    console.error("Refresh token error:", err);
  }
  return false;
}

window.refreshAccessToken = refreshAccessToken;
