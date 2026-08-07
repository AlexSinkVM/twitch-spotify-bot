const tmi = require('tmi.js');
const SpotifyWebApi = require('spotify-web-api-node');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

// === Configuración Spotify ===
const clientId = '90e213d3dedf4d7aa7aa0c3ad00eb1ff';
const clientSecret = '45f592b007024040a44c80b032e6a4eb';
const redirectUri = 'https://twitch-spotify-bot.onrender.com/callback';
const redirectOrigin = new URL(redirectUri).origin;
const scopes = ['user-modify-playback-state', 'user-read-playback-state'];

const spotifyApi = new SpotifyWebApi({ clientId, clientSecret, redirectUri });
const TOKEN_PATH = path.join(__dirname, 'spotify_token.json');

// === Funciones de tokens ===
function saveTokens(data) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(data));
  console.log('✅ Tokens guardados');
}

function deleteTokens() {
  if (fs.existsSync(TOKEN_PATH)) {
    fs.unlinkSync(TOKEN_PATH);
    console.log('🗑️ Token revocado: se eliminó el archivo de tokens.');
  }
}

function loadTokens() {
  if (fs.existsSync(TOKEN_PATH)) {
    const data = fs.readFileSync(TOKEN_PATH);
    return JSON.parse(data);
  }
  return null;
}

const savedTokens = loadTokens();
if (savedTokens) {
  spotifyApi.setAccessToken(savedTokens.access_token);
  spotifyApi.setRefreshToken(savedTokens.refresh_token);
  console.log('🔄 Tokens cargados desde disco');
}

async function refreshTokenIfNeeded() {
  const refreshToken = spotifyApi.getRefreshToken();
  if (!refreshToken) {
    throw new Error('No hay refresh token disponible. Autentica Spotify de nuevo.');
  }

  try {
    const data = await spotifyApi.refreshAccessToken();
    spotifyApi.setAccessToken(data.body.access_token);
    saveTokens({
      access_token: data.body.access_token,
      refresh_token: refreshToken,
    });
    console.log('🔄 Token de acceso refrescado');
  } catch (error) {
    const message = error.body?.error?.message || error.message || String(error);
    console.error('⚠️ Error refrescando token:', message);

    if (message.includes('invalid_grant') || message.includes('Refresh token revoked')) {
      deleteTokens();
      throw new Error('Refresh token revocado o inválido. Elimina el token y vuelve a autenticar Spotify en /login.');
    }

    throw error;
  }
}

// === Express para autenticación Spotify ===
const app = express();
const PORT = process.env.PORT || 8888;

app.get('/login', (req, res) => {
  const url = spotifyApi.createAuthorizeURL(scopes);
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    spotifyApi.setAccessToken(data.body.access_token);
    spotifyApi.setRefreshToken(data.body.refresh_token);
    saveTokens({
      access_token: data.body.access_token,
      refresh_token: data.body.refresh_token,
    });
    res.send('✅ Spotify conectado. Puedes cerrar esta pestaña.');
  } catch (error) {
    console.error('⚠️ Error en el callback:', error);
    res.status(500).send('Error en la autenticación con Spotify.');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en ${redirectOrigin}/login`);
});

const keepAliveUrl = `http://localhost:${PORT}/login`;
setInterval(() => {
  http.get(keepAliveUrl).on('error', err => {
    console.error('⛔ Ping interno falló:', err.message);
  });
}, 1000 * 60 * 4);

// === Twitch Bot ===
const twitchClient = new tmi.Client({
  options: { debug: true },
  identity: {
    username: 'aletsink',
    password: 'oauth:9s9nn7d1c0p4exfj4c13r3qu9zy0x4',
  },
  channels: ['aletsink'],
});

twitchClient.connect().then(() => {
  console.log('✅ Conectado a Twitch');
}).catch(console.error);

const customRewardId = '154d4847-aec0-4b73-8f21-0e3313bc6c4f';
const mensajesDelBot = [
  '🎶 Añadido a la cola:',
  '❌ No encontré la canción',
];

const queue = [];
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const { channel, message } = queue.shift();

    try {
      await refreshTokenIfNeeded();
      const result = await spotifyApi.searchTracks(message);
      const track = result.body.tracks.items[0];
      if (track) {
        await spotifyApi.addToQueue(track.uri);
        twitchClient.say(channel, `🎶 Añadido a la cola: "${track.name}" - ${track.artists[0].name}`);
      } else {
        twitchClient.say(channel, `❌ No encontré la canción: "${message}"`);
      }
      // Espera un poco para no saturar la API
      await new Promise(r => setTimeout(r, 1500));
    } catch (error) {
      console.error('⚠️ Error al añadir canción:', error.message || error);

      if (error.statusCode === 429) {
        const retryAfter = parseInt(error.headers?.['retry-after'], 10) || 5;
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }

      const spotifyError = error.body?.error?.message || error.message || 'Error desconocido';
      const isAuthError = error.statusCode === 401 || error.statusCode === 403;

      if (isAuthError) {
        twitchClient.say(channel, '⚠️ Error de autenticación con Spotify. Por favor, vuelve a conectar el bot.');
        break;
      }

      if (spotifyError) {
        twitchClient.say(channel, `⚠️ Error de Spotify: ${spotifyError}`);
      } else {
        twitchClient.say(channel, '⚠️ Ocurrió un error al intentar añadir la canción.');
      }
    }
  }

  processing = false;
}

twitchClient.on('message', (channel, tags, message, self) => {
  if (self) return;
  if (channel !== '#aletsink') return;
  if (mensajesDelBot.some(m => message.startsWith(m))) return;

  if (tags['custom-reward-id'] === customRewardId) {
    queue.push({ channel, message });
    processQueue();
  }
});
