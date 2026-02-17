const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const axios = require('axios');
const { RSI, SMA } = require('technicalindicators');

// Konfigurasi Strategi
const MIN_VOLUME = 1500000000; 
const RSI_LOWER = 50; 
const RSI_UPPER = 100;
const COOLDOWN_MS = 30 * 60 * 1000; 

let alertCounter = new Map();
let lastAlertTime = new Map();
let lastResetDate = new Date().toDateString();

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
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000 
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

async function sendTelegram(symbol, rsi, price, diffMA, vol) {
    const count = (alertCounter.get(symbol) || 0) + 1;
    alertCounter.set(symbol, count);

    const message = `🚀 *#${symbol} RSI: ${rsi.toFixed(2)} | ALERT #${count}* 🚀\n` +
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
        // Logging detail error khusus Ubuntu
        if (e.response) {
            console.error(`❌ Telegram Error #${symbol}:`, e.response.data.description);
        } else {
            console.error(`❌ Network Error #${symbol}:`, e.message);
        }
    }
}

async function runScanner() {
    checkMidnightReset();
    console.log(`\n--- [${new Date().toLocaleTimeString()}] SCANNING ---`);

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
                await new Promise(r => setTimeout(r, 2000)); // Rate limit protection
                const tech = await getTechnicalData(symbol, priceNow);
                
                if (tech && priceNow > tech.ma25 && tech.rsi >= RSI_LOWER && tech.rsi <= RSI_UPPER) {
                    const diffMA = ((priceNow - tech.ma25) / tech.ma25) * 100;
                    await sendTelegram(symbol, tech.rsi, priceNow, diffMA, volIdr);
                    lastAlertTime.set(symbol, now);
                }
            }
        }
    } catch (error) {
        console.error("❌ Main Error:", error.message);
    }
}

// Start
setInterval(runScanner, 5 * 60 * 1000); 
runScanner();