// app.js
// Fő Express alkalmazás

require('dotenv').config();
const express = require('express');
// const axios = require('axios'); // Erre itt már nem biztos, hogy szükség van közvetlenül
const db = require('./db');
// const { encrypt, decrypt } = require('./encryption'); // Erre itt már nem biztos, hogy szükség van közvetlenül

const app = express();
app.use(express.json());

// iOS App Callback Konstansok (maradhatnak)
const APP_SCHEME = process.env.IOS_APP_SCHEME || 'spotifyjournalauth';
const APP_CALLBACK_PATH = 'callback';

// --- Új Route Handlerek Importálása ---
const handleExchangeCode = require('./api/auth/exchange-code');
const handleRefreshToken = require('./api/auth/refresh');
const handleFetchHistory = require('./api/history'); // Feltételezve, hogy ez is külön fájlban van
const handleCronFetch = require('./api/cron/fetch_recent_plays'); // Cron job handler

// --- Útvonalak ---

// 1. Spotify Callback (Middleman) - Változatlan
app.get('/spotify-callback', (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    const error = req.query.error;
    console.log('Received /spotify-callback from Spotify:', { code: !!code, state, error });
    const appUrl = new URL(`${APP_SCHEME}://${APP_CALLBACK_PATH}`);
    if (error) {
        appUrl.searchParams.append('error', error);
        if (req.query.error_description) appUrl.searchParams.append('error_description', req.query.error_description);
        if (state) appUrl.searchParams.append('state', state);
        console.log('Redirecting to app with error:', appUrl.toString());
        res.redirect(302, appUrl.toString());
    } else if (code) {
        appUrl.searchParams.append('code', code);
        if (state) appUrl.searchParams.append('state', state);
        console.log('Redirecting to app with code:', appUrl.toString());
        res.redirect(302, appUrl.toString());
    } else {
        console.warn('/spotify-callback called without code or error.');
        res.status(400).send('Invalid callback parameters received from Spotify.');
    }
});

// 2. Kód Cseréje és Felhasználó Regisztráció (ÚJ VÉGPONT)
// Az iOS app ezt hívja meg a 'code' megszerzése után.
app.post('/api/auth/exchange-code', handleExchangeCode);

// 3. Token Frissítés (ÚJ VÉGPONT)
// Az iOS app ezt hívja meg, ha az access token lejár.
app.post('/api/auth/refresh', handleRefreshToken);


// 4. Lejátszási Előzmények Lekérése (Régi /api/history - Átnevezhető vagy maradhat)
// Ezt az iOS app hívja az érvényes access tokenjével.
// Javaslat: Tedd ezt is külön fájlba, pl. api/history.js
// const handleFetchHistory = require('./api/history'); // Import fentebb
app.get('/api/history', handleFetchHistory); // Használjuk a külön fájlt


// 5. Gyökér útvonal (Health check) - Változatlan
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send('Spotify Journal Backend is running!');
});

// 6. Cron Job Útvonal (Ha még használod)
// Győződj meg róla, hogy a fetch_recent_plays.js már nem próbál felhasználót regisztrálni,
// csak a meglévő, nem 'needs_reauth' user-ek tokenjeit frissíti és adatait kéri le.
// A require('./api/cron/fetch_recent_plays')(app); forma helyett jobb lehet egy router használata:
// const cronRouter = require('./api/cron/fetch_recent_plays');
// app.use('/api/cron', cronRouter); // Ha a fájl egy routert exportál
// Vagy ha csak egy GET végpont:
app.get('/api/cron/fetch_recent_plays', handleCronFetch); // Ha a fájl a handlert exportálja


// --- Régi /api/users/register TÖRLÉSE ---
// app.post('/api/users/register', async (req, res) => { ... }); // EZT TÖRÖLD!


// --- Vercel Export ---
module.exports = app;