// app.js
// Fő Express alkalmazás: Kezeli a Spotify callback-et, felhasználó regisztrációt,
// és az iOS app adatlekérési kéréseit.

require('dotenv').config(); // Környezeti változók betöltése .env-ből (helyi fejlesztéshez)
const express = require('express');
const axios = require('axios'); // Spotify API hívásokhoz
const db = require('./db'); // Adatbázis kapcsolat modul (Neon Postgres)
const { encrypt, decrypt } = require('./encryption'); // Titkosító/dekódoló segédfüggvények

const app = express();

// Middleware a JSON request body-k parse-olásához
app.use(express.json());

// Konstansok az iOS app callback-hez
const APP_SCHEME = process.env.IOS_APP_SCHEME || 'spotifyjournalauth'; // Használj környezeti változót!
const APP_CALLBACK_PATH = 'callback';

// --- Útvonalak ---

// 1. Spotify Callback (Middleman) - A Spotify ide irányít a felhasználói bejelentkezés után
app.get('/spotify-callback', (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    const error = req.query.error;

    console.log('Received /spotify-callback from Spotify:', { code: !!code, state, error });

    // Összeállítjuk az iOS app URL-jét
    const appUrl = new URL(`${APP_SCHEME}://${APP_CALLBACK_PATH}`);

    if (error) {
        appUrl.searchParams.append('error', error);
        if (req.query.error_description) {
            appUrl.searchParams.append('error_description', req.query.error_description);
        }
        if (state) appUrl.searchParams.append('state', state); // State-et hiba esetén is átadjuk
        console.log('Redirecting to app with error:', appUrl.toString());
        res.redirect(302, appUrl.toString());
    } else if (code) {
        appUrl.searchParams.append('code', code);
        if (state) appUrl.searchParams.append('state', state); // State átadása
        console.log('Redirecting to app with code:', appUrl.toString());
        res.redirect(302, appUrl.toString());
    } else {
        // Váratlan eset
        console.warn('/spotify-callback called without code or error.');
        res.status(400).send('Invalid callback parameters received from Spotify.');
    }
});

// 2. Felhasználó Regisztráció / Refresh Token Mentése (iOS app hívja)
app.post('/api/users/register', async (req, res) => {
    const { refreshToken, spotifyId } = req.body;

    console.log(`Received /api/users/register request for Spotify ID: ${spotifyId ? spotifyId.substring(0,5)+'...' : 'N/A'}`);

    if (!refreshToken || !spotifyId) {
        console.warn('Missing refreshToken or spotifyId in request body.');
        return res.status(400).json({ error: 'Refresh token and Spotify ID are required' });
    }

    // Titkosítjuk a refresh tokent
    const encryptedToken = encrypt(refreshToken);
    if (!encryptedToken) {
        console.error(`Failed to encrypt refresh token for user: ${spotifyId}`);
        // Ne adjunk vissza túl sok infót a kliensnek biztonsági okokból
        return res.status(500).json({ error: 'Failed to secure user credentials' });
    }

    // Mentsük vagy frissítsük a felhasználót az adatbázisban (UPSERT)
    const upsertQuery = `
    INSERT INTO users (spotify_id, encrypted_refresh_token, needs_reauth, updated_at)
    VALUES ($1, $2, false, NOW())
    ON CONFLICT (spotify_id)
    DO UPDATE SET
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      needs_reauth = false,
      updated_at = NOW() -- Trigger is jobb lehet, de ez is működik
    RETURNING spotify_id;
  `;
    try {
        const result = await db.query(upsertQuery, [spotifyId, encryptedToken]);
        console.log(`User registered or token updated successfully: ${result.rows[0].spotify_id}`);
        res.status(200).json({ message: 'User token registered successfully' });
    } catch (dbError) {
        console.error(`Database error during user registration for ${spotifyId}:`, dbError);
        res.status(500).json({ error: 'Database error during registration' });
    }
});

// 3. Lejátszási Előzmények Lekérése (iOS app hívja)
app.get('/api/history', async (req, res) => {
    console.log('Received /api/history request.');
    // Hitelesítés: Az app küldi az érvényes Spotify access tokenjét a headerben
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn('/api/history: Missing or invalid Authorization header.');
        return res.status(401).json({ error: 'Authorization header missing or invalid' });
    }
    const accessToken = authHeader.split(' ')[1];

    // Opcionális 'since' paraméter (ISO 8601 dátum string)
    const sinceTimestamp = req.query.since;
    let sinceDate = null;
    if (sinceTimestamp) {
        try {
            sinceDate = new Date(sinceTimestamp);
            if (isNaN(sinceDate.getTime())) throw new Error('Invalid date format');
            console.log(`Querying history since: ${sinceTimestamp}`);
        } catch (e) {
            console.warn(`/api/history: Invalid 'since' parameter: ${sinceTimestamp}`);
            return res.status(400).json({ error: 'Invalid since timestamp format. Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ).' });
        }
    } else {
        console.log('Querying all history (no "since" parameter).');
    }

    try {
        // 1. Felhasználó azonosítása a token alapján (Spotify /v1/me)
        let spotifyUserId;
        try {
            const spotifyUserResponse = await axios.get('https://api.spotify.com/v1/me', {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            spotifyUserId = spotifyUserResponse.data.id;
            if (!spotifyUserId) throw new Error('Spotify ID not found in response');
            console.log(`Verified user via Spotify token: ${spotifyUserId}`);
        } catch (error) {
            console.warn(`/api/history: Failed to verify Spotify access token:`, error.response?.data || error.message);
            const status = error.response?.status === 401 ? 401 : 500;
            return res.status(status).json({ error: 'Invalid or expired Spotify access token' });
        }

        // 2. Adatok lekérdezése az adatbázisból a felhasználóhoz
        let historyQuery = `
      SELECT track_id, track_name, artist_names, album_name, album_image_url, played_at, spotify_uri, duration_ms
      FROM play_history
      WHERE user_spotify_id = $1
    `;
        const queryParams = [spotifyUserId];

        if (sinceDate) {
            historyQuery += ` AND played_at > $2 ORDER BY played_at ASC`;
            queryParams.push(sinceDate);
        } else {
            historyQuery += ` ORDER BY played_at ASC`;
        }

        // Limitáljuk a visszaadott elemek számát egy észszerű értékre (pl. 500)
        // hogy ne terheljük túl a klienst vagy a szervert, ha nagyon sok adat van.
        // A kliensnek kellene kezelnie a lapozást, ha szükséges, de ez egyszerűbb kezdetnek.
        historyQuery += ` LIMIT 500`; // Adj hozzá egy limitet!

        console.log(`Executing history query for user ${spotifyUserId}...`);
        const historyResult = await db.query(historyQuery, queryParams);
        console.log(`Found ${historyResult.rows.length} history items for user ${spotifyUserId}.`);

        // 3. Válasz összeállítása
        // A played_at dátumokat ISO stringgé alakítjuk a JSON válaszhoz
        const items = historyResult.rows.map(row => ({
            ...row,
            played_at: row.played_at.toISOString() // Konvertálás ISO stringgé
        }));

        const responsePayload = {
            items: items,
            // Visszaküldjük a legutolsó elem időbélyegét (ha volt), hogy az app elmenthesse
            newest_timestamp: items.length > 0
                ? items[items.length - 1].played_at // Ez már ISO string
                : sinceTimestamp // Ha nem jött új, a kérésben lévőt küldjük vissza
        };

        res.status(200).json(responsePayload);

    } catch (error) {
        console.error("/api/history internal error:", error);
        res.status(500).json({ error: 'Internal server error while fetching history' });
    }
});

// 4. Gyökér útvonal (Egyszerű health check)
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send('Spotify Journal Backend is running!');
});

// --- Cron Job Útvonal ---
// Ezt az útvonalat fogja a Vercel Cron meghívni a vercel.json alapján.
// A logikát külön fájlba is szervezhetnéd (pl. api/cron/fetch_recent_plays.js),
// de itt is maradhat, ha egyszerűbbnek találod.
require('./api/cron/fetch_recent_plays')(app); // Behúzzuk és átadjuk az app példányt

// --- Vercel Export ---
// Az Express app exportálása, hogy a Vercel szerverless környezete futtatni tudja.
// Nincs szükség app.listen()-re.
module.exports = app;