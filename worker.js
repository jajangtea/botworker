const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const axios = require('axios');
const { RSI, SMA } = require('technicalindicators');

// Konfigurasi Strategi
const MIN_VOLUME = 10000000000; 
const RSI_LOWER = 50; 
const RSI_UPPER = 100;
const COOLDOWN_MS = 30 * 60 * 1000; 

let alertCounter = new Map();
let lastAlertTime = new Map();
let lastResetDate = new Date().toDateString();

// Konfigurasi Default Axios (Global)
axios.defaults.timeout = 15000; // Putus koneksi otomatis jika > 15 detik tidak respon

function checkMidnightReset() {
    const today = new Date().toDateString();
    if (lastResetDate !== today) {
        console.log("🕛 Reset counter harian...");
        alertCounter.clear();
        lastResetDate = today;
    }
}

async function getTechnicalData(symbol, priceNow) {
    try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - (60 * 60 * 48); 
        const url = `https://indodax.com/tradingview/history_v2?from=${from}&symbol=${symbol}IDR&tf=60&to=${to}`;

        const response = await axios.get(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        // Perbaikan: Validasi struktur data TradingView Indodax
        const candles = response.data;
        if (!Array.isArray(candles) || candles.length < 30) return null;

        let closes = candles.map(c => Number(c.Close));
        
        // Pastikan tidak ada nilai NaN di data harga
        if (closes.some(isNaN)) return null;

        closes.push(priceNow); 

        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const maValues = SMA.calculate({ values: closes, period: 25 });

        if (!rsiValues.length || !maValues.length) return null;

        return {
            rsi: rsiValues[rsiValues.length - 1],
            ma25: maValues[maValues.length - 1]
        };
    } catch (e) {
        // Menangkap ECONNRESET atau Timeout di level API TradingView
        console.error(`⚠️  Skip ${symbol}: Masalah koneksi API History (${e.code || e.message})`);
        return null;
    }
}

async function sendTelegram(symbol, rsi, price, diffMA, vol) {
    const count = (alertCounter.get(symbol) || 0) + 1;
    alertCounter.set(symbol, count);

    const message = `🚀 *#${symbol} RSI: ${rsi.toFixed(2)} | #${count}* 🚀\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🛡️ vs MA25: *+${diffMA.toFixed(2)}%*\n` +
        `💰 Harga: *Rp ${price.toLocaleString('id-ID')}*\n` +
        `🌊 Vol 24h: *Rp ${(vol/1e9).toFixed(2)} Miliar*\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💡 *Status:* Uptrend Terdeteksi\n` +
        `⏰ ${new Date().toLocaleTimeString('id-ID')} WIB\n`;

    try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: "Markdown"
        });
        console.log(`✅ Terkirim: #${symbol}`);
    } catch (e) {
        // Menangkap error Telegram agar tidak merusak loop scanner
        console.error(`❌ Telegram Gagal (#${symbol}): ${e.message}`);
    }
}

async function runScanner() {
    checkMidnightReset();
    console.log(`\n--- [${new Date().toLocaleTimeString()}] SCANNING ---`);

    try {
        // Step 1: Ambil Summary Tickers
        const response = await axios.get('https://indodax.com/api/summaries');
        const tickers = response.data.tickers;
        if (!tickers) return;

        const pairs = Object.keys(tickers).filter(p => p.endsWith('_idr'));

        for (const pair of pairs) {
            try { // Tambahkan try-catch internal per-pair agar jika satu pair error, yang lain tetap jalan
                const d = tickers[pair];
                const symbol = pair.split('_')[0].toUpperCase();
                const priceNow = Number(d.last);
                const volIdr = Number(d.vol_idr);

                const now = Date.now();
                
                // Filter Volume dan Cooldown
                if (volIdr > MIN_VOLUME && (now - (lastAlertTime.get(symbol) || 0) > COOLDOWN_MS)) {
                    
                    // Delay kecil antar request untuk menghindari rate limit/ECONNRESET
                    await new Promise(r => setTimeout(r, 1000)); 
                    
                    const tech = await getTechnicalData(symbol, priceNow);
                    
                    if (tech && priceNow > tech.ma25 && tech.rsi >= RSI_LOWER && tech.rsi <= RSI_UPPER) {
                        const diffMA = ((priceNow - tech.ma25) / tech.ma25) * 100;
                        await sendTelegram(symbol, tech.rsi, priceNow, diffMA, volIdr);
                        lastAlertTime.set(symbol, now);
                    }
                }
            } catch (err) {
                console.error(`❌ Error pada pair ${pair}:`, err.message);
                continue; // Lanjut ke koin berikutnya
            }
        }
    } catch (error) {
        // Menangkap error utama (misal indodax.com down)
        console.error("❌ Main Error (Indodax API):", error.code || error.message);
    }
}

// Start
// Gunakan interval 5 menit
setInterval(runScanner, 5 * 60 * 1000); 
runScanner();