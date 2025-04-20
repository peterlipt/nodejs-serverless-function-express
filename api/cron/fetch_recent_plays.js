// api/cron/fetch_recent_plays.js
// Ezt a fájlt/útvonalat hívja meg a Vercel Cron Job a vercel.json beállítása alapján.
// Feladata: Végigmenni az aktív felhasználókon, frissíteni a Spotify tokenjüket,
// lekérni a legutóbbi lejátszásokat, és menteni az adatbázisba.

const axios = require('axios');
const { decrypt } = require('../../encryption'); // Figyelj a relatív útvonalra! (../../)
const db = require('../../db'); // Figyelj a relatív útvonalra! (../../)

// Környezeti változók betöltése (szükséges a Spotify ID/Secret-hez)
// A dotenv betöltése itt nem feltétlen kell, ha az app.js már betöltötte,
// de biztonságosabb lehet expliciten itt is behúzni.
require('dotenv').config({ path: '../../.env' }); // Igazítsd az elérési utat a .env-hez!

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_RECENTLY_PLAYED_URL = 'https://api.spotify.com/v1/me/player/recently-played';

// A fő cron job logika
async function runFetchRecentPlays(req, res) {
    // Opcionális: Cron Secret ellenőrzése
    // const secret = req.headers['x-vercel-cron-secret'];
    // if (!secret || secret !== process.env.VERCEL_CRON_SECRET) {
    //     console.warn('Cron Job: Unauthorized access attempt.');
    //     return res.status(401).json({ error: 'Unauthorized' });
    // }

    console.log(`[${new Date().toISOString()}] Cron Job: Starting fetch_recent_plays...`);
    let processedUsers = 0;
    let totalErrors = 0;
    let totalNewPlays = 0;

    try {
        // 1. Aktív felhasználók lekérése
        const usersResult = await db.query('SELECT spotify_id, encrypted_refresh_token, last_sync_cursor FROM users WHERE needs_reauth = false');
        const users = usersResult.rows;
        console.log(`Cron Job: Found ${users.length} active users.`);

        // Párhuzamosítás helyett szekvenciálisan dolgozzuk fel a felhasználókat,
        // hogy ne terheljük túl a Spotify API-t vagy az adatbázist (egyszerűbb kezdetnek).
        for (const user of users) {
            const { spotify_id, encrypted_refresh_token, last_sync_cursor } = user;
            console.log(`Cron Job: Processing user ${spotify_id}...`);
            let newAccessToken = null;
            let currentCursor = last_sync_cursor;
            let userError = false; // Jelzi, ha ennél a usernél hiba történt

            try {
                // 2. Refresh token dekódolása
                const refreshToken = decrypt(encrypted_refresh_token);
                if (!refreshToken) {
                    console.error(`Cron Job: Failed to decrypt token for user ${spotify_id}. Marking for re-auth.`);
                    await db.query('UPDATE users SET needs_reauth = true, updated_at = NOW() WHERE spotify_id = $1', [spotify_id]);
                    userError = true;
                }

                // 3. Új access token kérése (csak ha a dekódolás sikeres volt)
                if (!userError) {
                    try {
                        console.log(`Cron Job: Refreshing token for user ${spotify_id}...`);
                        const tokenResponse = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams({
                            grant_type: 'refresh_token',
                            refresh_token: refreshToken
                        }), {
                            headers: {
                                'Authorization': `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
                                'Content-Type': 'application/x-www-form-urlencoded'
                            },
                            timeout: 10000 // 10 másodperc timeout
                        });
                        newAccessToken = tokenResponse.data.access_token;
                        console.log(`Cron Job: Token refreshed successfully for user ${spotify_id}.`);
                    } catch (tokenError) {
                        console.error(`Cron Job: Failed to refresh token for user ${spotify_id}:`, tokenError.response?.data || tokenError.message);
                        if (tokenError.response?.status === 400 || tokenError.response?.status === 401) {
                            console.log(`Cron Job: Marking user ${spotify_id} for re-auth due to invalid refresh token.`);
                            await db.query('UPDATE users SET needs_reauth = true, updated_at = NOW() WHERE spotify_id = $1', [spotify_id]);
                        }
                        userError = true;
                    }
                }

                // 4. Legutóbbi zenék lekérése (csak ha van érvényes access token)
                if (!userError && newAccessToken) {
                    let hasMore = true;
                    let fetchCount = 0; // Hány új elemet találtunk ennél a usernél
                    let url = `${SPOTIFY_RECENTLY_PLAYED_URL}?limit=50`;
                    if (currentCursor) {
                        url += `&after=${currentCursor}`;
                    }
                    console.log(`Cron Job: Fetching plays for user ${spotify_id} from URL: ${url}`);

                    while (hasMore && newAccessToken) {
                        try {
                            const playsResponse = await axios.get(url, {
                                headers: { 'Authorization': `Bearer ${newAccessToken}` },
                                timeout: 15000 // 15 másodperc timeout
                            });
                            const items = playsResponse.data.items;
                            const nextCursor = playsResponse.data.cursors?.after; // Következő oldal kurzora

                            if (items && items.length > 0) {
                                console.log(`Cron Job: Fetched ${items.length} plays page for user ${spotify_id}. Saving...`);
                                fetchCount += items.length;

                                // 5. Adatok mentése tranzakcióban
                                const client = await db.getClient();
                                try {
                                    await client.query('BEGIN');
                                    const insertQuery = `
                                        INSERT INTO play_history (user_spotify_id, track_id, track_name, artist_names, album_name, album_image_url, played_at, spotify_uri, duration_ms)
                                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                                        ON CONFLICT (user_spotify_id, track_id, played_at) DO NOTHING;
                                    `;
                                    for (const item of items) {
                                        const track = item.track;
                                        if (!track || !track.id || !item.played_at) continue; // Alapvető adatok ellenőrzése

                                        const artists = track.artists?.map(a => a.name).join(', ') || null;
                                        const imageUrl = track.album?.images?.[0]?.url || null;
                                        const albumName = track.album?.name || 'Unknown Album';
                                        const trackName = track.name || 'Unknown Track';

                                        if (isNaN(new Date(item.played_at).getTime())) {
                                            console.warn(`Cron Job: Invalid played_at date format for user ${spotify_id}, track ${track.id}: ${item.played_at}`);
                                            continue;
                                        }

                                        await client.query(insertQuery, [
                                            spotify_id, track.id, trackName, artists, albumName, imageUrl,
                                            item.played_at, track.uri, track.duration_ms
                                        ]);
                                    }

                                    // 6. Kurzor frissítése (csak ha volt új kurzor)
                                    if (nextCursor) {
                                        await client.query('UPDATE users SET last_sync_cursor = $1, last_checked_at = NOW() WHERE spotify_id = $2', [nextCursor, spotify_id]);
                                        currentCursor = nextCursor; // Következő ciklushoz
                                        console.log(`Cron Job: Updated cursor for user ${spotify_id} to ${nextCursor}`);
                                    } else {
                                        // Ha nem volt új kurzor, de voltak elemek, akkor is frissítjük az időt
                                        await client.query('UPDATE users SET last_checked_at = NOW() WHERE spotify_id = $1', [spotify_id]);
                                        console.log(`Cron Job: Updated last_checked_at for user ${spotify_id} (no new cursor).`);
                                    }
                                    await client.query('COMMIT');
                                } catch (dbError) {
                                    await client.query('ROLLBACK');
                                    console.error(`Cron Job: DB transaction error for user ${spotify_id}:`, dbError);
                                    userError = true; // Hiba történt, ne folytassuk a lapozást
                                    hasMore = false;
                                } finally {
                                    client.release();
                                }
                            } else {
                                // Nincs több új elem ezen az oldalon
                                console.log(`Cron Job: No more new plays found for user ${spotify_id} on this page.`);
                                // Ha nem volt hiba és nem volt új kurzor sem, akkor is frissítjük az időt
                                if (!userError && !nextCursor) {
                                    await db.query('UPDATE users SET last_checked_at = NOW() WHERE spotify_id = $1', [spotify_id]);
                                    console.log(`Cron Job: Updated last_checked_at for user ${spotify_id} (no new items).`);
                                }
                                hasMore = false;
                            }

                            // Következő oldal URL-je, vagy leállás
                            if (hasMore && playsResponse.data.next && nextCursor) {
                                url = playsResponse.data.next; // Spotify megadja a teljes URL-t
                                console.log(`Cron Job: Fetching next page for user ${spotify_id}: ${url}`);
                            } else {
                                hasMore = false;
                            }

                        } catch (fetchError) {
                            console.error(`Cron Job: Failed to fetch plays page for user ${spotify_id}:`, fetchError.response?.data || fetchError.message);
                            if (fetchError.response?.status === 401) newAccessToken = null; // Token lejárt lapozás közben
                            userError = true;
                            hasMore = false; // Hiba esetén leállunk ennél a usernél
                        }
                    } // end while(hasMore)

                    if (!userError) {
                        console.log(`Cron Job: Finished fetching for user ${spotify_id}. Total new plays found: ${fetchCount}`);
                        totalNewPlays += fetchCount;
                    }

                } // end if (!userError && newAccessToken)

            } catch (userProcessingError) {
                console.error(`Cron Job: Unhandled error processing user ${spotify_id}:`, userProcessingError);
                userError = true; // Jelöljük, hogy hiba volt
            }

            // Számoljuk a sikeresen feldolgozott usereket és a hibákat
            if (!userError) {
                processedUsers++;
            } else {
                totalErrors++;
            }

        } // end for(user of users)

        console.log(`[${new Date().toISOString()}] Cron Job: Finished. Processed users: ${processedUsers}, Users with errors: ${totalErrors}, Total new plays saved: ${totalNewPlays}`);
        // Sikeres választ küldünk Vercelnek, még ha voltak is egyedi felhasználói hibák.
        // A Vercel Cron logokból lehet majd debuggolni a hibákat.
        res.status(200).json({
            message: `Cron finished. Processed: ${processedUsers}, Errors: ${totalErrors}, New Plays: ${totalNewPlays}`
        });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Cron Job: Fatal error during execution:`, error);
        res.status(500).json({ error: 'Cron job failed due to an internal error' });
    }
}

module.exports = runFetchRecentPlays;