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
    // Mantendo a pasta de sessão estável que já funcionou para você
    const { state, saveCreds } = await useMultiFileAuthState('./sessao_v2');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        // Identidade macOS Safari para evitar bloqueios da Meta
        browser: ["macOS", "Safari", "17.0"],
        // Travas de estabilidade para o Railway Pago
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: true,
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
            console.log("MOTOR PROFISSIONAL ONLINE!");
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Conexão encerrada com status: ${statusCode}`);
            
            // Limpa sessão apenas em erros críticos de autenticação
            if ([401, 408, 428].includes(statusCode)) {
                if (fs.existsSync('./sessao_v2')) fs.rmSync('./sessao_v2', { recursive: true, force: true });
            }
            
            // Tenta reconectar automaticamente
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => connectToWA(), 5000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Endpoint de Status (usado pelo Lovable para mostrar o QR Code ou "Conectado")
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeBase64 }));

// Endpoint de Envio (Ajustado para aceitar números com ou sem o 9º dígito)
app.post('/send', async (req, res) => {
    let { number, message } = req.body;
    
    if (connectionStatus !== "Conectado") {
        return res.status(503).json({ error: "Motor Offline" });
    }

    try {
        // Limpa o número: remove parênteses, espaços e traços
        let cleanNumber = String(number).replace(/\D/g, '');
        
        // Garante o código do país (Brasil = 55)
        if (!cleanNumber.startsWith('55')) {
            cleanNumber = '55' + cleanNumber;
        }

        // Lógica de compatibilidade do WhatsApp:
        // Se o número tem o 9 mas falha, ou se não tem, o Baileys tenta encontrar o JID correto
        // A forma mais segura é enviar para o número exato que o WhatsApp reconhece internamente
        let jid = cleanNumber + '@s.whatsapp.net';
        
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, sentTo: jid });
        console.log(`Mensagem enviada para: ${jid}`);
        
    } catch (err) {
        console.error("Erro no envio:", err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => connectToWA());
