const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const QRCode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

let qrCodeBase64 = null;
let connectionStatus = "Desconectado";
let sock = null;

async function connectToWA() {
    const { state, saveCreds } = await useMultiFileAuthState('./sessao_limpa_v2');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["macOS", "Safari", "17.0"],
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        connectTimeoutMs: 60000
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeBase64 = await QRCode.toDataURL(qr);
            connectionStatus = "Aguardando Leitura";
        }
        if (connection === 'open') {
            qrCodeBase64 = null;
            connectionStatus = "Conectado";
            console.log("MOTOR V2 ONLINE!");
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if ([401, 408, 428].includes(statusCode)) {
                if (fs.existsSync('./sessao_limpa_v2')) fs.rmSync('./sessao_limpa_v2', { recursive: true, force: true });
            }
            setTimeout(() => connectToWA(), 5000);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeBase64 }));

app.post('/send', async (req, res) => {
    let { number, message } = req.body;
    if (connectionStatus !== "Conectado") return res.status(503).json({ error: "Offline" });
    try {
        let cleanNumber = String(number).replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(cleanNumber, { text: message });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(process.env.PORT || 3000, () => connectToWA());
