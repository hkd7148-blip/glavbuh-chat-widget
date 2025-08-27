import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import mammoth from 'mammoth';
// PDF: pdfjs-dist для извлечения текста
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// === Простейшие аккаунты/токены в памяти (MVP) ===
const accounts = new Map(); // email -> { expiresAt: number, token: string }
const tokens   = new Map(); // token -> { email: string, expiresAt: number }

function isValidEmail(e='') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.toLowerCase());
}

// === Хранилище вложений (в памяти) ===
const attachments = new Map();

// Настройка загрузки файлов (до 10 МБ)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// === Вспомогательные функции ===
function clampText(s, max = 8000) {
  if (!s) return '';
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t]+\n/g, '\n').trim();
  return s.length > max ? s.slice(0, max) + '\n...[обрезано]...' : s;
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
  if (name.endsWith('.txt')) {
    return file.buffer.toString('utf8');
  }
  if (name.endsWith('.pdf')) {
    return await extractPdfText(file.buffer);
  }
  if (name.endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return value || '';
  }
  throw new Error('Неподдерживаемый формат. Разрешены: PDF, DOCX, TXT');
}

// === Функция маскирования PII ===
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

// === Маршрут: загрузка файла ===
app.post('/api/upload', upload.single('file'), async (req, res) => {
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

    for (const [key, v] of attachments) {
      if (Date.now() > v.expiresAt) attachments.delete(key);
    }

    return res.json({ id, name: req.file.originalname, length: safe.length });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});

// === Маршрут: чат ===
app.post('/api/chat', express.json(), async (req, res) => {
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
Если вопрос требует персональных данных — попроси обезличить и предложи инструмент /anonimize/.1. Назначение чат-бота
Чат-бот — интеллектуальный помощник, созданный для поддержки главных бухгалтеров и сотрудников бухгалтерии. Он предоставляет консультации по вопросам налогообложения, учета и законодательства.
Чат-бот помогает:
Разъяснять требования законодательства;
Подсказывать порядок заполнения отчетности;
Выполнять расчеты (налоги, взносы, проценты);
Отвечать на вопросы по проводкам, НДС, УСН, учету доходов и расходов.
Он не интегрируется с бухгалтерскими программами (1С, SAP), базами данных и порталами ФНС, ПФР и др.
2. Возможности чат-бота
Консультации по законодательству — налоги, сборы, сроки сдачи, изменения в законах.
Помощь с расчетами — налоги, взносы, штрафы и пени на основе введённых данных.
Подсказки по отчетности — формы (НДС, 3-НДФЛ, отчеты в ФСС).
Разъяснение терминов — бухгалтерские термины и учетные процедуры.
Примеры проводок — типовые бухгалтерские проводки.
Актуальность — обновление информации (по состоянию на 30 июля 2025 года).
2. Формат общения:
Пишите на русском в свободной форме. Примеры:
«Как рассчитать НДС с аванса?»
«Срок сдачи декларации по УСН за 2025 год?»
«Проводки по аренде помещения».
3. Ввод данных для расчетов:
Указывайте точные параметры (доход, ставка налога, период).
Пример: «Налог на прибыль при доходе 1 200 000 руб. и расходах 800 000 руб.»
4. Рекомендации
Формулируйте запросы чётко (указывайте тип организации, налоговый режим).
Уточняйте актуальность, если речь о законодательстве.
Не передавайте ИНН, паспортные данные или конфиденциальную информацию.
5. Ограничения
Нет интеграции с программами или порталами.
Рекомендательный характер ответов — бот не несёт ответственности за принятые решения.
Не решает сложные задачи — аудит и т.п.
Язык общения — русский.
6. Примеры сценариев
Вопрос о сроках
Пользователь: «Когда сдавать 6-НДФЛ в 2025 году?»
Бот: «1 кв. — до 25.04.2025, полугодие — до 25.07.2025, 9 мес. — до 25.10.2025, за год — до 25.02.2026».
Расчет налога
Пользователь: «Рассчитай УСН 6% при доходе 500 000 руб.»
Бот: «Налог = 30 000 руб. Возможно уменьшение на взносы».
Проводки
Пользователь: «Начисление зарплаты»
Бот:
Дт 20 (26, 44) Кт 70 — начислена зарплата
Дт 70 Кт 68 — удержан НДФЛ
Дт 20 (26, 44) Кт 69 — начислены взносы
7. Техническая поддержка
Если бот не понимает запрос — переформулируйте.
При необходимости обратитесь в поддержку через сайт или email.
8. Обновления
Информация актуальна на 30 июля 2025 года. Уточняйте при необходимости.
9. Заключение
Чат-бот — удобный инструмент для быстрого решения типовых задач главного бухгалтера. Он экономит время. Используй вложенный текст ниже как контекст, если он релевантен.${attachmentNote}`;
    // Готовим запрос к OpenAI (в Node 18 fetch доступен без доп. пакетов)
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

// === Маршрут: обезличивание ===
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
// === Регистрация: выдаём 1 день trial и токен ===
app.post('/api/register', express.json(), (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Укажите корректный e-mail' });
    }

    // 1 день тест-доступа
    const ttlMs = 1000 * 60 * 60 * 24;
    const expiresAt = Date.now() + ttlMs;

    // Генерим токен
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    // Сохраняем в память (MVP)
    accounts.set(email, { expiresAt, token });
    tokens.set(token, { email, expiresAt });

    // Чистим протухшие
    for (const [t, v] of tokens) if (Date.now() > v.expiresAt) tokens.delete(t);
    for (const [e, v] of accounts) if (Date.now() > v.expiresAt) accounts.delete(e);

    return res.json({ ok: true, email, token, expiresAt });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});


// === Служебные маршруты ===
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/widget', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'widget.html'));
});

app.get('/anon', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'anon.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// === Запуск ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on', PORT);
});
