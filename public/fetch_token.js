// fetchToken.js (browser-side)
async function fetchSpotifyTokenWithRetry() {
  const RETRY_INTERVAL = 5000; // 5 sec
  const TIMEOUT = 3 * 60 * 1000; // 3 min
  const startTime = Date.now();

  const statusMessage = document.createElement("div");
  statusMessage.id = "statusMessage";
  statusMessage.textContent = "Waiting for Spotify token... Please complete login on your phone.";
  document.body.appendChild(statusMessage);

  while (Date.now() - startTime < TIMEOUT) {
    try {
      const response = await fetch("https://script.google.com/macros/s/AKfycbxhWiJ5QUNrsfMVJ4D2bXan6twI3SI1KJ-oYhs1nzLKv0y-hLq0EjIFifKeupcjkGA/exec");
      const token = await response.text();

      if (token) {
        localStorage.setItem("access_token", token);
        statusMessage.textContent = "Token received! Redirecting...";
        window.location.href = "/player/player.html";
        return;
      }

      statusMessage.textContent = "Waiting for Spotify token... still trying.";
    } catch (err) {
      console.error("Error fetching token:", err);
      statusMessage.textContent = "Error fetching token. Retrying...";
    }

    await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL));
  }

  statusMessage.textContent = "Failed to get Spotify token after 3 minutes.";
  alert("Failed to get Spotify token after 3 minutes. Please try login again on your phone.");
}

fetchSpotifyTokenWithRetry();
