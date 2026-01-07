import express from "express";
import fetch from "node-fetch";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://127.0.0.1:${PORT}`;

if (!CLIENT_ID) {
  console.error("Missing CLIENT_ID in environment. See .env.example");
  process.exit(1);
}

const app = express();

// Restrictive CORS: allow only the configured origin
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// Public endpoint to expose client-side config (safe: client_id is public)
app.get("/config", (req, res) => {
  res.json({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scopes: [
      "user-read-playback-state",
      "user-modify-playback-state",
      "streaming",
      "playlist-read-private",
      "playlist-read-collaborative",
      "user-library-read",
      "user-read-private",
      "user-read-email"
    ].join(" ")
  });
});

// PKCE token exchange endpoint
app.post("/token", async (req, res) => {
  const { code, code_verifier, refresh_token, grant_type } = req.body;

  try {
    let params;
  if (grant_type === "refresh_token") {
    if (!refresh_token) {
      return res.status(400).json({ error: "Missing refresh_token" });
    }
    params = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token
    });
  } else {
    // Default to strict auth code check
    if (!code || !code_verifier) {
      return res.status(400).json({ error: "Missing code or code_verifier" });
    }
    params = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier
    });
  }

    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      console.error("Token exchange failed:", tokenResponse.status, text);
      return res.status(502).json({ error: "Failed to exchange token" });
    }

    const data = await tokenResponse.json();
    res.json(data);
  } catch (err) {
    console.error("Token exchange error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Serve callback page explicitly (not strictly required if static is fine)
app.get("/callback", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "callback.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
});
