const tmi = require('tmi.js');
const SpotifyWebApi = require('spotify-web-api-node');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const LOCKFILE = path.join(__dirname, 'bot.lock');

// Verificar si ya hay una instancia corriendo
if (fs.existsSync(LOCKFILE)) {
  console.log('⚠️ El bot ya está corriendo, saliendo...');
  process.exit(1);
} else {
  fs.writeFileSync(LOCKFILE, process.pid.toString());
}

// Limpiar lockfile al salir
function cleanLockFile() {
  if (fs.existsSync(LOCKFILE)) fs.unlinkSync(LOCKFILE);
}

process.on('exit', cleanLockFile);
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

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

// Ping interno cada 4 minutos para mantener el app despierta
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
        // En caso de rate limit, espera retry-after segundos, pero no avisa en chat
        const retryAfter = parseInt(error.headers['retry-after'], 10) || 5;
        await new Promise(r => setTimeout(r, retryAfter * 1000));
      } else {
        twitchClient.say(channel, '⚠️ Ocurrió un error al intentar añadir la canción.');
      }
    }
  }

  processing = false;
}

twitchClient.on('message', (channel, tags, message, self) => {
  if (self) return;
  if (channel !== '#alexsink') return;
  if (mensajesDelBot.some(m => message.startsWith(m))) return;

  if (tags['custom-reward-id'] === customRewardId) {
    queue.push({ channel, message });
    processQueue();
  }
});
