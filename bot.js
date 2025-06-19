const tmi = require('tmi.js');
const SpotifyWebApi = require('spotify-web-api-node');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

// === CONFIGURACIÓN ===
const clientId = '90e213d3dedf4d7aa7aa0c3ad00eb1ff';
const clientSecret = '45f592b007024040a44c80b032e6a4eb';
const redirectUri = 'https://twitch-spotify-bot.onrender.com/callback';

const spotifyApi = new SpotifyWebApi({ clientId, clientSecret, redirectUri });
const app = express();
const scopes = ['user-modify-playback-state', 'user-read-playback-state'];
const TOKEN_PATH = path.join(__dirname, 'spotify_token.json');

// === FUNCIONES DE TOKENS ===
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

// === CARGAR TOKENS EXISTENTES ===
const savedTokens = loadTokens();
if (savedTokens) {
  spotifyApi.setAccessToken(savedTokens.access_token);
  spotifyApi.setRefreshToken(savedTokens.refresh_token);
  console.log('🔄 Tokens cargados desde disco');
}

// === REFRESCAR TOKEN SI ES NECESARIO ===
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

// === RUTA /LOGIN VISUAL ===
app.get('/login', (req, res) => {
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes);
  res.send(`
    <html>
      <head><title>Conectar Spotify</title></head>
      <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h2>Conecta tu cuenta de Spotify</h2>
        <a href="${authorizeURL}" style="padding: 10px 20px; background: #1DB954; color: white; border-radius: 5px; text-decoration: none;">Conectar con Spotify</a>
      </body>
    </html>
  `);
});

// === CALLBACK DE SPOTIFY ===
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

// === PING INTERNO PARA RENDER ===
const PORT = process.env.PORT || 8888;
setInterval(() => {
  http.get('https://twitch-spotify-bot.onrender.com/login').on('error', (err) => {
    console.error('Ping interno falló:', err.message);
  });
  console.log('⏰ Ping interno enviado para mantener activo');
}, 1000 * 60 * 4); // cada 4 minutos

app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}/login`);
});

// === TWITCH BOT ===
const twitchClient = new tmi.Client({
  options: { debug: true },
  identity: {
    username: 'alexsink',
    password: 'oauth:9s9nn7d1c0p4exfj4c13r3qu9zy0x4',
  },
  channels: ['alexsink'],
});

twitchClient.connect();

twitchClient.on('message', async (channel, tags, message, self) => {
  if (tags['custom-reward-id']) {
    console.log('💡 Recompensa usada');
    console.log('👉 ID:', tags['custom-reward-id']);
    console.log('🎵 Canción solicitada:', message);

    if (tags['custom-reward-id'] === '154d4847-aec0-4b73-8f21-0e3313bc6c4f') {
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
        twitchClient.say(channel, '⚠️ Ocurrió un error al intentar añadir la canción.');
      }
    }
  }
});
