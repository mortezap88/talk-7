import type {
  AppSettings,
  ChatAttachment,
  ChatItem,
  ChatMemory,
  ChatMessage,
  ConceptState,
  FlashcardItem,
  GeminiModel,
  NoteData,
  StoredQuestion,
  TextbookData,
  ThinkingLevel,
  TokenUsageSnapshot,
} from '../types/talk';

import { localWorkspaceStore } from '../utils/localStore';
import type { PersistedWorkspace } from '../utils/seedData';
import { firestoreWorkspaceStore } from '../firebase/firestoreStore';

let activeFirebaseUid: string | null = null;
let cachedGeminiModel: GeminiModel | null = null;

async function resolveActiveGeminiModel(explicitModel?: GeminiModel): Promise<GeminiModel> {
  if (explicitModel) return explicitModel;
  if (cachedGeminiModel) return cachedGeminiModel;
  const settings = await talkApi.getSettings();
  cachedGeminiModel = settings.geminiModel;
  return settings.geminiModel;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  const raw = await res.text();
  let data: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }
      const looksHtml = /^\s*</.test(raw);
      throw new Error(
        looksHtml
          ? 'Connection was interrupted before JSON finished. Please try again.'
          : 'Server returned an unexpected non-JSON response. Please try again.'
      );
    }
  }
  if (!res.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`);
  }
  return data as T;
}

export const talkApi = {
  setFirebaseUser(uid: string | null): void {
    activeFirebaseUid = uid;
    cachedGeminiModel = null;
  },

  getFirebaseUserId(): string | null {
    return activeFirebaseUid;
  },

  async listChats(): Promise<ChatItem[]> {
    if (activeFirebaseUid) {
      return firestoreWorkspaceStore.listChats(activeFirebaseUid);
    }
    return localWorkspaceStore.listChats();
  },

  async createChat(title?: string): Promise<ChatItem> {
    if (activeFirebaseUid) {
      return firestoreWorkspaceStore.createChat(activeFirebaseUid, title);
    }
    return localWorkspaceStore.createChat(title);
  },

  async updateChat(
    id: string,
    patch: Partial<Pick<ChatItem, 'title' | 'messages' | 'updatedAt'>>
  ): Promise<ChatItem> {
    if (activeFirebaseUid) {
      return firestoreWorkspaceStore.updateChat(activeFirebaseUid, id, patch);
    }
    return localWorkspaceStore.updateChat(id, patch);
  },

  async deleteChat(id: string): Promise<void> {
    if (activeFirebaseUid) {
      return firestoreWorkspaceStore.deleteChat(activeFirebaseUid, id);
    }
    return localWorkspaceStore.deleteChat(id);
  },

  async kvGet<T>(key: string): Promise<T | null> {
    if (activeFirebaseUid) {
      const colonIdx = key.indexOf(':');
      if (colonIdx !== -1) {
        const prefix = key.slice(0, colonIdx);
        const chatId = key.slice(colonIdx + 1);
        if (prefix === 'note') {
          return (await firestoreWorkspaceStore.getNote(activeFirebaseUid, chatId)) as T | null;
        }
        if (prefix === 'textbook') {
          return (await firestoreWorkspaceStore.getTextbook(activeFirebaseUid, chatId)) as T | null;
        }
        if (prefix === 'questions') {
          return (await firestoreWorkspaceStore.getQuestions(activeFirebaseUid, chatId)) as T | null;
        }
        if (prefix === 'memory') {
          return (await firestoreWorkspaceStore.getMemory(activeFirebaseUid, chatId)) as T | null;
        }
      }
    }
    return localWorkspaceStore.getKv<T>(key);
  },

  async kvSet<T>(key: string, value: T): Promise<T> {
    if (activeFirebaseUid) {
      const colonIdx = key.indexOf(':');
      if (colonIdx !== -1) {
        const prefix = key.slice(0, colonIdx);
        const chatId = key.slice(colonIdx + 1);
        if (prefix === 'note') {
          return (await firestoreWorkspaceStore.saveNote(
            activeFirebaseUid,
            chatId,
            value as unknown as NoteData
          )) as unknown as T;
        }
        if (prefix === 'textbook') {
          return (await firestoreWorkspaceStore.saveTextbook(
            activeFirebaseUid,
            chatId,
            value as unknown as TextbookData
          )) as unknown as T;
        }
        if (prefix === 'questions') {
          return (await firestoreWorkspaceStore.saveQuestions(
            activeFirebaseUid,
            chatId,
            value as unknown as StoredQuestion[]
          )) as unknown as T;
        }
        if (prefix === 'memory') {
          return (await firestoreWorkspaceStore.saveMemory(
            activeFirebaseUid,
            chatId,
            value as unknown as ChatMemory
          )) as unknown as T;
        }
      }
    }
    return localWorkspaceStore.setKv<T>(key, value);
  },

  async listCards(chatId?: string): Promise<FlashcardItem[]> {
    if (activeFirebaseUid) {
      return firestoreWorkspaceStore.listCards(activeFirebaseUid, chatId);
    }
    return localWorkspaceStore.listCards(chatId);
  },

  async createCard(input: {
    chatId: string;
    questionId: string;
    question: string;
    answer: string;
    subject: string;
  }): Promise<FlashcardItem> {
    if (activeFirebaseUid) {
      return firestoreWorkspaceStore.createCard(activeFirebaseUid, input);
    }
    return localWorkspaceStore.createCard(input);
  },

  async updateCard(
    id: string,
    patch: Partial<Pick<FlashcardItem, 'question' | 'answer' | 'status' | 'subject'>>
  ): Promise<FlashcardItem> {
    if (activeFirebaseUid) {
      return firestoreWorkspaceStore.updateCard(activeFirebaseUid, id, patch);
    }
    return localWorkspaceStore.updateCard(id, patch);
  },

  async deleteCard(id: string): Promise<void> {
    if (activeFirebaseUid) {
      return firestoreWorkspaceStore.deleteCard(activeFirebaseUid, id);
    }
    return localWorkspaceStore.deleteCard(id);
  },

  async listSubjects(): Promise<string[]> {
    if (activeFirebaseUid) {
      return firestoreWorkspaceStore.listSubjects(activeFirebaseUid);
    }
    return localWorkspaceStore.listSubjects();
  },

  async getSettings(): Promise<AppSettings> {
    const settings = activeFirebaseUid
      ? await firestoreWorkspaceStore.getSettings(activeFirebaseUid)
      : await localWorkspaceStore.getSettings();
    cachedGeminiModel = settings.geminiModel;
    return settings;
  },

  async updateSettings(
    patch: Partial<Pick<AppSettings, 'provider' | 'geminiModel' | 'thinkingLevel' | 'themeMode'>>
  ): Promise<AppSettings> {
    const saved = activeFirebaseUid
      ? await firestoreWorkspaceStore.updateSettings(activeFirebaseUid, patch)
      : await localWorkspaceStore.updateSettings(patch);
    cachedGeminiModel = saved.geminiModel;
    return saved;
  },

  async exportWorkspace(): Promise<PersistedWorkspace> {
    return localWorkspaceStore.exportWorkspace();
  },

  async importWorkspace(raw: unknown): Promise<PersistedWorkspace> {
    return localWorkspaceStore.importWorkspace(raw);
  },

  async resetWorkspace(): Promise<PersistedWorkspace> {
    return localWorkspaceStore.resetWorkspace();
  },

  async windowAction(_action: 'minimize' | 'maximize' | 'fullscreen' | 'close'): Promise<void> {
    // No-op in browser environment
  },

  async streamChat(
    payload: {
      requestId: string;
      chatId: string;
      messages: ChatMessage[];
      systemPrompt: string;
      thinkingLevel: ThinkingLevel;
      textbookImages: ChatAttachment[];
    },
    handlers: {
      onChunk: (requestId: string, delta: string) => void;
      onDone: (
        requestId: string,
        fullText?: string,
        cancelled?: boolean,
        usage?: TokenUsageSnapshot
      ) => void;
      onError: (requestId: string, error: string) => void;
    }
  ): Promise<void> {
    const geminiModel = await resolveActiveGeminiModel();
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, model: geminiModel }),
    });

    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({}));
      handlers.onError(
        payload.requestId,
        typeof errData?.error === 'string' ? errData.error : `Chat request failed (${res.status})`
      );
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedTerminal = false;

    const processBlock = (block: string) => {
      const lines = block.split('\n');
      let currentEvent = 'message';
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLine += line.slice(5).trim();
        }
      }
      if (!dataLine) return;
      try {
        const parsed = JSON.parse(dataLine);
        if (currentEvent === 'ai:chunk') {
          handlers.onChunk(parsed.requestId, parsed.delta || '');
        } else if (currentEvent === 'ai:done') {
          receivedTerminal = true;
          handlers.onDone(
            parsed.requestId,
            parsed.fullText,
            parsed.cancelled,
            parsed.usage as TokenUsageSnapshot | undefined
          );
        } else if (currentEvent === 'ai:error') {
          receivedTerminal = true;
          handlers.onError(parsed.requestId, parsed.error || 'Unknown streaming error');
        }
      } catch {
        // ignore unparseable event frame
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const block of chunks) {
        if (block.trim()) processBlock(block);
      }
    }

    if (buffer.trim()) {
      processBlock(buffer);
    }

    if (!receivedTerminal) {
      handlers.onDone(payload.requestId, undefined, false);
    }
  },

  async cancelChat(requestId: string): Promise<void> {
    await jsonRequest('/api/ai/cancel', {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    });
  },

  async countTokens(payload: {
    messages: ChatMessage[];
    systemPrompt: string;
    textbookImages?: ChatAttachment[];
  }): Promise<{ totalTokens: number; model: string }> {
    const geminiModel = await resolveActiveGeminiModel();
    return jsonRequest('/api/ai/count-tokens', {
      method: 'POST',
      body: JSON.stringify({ ...payload, model: geminiModel }),
    });
  },

  async summarizeMemory(payload: {
    stage: 1 | 2 | 3;
    inputTokens: number;
    messages?: ChatMessage[];
    packs?: Array<{ stage: number; summary: string; bullets: string[] }>;
  }): Promise<{ summary: string; bullets: string[] }> {
    const geminiModel = await resolveActiveGeminiModel();
    return jsonRequest('/api/ai/summarize', {
      method: 'POST',
      body: JSON.stringify({ ...payload, model: geminiModel }),
    });
  },

  async updateLearnerState(payload: {
    currentState: ConceptState[];
    messages: ChatMessage[];
  }): Promise<{ concepts: ConceptState[] }> {
    const geminiModel = await resolveActiveGeminiModel();
    return jsonRequest('/api/ai/update-learner-state', {
      method: 'POST',
      body: JSON.stringify({ ...payload, model: geminiModel }),
    });
  },

  async transcribeAudio(blob: Blob, filename?: string): Promise<{ text: string }> {
    const resolvedName =
      filename || (blob.type.includes('wav') ? 'recording.wav' : 'recording.webm');
    const form = new FormData();
    form.append('file', blob, resolvedName);
    const res = await fetch('/api/ai/transcribe', {
      method: 'POST',
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data?.error === 'string' ? data.error : `Transcription failed (${res.status})`);
    }
    return data as { text: string };
  },

  async webSearch(query: string): Promise<{
    answer: string;
    results: Array<{ title: string; url: string; content: string }>;
  }> {
    return jsonRequest('/api/web-search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  },

  async analyzeTextbookPage(payload: {
    imageDataUrl: string;
    mimeType: string;
    pageNumber: number;
    documentContext?: string;
    model?: GeminiModel;
    batchGuidance?: {
      primaryLanguage?: string;
      chapterContext?: string;
      expectedPageKind?: 'text_only' | 'visual_only' | 'mixed';
      expectedSourceType?: 'book_page' | 'webpage';
      expectedFigureCaptions?: string[];
    };
  }): Promise<{
    pageKind: 'text_only' | 'visual_only' | 'mixed';
    sourceType?: 'book_page' | 'webpage';
    blocks: Array<{
      type: 'text' | 'figure';
      content?: string;
      caption?: string;
      box_2d?: [number, number, number, number];
      align?: 'left' | 'center' | 'right' | 'full';
      widthPct?: number;
    }>;
  }> {
    return postSseResultRequest('/api/ai/analyze-textbook-page', payload);
  },

  async planTextbookBatch(payload: {
    pages: Array<{
      imageDataUrl: string;
      mimeType: string;
      pageNumber: number;
    }>;
    documentContext?: string;
    model?: GeminiModel;
  }): Promise<{
    primaryLanguage: string;
    chapterContext: string;
    pages: Array<{
      pageIndex: number;
      pageKind: 'text_only' | 'visual_only' | 'mixed';
      sourceType?: 'book_page' | 'webpage';
      figureCaptions: string[];
    }>;
  }> {
    return postSseResultRequest('/api/ai/plan-textbook-batch', payload);
  },

  async analyzeTextbookPages(payload: {
    pages: Array<{
      imageDataUrl: string;
      mimeType: string;
      pageNumber: number;
    }>;
    documentContext?: string;
    model?: GeminiModel;
  }): Promise<{
    pages: Array<{
      pageKind: 'text_only' | 'visual_only' | 'mixed';
      blocks: Array<{
        type: 'text' | 'figure';
        content?: string;
        caption?: string;
        box_2d?: [number, number, number, number];
        align?: 'left' | 'center' | 'right' | 'full';
        widthPct?: number;
      }>;
    }>;
  }> {
    return postSseResultRequest('/api/ai/analyze-textbook-pages', payload);
  },

  async scrapeTextbookUrls(payload: {
    urls: string[];
    documentContext?: string;
    model?: GeminiModel;
  }): Promise<{
    pages: Array<{
      url: string;
      title: string;
      pageKind: 'text_only' | 'visual_only' | 'mixed';
      sourceType?: 'webpage';
      blocks: Array<{
        type: 'text' | 'figure';
        content?: string;
        caption?: string;
      }>;
    }>;
    failed?: Array<{ url: string; error: string }>;
  }> {
    return postSseResultRequest('/api/ai/scrape-textbook-urls', payload);
  },
};

async function postSseResultRequest<T>(url: string, payload: Record<string, unknown>): Promise<T> {
  const explicit =
    typeof payload.model === 'string' ? (payload.model as GeminiModel) : undefined;
  const geminiModel = await resolveActiveGeminiModel(explicit);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...payload, model: geminiModel, stream: true }),
  });

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    try {
      const errData = JSON.parse(raw) as Record<string, unknown>;
      if (typeof errData?.error === 'string') {
        throw new Error(errData.error);
      }
    } catch (e) {
      if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
    }
    throw new Error(`Request failed (${res.status})`);
  }

  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }

  if (!contentType.includes('text/event-stream')) {
    await res.text().catch(() => '');
    throw new Error('Connection was interrupted before analysis completed. Please try again.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: T | null = null;
  let streamError: string | null = null;

  const handleFrame = (frame: string) => {
    const lines = frame.split('\n');
    let eventName = 'message';
    let dataLine = '';
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLine += line.slice(5).trim();
      }
    }
    if (!dataLine) return;
    try {
      const parsed = JSON.parse(dataLine) as Record<string, unknown>;
      if (eventName === 'result') {
        finalResult = parsed as unknown as T;
      } else if (eventName === 'error') {
        streamError =
          typeof parsed?.error === 'string'
            ? parsed.error
            : 'Textbook page analysis failed.';
      }
    } catch {
      // ignore unparseable frame
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      if (frame.trim()) handleFrame(frame);
    }
  }

  if (buffer.trim()) {
    handleFrame(buffer);
  }

  if (streamError) {
    throw new Error(streamError);
  }
  if (!finalResult) {
    throw new Error('Analysis stream ended unexpectedly. Please try again.');
  }
  return finalResult;
}

export type { NoteData, StoredQuestion, TextbookData, ChatMemory };
