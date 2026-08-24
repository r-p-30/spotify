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
    // Happens when a stale /callback?code=... URL gets re-run (e.g. browser
    // back button after the flow already completed, or a duplicate load) —
    // the verifier is already consumed. Log out cleanly instead of alerting.
    console.warn("Missing PKCE verifier — stale callback, logging out.");
    forceLogout("missing_pkce_verifier");
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
      forceLogout("token_exchange_failed");
      return;
    }

    localStorage.setItem("access_token", data.access_token);
    if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
    if (data.expires_in) localStorage.setItem("token_expiry", Date.now() + data.expires_in * 1000);
    localStorage.removeItem("pkce_code_verifier");

    window.location.href = "/player/player.html";
  } catch (err) {
    console.error("Callback error:", err);
    forceLogout("callback_error");
  }
}

// Single, idempotent exit path for every auth failure (missing verifier, failed
// refresh, expired session, SDK auth errors). Without this, several independent
// requests failing at once after a long idle period could each fire their own
// alert()/redirect, stacking blocking dialogs and making the app look stuck.
let _loggingOut = false;

function forceLogout(reason) {
  if (_loggingOut) return;
  _loggingOut = true;
  if (reason) console.warn("Logging out:", reason);
  localStorage.clear();
  window.location.href = "/";
}
window.forceLogout = forceLogout;

// Singleton promise to prevent concurrent refresh calls from burning through
// Spotify's one-time-use (rotated) refresh tokens, which causes a 500
// "Failed to remove token" error on the second simultaneous request.
let _refreshPromise = null;

async function refreshAccessToken() {
  if (_refreshPromise) {
    // A refresh is already in-flight — piggyback on it instead of starting a new one
    return _refreshPromise;
  }

  const refreshToken = localStorage.getItem("refresh_token");
  if (!refreshToken) {
    forceLogout("no_refresh_token");
    return false;
  }

  _refreshPromise = (async () => {
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
        if (data.expires_in) localStorage.setItem("token_expiry", Date.now() + data.expires_in * 1000);
        return true;
      }

      console.error("Failed to refresh token", data);
    } catch (err) {
      console.error("Refresh token error:", err);
    }
    // Any refresh failure (invalid_grant, network error, server error) means
    // the session can't continue — log out instead of leaving stale tokens
    // around for the caller to figure out.
    forceLogout("refresh_failed");
    return false;
  })().finally(() => {
    // Clear the lock so future expiries can trigger a fresh refresh
    _refreshPromise = null;
  });

  return _refreshPromise;
}

window.refreshAccessToken = refreshAccessToken;
