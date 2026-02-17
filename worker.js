require('dotenv').config();
const axios = require('axios');
const { RSI, SMA } = require('technicalindicators');

// Konfigurasi Strategi
const MIN_VOLUME = 1500000000;      // Sesuai permintaan Anda: 1.5 Miliar
const RSI_LOWER = 50; 
const RSI_UPPER = 100;              // Dibuka sampai 100 agar lebih sensitif
const COOLDOWN_MS = 30 * 60 * 1000; // Cooldown 30 menit

let alertCounter = new Map();
let lastAlertTime = new Map();
let lastResetDate = new Date().toDateString();

/**
 * Reset counter jika sudah ganti hari (Jam 12 Malam)
 */
function checkMidnightReset() {
    const today = new Date().toDateString();
    if (lastResetDate !== today) {
        console.log("🕛 Jam 12 Malam: Reset semua counter koin.");
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
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 8000 
        });

        const candles = response.data;
        if (!Array.isArray(candles) || candles.length < 30) return null;

        let closes = candles.map(c => Number(c.Close));
        closes.push(priceNow); 

        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const maValues = SMA.calculate({ values: closes, period: 25 });

        return {
            rsi: rsiValues[rsiValues.length - 1],
            ma25: maValues[maValues.length - 1]
        };
    } catch (e) {
        return null;
    }
}

async function runScanner() {
    checkMidnightReset(); // Cek reset setiap kali scan dimulai
    console.log(`\n--- [${new Date().toLocaleTimeString()}] MEMULAI SCAN ---`);

    try {
        const response = await axios.get('https://indodax.com/api/summaries');
        const tickers = response.data.tickers;
        if (!tickers) return;

        const pairs = Object.keys(tickers).filter(p => p.endsWith('_idr'));

        for (const pair of pairs) {
            const d = tickers[pair];
            const symbol = pair.split('_')[0].toUpperCase();
            const priceNow = Number(d.last);
            const volIdr = Number(d.vol_idr);

            const now = Date.now();
            if (volIdr > MIN_VOLUME && (now - (lastAlertTime.get(symbol) || 0) > COOLDOWN_MS)) {
                
                await new Promise(r => setTimeout(r, 2000)); 

                const tech = await getTechnicalData(symbol, priceNow);
                if (!tech) continue;

                const { rsi, ma25 } = tech;
                const diffMA = ((priceNow - ma25) / ma25) * 100;

                if (priceNow > ma25 && rsi >= RSI_LOWER && rsi <= RSI_UPPER) {
                    console.log(`🎯 [#${symbol}] RSI: ${rsi.toFixed(2)} | Terdeteksi!`);
                    await sendTelegram(symbol, rsi, priceNow, diffMA, volIdr);
                    lastAlertTime.set(symbol, now);
                }
            }
        }
        console.log(`--- [${new Date().toLocaleTimeString()}] SCAN SELESAI ---`);
    } catch (error) {
        console.error("❌ Main Error:", error.message);
    }
}

async function sendTelegram(symbol, rsi, price, diffMA, vol) {
    // Logic Counter per Koin
    const count = (alertCounter.get(symbol) || 0) + 1;
    alertCounter.set(symbol, count);

    // Format Pesan Sesuai Permintaan
    const message = `🚀 *RSI: ${rsi.toFixed(2)} | ALERT #${count}* 🚀\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🪙 Asset: *#${symbol}*\n` +
        `📊 Momentum: *${rsi.toFixed(2)}*\n` +
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
    } catch (e) {
        console.error(`❌ Gagal kirim Telegram #${symbol}`);
    }
}

setInterval(runScanner, 5 * 60 * 1000); 
runScanner();