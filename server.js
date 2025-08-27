import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/widget", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "widget.html"));
});

const PORT = process.env.PORT || 3000;
// Принимаем вопрос и стримим ответ модели
app.post('/api/chat', express.json(), async (req, res) => {
  try {
    const { messages, attachmentId } = req.body || {};
// ...
let attachmentNote = '';
if (attachmentId && attachments.has(attachmentId)) {
  const a = attachments.get(attachmentId);
  attachmentNote = `\n\nВложенный текст (обезличенный, до 8k):\n${a.text}`;
};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }

    // Базовая инструкция помощнику (можно потом усилить)
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

    // Заголовки для Server-Sent Events
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

    // Читаем поток OpenAI и проксируем только текстовые дельты
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
        } catch {
          // пропускаем служебные чанки
        }
      }
    }

    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: 'proxy_error', detail: String(e) })}\n\n`);
    res.end();
  }
});
import multer from 'multer';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';

// Хранилище «во временной памяти»: id -> { text, name, expiresAt }
const attachments = new Map();

// Multer: принимаем один файл, до ~10 МБ
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Вспомогательная функция: аккуратно обрезать текст
function clampText(s, max = 8000) {
  if (!s) return '';
  s = s.replace(/\r/g, '');
  // чуть чистим пробелы
  s = s.replace(/[ \t]+\n/g, '\n').trim();
  return s.length > max ? s.slice(0, max) + '\n...[обрезано]...' : s;
}

// Извлечь текст в зависимости от типа файла
async function extractTextFrom(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.txt')) {
    return file.buffer.toString('utf8');
  }
  if (name.endsWith('.pdf')) {
    const data = await pdf(file.buffer);
    return data.text || '';
  }
  if (name.endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return value || '';
  }
  throw new Error('Неподдерживаемый формат. Разрешены: PDF, DOCX, TXT');
}

// Загрузка файла: возвращаем attachmentId
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const raw = await extractTextFrom(req.file);
    const text = clampText(raw, 8000); // ограничим, чтобы не переполнить промпт

    // простая защита: выкидываем явные ИНН/тел/емейлы, если вдруг остались
    const safe = text
      .replace(/\b\d{10,12}\b/g, '[скрыто]')            // ИНН/СНИЛС-сходные куски
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[скрыто]')
      .replace(/\+?\d[\d \-()]{7,}\d/g, '[скрыто]');

    const id = Math.random().toString(36).slice(2);
    const ttlMs = 1000 * 60 * 15; // 15 минут жизни
    attachments.set(id, { text: safe, name: req.file.originalname, expiresAt: Date.now() + ttlMs });

    // Чистим протухшие
    for (const [key, v] of attachments) {
      if (Date.now() > v.expiresAt) attachments.delete(key);
    }

    return res.json({
      id,
      name: req.file.originalname,
      length: safe.length
    });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
});
app.listen(PORT, () => console.log("Running on :" + PORT));
