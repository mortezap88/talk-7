import type {
  ChatAttachment,
  ChatMemory,
  ChatMessage,
  ConceptState,
  ConceptStatus,
  MemoryPack,
  NoteData,
  StoredQuestion,
  TextbookData,
} from '../types/talk';
import { serializeConvertedBlocksForPrompt } from './imageCrop';
import { buildTextbookImageCatalog } from './textbookImages';

export const ACTIVE_WINDOW_MAX_MESSAGES = 10;
export const ACTIVE_WINDOW_MAX_TOKENS = 12000;
export const COMPACTION_TRIGGER_TOKENS = 1000;
export const PACK_SLOTS = 15;
export const PACK_KEEP_RATIO = 0.8;
export const PACK_QUOTE_SHARE = 0.5;
export const MEMORY_PROMPT_BUDGET_TOKENS = 25000;
export const GEMINI_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const IMAGE_TOKEN_ESTIMATE = 258;
export const TEXTBOOK_MAX_CHARS = 6000;
export const CONVERTED_TEXTBOOK_MAX_CHARS = 24000;
export const TEXTBOOK_MAX_IMAGES = Infinity;
export const MAX_LEARNER_CONCEPTS = 24;
export const MIN_RECENT_TURNS = 10;

const STATUS_PRIORITY: Record<ConceptStatus, number> = {
  misunderstood: 0,
  unresolved: 1,
  shaky: 2,
  understood: 3,
};

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) asciiCount++;
    else nonAsciiCount++;
  }
  return Math.max(1, Math.ceil(asciiCount / 4 + nonAsciiCount / 2));
}

export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = estimateTokens(message.content);
  if (message.attachments) {
    for (const att of message.attachments) {
      if (att.kind === 'image') {
        tokens += IMAGE_TOKEN_ESTIMATE;
      } else if (att.textContent) {
        tokens += estimateTokens(att.textContent);
      }
    }
  }
  return tokens;
}

export function createEmptyMemory(now = Date.now()): ChatMemory {
  return {
    version: 2,
    compactedCount: 0,
    compactedTokens: 0,
    epoch: 0,
    learnerState: [],
    packs: [],
    updatedAt: now,
  };
}

const HIGHLIGHT_MARKUP_RE =
  /(?<![A-Za-z0-9])`?(==|@@|!!|\+\+|\^\^|%%)(?!\s)([^\n]*?\S)\1`?/g;

export function stripHighlightMarkup(text: string): string {
  if (!text) return '';
  let result = text;
  for (let i = 0; i < 2; i++) {
    const next = result.replace(HIGHLIGHT_MARKUP_RE, (_match, _delim, inner: string) => inner);
    if (next === result) break;
    result = next;
  }
  return result.replace(/\[!(?:KEY|NOTE|TIP|TRAP|WARNING|CAUTION|IMPORTANT|EXAMPLE|PROCESS|VOCAB|COMPARE)\]\s*/gi, '');
}

export function sanitizeMemoryPackOutput(raw: {
  summary: string;
  bullets: string[];
}): { summary: string; bullets: string[] } {
  const summary = stripHighlightMarkup(typeof raw.summary === 'string' ? raw.summary : '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const seen = new Set<string>();
  const bullets: string[] = [];
  for (const item of Array.isArray(raw.bullets) ? raw.bullets : []) {
    const cleaned = stripHighlightMarkup(String(item || ''))
      .replace(/^[-*•]\s+/, '')
      .trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(cleaned);
    if (bullets.length >= 5) break;
  }

  return { summary, bullets };
}

export function sortLearnerState(concepts: ConceptState[]): ConceptState[] {
  return [...concepts]
    .sort((a, b) => {
      const pDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
      if (pDiff !== 0) return pDiff;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, MAX_LEARNER_CONCEPTS);
}

const VALID_CONCEPT_STATUSES = new Set<ConceptStatus>([
  'misunderstood',
  'unresolved',
  'shaky',
  'understood',
]);

export function mergeLearnerState(
  currentState: ConceptState[],
  incoming: ConceptState[],
  now = Date.now()
): ConceptState[] {
  const byKey = new Map<string, ConceptState>();

  for (const item of currentState || []) {
    const concept = stripHighlightMarkup(item.concept || '').trim();
    if (!concept) continue;
    const key = concept.toLowerCase();
    const status: ConceptStatus = VALID_CONCEPT_STATUSES.has(item.status)
      ? item.status
      : 'unresolved';
    byKey.set(key, {
      id: item.id,
      concept,
      status,
      note: stripHighlightMarkup(item.note || '').trim(),
      updatedAt: item.updatedAt || now,
    });
  }

  for (const item of incoming || []) {
    const concept = stripHighlightMarkup(item.concept || '').trim();
    if (!concept) continue;
    const key = concept.toLowerCase();
    const existing = byKey.get(key);
    const status: ConceptStatus = VALID_CONCEPT_STATUSES.has(item.status)
      ? item.status
      : 'unresolved';
    const note = stripHighlightMarkup(item.note || '').trim();
    byKey.set(key, {
      id: existing?.id || item.id,
      concept,
      status,
      note: note || existing?.note || '',
      updatedAt: item.updatedAt || now,
    });
  }

  return sortLearnerState(Array.from(byKey.values()));
}

export interface ActiveWindowAnalysis {
  activeWindow: ChatMessage[];
  activeTokens: number;
  uncompactedOutsideWindow: ChatMessage[];
  uncompactedOutsideTokens: number;
  uncompactedTotalCount: number;
}

export function analyzeActiveWindow(
  messages: ChatMessage[],
  compactedCount: number,
  maxMessages = ACTIVE_WINDOW_MAX_MESSAGES
): ActiveWindowAnalysis {
  const safeCompacted = Math.max(0, Math.min(compactedCount, messages.length));
  const uncompactedTail = messages.slice(safeCompacted);

  // Keep the most recent 10 messages verbatim as the immediate conversation window.
  // Everything older than those 10 messages is counted toward the 1,000-token pack threshold.
  const activeWindow = uncompactedTail.slice(-maxMessages);
  const activeTokens = activeWindow.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  const outsideCount = Math.max(0, uncompactedTail.length - activeWindow.length);
  const uncompactedOutsideWindow = uncompactedTail.slice(0, outsideCount);
  const uncompactedOutsideTokens = uncompactedOutsideWindow.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0
  );

  return {
    activeWindow,
    activeTokens,
    uncompactedOutsideWindow,
    uncompactedOutsideTokens,
    uncompactedTotalCount: uncompactedTail.length,
  };
}

export function needsCompaction(
  messages: ChatMessage[],
  memory: ChatMemory
): boolean {
  const analysis = analyzeActiveWindow(messages, memory.compactedCount);
  if (analysis.uncompactedOutsideWindow.length === 0) return false;
  return analysis.uncompactedOutsideTokens >= COMPACTION_TRIGGER_TOKENS;
}

/**
 * Selects whole messages oldest-first until reaching at least `targetMinTokens` (1,000)
 * without ever splitting a message mid-way.
 */
export function selectCompactionChunk(
  outsideMessages: ChatMessage[],
  targetMinTokens = COMPACTION_TRIGGER_TOKENS
): { messages: ChatMessage[]; tokens: number } {
  const selected: ChatMessage[] = [];
  let tokens = 0;
  for (const msg of outsideMessages) {
    selected.push(msg);
    tokens += estimateMessageTokens(msg);
    if (tokens >= targetMinTokens) {
      break;
    }
  }
  return { messages: selected, tokens };
}

export function getTargetSummaryTokens(inputTokens: number): number {
  return Math.max(120, Math.round(inputTokens * PACK_KEEP_RATIO));
}

export function getQuoteAllowance(): number {
  return PACK_QUOTE_SHARE;
}

/**
 * Single-stage rolling 15-room pack ordering: newest first (P1 = newest .. P15 = oldest).
 */
export function getRollingPacks(packs: MemoryPack[]): MemoryPack[] {
  return [...packs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, PACK_SLOTS);
}

/**
 * Inserts a newly compacted pack at P1 (newest), shifting existing packs P1 -> P2 -> ... -> P15.
 */
export function insertRollingPack(
  existingPacks: MemoryPack[],
  newPack: MemoryPack,
  maxSlots = PACK_SLOTS
): MemoryPack[] {
  const orderedExisting = [...existingPacks].sort((a, b) => b.createdAt - a.createdAt);
  const newestTimestamp =
    orderedExisting.length > 0
      ? Math.max(newPack.createdAt, orderedExisting[0].createdAt + 1)
      : newPack.createdAt;
  return [{ ...newPack, createdAt: newestTimestamp }, ...orderedExisting].slice(0, maxSlots);
}

export interface AssembledPromptContext {
  systemPrompt: string;
  selectedMessages: ChatMessage[];
  textbookImagesForLatestUser: ChatAttachment[];
  includedPackIds: string[];
}

export function assembleContextPrompt(params: {
  memory: ChatMemory;
  note?: NoteData | null;
  textbook?: TextbookData | null;
  questions?: StoredQuestion[] | null;
  messages: ChatMessage[];
  extraSystemNotices?: string[];
}): AssembledPromptContext {
  const { memory, note, textbook, questions, messages, extraSystemNotices = [] } = params;
  const sections: string[] = [
    `You are Talk, a rigorous, encouraging study tutor. Help the student understand deeply, catch misconceptions, and build exam-ready mastery.

## Rich Study Formatting Rules (Supported & Animated App-Wide)
The Talk UI renders interactive, animated study formatting directly in your prose (and in the Textbook & Notes). Write these markers directly in your text WITHOUT wrapping them in backticks (never write \`==term==\` with backticks; write ==term== directly):
- Bold: **text** | Italic: *text* | Underline: __text__ | Strikethrough: ~~wrong~~
- Semantic kinetic highlights & interactive tokens (works in both English and Persian/RTL — write directly without backticks, and never overuse):
  - ==term== → Animated amber ink-sweep highlighter for core terms, definitions, or key words to memorize.
  - @@concept@@ → Kinetic sky concept node for named laws, structures, mechanisms, or anatomical terms (e.g. @@CIP rule@@, @@T-state@@).
  - ++rule++ → Emerald verified takeaway/rule sweep.
  - !!pitfall!! → High-alert rose trap/warning for common exam traps or misconceptions.
  - ^^step 1 -> step 2 -> step 3^^ → Kinetic Pathway Chain (animated flowing sequence with directional arrows; supports ->, →, =>, ↔, ⇌) OR ^^mechanism^^ for a highlighted causal mechanism.
  - %%answer%% → Interactive click-to-reveal active recall blank (student clicks to unblur and self-test). Great during review drills!
- Formulas & Math (LaTeX): Wrap chemical formulas, equations, and math expressions in $...$ (inline) or $$...$$ (display block), e.g. $-\\text{CH}=\\text{CH}_2$. Do NOT put ** or \\- inside $...$.
- Structured animated blocks: Use # / ## / ### headings, bullet or numbered lists, Markdown comparison tables (| A | B |), fenced code blocks (only for actual code), and rich study callout cards:
  - > [!KEY] ... (Key Point)
  - > [!TIP] ... (Study Tip / Mnemonic)
  - > [!TRAP] ... (Exam Trap / Common Mistake)
  - > [!EXAMPLE] ... (Worked Example)
  - > [!VOCAB] ... (Terminology / Word Breakdown)
  - > [!PROCESS] ... (Animated vertical step-by-step timeline — put numbered/bulleted steps inside)
  - > [!COMPARE] ... (Side-by-side comparison cards — use \`Side A || Side B\` lines or bullet pairs)
- Keep numbered review Q&A suggestions formatted as 1. ... followed by Answer: ... (or پاسخ: ...) when proposing flashcard-ready questions.`,
  ];

  // 1. Living Learner State (always first & authoritative)
  const sortedConcepts = sortLearnerState(memory.learnerState);
  if (sortedConcepts.length > 0) {
    const blindspotLines = sortedConcepts
      .filter((c) => c.status !== 'understood')
      .map(
        (c) =>
          `- [${c.status.toUpperCase()}] ${stripHighlightMarkup(c.concept)}: ${stripHighlightMarkup(c.note)}`
      );
    const improvementLines = sortedConcepts
      .filter((c) => c.status === 'understood')
      .map(
        (c) =>
          `- [UNDERSTOOD] ${stripHighlightMarkup(c.concept)}: ${stripHighlightMarkup(c.note)}`
      );
    const stateBlocks: string[] = [
      '## Living Learner State (AUTHORITATIVE — overrides older episodic memory packs)',
      'Actively address open blindspots below, and build upon mastered/improved concepts without re-explaining them from scratch.',
    ];
    if (blindspotLines.length > 0) {
      stateBlocks.push(`### Blindspots & Open Gaps\n${blindspotLines.join('\n')}`);
    }
    if (improvementLines.length > 0) {
      stateBlocks.push(`### Understanding Improvements & Mastered\n${improvementLines.join('\n')}`);
    }
    sections.push(stateBlocks.join('\n'));
  }

  // 2. Rolling 15-Slot Episodic Memory Packs: select newest-first under budget, present chronologically
  let packBudgetLeft = MEMORY_PROMPT_BUDGET_TOKENS;
  const newestFirst = getRollingPacks(memory.packs);
  const chosenPacks: Array<{ pack: MemoryPack; slotNumber: number }> = [];
  newestFirst.forEach((pack, idx) => {
    const tok = pack.tokenCount || estimateTokens(pack.summary);
    if (chosenPacks.length > 0 && packBudgetLeft - tok < 0) return;
    chosenPacks.push({ pack, slotNumber: idx + 1 });
    packBudgetLeft -= tok;
  });

  const chronologicalPacks = [...chosenPacks].sort(
    (a, b) => a.pack.createdAt - b.pack.createdAt
  );
  if (chronologicalPacks.length > 0) {
    const packLines = chronologicalPacks.map(
      ({ pack, slotNumber }) => `[Memory Pack P${slotNumber}]\n${pack.summary}`
    );
    sections.push(`## Episodic Memory (Chronological)\n${packLines.join('\n\n')}`);
  }

  // 3. Per-chat Notes
  if (note && (note.title.trim() || note.body.trim() || note.tags.length > 0)) {
    const noteHeaderLines: string[] = [];
    if (note.title.trim()) noteHeaderLines.push(`Title: ${note.title.trim()}`);
    if (note.tags.length > 0) noteHeaderLines.push(`Tags: ${note.tags.join(', ')}`);
    const noteBodyText = [noteHeaderLines.join('\n'), note.body].filter(Boolean).join('\n');
    sections.push(`## Notes for this conversation\n${noteBodyText}`);
  }

  // 4. Global Textbook (Box 1 plain text + Box 2 verbatim converted book + coded figure images)
  const textbookCatalog = buildTextbookImageCatalog(textbook, TEXTBOOK_MAX_IMAGES);
  const textbookImages: ChatAttachment[] = textbookCatalog.map((entry) => entry.image);
  const convertedBookText =
    textbook?.convertedBlocks && textbook.convertedBlocks.length > 0
      ? serializeConvertedBlocksForPrompt(
          textbook.convertedBlocks,
          textbook.convertedFigures
        )
      : '';
  const hasTextbookContent = Boolean(
    textbook &&
      (textbook.title.trim() ||
        textbook.body.trim() ||
        convertedBookText.trim() ||
        textbookImages.length > 0)
  );
  if (textbook && hasTextbookContent) {
    const parts: string[] = [];
    if (textbook.title.trim()) {
      parts.push(`Title: ${textbook.title.trim()}`);
    }
    if (textbook.body.trim()) {
      const clippedBody = textbook.body.slice(0, TEXTBOOK_MAX_CHARS);
      const wasClipped = textbook.body.length > TEXTBOOK_MAX_CHARS;
      parts.push(
        `${clippedBody}${wasClipped ? '\n[...truncated at 6,000 characters]' : ''}`
      );
    }
    if (convertedBookText.trim()) {
      const clippedConverted = convertedBookText.slice(0, CONVERTED_TEXTBOOK_MAX_CHARS);
      const wasConvertedClipped = convertedBookText.length > CONVERTED_TEXTBOOK_MAX_CHARS;
      parts.push(
        `${clippedConverted}${
          wasConvertedClipped ? '\n[...truncated at 24,000 characters]' : ''
        }`
      );
    }
    if (parts.length === 0 && textbookImages.length > 0) {
      parts.push('(See attached textbook images below.)');
    }

    if (textbookCatalog.length > 0) {
      parts.push(
        'Note: The textbook figures/images above are already visible in the student’s Textbook tab and attached below for your visual reference. Answer using clear text only—never embed images or output `[[IMG-...]]` image tags in your replies.'
      );
    }

    sections.push(`## Global Textbook (AUTHORITATIVE REFERENCE)\n${parts.join('\n\n')}`);
  }

  // 5. Saved Study Questions for this chat
  if (questions && questions.length > 0) {
    const qLines = questions.map((q, idx) => {
      const ans = q.answer?.trim() ? `\n   Answer: ${q.answer.trim()}` : '';
      return `${idx + 1}. ${q.question.trim()}${ans}`;
    });
    sections.push(`## Saved Study Questions for this conversation\n${qLines.join('\n')}`);
  }

  // 6. Extra system notices (e.g., Tavily search results)
  for (const notice of extraSystemNotices) {
    if (notice.trim()) {
      sections.push(notice.trim());
    }
  }

  // 7. Immediate conversation messages: always keep the last 10 messages verbatim, plus any uncompacted messages within budget
  const safeCompacted = Math.max(0, Math.min(memory.compactedCount, messages.length));
  const tail = messages.slice(safeCompacted);
  const selectedMessages: ChatMessage[] = [];
  let tokenBudget = ACTIVE_WINDOW_MAX_TOKENS;

  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    const tok = estimateMessageTokens(m);
    const insideImmediateWindow = selectedMessages.length < MIN_RECENT_TURNS;
    if (!insideImmediateWindow && tokenBudget - tok < 0) {
      break;
    }
    selectedMessages.unshift(m);
    tokenBudget -= tok;
  }

  return {
    systemPrompt: sections.join('\n\n'),
    selectedMessages,
    textbookImagesForLatestUser: textbookImages,
    includedPackIds: chronologicalPacks.map((item) => item.pack.id),
  };
}

export interface NextRequestTokenBreakdown {
  systemAndLearnerTokens: number;
  memoryPacksTokens: number;
  packCount: number;
  notesTokens: number;
  textbookTextTokens: number;
  textbookImagesTokens: number;
  textbookImageCount: number;
  questionsTokens: number;
  questionCount: number;
  historyMessagesTokens: number;
  historyMessageCount: number;
  historyImageCount: number;
  draftTextTokens: number;
  draftAttachmentsTokens: number;
  draftImageCount: number;
  estimatedBaseTokens: number;
  estimatedDraftTokens: number;
  estimatedTotalTokens: number;
  assembledBase: AssembledPromptContext;
  draftMessage: ChatMessage | null;
}

/**
 * Computes a complete token breakdown covering everything sent on the next request:
 * base instructions, all active episodic memory packs, per-chat notes,
 * global textbook text + all textbook images, saved study questions, active chat history + images,
 * and the current unsent composer draft + pending attachments.
 */
export function computeNextRequestTokenBreakdown(params: {
  memory: ChatMemory;
  note?: NoteData | null;
  textbook?: TextbookData | null;
  questions?: StoredQuestion[] | null;
  messages: ChatMessage[];
  draftText?: string;
  draftAttachments?: ChatAttachment[];
}): NextRequestTokenBreakdown {
  const {
    memory,
    note,
    textbook,
    questions = [],
    messages,
    draftText = '',
    draftAttachments = [],
  } = params;

  const assembledBase = assembleContextPrompt({
    memory,
    note,
    textbook,
    questions,
    messages,
  });

  // Breakdown of sections inside systemPrompt
  const sectionParts = assembledBase.systemPrompt.split('\n\n## ');
  let systemAndLearnerTokens = 0;
  let memoryPacksTokens = 0;
  let notesTokens = 0;
  let textbookTextTokens = 0;
  let questionsTokens = 0;

  sectionParts.forEach((rawPart, idx) => {
    const part = idx === 0 ? rawPart : `## ${rawPart}`;
    const tok = estimateTokens(part);
    if (part.startsWith('## Episodic Memory')) {
      memoryPacksTokens += tok;
    } else if (part.startsWith('## Notes for this conversation')) {
      notesTokens += tok;
    } else if (part.startsWith('## Global Textbook')) {
      textbookTextTokens += tok;
    } else if (part.startsWith('## Saved Study Questions')) {
      questionsTokens += tok;
    } else {
      systemAndLearnerTokens += tok;
    }
  });

  const textbookImageCount = assembledBase.textbookImagesForLatestUser.length;
  const textbookImagesTokens = textbookImageCount * IMAGE_TOKEN_ESTIMATE;

  let historyMessagesTokens = 0;
  let historyImageCount = 0;
  for (const m of assembledBase.selectedMessages) {
    historyMessagesTokens += estimateMessageTokens(m);
    if (m.attachments) {
      historyImageCount += m.attachments.filter((a) => a.kind === 'image' && a.dataUrl).length;
    }
  }

  const hasDraft = Boolean(draftText.length > 0 || draftAttachments.length > 0);
  const draftMessage: ChatMessage | null = hasDraft
    ? {
        id: '__draft__',
        role: 'user',
        content: draftText,
        createdAt: 0,
        attachments: draftAttachments.length > 0 ? draftAttachments : undefined,
      }
    : null;

  const draftTextTokens = estimateTokens(draftText);
  let draftAttachmentsTokens = 0;
  let draftImageCount = 0;
  for (const att of draftAttachments) {
    if (att.kind === 'image') {
      draftImageCount++;
      draftAttachmentsTokens += IMAGE_TOKEN_ESTIMATE;
    } else if (att.textContent) {
      draftAttachmentsTokens += estimateTokens(att.textContent);
    }
  }

  const estimatedBaseTokens =
    systemAndLearnerTokens +
    memoryPacksTokens +
    notesTokens +
    textbookTextTokens +
    textbookImagesTokens +
    questionsTokens +
    historyMessagesTokens;

  const estimatedDraftTokens = draftTextTokens + draftAttachmentsTokens;

  return {
    systemAndLearnerTokens,
    memoryPacksTokens,
    packCount: assembledBase.includedPackIds.length,
    notesTokens,
    textbookTextTokens,
    textbookImagesTokens,
    textbookImageCount,
    questionsTokens,
    questionCount: questions?.length ?? 0,
    historyMessagesTokens,
    historyMessageCount: assembledBase.selectedMessages.length,
    historyImageCount,
    draftTextTokens,
    draftAttachmentsTokens,
    draftImageCount,
    estimatedBaseTokens,
    estimatedDraftTokens,
    estimatedTotalTokens: estimatedBaseTokens + estimatedDraftTokens,
    assembledBase,
    draftMessage,
  };
}
