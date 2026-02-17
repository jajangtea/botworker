require('dotenv').config();
const axios = require('axios');
const { RSI, SMA } = require('technicalindicators');

// --- KONFIGURASI & DATABASE ---
const alertCounter = new Map();
const lastAlertTime = new Map();
const prevVolume = new Map();
const lastAlertData = new Map();
let lastResetDate = new Date().toDateString();

// Fungsi pembantu untuk memberi jeda (mencegah Error 429)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Mengambil data teknikal RSI dan MA25
 */
async function getTechnicalData(symbol) {
    try {
        // Menambahkan header User-Agent agar tidak dianggap bot ilegal oleh Indodax
        const response = await axios.get(`https://indodax.com/api/candles/${symbol.toLowerCase()}idr?tf=60`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const candles = response.data;
        if (!candles || candles.length < 30) return null;

        const closes = candles.map(c => Number(c[4]));

        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const currentRSI = rsiValues[rsiValues.length - 1];

        const maValues = SMA.calculate({ values: closes, period: 25 });
        const currentMA25 = maValues[maValues.length - 1];

        return {
            rsi: currentRSI,
            ma25: currentMA25
        };
    } catch (e) {
        return null;
    }
}

/**
 * Fungsi utama pemindaian market (Optimized for Rate Limiting)
 */
async function runScanner() {
    const today = new Date().toDateString();

    // Logika Reset Harian
    if (lastResetDate !== today) {
        alertCounter.clear();
        lastResetDate = today;
        console.log(`[${new Date().toLocaleTimeString()}] 🌙 Berganti hari. Resetting all counters...`);
    }

    console.log(`[${new Date().toLocaleTimeString()}] 🔍 Memulai pemindaian koin potensial...`);

    try {
        const response = await axios.get(process.env.API_TICKER_URL);
        const tickers = response.data.tickers;

        if (!tickers) return;

        // Mengubah object tickers menjadi array agar bisa menggunakan for...of (sekuensial)
        const pairs = Object.keys(tickers);

        for (const pair of pairs) {
            // Hanya ambil pair IDR
            if (!pair.endsWith('_idr')) continue;

            const d = tickers[pair];
            const symbol = pair.split('_')[0].toUpperCase();
            const volNow = Number(d.vol_idr);
            const priceNow = Number(d.last);

            /**
             * 1. FILTER VOLUME: Minimal 1 Miliar
             * Dinaikkan ke 1M untuk mengurangi beban request ke API Candle 
             * agar IP tidak mudah terkena blokir (429).
             */
            if (volNow > 1000000000) {

                // 2. DETEKSI VOLUME SPIKE
                const volBefore = prevVolume.get(symbol) || volNow;
                const volIncrease = ((volNow - volBefore) / volBefore) * 100;
                prevVolume.set(symbol, volNow);

                /**
                 * 3. JEDA WAJIB (QUEUEING)
                 * Memberikan jeda 1.5 detik per koin agar Indodax tidak menganggap bot
                 * sedang melakukan spamming request candle.
                 */
                console.log(`   ∟ 📊 Menganalisa teknikal: ${symbol}...`);
                await sleep(1500);

                const tech = await getTechnicalData(symbol);
                if (!tech) continue;

                // 4. LOGIKA FILTER SINYAL (MA25 & RSI)
                const isBullish = priceNow > tech.ma25;
                const isStrongMomentum = tech.rsi > 50;

                if (isBullish && isStrongMomentum) {
                    /**
                     * Trigger Alert: 
                     * - RSI sudah di area Overbought (>70)
                     * - ATAU Terjadi lonjakan volume mendadak (>20%)
                     */
                    if (tech.rsi > 70 || volIncrease > 20) {
                        await sendTelegram(symbol, tech.rsi, priceNow, tech.ma25, volIncrease);
                    }
                }
            }
        }
        console.log(`[${new Date().toLocaleTimeString()}] ✅ Scan selesai. Tidur sejenak...`);

    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.error("❌ ERROR 429: Terkena Rate Limit! Berhenti selama 2 menit...");
            // Jika kena limit, istirahat lebih lama (2 menit) agar IP kembali bersih
            await sleep(120000);
        } else {
            console.error("❌ Scanner Error:", error.message);
        }
    }
}
/**
 * Mengirim notifikasi ke Telegram dengan Smart Alert
 */
async function sendTelegram(symbol, rsi, price, ma25, volSpike) {
    const now = Date.now();
    const lastTime = lastAlertTime.get(symbol) || 0;
    const lastData = lastAlertData.get(symbol);

    let shouldBreakCooldown = false;

    if (lastData) {
        const priceChange = ((price - lastData.price) / lastData.price) * 100;
        const rsiChange = rsi - lastData.rsi;

        // Smart Alert: Kirim ulang jika harga naik > 2% atau RSI naik > 5 poin
        if (priceChange >= 2.0 || rsiChange >= 5) {
            shouldBreakCooldown = true;
        }
    }

    // Cooldown 10 menit kecuali ada pergerakan signifikan
    if (now - lastTime < 10 * 60 * 1000 && !shouldBreakCooldown) {
        return;
    }

    const count = (alertCounter.get(symbol) || 0) + 1;
    alertCounter.set(symbol, count);
    lastAlertData.set(symbol, { price, rsi });
    lastAlertTime.set(symbol, now);

    const diffMA = ((price - ma25) / ma25) * 100;
    const momentumEmoji = shouldBreakCooldown ? "⚡ MOMENTUM SPIKE ⚡" : (rsi > 70 ? '🔥 STRONG PUMP' : '📈 BULLISH TREND');

    const message = `🚀 *SMART ALERT #${count}* 🚀\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🪙 Asset: *#${symbol}*\n` +
        `📊 Status: *${momentumEmoji}*\n\n` +
        `📈 RSI (1H): *${rsi.toFixed(2)}* ${shouldBreakCooldown ? '🔼' : ''}\n` +
        `🛡️ Harga vs MA25: *+${diffMA.toFixed(2)}%*\n` +
        `⚡ Vol Spike: *+${volSpike.toFixed(2)}%*\n` +
        `💰 Price: *Rp ${price.toLocaleString('id-ID')}*\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🔗 [Lihat Chart](https://indodax.com/market/${symbol}IDR)\n` +
        `⏰ ${new Date().toLocaleTimeString('id-ID')} WIB`;

    try {
        const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: "Markdown"
        });
        console.log(`✅ [${symbol}] Notifikasi terkirim.`);
    } catch (e) {
        console.error(`❌ Gagal kirim Telegram untuk ${symbol}`);
    }
}

// Menjalankan scanner sesuai interval .env (disarankan minimal 60000ms / 1 menit)
const interval = parseInt(process.env.FETCH_INTERVAL) || 60000;
setInterval(runScanner, interval);
runScanner();

console.log(`🚀 Bot Worker aktif! Interval: ${interval / 1000} detik.`);