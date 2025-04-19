// index.js vagy app.js (a platformtól függően)
const express = require('express');
const app = express();
const port = process.env.PORT || 3000; // Platform adja a PORT-ot

// A te appod custom URL scheme-je
const APP_SCHEME = 'spotifyjournalauth';
const APP_CALLBACK_PATH = 'callback'; // Vagy amit használsz

app.get('/hello', (req, res) => {
    res.send('Hello World!');
}
);

app.get('/spotify-callback', (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    const error = req.query.error;

    console.log('Received callback from Spotify:');
    console.log('Code:', code);
    console.log('State:', state);
    console.log('Error:', error);

    if (error) {
        // Hiba esetén is átirányíthatod az appba a hibával
        const redirectUrl = `${APP_SCHEME}://${APP_CALLBACK_PATH}?error=${encodeURIComponent(error)}&state=${encodeURIComponent(state || '')}`;
        console.log('Redirecting to app with error:', redirectUrl);
        res.redirect(302, redirectUrl);
    } else if (code) {
        // Sikeres kód esetén átirányítás az appba a kóddal és state-tel
        const redirectUrl = `${APP_SCHEME}://${APP_CALLBACK_PATH}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || '')}`;
        console.log('Redirecting to app with code:', redirectUrl);
        res.redirect(302, redirectUrl);
    } else {
        // Váratlan eset, talán csak egy sima hibaoldalra irányítás
        console.log('Missing code and error in callback.');
        res.status(400).send('Invalid callback parameters received from Spotify.');
    }
});

// Egyszerű gyökér endpoint a teszteléshez
app.get('/', (req, res) => {
    res.send('Spotify Callback Middle Man is running!');
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});