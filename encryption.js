// encryption.js
// Titkosító és dekódoló segédfüggvények AES-256-CBC használatával.

const crypto = require('crypto');
require('dotenv').config(); // .env betöltése helyi fejlesztéshez

const ALGORITHM = 'aes-256-cbc'; // Ajánlott, erős titkosítási algoritmus
const IV_LENGTH = 16; // Az AES blokkmérete 16 bájt

// A titkosító kulcs betöltése a környezeti változóból.
// KRITIKUS: Ennek 64 hexadecimális karakternek (32 bájt) kell lennie!
const encryptionKeyHex = process.env.ENCRYPTION_KEY;

// Ellenőrzés indításkor: Megvan és megfelelő hosszúságú a kulcs?
if (!encryptionKeyHex || !/^[a-fA-F0-9]{64}$/.test(encryptionKeyHex)) {
    const keyInfo = encryptionKeyHex ? `(Length: ${encryptionKeyHex.length})` : '(Not set)';
    console.error(`FATAL ERROR: ENCRYPTION_KEY environment variable is missing, invalid, or not 64 hex characters long. ${keyInfo}`);
    console.error('Please generate a 32-byte key (64 hex chars) and set it in your .env file and Vercel environment variables.');
    // Leállítjuk az alkalmazást, mert titkosítás nélkül nem működhet biztonságosan.
    process.exit(1);
}

// A hexadecimális kulcs átalakítása Buffer objektummá, amit a crypto modul vár.
const KEY = Buffer.from(encryptionKeyHex, 'hex');

/**
 * Titkosítja a megadott szöveget AES-256-CBC algoritmussal.
 * @param {string | null | undefined} text A titkosítandó szöveg (pl. refresh token).
 * @returns {string | null} A titkosított szöveg "iv:ciphertext" hex formátumban, vagy null, ha a bemenet null/undefined.
 */
function encrypt(text) {
    // Kezeljük a null/undefined bemenetet
    if (text == null) {
        return null;
    }
    const plainText = String(text); // Biztosítjuk, hogy string legyen

    // Generálunk egy véletlenszerű Initialization Vector-t (IV) minden titkosításhoz.
    // Az IV nem titkos, de egyedinek kell lennie minden titkosításhoz ugyanazzal a kulccsal.
    const iv = crypto.randomBytes(IV_LENGTH);

    // Létrehozzuk a titkosító objektumot az algoritmussal, kulccsal és IV-vel.
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

    // Elvégezzük a titkosítást. Az eredményt hex formátumban kérjük.
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Az IV-t (hex formátumban) és a titkosított szöveget (hex formátumban)
    // összefűzzük egy kettősponttal elválasztva. Így tároljuk, hogy dekódolni tudjuk.
    return iv.toString('hex') + ':' + encrypted;
}

/**
 * Dekódolja az "iv:ciphertext" formátumú, hex kódolású szöveget.
 * @param {string | null | undefined} text A dekódolandó, "iv:ciphertext" hex formátumú szöveg.
 * @returns {string | null} Az eredeti szöveg, vagy null, ha a bemenet null/undefined,
 *                          érvénytelen formátumú, vagy a dekódolás sikertelen (pl. rossz kulcs).
 */
function decrypt(text) {
    // Kezeljük a null/undefined bemenetet
    if (text == null) {
        return null;
    }
    const encryptedTextWithIv = String(text);

    try {
        // Szétválasztjuk az IV-t és a titkosított szöveget a kettőspont mentén.
        const parts = encryptedTextWithIv.split(':');
        if (parts.length !== 2) {
            console.error('Decryption Error: Invalid format. Expected "iv_hex:ciphertext_hex". Received:', encryptedTextWithIv.substring(0, 50) + '...');
            return null; // Hibás formátum
        }

        const ivHex = parts[0];
        const encryptedTextHex = parts[1];

        // Visszaalakítjuk a hex IV-t Buffer objektummá.
        const iv = Buffer.from(ivHex, 'hex');

        // Ellenőrizzük az IV hosszát (AES-hez 16 bájtosnak kell lennie).
        if (iv.length !== IV_LENGTH) {
            console.error(`Decryption Error: Invalid IV length (${iv.length} bytes). Expected ${IV_LENGTH}.`);
            return null;
        }

        // Létrehozzuk a dekódoló objektumot.
        const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);

        // Elvégezzük a dekódolást hex formátumból utf8 szöveggé.
        let decrypted = decipher.update(encryptedTextHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        // Sikeres dekódolás esetén visszaadjuk az eredeti szöveget.
        return decrypted;

    } catch (error) {
        // Bármilyen hiba esetén (pl. rossz kulcs, sérült adat) null-t adunk vissza.
        // Fontos, hogy ne dobjunk kivételt feltétlenül, mert a hívó kód (pl. cron job)
        // lehet, hogy csak jelezni akarja a hibát (needs_reauth=true), és nem akar leállni.
        console.error('Decryption failed:', error.message); // Logoljuk a hibát a szerveren
        return null;
    }
}

// Exportáljuk a két függvényt, hogy más modulok használhassák.
module.exports = {
    encrypt,
    decrypt
};