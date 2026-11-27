export type ModeTab = 'notes' | 'textbook' | 'questions' | 'memory';

export type ThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh';

export type ThemeMode = 'system' | 'light' | 'dark';

export type AiProvider = 'gemini';

export type GeminiModel = 'gemini-4-hydrogen' | 'gemini-3.5-flash-lite' | 'gemini-3.8-flash';

export type ConceptStatus = 'misunderstood' | 'unresolved' | 'shaky' | 'understood';

export interface ChatAttachment {
  id: string;
  kind: 'image' | 'text';
  name: string;
  mimeType: string;
  dataUrl?: string;
  textContent?: string;
  textbookCode?: string;
  caption?: string;
  pageNumber?: number;
}

export interface CandidateQuestion {
  id: string;
  question: string;
  answer: string;
  status: 'pending' | 'accepted' | 'dismissed';
  savedQuestionId?: string;
  flashcardId?: string;
}

export interface TokenUsageSnapshot {
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  candidate?: CandidateQuestion[];
  candidateState?: 'active' | 'resolved';
  memoryStage?: 1 | 2 | 3;
  tokenUsage?: TokenUsageSnapshot;
}

export interface ChatItem {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export interface NoteData {
  title: string;
  body: string;
  tags: string[];
  images?: ChatAttachment[];
  updatedAt: number;
}

export interface TextbookFigure {
  id: string;
  code?: string;
  pageNumber: number;
  caption: string;
  image: ChatAttachment;
}

export type TextbookFigureAlign = 'left' | 'center' | 'right' | 'full';

export interface TextbookConvertedBlock {
  id: string;
  type: 'text' | 'figure';
  pageNumber: number;
  content?: string;
  figureId?: string;
  figureCode?: string;
  caption?: string;
  align?: TextbookFigureAlign;
  widthPct?: number;
}

export interface TextbookData {
  title: string;
  body: string;
  images: ChatAttachment[];
  convertedBlocks?: TextbookConvertedBlock[];
  convertedFigures?: TextbookFigure[];
  sourcePageCount?: number;
  updatedAt: number;
}

export interface StoredQuestion {
  id: string;
  question: string;
  answer: string;
  flashcardId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FlashcardItem {
  id: string;
  chatId: string;
  questionId: string;
  question: string;
  answer: string;
  type: 'EXAM';
  status: 'NEW' | 'LEARNING' | 'MASTERED';
  subject: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConceptState {
  id: string;
  concept: string;
  status: ConceptStatus;
  note: string;
  updatedAt: number;
}

export interface MemoryPack {
  id: string;
  stage: 1 | 2 | 3;
  summary: string;
  bullets: string[];
  tokenCount: number;
  sourceRange?: [number, number];
  createdAt: number;
}

export interface ChatMemory {
  version: 2;
  compactedCount: number;
  compactedTokens: number;
  epoch: number;
  learnerState: ConceptState[];
  packs: MemoryPack[];
  condensedArchive?: string;
  updatedAt: number;
  lastError?: string;
}

export interface AppSettings {
  provider: AiProvider;
  geminiModel: GeminiModel;
  thinkingLevel: ThinkingLevel;
  themeMode: ThemeMode;
  chatModel: string;
  sttModel: string;
  hasGeminiKey?: boolean;
  hasTavilyKey?: boolean;
}
