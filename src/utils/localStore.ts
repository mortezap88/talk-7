import type {
  AppSettings,
  ChatItem,
  ChatMemory,
  FlashcardItem,
  NoteData,
  StoredQuestion,
  TextbookData,
} from '../types/talk';
import {
  createSeedWorkspace,
  VALID_GEMINI_MODELS,
  type PersistedWorkspace,
} from './seedData';

const IDB_NAME = 'talk_study_workspace';
const IDB_VERSION = 1;
const IDB_STORE = 'workspace';
const IDB_KEY = 'state';
const LS_FALLBACK_KEY = 'talk_study_workspace_v1';

export const DEFAULT_STT_MODEL = 'gemini-3.5-transcribe';

export interface WorkspaceStorageBackend {
  load(): Promise<PersistedWorkspace | null>;
  save(data: PersistedWorkspace): Promise<void>;
}

function cloneWorkspace(data: PersistedWorkspace): PersistedWorkspace {
  if (typeof structuredClone === 'function') {
    return structuredClone(data);
  }
  return JSON.parse(JSON.stringify(data)) as PersistedWorkspace;
}

export function normalizeWorkspace(raw: unknown): PersistedWorkspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<PersistedWorkspace>;
  if (!Array.isArray(candidate.chats) || !candidate.kv || typeof candidate.kv !== 'object') {
    return null;
  }

  const seedSettings = createSeedWorkspace().settings;
  const rawSettings = candidate.settings;
  const geminiModel =
    rawSettings?.geminiModel && VALID_GEMINI_MODELS.includes(rawSettings.geminiModel)
      ? rawSettings.geminiModel
      : seedSettings.geminiModel;
  const thinkingLevel =
    rawSettings?.thinkingLevel &&
    ['low', 'medium', 'high', 'xhigh'].includes(rawSettings.thinkingLevel)
      ? rawSettings.thinkingLevel
      : seedSettings.thinkingLevel;
  const themeMode =
    rawSettings?.themeMode && ['system', 'light', 'dark'].includes(rawSettings.themeMode)
      ? rawSettings.themeMode
      : seedSettings.themeMode;

  return {
    version: 1,
    chats: candidate.chats,
    kv: { ...candidate.kv },
    cards: Array.isArray(candidate.cards) ? candidate.cards : [],
    subjects: Array.isArray(candidate.subjects)
      ? candidate.subjects
      : ['Biology', 'Organic Chemistry', 'Biochemistry', 'General Study'],
    settings: {
      provider: 'gemini',
      geminiModel,
      thinkingLevel,
      themeMode,
    },
  };
}

export class MemoryStorageBackend implements WorkspaceStorageBackend {
  private snapshot: PersistedWorkspace | null = null;

  constructor(initial?: PersistedWorkspace | null) {
    this.snapshot = initial ? cloneWorkspace(initial) : null;
  }

  async load(): Promise<PersistedWorkspace | null> {
    return this.snapshot ? cloneWorkspace(this.snapshot) : null;
  }

  async save(data: PersistedWorkspace): Promise<void> {
    this.snapshot = cloneWorkspace(data);
  }
}

function openWorkspaceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

export class BrowserWorkspaceBackend implements WorkspaceStorageBackend {
  async load(): Promise<PersistedWorkspace | null> {
    if (typeof indexedDB !== 'undefined') {
      try {
        const db = await openWorkspaceDb();
        try {
          const loaded = await new Promise<unknown>((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const req = store.get(IDB_KEY);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
          });
          const normalized = normalizeWorkspace(loaded);
          if (normalized) return normalized;
        } finally {
          db.close();
        }
      } catch {
        // Fall through to localStorage fallback
      }
    }

    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(LS_FALLBACK_KEY);
        if (raw) {
          return normalizeWorkspace(JSON.parse(raw));
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  async save(data: PersistedWorkspace): Promise<void> {
    if (typeof indexedDB !== 'undefined') {
      try {
        const db = await openWorkspaceDb();
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            store.put(data, IDB_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
          });
          return;
        } finally {
          db.close();
        }
      } catch {
        // Fall through to localStorage fallback
      }
    }

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(data));
    }
  }
}

export class LocalWorkspaceStore {
  private backend: WorkspaceStorageBackend;
  private data: PersistedWorkspace | null = null;
  private initPromise: Promise<PersistedWorkspace> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(backend: WorkspaceStorageBackend) {
    this.backend = backend;
  }

  private async ensureLoaded(): Promise<PersistedWorkspace> {
    if (this.data) return this.data;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const existing = await this.backend.load();
        const normalized = normalizeWorkspace(existing);
        if (normalized) {
          this.data = normalized;
          return normalized;
        }
        const seed = createSeedWorkspace();
        this.data = seed;
        await this.backend.save(seed);
        return seed;
      })();
    }
    return this.initPromise;
  }

  private persist(): Promise<void> {
    if (!this.data) return Promise.resolve();
    const snapshot = cloneWorkspace(this.data);
    this.writeQueue = this.writeQueue.then(() => this.backend.save(snapshot));
    return this.writeQueue;
  }

  async listChats(): Promise<ChatItem[]> {
    const data = await this.ensureLoaded();
    return [...data.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createChat(title?: string): Promise<ChatItem> {
    const data = await this.ensureLoaded();
    const now = Date.now();
    const id = `chat_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const chat: ChatItem = {
      id,
      title: title?.trim() || 'New study chat',
      messages: [],
      updatedAt: now,
    };
    data.chats.unshift(chat);
    data.kv[`note:${id}`] = { title: '', body: '', tags: [], updatedAt: now } satisfies NoteData;
    data.kv[`questions:${id}`] = [] satisfies StoredQuestion[];
    data.kv[`textbook:${id}`] = { title: '', body: '', images: [], updatedAt: 0 } satisfies TextbookData;
    data.kv[`memory:${id}`] = {
      version: 2,
      compactedCount: 0,
      compactedTokens: 0,
      epoch: 0,
      learnerState: [],
      packs: [],
      updatedAt: now,
    } satisfies ChatMemory;
    await this.persist();
    return cloneWorkspace({ ...data, chats: [chat] }).chats[0];
  }

  async updateChat(
    id: string,
    patch: Partial<Pick<ChatItem, 'title' | 'messages' | 'updatedAt'>>
  ): Promise<ChatItem> {
    const data = await this.ensureLoaded();
    const idx = data.chats.findIndex((c) => c.id === id);
    if (idx === -1) {
      throw new Error('Chat not found');
    }
    const current = data.chats[idx];
    const updated: ChatItem = {
      ...current,
      ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
      ...(Array.isArray(patch.messages) ? { messages: patch.messages } : {}),
      updatedAt: typeof patch.updatedAt === 'number' ? patch.updatedAt : Date.now(),
    };
    data.chats[idx] = updated;
    await this.persist();
    return updated;
  }

  async deleteChat(id: string): Promise<void> {
    const data = await this.ensureLoaded();
    const before = data.chats.length;
    data.chats = data.chats.filter((c) => c.id !== id);
    if (data.chats.length === before) {
      throw new Error('Chat not found');
    }
    delete data.kv[`note:${id}`];
    delete data.kv[`questions:${id}`];
    delete data.kv[`textbook:${id}`];
    delete data.kv[`memory:${id}`];
    data.cards = data.cards.filter((c) => c.chatId !== id);
    await this.persist();
  }

  async getKv<T>(key: string): Promise<T | null> {
    const data = await this.ensureLoaded();
    return (data.kv[key] as T | undefined) ?? null;
  }

  async setKv<T>(key: string, value: T): Promise<T> {
    const data = await this.ensureLoaded();
    data.kv[key] = value;
    await this.persist();
    return value;
  }

  async listCards(chatId?: string): Promise<FlashcardItem[]> {
    const data = await this.ensureLoaded();
    if (chatId) {
      return data.cards.filter((c) => c.chatId === chatId);
    }
    return [...data.cards];
  }

  async createCard(input: {
    chatId: string;
    questionId: string;
    question: string;
    answer: string;
    subject: string;
  }): Promise<FlashcardItem> {
    const data = await this.ensureLoaded();
    const now = Date.now();
    const card: FlashcardItem = {
      id: `fc_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      chatId: input.chatId,
      questionId: input.questionId,
      question: input.question,
      answer: input.answer,
      type: 'EXAM',
      status: 'NEW',
      subject: input.subject || 'General Study',
      createdAt: now,
      updatedAt: now,
    };
    data.cards.push(card);
    await this.persist();
    return card;
  }

  async updateCard(
    id: string,
    patch: Partial<Pick<FlashcardItem, 'question' | 'answer' | 'status' | 'subject'>>
  ): Promise<FlashcardItem> {
    const data = await this.ensureLoaded();
    const idx = data.cards.findIndex((c) => c.id === id);
    if (idx === -1) {
      throw new Error('Card not found');
    }
    data.cards[idx] = {
      ...data.cards[idx],
      ...(typeof patch.question === 'string' ? { question: patch.question } : {}),
      ...(typeof patch.answer === 'string' ? { answer: patch.answer } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(typeof patch.subject === 'string' ? { subject: patch.subject } : {}),
      updatedAt: Date.now(),
    };
    await this.persist();
    return data.cards[idx];
  }

  async deleteCard(id: string): Promise<void> {
    const data = await this.ensureLoaded();
    const before = data.cards.length;
    data.cards = data.cards.filter((c) => c.id !== id);
    if (data.cards.length === before) {
      throw new Error('Card not found');
    }
    await this.persist();
  }

  async listSubjects(): Promise<string[]> {
    const data = await this.ensureLoaded();
    return [...data.subjects];
  }

  async getSettings(): Promise<AppSettings> {
    const data = await this.ensureLoaded();
    return {
      ...data.settings,
      chatModel: data.settings.geminiModel,
      sttModel: DEFAULT_STT_MODEL,
    };
  }

  async updateSettings(
    patch: Partial<Pick<AppSettings, 'provider' | 'geminiModel' | 'thinkingLevel' | 'themeMode'>>
  ): Promise<AppSettings> {
    const data = await this.ensureLoaded();
    if (patch.provider === 'gemini') {
      data.settings.provider = 'gemini';
    }
    if (patch.geminiModel && VALID_GEMINI_MODELS.includes(patch.geminiModel)) {
      data.settings.geminiModel = patch.geminiModel;
    }
    if (patch.thinkingLevel && ['low', 'medium', 'high', 'xhigh'].includes(patch.thinkingLevel)) {
      data.settings.thinkingLevel = patch.thinkingLevel;
    }
    if (patch.themeMode && ['system', 'light', 'dark'].includes(patch.themeMode)) {
      data.settings.themeMode = patch.themeMode;
    }
    if (data.settings.thinkingLevel === 'xhigh' && data.settings.geminiModel !== 'gemini-4-hydrogen') {
      data.settings.thinkingLevel = 'high';
    }
    await this.persist();
    return {
      ...data.settings,
      chatModel: data.settings.geminiModel,
      sttModel: DEFAULT_STT_MODEL,
    };
  }

  async exportWorkspace(): Promise<PersistedWorkspace> {
    const data = await this.ensureLoaded();
    return cloneWorkspace(data);
  }

  async importWorkspace(raw: unknown): Promise<PersistedWorkspace> {
    const normalized = normalizeWorkspace(raw);
    if (!normalized || normalized.chats.length === 0) {
      throw new Error('Invalid Talk workspace backup file.');
    }
    this.data = cloneWorkspace(normalized);
    this.initPromise = Promise.resolve(this.data);
    await this.persist();
    return cloneWorkspace(this.data);
  }

  async resetWorkspace(): Promise<PersistedWorkspace> {
    const seed = createSeedWorkspace();
    this.data = cloneWorkspace(seed);
    this.initPromise = Promise.resolve(this.data);
    await this.persist();
    return cloneWorkspace(this.data);
  }
}

export const localWorkspaceStore = new LocalWorkspaceStore(new BrowserWorkspaceBackend());
