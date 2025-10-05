import express from "express";
import fetch from "node-fetch";
import path from "path";
import cors from "cors"; // <- import cors
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors()); // <- allow all origins
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// PKCE token exchange
app.post("/token", async (req, res) => {
  const { code, code_verifier } = req.body;

  try {
    const params = new URLSearchParams({
      client_id: "244de89a12e446b99a60bdd0892d75ff",
      grant_type: "authorization_code",
      code,
      redirect_uri: `http://127.0.0.1:${PORT}/callback`,
      code_verifier
    });

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Callback route
app.get("/callback", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "callback.html"));
});

app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
