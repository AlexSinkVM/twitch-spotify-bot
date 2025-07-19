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
const scopes = ['user-modify-playback-state', 'user-read-playback-state'];

const spotifyApi = new SpotifyWebApi({ clientId, clientSecret, redirectUri });
const TOKEN_PATH = path.join(__dirname, 'spotify_token.json');

// === Funciones de tokens ===
function saveTokens(data) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(data));
  console.log('✅ Tokens guardados');
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
  try {
    const data = await spotifyApi.refreshAccessToken();
    spotifyApi.setAccessToken(data.body.access_token);
    saveTokens({
      access_token: data.body.access_token,
      refresh_token: spotifyApi.getRefreshToken(),
    });
    console.log('🔄 Token de acceso refrescado');
  } catch (error) {
    console.error('⚠️ Error refrescando token:', error);
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
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}/login`);
});

// Ping interno cada 4 minutos
setInterval(() => {
  http.get(`http://localhost:${PORT}/login`).on('error', err => {
    console.error('⛔ Ping interno falló:', err.message);
  });
  console.log('⏰ Ping enviado para mantener activo');
}, 1000 * 60 * 4);

// === Twitch Bot ===
const twitchClient = new tmi.Client({
  options: { debug: true },
  identity: {
    username: 'alexsink',
    password: 'oauth:9s9nn7d1c0p4exfj4c13r3qu9zy0x4',
  },
  channels: ['alexsink'],
});

twitchClient.connect().then(() => {
  console.log('✅ Conectado a Twitch');
}).catch(console.error);

let isRateLimited = false;

const customRewardId = '154d4847-aec0-4b73-8f21-0e3313bc6c4f';
const mensajesDelBot = [
  '🎶 Añadido a la cola:',
  '⚠️ Por favor espera',
  '⚠️ Límite de peticiones',
  '⚠️ Ocurrió un error',
  '❌ No encontré la canción',
  '✅ Rate limit levantado',
];

twitchClient.on('message', async (channel, tags, message, self) => {
  if (self) return; // Ignorar mensajes propios
  if (channel !== '#alexsink') return; // Solo canal especificado
  if (mensajesDelBot.some(m => message.startsWith(m))) return; // Ignorar mensajes del bot

  if (isRateLimited) {
    twitchClient.say(channel, '⚠️ Por favor espera un poco antes de pedir otra canción.');
    return;
  }

  if (tags['custom-reward-id'] === customRewardId) {
    try {
      await refreshTokenIfNeeded();
      const result = await spotifyApi.searchTracks(message);
      const track = result.body.tracks.items[0];

      if (track) {
        await spotifyApi.addToQueue(track.uri);
        const response = `🎶 Añadido a la cola: "${track.name}" - ${track.artists[0].name}`;
        twitchClient.say(channel, response);
      } else {
        twitchClient.say(channel, `❌ No encontré la canción: "${message}"`);
      }
    } catch (error) {
      console.error('⚠️ Error al añadir canción:', error.message || error);
      if (error.statusCode === 429) {
        if (!isRateLimited) {
          isRateLimited = true;
          const retryAfter = parseInt(error.headers['retry-after'], 10) || 5;
          twitchClient.say(channel, `⚠️ Límite de peticiones alcanzado, espera ${retryAfter} segundos.`);
          setTimeout(() => {
            isRateLimited = false;
            twitchClient.say(channel, '✅ Rate limit levantado, se pueden hacer peticiones de nuevo.');
          }, retryAfter * 1000);
        }
      } else {
        twitchClient.say(channel, '⚠️ Ocurrió un error al intentar añadir la canción.');
      }
    }
  }
});
