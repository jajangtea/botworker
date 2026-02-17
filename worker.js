require('dotenv').config();
const axios = require('axios');
const { RSI, SMA } = require('technicalindicators');

// Konfigurasi Strategi
const MIN_VOLUME = 1200000000; // Naikkan ke 500 Juta agar koin lebih berkualitas
const RSI_LOWER = 50;         // Sinyal beli jika RSI di atas 50 (Uptrend)
const RSI_UPPER = 100;         // Jangan beli jika RSI di atas 70 (Pucuk/Overbought)
const COOLDOWN_MS = 30 * 60 * 1000; // Cooldown 30 menit per koin agar tidak spam

const alertCounter = new Map();
const lastAlertTime = new Map();

/**
 * Fungsi hitung teknikal dengan menyuntikkan harga real-time
 */
async function getTechnicalData(symbol, priceNow) {
    try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - (60 * 60 * 48); // 48 jam data
        const url = `https://indodax.com/tradingview/history_v2?from=${from}&symbol=${symbol}IDR&tf=60&to=${to}`;

        const response = await axios.get(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 8000 
        });

        const candles = response.data;
        if (!Array.isArray(candles) || candles.length < 30) return null;

        // Ambil data close dan tambahkan harga saat ini (Real-time injection)
        let closes = candles.map(c => Number(c.Close));
        closes.push(priceNow); 

        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const maValues = SMA.calculate({ values: closes, period: 25 });

        return {
            rsi: rsiValues[rsiValues.length - 1],
            ma25: maValues[maValues.length - 1]
        };
    } catch (e) {
        if (e.response && e.response.status === 429) {
            console.error("⚠️ Terdeteksi Rate Limit (429). Melambatkan permintaan...");
        }
        return null;
    }
}

async function runScanner() {
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

            // FILTER 1: Volume & Cooldown (Cek ini dulu sebelum panggil API Candle)
            const now = Date.now();
            if (volIdr > MIN_VOLUME && (now - (lastAlertTime.get(symbol) || 0) > COOLDOWN_MS)) {
                
                // Jeda 2 detik antar koin untuk menghindari Error 429
                await new Promise(r => setTimeout(r, 2000)); 

                const tech = await getTechnicalData(symbol, priceNow);
                if (!tech) continue;

                const { rsi, ma25 } = tech;
                const diffMA = ((priceNow - ma25) / ma25) * 100;

                // FILTER 2: Logika Strategi (Lebih Ketat & Efektif)
                // 1. Harga harus di atas MA25 (Tren naik)
                // 2. RSI harus di antara 50 - 70 (Momentum kuat tapi belum klimaks)
                if (priceNow > ma25 && rsi >= RSI_LOWER && rsi <= RSI_UPPER) {
                    
                    console.log(`🎯 [${symbol}] Memenuhi Syarat! RSI: ${rsi.toFixed(2)}`);
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
    const count = (alertCounter.get(symbol) || 0) + 1;
    alertCounter.set(symbol, count);

    const message = `🚀 *SINYAL VALID DETECTED* 🚀\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🪙 Asset: *#${symbol}*\n` +
        `📊 RSI (Real-time): *${rsi.toFixed(2)}*\n` +
        `🛡️ Posisi vs MA25: *+${diffMA.toFixed(2)}%*\n` +
        `💰 Harga: *Rp ${price.toLocaleString('id-ID')}*\n` +
        `🌊 Vol 24h: *Rp ${(vol/1e9).toFixed(2)} Miliar*\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💡 *Analisa:* Uptrend terkonfirmasi. RSI menunjukkan momentum positif yang stabil.\n` +
        `🔗 [Chart Indodax](https://indodax.com/market/${symbol}IDR)`;

    try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: "Markdown"
        });
    } catch (e) {
        console.error("❌ Gagal kirim Telegram");
    }
}

// Interval diperpanjang ke 5 menit agar tidak dianggap spamming oleh server
// Strategi 1 Jam (1H) tidak butuh cek tiap menit.
setInterval(runScanner, 5 * 60 * 1000); 
runScanner();