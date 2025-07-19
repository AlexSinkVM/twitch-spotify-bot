const tmi = require('tmi.js');
const SpotifyWebApi = require('spotify-web-api-node');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const clientId = '90e213d3dedf4d7aa7aa0c3ad00eb1ff';
const clientSecret = '45f592b007024040a44c80b032e6a4eb';
const redirectUri = 'https://twitch-spotify-bot.onrender.com/callback';

const spotifyApi = new SpotifyWebApi({ clientId, clientSecret, redirectUri });
const app = express();
const scopes = ['user-modify-playback-state', 'user-read-playback-state'];
const TOKEN_PATH = path.join(__dirname, 'spotify_token.json');

// Variables para controlar repetición y rate limit
let lastMessage = '';
let lastMessageTimestamp = 0;
let isRateLimited = false;
let rateLimitResetTime = 0;

// === Funciones para guardar/cargar tokens ===
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

// === Cargar tokens si existen ===
const savedTokens = loadTokens();
if (savedTokens) {
  spotifyApi.setAccessToken(savedTokens.access_token);
  spotifyApi.setRefreshToken(savedTokens.refresh_token);
  console.log('🔄 Tokens cargados desde disco');
}

// === Refrescar token si es necesario ===
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

// === Rutas de Express para Spotify Auth ===
app.get('/login', (req, res) => {
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes);
  res.redirect(authorizeURL);
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
    res.send('¡Spotify conectado! Puedes cerrar esta pestaña.');
  } catch (error) {
    console.error('⚠️ Error en callback:', error);
    res.status(500).send('Error en autenticación con Spotify.');
  }
});

// === Mantener la app despierta (ping interno) ===
const PORT = process.env.PORT || 8888;

setInterval(() => {
  http.get(`http://localhost:${PORT}/login`).on('error', (err) => {
    console.error('Ping interno falló:', err.message);
  });
  console.log('⏰ Ping interno enviado para mantener activo');
}, 1000 * 60 * 4); // cada 4 minutos

app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}/login`);
});

// === Twitch bot ===
const twitchClient = new tmi.Client({
  options: { debug: true },
  identity: {
    username: 'alexsink',
    password: 'oauth:9s9nn7d1c0p4exfj4c13r3qu9zy0x4',
  },
  channels: ['alexsink'],
});

twitchClient.connect()
  .then(() => console.log('✅ Twitch client conectado'))
  .catch(console.error);

twitchClient.on('message', async (channel, tags, message, self) => {
  if (self) return;  // Ignorar mensajes del bot
  if (channel !== '#alexsink') return;  // Solo canal objetivo

  const now = Date.now();

  // Ignorar mensajes repetidos en menos de 5 segundos
  if (message === lastMessage && (now - lastMessageTimestamp) < 5000) {
    return;
  }
  lastMessage = message;
  lastMessageTimestamp = now;

  if (tags['custom-reward-id'] === '154d4847-aec0-4b73-8f21-0e3313bc6c4f') {
    if (isRateLimited && now < rateLimitResetTime) {
      twitchClient.say(channel, `⏳ Espera un momento antes de pedir otra canción.`);
      return;
    }
    try {
      await refreshTokenIfNeeded();

      const result = await spotifyApi.searchTracks(message);
      const track = result.body.tracks.items[0];
      if (track) {
        await spotifyApi.addToQueue(track.uri);
        console.log(`➕ Añadido a la cola: ${track.name} - ${track.artists[0].name}`);

        twitchClient.say(channel, `🎶 Añadido a la cola: "${track.name}" - ${track.artists[0].name}`);
      } else {
        console.log(`❌ No se encontró la canción: ${message}`);
        twitchClient.say(channel, `❌ No encontré la canción: "${message}"`);
      }
    } catch (error) {
      console.error('⚠️ Error al agregar a la cola:', error);

      if (error.statusCode === 429 && error.headers && error.headers['retry-after']) {
        isRateLimited = true;
        rateLimitResetTime = Date.now() + (parseInt(error.headers['retry-after'], 10) + 1) * 1000; // +1 seg de margen
        twitchClient.say(channel, `⚠️ Límite de peticiones alcanzado, espera ${error.headers['retry-after']} segundos.`);
      } else {
        twitchClient.say(channel, '⚠️ Ocurrió un error al intentar añadir la canción.');
      }
    }
  }
});
