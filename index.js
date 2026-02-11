try { require("dotenv").config() } catch {}

const fs = require("fs")
const path = require("path")
const express = require("express")
const cors = require("cors")
const QRCode = require("qrcode")
const P = require("pino")
const WebSocket = require("ws")

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  downloadMediaMessage
} = require("@whiskeysockets/baileys")

const app = express()
app.use(cors())
app.use(express.json({ limit: "25mb" }))

const PORT = process.env.PORT || 3000
const MEDIA_DIR = process.env.MEDIA_DIR || "./media"
const SESSIONS_DIR = "./sessions"
const AUTO_BOT = String(process.env.AUTO_BOT || "true") === "true"
const AUTO_MARK_READ = String(process.env.AUTO_MARK_READ || "false") === "true"
const INTERNAL_WEBHOOK = process.env.INTERNAL_WEBHOOK || ""

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
ensureDir(MEDIA_DIR)
ensureDir(SESSIONS_DIR)

const mem = {
  sessions: {},
  messages: {},
  chats: {}
}

function pushMessage(sessionId, msg) {
  if (!mem.messages[sessionId]) mem.messages[sessionId] = []
  mem.messages[sessionId].push(msg)
  if (mem.messages[sessionId].length > 5000) mem.messages[sessionId].shift()
}

function upsertChat(sessionId, jid, lastMessage) {
  if (!mem.chats[sessionId]) mem.chats[sessionId] = {}
  mem.chats[sessionId][jid] = lastMessage
}

function extByType(type, mimetype) {
  if (type === "imageMessage") return ".jpg"
  if (type === "videoMessage") return ".mp4"
  if (type === "audioMessage") return ".ogg"
  if (type === "documentMessage") {
    const guess = mimetype?.split("/")?.[1]
    return guess ? "." + guess : ".bin"
  }
  return ".bin"
}

async function saveIncomingMedia(sock, msg, messageType) {
  const buffer = await downloadMediaMessage(
    msg,
    "buffer",
    {},
    { reuploadRequest: sock.updateMediaMessage }
  )

  const mimetype = msg.message?.[messageType]?.mimetype || null
  const filename = `${Date.now()}_${msg.key.id}${extByType(messageType, mimetype)}`
  const filepath = path.join(MEDIA_DIR, filename)
  fs.writeFileSync(filepath, buffer)

  return {
    filepath,
    filename,
    mimetype,
    url: `/media/${encodeURIComponent(filename)}`
  }
}

async function runBot(sock, jid, text) {
  if (!AUTO_BOT) return { replied: false }

  const t = (text || "").trim().toLowerCase()
  if (!t) return { replied: false }

  if (t === "oi" || t === "olá" || t === "ola") {
    await sock.sendMessage(jid, { text: "Olá, tudo bem? Me diga se você tem loja ou quer começar a empreender." })
    return { replied: true }
  }

  if (t.includes("preço") || t.includes("valor")) {
    await sock.sendMessage(jid, { text: "Me fala qual produto você quer e sua cidade, que eu te passo certinho." })
    return { replied: true }
  }

  return { replied: false }
}

const clients = {}
const stores = {}

async function createClient(sessionId) {
  ensureDir(path.join(SESSIONS_DIR, sessionId))

  const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSIONS_DIR, sessionId))
  const { version } = await fetchLatestBaileysVersion()

  const store = makeInMemoryStore({ logger: P().child({ level: "silent" }) })
  stores[sessionId] = store

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: true
  })

  store.bind(sock.ev)

  mem.sessions[sessionId] = mem.sessions[sessionId] || {}
  mem.sessions[sessionId].status = "Conectando"
  mem.sessions[sessionId].qr = null
  mem.sessions[sessionId].me = mem.sessions[sessionId].me || null
  mem.sessions[sessionId].lastEventAt = Date.now()

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update
    mem.sessions[sessionId].lastEventAt = Date.now()

    if (qr) {
      const b64 = await QRCode.toDataURL(qr)
      mem.sessions[sessionId].qr = b64
      mem.sessions[sessionId].status = "QR Gerado"
      broadcast("qr", { sessionId, qr: b64 })
    }

    if (connection === "open") {
      mem.sessions[sessionId].status = "Conectado"
      mem.sessions[sessionId].qr = null
      mem.sessions[sessionId].me = sock.user
      broadcast("status", { sessionId, status: "Conectado", me: sock.user })
    }

    if (connection === "close") {
      mem.sessions[sessionId].status = "Desconectado"
      broadcast("status", { sessionId, status: "Desconectado" })

      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut

      if (shouldReconnect) {
        delete clients[sessionId]
        setTimeout(() => createClient(sessionId), 1500)
      }
    }
  })

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0]
    if (!msg?.message) return

    mem.sessions[sessionId].lastEventAt = Date.now()

    const jid = msg.key.remoteJid
    const fromMe = !!msg.key.fromMe
    const messageType = Object.keys(msg.message)[0]

    let text = null
    if (messageType === "conversation") text = msg.message.conversation
    if (messageType === "extendedTextMessage") text = msg.message.extendedTextMessage?.text || null

    const base = {
      sessionId,
      id: msg.key.id,
      jid,
      fromMe,
      timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000),
      type: messageType,
      pushName: msg.pushName || null,
      participant: msg.key.participant || null,
      hasQuoted: !!msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    }

    const isMedia =
      messageType === "imageMessage" ||
      messageType === "videoMessage" ||
      messageType === "audioMessage" ||
      messageType === "documentMessage"

    let media = null
    if (isMedia) {
      try {
        media = await saveIncomingMedia(sock, msg, messageType)
      } catch (e) {
        media = { error: "Falha ao baixar mídia" }
      }
    }

    const normalized = { ...base, text, media }
    pushMessage(sessionId, normalized)
    upsertChat(sessionId, jid, normalized)

    broadcast("message", normalized)

    if (!fromMe && AUTO_MARK_READ) {
      try {
        await sock.readMessages([msg.key])
      } catch {}
    }

    if (!fromMe) {
      try {
        await runBot(sock, jid, text)
      } catch {}
    }

    if (INTERNAL_WEBHOOK) {
      try {
        await fetch(INTERNAL_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...normalized, source: "live" })
        })
      } catch {}
    }
  })

  sock.ev.on("message-receipt.update", (updates) => {
    mem.sessions[sessionId].lastEventAt = Date.now()
    broadcast("receipt", { sessionId, updates })
  })

  sock.ev.on("presence.update", (p) => {
    mem.sessions[sessionId].lastEventAt = Date.now()
    broadcast("presence", { sessionId, presence: p })
  })

  clients[sessionId] = sock
  return sock
}

async function ensureSession(sessionId) {
  if (clients[sessionId]) return clients[sessionId]
  return await createClient(sessionId)
}

function listSessions() {
  return Object.keys(mem.sessions || {}).map((id) => ({
    sessionId: id,
    status: mem.sessions[id]?.status || "Desconhecido",
    hasQr: !!mem.sessions[id]?.qr,
    me: mem.sessions[id]?.me || null,
    lastEventAt: mem.sessions[id]?.lastEventAt || null
  }))
}

let httpServer = null
const wss = new WebSocket.Server({ noServer: true })

function broadcast(event, payload) {
  const msg = JSON.stringify({ event, payload })
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg)
  })
}

setInterval(() => {
  wss.clients.forEach((ws) => {
    try {
      if (ws.isAlive === false) return ws.terminate()
      ws.isAlive = false
      ws.ping()
    } catch {}
  })
}, 30000)

function normalizeToJid(number, jid) {
  const cleanNumber = String(number || "").replace(/\D/g, "")
  const finalNumber =
    cleanNumber.length === 13 && cleanNumber.startsWith("55")
      ? cleanNumber.slice(0, 4) + cleanNumber.slice(5)
      : cleanNumber
  return jid || (finalNumber + "@s.whatsapp.net")
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    sessions: listSessions().length,
    node: process.version
  })
})

app.get("/media/:filename", (req, res) => {
  const filename = req.params.filename
  const filepath = path.join(MEDIA_DIR, filename)
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: "Arquivo não encontrado" })
  res.sendFile(path.resolve(filepath))
})

app.get("/sessions", (req, res) => res.json({ sessions: listSessions() }))

app.post("/sessions/:sessionId/start", async (req, res) => {
  const { sessionId } = req.params
  await ensureSession(sessionId)
  res.json({ ok: true })
})

app.get("/sessions/:sessionId/status", (req, res) => {
  const { sessionId } = req.params
  const s = mem.sessions[sessionId] || {}
  res.json({ status: s.status || "Desconhecido", me: s.me || null, lastEventAt: s.lastEventAt || null })
})

app.get("/sessions/:sessionId/qr", (req, res) => {
  const { sessionId } = req.params
  const s = mem.sessions[sessionId] || {}
  res.json({ qr: s.qr || null })
})

app.get("/sessions/:sessionId/messages", (req, res) => {
  const { sessionId } = req.params
  const limit = Math.min(Number(req.query.limit || 200), 2000)
  const before = req.query.before ? Number(req.query.before) : null

  const arr = mem.messages[sessionId] || []
  const filtered = before
    ? arr.filter((m) => Number(m.timestamp || 0) < before)
    : arr

  res.json({
    messages: filtered.slice(-limit),
    nextBefore: filtered.length ? Number(filtered[0]?.timestamp || 0) : null
  })
})

app.get("/sessions/:sessionId/chats", (req, res) => {
  const { sessionId } = req.params
  const chats = mem.chats[sessionId] || {}
  const list = Object.values(chats).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
  res.json({ chats: list })
})

app.post("/sessions/:sessionId/send/text", async (req, res) => {
  const { sessionId } = req.params
  const { number, jid, text } = req.body || {}
  if (!jid && !number) return res.status(400).json({ error: "Informe jid ou number" })

  const sock = await ensureSession(sessionId)
  const targetJid = normalizeToJid(number, jid)

  await sock.sendMessage(targetJid, { text: String(text || "") })
  res.json({ ok: true })
})

app.post("/sessions/:sessionId/send/image", async (req, res) => {
  const { sessionId } = req.params
  const { jid, number, imageUrl, caption } = req.body || {}
  if (!jid && !number) return res.status(400).json({ error: "Informe jid ou number" })
  if (!imageUrl) return res.status(400).json({ error: "Informe imageUrl" })

  const sock = await ensureSession(sessionId)
  const targetJid = normalizeToJid(number, jid)

  await sock.sendMessage(targetJid, { image: { url: imageUrl }, caption: caption || "" })
  res.json({ ok: true })
})

app.post("/sessions/:sessionId/send/video", async (req, res) => {
  const { sessionId } = req.params
  const { jid, number, videoUrl, caption } = req.body || {}
  if (!jid && !number) return res.status(400).json({ error: "Informe jid ou number" })
  if (!videoUrl) return res.status(400).json({ error: "Informe videoUrl" })

  const sock = await ensureSession(sessionId)
  const targetJid = normalizeToJid(number, jid)

  await sock.sendMessage(targetJid, { video: { url: videoUrl }, caption: caption || "" })
  res.json({ ok: true })
})

app.post("/sessions/:sessionId/send/audio", async (req, res) => {
  const { sessionId } = req.params
  const { jid, number, audioUrl, ptt } = req.body || {}
  if (!jid && !number) return res.status(400).json({ error: "Informe jid ou number" })
  if (!audioUrl) return res.status(400).json({ error: "Informe audioUrl" })

  const sock = await ensureSession(sessionId)
  const targetJid = normalizeToJid(number, jid)

  await sock.sendMessage(targetJid, {
    audio: { url: audioUrl },
    mimetype: "audio/mp4",
    ptt: ptt !== false
  })
  res.json({ ok: true })
})

app.post("/sessions/:sessionId/send/document", async (req, res) => {
  const { sessionId } = req.params
  const { jid, number, documentUrl, fileName, mimetype, caption } = req.body || {}
  if (!jid && !number) return res.status(400).json({ error: "Informe jid ou number" })
  if (!documentUrl) return res.status(400).json({ error: "Informe documentUrl" })

  const sock = await ensureSession(sessionId)
  const targetJid = normalizeToJid(number, jid)

  await sock.sendMessage(targetJid, {
    document: { url: documentUrl },
    fileName: fileName || "arquivo",
    mimetype: mimetype || "application/octet-stream",
    caption: caption || ""
  })
  res.json({ ok: true })
})

app.post("/sessions/:sessionId/read", async (req, res) => {
  const { sessionId } = req.params
  const { jid, messageIds } = req.body || {}
  if (!jid || !Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: "Informe jid e messageIds" })
  }

  const sock = await ensureSession(sessionId)
  const keys = messageIds.map((id) => ({ remoteJid: jid, fromMe: false, id }))
  await sock.readMessages(keys)
  res.json({ ok: true })
})

app.post("/sessions/:sessionId/presence", async (req, res) => {
  const { sessionId } = req.params
  const { jid, state } = req.body || {}
  if (!jid) return res.status(400).json({ error: "Informe jid" })

  const sock = await ensureSession(sessionId)
  await sock.sendPresenceUpdate(state || "available", jid)
  res.json({ ok: true })
})

app.get("/sessions/:sessionId/groups", async (req, res) => {
  const { sessionId } = req.params
  const sock = await ensureSession(sessionId)
  const groups = await sock.groupFetchAllParticipating()
  res.json({ groups })
})

app.get("/sessions/:sessionId/group-metadata", async (req, res) => {
  const { sessionId } = req.params
  const jid = String(req.query.jid || "")
  if (!jid) return res.status(400).json({ error: "Informe jid" })

  const sock = await ensureSession(sessionId)
  const md = await sock.groupMetadata(jid)
  res.json({ metadata: md })
})

app.get("/sessions/:sessionId/profile-pic", async (req, res) => {
  const { sessionId } = req.params
  const jid = String(req.query.jid || "")
  if (!jid) return res.status(400).json({ error: "Informe jid" })

  const sock = await ensureSession(sessionId)
  const url = await sock.profilePictureUrl(jid, "image").catch(() => null)
  res.json({ url })
})

httpServer = app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT)
})

httpServer.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true
      ws.on("pong", () => { ws.isAlive = true })
      wss.emit("connection", ws, req)
    })
  } else {
    socket.destroy()
  }
})
app.get("/status", (req, res) => {
  const sessions = listSessions()

  if (!sessions.length) {
    return res.json({
      ok: true,
      connected: false,
      sessions: []
    })
  }

  const first = sessions[0]

  res.json({
    ok: true,
    connected: first.status === "Conectado",
    sessionId: first.sessionId,
    status: first.status,
    sessions
  })
})

app.get("/messages", (req, res) => {
  const sessionIds = Object.keys(mem.sessions || {})

  if (!sessionIds.length) {
    return res.json({
      ok: true,
      messages: []
    })
  }

  const sessionId = sessionIds[0]
  const limit = Math.min(Number(req.query.limit || 200), 2000)
  const arr = mem.messages[sessionId] || []

  res.json({
    ok: true,
    sessionId,
    total: arr.length,
    messages: arr.slice(-limit)
  })
})
