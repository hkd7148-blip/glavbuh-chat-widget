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

/* ================== API: ОБЕЗЛИЧИВАНИЕ (ОТКРЫТО) ================== */
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

/* ================== API: РЕГИСТРАЦИЯ (2 ШАГА) ================== */
// Шаг 1 — отправка кода
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
    const expiresAt = Date.now() + 1000 * 60 * 10; // 10 минут
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

// Шаг 2 — проверка кода и выдача токена
app.post('/api/register/verify', express.json(), (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code  = String(req.body?.code  || '').trim();

    if (!isValidEmail(email))        return res.status(400).json({ error: 'E-mail некорректен' });
    if (!/^\d{6}$/.test(code))       return res.status(400).json({ error: 'Код должен быть 6 цифр' });

    const rec = pending.get(email);
    if (!rec)                        return res.status(400).json({ error: 'Код не найден. Запросите новый.' });
    if (Date.now() > rec.expiresAt) { pending.delete(email); return res.status(400).json({ error: 'Срок кода истёк. Запросите новый.' }); }
    if (rec.code !== code)           return res.status(400).json({ error: 'Неверный код' });

    const ttlMs = 1000 * 60 * 60 * 24; // 1 день
    const expiresAt = Date.now() + ttlMs;
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    accounts.set(email, { expiresAt, token, name: rec.name, phone: rec.phone });
    tokens.set(token,   { email, expiresAt });
    pending.delete(email);

    return res.json({ ok: true, email, token, expiresAt });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});

/* ================== СЛУЖЕБНОЕ И СТАТИКА ================== */
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

/* ================== ЗАПУСК ================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on', PORT);
});
