const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, delay, DisconnectReason } = require("@whiskeysockets/baileys");
const QRCode = require('qrcode');
const fs = require('fs');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

let qrCodeBase64 = null;
let connectionStatus = "Desconectado";
let sock = null;
let messagesHistory = []; // Memória para o seu site estilo WhatsApp

async function connectToWA() {
    // Pasta definitiva para sua sessão paga no Railway
    const { state, saveCreds } = await useMultiFileAuthState('./sessao_definitiva');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["macOS", "Safari", "17.0"], // Identidade segura
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: true
    });

    // --- MOTOR DE ESCUTA (ROBÔ E CHAT) ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const name = msg.pushName || "Cliente";
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "Mídia recebida";

        // 1. Salva no histórico para o seu Dashboard no Lovable
        messagesHistory.push({
            id: msg.key.id,
            from: from.replace('@s.whatsapp.net', ''),
            name: name,
            text: text,
            time: new Date().toLocaleTimeString('pt-BR')
        });

        // 2. LÓGICA DO ROBÔ (CHATBOT)
        const mensagemBaixa = text.toLowerCase();
        if (mensagemBaixa === 'oi' || mensagemBaixa === 'olá') {
            await delay(2000); // Espera 2 segundos para parecer humano
            await sock.sendMessage(from, { text: `Olá ${name}! Bem-vindo ao atendimento automático. Como posso te ajudar?` });
        }
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
            console.log("SISTEMA COMPLETO ONLINE!");
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => connectToWA(), 5000);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- ENDPOINTS PARA O LOVABLE ---
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeBase64 }));
app.get('/messages', (req, res) => res.json(messagesHistory));

app.post('/send', async (req, res) => {
    let { number, message } = req.body;
    if (connectionStatus !== "Conectado") return res.status(503).json({ error: "Offline" });
    
    try {
        let cleanNumber = String(number).replace(/\D/g, '');
        if (!cleanNumber.startsWith('55')) cleanNumber = '55' + cleanNumber;
        let jid = cleanNumber + '@s.whatsapp.net';
        
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(process.env.PORT || 3000, () => connectToWA());
