# Spotify Player

A personal Spotify client built on top of the [Spotify Web API](https://developer.spotify.com/documentation/web-api) and [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk). Created because the official Spotify desktop app is blocked for hardened systems, this runs entirely locally using your own Spotify Developer credentials, so playback is controlled through your account with no restrictions.

Features include playlist browsing, search, lyrics, queue view, audio stats, and full playback control.

## Setup

1. Create an app at [developer.spotify.com](https://developer.spotify.com/dashboard) and grab your `Client ID`.
2. Set the Redirect URI in your Spotify app settings to `http://127.0.0.1:3004/callback`.
3. Copy `.env.example` → `.env` and fill in your `CLIENT_ID` and `REDIRECT_URI`.

## Run

```bash
npm install && npm start
```

Then open **http://127.0.0.1:3004** in your browser and log in with your Spotify account.

> **Note:** Your Spotify account must have an active Premium subscription for playback control via the Web Playback SDK.

## Deploy to Render

This repo includes a [`render.yaml`](render.yaml) Blueprint for Render's free tier.

1. Push to GitHub, then on [render.com](https://render.com) go to **New → Blueprint** and connect this repo. Render detects `render.yaml` automatically.
2. When prompted, set these environment variables:
   - `CLIENT_ID` — your Spotify app's client ID
   - `REDIRECT_URI` — `https://<your-service>.onrender.com/callback`
   - `ALLOWED_ORIGIN` — `https://<your-service>.onrender.com`
3. Add `https://<your-service>.onrender.com/callback` as a Redirect URI in your [Spotify app settings](https://developer.spotify.com/dashboard) (alongside your local one).
4. Open the deployed URL and log in.

> **Note:** Render's free plan spins down after ~15 min idle — the first request after a gap takes 30-50s to cold-start.