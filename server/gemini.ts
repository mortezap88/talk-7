import { GoogleGenAI, ThinkingLevel, Type, type Content, type Part } from '@google/genai';
import type {
  ChatAttachment,
  ChatMessage,
  ConceptState,
  GeminiModel,
  MemoryPack,
  ThinkingLevel as TalkThinkingLevel,
  TokenUsageSnapshot,
} from '../src/types/talk.ts';
import {
  getTargetSummaryTokens,
  sanitizeMemoryPackOutput,
  stripHighlightMarkup,
} from '../src/utils/memoryEngine.ts';
import {
  cleanScrapedWebpageFallback,
  decodeHtmlEntities,
  ensureWebpageMarkdownHasTitle,
  extractWebpageMetadataFromHtml,
  isGenericOrEmptyFigureCaption,
  markdownStartsWithArticleTitle,
  parseAnalyzedMarkdownWithImageBoxes,
  precleanWebpageMarkdown,
  type WebpageHtmlMetadata,
} from '../src/utils/textbookLayout.ts';

export const GEMINI_CHAT_MODEL: GeminiModel = 'gemini-4-hydrogen';
export const GEMINI_STT_MODEL = 'gemini-3.5-transcribe';

const SUPPORTED_RASTER_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export function getGeminiKey(): string {
  return (process.env.GEMINI_API_KEY || '').trim();
}

function createGeminiClient(): GoogleGenAI {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Check Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function toGeminiThinkingLevel(
  level: TalkThinkingLevel,
  model: GeminiModel = GEMINI_CHAT_MODEL
): ThinkingLevel {
  if (level === 'low') return ThinkingLevel.LOW;
  if (level === 'high') return ThinkingLevel.HIGH;
  if (level === 'xhigh') {
    return model === 'gemini-4-hydrogen' ? ThinkingLevel.XHIGH : ThinkingLevel.HIGH;
  }
  return ThinkingLevel.MEDIUM;
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), base64: match[2] };
}

function attachmentToParts(att: ChatAttachment): Part[] {
  if (att.kind === 'text' && att.textContent) {
    return [{ text: `[Attached file: ${att.name}]\n${att.textContent}` }];
  }
  if (att.kind === 'image' && att.dataUrl) {
    const parsed = parseDataUrl(att.dataUrl);
    if (!parsed) return [];
    if (SUPPORTED_RASTER_MIMES.has(parsed.mimeType)) {
      const mime = parsed.mimeType === 'image/jpg' ? 'image/jpeg' : parsed.mimeType;
      return [{ inlineData: { mimeType: mime, data: parsed.base64 } }];
    }
    if (parsed.mimeType === 'image/svg+xml') {
      try {
        const svgText = Buffer.from(parsed.base64, 'base64').toString('utf8');
        return [{ text: `[Attached SVG diagram: ${att.name}]\n${svgText.slice(0, 4000)}` }];
      } catch {
        return [{ text: `[Attached diagram: ${att.name}]` }];
      }
    }
  }
  return [];
}

function buildGeminiContents(
  messages: ChatMessage[],
  textbookImages: ChatAttachment[]
): Content[] {
  let latestUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      latestUserIdx = i;
      break;
    }
  }

  const contents: Content[] = [];
  messages.forEach((msg, idx) => {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: Part[] = [];
    let textBody = msg.content || '';

    const extraTextbook =
      idx === latestUserIdx && Array.isArray(textbookImages)
        ? textbookImages.filter((a) => a.dataUrl)
        : [];

    if (role === 'user' && extraTextbook.length > 0) {
      textBody = `${textBody}\n\n[Authoritative Textbook Pages attached below — treat these images as authoritative textbook reference material.]`.trim();
    }

    if (textBody) {
      parts.push({ text: textBody });
    }

    if (Array.isArray(msg.attachments)) {
      for (const att of msg.attachments) {
        parts.push(...attachmentToParts(att));
      }
    }

    if (role === 'user') {
      extraTextbook.forEach((tbImg) => {
        const imgParts = attachmentToParts(tbImg);
        if (imgParts.length === 0) return;
        const pageNote = tbImg.pageNumber ? ` (Page ${tbImg.pageNumber})` : '';
        const capNote = tbImg.caption ? `: ${tbImg.caption}` : '';
        parts.push({ text: `[Textbook Figure${pageNote}${capNote}]` });
        parts.push(...imgParts);
      });
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  });

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  return contents;
}

export function formatGeminiError(err: unknown): string {
  let msg = (err as Error)?.message || String(err);
  // Unwrap nested JSON error envelopes returned by @google/genai
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(msg);
      if (parsed?.error?.message) {
        msg = String(parsed.error.message);
        continue;
      }
      if (parsed?.message) {
        msg = String(parsed.message);
        continue;
      }
    } catch {
      break;
    }
  }
  if (/API_KEY_INVALID|PERMISSION_DENIED|403|401/i.test(msg)) {
    return 'Gemini API key error. Please verify GEMINI_API_KEY in Settings > Secrets.';
  }
  if (/RESOURCE_EXHAUSTED|429/i.test(msg)) {
    return 'Gemini rate limit reached (429). Please wait a moment and try again.';
  }
  if (/UNAVAILABLE|503|high demand/i.test(msg)) {
    return 'Gemini is temporarily experiencing high demand (503). Please try again in a few seconds.';
  }
  return msg || 'Gemini API request failed.';
}

function isTransientError(err: unknown): boolean {
  const msg = (err as Error)?.message || String(err);
  return /503|UNAVAILABLE|high demand|ECONNRESET|ETIMEDOUT/i.test(msg);
}

async function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function streamGeminiChat(params: {
  model?: GeminiModel;
  messages: ChatMessage[];
  systemPrompt: string;
  thinkingLevel: TalkThinkingLevel;
  textbookImages: ChatAttachment[];
  signal: AbortSignal;
  onChunk: (delta: string) => void;
}): Promise<{ fullText: string; usage?: TokenUsageSnapshot }> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const contents = buildGeminiContents(params.messages, params.textbookImages);

  const delays = [600, 1400];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let fullText = '';
    let latestUsage: TokenUsageSnapshot | undefined;
    try {
      const streamResponse = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: params.systemPrompt || undefined,
          thinkingConfig: {
            thinkingLevel: toGeminiThinkingLevel(params.thinkingLevel, model),
          },
          abortSignal: params.signal,
        },
      });

      for await (const chunk of streamResponse) {
        if (params.signal.aborted) break;
        const meta = chunk.usageMetadata;
        if (meta) {
          latestUsage = {
            promptTokens: meta.promptTokenCount ?? 0,
            outputTokens: meta.candidatesTokenCount ?? 0,
            thinkingTokens: meta.thoughtsTokenCount ?? 0,
            totalTokens: meta.totalTokenCount ?? 0,
          };
        }
        const text = chunk.text;
        if (typeof text === 'string' && text.length > 0) {
          fullText += text;
          params.onChunk(text);
        }
      }
      return { fullText, usage: latestUsage };
    } catch (err) {
      lastError = err;
      if (params.signal.aborted || (err as Error).name === 'AbortError') {
        throw err;
      }
      if (fullText.length === 0 && attempt < delays.length && isTransientError(err)) {
        await waitWithAbort(delays[attempt], params.signal);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

export async function countGeminiTokens(params: {
  model?: GeminiModel;
  messages: ChatMessage[];
  systemPrompt: string;
  textbookImages: ChatAttachment[];
}): Promise<number> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;

  let msgContents: Content[] = [];
  if (params.messages.length > 0) {
    msgContents = buildGeminiContents(params.messages, params.textbookImages);
  } else if (params.textbookImages.length > 0) {
    msgContents = buildGeminiContents(
      [{ id: '__next_user__', role: 'user', content: '', createdAt: 0 }],
      params.textbookImages
    );
  }

  // Gemini Developer API countTokens rejects config.systemInstruction,
  // so prepend systemPrompt as a Content item for exact full-context token counting.
  const contents: Content[] = params.systemPrompt.trim()
    ? [{ role: 'user', parts: [{ text: params.systemPrompt }] }, ...msgContents]
    : msgContents;

  if (contents.length === 0) {
    return 0;
  }

  const response = await ai.models.countTokens({
    model,
    contents,
  });

  return response.totalTokens ?? 0;
}

export async function summarizeWithGemini(params: {
  model?: GeminiModel;
  stage?: 1 | 2 | 3;
  inputTokens: number;
  messages?: ChatMessage[];
  packs?: MemoryPack[];
}): Promise<{ summary: string; bullets: string[] }> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const maxTargetTokens = getTargetSummaryTokens(params.inputTokens);

  const sourceText =
    Array.isArray(params.packs) && params.packs.length > 0
      ? params.packs
          .map(
            (p, idx) =>
              `Pack ${idx + 1}:\n${p.summary}\nBullets:\n${p.bullets.join('\n')}`
          )
          .join('\n\n')
      : (params.messages || [])
          .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
          .join('\n\n');

  const response = await ai.models.generateContent({
    model,
    contents: sourceText,
    config: {
      systemInstruction: `You are a high-signal study-memory compactor for Talk. Compress this conversation segment into a crisp, durable study memory pack that helps the tutor remember what was learned, decided, still shaky, and improved.

Rules:
1. Substance-proportional length: Use at most ~${maxTargetTokens} tokens as an upper ceiling for dense technical content—never pad to hit a length target. Strip greetings, connection tests ("can you hear me?"), and app/UI troubleshooting chatter. If the segment contains mostly small talk or UI talk, compress it into 1–3 brief sentences.
2. Required structure inside "summary" (use concise **Section:** headings, omitting any section that genuinely has nothing substantive):
   - **Discussed & Subtopics Covered:** Specific topics, problems, mechanisms, or questions covered (preserve exact formulas/LaTeX like $...$ and key nuances concisely).
   - **Conclusions:** Verified answers, rules, derivations, or study decisions reached.
   - **Blindspots:** Student misconceptions, shaky assumptions, confusing steps, or open unresolved questions.
   - **Understanding Improvements:** Concepts the student clarified, errors they corrected, or breakthroughs demonstrated.
3. Formatting & cleanliness:
   - Write clean plain prose and standard Markdown bold/LaTeX ($...$) only.
   - NEVER use Talk inline highlight delimiters (==...==, @@...@@, !!...!!, ++...++, whether raw or in backticks) anywhere in "summary" or "bullets".
4. "bullets": Provide 2–5 short, distinct scannable takeaways (max 1 line each) covering key subtopics, conclusions, blindspots, or improvements. Do not duplicate lines verbatim from "summary". (Use 1 short bullet if the segment had minimal study content.)`,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          bullets: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['summary', 'bullets'],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim());
  return sanitizeMemoryPackOutput({
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    bullets: Array.isArray(parsed.bullets)
      ? parsed.bullets.map((b: unknown) => String(b))
      : [],
  });
}

export async function updateLearnerStateWithGemini(params: {
  model?: GeminiModel;
  currentState: ConceptState[];
  messages: ChatMessage[];
}): Promise<ConceptState[]> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const dialogue = params.messages
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  const response = await ai.models.generateContent({
    model,
    contents: `Current state:\n${JSON.stringify(params.currentState)}\n\nNew dialogue:\n${dialogue}`,
    config: {
      systemInstruction: `Maintain the student's Living Learner State (max 24 concepts). Statuses allowed: "misunderstood", "unresolved", "shaky", "understood".

Rules:
1. Track Blindspots ("misunderstood", "unresolved", "shaky") with a 1-line diagnosis of what is confused, incomplete, or still open.
2. Track Understanding Improvements ("understood"): add mastered concepts and promote prior blindspots when the new dialogue shows the student corrected a mistake or reasoned accurately—prefixing the note with "Improved:" when an earlier gap was resolved (e.g., "Improved: correctly distinguished Keq from reaction quotient Q").
3. Carry forward existing unaffected concepts from Current state so prior progress and open blindspots are never lost.
4. Ignore casual greetings, connection checks, and app/UI troubleshooting—never create concepts for UI issues or meta chat.
5. Never use inline highlight delimiters (==, @@, !!, ++) in concept names or notes. Each note must be 1 concise, informative line.`,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          concepts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                concept: { type: Type.STRING },
                status: { type: Type.STRING },
                note: { type: Type.STRING },
              },
              required: ['concept', 'status', 'note'],
            },
          },
        },
        required: ['concepts'],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim());
  const list = Array.isArray(parsed?.concepts) ? parsed.concepts : [];
  const now = Date.now();
  return list
    .filter((item: Record<string, unknown>) => typeof item?.concept === 'string')
    .slice(0, 24)
    .map((item: Record<string, unknown>, idx: number) => ({
      id: `cs_${now}_${idx}`,
      concept: stripHighlightMarkup(String(item.concept)).trim(),
      status: ['misunderstood', 'unresolved', 'shaky', 'understood'].includes(String(item.status))
        ? (item.status as ConceptState['status'])
        : 'unresolved',
      note: stripHighlightMarkup(String(item.note || '')).trim(),
      updatedAt: now,
    }))
    .filter((item: ConceptState) => item.concept.length > 0);
}

export async function transcribeWithGemini(
  audioBuffer: Buffer,
  mimeType: string
): Promise<string> {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Check Settings > Secrets.');
  }
  const rawMime = (mimeType || 'audio/webm').split(';')[0].trim().toLowerCase();
  const normalizedMime = rawMime.startsWith('audio/') ? rawMime : 'audio/webm';
  const base64Audio = audioBuffer.toString('base64');

  const requestBody = {
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: normalizedMime,
            data: base64Audio,
          },
        },
        {
          text: 'Transcribe the spoken words in this audio accurately. Return only the spoken transcript text, or an empty string if there is no speech.',
        },
      ],
    },
  };

  // Try gemini-3.5-transcribe on v1beta first, then fall back to gemini-4-hydrogen on default client
  const attempts: Array<{ model: string; apiVersion?: string }> = [
    { model: GEMINI_STT_MODEL, apiVersion: 'v1beta' },
    { model: GEMINI_CHAT_MODEL },
  ];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const client = new GoogleGenAI({
        apiKey,
        ...(attempt.apiVersion ? { apiVersion: attempt.apiVersion } : {}),
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
      const response = await client.models.generateContent({
        model: attempt.model,
        ...requestBody,
      });
      return (response.text ?? '').trim();
    } catch (err) {
      lastError = err;
      const msg = (err as Error)?.message || String(err);
      if (/not found|NOT_FOUND|404|is not supported for generateContent/i.test(msg)) {
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

export interface AnalyzedTextbookBlock {
  type: 'text' | 'figure';
  content?: string;
  caption?: string;
  box_2d?: [number, number, number, number];
  align?: 'left' | 'center' | 'right' | 'full';
  widthPct?: number;
}

export interface AnalyzedTextbookPageResult {
  pageKind: 'text_only' | 'visual_only' | 'mixed';
  sourceType?: 'book_page' | 'webpage';
  blocks: AnalyzedTextbookBlock[];
}

export interface TextbookPageInput {
  imageDataUrl: string;
  mimeType?: string;
  pageNumber: number;
}

export interface TextbookBatchPagePlan {
  pageIndex: number;
  pageKind: 'text_only' | 'visual_only' | 'mixed';
  sourceType: 'book_page' | 'webpage';
  figureCaptions: string[];
}

export interface TextbookBatchPlan {
  primaryLanguage: string;
  chapterContext: string;
  pages: TextbookBatchPagePlan[];
}

export interface TextbookBatchGuidance {
  primaryLanguage?: string;
  chapterContext?: string;
  expectedPageKind?: 'text_only' | 'visual_only' | 'mixed';
  expectedSourceType?: 'book_page' | 'webpage';
  expectedFigureCaptions?: string[];
}

export { isGenericOrEmptyFigureCaption };

function validateRasterPage(p: TextbookPageInput, idx: number): {
  pageIndex: number;
  pageNumber: number;
  mimeType: string;
  base64: string;
} {
  const parsedUrl = parseDataUrl(p.imageDataUrl);
  if (!parsedUrl) {
    throw new Error(`Invalid image data URL for textbook page #${idx + 1}.`);
  }
  const rawMime = (p.mimeType || parsedUrl.mimeType || 'image/jpeg').toLowerCase();
  const mimeType = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
  if (!SUPPORTED_RASTER_MIMES.has(mimeType)) {
    throw new Error(`Unsupported textbook page image type: ${mimeType}`);
  }
  return {
    pageIndex: idx,
    pageNumber: p.pageNumber,
    mimeType,
    base64: parsedUrl.base64,
  };
}

/**
 * Phase 1 (Holistic Batch Planner):
 * Inspects ALL uploaded images together in one lightweight pass to determine:
 * - One consistent primary language across the batch & existing textbook context
 * - Brief chapter/topic continuity context so heading levels stay consistent
 */
export async function planTextbookBatchWithGemini(params: {
  model?: GeminiModel;
  pages: TextbookPageInput[];
  documentContext?: string;
}): Promise<TextbookBatchPlan> {
  if (!Array.isArray(params.pages) || params.pages.length === 0) {
    return { primaryLanguage: '', chapterContext: '', pages: [] };
  }

  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const validatedPages = params.pages.map((p, idx) => validateRasterPage(p, idx));
  const contextHint = (params.documentContext || '').trim().slice(0, 1200);

  const parts: Part[] = [];
  for (const page of validatedPages) {
    parts.push({ text: `Image pageIndex=${page.pageIndex} (sequence #${page.pageNumber}):` });
    parts.push({ inlineData: { mimeType: page.mimeType, data: page.base64 } });
  }
  parts.push({
    text: `Inspect ALL ${validatedPages.length} textbook image(s) TOGETHER as one continuous reading batch.${
      contextHint
        ? `\n\nExisting textbook text context (match this language & heading hierarchy):\n"""\n${contextHint}\n"""`
        : ''
    }\n\nDetermine the single primaryLanguage, a brief 1-sentence chapterContext summarizing the topic and heading hierarchy, and for each pageIndex 0..${validatedPages.length - 1}, whether it contains readable text.`,
  });

  const delays = [700, 1500];
  let parsed: Record<string, unknown> | null = null;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: { parts },
        config: {
          systemInstruction: `You are planning consistent verbatim text extraction across a multi-image upload (textbook pages or website article screenshots).
Your ONLY job in this planning step is to look at ALL images together and produce a compact manifest:
1. "primaryLanguage": The single dominant language of the main study/article content (e.g. "Persian" or "English").
2. "chapterContext": 1 concise sentence summarizing the main chapter/article topic and heading hierarchy across these images so each image formats cleanly into one unified document.
3. "pages": An array with ONE entry for EVERY pageIndex 0..${validatedPages.length - 1}:
   - "sourceType": "webpage" if the image is a website, news article, blog, wiki, forum, or documentation screenshot (has browser chrome, site mastheads/navbars, ads, sidebars, share/follow buttons, subscription banners, or web layout), or "book_page" if it is a printed/scanned textbook page, PDF page, worksheet, slide, or notes page.
   - "pageKind": "text_only" if the image contains readable main body text outside pictures/diagrams/ads, or "visual_only" if it is only a standalone picture/diagram with no main body text.`,
          ...(model === 'gemini-3.5-flash-lite'
            ? {}
            : { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              primaryLanguage: { type: Type.STRING },
              chapterContext: { type: Type.STRING },
              pages: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    pageIndex: { type: Type.INTEGER },
                    sourceType: { type: Type.STRING },
                    pageKind: { type: Type.STRING },
                  },
                  required: ['pageIndex', 'sourceType', 'pageKind'],
                },
              },
            },
            required: ['primaryLanguage', 'chapterContext', 'pages'],
          },
        },
      });

      const rawText = (response.text ?? '{}').trim();
      const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const jsonCandidate = fenced?.[1] ? fenced[1].trim() : rawText;
      parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < delays.length && (isTransientError(err) || err instanceof SyntaxError)) {
        await waitWithAbort(delays[attempt]);
        continue;
      }
      throw err;
    }
  }

  if (!parsed) {
    throw lastError instanceof Error ? lastError : new Error('Failed to plan textbook batch.');
  }

  const primaryLanguage = typeof parsed.primaryLanguage === 'string' ? parsed.primaryLanguage.trim() : '';
  const chapterContext = typeof parsed.chapterContext === 'string' ? parsed.chapterContext.trim() : '';
  const rawPages = Array.isArray(parsed.pages) ? (parsed.pages as Array<Record<string, unknown>>) : [];

  const pages: TextbookBatchPagePlan[] = validatedPages.map((_, idx) => {
    const matched = rawPages.find((p) => Number(p?.pageIndex) === idx) ?? rawPages[idx] ?? null;
    const rawKind = String(matched?.pageKind || 'text_only');
    const pageKind: TextbookBatchPagePlan['pageKind'] =
      rawKind === 'visual_only' ? 'visual_only' : 'text_only';
    const rawSource = String(matched?.sourceType || 'book_page');
    const sourceType: TextbookBatchPagePlan['sourceType'] =
      rawSource === 'webpage' ? 'webpage' : 'book_page';
    return { pageIndex: idx, pageKind, sourceType, figureCaptions: [] };
  });

  return { primaryLanguage, chapterContext, pages };
}

/**
 * Phase 2 (Per-Page Precision Text Extractor):
 * Focuses 100% of vision/OCR attention on ONE page image, extracting ONLY structured,
 * sleek book-page Markdown text while preserving every printed word 100% verbatim.
 */
export async function analyzeTextbookPageWithGemini(params: {
  model?: GeminiModel;
  imageDataUrl: string;
  mimeType?: string;
  pageNumber: number;
  documentContext?: string;
  batchGuidance?: TextbookBatchGuidance;
}): Promise<AnalyzedTextbookPageResult> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const validated = validateRasterPage(
    {
      imageDataUrl: params.imageDataUrl,
      mimeType: params.mimeType,
      pageNumber: params.pageNumber,
    },
    0
  );

  const contextHint = (params.documentContext || '').trim().slice(0, 1200);
  const guidance = params.batchGuidance;

  const guidanceNotes: string[] = [];
  if (guidance?.expectedSourceType) {
    guidanceNotes.push(`Batch source type: ${guidance.expectedSourceType}`);
  }
  if (guidance?.primaryLanguage) {
    guidanceNotes.push(`Batch primary language: ${guidance.primaryLanguage}`);
  }
  if (guidance?.chapterContext) {
    guidanceNotes.push(`Chapter/article topic: ${guidance.chapterContext}`);
  }

  const promptText = [
    `Classify this image ("webpage" vs "book_page") and extract ONLY the main readable content verbatim (sequence #${params.pageNumber}) into clean structured Markdown.`,
    guidanceNotes.length > 0 ? `BATCH CONTEXT:\n${guidanceNotes.join('\n')}` : '',
    contextHint
      ? `PRECEDING CONTEXT (continue seamlessly in the same language & heading hierarchy):\n"""\n${contextHint}\n"""`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const delays = [800, 1800];
  let lastError: unknown;
  let parsed: Record<string, unknown> | null = null;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            { inlineData: { mimeType: validated.mimeType, data: validated.base64 } },
            { text: promptText },
          ],
        },
        config: {
          systemInstruction: `You are a precision document & webpage reader-mode OCR extractor. First classify whether the image is a website screenshot ("webpage") or a book/study document ("book_page"), then extract ONLY the primary readable content verbatim into sleek Markdown—WITHOUT transcribing text inside photos/diagrams, WITHOUT changing a single word, and placing [[IMAGE_BOX: subtitle]] placeholders only for genuine main-content figures.

STEP 1 — CLASSIFY "sourceType" BEFORE WRITING MARKDOWN:
- "webpage": screenshots of websites, news articles, blogs, wikis, online docs, or forums (identifiable by browser chrome, site logos/mastheads, navigation bars, donation/subscription banners, advertisements, left/right sidebars, Share/Follow buttons, cookie notices, or web UI).
- "book_page": printed or scanned textbook pages, PDF pages, worksheets, lecture slides, or handwritten/typed notes.

STEP 2A — SPECIAL WEBSITE READER-MODE RULES (APPLY STRICTLY WHENEVER "sourceType" IS "webpage"):
When extracting from a website screenshot, isolate ONLY the primary central article / post / documentation column and COMPLETELY IGNORE surrounding webpage clutter:
- STRICTLY EXCLUDE ALL WEBPAGE CHROME, ADS, SIDEBARS, & UI NOISE:
  - Browser bars, tabs, address bars, bookmarks, scrollbars, OS taskbars.
  - Site mastheads/logos (e.g. "The Guardian"), top navbars, breadcrumbs, and category/section tags or badges (e.g. "Film", "News", "Opinion", "Home > Science").
  - Paywall, donation, subscription, or account banners (e.g. "Support the Guardian", "Fund independent journalism...", "Claim discount", "Print subscriptions", "My account", "Subscribe", "Sign in", currency/edition selectors like "Eur").
  - Advertisements & promotional cards (e.g. "Advertisement", "Sponsored", "WPS Compress PDF", "DOWNLOAD", AdChoices icons).
  - Left/right sidebars, separate metadata rails, social/action widgets, & sharing buttons (e.g. "Share", "Prefer the Guardian on Google", "Follow", "Bookmark", "Print", "Listen", "Comments", newsletter signups, cookie banners, and standalone sidebar byline/timestamp widgets like "Andrew Pulver" / "Thu 26 Nov 2026 15.52 CET" when sitting in a separate left/right chrome column outside the main article body).
  - "Related stories", "Most viewed", "More on this story", "Recommended", comment sections, and page footers.
- WHAT TO EXTRACT FROM A WEBPAGE:
  - Only the primary article's main headline (# Title), its editorial standfirst/subtitle directly under the headline (## Subtitle or lead paragraph), section subheadings (## / ###), body paragraphs, inline lists, blockquotes, tables, code blocks, and formulas—100% verbatim in reading order.
- WEBSITE IMAGES ([[IMAGE_BOX: ...]]):
  - Emit [[IMAGE_BOX: <subtitle>]] ONLY for genuine, substantially visible editorial photos, charts, or diagrams inside the **main article body** (putting the printed photo caption verbatim inside the tag, e.g. [[IMAGE_BOX: 'It was the Twilight Zone' ... Amanda Seyfried. Photograph: Evan Agostini/AP]], without repeating that caption as text).
  - NEVER emit [[IMAGE_BOX: ...]] for advertisements, download/promo banners, site mastheads/logos, author avatars, social/UI icons, related-story thumbnails, OR **partially cut-off / peeking image slivers at the top or bottom border of the screenshot** (e.g., an image edge cut off at the bottom of the viewport with no visible caption).

STEP 2B — TEXTBOOK / DOCUMENT RULES (WHEN "sourceType" IS "book_page"):
1. EXTRACT ONLY WRITTEN BOOK TEXT — NEVER TRANSCRIBE TEXT INSIDE PICTURES OR DIAGRAMS:
   - Read every written section of the page from top to bottom: colored chapter/unit banners, titles, subtitles, body paragraphs above/below/beside illustrations, lists, tables, equations, and book callout/sidebar boxes (e.g. واژه‌شناسی, فعالیت, بیشتر بدانید, گفت‌وگو کنید).
   - **STRICTLY DO NOT TRANSCRIBE** any labels, callout words, pointer names, arrows, axis numbers, or annotations printed **inside or pointing onto pictures, illustrations, anatomical/scientific diagrams, photographs, or charts**. Never convert diagram labels into bullet lists or prose.
   - **STRICTLY SKIP ALL PAGE NUMBERS & CHROME**: Never transcribe standalone page numbers printed in top/bottom corners, margins, headers, or footers (e.g. "۴۷", "۴۸", "48", "صفحه ۴۸", "Page 48"), repetitive running chapter headers/footers, or QR codes.
   - Even if an illustration or photograph occupies most of the page, extract ALL written body paragraphs, headings, and boxes around it verbatim, AND mark each illustration with an image placeholder box (Rule 4).

SHARED RULES FOR BOTH MODES:
2. 100% VERBATIM WORDINGS — ZERO PARAPHRASING, TRANSLATION, OR ADDITIONS:
   - Transcribe every extracted word, sentence, number, heading, subheading, list item, footnote, table cell, equation, and box text 100% VERBATIM in its original language (Persian/Farsi, English, Arabic, or mixed).
   - NEVER paraphrase, summarize, simplify, translate, reword, fix wording, or invent titles/labels that are not printed in the text.
   - Double-check script accuracy carefully—especially Persian/Farsi letters, word spaces, diacritics, and ZWNJ (NEVER mix Latin letters into Persian words, and preserve proper word spacing such as "آموختید که", "ساختار", "یاخته‌ای", "رگ‌های").
3. PERSONALIZED STUDY UI FORMATTING (100% VERBATIM — DO NOT ALTER WORDS):
   - Headings: Use # for the primary chapter/article headline, ## for standfirst/subtitle or major section headings, ### for sub-sections or titled boxes/activities, and #### for minor subheadings—using only exact printed heading text.
   - Paragraphs: Separate paragraphs with blank lines (\n\n). Rejoin broken end-of-line word wraps / hyphenations into smooth, natural paragraphs.
   - Interactive Study Highlights (write directly inline around existing printed words WITHOUT backticks and WITHOUT changing any words — keep selective and tasteful, 1–3 key highlights per paragraph):
     - @@concept@@ for named entities, laws, organs, mechanisms, technical systems, or core concepts (e.g. @@Telecommunications Act@@, @@قلب@@).
     - ==key term or metric== for vital terminology, numbers, durations, thresholds, or definitions to remember (e.g. ==50,000 households==, ==100 hours==).
     - ++takeaway or safeguard++ for key solutions, rules, protective outcomes, or conclusions.
     - !!risk or caveat!! for failures, disruptions, limitations, warnings, or common exam traps.
     - **bold** and *italic* for structural anchors and emphasis (keeping asterisks cleanly paired in bidirectional RTL/LTR text; never wrap Persian/Arabic mid-word).
     - ^^step 1 -> step 2 -> step 3^^ ONLY when the printed text explicitly states a sequential causal flow/pathway whose verbatim step phrases naturally connect with arrows without rewording.
   - Lists & Tables: Clean Markdown bulleted/numbered lists and tables ONLY when part of the main prose/article—never from diagram labels or website nav/share buttons.
   - Kinetic Callout Cards & Blockquotes (wrap existing verbatim boxes/paragraphs/quotes cleanly WITHOUT inventing extra prose):
     - Prefix boxed/important study sections directly with > [!KEY] (central rule/finding), > [!EXAMPLE] (worked example or real-world case study), > [!TRAP] (warning/limitation/pitfall), > [!VOCAB] (terminology/واژه‌شناسی), > [!PROCESS] (numbered/bulleted multi-step sequence), or > [!COMPARE] (contrast).
     - Keep multi-paragraph callout cards continuous by starting empty divider lines inside the card with >.
     - Plain quotes use regular > blockquotes.
   - Math & Formulas: Inline $...$ and display $$...$$.
   - Reading Order: For multi-column book prose, read each column completely in natural reading order (RTL for Persian/Arabic, LTR for English). For webpages, ignore UI/ad sidebars completely and read only the main article column.
4. IMAGE PLACEHOLDER BOXES WITH SUBTITLES ([[IMAGE_BOX: subtitle]]):
   - Place ONE standalone line [[IMAGE_BOX: <subtitle>]] at the exact reading position of each meaningful, clearly visible main-content illustration, diagram, or editorial photograph.
   - If the figure has a printed caption/subtitle (e.g. "شکل ۱ـ قلب و رگ‌های متصل به آن" or "'It was the Twilight Zone' ... Photograph: Evan Agostini/AP"), put that EXACT printed caption verbatim inside [[IMAGE_BOX: ...]] and do NOT repeat that caption as a separate line outside the tag.
   - On a "book_page", if an uncaptioned full textbook illustration appears (e.g. a chapter opener illustration), write a brief clear descriptive subtitle in the textbook's primary language. On a "webpage", NEVER invent placeholder boxes for cut-off edge slivers, ads, logos, avatars, or decorative UI.
   - NEVER emit [[IMAGE_BOX: ...]] for QR codes, margin page-number icons, tiny decorative ornaments, or page borders.
   - NEVER emit [[IMG-N]] tags.`,
          ...(model === 'gemini-3.5-flash-lite'
            ? {}
            : { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              sourceType: {
                type: Type.STRING,
                description: 'Either "webpage" (website/news/blog/docs screenshot with UI chrome, ads, or sidebars) or "book_page" (textbook/PDF/handout/slide).',
              },
              markdown: {
                type: Type.STRING,
                description:
                  'Complete verbatim structured main-content Markdown/LaTeX extracted from the image (with all webpage chrome, ads, sidebars, and UI noise excluded when sourceType is webpage), including [[IMAGE_BOX: subtitle]] lines where main figures belong.',
              },
            },
            required: ['sourceType', 'markdown'],
          },
        },
      });

      const rawText = (response.text ?? '{}').trim();
      const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const jsonCandidate = fenced?.[1] ? fenced[1].trim() : rawText;
      parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < delays.length && (isTransientError(err) || err instanceof SyntaxError)) {
        await waitWithAbort(delays[attempt]);
        continue;
      }
      throw err;
    }
  }

  if (!parsed) {
    throw lastError instanceof Error ? lastError : new Error('Failed to parse textbook page analysis.');
  }

  let blocks: AnalyzedTextbookBlock[] = [];
  const markdown = typeof parsed.markdown === 'string' ? parsed.markdown.trim() : '';

  if (markdown) {
    blocks = parseAnalyzedMarkdownWithImageBoxes(markdown);
  } else if (Array.isArray(parsed.blocks)) {
    for (const raw of parsed.blocks as Array<Record<string, unknown>>) {
      if (raw?.type === 'figure') {
        blocks.push({
          type: 'figure',
          caption: typeof raw.caption === 'string' ? raw.caption.trim() : '',
        });
      } else if (typeof raw?.content === 'string' && raw.content.trim()) {
        blocks.push(...parseAnalyzedMarkdownWithImageBoxes(raw.content));
      }
    }
  }

  const sourceType: AnalyzedTextbookPageResult['sourceType'] =
    parsed.sourceType === 'webpage'
      ? 'webpage'
      : parsed.sourceType === 'book_page'
        ? 'book_page'
        : guidance?.expectedSourceType;

  const hasText = blocks.some((b) => b.type === 'text' && Boolean(b.content?.trim()));
  const hasFigure = blocks.some((b) => b.type === 'figure');
  const pageKind: AnalyzedTextbookPageResult['pageKind'] =
    hasText && hasFigure ? 'mixed' : hasFigure ? 'visual_only' : 'text_only';

  return { pageKind, sourceType, blocks };
}

export async function analyzeTextbookPagesWithGemini(params: {
  model?: GeminiModel;
  pages: TextbookPageInput[];
  documentContext?: string;
}): Promise<AnalyzedTextbookPageResult[]> {
  if (!Array.isArray(params.pages) || params.pages.length === 0) {
    return [];
  }

  let plan: TextbookBatchPlan | null = null;
  if (params.pages.length > 1) {
    try {
      plan = await planTextbookBatchWithGemini(params);
    } catch {
      plan = null;
    }
  }

  let runningContext = (params.documentContext || '').trim();
  const results: AnalyzedTextbookPageResult[] = [];

  for (let i = 0; i < params.pages.length; i++) {
    const pagePlan = plan?.pages[i];
    const pageResult = await analyzeTextbookPageWithGemini({
      model: params.model,
      imageDataUrl: params.pages[i].imageDataUrl,
      mimeType: params.pages[i].mimeType,
      pageNumber: params.pages[i].pageNumber,
      documentContext: runningContext || undefined,
      batchGuidance: plan
        ? {
            primaryLanguage: plan.primaryLanguage,
            chapterContext: plan.chapterContext,
            expectedPageKind: pagePlan?.pageKind,
            expectedSourceType: pagePlan?.sourceType,
            expectedFigureCaptions: pagePlan?.figureCaptions,
          }
        : undefined,
    });
    results.push(pageResult);

    const addedText = pageResult.blocks
      .filter((b) => b.type === 'text' && b.content)
      .map((b) => b.content!.trim())
      .join('\n\n');
    if (addedText) {
      runningContext = `${runningContext}\n\n${addedText}`.trim().slice(-1200);
    }
  }

  return results;
}

export interface ScrapedTextbookWebpageResult {
  url: string;
  title: string;
  pageKind: 'text_only' | 'visual_only' | 'mixed';
  sourceType: 'webpage';
  blocks: AnalyzedTextbookBlock[];
}

interface TavilyExtractResultItem {
  url: string;
  raw_content: string;
  images?: string[];
  title?: string;
}

interface TavilyExtractFailedItem {
  url: string;
  error: string;
}

async function callTavilyExtract(
  tavilyKey: string,
  urls: string[],
  extractDepth: 'advanced' | 'basic'
): Promise<{
  results: TavilyExtractResultItem[];
  failedResults: TavilyExtractFailedItem[];
}> {
  const upstream = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      urls,
      extract_depth: extractDepth,
      format: 'markdown',
      include_images: true,
    }),
  });

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    throw new Error(
      `Tavily extract error (${upstream.status}): ${txt.slice(0, 200) || upstream.statusText}`
    );
  }

  const data = (await upstream.json()) as {
    results?: Array<Record<string, unknown>>;
    failed_results?: Array<Record<string, unknown>>;
  };

  const results: TavilyExtractResultItem[] = Array.isArray(data?.results)
    ? data.results
        .map((r) => ({
          url: String(r?.url || ''),
          raw_content: String(r?.raw_content || ''),
          images: Array.isArray(r?.images) ? r.images.map((img) => String(img)) : [],
          title: typeof r?.title === 'string' && r.title.trim() ? r.title.trim() : undefined,
        }))
        .filter((r) => Boolean(r.url && r.raw_content.trim()))
    : [];

  const failedResults: TavilyExtractFailedItem[] = Array.isArray(data?.failed_results)
    ? data.failed_results.map((f) => ({
        url: String(f?.url || ''),
        error: String(f?.error || 'Could not extract page content.'),
      }))
    : [];

  return { results, failedResults };
}

function inferTitleFromMarkdownOrUrl(markdown: string, url: string): string {
  const headingMatch = markdown.match(/^#{1,2}\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].replace(/\s+/g, ' ').trim();
  }
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

async function fetchWebpageHtmlMetadata(url: string): Promise<WebpageHtmlMetadata> {
  const delays = [350];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(5000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) {
        if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < delays.length) {
          await waitWithAbort(delays[attempt]);
          continue;
        }
        return {};
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.includes('html') && !ct.includes('xml')) {
        return {};
      }
      const html = await res.text();
      return extractWebpageMetadataFromHtml(html.slice(0, 260000), res.url || url);
    } catch {
      if (attempt < delays.length) {
        await waitWithAbort(delays[attempt]);
        continue;
      }
      return {};
    }
  }
  return {};
}

async function structureScrapedWebpageWithGemini(params: {
  model?: GeminiModel;
  url: string;
  rawContent: string;
  suggestedTitle?: string;
  authorHint?: string;
  publishedDateHint?: string;
  heroImageAlt?: string;
  heroImageUrl?: string;
  images?: string[];
  documentContext?: string;
}): Promise<{ title: string; markdown: string }> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const contextHint = (params.documentContext || '').trim().slice(0, 1000);
  const precleaned = precleanWebpageMarkdown(params.rawContent);
  const clippedContent = (precleaned || params.rawContent.trim()).slice(0, 110000);
  const imageCountNote =
    Array.isArray(params.images) && params.images.length > 0
      ? `\nExtracted article image URLs (${params.images.length}): ${params.images.slice(0, 3).join(', ')}`
      : '';
  const bylineLine = [params.authorHint, params.publishedDateHint].filter(Boolean).join(' · ');

  const promptText = [
    `Source URL: ${params.url}${imageCountNote}`,
    params.suggestedTitle ? `REQUIRED Top-Level Article Headline (MUST open with # heading): ${params.suggestedTitle}` : '',
    bylineLine ? `Article Header Byline / Date (if omitted from scraped body): ${bylineLine}` : '',
    params.heroImageUrl
      ? `Editorial Hero Photo Present at Top (${params.heroImageUrl})${params.heroImageAlt ? ` — Caption/Alt: ${params.heroImageAlt}` : ' — include concise [[IMAGE_BOX: ...]] right under the header if not already in body'}`
      : '',
    contextHint
      ? `PRECEDING TEXTBOOK CONTEXT (keep heading hierarchy aligned if relevant):\n"""\n${contextHint}\n"""`
      : '',
    `RAW SCRAPED WEBPAGE MARKDOWN:\n"""\n${clippedContent}\n"""`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const delays = [800, 1800];
  let responseText = '';
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: promptText,
        config: {
          systemInstruction: `You are a precision website reader-mode extractor & Personalized Study UI formatter. You receive raw Markdown scraped from a webpage and optional verified page-header metadata, and must output ONLY the clean primary article, essay, post, or documentation—keeping EVERY article word 100% VERBATIM while removing webpage chrome AND bringing the text alive using Talk's rich interactive UI markup!

RULES:
1. MANDATORY TITLE, BYLINE & OUTPUT FORMAT:
   - Output ONLY the formatted Markdown directly. Do NOT wrap output in \`\`\`markdown fences, JSON, or commentary.
   - ALWAYS start line 1 with \`# <exact primary article headline>\`! Use the provided Article Headline whenever the raw scraped body skipped it. NEVER skip the main article title.
   - If a standfirst/subheadline or verified Byline/Date header is present at the top (e.g. \`*Ryan Daws · 26th November 2026*\`), include it cleanly right beneath \`# Title\`, and use \`## <exact section heading>\` / \`### <subsection>\` for sections.
2. STRICTLY STRIP ALL WEBPAGE CHROME, PROMOS, & UI NOISE:
   - Remove accessibility skip links, carousel controls ("Close dialogue 1/3", "Next image", "Previous image"), site mastheads/logos, navbars, breadcrumbs, category pills, cookie/privacy notices, and copyright footers.
   - Remove ALL donation, fundraiser, membership, paywall, & subscription widgets ("Support the Guardian", "Collapse banner", "Subscribe", "Sign in", etc.).
   - Remove advertisements, social share bars, author-bio sidebars sitting outside the article prose, comments, and "Related stories" / "More on this story" link lists.
   - Convert inline Markdown links \`[anchor text](https://...)\` in prose to plain readable text \`anchor text\`—NEVER output raw URLs or tracking links.
3. 100% VERBATIM WORDING — ZERO PARAPHRASING OR INVENTED PROSE:
   - Keep EVERY kept article word, headline, subtitle, quote, paragraph, list item, table cell, code block, and mathematical expression 100% VERBATIM in exact reading order and original language.
   - Fix obvious HTML drop-cap splits if the first word of a paragraph is broken by one letter + space (e.g. \`M ike Leigh\` -> \`Mike Leigh\`).
   - NEVER paraphrase, summarize, translate, reorder, or add explanatory sentences/labels that are not part of the article!
4. UNLEASH TALK'S PERSONALIZED STUDY UI FORMATTING (APPLIED DIRECTLY ON VERBATIM WORDS):
   Make the reading experience vivid, scannable, and alive by applying Talk's supported interactive tokens directly onto existing verbatim spans—NEVER wrap tokens in backticks and NEVER invent extra words:
   - \`@@entity / system / regulation / core concept@@\` -> Kinetic sky glass node (e.g. \`@@Federal Network Agency@@\`, \`@@crisis core network@@\`, \`@@Telecommunications Act@@\`).
   - \`==metric / figure / threshold / key term==\` -> Animated amber ink-sweep highlight (e.g. \`==50,000 households==\`, \`==100 hours==\`, \`==security and network availability==\`).
   - \`++core takeaway / protection / goal++\` -> Emerald verified takeaway highlight (e.g. \`++preserve basic mobile services++\`).
   - \`!!disruption / incident / caveat / warning!!\` -> High-alert rose trap/warning chip (e.g. \`!!arson attack on power pylons!!!\`, \`!!It doesn't itself impose binding obligations!!\`).
   - \`**bold**\` -> Typographic anchor emphasis on key items/phrases (1–3 targeted highlights + bold anchors per paragraph; restrained and readable, never clutter every word).
   - \`^^step 1 -> step 2 -> step 3^^\` -> Kinetic connected-train diagram ONLY when exact verbatim phrases naturally form an explicit causal sequence without rewriting words.
   - Kinetic Study Callout Cards (wrap high-value verbatim paragraphs/sections cleanly without adding extra words—keep every line inside a multi-paragraph callout prefixed with \`>\`, including \`>\` on blank divider lines):
     - \`> [!KEY]\` -> Wrap the central policy rule, thesis, or critical takeaway paragraph verbatim.
     - \`> [!EXAMPLE]\` -> Wrap real-world examples or case-study paragraphs (such as specific outage incidents) verbatim.
     - \`> [!TRAP]\` -> Wrap major warnings, caveats, non-binding limitations, or risk sections verbatim.
     - \`> [!PROCESS]\` -> Wrap numbered/bulleted multi-step sequences cleanly verbatim.
     - \`> [!VOCAB]\` / \`> [!COMPARE]\` -> Wrap verbatim definitions or direct A vs B comparisons cleanly.
     - Standard \`>\` blockquotes -> For direct verbatim quotes from people or reports.
   - Use clean Markdown lists (\`-\` or \`1.\`), Markdown comparison tables when structured comparisons exist, and KaTeX \`$...$\` / \`$$...$$\` + fenced code blocks where appropriate.
5. EDITORIAL ARTICLE IMAGE BOXES (\`[[IMAGE_BOX: ...]]\`):
   - Emit standalone \`[[IMAGE_BOX: <caption or concise subject description>]]\` at the exact position of genuine editorial photos, charts, or diagrams in the main article (including the main hero photo right under the headline/byline if an editorial hero photo was detected).
   - Strip generic prefixes like \`Image 1:\`; if a printed caption follows an image, put it inside \`[[IMAGE_BOX: ...]]\` without duplicating it beneath.
   - NEVER emit \`[[IMAGE_BOX: ...]]\` for logos, author avatars, social icons, ads, or related-story thumbnails.
   - NEVER output raw \`![...](...)\` or \`[[IMG-N]]\`.`,
          ...(model === 'gemini-3.5-flash-lite'
            ? {}
            : { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
        },
      });
      responseText = response.text ?? '';
      break;
    } catch (err) {
      lastError = err;
      if (attempt < delays.length && isTransientError(err)) {
        await waitWithAbort(delays[attempt]);
        continue;
      }
      throw err;
    }
  }

  if (!responseText && lastError) {
    throw lastError;
  }

  const cleanedMd = responseText
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, '$1')
    .trim();
  const title =
    (params.suggestedTitle || '').trim() ||
    inferTitleFromMarkdownOrUrl(cleanedMd, params.url);
  const markdown = ensureWebpageMarkdownHasTitle(cleanedMd, params.suggestedTitle);
  return { title, markdown };
}

function parseJinaReaderMarkdown(raw: string): { title: string; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  const titleMatch = normalized.match(/^Title:\s*(.+)$/m);
  const title = titleMatch?.[1]?.trim() || '';
  const markerIdx = normalized.indexOf('Markdown Content:');
  let body =
    markerIdx !== -1
      ? normalized.slice(markerIdx + 'Markdown Content:'.length).trim()
      : normalized.replace(/^(?:Title|URL Source|Published Time|Warning):[^\n]*\n?/gm, '').trim();

  // Rejoin drop-cap single-letter splits at start of paragraphs (excluding real words "I" and "A")
  body = body.replace(/(^|\n\n)([B-HJ-Z])\s+([a-z]{2,})/g, '$1$2$3');
  return { title, body };
}

async function fetchWithJinaReader(
  url: string
): Promise<{ url: string; raw_content: string; images: string[]; title?: string }> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: 'text/markdown',
    },
  });

  if (!res.ok) {
    throw new Error(`Reader fetch failed (${res.status})`);
  }

  const text = await res.text();
  if (!text.trim() || /Warning:\s*Target URL returned error\s*(?:403|404|5\d\d)/i.test(text.slice(0, 600))) {
    throw new Error('Website blocked automated reader access.');
  }

  const { title, body } = parseJinaReaderMarkdown(text);
  if (body.length < 100) {
    throw new Error('Reader returned insufficient readable article content.');
  }

  const rawContent =
    title && !/^#\s+/m.test(body.slice(0, 200))
      ? `# ${title}\n\n${body}`
      : body;

  return {
    url,
    raw_content: rawContent,
    images: [],
    title,
  };
}

function htmlToRoughMarkdown(html: string, url: string): { title: string; markdown: string } {
  const meta = extractWebpageMetadataFromHtml(html, url);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const fallbackTitle = titleMatch?.[1]
    ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    : '';
  const title = meta.title || fallbackTitle;

  const articleMatch = html.match(/<article\b[\s\S]*?<\/article>/i);
  const mainMatch = html.match(/<main\b[\s\S]*?<\/main>/i);
  const bodyMatch = html.match(/<body\b[\s\S]*?<\/body>/i);
  let scope = articleMatch?.[0] || mainMatch?.[0] || bodyMatch?.[0] || html;

  scope = scope
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const altMatch = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const srcMatch = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const alt = decodeHtmlEntities((altMatch?.[1] || altMatch?.[2] || '').trim());
      const src = (srcMatch?.[1] || srcMatch?.[2] || '').trim();
      if (!alt && !src) return '';
      return `\n\n![${alt || 'Image'}](${src || 'image'})\n\n`;
    })
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => {
      const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '';
    })
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => {
      const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      return text ? `\n\n> ${text}\n\n` : '';
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => {
      const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      return text ? `\n- ${text}` : '';
    })
    .replace(/<(?:p|div|section|br|tr)[^>]*>/gi, '\n\n')
    .replace(/<\/(?:p|div|section|ul|ol|table)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');

  const lines = decodeHtmlEntities(scope)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());
  const markdown = ensureWebpageMarkdownHasTitle(
    lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    title
  );
  return { title, markdown };
}

async function fetchDirectHtmlAsMarkdown(
  url: string
): Promise<{ url: string; raw_content: string; images: string[]; title?: string }> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${res.statusText || 'Blocked'})`);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('text/') && !contentType.includes('html') && !contentType.includes('xml')) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const body = await res.text();
  if (!body.trim() || /just a moment\.\.\.|cf-browser-verification|access denied/i.test(body.slice(0, 1500))) {
    throw new Error('Website blocked automated access.');
  }

  if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
    return { url: res.url || url, raw_content: body.trim(), images: [] };
  }

  const { title, markdown } = htmlToRoughMarkdown(body, res.url || url);
  if (markdown.length < 120) {
    throw new Error('Could not extract readable article body from HTML.');
  }

  return {
    url: res.url || url,
    raw_content: markdown,
    images: [],
    title,
  };
}

async function extractWebpageWithGeminiUrlContext(params: {
  url: string;
  model?: GeminiModel;
  documentContext?: string;
}): Promise<{ title: string; markdown: string } | null> {
  const ai = createGeminiClient();
  const model = params.model || GEMINI_CHAT_MODEL;
  const contextHint = (params.documentContext || '').trim().slice(0, 600);

  const response = await ai.models.generateContent({
    model,
    contents: [
      `Fetch and transcribe the FULL main article from this exact URL verbatim: ${params.url}`,
      contextHint ? `Preceding textbook context:\n${contextHint}` : '',
      [
        'Output ONLY clean Markdown for the primary article:',
        '- Remove all site navbars, accessibility skip links, lightbox/carousel controls, donation/subscription/fundraiser/cookie banners, advertisements, social share bars, related stories, and footers.',
        '- Convert inline links to plain readable anchor text (never output raw URLs or `[text](url)` tracking syntax).',
        '- ALWAYS start with `# <exact article headline>`, optional `*<author · date>*`, and `## <section headings>` as printed, keeping every word of the main article VERBATIM (do NOT summarize or paraphrase).',
        '- Unleash Talk Personalized Study UI formatting directly onto existing verbatim spans (without backticks or changing words): `@@concept/entity@@`, `==key phrase/metric==`, `++takeaway++`, `!!risk/caveat!!`, `**bold**`, and verbatim callout cards `> [!KEY]` / `> [!EXAMPLE]` / `> [!TRAP]` / `> [!PROCESS]` (with `>` on blank lines inside multi-paragraph callouts).',
        '- For genuine editorial photos/diagrams inside the main article body, insert a standalone line `[[IMAGE_BOX: <exact printed caption or concise photo description>]]` at that position.',
        '- If the page cannot be accessed or fetched (e.g. blocked or 403/404), reply ONLY with `[[UNAVAILABLE]]`.',
      ].join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n'),
    config: {
      tools: [{ urlContext: {} }],
      ...(model === 'gemini-3.5-flash-lite'
        ? {}
        : { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
    },
  });

  const candidate = response.candidates?.[0] as
    | { urlContextMetadata?: { urlMetadata?: Array<Record<string, unknown>> } }
    | undefined;
  const metaList = candidate?.urlContextMetadata?.urlMetadata;
  if (Array.isArray(metaList) && metaList.length > 0) {
    const anySuccess = metaList.some((m) =>
      String(m?.urlRetrievalStatus || '').toUpperCase().includes('SUCCESS')
    );
    if (!anySuccess) {
      return null;
    }
  }

  const text = (response.text ?? '').trim();
  if (
    !text ||
    text.includes('[[UNAVAILABLE]]') ||
    text.length < 150 ||
    /cannot access|unable to (?:fetch|access|retrieve)|403|forbidden/i.test(text.slice(0, 300))
  ) {
    return null;
  }

  const title = inferTitleFromMarkdownOrUrl(text, params.url);
  return { title, markdown: text };
}

export async function scrapeTextbookUrlsWithTavily(params: {
  urls: string[];
  documentContext?: string;
  model?: GeminiModel;
}): Promise<{
  pages: ScrapedTextbookWebpageResult[];
  failed: Array<{ url: string; error: string }>;
}> {
  const tavilyKey = (process.env.TAVILY_API_KEY || '').trim();
  if (!tavilyKey) {
    throw new Error(
      'TAVILY_API_KEY is not configured on the server. Add TAVILY_API_KEY in Secrets to scrape website URLs.'
    );
  }

  const urls = params.urls.map((u) => u.trim()).filter(Boolean).slice(0, 5);
  if (urls.length === 0) {
    throw new Error('At least one valid website URL is required.');
  }

  let extracted = await callTavilyExtract(tavilyKey, urls, 'advanced');

  // Retry any URLs that failed advanced extraction using basic extraction once
  if (extracted.failedResults.length > 0) {
    const retryUrls = extracted.failedResults.map((f) => f.url).filter(Boolean);
    if (retryUrls.length > 0) {
      try {
        const fallback = await callTavilyExtract(tavilyKey, retryUrls, 'basic');
        const recoveredUrls = new Set(fallback.results.map((r) => r.url));
        extracted = {
          results: [...extracted.results, ...fallback.results],
          failedResults: [
            ...extracted.failedResults.filter((f) => !recoveredUrls.has(f.url) && !retryUrls.includes(f.url)),
            ...fallback.failedResults,
          ],
        };
      } catch {
        // Keep original advanced failedResults
      }
    }
  }

  const hasGemini = Boolean(getGeminiKey());
  const urlContextPages = new Map<string, { title: string; markdown: string }>();
  const discoveredTitles = new Map<string, string>();

  // Fallback for sites whose CDN blocks Tavily's crawler (e.g. The Guardian HTTP 403):
  // 1) Jina Reader markdown fetch, 2) direct browser-header HTML fetch, 3) Gemini urlContext tool.
  if (extracted.failedResults.length > 0) {
    const remainingFailed: TavilyExtractFailedItem[] = [];
    for (const failItem of extracted.failedResults) {
      let recovered = false;
      let fallbackReason = failItem.error || 'Failed to fetch url';

      try {
        const reader = await fetchWithJinaReader(failItem.url);
        if (precleanWebpageMarkdown(reader.raw_content).length < 200) {
          throw new Error('Reader returned mostly page chrome.');
        }
        if (reader.title) discoveredTitles.set(failItem.url, reader.title);
        extracted.results.push({
          url: failItem.url,
          raw_content: reader.raw_content,
          images: reader.images,
        });
        recovered = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fallbackReason = `${fallbackReason} (reader: ${msg})`;
      }

      if (!recovered) {
        try {
          const direct = await fetchDirectHtmlAsMarkdown(failItem.url);
          if (direct.title) discoveredTitles.set(failItem.url, direct.title);
          extracted.results.push({
            url: failItem.url,
            raw_content: direct.raw_content,
            images: direct.images,
          });
          recovered = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fallbackReason = `${fallbackReason} (direct fetch: ${msg})`;
        }
      }

      if (!recovered && hasGemini) {
        try {
          const fromUrlCtx = await extractWebpageWithGeminiUrlContext({
            url: failItem.url,
            model: params.model,
            documentContext: params.documentContext,
          });
          if (fromUrlCtx) {
            urlContextPages.set(failItem.url, fromUrlCtx);
            extracted.results.push({
              url: failItem.url,
              raw_content: fromUrlCtx.markdown,
              images: [],
            });
            recovered = true;
          }
        } catch {
          // Keep combined fallbackReason
        }
      }

      if (!recovered) {
        const blockedHint = /403|blocked|forbidden/i.test(fallbackReason)
          ? 'This website blocks automated scrapers. Try pasting the article text or screenshots instead.'
          : fallbackReason;
        remainingFailed.push({ url: failItem.url, error: blockedHint });
      }
    }
    extracted.failedResults = remainingFailed;
  }

  if (extracted.results.length === 0) {
    const reason =
      extracted.failedResults[0]?.error ||
      'Could not extract readable content from the pasted URL.';
    throw new Error(reason);
  }

  // Preserve original pasted URL ordering
  const orderMap = new Map(urls.map((u, idx) => [u, idx]));
  extracted.results.sort(
    (a, b) => (orderMap.get(a.url) ?? 999) - (orderMap.get(b.url) ?? 999)
  );

  let runningContext = (params.documentContext || '').trim();
  const pages: ScrapedTextbookWebpageResult[] = [];

  for (const item of extracted.results) {
    let structuredMarkdown = '';
    let title = (item.title || discoveredTitles.get(item.url) || '').trim();
    const needsHtmlMeta =
      !title || !markdownStartsWithArticleTitle(precleanWebpageMarkdown(item.raw_content));
    const htmlMeta = needsHtmlMeta ? await fetchWebpageHtmlMetadata(item.url) : {};
    if (!title && htmlMeta.title) {
      title = htmlMeta.title;
    }

    const preExtracted = urlContextPages.get(item.url);
    if (preExtracted) {
      structuredMarkdown = ensureWebpageMarkdownHasTitle(
        preExtracted.markdown,
        title || preExtracted.title
      );
      title = title || preExtracted.title;
    } else if (hasGemini) {
      try {
        const cleaned = await structureScrapedWebpageWithGemini({
          model: params.model,
          url: item.url,
          rawContent: item.raw_content,
          suggestedTitle: title || undefined,
          authorHint: htmlMeta.author,
          publishedDateHint: htmlMeta.publishedDate,
          heroImageAlt: htmlMeta.heroImageAlt,
          heroImageUrl: htmlMeta.heroImageUrl || item.images?.[0],
          images: item.images,
          documentContext: runningContext || undefined,
        });
        structuredMarkdown = cleaned.markdown;
        title = title || cleaned.title;
      } catch {
        structuredMarkdown = '';
      }
    }

    if (!structuredMarkdown.trim()) {
      structuredMarkdown = cleanScrapedWebpageFallback(item.raw_content);
    }

    structuredMarkdown = ensureWebpageMarkdownHasTitle(structuredMarkdown, title);

    const blocks = parseAnalyzedMarkdownWithImageBoxes(structuredMarkdown);
    const hasText = blocks.some((b) => b.type === 'text' && Boolean(b.content?.trim()));
    const hasFigure = blocks.some((b) => b.type === 'figure');
    const pageKind: ScrapedTextbookWebpageResult['pageKind'] =
      hasText && hasFigure ? 'mixed' : hasFigure ? 'visual_only' : 'text_only';

    pages.push({
      url: item.url,
      title: title || inferTitleFromMarkdownOrUrl(structuredMarkdown, item.url),
      pageKind,
      sourceType: 'webpage',
      blocks,
    });

    const addedText = blocks
      .filter((b) => b.type === 'text' && b.content)
      .map((b) => b.content!.trim())
      .join('\n\n');
    if (addedText) {
      runningContext = `${runningContext}\n\n${addedText}`.trim().slice(-1200);
    }
  }

  return { pages, failed: extracted.failedResults };
}

