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

// Улучшенная обёртка таймаута с детальной информацией
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

// Функция повтора с экспоненциальной задержкой
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
      
      // Экспоненциальная задержка с jitter
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

// Улучшенный вызов OpenAI с retry и валидацией
async function callOpenAIOnce({ 
  model, 
  messages, 
  temperature = DEFAULT_CONFIG.TEMPERATURE, 
  max_tokens = DEFAULT_CONFIG.MAX_TOKENS,
  timeout = DEFAULT_CONFIG.TIMEOUT_MS
}) {
  // Проверяем API ключ
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY не установлен в переменных окружения');
  }
  
  // Валидация параметров
  validateOpenAIParams({ model, messages, temperature, max_tokens });
  
  // Функция для одного запроса
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
        
        // Специальная обработка разных типов ошибок OpenAI
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
      
      // Проверяем структуру ответа
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
  
  // Выполняем с retry
  return await withRetry(makeRequest);
}

// ИСПРАВЛЕННАЯ функция стриминга SSE (убран await из обычной функции)
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
    // Устанавливаем заголовки SSE, если еще не установлены
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
    
    // Отправляем метаинформацию
    res.write(`data: ${JSON.stringify({ 
      type: 'start',
      totalLength,
      chunkSize 
    })}\n\n`);
    
    // Отправляем текст порциями (БЕЗ await!)
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
      
      // Убираем await и используем обычный setTimeout для задержки
      if (i + chunkSize < text.length) {
        // Синхронная задержка не нужна для SSE
      }
    }
    
    // Финальное сообщение
    res.write(`data: ${JSON.stringify({ 
      type: 'end',
      totalSent,
      completed: true
    })}\n\n`);
    
    res.end();
    
  } catch (error) {
    // Отправляем ошибку через SSE
    try {
      res.write(`data: ${JSON.stringify({ 
        type: 'error',
        error: error.message 
      })}\n\n`);
      res.end();
    } catch {
      // Если не можем отправить ошибку через SSE, логируем
      console.error('Ошибка при SSE стриминге:', error);
    }
  }
}

// Утилита для безопасного JSON.stringify
function safeStringify(obj, maxLength = 1000) {
  try {
    const str = JSON.stringify(obj, null, 2);
    return str.length > maxLength ? str.slice(0, maxLength) + '...[truncated]' : str;
  } catch (error) {
    return `[Ошибка сериализации: ${error.message}]`;
  }
}

// Логгер с уровнями
const logger = {
  info: (message, ...args) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, ...args);
  },
  warn: (message, ...args) => {
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, ...args);
  },
  error: (message, error, ...args) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error, ...args);
  },
  debug: (message, data) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[DEBUG] ${new Date().toISOString()} - ${message}`, safeStringify(data));
    }
  }
};

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
  t = t.replace(/\b\d{2}\s?\d{2}\s?\d{6}\b/g, '[скрыто:паспорт]');         // паспорт РФ
  t = t.replace(/\b\d{3}-\d{3}-\d{3}\s?\d{2}\b/g, '[скрыто:СНИЛС]');        // СНИЛС
  t = t.replace(/\b\d{10,12}\b/g, '[скрыто:ИНН/СНИЛС]');                    // ИНН/СНИЛС цифры
  t = t.replace(/\b\d{13}\b/g, '[скрыто:ОГРН]');                            // ОГРН
  t = t.replace(/\b\d{15}\b/g, '[скрыто:ОГРНИП]');                          // ОГРНИП
  t = t.replace(/\b\d{9}\b/g, '[скрыто:БИК]');                               // БИК
  t = t.replace(/\b(?:\d[ -]?){16,20}\b/g, '[скрыто:счёт/карта]');          // карты/счета
  t = t.replace(/\+?\d[\d\s()-]{7,}\d/g, '[скрыто:тел]');                    // телефоны
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[скрыто:email]');// email
  t = t.replace(/\b(ул\.|улица|пр-т|проспект|пер\.|переулок|д\.|дом|кв\.|квартира)\s+[^\n,;]+/gi, '[скрыто:адрес]');
  t = t.replace(/\b[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}\b/g, '[скрыто:ФИО]'); // грубо ФИО
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
  const from = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  if (!apiKey) throw new Error('RESEND_API_KEY не задан');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, text })
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('Resend error: ' + t);
  }
}

/* ================== АВТОРИЗАЦИЯ (MVP) ================== */
function getTokenInfo(token = '') {
  if (!token) return null;
  const rec = tokens.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) return null;
  return rec;
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
  req.user = { email: info.email, expiresAt: info.expiresAt };
  next();
}

/* ================== API: ЗАГРУЗКА ДЛЯ ЧАТА ================== */
app.post('/api/upload', authRequired, upload.single('file'), async (req, res) => {
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

/* ================== API: ЧАТ ================== */
// Обычный чат
app.post('/api/chat', authRequired, express.json(), async (req, res) => {
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

    const systemPrompt = `Ты — онлайн-помощник главного бухгалтера для РФ. Отвечай кратко и по делу, по-русски.
Если вопрос требует персональных данных — попроси обезличить и предложи инструмент /anonimize/.${attachmentNote}`;

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

// Ансамбль чат - ИСПРАВЛЕНА функция sseStreamText
app.post('/api/chat_plus', authRequired, express.json(), async (req, res) => {
  let headersSent = false;
  
  // Утилита для безопасной отправки SSE заголовков
  const ensureSSEHeaders = () => {
    if (!headersSent) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.flushHeaders?.();
      headersSent = true;
    }
  };
  
  // Утилита для отправки SSE ошибки
  const sendSSEError = (error, code = 'ensemble_error') => {
    try {
      ensureSSEHeaders();
      res.write(`data: ${JSON.stringify({ 
        type: 'error',
        error: code, 
        message: String(error?.message || error),
        timestamp: new Date().toISOString()
      })}\n\n`);
      res.end();
    } catch (writeError) {
      console.error('Ошибка отправки SSE error:', writeError);
      if (!res.headersSent) {
        res.status(500).json({ error: code, message: String(error?.message || error) });
      }
    }
  };

  try {
    const { messages, attachmentId } = req.body || {};
    
    // Валидация входных данных
    if (!Array.isArray(messages) || messages.length === 0) {
      return sendSSEError(new Error('messages должен быть непустым массивом'), 'invalid_input');
    }

    // Проверяем структуру сообщений
    for (const msg of messages) {
      if (!msg.role || !msg.content || typeof msg.content !== 'string') {
        return sendSSEError(new Error('Каждое сообщение должно содержать role и content'), 'invalid_message');
      }
    }

    // Контекст вложения
    let attachmentNote = '';
    if (attachmentId && attachments.has(attachmentId)) {
      const attachment = attachments.get(attachmentId);
      const truncatedText = attachment.text.length > 8000 
        ? attachment.text.slice(0, 8000) + '...[обрезано]'
        : attachment.text;
      attachmentNote = `\n\nВложенный текст (обезличенный, до 8k):\n${truncatedText}`;
    }

    // Конфигурация
    const config = {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      timeout: Number(process.env.ENSEMBLE_TIMEOUT_MS || 15000),
      aggTokens: Number(process.env.ENSEMBLE_AGG_TOKENS || 1000),
      fallbackTimeout: Number(process.env.FALLBACK_TIMEOUT_MS || 10000)
    };

    // Базовый системный промпт
    const baseSystem = `Ты — онлайн-помощник главного бухгалтера для РФ. Отвечай кратко и по делу, по-русски.${attachmentNote}`;

    // Две роли
    const roleA = {
      name: 'Нормативно-правовой',
      system: `${baseSystem}\n\nРОЛЬ: Нормативно-правовой консультант\nФОКУС: Точность, ссылки на НК РФ/ПБУ/ФЗ, формулы расчётов.`,
      temperature: 0.2
    };

    const roleB = {
      name: 'Практико-прикладной',
      system: `${baseSystem}\n\nРОЛЬ: Практический консультант\nФОКУС: Реальные кейсы, ошибки, рекомендации по процедурам.`,
      temperature: 0.4
    };

    // Отправляем начальный статус
    ensureSSEHeaders();
    res.write(`data: ${JSON.stringify({ 
      type: 'status',
      message: 'Запускаем ансамбль экспертов...',
      stage: 'init'
    })}\n\n`);

    // Готовим запросы
    const createRequest = (role) => callOpenAIOnce({
      model: config.model,
      temperature: role.temperature,
      max_tokens: 700,
      timeout: config.timeout,
      messages: [
        { role: 'system', content: role.system },
        ...messages
      ]
    });

    const requestA = createRequest(roleA);
    const requestB = createRequest(roleB);

    // Выполняем параллельно
    const [resultA, resultB] = await Promise.all([
      withTimeout(requestA, config.timeout, 'A'),
      withTimeout(requestB, config.timeout, 'B')
    ]);

    // Собираем результаты
    const validParts = [];
    const errors = [];

    if (resultA.ok && resultA.value?.content) {
      validParts.push({
        role: roleA.name,
        content: resultA.value.content,
        usage: resultA.value.usage
      });
    } else {
      errors.push(`${roleA.name}: ${resultA.error || 'неизвестная ошибка'}`);
    }

    if (resultB.ok && resultB.value?.content) {
      validParts.push({
        role: roleB.name,
        content: resultB.value.content,
        usage: resultB.value.usage
      });
    } else {
      errors.push(`${roleB.name}: ${resultB.error || 'неизвестная ошибка'}`);
    }

    console.log(`Ансамбль: получено ${validParts.length}/2 ответов`, errors.length > 0 ? { errors } : '');

    // Fallback если ничего не получили
    if (validParts.length === 0) {
      res.write(`data: ${JSON.stringify({ 
        type: 'status',
        message: 'Переключаемся на базовый режим...',
        stage: 'fallback'
      })}\n\n`);

      try {
        const fallbackResult = await withTimeout(
          callOpenAIOnce({
            model: config.model,
            temperature: 0.3,
            max_tokens: 800,
            timeout: config.fallbackTimeout,
            messages: [
              { role:
