// api/auth/refresh.js
// Végpont: POST /api/auth/refresh
// Feladat: Fogadja a kérést az iOS apptól (azonosítania kell a felhasználót, pl. lejárt token alapján),
//          kikeresi a DB-ből a titkosított refresh tokent, dekódolja,
//          frissíti a Spotify API-nál, elmenti az esetleges új refresh tokent,
//          visszaküldi az új access tokent és lejáratot az iOS appnak.

const axios = require('axios');
const db = require('../../db');
const { encrypt, decrypt } = require('../../encryption');
require('dotenv').config({ path: '../../.env' });

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_ME_URL = 'https://api.spotify.com/v1/me'; // A user ID ellenőrzéséhez

// Express route handler funkció
async function handleRefreshToken(req, res) {
    console.log('Received /api/auth/refresh request.');

    // --- Felhasználó azonosítása ---
    // Több módszer lehetséges:
    // 1. Az iOS app küldi a (lejárt) access tokent, amiből kinyerjük a user ID-t. (Ezt implementáljuk most)
    // 2. Session/Cookie alapú azonosítás (bonyolultabb serverless környezetben).
    // 3. Az iOS app küld egy saját belső user ID-t (ha van ilyen).

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn('/api/auth/refresh: Missing or invalid Authorization header.');
        // Lehet, hogy a token már törölve lett a kliens oldalon, ezért nem feltétlen 401
        return res.status(400).json({ error: 'Authorization header with expired token is required for refresh.' });
    }
    const expiredAccessToken = authHeader.split(' ')[1];

    let spotifyId;
    try {
        // Megpróbáljuk a /v1/me hívást a kapott (lejárt) tokennel.
        // Ez vagy hibát ad (401), vagy visszaadja a user ID-t, ha még épp nem járt le.
        // Biztonságosabb lenne egy saját token validálási mechanizmus, de ez egyszerűbb.
        console.log('Verifying expired token to get user ID...');
        const userResponse = await axios.get(SPOTIFY_ME_URL, {
            headers: { 'Authorization': `Bearer ${expiredAccessToken}` },
            timeout: 5000,
            // Fontos: Ne dobjon hibát 401 esetén, hogy megkapjuk a választ
            validateStatus: function (status) {
                return status >= 200 && status < 300 || status === 401;
            }
        });

        if (userResponse.status === 401) {
            // Ha 401-et kapunk, megpróbáljuk a tokent dekódolni (ha JWT, bár Spotify nem az)
            // vagy más módon azonosítani. Itt most feltételezzük, hogy a 401 azt jelenti,
            // hogy a token valid volt, csak lejárt. De hogyan szerezzük meg a user ID-t?
            // -> Ez a módszer nem tökéletes. Jobb lenne, ha a kliens tárolná a user ID-t
            //    és elküldené a refresh kéréssel, VAGY ha a refresh token maga lenne
            //    az azonosító (de ez nem biztonságos).
            // -> Kompromisszum: Feltételezzük, hogy a /v1/me hívás *előtt* a kliens
            //    tudta a user ID-t, és a refresh kérésben elküldi azt is.
            //    Módosítsuk a kérést: iOS küldje a spotifyId-t is!

            // *** ÁTÍRÁS: Feltételezzük, az iOS küldi a spotifyId-t a body-ban ***
            const { userIdFromBody } = req.body; // iOS-nek ezt küldenie kell!
            if (!userIdFromBody) {
                console.warn('/api/auth/refresh: Missing spotifyId in request body.');
                return res.status(400).json({ error: 'Spotify User ID is required in the request body for refresh.' });
            }
            spotifyId = userIdFromBody;
            console.log(`User ID received from request body: ${spotifyId}`);

        } else if (userResponse.status === 200 && userResponse.data.id) {
            spotifyId = userResponse.data.id;
            console.log(`User ID verified via /v1/me: ${spotifyId}`);
        } else {
            console.error('Failed to verify user identity for refresh. Status:', userResponse.status);
            return res.status(401).json({ error: 'Could not verify user identity.' });
        }

    } catch (error) {
        console.error('Error during user verification for refresh:', error.message);
        return res.status(500).json({ error: 'Internal server error during user verification.' });
    }

    if (!spotifyId) {
        console.error('Could not determine Spotify ID for refresh.');
        return res.status(400).json({ error: 'Could not determine user for refresh.' });
    }

    try {
        // --- 1. Titkosított Refresh Token lekérése a DB-ből ---
        console.log(`Fetching encrypted refresh token for user ${spotifyId}...`);
        const userResult = await db.query('SELECT encrypted_refresh_token FROM users WHERE spotify_id = $1 AND needs_reauth = false', [spotifyId]);

        if (userResult.rows.length === 0) {
            console.warn(`No valid user or refresh token found in DB for ${spotifyId}. User might need re-authentication.`);
            // Fontos, hogy itt 401-et küldjünk, hogy az iOS app tudja, újra be kell jelentkezni.
            return res.status(401).json({ error: 'User session not found or invalid. Please log in again.' });
        }
        const encryptedToken = userResult.rows[0].encrypted_refresh_token;
        console.log('Encrypted token fetched.');

        // --- 2. Refresh Token dekódolása ---
        console.log('Decrypting refresh token...');
        const refreshToken = decrypt(encryptedToken);
        if (!refreshToken) {
            console.error(`Failed to decrypt token for user ${spotifyId}. Marking for re-auth.`);
            // Jelöljük a DB-ben, hogy újra kell auth, és küldjünk hibát
            await db.query('UPDATE users SET needs_reauth = true, updated_at = NOW() WHERE spotify_id = $1', [spotifyId]);
            return res.status(401).json({ error: 'Session corrupted. Please log in again.' });
        }
        console.log('Refresh token decrypted.');

        // --- 3. Token frissítése a Spotify API-nál ---
        console.log('Refreshing token with Spotify API...');
        let tokenResponse;
        try {
            tokenResponse = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            }), {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 10000
            });
        } catch (error) {
            console.error(`Spotify token refresh failed for user ${spotifyId}:`, error.response?.data || error.message);
            // Ha a refresh token érvénytelen (pl. visszavonták), jelöljük a DB-ben és küldjünk 401-et
            if (error.response?.status === 400 || error.response?.status === 401) {
                console.log(`Marking user ${spotifyId} for re-auth due to invalid refresh token.`);
                await db.query('UPDATE users SET needs_reauth = true, updated_at = NOW() WHERE spotify_id = $1', [spotifyId]);
                return res.status(401).json({ error: 'Session expired. Please log in again.' });
            }
            const status = error.response?.status || 500;
            const message = error.response?.data?.error_description || 'Failed to refresh token with Spotify.';
            return res.status(status >= 500 ? 502 : status).json({ error: message });
        }

        const { access_token, expires_in } = tokenResponse.data;
        // A Spotify visszaküldhet új refresh tokent is, de nem mindig. Ha igen, frissíteni kell a DB-ben!
        const new_refresh_token = tokenResponse.data.refresh_token;

        if (!access_token) {
            console.error('Missing access_token in Spotify refresh response.');
            return res.status(502).json({ error: 'Received incomplete token data from Spotify during refresh.' });
        }
        console.log('Token refreshed successfully via Spotify.');

        // --- 4. Új Refresh Token mentése (ha kaptunk) ---
        if (new_refresh_token && new_refresh_token !== refreshToken) {
            console.log(`Received a new refresh token for user ${spotifyId}. Encrypting and updating DB...`);
            const newEncryptedToken = encrypt(new_refresh_token);
            if (newEncryptedToken) {
                try {
                    await db.query('UPDATE users SET encrypted_refresh_token = $1, updated_at = NOW() WHERE spotify_id = $2', [newEncryptedToken, spotifyId]);
                    console.log('New refresh token saved successfully.');
                } catch (dbError) {
                    console.error(`Database error updating new refresh token for ${spotifyId}:`, dbError);
                    // Ez nem végzetes hiba a folyamat szempontjából, de logolni kell.
                    // A régi refresh token valószínűleg még működik egy darabig.
                }
            } else {
                console.error(`Failed to encrypt new refresh token for user ${spotifyId}.`);
                // Logoljuk, de folytatjuk az új access token visszaadásával.
            }
        }

        // --- 5. Sikeres válasz küldése az iOS appnak ---
        console.log('Sending success response (new access token) to iOS app.');
        res.status(200).json({
            access_token: access_token,
            expires_in: expires_in
        });

    } catch (error) {
        // Általános váratlan hiba
        console.error(`Unexpected error during /api/auth/refresh for user ${spotifyId || 'unknown'}:`, error);
        res.status(500).json({ error: 'An internal server error occurred during session refresh.' });
    }
}

// Exportáljuk a route handler funkciót
module.exports = handleRefreshToken;