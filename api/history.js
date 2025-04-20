// api/history.js
// Végpont: GET /api/history
// Feladat: Fogadja a kérést az iOS apptól (érvényes access token a headerben),
//          validálja a tokent a Spotify /v1/me hívásával,
//          lekérdezi a felhasználóhoz tartozó előzményeket a DB-ből (Neon).

const axios = require('axios');
const db = require('../db');
require('dotenv').config({ path: '../../.env' });

const SPOTIFY_ME_URL = 'https://api.spotify.com/v1/me';

async function handleFetchHistory(req, res) {
    console.log('Received /api/history request.');
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn('/api/history: Missing or invalid Authorization header.');
        return res.status(401).json({ error: 'Authorization header missing or invalid' });
    }
    const accessToken = authHeader.split(' ')[1];

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
        // 1. Felhasználó azonosítása a token alapján
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
            const status = error.response?.status === 401 ? 401 : 502; // 401 Unauthorized, 502 Bad Gateway
            const message = error.response?.status === 401 ? 'Invalid or expired Spotify access token' : 'Could not verify user with Spotify';
            return res.status(status).json({ error: message });
        }

        // 2. Adatok lekérdezése az adatbázisból
        console.log(`Fetching history from DB for user ${spotifyUserId}...`);
        let historyQuery = `
            SELECT track_id, track_name, artist_names, album_name, album_image_url, played_at, spotify_uri, duration_ms
            FROM play_history
            WHERE user_spotify_id = $1
        `;
        const queryParams = [spotifyUserId];

        if (sinceDate) {
            historyQuery += ` AND played_at > $2 ORDER BY played_at ASC`; // Csak az újabbak
            queryParams.push(sinceDate);
        } else {
            historyQuery += ` ORDER BY played_at DESC`; // Ha nincs 'since', a legutóbbiakat kérjük először
        }

        // Limit és esetleg lapozás (offset) hozzáadása
        const limit = parseInt(req.query.limit) || 50; // Max 50 alapértelmezetten
        const offset = parseInt(req.query.offset) || 0;
        historyQuery += ` LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
        queryParams.push(limit, offset);

        const historyResult = await db.query(historyQuery, queryParams);
        console.log(`Found ${historyResult.rows.length} history items in DB for user ${spotifyUserId}.`);

        // 3. Válasz összeállítása
        const items = historyResult.rows.map(row => ({
            ...row,
            played_at: row.played_at.toISOString()
        }));

        // Adjunk vissza információt a lapozáshoz is
        const responsePayload = {
            items: items,
            limit: limit,
            offset: offset,
            // newest_timestamp: items.length > 0 ? items[0].played_at : sinceTimestamp // Ha DESC sorrend van
        };

        res.status(200).json(responsePayload);

    } catch (error) {
        console.error("/api/history internal error:", error);
        res.status(500).json({ error: 'Internal server error while fetching history' });
    }
}

module.exports = handleFetchHistory;