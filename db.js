// db.js
const { Pool } = require('pg');
require('dotenv').config(); // Helyi .env betöltése

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set.');
}

const pool = new Pool({
    connectionString: connectionString,
    // A Neon általában SSL-t igényel, a Vercel production környezetben is.
    // A ?sslmode=require a connection stringben ezt kezelheti, de expliciten is beállítható.
    ssl: {
        rejectUnauthorized: false // Szükséges lehet bizonyos környezetekben, de élesben fontold meg a CA cert használatát, ha lehetséges.
    }
});

pool.on('connect', () => {
    console.log('Connected to Neon database!');
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    // process.exit(-1); // Opcionális: Hiba esetén kilépés
});

module.exports = {
    // Egyszerűsített query függvény a pool használatával
    query: async (text, params) => {
        const start = Date.now();
        try {
            const res = await pool.query(text, params);
            const duration = Date.now() - start;
            // Opcionális: Logolhatod a lassú lekérdezéseket
            // if (duration > 500) {
            //   console.log('executed query', { text, duration, rows: res.rowCount });
            // }
            return res;
        } catch (err) {
            console.error('Database Query Error:', { text, params, error: err.message });
            throw err; // Dobjuk tovább a hibát, hogy a hívó kezelhesse
        }
    },
    // Lehetővé teszi a tranzakciókhoz szükséges kliens lekérését
    getClient: async () => {
        const client = await pool.connect();
        const query = client.query;
        const release = client.release;
        // Biztonsági intézkedés: timeout beállítása a lekérdezésekre
        client.query = (...args) => {
            client.lastQuery = args;
            return query.apply(client, args);
        };
        client.release = () => {
            // reset timeout
            client.query = query;
            client.release = release;
            return release.apply(client);
        };
        return client;
    }
};