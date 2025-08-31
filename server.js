import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import mammoth from 'mammoth';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* ================== ХРАНИЛИЩА В ПАМЯТИ (MVP) ================== */
const attachments = new Map(); // id -> { text, name, expiresAt }
const accounts    = new Map(); // email -> { expiresAt, token, name, phone }
const tokens      = new Map(); // token -> { email, expiresAt }
const pending     = new Map(); // email -> { name, phone, code, expiresAt, lastSentAt }

/* ================== СТАТИСТИКА И АДМИНИСТРИРОВАНИЕ ================== */
const userStats = new Map(); // email -> { registeredAt, lastActive, requestCount, isBlocked, blockReason }
const adminUsers = new Set(['admin@glavbuh-chat.ru']); // список админов

/* ================== ЗАГРУЗКА ФАЙЛОВ ================== */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 МБ
});

/* ================== УТИЛИТЫ ================== */

// Конфигурация по умолчанию
const DEFAULT_CONFIG = {
  TIMEOUT_MS: 30000,
  MAX_TOKENS: 700,
  TEMPERATURE: 0.3,
  CHUNK_SIZE: 900,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 1000
};

// Обёртка таймаута
function withTimeout(promise, ms = DEFAULT_CONFIG.TIMEOUT_MS, tag = 'task') {
  if (typeof ms !== 'number' || ms <= 0) {
    throw new Error('Timeout должен быть положительным числом');
  }
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    const timer = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      resolve({ 
        ok: false, 
        tag, 
        error: 'timeout',
        details: {
          timeoutMs: ms,
          elapsedMs: elapsed
        }
      });
    }, ms);
    
    promise.then(
      (value) => {
        clearTimeout(timer);
        const elapsed = Date.now() - startTime;
        resolve({ 
          ok: true, 
          tag, 
          value,
          details: {
            elapsedMs: elapsed
          }
        });
      },
      (error) => {
        clearTimeout(timer);
        const elapsed = Date.now() - startTime;
        resolve({ 
          ok: false, 
          tag, 
          error: String(error?.message || error || 'Unknown error'),
          details: {
            elapsedMs: elapsed,
            originalError: error
          }
        });
      }
    );
  });
}

// Функция повтора
async function withRetry(fn, attempts = DEFAULT_CONFIG.RETRY_ATTEMPTS, baseDelayMs = DEFAULT_CONFIG.RETRY_DELAY_MS) {
  let lastError;
  
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === attempts) {
        throw error;
      }
      
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      
      console.warn(`Попытка ${attempt}/${attempts} неудачна, повтор через ${Math.round(delay)}мс:`, error.message);
    }
  }
  
  throw lastError;
}

// Валидация параметров OpenAI
function validateOpenAIParams({ model, messages, temperature, max_tokens }) {
  if (!model || typeof model !== 'string') {
    throw new Error('Параметр model обязателен и должен быть строкой');
  }
  
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Параметр messages должен быть непустым массивом');
  }
  
  for (const msg of messages) {
    if (!msg.role || !msg.content) {
      throw new Error('Каждое сообщение должно содержать role и content');
    }
  }
  
  if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > 2)) {
    throw new Error('Temperature должен быть числом от 0 до 2');
  }
  
  if (max_tokens !== undefined && (typeof max_tokens !== 'number' || max_tokens <= 0)) {
    throw new Error('max_tokens должен быть положительным числом');
  }
}

// Вызов OpenAI
async function callOpenAIOnce({ 
  model, 
  messages, 
  temperature = DEFAULT_CONFIG.TEMPERATURE, 
  max_tokens = DEFAULT_CONFIG.MAX_TOKENS,
  timeout = DEFAULT_CONFIG.TIMEOUT_MS
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY не установлен в переменных окружения');
  }
  
  validateOpenAIParams({ model, messages, temperature, max_tokens });
  
  const makeRequest = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'OpenAI-Node-Client'
        },
        body: JSON.stringify({ 
          model, 
          messages, 
          temperature, 
          max_tokens, 
          stream: false 
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        let errorDetails = `HTTP ${response.status}`;
        try {
          const errorData = await response.json();
          errorDetails = errorData.error?.message || JSON.stringify(errorData);
        } catch {
          try {
            errorDetails = await response.text();
          } catch {}
        }
        
        if (response.status === 401) {
          throw new Error('Неверный API ключ OpenAI');
        } else if (response.status === 429) {
          throw new Error('Превышен лимит запросов OpenAI');
        } else if (response.status === 500) {
          throw new Error('Внутренняя ошибка OpenAI');
        }
        
        throw new Error(`OpenAI API Error: ${errorDetails}`);
      }
      
      const data = await response.json();
      
      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
        throw new Error('Некорректный ответ от OpenAI: отсутствуют choices');
      }
      
      const content = data.choices[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('Некорректный ответ от OpenAI: отсутствует content');
      }
      
      return {
        content: content.trim(),
        usage: data.usage,
        model: data.model,
        finishReason: data.choices[0]?.finish_reason
      };
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error(`Таймаут запроса к OpenAI (${timeout}мс)`);
      }
      
      throw error;
    }
  };
  
  return await withRetry(makeRequest);
}

// Функция стриминга SSE
function sseStreamText(res, text, chunkSize = DEFAULT_CONFIG.CHUNK_SIZE) {
  if (!res || typeof res.write !== 'function') {
    throw new Error('Некорректный объект response');
  }
  
  if (typeof text !== 'string') {
    throw new Error('Текст должен быть строкой');
  }
  
  if (typeof chunkSize !== 'number' || chunkSize <= 0) {
    chunkSize = DEFAULT_CONFIG.CHUNK_SIZE;
  }
  
  try {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });
    }
    
    let totalSent = 0;
    const totalLength = text.length;
    
    res.write(`data: ${JSON.stringify({ 
      type: 'start',
      totalLength,
      chunkSize 
    })}\n\n`);
    
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      totalSent += chunk.length;
      
      const progress = Math.round((totalSent / totalLength) * 100);
      
      res.write(`data: ${JSON.stringify({ 
        type: 'chunk',
        delta: chunk,
        progress,
        chunkIndex: Math.floor(i / chunkSize),
        totalSent
      })}\n\n`);
    }
    
    res.write(`data: ${JSON.stringify({ 
      type: 'end',
      totalSent,
      completed: true
    })}\n\n`);
    
    res.end();
    
  } catch (error) {
    try {
      res.write(`data: ${JSON.stringify({ 
        type: 'error',
        error: error.message 
      })}\n\n`);
      res.end();
    } catch {
      console.error('Ошибка при SSE стриминге:', error);
    }
  }
}

// Вспомогательные функции
function clampText(s, max = 8000) {
  if (!s) return '';
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t]+\n/g, '\n').trim();
  return s.length > max ? s.slice(0, max) + '\n...[обрезано]...' : s;
}

function getCookie(req, name) {
  const h = req.headers.cookie || '';
  const m = h.match(new RegExp('(?:^|; )' + name.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

async function extractPdfText(buffer) {
  const loadingTask = pdfjs.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  let out = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map(it => (it.str || '')).join(' ');
    out += text + '\n';
  }
  return out;
}

async function extractTextFrom(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.txt'))  return file.buffer.toString('utf8');
  if (name.endsWith('.pdf'))  return await extractPdfText(file.buffer);
  if (name.endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return value || '';
  }
  throw new Error('Неподдерживаемый формат. Разрешены: PDF, DOCX, TXT');
}

function redactPII(text) {
  if (!text) return '';
  let t = text;
  t = t.replace(/\b\d{2}\s?\d{2}\s?\d{6}\b/g, '[скрыто:паспорт]');
  t = t.replace(/\b\d{3}-\d{3}-\d{3}\s?\d{2}\b/g, '[скрыто:СНИЛС]');
  t = t.replace(/\b\d{10,12}\b/g, '[скрыто:ИНН/СНИЛС]');
  t = t.replace(/\b\d{13}\b/g, '[скрыто:ОГРН]');
  t = t.replace(/\b\d{15}\b/g, '[скрыто:ОГРНИП]');
  t = t.replace(/\b\d{9}\b/g, '[скрыто:БИК]');
  t = t.replace(/\b(?:\d[ -]?){16,20}\b/g, '[скрыто:счёт/карта]');
  t = t.replace(/\+?\d[\d\s()-]{7,}\d/g, '[скрыто:тел]');
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[скрыто:email]');
  t = t.replace(/\b(ул\.|улица|пр-т|проспект|пер\.|переулок|д\.|дом|кв\.|квартира)\s+[^\n,;]+/gi, '[скрыто:адрес]');
  t = t.replace(/\b[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}\b/g, '[скрыто:ФИО]');
  return t;
}

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isValidEmail(e = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.toLowerCase());
}

function isValidPhone(p = '') {
  const digits = (p.match(/\d/g) || []).length;
  return digits >= 10 && digits <= 15;
}

async function sendEmail(to, subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || 'noreply@glavbuh-chat.ru';
  
  console.log('\n=== EMAIL DEBUG START ===');
  console.log('API Key:', apiKey ? `${apiKey.substring(0, 10)}...` : 'НЕТ');
  console.log('From:', from);
  console.log('To:', to);
  console.log('========================\n');
  
  if (!apiKey) throw new Error('RESEND_API_KEY не задан');

  try {
    const payload = { 
      from, 
      to: [to],
      subject, 
      text 
    };
    
    console.log('Payload:', JSON.stringify(payload, null, 2));

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    console.log('Response Status:', resp.status);
    const responseText = await resp.text();
    console.log('Response Body:', responseText);

    if (!resp.ok) {
      throw new Error('Resend API error: ' + responseText);
    }

    const result = JSON.parse(responseText);
    console.log('Email sent successfully:', result.id);
    
    return result;

  } catch (error) {
    console.error('Email sending failed:', error);
    throw error;
  }
}

/* ================== АВТОРИЗАЦИЯ ================== */
function getTokenInfo(token = '') {
  if (!token) return null;
  const rec = tokens.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) return null;
  return rec;
}

// Middleware для отслеживания активности пользователей
function trackUserActivity(req, res, next) {
  if (req.user?.email) {
    const email = req.user.email;
    const stats = userStats.get(email) || {
      registeredAt: Date.now(),
      lastActive: Date.now(),
      requestCount: 0,
      isBlocked: false,
      blockReason: null
    };
    
    stats.lastActive = Date.now();
    stats.requestCount++;
    userStats.set(email, stats);
  }
  next();
}

function authRequired(req, res, next) {
  const token = req.headers['x-gb-token'] || '';
  const info = getTokenInfo(String(token));
  if (!info) {
    return res.status(401).json({
      error: 'auth_required',
      message: 'Доступ к онлайн-помощнику только после регистрации или продления.'
    });
  }
  
  // Проверка блокировки пользователя
  const stats = userStats.get(info.email);
  if (stats?.isBlocked) {
    return res.status(403).json({
      error: 'user_blocked',
      message: stats.blockReason || 'Ваш аккаунт заблокирован администратором'
    });
  }
  
  req.user = { email: info.email, expiresAt: info.expiresAt };
  next();
}

/* ================== АДМИНСКИЕ API ================== */

// Проверка админских прав
function adminRequired(req, res, next) {
  const token = req.headers['x-gb-token'] || '';
  const info = getTokenInfo(String(token));
  
  if (!info || !adminUsers.has(info.email)) {
    return res.status(403).json({ error: 'admin_access_required' });
  }
  
  req.admin = { email: info.email };
  next();
}

// Статистика пользователей
app.get('/api/admin/users', adminRequired, (req, res) => {
  const users = [];
  for (const [email, account] of accounts) {
    const stats = userStats.get(email) || {};
    users.push({
      email,
      name: account.name,
      phone: account.phone,
      registeredAt: stats.registeredAt || account.expiresAt - (24*60*60*1000),
      lastActive: stats.lastActive,
      requestCount: stats.requestCount || 0,
      isBlocked: stats.isBlocked || false,
      blockReason: stats.blockReason,
      tokenExpiresAt: account.expiresAt
    });
  }
  
  // Сортируем по последней активности
  users.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  
  res.json({
    total: users.length,
    active: users.filter(u => !u.isBlocked).length,
    blocked: users.filter(u => u.isBlocked).length,
    users
  });
});

// Блокировка/разблокировка пользователя
app.post('/api/admin/users/:email/block', adminRequired, express.json(), (req, res) => {
  const { email } = req.params;
  const { block, reason } = req.body;
  
  if (!accounts.has(email)) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  const stats = userStats.get(email) || {};
  stats.isBlocked = Boolean(block);
  stats.blockReason = block ? (reason || 'Заблокирован администратором') : null;
  userStats.set(email, stats);
  
  res.json({
    email,
    isBlocked: stats.isBlocked,
    blockReason: stats.blockReason
  });
});

// Статистика системы
app.get('/api/admin/stats', adminRequired, (req, res) => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  
  let activeToday = 0;
  let totalRequests = 0;
  
  for (const stats of userStats.values()) {
    if (stats.lastActive && (now - stats.lastActive) < day) {
      activeToday++;
    }
    totalRequests += stats.requestCount || 0;
  }
  
  res.json({
    totalUsers: accounts.size,
    activeToday,
    totalRequests,
    pendingRegistrations: pending.size,
    attachmentsCount: attachments.size
  });
});

/* ================== API ROUTES ================== */

// Загрузка файлов
app.post('/api/upload', authRequired, trackUserActivity, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    const raw = await extractTextFrom(req.file);
    const text = clampText(raw, 8000);

    const safe = text
      .replace(/\b\d{10,12}\b/g, '[скрыто]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[скрыто]')
      .replace(/\+?\d[\d \-()]{7,}\d/g, '[скрыто]');

    const id = Math.random().toString(36).slice(2);
    const ttlMs = 1000 * 60 * 15;
    attachments.set(id, { text: safe, name: req.file.originalname, expiresAt: Date.now() + ttlMs });

    for (const [key, v] of attachments) if (Date.now() > v.expiresAt) attachments.delete(key);

    return res.json({ id, name: req.file.originalname, length: safe.length });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});

// Обычный чат
app.post('/api/chat', authRequired, trackUserActivity, express.json(), async (req, res) => {
  try {
    const { messages, attachmentId } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }

    let attachmentNote = '';
    if (attachmentId && attachments.has(attachmentId)) {
      const a = attachments.get(attachmentId);
      attachmentNote = `\n\nВложенный текст (обезличенный, до 8k):\n${a.text}`;
    }

    const systemPrompt = `Ты — онлайн-помощник главного бухгалтера для РФ. Отвечай кратко и по делу, по-русски.${attachmentNote}`;

    const body = {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      temperature: 0.3,
      max_tokens: 700
    };

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text();
      res.write(`data: ${JSON.stringify({ error: 'upstream_error', detail: errText })}\n\n`);
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const chunks = buf.split('\n\n');
      buf = chunks.pop() || '';
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          return res.end();
        }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        } catch {}
      }
    }

    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: 'proxy_error', detail: String(e) })}\n\n`);
    res.end();
  }
});

// Ансамбль чат
app.post('/api/chat_plus', authRequired, trackUserActivity, express.json(), async (req, res) => {
  try {
    const { messages, attachmentId } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }

    let attachmentNote = '';
    if (attachmentId && attachments.has(attachmentId)) {
      const a = attachments.get(attachmentId);
      attachmentNote = `\n\nВложенный текст (обезличенный, до 8k):\n${a.text}`;
    }

    const baseSystem = `Ты — онлайн-помощник главного бухгалтера для РФ. Отвечай кратко и по делу, по-русски.${attachmentNote}`;
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    
    // Простая версия без ансамбля
    const result = await callOpenAIOnce({
      model,
      temperature: 0.3,
      max_tokens: 700,
      messages: [
        { role: 'system', content: baseSystem },
        ...messages
      ]
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    sseStreamText(res, result.content);

  } catch (e) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ error: 'ensemble_error', detail: String(e?.message || e) })}\n\n`);
    res.end();
  }
});

// Обезличивание
app.post('/api/anon', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    const raw = await extractTextFrom(req.file);
    const trimmed = clampText(raw, 20000);
    const safe = redactPII(trimmed);

    const base = (req.file.originalname || 'document').replace(/\.[^.]+$/, '');
    const fname = `${base}-anon.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
    return res.send(safe);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});

// Регистрация - отправка кода
app.post('/api/register/init', express.json(), async (req, res) => {
  try {
    const name  = String(req.body?.name  || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!name || name.length < 3)  return res.status(400).json({ error: 'Укажите ФИО' });
    if (!isValidPhone(phone))      return res.status(400).json({ error: 'Укажите корректный телефон' });
    if (!isValidEmail(email))      return res.status(400).json({ error: 'Укажите корректный e-mail' });

    const old = pending.get(email);
    if (old && Date.now() - (old.lastSentAt || 0) < 60000) {
      return res.status(429).json({ error: 'Код уже отправлен. Попробуйте через минуту.' });
    }

    const code = genCode();
    const expiresAt = Date.now() + 1000 * 60 * 10;
    pending.set(email, { name, phone, code, expiresAt, lastSentAt: Date.now() });

    const subject = 'Код подтверждения — Ваш ГлавБух';
    const text = `Здравствуйте, ${name}!\n\nВаш код подтверждения: ${code}\nСрок действия: 10 минут.\n\nЕсли вы не запрашивали код, просто игнорируйте это письмо.`;

    await sendEmail(email, subject, text);

    for (const [k, v] of pending) if (Date.now() > v.expiresAt) pending.delete(k);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});

// Регистрация - проверка кода
app.post('/api/register/verify', express.json(), (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code  = String(req.body?.code  || '').trim();

    if (!isValidEmail(email)) return res.status(400).json({ error: 'E-mail некорректен' });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Код должен быть 6 цифр' });

    const rec = pending.get(email);
    if (!rec) return res.status(400).json({ error: 'Код не найден. Запросите новый.' });
    if (Date.now() > rec.expiresAt) {
      pending.delete(email);
      return res.status(400).json({ error: 'Срок кода истёк. Запросите новый.' });
    }
    if (rec.code !== code) return res.status(400).json({ error: 'Неверный код' });

    const ttlMs = 1000 * 60 * 60 * 24;
    const expiresAt = Date.now() + ttlMs;
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    accounts.set(email, { expiresAt, token, name: rec.name, phone: rec.phone });
    tokens.set(token, { email, expiresAt });
    pending.delete(email);
    
    // Инициализируем статистику нового пользователя
    userStats.set(email, {
      registeredAt: Date.now(),
      lastActive: Date.now(),
      requestCount: 0,
      isBlocked: false,
      blockReason: null
    });

    return res.json({ ok: true, email, token, expiresAt });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});

// Здоровье
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Статика
app.use(express.static(path.join(__dirname, 'public')));

// Виджет
app.get('/widget', (req, res) => {
  const token = getCookie(req, 'gb_token');
  const info = token ? tokens.get(token) : null;
  const valid = info && Date.now() < info.expiresAt;

  if (!valid) {
    return res.send(`
      <!doctype html>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Доступ к чату</title>
      <style>
        body{margin:0;background:#f7f8fb;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#111827}
        .wrap{max-width:640px;margin:0 auto;padding:24px}
        .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px}
        a.button{display:inline-block;padding:10px 16px;border-radius:10px;background:#10B981;color:#fff;text-decoration:none;font-weight:700}
        .muted{font-size:13px;color:#6B7280}
      </style>
      <div class="wrap">
        <div class="card">
          <h1 style="margin:0 0 6px;color:#1E3A8A;font-size:20px">Доступ только для зарегистрированных</h1>
          <p class="muted">Чтобы открыть чат онлайн-помощника, пройдите регистрацию и подтвердите e-mail. Это займёт минуту.</p>
          <p><a class="button" href="/register">Зарегистрироваться</a></p>
        </div>
      </div>
    `);
  }

  res.sendFile(path.join(__dirname, 'public', 'widget.html'));
});

app.get('/anon', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'anon.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/* ================== ЗАПУСК ================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on', PORT);
});
