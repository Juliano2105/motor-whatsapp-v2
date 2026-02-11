// 1. IMPORTAÇÕES NECESSÁRIAS
const { default: makeWASocket, useMultiFileAuthState, disconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// 2. DEFINIÇÃO DO APP (O que estava faltando!)
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Configuração de pastas
const mediaFolder = path.join(__dirname, 'media');
if (!fs.existsSync(mediaFolder)) fs.mkdirSync(mediaFolder, { recursive: true });
app.use('/media', express.static(mediaFolder));

let sock;
let connectionStatus = "Desconectado";
let qrCode = null;
let messageStore = []; // Onde as mensagens ficam guardadas

// 3. LOGICA DE CONEXÃO (FIXAÇÃO DE SESSÃO)
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('sessao_definitiva');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCode = qr;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== disconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            connectionStatus = "Conectado";
            qrCode = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ESCUTA DE MENSAGENS
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

            let msgData = {
                id: msg.key.id,
                from: msg.key.remoteJid,
                fromMe: msg.key.fromMe || false,
                name: msg.pushName || 'Contato',
                timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
                type: 'text',
                text: msg.message.conversation || msg.message.extendedTextMessage?.text || '',
                mediaUrl: null
            };

            // Download de mídia
            const m = msg.message;
            if (m.imageMessage || m.videoMessage || m.audioMessage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const ext = m.imageMessage ? 'jpg' : m.videoMessage ? 'mp4' : 'ogg';
                    const fileName = `${msg.key.id}.${ext}`;
                    fs.writeFileSync(path.join(mediaFolder, fileName), buffer);
                    msgData.type = m.imageMessage ? 'image' : m.videoMessage ? 'video' : 'audio';
                    msgData.mediaUrl = `/media/${fileName}`;
                } catch (e) { console.log("Erro mídia:", e.message); }
            }
            messageStore.push(msgData);
        }
    });
}

// 4. SEUS NOVOS ENDPOINTS (HISTORY, CHATS, SEARCH)
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCode }));

app.get('/history', (req, res) => {
    res.json({ total: messageStore.length, messages: messageStore });
});

app.get('/chats', (req, res) => {
    const chatMap = {};
    messageStore.forEach(msg => {
        const chatId = msg.from;
        if (!chatMap[chatId]) {
            chatMap[chatId] = { id: chatId, name: msg.name, lastMessage: msg.text, lastTimestamp: msg.timestamp };
        }
    });
    res.json({ chats: Object.values(chatMap).sort((a,b) => b.lastTimestamp - a.lastTimestamp) });
});

app.get('/chat/:chatId', (req, res) => {
    const { chatId } = req.params;
    const cleanParam = chatId.replace(/\D/g, '');
    const filtered = messageStore.filter(msg => msg.from.replace(/\D/g, '').includes(cleanParam));
    res.json({ messages: filtered });
});

app.post('/send', async (req, res) => {
    const { number, message } = req.body;
    try {
        let cleanNumber = number.replace(/\D/g, '');
        if (cleanNumber.length === 13) cleanNumber = cleanNumber.slice(0, 4) + cleanNumber.slice(5);
        const jid = cleanNumber + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// INICIALIZAÇÃO
connectToWhatsApp();
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
