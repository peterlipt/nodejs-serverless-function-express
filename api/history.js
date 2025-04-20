// api/history.js
// Végpont: GET /api/history?since=<ISO_DATE_STRING>
// Feladat: Fogadja a kérést az iOS apptól (érvényes access token a headerben),
//          validálja a tokent a Spotify /v1/me hívásával (felhasználó azonosítása),
//          lekérdezi a felhasználóhoz tartozó előzményeket a Neon DB-ből,
//          figyelembe véve az opcionális 'since' paramétert.

const axios = require('axios');
const db = require('../db'); // Ellenőrizd az elérési utat!
require('dotenv').config({ path: '../../.env' }); // Ellenőrizd az elérési utat!

const SPOTIFY_ME_URL = 'https://api.spotify.com/v1/me';

async function handleFetchHistory(req, res) {
    console.log('Received /api/history request.');
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn('/api/history: Missing or invalid Authorization header.');
        return res.status(401).json({ error: 'Authorization header missing or invalid' });
    }
    const accessToken = authHeader.split(' ')[1];

    // --- 1. Felhasználó azonosítása a token alapján ---
    let spotifyUserId;
    try {
        console.log('Verifying access token with Spotify /v1/me...');
        const spotifyUserResponse = await axios.get(SPOTIFY_ME_URL, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            timeout: 8000
        });
        spotifyUserId = spotifyUserResponse.data.id;
        if (!spotifyUserId) throw new Error('Spotify ID not found in response');
        console.log(`Verified user via Spotify token: ${spotifyUserId}`);
    } catch (error) {
        console.warn(`/api/history: Failed to verify Spotify access token:`, error.response?.data || error.message);
        const status = error.response?.status === 401 ? 401 : 502;
        const message = error.response?.status === 401 ? 'Invalid or expired Spotify access token' : 'Could not verify user with Spotify';
        return res.status(status).json({ error: message });
    }

    // --- 2. 'since' paraméter feldolgozása ---
    const sinceTimestamp = req.query.since;
    let sinceDate = null;
    const queryParams = [spotifyUserId]; // Kezdjük a user ID-val

    if (sinceTimestamp) {
        try {
            sinceDate = new Date(sinceTimestamp);
            if (isNaN(sinceDate.getTime())) throw new Error('Invalid date format');
            queryParams.push(sinceDate); // Adjuk hozzá a dátumot a paraméterekhez
            console.log(`Querying history since: ${sinceTimestamp} for user ${spotifyUserId}`);
        } catch (e) {
            console.warn(`/api/history: Invalid 'since' parameter: ${sinceTimestamp}`);
            // Ne álljon le a kérés, csak ne használjuk a szűrőt
            sinceDate = null;
            queryParams.pop(); // Vegyük ki a rossz dátumot
            // return res.status(400).json({ error: 'Invalid since timestamp format. Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ).' });
        }
    } else {
        console.log(`Querying all history (no "since" parameter) for user ${spotifyUserId}.`);
    }

    try {
        // --- 3. Adatok lekérdezése a Neon DB-ből ---
        console.log(`Fetching history from Neon DB for user ${spotifyUserId}...`);
        let historyQuery = `
            SELECT track_id, track_name, artist_names, album_name, album_image_url, played_at, spotify_uri, duration_ms
            FROM play_history
            WHERE user_spotify_id = $1
        `;

        if (sinceDate) {
            // Csak az újabbakat kérjük le
            historyQuery += ` AND played_at > $2`;
        }

        // Mindig a legújabbal kezdjük a sorrendet, hogy a kliens könnyen megtalálja a legfrissebbet
        historyQuery += ` ORDER BY played_at DESC`;

        // Opcionális: Limit hozzáadása, ha túl sok adat lenne egyszerre
        // historyQuery += ` LIMIT 500`; // Pl. max 500 új elem egyszerre

        const historyResult = await db.query(historyQuery, queryParams);
        console.log(`Found ${historyResult.rows.length} history items in Neon DB for user ${spotifyUserId}.`);

        // --- 4. Válasz összeállítása ---
        // Az adatbázisból már a helyes formátumban kellene jönnie az adatoknak
        // A dátumokat ISO stringgé alakítjuk a JSON válaszhoz
        const items = historyResult.rows.map(row => ({
            ...row,
            played_at: row.played_at.toISOString() // Konvertálás ISO stringgé
        }));

        // A payload most már csak az itemeket tartalmazza
        const responsePayload = {
            items: items
        };

        res.status(200).json(responsePayload);

    } catch (error) {
        console.error("/api/history internal error:", error);
        res.status(500).json({ error: 'Internal server error while fetching history from database' });
    }
}

module.exports = handleFetchHistory; // Exportáljuk a handlert