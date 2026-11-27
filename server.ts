import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { TalkStore } from './server/store.ts';
import {
  analyzeTextbookPagesWithGemini,
  analyzeTextbookPageWithGemini,
  countGeminiTokens,
  formatGeminiError,
  GEMINI_STT_MODEL,
  getGeminiKey,
  planTextbookBatchWithGemini,
  scrapeTextbookUrlsWithTavily,
  streamGeminiChat,
  summarizeWithGemini,
  type TextbookBatchGuidance,
  type TextbookPageInput,
  transcribeWithGemini,
  updateLearnerStateWithGemini,
} from './server/gemini.ts';
import type { ChatMessage, GeminiModel } from './src/types/talk.ts';

const VALID_GEMINI_MODELS = new Set<GeminiModel>([
  'gemini-4-hydrogen',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
]);

function resolveGeminiModel(requested: unknown, fallback: GeminiModel): GeminiModel {
  if (typeof requested === 'string' && VALID_GEMINI_MODELS.has(requested as GeminiModel)) {
    return requested as GeminiModel;
  }
  return fallback;
}

const PORT = 3000;

const store = new TalkStore();
const activeStreams = new Map<string, AbortController>();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const VALID_KV_KEY = /^(note:[a-zA-Z0-9_-]+|questions:[a-zA-Z0-9_-]+|memory:[a-zA-Z0-9_-]+|textbook:[a-zA-Z0-9_-]+|textbook|extraKnowledge)$/;

function writeSseEvent(res: Response, event: string, payload: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '100mb' }));

  // Chats REST
  app.get('/api/chats', (_req, res) => {
    res.json({ chats: store.listChats() });
  });

  app.post('/api/chats', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
    const chat = store.createChat(title);
    res.status(201).json({ chat });
  });

  app.put('/api/chats/:id', (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid chat ID' });
      return;
    }
    const updated = store.updateChat(id, {
      title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      messages: Array.isArray(req.body?.messages) ? req.body.messages : undefined,
      updatedAt: typeof req.body?.updatedAt === 'number' ? req.body.updatedAt : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.json({ chat: updated });
  });

  app.delete('/api/chats/:id', (req, res) => {
    const ok = store.deleteChat(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.json({ ok: true });
  });

  // KV Store
  app.get('/api/kv/:key', (req, res) => {
    const key = req.params.key;
    if (!VALID_KV_KEY.test(key)) {
      res.status(400).json({ error: 'Invalid KV key' });
      return;
    }
    res.json({ key, value: store.getKv(key) });
  });

  app.put('/api/kv/:key', (req, res) => {
    const key = req.params.key;
    if (!VALID_KV_KEY.test(key)) {
      res.status(400).json({ error: 'Invalid KV key' });
      return;
    }
    const value = req.body?.value;
    if (value === undefined) {
      res.status(400).json({ error: 'Missing value in request body' });
      return;
    }
    const saved = store.setKv(key, value);
    res.json({ key, value: saved });
  });

  // Flashcards Bridge
  app.get('/api/cards', (req, res) => {
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : undefined;
    res.json({ cards: store.listCards(chatId) });
  });

  app.post('/api/cards', (req, res) => {
    const { chatId, questionId, question, answer, subject } = req.body ?? {};
    if (typeof chatId !== 'string' || typeof questionId !== 'string' || typeof question !== 'string') {
      res.status(400).json({ error: 'chatId, questionId, and question are required' });
      return;
    }
    const card = store.createCard({
      chatId,
      questionId,
      question,
      answer: typeof answer === 'string' ? answer : '',
      subject: typeof subject === 'string' ? subject : 'General Study',
    });
    res.status(201).json({ card });
  });

  app.put('/api/cards/:id', (req, res) => {
    const updated = store.updateCard(req.params.id, {
      question: typeof req.body?.question === 'string' ? req.body.question : undefined,
      answer: typeof req.body?.answer === 'string' ? req.body.answer : undefined,
      status: req.body?.status,
      subject: typeof req.body?.subject === 'string' ? req.body.subject : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }
    res.json({ card: updated });
  });

  app.delete('/api/cards/:id', (req, res) => {
    const ok = store.deleteCard(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/subjects', (_req, res) => {
    res.json({ subjects: store.listSubjects() });
  });

  // Settings
  app.get('/api/settings', (_req, res) => {
    const saved = store.getSettings();
    res.json({
      settings: {
        ...saved,
        chatModel: saved.geminiModel,
        sttModel: GEMINI_STT_MODEL,
        hasGeminiKey: Boolean(getGeminiKey()),
        hasTavilyKey: Boolean((process.env.TAVILY_API_KEY || '').trim()),
      },
    });
  });

  app.put('/api/settings', (req, res) => {
    const saved = store.updateSettings({
      provider: req.body?.provider,
      geminiModel: req.body?.geminiModel,
      thinkingLevel: req.body?.thinkingLevel,
      themeMode: req.body?.themeMode,
    });
    res.json({
      settings: {
        ...saved,
        chatModel: saved.geminiModel,
        sttModel: GEMINI_STT_MODEL,
        hasGeminiKey: Boolean(getGeminiKey()),
        hasTavilyKey: Boolean((process.env.TAVILY_API_KEY || '').trim()),
      },
    });
  });

  // Frameless window IPC bridge
  app.post('/api/window/:action', (req, res) => {
    const action = req.params.action;
    if (!['minimize', 'maximize', 'fullscreen', 'close'].includes(action)) {
      res.status(400).json({ error: 'Unsupported window action' });
      return;
    }
    res.json({ ok: true, action });
  });

  // Streaming AI Chat (Gemini)
  app.post('/api/ai/chat', async (req: Request, res: Response) => {
    const {
      requestId,
      messages = [],
      systemPrompt = '',
      thinkingLevel = 'medium',
      textbookImages = [],
      model: requestedModel,
    } = req.body ?? {};

    if (typeof requestId !== 'string' || !requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const geminiModel = resolveGeminiModel(requestedModel, store.getSettings().geminiModel);
    const messageList = Array.isArray(messages) ? (messages as ChatMessage[]) : [];
    const latestUserMsg = [...messageList].reverse().find((m) => m.role === 'user');
    const latestUserHasImage = Boolean(
      latestUserMsg?.attachments?.some((att) => att.kind === 'image' && Boolean(att.dataUrl))
    );
    const requestedThinking = ['low', 'medium', 'high', 'xhigh'].includes(thinkingLevel)
      ? thinkingLevel
      : 'medium';
    const effectiveThinkingLevel =
      latestUserHasImage && (requestedThinking === 'low' || requestedThinking === 'medium')
        ? 'high'
        : requestedThinking;

    const controller = new AbortController();
    activeStreams.set(requestId, controller);

    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
      activeStreams.delete(requestId);
    });

    try {
      const { fullText, usage } = await streamGeminiChat({
        model: geminiModel,
        messages: messageList,
        systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : '',
        thinkingLevel: effectiveThinkingLevel,
        textbookImages: Array.isArray(textbookImages) ? textbookImages : [],
        signal: controller.signal,
        onChunk: (delta) => {
          writeSseEvent(res, 'ai:chunk', { requestId, delta });
        },
      });
      if (controller.signal.aborted) {
        writeSseEvent(res, 'ai:done', { requestId, fullText, usage, cancelled: true });
      } else {
        writeSseEvent(res, 'ai:done', { requestId, fullText, usage });
      }
      res.end();
    } catch (err) {
      if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
        writeSseEvent(res, 'ai:done', { requestId, cancelled: true });
      } else {
        writeSseEvent(res, 'ai:error', {
          requestId,
          error: formatGeminiError(err),
        });
      }
      res.end();
    } finally {
      activeStreams.delete(requestId);
    }
  });

  app.post('/api/ai/cancel', (req, res) => {
    const requestId = req.body?.requestId;
    if (typeof requestId === 'string' && activeStreams.has(requestId)) {
      activeStreams.get(requestId)?.abort();
      activeStreams.delete(requestId);
      res.json({ ok: true, cancelled: true });
      return;
    }
    res.json({ ok: true, cancelled: false });
  });

  // Exact Gemini token counter (AI Studio parity)
  app.post('/api/ai/count-tokens', async (req, res) => {
    const {
      messages = [],
      systemPrompt = '',
      textbookImages = [],
      model: requestedModel,
    } = req.body ?? {};
    const geminiModel = resolveGeminiModel(requestedModel, store.getSettings().geminiModel);

    try {
      const totalTokens = await countGeminiTokens({
        model: geminiModel,
        messages: Array.isArray(messages) ? (messages as ChatMessage[]) : [],
        systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : '',
        textbookImages: Array.isArray(textbookImages) ? textbookImages : [],
      });
      res.json({ totalTokens, model: geminiModel });
    } catch (err) {
      res.status(502).json({ error: formatGeminiError(err) });
    }
  });

  // Memory Summarization (Single-Stage Rolling Packs)
  app.post('/api/ai/summarize', async (req, res) => {
    const { inputTokens = 1000, messages = [], packs = [], model: requestedModel } = req.body ?? {};
    const geminiModel = resolveGeminiModel(requestedModel, store.getSettings().geminiModel);

    try {
      const result = await summarizeWithGemini({
        model: geminiModel,
        stage: 1,
        inputTokens: Number(inputTokens) || 1000,
        messages: Array.isArray(messages) ? messages : undefined,
        packs: Array.isArray(packs) ? packs : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: formatGeminiError(err) });
    }
  });

  // Living Learner State update
  app.post('/api/ai/update-learner-state', async (req, res) => {
    const { currentState = [], messages = [], model: requestedModel } = req.body ?? {};
    const geminiModel = resolveGeminiModel(requestedModel, store.getSettings().geminiModel);

    try {
      const concepts = await updateLearnerStateWithGemini({
        model: geminiModel,
        currentState: Array.isArray(currentState) ? currentState : [],
        messages: Array.isArray(messages) ? messages : [],
      });
      res.json({ concepts });
    } catch (err) {
      res.status(502).json({ error: formatGeminiError(err) });
    }
  });

  // Voice transcription (STT)
  app.post('/api/ai/transcribe', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Audio file is required' });
      return;
    }

    try {
      const text = await transcribeWithGemini(
        req.file.buffer,
        req.file.mimetype || 'audio/webm'
      );
      res.json({ text });
    } catch (err) {
      res.status(502).json({ error: formatGeminiError(err) });
    }
  });

  // Textbook Page OCR + Figure Bounding-Box Analyzer (Single Page)
  app.post('/api/ai/analyze-textbook-page', async (req, res) => {
    const {
      imageDataUrl,
      mimeType,
      pageNumber = 1,
      documentContext,
      batchGuidance,
      stream = false,
      model: requestedModel,
    } = req.body ?? {};
    if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
      res.status(400).json({ error: 'Valid imageDataUrl is required.' });
      return;
    }

    const geminiModel = resolveGeminiModel(requestedModel, store.getSettings().geminiModel);
    const contextStr = typeof documentContext === 'string' ? documentContext : undefined;
    const guidanceObj =
      batchGuidance && typeof batchGuidance === 'object'
        ? (batchGuidance as TextbookBatchGuidance)
        : undefined;
    const wantsStream =
      stream === true || String(req.headers.accept || '').includes('text/event-stream');

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': ping\n\n');
        }
      }, 3000);

      res.on('close', () => {
        clearInterval(heartbeat);
      });

      try {
        const result = await analyzeTextbookPageWithGemini({
          model: geminiModel,
          imageDataUrl,
          mimeType: typeof mimeType === 'string' ? mimeType : undefined,
          pageNumber: Number(pageNumber) || 1,
          documentContext: contextStr,
          batchGuidance: guidanceObj,
        });
        writeSseEvent(res, 'result', result);
      } catch (err) {
        writeSseEvent(res, 'error', { error: formatGeminiError(err) });
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    try {
      const result = await analyzeTextbookPageWithGemini({
        model: geminiModel,
        imageDataUrl,
        mimeType: typeof mimeType === 'string' ? mimeType : undefined,
        pageNumber: Number(pageNumber) || 1,
        documentContext: contextStr,
        batchGuidance: guidanceObj,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: formatGeminiError(err) });
    }
  });

  // Holistic Batch Planner (Phase 1: Inspect all pages together for language & consistent titles)
  app.post('/api/ai/plan-textbook-batch', async (req, res) => {
    const {
      pages,
      documentContext,
      stream = false,
      model: requestedModel,
    } = req.body ?? {};

    if (!Array.isArray(pages) || pages.length === 0) {
      res.status(400).json({ error: 'A non-empty pages array is required.' });
      return;
    }

    const validatedPages: TextbookPageInput[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i] as Record<string, unknown> | null;
      const imageDataUrl = p?.imageDataUrl;
      if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
        res.status(400).json({ error: `Valid imageDataUrl is required for page #${i + 1}.` });
        return;
      }
      validatedPages.push({
        imageDataUrl,
        mimeType: typeof p?.mimeType === 'string' ? p.mimeType : undefined,
        pageNumber: Number(p?.pageNumber) || i + 1,
      });
    }

    const geminiModel = resolveGeminiModel(requestedModel, store.getSettings().geminiModel);
    const contextStr = typeof documentContext === 'string' ? documentContext : undefined;
    const wantsStream =
      stream === true || String(req.headers.accept || '').includes('text/event-stream');

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': ping\n\n');
        }
      }, 3000);

      res.on('close', () => {
        clearInterval(heartbeat);
      });

      try {
        const plan = await planTextbookBatchWithGemini({
          model: geminiModel,
          pages: validatedPages,
          documentContext: contextStr,
        });
        writeSseEvent(res, 'result', plan);
      } catch (err) {
        writeSseEvent(res, 'error', { error: formatGeminiError(err) });
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    try {
      const plan = await planTextbookBatchWithGemini({
        model: geminiModel,
        pages: validatedPages,
        documentContext: contextStr,
      });
      res.json(plan);
    } catch (err) {
      res.status(502).json({ error: formatGeminiError(err) });
    }
  });

  // Textbook Pages Holistic Multi-Image Analyzer (Batch)
  app.post('/api/ai/analyze-textbook-pages', async (req, res) => {
    const {
      pages,
      documentContext,
      stream = false,
      model: requestedModel,
    } = req.body ?? {};

    if (!Array.isArray(pages) || pages.length === 0) {
      res.status(400).json({ error: 'A non-empty pages array is required.' });
      return;
    }

    const validatedPages: TextbookPageInput[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i] as Record<string, unknown> | null;
      const imageDataUrl = p?.imageDataUrl;
      if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
        res.status(400).json({ error: `Valid imageDataUrl is required for page #${i + 1}.` });
        return;
      }
      validatedPages.push({
        imageDataUrl,
        mimeType: typeof p?.mimeType === 'string' ? p.mimeType : undefined,
        pageNumber: Number(p?.pageNumber) || i + 1,
      });
    }

    const geminiModel = resolveGeminiModel(requestedModel, store.getSettings().geminiModel);
    const contextStr = typeof documentContext === 'string' ? documentContext : undefined;
    const wantsStream =
      stream === true || String(req.headers.accept || '').includes('text/event-stream');

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': ping\n\n');
        }
      }, 3000);

      res.on('close', () => {
        clearInterval(heartbeat);
      });

      try {
        const results = await analyzeTextbookPagesWithGemini({
          model: geminiModel,
          pages: validatedPages,
          documentContext: contextStr,
        });
        writeSseEvent(res, 'result', { pages: results });
      } catch (err) {
        writeSseEvent(res, 'error', { error: formatGeminiError(err) });
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    try {
      const results = await analyzeTextbookPagesWithGemini({
        model: geminiModel,
        pages: validatedPages,
        documentContext: contextStr,
      });
      res.json({ pages: results });
    } catch (err) {
      res.status(502).json({ error: formatGeminiError(err) });
    }
  });

  // Textbook URL Scraper (Tavily Extract + Reader-Mode Formatter)
  app.post('/api/ai/scrape-textbook-urls', async (req, res) => {
    const {
      urls,
      documentContext,
      stream = false,
      model: requestedModel,
    } = req.body ?? {};

    if (!Array.isArray(urls) || urls.length === 0) {
      res.status(400).json({ error: 'At least one website URL is required.' });
      return;
    }

    const validUrls: string[] = [];
    for (const raw of urls.slice(0, 5)) {
      if (typeof raw !== 'string') continue;
      try {
        const parsed = new URL(raw.trim());
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          validUrls.push(parsed.href);
        }
      } catch {
        // Skip invalid URL entries
      }
    }

    if (validUrls.length === 0) {
      res.status(400).json({ error: 'No valid http(s) website URLs provided.' });
      return;
    }

    const geminiModel = resolveGeminiModel(requestedModel, store.getSettings().geminiModel);
    const contextStr = typeof documentContext === 'string' ? documentContext : undefined;
    const wantsStream =
      stream === true || String(req.headers.accept || '').includes('text/event-stream');

    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': ping\n\n');
        }
      }, 3000);

      res.on('close', () => {
        clearInterval(heartbeat);
      });

      try {
        const result = await scrapeTextbookUrlsWithTavily({
          urls: validUrls,
          documentContext: contextStr,
          model: geminiModel,
        });
        writeSseEvent(res, 'result', result);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = /Tavily|website blocks|Could not extract|TAVILY_API_KEY|Reader|direct fetch/i.test(rawMsg)
          ? rawMsg
          : formatGeminiError(err);
        writeSseEvent(res, 'error', { error: safeMsg });
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    try {
      const result = await scrapeTextbookUrlsWithTavily({
        urls: validUrls,
        documentContext: contextStr,
        model: geminiModel,
      });
      res.json(result);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = /Tavily|website blocks|Could not extract|TAVILY_API_KEY|Reader|direct fetch/i.test(rawMsg)
        ? rawMsg
        : formatGeminiError(err);
      const status = /TAVILY_API_KEY is not configured/i.test(msg) ? 400 : 502;
      res.status(status).json({ error: msg });
    }
  });

  // Web search (Tavily)
  app.post('/api/web-search', async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }
    const tavilyKey = (process.env.TAVILY_API_KEY || '').trim();
    if (!tavilyKey) {
      res.status(400).json({
        error: 'TAVILY_API_KEY is not configured on the server. Add TAVILY_API_KEY in Secrets to enable live web search.',
      });
      return;
    }

    try {
      const upstream = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          search_depth: 'basic',
          include_answer: true,
          max_results: 5,
        }),
      });
      if (!upstream.ok) {
        const txt = await upstream.text().catch(() => '');
        res.status(upstream.status).json({ error: `Tavily search error: ${txt.slice(0, 200)}` });
        return;
      }
      const data = await upstream.json();
      res.json({
        answer: data.answer || '',
        results: Array.isArray(data.results)
          ? data.results.map((r: Record<string, unknown>) => ({
              title: String(r.title || ''),
              url: String(r.url || ''),
              content: String(r.content || ''),
            }))
          : [],
      });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message || 'Web search failed' });
    }
  });

  // Frontend Vite / static middleware
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Talk study tutor server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Talk server:', err);
  process.exit(1);
});
