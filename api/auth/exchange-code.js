// api/auth/exchange-code.js
// Végpont: POST /api/auth/exchange-code
// Feladat: Fogadja az iOS apptól kapott authorization_code-ot,
//          kicseréli Spotify access és refresh tokenekre,
//          lekérdezi a felhasználó Spotify ID-ját,
//          elmenti/frissíti a felhasználót és a titkosított refresh tokent a DB-ben,
//          visszaküldi az access tokent és a lejáratot az iOS appnak.

const axios = require('axios');
const db = require('../../db'); // Adatbázis kapcsolat (feltételezve, hogy a gyökérből 2 szinttel feljebb van)
const { encrypt } = require('../../encryption'); // Titkosító segédfüggvény
require('dotenv').config({ path: '../../.env' }); // .env betöltése a gyökérből

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
// Fontos: Ennek pontosan meg kell egyeznie azzal, amit az iOS app küldött
// a Spotify /authorize hívásakor, és ami a Spotify Dashboardon regisztrálva van!
const MIDDLEMAN_REDIRECT_URI = process.env.MIDDLEMAN_REDIRECT_URI; // Pl. https://yourapp.vercel.app/spotify-callback
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_ME_URL = 'https://api.spotify.com/v1/me';

// Express route handler funkció
async function handleExchangeCode(req, res) {
    const { code } = req.body;

    console.log('Received /api/auth/exchange-code request.');

    if (!code) {
        console.warn('Missing authorization code in request body.');
        return res.status(400).json({ error: 'Authorization code is required' });
    }

    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !MIDDLEMAN_REDIRECT_URI) {
        console.error('Missing required Spotify environment variables (ID, SECRET, or REDIRECT_URI).');
        return res.status(500).json({ error: 'Server configuration error.' });
    }

    try {
        // --- 1. Kód cseréje tokenekre ---
        console.log('Exchanging code for tokens...');
        let tokenResponse;
        try {
            tokenResponse = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: MIDDLEMAN_REDIRECT_URI // Ugyanaz a redirect URI kell ide is!
            }), {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 10000 // 10 mp timeout
            });
        } catch (error) {
            console.error('Spotify token exchange failed:', error.response?.data || error.message);
            const status = error.response?.status || 500;
            const message = error.response?.data?.error_description || 'Failed to exchange code with Spotify.';
            // Külön kezeljük az invalid_grant hibát (pl. lejárt kód)
            if (error.response?.data?.error === 'invalid_grant') {
                return res.status(400).json({ error: 'Authorization code expired or invalid. Please try logging in again.' });
            }
            return res.status(status >= 500 ? 502 : status).json({ error: message }); // 502 Bad Gateway, ha Spotify hiba
        }

        const { access_token, refresh_token, expires_in } = tokenResponse.data;

        if (!access_token || !refresh_token) {
            console.error('Missing access_token or refresh_token in Spotify response.');
            return res.status(502).json({ error: 'Received incomplete token data from Spotify.' });
        }
        console.log('Tokens received successfully.');

        // --- 2. Felhasználó Spotify ID lekérése ---
        console.log('Fetching user profile (Spotify ID)...');
        let userProfileResponse;
        try {
            userProfileResponse = await axios.get(SPOTIFY_ME_URL, {
                headers: { 'Authorization': `Bearer ${access_token}` },
                timeout: 8000 // 8 mp timeout
            });
        } catch (error) {
            console.error('Spotify user profile fetch failed:', error.response?.data || error.message);
            const status = error.response?.status || 500;
            const message = error.response?.data?.error?.message || 'Failed to fetch user profile from Spotify.';
            return res.status(status >= 500 ? 502 : status).json({ error: message });
        }

        const spotifyId = userProfileResponse.data.id;
        const userEmail = userProfileResponse.data.email; // Opcionális, de hasznos lehet
        const displayName = userProfileResponse.data.display_name; // Opcionális

        if (!spotifyId) {
            console.error('Spotify ID not found in user profile response.');
            return res.status(502).json({ error: 'Could not retrieve Spotify user ID.' });
        }
        console.log(`User profile fetched. Spotify ID: ${spotifyId}, Email: ${userEmail}`);

        // --- 3. Refresh Token titkosítása ---
        console.log('Encrypting refresh token...');
        const encryptedToken = encrypt(refresh_token);
        if (!encryptedToken) {
            console.error(`Failed to encrypt refresh token for user: ${spotifyId}`);
            return res.status(500).json({ error: 'Failed to secure user credentials' });
        }
        console.log('Refresh token encrypted.');

        // --- 4. Felhasználó mentése/frissítése a DB-ben (UPSERT) ---
        console.log(`Upserting user ${spotifyId} into database...`);
        const upsertQuery = `
            INSERT INTO users (spotify_id, encrypted_refresh_token, email, display_name, needs_reauth, updated_at, last_login_at)
            VALUES ($1, $2, $3, $4, false, NOW(), NOW())
            ON CONFLICT (spotify_id)
            DO UPDATE SET
                encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
                email = EXCLUDED.email,
                display_name = EXCLUDED.display_name,
                needs_reauth = false, -- Sikeres bejelentkezés/frissítés után false
                updated_at = NOW(),
                last_login_at = NOW()
            RETURNING spotify_id;
        `;
        try {
            const result = await db.query(upsertQuery, [spotifyId, encryptedToken, userEmail, displayName]);
            console.log(`User registered or token updated successfully in DB: ${result.rows[0].spotify_id}`);
        } catch (dbError) {
            console.error(`Database error during user upsert for ${spotifyId}:`, dbError);
            // Ne küldjünk részletes DB hibát a kliensnek
            return res.status(500).json({ error: 'Database error during user registration' });
        }

        // --- 5. Sikeres válasz küldése az iOS appnak ---
        // Csak az access tokent és a lejáratot küldjük vissza!
        console.log('Sending success response (access token) to iOS app.');
        res.status(200).json({
            access_token: access_token,
            expires_in: expires_in
        });

    } catch (error) {
        // Általános váratlan hiba a folyamat során
        console.error('Unexpected error during /api/auth/exchange-code:', error);
        res.status(500).json({ error: 'An internal server error occurred during login.' });
    }
}

// Exportáljuk a route handler funkciót
module.exports = handleExchangeCode;