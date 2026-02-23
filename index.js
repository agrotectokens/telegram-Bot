const express    = require('express');
const axios      = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT }    = require('google-auth-library');

const app  = express();
app.use(express.json());

const TELEGRAM_TOKEN = '7637448101:AAH1cv31WXt6-A0IrPcwC-KdKJap6D7jjh0';
const GROQ_API_KEY   = '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';
const SPREADSHEET_ID = '1NVvOOP3H3vAvE8uwGafXUnXoqMz-UCJtwLkk0rGTB5A';
const TG_API        = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── Memoria en RAM (simple, sin base de datos) ──────────
const memoria = {}; // { chatId: { lang, visto, optout, historial } }

function getUser(chatId) {
  if (!memoria[chatId]) {
    memoria[chatId] = { lang: 'es', visto: false, optout: false, historial: [] };
  }
  return memoria[chatId];
}

// ── Prompts ──────────────────────────────────────────────
function getPrompt(lang) {
  if (lang === 'en') return 'You are Karla, sales advisor for Corporacion Agrotec Peru. BUSINESS: Premium cacao plots in Peru. Up to S/.30,000/year. We manage everything. Real land, secure titles. From $1 via Agrotec tokenization on Polygon. STRICT RULES: Maximum 2 short sentences. Only 1 emoji. End with one short question. NEVER guarantee returns. ALWAYS reply in English.';
  if (lang === 'pt') return 'Voce e Karla, consultora da Corporacion Agrotec Peru. NEGOCIO: Parcelas de cacau premium no Peru. Ate S/.30.000 por ano. Nos gerenciamos tudo. Terra real com titulos. A partir de US$1 via tokenizacao Agrotec no Polygon. REGRAS: Maximo 2 frases curtas. Apenas 1 emoji. Termine com uma pergunta curta. NUNCA garanta retornos. SEMPRE responda em Portugues.';
  return 'Eres Karla, asesora de Corporacion Agrotec Peru. NEGOCIO: Parcelas de cacao premium en Peru. Hasta S/.30,000 al anio. Manejamos todo. Tierra real con titulos. Desde $1 via tokenizacion Agrotec en Polygon. REGLAS: Maximo 2 oraciones cortas. Solo 1 emoji. Termina con una pregunta corta. NUNCA garantices ganancias. RESPONDE siempre en Espanol.';
}

// ── Mensajes fijos ───────────────────────────────────────
function getBienvenida(lang, nombre) {
  if (lang === 'en') return `Hi ${nombre}! I'm Karla from Corporacion Agrotec Peru 🌿 We have premium cacao plots generating up to S/.30,000/year and we manage everything. Want to know how it works?`;
  if (lang === 'pt') return `Oi ${nombre}! Sou Karla da Corporacion Agrotec Peru 🌿 Temos parcelas de cacau premium que geram ate S/.30.000 por ano e nos cuidamos de tudo. Quer saber como funciona?`;
  return `Hola ${nombre}! Soy Karla de Corporacion Agrotec Peru 🌿 Tenemos parcelas de cacao premium que generan hasta S/.30,000 al anio y nosotros manejamos todo. Te cuento como funciona?`;
}

// ── Telegram ─────────────────────────────────────────────
async function sendMessage(chatId, text) {
  await axios.post(`${TG_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  }).catch(e => console.error('sendMessage error:', e.message));
}

async function sendSelector(chatId) {
  await axios.post(`${TG_API}/sendMessage`, {
    chat_id: chatId,
    text: 'Elige tu idioma / Choose your language / Escolha seu idioma:',
    reply_markup: {
      inline_keyboard: [[
        { text: 'Espanol',   callback_data: 'lang_es' },
        { text: 'English',   callback_data: 'lang_en' },
        { text: 'Portugues', callback_data: 'lang_pt' }
      ]]
    }
  }).catch(e => console.error('sendSelector error:', e.message));
}

async function answerCB(id) {
  await axios.post(`${TG_API}/answerCallbackQuery`, { callback_query_id: id })
    .catch(e => console.error('answerCB error:', e.message));
}

// ── Groq ─────────────────────────────────────────────────
async function llamarGroq(lang, historial) {
  const msgs = [{ role: 'system', content: getPrompt(lang) }, ...historial.slice(-4)];
  try {
    const resp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', temperature: 0.7, max_tokens: 80, messages: msgs },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } }
    );
    return resp.data.choices[0].message.content.trim();
  } catch(e) {
    console.error('Groq error:', e.message);
    return null;
  }
}

// ── Google Sheets (opcional) ─────────────────────────────
async function logSheet(chatId, nombre, lang, texto, respuesta) {
  try {
    // Solo loguea en consola por ahora — Sheets requiere credenciales OAuth
    console.log(`[CONV] ${nombre}(${chatId}) [${lang}]: ${texto} -> ${respuesta.substring(0,50)}`);
  } catch(e) {
    console.error('Sheet error:', e.message);
  }
}

// ── Webhook ──────────────────────────────────────────────
const procesados = new Set();

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder a Telegram PRIMERO

  const update = req.body;
  if (!update) return;

  // Evitar duplicados
  if (update.update_id) {
    if (procesados.has(update.update_id)) return;
    procesados.add(update.update_id);
    if (procesados.size > 1000) {
      const first = procesados.values().next().value;
      procesados.delete(first);
    }
  }

  // Descartar updates viejos (más de 30 segundos)
  const ts = update.message?.date || update.callback_query?.message?.date || 0;
  if (ts > 0 && (Math.floor(Date.now() / 1000) - ts) > 30) return;

  // BLOQUE A: botón de idioma
  if (update.callback_query) {
    const cb     = update.callback_query;
    const chatId = cb.message.chat.id.toString();
    const nombre = cb.from.first_name || 'Inversor';
    await answerCB(cb.id);
    if (['lang_es','lang_en','lang_pt'].includes(cb.data)) {
      const lang = cb.data.replace('lang_', '');
      const user = getUser(chatId);
      user.lang  = lang;
      user.visto = true;
      await sendMessage(chatId, getBienvenida(lang, nombre));
    }
    return;
  }

  // BLOQUE B: mensaje de texto
  if (!update.message?.text) return;

  const msg    = update.message;
  const chatId = msg.chat.id.toString();
  const texto  = msg.text.trim();
  const nombre = msg.from.first_name || 'Inversor';
  const textoU = texto.toUpperCase();
  const user   = getUser(chatId);
  const lang   = user.lang;

  // /start o primera vez
  if (texto === '/start' || !user.visto) {
    user.visto = true;
    await sendSelector(chatId);
    return;
  }

  // /lang
  if (['/LANG','/IDIOMA','/LANGUAGE'].includes(textoU)) {
    await sendSelector(chatId);
    return;
  }

  // opt-out
  const outWords = { es: ['STOP','DETENER','NO MAS'], en: ['STOP','UNSUBSCRIBE'], pt: ['STOP','CANCELAR'] };
  if (outWords[lang].some(w => textoU.includes(w))) {
    user.optout = true;
    const msgs  = { es: `Entendido ${nombre}! Te saque de mi lista. Escribe VOLVER cuando quieras.`, en: `Understood ${nombre}! Removed from my list. Write COME BACK anytime.`, pt: `Entendido ${nombre}! Removido da lista. Escreva VOLTAR quando quiser.` };
    await sendMessage(chatId, msgs[lang]);
    return;
  }

  // opt-in
  if (user.optout) {
    const inWords = { es: ['VOLVER','PONME'], en: ['COME BACK','ADD ME'], pt: ['VOLTAR','ADICIONAR'] };
    if (inWords[lang].some(w => textoU.includes(w))) {
      user.optout = false;
      const msgs  = { es: `Que alegria que vuelvas ${nombre}! En que te puedo ayudar?`, en: `Welcome back ${nombre}! How can I help you?`, pt: `Que bom ter voce de volta ${nombre}! Como posso ajudar?` };
      await sendMessage(chatId, msgs[lang]);
    }
    return;
  }

  // respuesta IA
  user.historial.push({ role: 'user', content: texto });
  const respuesta = await llamarGroq(lang, user.historial) || 'Un momento, enseguida te respondo!';
  user.historial.push({ role: 'assistant', content: respuesta });
  if (user.historial.length > 8) user.historial = user.historial.slice(-8);

  await logSheet(chatId, nombre, lang, texto, respuesta);
  await sendMessage(chatId, respuesta);
});

app.get('/', (req, res) => res.send('Karla Bot - Agrotec Peru - OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console
