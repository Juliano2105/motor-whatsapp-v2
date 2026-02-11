const { default: makeWASocket, useMultiFileAuthState, disconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// 1. CONFIGURAÇÃO DE MÍDIA: Cria e serve a pasta para o Lovable acessar fotos/áudios
const mediaFolder = path.join(__dirname, 'media');
if (!fs.existsSync(mediaFolder)) fs.mkdirSync(mediaFolder, { recursive: true });
app.use('/media', express.static(mediaFolder));

let sock;
let connectionStatus = "Desconectado";
let qrCode = null;
let messageStore = [];

// 2. REGRA DO 9: Função para garantir que o número seja enviado sem o dígito 9 extra
function formatBRNumber(number) {
    let clean = String(number).replace(/\D/g, '');
    if (clean.length === 13 && clean.startsWith('55')) {
        clean = clean.slice(0, 4) + clean.slice(5);
    }
    if (!clean.startsWith('55')) clean = '55' + clean;
    return clean + '@s.whatsapp.net';
}

async function connectToWhatsApp() {
    // 3. FIXAÇÃO DE SESSÃO: Usa a pasta fixa para retomar a conexão sem novo QR Code
    const { state, saveCreds } = await useMultiFileAuthState('sessao_definitiva');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        defaultQueryTimeoutMs: undefined
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCode = qr;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== disconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp(); // Reconecta automaticamente
        } else if (connection === 'open') {
            connectionStatus = "Conectado";
            qrCode = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

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

            // 4. PROCESSAMENTO DE MÍDIA: Baixa fotos, vídeos e áudios
            const isImage = msg.message.imageMessage;
            const isVideo = msg.message.videoMessage;
            const isAudio = msg.message.audioMessage;

            if (isImage || isVideo || isAudio) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const extension = isImage ? 'jpg' : isVideo ? 'mp4' : 'ogg';
                    const fileName = `${msg.key.id}.${extension}`;
                    fs.writeFileSync(path.join(mediaFolder, fileName), buffer);
                    
                    msgData.type = isImage ? 'image' : isVideo ? 'video' : 'audio';
                    // Define a URL relativa para o frontend (Lovable) buscar
                    msgData.mediaUrl = `/media/${fileName}`; 
                    msgData.text = isImage?.caption || isVideo?.caption || '';
                } catch (e) {
                    console.log("Erro ao baixar mídia:", e.message);
                }
            }
            messageStore.push(msgData);
        }
    });
}

// ENDPOINTS DA API
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCode }));
app.get('/messages', (req, res) => res.json(messageStore));
app.post('/send', async (req, res) => {
    const { number, message } = req.body;
    try {
        const jid = formatBRNumber(number);
        await sock.sendMessage(jid, { text: message });
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

connectToWhatsApp();
app.listen(process.env.PORT || 3000);
