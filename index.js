// ========================================
// ENDPOINT: GET /history
// Retorna todas as mensagens armazenadas
// ========================================
app.get('/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 0;
    const offset = parseInt(req.query.offset) || 0;

    let messages = [...messageStore];

    // Ordenar por timestamp (mais antigas primeiro)
    messages.sort((a, b) => {
      const tsA = typeof a.timestamp === 'number' ? a.timestamp : 0;
      const tsB = typeof b.timestamp === 'number' ? b.timestamp : 0;
      return tsA - tsB;
    });

    // Paginação
    if (offset > 0) {
      messages = messages.slice(offset);
    }
    if (limit > 0) {
      messages = messages.slice(0, limit);
    }

    res.json({
      total: messageStore.length,
      returned: messages.length,
      offset,
      limit,
      messages,
    });
  } catch (err) {
    console.error('Erro no /history:', err.message);
    res.status(500).json({ error: 'Falha ao buscar histórico' });
  }
});

// ========================================
// ENDPOINT: GET /chats
// Retorna lista de contatos/conversas únicas
// ========================================
app.get('/chats', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    // Agrupar mensagens por contato
    const chatMap = {};

    for (const msg of messageStore) {
      const chatId = msg.from || msg.chatId || 'unknown';
      if (chatId.includes('status@broadcast')) continue;

      if (!chatMap[chatId]) {
        chatMap[chatId] = {
          id: chatId,
          name: msg.name || msg.pushName || chatId,
          lastMessage: '',
          lastTimestamp: 0,
          messageCount: 0,
          unreadCount: 0,
        };
      }

      const chat = chatMap[chatId];
      chat.messageCount++;

      const ts = msg.timestamp || 0;
      if (ts > chat.lastTimestamp) {
        chat.lastTimestamp = ts;
        chat.lastMessage = msg.text || msg.body || msg.message || '';
        if (msg.name || msg.pushName) {
          chat.name = msg.name || msg.pushName;
        }
      }

      if (!msg.fromMe) {
        chat.unreadCount++;
      }
    }

    // Converter para array e ordenar por mais recente
    let chats = Object.values(chatMap);
    chats.sort((a, b) => b.lastTimestamp - a.lastTimestamp);

    const total = chats.length;

    // Paginação
    chats = chats.slice(offset, offset + limit);

    res.json({
      total,
      returned: chats.length,
      offset,
      limit,
      chats,
    });
  } catch (err) {
    console.error('Erro no /chats:', err.message);
    res.status(500).json({ error: 'Falha ao buscar conversas' });
  }
});

// ========================================
// ENDPOINT: GET /chat/:chatId
// Retorna mensagens de uma conversa específica
// ========================================
app.get('/chat/:chatId', (req, res) => {
  try {
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    // Filtrar mensagens desse contato
    let messages = messageStore.filter((msg) => {
      const msgChatId = msg.from || msg.chatId || '';
      // Comparar sem @s.whatsapp.net e sem caracteres especiais
      const clean = msgChatId.replace(/@s\.whatsapp\.net$/, '').replace(/\D/g, '');
      const cleanParam = chatId.replace(/\D/g, '');
      return clean === cleanParam || clean.endsWith(cleanParam) || cleanParam.endsWith(clean);
    });

    // Ordenar por timestamp
    messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const total = messages.length;

    // Paginação
    messages = messages.slice(offset, offset + limit);

    res.json({
      chatId,
      total,
      returned: messages.length,
      offset,
      limit,
      messages,
    });
  } catch (err) {
    console.error('Erro no /chat/:chatId:', err.message);
    res.status(500).json({ error: 'Falha ao buscar mensagens do contato' });
  }
});

// ========================================
// ENDPOINT: GET /search
// Busca mensagens por texto ou número
// ========================================
app.get('/search', (req, res) => {
  try {
    const query = (req.query.q || '').toLowerCase().trim();
    const limit = parseInt(req.query.limit) || 20;

    if (!query) {
      return res.json({ results: [], total: 0 });
    }

    const results = messageStore.filter((msg) => {
      const text = (msg.text || msg.body || msg.message || '').toLowerCase();
      const from = (msg.from || msg.chatId || '').toLowerCase();
      const name = (msg.name || msg.pushName || '').toLowerCase();
      return text.includes(query) || from.includes(query) || name.includes(query);
    });

    // Mais recentes primeiro
    results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    res.json({
      query,
      total: results.length,
      returned: Math.min(results.length, limit),
      results: results.slice(0, limit),
    });
  } catch (err) {
    console.error('Erro no /search:', err.message);
    res.status(500).json({ error: 'Falha na busca' });
  }
});

// ========================================
// SERVIDOR - DEVE SER A ÚLTIMA LINHA
// ========================================
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
