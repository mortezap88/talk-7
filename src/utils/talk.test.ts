import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQaSuggestions,
  parseChatIntent,
  parseMessageSegments,
  splitAssistantMessageByQa,
} from './qaParser';
import {
  computePathwayConnectors,
  detectDominantDirection,
} from './pathwayLayout';
import {
  analyzeActiveWindow,
  assembleContextPrompt,
  COMPACTION_TRIGGER_TOKENS,
  computeNextRequestTokenBreakdown,
  createEmptyMemory,
  GEMINI_CONTEXT_WINDOW_TOKENS,
  getQuoteAllowance,
  getTargetSummaryTokens,
  insertRollingPack,
  mergeLearnerState,
  needsCompaction,
  PACK_SLOTS,
  sanitizeMemoryPackOutput,
  selectCompactionChunk,
  sortLearnerState,
  stripHighlightMarkup,
  TEXTBOOK_MAX_CHARS,
  TEXTBOOK_MAX_IMAGES,
} from './memoryEngine';
import type { ChatMessage, ConceptState, MemoryPack } from '../types/talk';
import {
  computeComposerLayout,
  dedupeById,
  normalizeThinkingLevelForModel,
  supportsXhighThinking,
} from './formatters';
import {
  mergeContinuousTextbookBlocks,
  normalizeBoxToPixels,
  serializeConvertedBlocksForPrompt,
} from './imageCrop';
import {
  encodeMonoWav,
  SilenceAudioChunker,
  TARGET_SAMPLE_RATE,
} from './voiceChunker';
import {
  buildTextbookImageCatalog,
  collectShownTextbookImageCodes,
  extractTextbookImageCodes,
  getNextTextbookImageCode,
  normalizeTextbookFigureCodes,
} from './textbookImages';
import {
  appendDroppedTextToTextbook,
  applyDraggedFigurePlacement,
  applyLineDraggedFigurePlacement,
  buildDragBaseFlow,
  cleanConsistentFigureCaption,
  cleanScrapedWebpageFallback,
  coalesceAdjacentTextBlocks,
  computeResizedFigureWidthPct,
  convertMarkdownImagesToImageBoxes,
  ensureWebpageMarkdownHasTitle,
  extractStandaloneUrlsFromPaste,
  extractUrlsFromDropData,
  extractWebpageMetadataFromHtml,
  precleanWebpageMarkdown,
  formatTextbookImageLabel,
  parseAnalyzedMarkdownWithImageBoxes,
  inferFigureBoxLayout,
  isGenericOrEmptyFigureCaption,
  normalizeBlocksToParagraphs,
  splitMarkdownIntoParagraphs,
  insertTextBlockAdjacent,
  mapRenderedLineStartTokensToRawOffsets,
  mergeTextBlockWithNext,
  moveTextbookBlock,
  moveTextbookBlockToTail,
  reorderTextbookBlock,
  resolveCardHorizontalSnapAlign,
  resolveDraggedFigureInsertIndex,
  resolveHorizontalSnapAlign,
  resolveLineDragTarget,
  resolveSplitTextParts,
  splitTextBlockAtOffset,
  updateFigureBlockLayout,
} from './textbookLayout';
import { toGeminiThinkingLevel } from '../../server/gemini';
import { ThinkingLevel as GenAiThinkingLevel } from '@google/genai';
import {
  createUndoHistory,
  isRedoShortcut,
  isUndoShortcut,
  pushUndoSnapshot,
  stepRedo,
  stepUndo,
} from './undoHistory';

test('parseQaSuggestions extracts English numbered Q&A pairs', () => {
  const reply = `Here are two practice questions:

1. Why does the Bohr curve shift right during exercise?
Answer: Increased CO2 and lower pH stabilize the T-state of hemoglobin, decreasing oxygen affinity so tissues receive more O2.

2. What is the Haldane effect?
Answer: Deoxygenated hemoglobin binds H+ and CO2 more readily in peripheral capillaries.`;

  const parsed = parseQaSuggestions(reply);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].question, 'Why does the Bohr curve shift right during exercise?');
  assert.match(parsed[0].answer, /T-state of hemoglobin/);
  assert.equal(parsed[1].question, 'What is the Haldane effect?');
});

test('parseQaSuggestions extracts Persian numbered Q&A pairs', () => {
  const reply = `چند سوال تمرینی:

۱. اثر بور چیست؟
پاسخ: کاهش pH و افزایش دی‌اکسید کربن تمایل هموگلوبین به اکسیژن را کاهش می‌دهد.

۲. چرا پیوند پپتیدی مسطح است؟
جواب: به دلیل رزونانس بین جفت الکترون نیتروژن و گروه کربونیل.`;

  const parsed = parseQaSuggestions(reply);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].question, 'اثر بور چیست؟');
  assert.match(parsed[0].answer, /هموگلوبین/);
  assert.equal(parsed[1].question, 'چرا پیوند پپتیدی مسطح است؟');
});

test('splitAssistantMessageByQa isolates Q&A in-place without swallowing trailing prose or breaking normal lists', () => {
  const reply = [
    'حالا برای اینکه مطمئن بشم کاملاً متوجه شدی، به این سؤال جواب بده:',
    '1. خون موجود در سرخرگ ششی تیره است یا روشن؟ و به کدوم سمت می‌ره؟',
    'پاسخ: %%تیره (کم‌اکسیژن/دی‌اکسید کربن بالا) و از بطن راست به سمت شش‌ها می‌رود تا اکسیژن بگیرد.%%',
    'دوست داری مسیر گردش خون عمومی و ششی (شکل ۲) رو هم با همین روش دونه‌دونه جلو بریم؟',
  ].join('\n');

  const segments = splitAssistantMessageByQa(reply);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].type, 'markdown');
  assert.equal(
    segments[0].content,
    'حالا برای اینکه مطمئن بشم کاملاً متوجه شدی، به این سؤال جواب بده:'
  );
  assert.equal(segments[1].type, 'qa');
  assert.equal(segments[1].suggestion.marker, '1');
  assert.equal(
    segments[1].suggestion.answer,
    '%%تیره (کم‌اکسیژن/دی‌اکسید کربن بالا) و از بطن راست به سمت شش‌ها می‌رود تا اکسیژن بگیرد.%%'
  );
  assert.equal(segments[2].type, 'markdown');
  assert.equal(
    segments[2].content,
    'دوست داری مسیر گردش خون عمومی و ششی (شکل ۲) رو هم با همین روش دونه‌دونه جلو بریم؟'
  );

  // Normal numbered list without Answer: stays intact as markdown
  const normalList = splitAssistantMessageByQa('1. First step\n2. Second step');
  assert.deepEqual(normalList, [
    { type: 'markdown', content: '1. First step\n2. Second step' },
  ]);
});

test('parseChatIntent recognizes add, delete, and change intents', () => {
  assert.deepEqual(parseChatIntent('add this question'), { type: 'add_last_question' });
  assert.deepEqual(parseChatIntent('Save this question!'), { type: 'add_last_question' });
  assert.deepEqual(parseChatIntent('delete question 2'), { type: 'delete_question', index: 2 });
  assert.deepEqual(parseChatIntent('delete question ۳'), { type: 'delete_question', index: 3 });
  assert.deepEqual(
    parseChatIntent('change question 1 to Explain Gibbs free energy'),
    { type: 'change_question', index: 1, newQuestion: 'Explain Gibbs free energy' }
  );
  assert.equal(parseChatIntent('Tell me more about thermodynamics'), null);
});

test('parseMessageSegments splits fenced code blocks safely', () => {
  const segments = parseMessageSegments('Intro\n```ts\nconst x = 1;\n```\nOutro');
  assert.equal(segments.length, 3);
  assert.equal(segments[0].type, 'text');
  assert.equal(segments[1].type, 'code');
  assert.equal(segments[1].language, 'ts');
  assert.equal(segments[1].content, 'const x = 1;');
  assert.equal(segments[2].type, 'text');
});

test('sortLearnerState enforces misunderstood -> unresolved -> shaky -> understood priority and max 24', () => {
  const now = 1000;
  const list: ConceptState[] = [
    { id: '1', concept: 'U1', status: 'understood', note: 'good', updatedAt: now },
    { id: '2', concept: 'S1', status: 'shaky', note: 'review', updatedAt: now },
    { id: '3', concept: 'M1', status: 'misunderstood', note: 'wrong sign', updatedAt: now },
    { id: '4', concept: 'R1', status: 'unresolved', note: 'open', updatedAt: now },
  ];
  const sorted = sortLearnerState(list);
  assert.deepEqual(
    sorted.map((c) => c.status),
    ['misunderstood', 'unresolved', 'shaky', 'understood']
  );
});

test('active window keeps last 10 messages verbatim and triggers pack at 1000 outside tokens', () => {
  const msgs: ChatMessage[] = Array.from({ length: 22 }, (_, idx) => ({
    id: `m_${idx}`,
    role: idx % 2 === 0 ? 'user' : 'assistant',
    content: 'a'.repeat(400), // 100 tokens each
    createdAt: idx * 1000,
  }));
  const mem = createEmptyMemory(0);
  const analysis = analyzeActiveWindow(msgs, mem.compactedCount);
  assert.equal(analysis.activeWindow.length, 10);
  assert.equal(analysis.activeWindow[0].id, 'm_12');
  assert.equal(analysis.uncompactedOutsideWindow.length, 12);
  assert.equal(analysis.uncompactedOutsideTokens, 1200);
  assert.equal(needsCompaction(msgs, mem), true);

  // Chunk selection takes whole messages oldest-first until >= 1,000 tokens without splitting
  const bigMsgs: ChatMessage[] = [
    { id: 'b1', role: 'user', content: 'x'.repeat(1600), createdAt: 1000 }, // 400 tok
    { id: 'b2', role: 'assistant', content: 'x'.repeat(1600), createdAt: 2000 }, // 400 tok (800 total)
    { id: 'b3', role: 'user', content: 'x'.repeat(1800), createdAt: 3000 }, // 450 tok (1250 total -> stops here)
    { id: 'b4', role: 'assistant', content: 'x'.repeat(800), createdAt: 4000 }, // 200 tok (remains for next chunk)
  ];
  const chunk = selectCompactionChunk(bigMsgs, COMPACTION_TRIGGER_TOKENS);
  assert.deepEqual(chunk.messages.map((m) => m.id), ['b1', 'b2', 'b3']);
  assert.equal(chunk.tokens, 1250);
});

test('single-stage rolling packs target ~80% retention, 50% quotes, and shift P1 -> P15 across 15 slots', () => {
  assert.equal(PACK_SLOTS, 15);
  assert.equal(getTargetSummaryTokens(1000), 800);
  assert.equal(getQuoteAllowance(), 0.5);

  let packs: MemoryPack[] = [];
  for (let i = 1; i <= 16; i++) {
    packs = insertRollingPack(packs, {
      id: `p_${i}`,
      stage: 1,
      summary: `Pack ${i}`,
      bullets: [],
      tokenCount: 800,
      createdAt: i * 1000,
    });
  }
  assert.equal(packs.length, 15);
  // Newest pack (#16) sits in P1 (index 0), shifting older packs down and dropping #1
  assert.equal(packs[0].id, 'p_16');
  assert.equal(packs[1].id, 'p_15');
  assert.equal(packs[14].id, 'p_2');
});

test('assembleContextPrompt clips textbook at 6000 chars, puts learner state first, and orders packs chronologically', () => {
  const mem = createEmptyMemory(100);
  mem.learnerState = [
    { id: 'c1', concept: 'Keq', status: 'misunderstood', note: 'confused with Q', updatedAt: 500 },
  ];
  mem.packs = [
    { id: 'p_new', stage: 1, summary: 'NEWER PACK', bullets: [], tokenCount: 120, createdAt: 2000 },
    { id: 'p_old', stage: 2, summary: 'OLDER PACK', bullets: [], tokenCount: 120, createdAt: 1000 },
  ];
  const longTextbook = 'X'.repeat(TEXTBOOK_MAX_CHARS + 500);
  const assembled = assembleContextPrompt({
    memory: mem,
    note: { title: 'Bio', body: 'Check chapter 4', tags: ['exam'], updatedAt: 100 },
    textbook: {
      title: 'Campbell',
      body: longTextbook,
      images: [{ id: 'img1', kind: 'image', name: 'fig1.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }],
      updatedAt: 100,
    },
    messages: [{ id: 'm1', role: 'user', content: 'Hi', createdAt: 100 }],
  });

  const learnerIdx = assembled.systemPrompt.indexOf('Living Learner State');
  const episodicIdx = assembled.systemPrompt.indexOf('Episodic Memory');
  const olderIdx = assembled.systemPrompt.indexOf('OLDER PACK');
  const newerIdx = assembled.systemPrompt.indexOf('NEWER PACK');
  assert.ok(learnerIdx !== -1 && episodicIdx > learnerIdx);
  assert.ok(olderIdx !== -1 && newerIdx > olderIdx);
  assert.ok(assembled.systemPrompt.includes('[...truncated at 6,000 characters]'));
  assert.equal(assembled.textbookImagesForLatestUser.length, 1);
});

test('toGeminiThinkingLevel maps all 4 gemini-4-hydrogen options without MINIMAL', () => {
  assert.equal(toGeminiThinkingLevel('low'), GenAiThinkingLevel.LOW);
  assert.equal(toGeminiThinkingLevel('medium'), GenAiThinkingLevel.MEDIUM);
  assert.equal(toGeminiThinkingLevel('high'), GenAiThinkingLevel.HIGH);
  assert.equal(toGeminiThinkingLevel('xhigh'), GenAiThinkingLevel.XHIGH);
});

test('computeComposerLayout grows vertically without scrollbars until maxHeight', () => {
  assert.deepEqual(computeComposerLayout(34, 2, 36, 180), {
    heightPx: 36,
    overflowY: 'hidden',
  });
  assert.deepEqual(computeComposerLayout(78, 2, 36, 180), {
    heightPx: 80,
    overflowY: 'hidden',
  });
  assert.deepEqual(computeComposerLayout(220, 2, 36, 180), {
    heightPx: 180,
    overflowY: 'auto',
  });
});

test('supportsXhighThinking and normalizeThinkingLevelForModel restrict xhigh to gemini-4-hydrogen', () => {
  assert.equal(supportsXhighThinking('gemini-4-hydrogen'), true);
  assert.equal(supportsXhighThinking('gemini-3.8-flash'), false);
  assert.equal(supportsXhighThinking('gemini-3.5-flash-lite'), false);

  assert.equal(normalizeThinkingLevelForModel('xhigh', 'gemini-4-hydrogen'), 'xhigh');
  assert.equal(normalizeThinkingLevelForModel('xhigh', 'gemini-3.8-flash'), 'high');
  assert.equal(normalizeThinkingLevelForModel('xhigh', 'gemini-3.5-flash-lite'), 'high');
  assert.equal(normalizeThinkingLevelForModel('medium', 'gemini-3.8-flash'), 'medium');
});

test('assembleContextPrompt supports more than 20 textbook images without capping and omits empty titles', () => {
  assert.equal(TEXTBOOK_MAX_IMAGES, Infinity);
  const images = Array.from({ length: 24 }, (_, idx) => ({
    id: `img_${idx}`,
    kind: 'image' as const,
    name: `page-${idx + 1}.png`,
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,AA==',
  }));
  const assembled = assembleContextPrompt({
    memory: createEmptyMemory(100),
    note: { title: '', body: 'Remember Km decreases with uncompetitive inhibitors.', tags: [], updatedAt: 100 },
    textbook: { title: '', body: 'Enzyme kinetics notes.', images, updatedAt: 100 },
    messages: [{ id: 'm1', role: 'user', content: 'Quiz me', createdAt: 100 }],
  });

  assert.equal(assembled.textbookImagesForLatestUser.length, 24);
  assert.equal(assembled.systemPrompt.includes('Title: Untitled'), false);
  assert.equal(assembled.systemPrompt.includes('Title: Reference Document'), false);
  assert.ok(assembled.systemPrompt.includes('Remember Km decreases'));
});

test('mergeContinuousTextbookBlocks joins broken cross-page sentences verbatim and preserves user sections & pictures', () => {
  const merged = mergeContinuousTextbookBlocks([
    { id: 'u0', type: 'text', pageNumber: 0, content: 'My notes before the chapter' },
    { id: 'pic0', type: 'figure', pageNumber: 0, figureId: 'pic_heart', caption: 'Heart anatomy' },
    { id: 'b1', type: 'text', pageNumber: 1, content: 'Hemoglobin binds oxygen in the' },
    { id: 'b2', type: 'text', pageNumber: 2, content: 'alveolar capillaries.' },
    { id: 'b3', type: 'figure', pageNumber: 2, figureId: 'fig1', caption: 'Figure 42.1' },
    { id: 'b4', type: 'text', pageNumber: 2, content: '## Bohr Shift\nLower pH releases more oxygen.' },
  ]);

  assert.equal(merged.length, 5);
  assert.equal(merged[0].content, 'My notes before the chapter');
  assert.equal(merged[1].type, 'figure');
  assert.equal(merged[2].content, 'Hemoglobin binds oxygen in the alveolar capillaries.');
  assert.equal(merged[3].type, 'figure');
  assert.equal(merged[4].type, 'text');

  const serialized = serializeConvertedBlocksForPrompt(merged);
  assert.ok(serialized.includes('[Picture: Heart anatomy]'));
  assert.ok(!serialized.includes('[Image Code:'));
  assert.ok(serialized.includes('Hemoglobin binds oxygen in the alveolar capillaries.'));
  assert.ok(serialized.includes('[Figure from Page 2: Figure 42.1]'));

  const crop = normalizeBoxToPixels([100, 200, 500, 800], 1000, 2000, 10);
  assert.deepEqual(crop, { sx: 190, sy: 180, sw: 620, sh: 840 });
  assert.equal(normalizeBoxToPixels([100, 100, 105, 105], 1000, 1000), null);
});

test('textbook image catalog assigns stable IMG-N codes and tracks already-shown images once per chat', () => {
  const existingFigs = [
    {
      id: 'f1',
      code: 'IMG-1',
      pageNumber: 2,
      caption: 'Bohr Shift Curve',
      image: { id: 'f1', kind: 'image' as const, name: 'fig1.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AA==' },
    },
    {
      id: 'f3',
      code: 'IMG-3',
      pageNumber: 5,
      caption: 'Enzyme Kinetics',
      image: { id: 'f3', kind: 'image' as const, name: 'fig3.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,BB==' },
    },
  ];
  assert.equal(getNextTextbookImageCode(existingFigs), 'IMG-4');

  const normalized = normalizeTextbookFigureCodes([
    { ...existingFigs[0], code: undefined },
    existingFigs[1],
  ]);
  assert.equal(normalized[0].code, 'IMG-1');
  assert.equal(normalized[1].code, 'IMG-3');

  const textbook = {
    title: '',
    body: 'See the diagrams.',
    images: [],
    convertedBlocks: [
      { id: 'b1', type: 'figure' as const, pageNumber: 2, figureId: 'f1', caption: 'Bohr Shift Curve' },
      { id: 'b2', type: 'figure' as const, pageNumber: 5, figureId: 'f3', caption: 'Enzyme Kinetics' },
    ],
    convertedFigures: normalized,
    updatedAt: 100,
  };

  const catalog = buildTextbookImageCatalog(textbook);
  assert.deepEqual(catalog.map((c) => c.code), ['IMG-1', 'IMG-3']);

  assert.deepEqual(extractTextbookImageCodes('Check [[IMG-1]], [[img 3]], and [[IMG-1]]'), ['IMG-1', 'IMG-3']);

  const mem = createEmptyMemory(100);
  mem.packs = [
    { id: 'p1', stage: 1, summary: 'Earlier we covered [[IMG-1]] in detail.', bullets: [], tokenCount: 40, createdAt: 100 },
  ];
  const msgs: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'Show [[IMG-3]]?', createdAt: 200 },
    { id: 'a1', role: 'assistant', content: 'Here is the kinetics plot:\n[[IMG-3]]', createdAt: 300 },
  ];
  assert.deepEqual(collectShownTextbookImageCodes(msgs, mem), ['IMG-1', 'IMG-3']);

  const assembled = assembleContextPrompt({
    memory: mem,
    textbook,
    messages: [{ id: 'u2', role: 'user', content: 'Remind me about the Bohr shift', createdAt: 400 }],
  });

  assert.equal(assembled.textbookImagesForLatestUser[0].textbookCode, 'IMG-1');
  assert.equal(assembled.textbookImagesForLatestUser[1].textbookCode, 'IMG-3');
  assert.ok(!assembled.systemPrompt.includes('Textbook Image Codes & Inline Chat Display Rules'));
  assert.ok(!assembled.systemPrompt.includes('output its exact marker'));
  assert.ok(assembled.systemPrompt.includes('never embed images or output `[[IMG-...]]` image tags'));
});

test('computeNextRequestTokenBreakdown accounts for notes, textbook + images, questions, memory packs, chat, and draft', () => {
  assert.equal(GEMINI_CONTEXT_WINDOW_TOKENS, 1_048_576);

  const mem = createEmptyMemory(100);
  mem.learnerState = [
    { id: 'c_bohr', concept: 'Bohr Effect', status: 'shaky', note: 'Needs review', updatedAt: 100 },
  ];
  mem.packs = [
    { id: 'p1', stage: 1, summary: 'Covered hemoglobin cooperative binding.', bullets: [], tokenCount: 55, createdAt: 100 },
    { id: 'p2', stage: 1, summary: 'Practiced 2,3-BPG shift effects.', bullets: [], tokenCount: 60, createdAt: 200 },
  ];

  const note = {
    title: '',
    body: 'Remember: lower pH shifts curve right (Bohr effect).',
    tags: [],
    updatedAt: 200,
  };

  const textbook = {
    title: '',
    body: 'Hemoglobin binds four O2 molecules cooperatively.',
    images: [
      { id: 'tb_img1', kind: 'image' as const, name: 'curve.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
    ],
    convertedBlocks: [],
    convertedFigures: [],
    updatedAt: 300,
  };

  const questions = [
    {
      id: 'q1',
      question: 'Why does high CO2 promote O2 unloading?',
      answer: 'CO2 lowers pH and stabilizes the T-state.',
      createdAt: 350,
      updatedAt: 350,
    },
  ];

  const messages: ChatMessage[] = [
    {
      id: 'm1',
      role: 'user',
      content: 'Explain this diagram please.',
      createdAt: 400,
      attachments: [
        { id: 'msg_img1', kind: 'image', name: 'slide.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,BB==' },
      ],
    },
  ];

  const breakdown = computeNextRequestTokenBreakdown({
    memory: mem,
    note,
    textbook,
    questions,
    messages,
    draftText: 'سلام، آیا افزایش دما هم نمودار را جابجا می‌کند؟',
    draftAttachments: [
      { id: 'draft_img1', kind: 'image', name: 'note.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,CC==' },
    ],
  });

  assert.ok(breakdown.assembledBase.systemPrompt.includes('## Saved Study Questions for this conversation'));
  assert.ok(breakdown.assembledBase.systemPrompt.includes('Why does high CO2 promote O2 unloading?'));

  assert.ok(breakdown.systemAndLearnerTokens > 0);
  assert.equal(breakdown.packCount, 2);
  assert.ok(breakdown.memoryPacksTokens > 0);
  assert.ok(breakdown.notesTokens > 0);
  assert.ok(breakdown.textbookTextTokens > 0);
  assert.equal(breakdown.textbookImageCount, 1);
  assert.equal(breakdown.textbookImagesTokens, 258);
  assert.equal(breakdown.questionCount, 1);
  assert.ok(breakdown.questionsTokens > 0);
  assert.equal(breakdown.historyMessageCount, 1);
  assert.equal(breakdown.historyImageCount, 1);
  assert.ok(breakdown.historyMessagesTokens >= 258);
  assert.ok(breakdown.draftTextTokens > 10);
  assert.equal(breakdown.draftImageCount, 1);
  assert.equal(breakdown.draftAttachmentsTokens, 258);
  assert.equal(
    breakdown.estimatedTotalTokens,
    breakdown.estimatedBaseTokens + breakdown.estimatedDraftTokens
  );
  assert.ok(breakdown.draftMessage !== null);
});

test('SilenceAudioChunker waits at least 20s, refreshes silence timer while speaking, and cuts on 0.3s silence', async () => {
  const emitted: Array<{ blob: Blob; durationMs: number }> = [];
  const chunker = new SilenceAudioChunker({
    sampleRate: TARGET_SAMPLE_RATE,
    silenceCutMs: 300,
    minPatchMs: 20000,
    maxPatchMs: 45000,
    onChunk: (blob, durationMs) => {
      emitted.push({ blob, durationMs });
    },
  });

  const makeFrame = (durationMs: number, amplitude: number) => {
    const len = Math.round((durationMs / 1000) * TARGET_SAMPLE_RATE);
    const buf = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      buf[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / TARGET_SAMPLE_RATE);
    }
    return buf;
  };

  // Pure silence should not emit anything
  for (let i = 0; i < 6; i++) {
    chunker.push(makeFrame(100, 0.001));
  }
  assert.equal(emitted.length, 0);

  // Even a 0.6s pause at 5s must NOT cut before 20s minimum is reached
  for (let i = 0; i < 50; i++) {
    chunker.push(makeFrame(100, 0.12));
  }
  for (let i = 0; i < 6; i++) {
    chunker.push(makeFrame(100, 0.001));
  }
  assert.equal(emitted.length, 0);

  // Continue speaking up to ~20.2s -> still active, no silence cut yet
  for (let i = 0; i < 146; i++) {
    chunker.push(makeFrame(100, 0.12));
  }
  assert.equal(emitted.length, 0);

  // At ~20.2s, pause 0.2s (< 0.3s) then speak again for 1.5s -> refreshes silence timer!
  chunker.push(makeFrame(100, 0.001));
  chunker.push(makeFrame(100, 0.001));
  assert.equal(emitted.length, 0);
  for (let i = 0; i < 15; i++) {
    chunker.push(makeFrame(100, 0.12));
  }
  assert.equal(emitted.length, 0);

  // Now pause 0.3s (~22.2s total) -> cuts patch #1 cleanly!
  chunker.push(makeFrame(100, 0.001));
  chunker.push(makeFrame(100, 0.001));
  chunker.push(makeFrame(100, 0.001));
  assert.equal(emitted.length, 1);
  assert.ok(emitted[0].durationMs >= 22000);
  assert.equal(emitted[0].blob.type, 'audio/wav');
  const headerBytes = new Uint8Array(await emitted[0].blob.slice(0, 12).arrayBuffer());
  const riff = String.fromCharCode(...headerBytes.slice(0, 4));
  const wave = String.fromCharCode(...headerBytes.slice(8, 12));
  assert.equal(riff, 'RIFF');
  assert.equal(wave, 'WAVE');

  // Next shorter speech patch followed by manual flush() -> emits patch #2
  for (let i = 0; i < 6; i++) {
    chunker.push(makeFrame(100, 0.15));
  }
  chunker.flush();
  assert.equal(emitted.length, 2);

  // Flushing empty/silent tail emits nothing extra
  chunker.flush();
  assert.equal(emitted.length, 2);

  // Soft-spoken mic levels (e.g., amplitude 0.015 -> RMS ~0.01) still flush cleanly on stop
  for (let i = 0; i < 6; i++) {
    chunker.push(makeFrame(100, 0.015));
  }
  chunker.flush();
  assert.equal(emitted.length, 3);

  const wav = encodeMonoWav(makeFrame(50, 0.1), TARGET_SAMPLE_RATE);
  assert.equal(wav.size, 44 + 800 * 2);
});

test('inferFigureBoxLayout resolves left/right/center/full defaults from AI metadata or crop coordinates', () => {
  assert.deepEqual(inferFigureBoxLayout([100, 50, 450, 450], 'left', 38), {
    align: 'left',
    widthPct: 38,
  });
  // Left-margin crop without explicit AI align -> auto left wrap
  assert.deepEqual(inferFigureBoxLayout([100, 40, 450, 460]), {
    align: 'left',
    widthPct: 42,
  });
  // Right-margin crop without explicit AI align -> auto right wrap
  assert.deepEqual(inferFigureBoxLayout([100, 550, 450, 960]), {
    align: 'right',
    widthPct: 41,
  });
  // Full-width banner crop
  assert.deepEqual(inferFigureBoxLayout([100, 20, 450, 980]), {
    align: 'full',
    widthPct: 100,
  });
});

test('paper restructuring helpers adjust alignment, width, order, split, merge, and insert cleanly', () => {
  const blocks = [
    { id: 't1', type: 'text' as const, pageNumber: 1, content: 'Paragraph one.\n\nParagraph two.' },
    {
      id: 'f1',
      type: 'figure' as const,
      pageNumber: 1,
      figureId: 'fig_1',
      figureCode: 'IMG-1',
      caption: 'Curve',
      align: 'center' as const,
      widthPct: 80,
    },
  ];

  // Switching centered 80% figure to left/right snaps to wrap-friendly 42% width
  const leftAligned = updateFigureBlockLayout(blocks, 'f1', { align: 'left' });
  assert.equal(leftAligned[1].align, 'left');
  assert.equal(leftAligned[1].widthPct, 42);

  // Move figure above paragraph so prose wraps beside it
  const movedUp = moveTextbookBlock(leftAligned, 'f1', 'up');
  assert.deepEqual(movedUp.map((b) => b.id), ['f1', 't1']);

  // Drag reorder swaps back
  const reordered = reorderTextbookBlock(movedUp, 'f1', 't1');
  assert.deepEqual(reordered.map((b) => b.id), ['t1', 'f1']);

  // Split multi-paragraph text block & merge back
  const split = splitTextBlockAtOffset(reordered, 't1', undefined, 't2');
  assert.equal(split.length, 3);
  assert.equal(split[0].content, 'Paragraph one.');
  assert.equal(split[1].content, 'Paragraph two.');

  const merged = mergeTextBlockWithNext(split, 't1');
  assert.equal(merged.length, 2);
  assert.equal(merged[0].content, 'Paragraph one.\n\nParagraph two.');

  // Insert empty text block immediately after a figure
  const withInserted = insertTextBlockAdjacent(merged, 'f1', 'after', 't3', 'Side note');
  assert.deepEqual(withInserted.map((b) => b.id), ['t1', 'f1', 't3']);
  assert.equal(withInserted[2].content, 'Side note');
});

test('dedupeById removes duplicate IDs from concurrent optimistic and snapshot updates', () => {
  const result = dedupeById([
    { id: 'chat_a4d9c3d2-9e4', title: 'New session' },
    { id: 'chat_bio_bohr', title: 'Biology' },
    { id: 'chat_a4d9c3d2-9e4', title: 'New session' },
  ]);
  assert.deepEqual(result.map((c) => c.id), ['chat_a4d9c3d2-9e4', 'chat_bio_bohr']);
});

test('stripHighlightMarkup and sanitizeMemoryPackOutput clean leaked highlight tags while preserving math and C++', () => {
  const dirty =
    'Covered ==session memory==, @@CIP rule@@, ++right shift++, and `!!pitfall!!` plus C++ and g++ with $E = mc^2$.';
  assert.equal(
    stripHighlightMarkup(dirty),
    'Covered session memory, CIP rule, right shift, and pitfall plus C++ and g++ with $E = mc^2$.'
  );

  const sanitized = sanitizeMemoryPackOutput({
    summary: '**Subtopics Covered:** ==Bohr Effect== and !!exam traps pitfall!!.',
    bullets: [
      '- Covered ==Bohr Effect==',
      'Covered Bohr Effect',
      'Resolved `!!sign confusion!!`',
    ],
  });
  assert.equal(sanitized.summary, '**Subtopics Covered:** Bohr Effect and exam traps pitfall.');
  assert.deepEqual(sanitized.bullets, ['Covered Bohr Effect', 'Resolved sign confusion']);
});

test('mergeLearnerState preserves existing concepts, promotes improvements, and caps at 24', () => {
  const existing: ConceptState[] = [
    {
      id: 'c_keq',
      concept: 'Keq vs Q',
      status: 'misunderstood',
      note: 'Mixed up equilibrium constant with reaction quotient',
      updatedAt: 1000,
    },
    {
      id: 'c_hill',
      concept: 'Hill Coefficient',
      status: 'shaky',
      note: 'Needs practice interpreting nH slope',
      updatedAt: 900,
    },
  ];
  const incoming: ConceptState[] = [
    {
      id: 'cs_new_1',
      concept: '==Keq vs Q==',
      status: 'understood',
      note: 'Improved: correctly used Q < Keq to predict forward shift',
      updatedAt: 2000,
    },
    {
      id: 'cs_new_2',
      concept: 'Entropy Sign',
      status: 'unresolved',
      note: 'Open question on surroundings entropy sign',
      updatedAt: 2000,
    },
  ];

  const merged = mergeLearnerState(existing, incoming, 2000);
  assert.deepEqual(
    merged.map((c) => [c.id, c.concept, c.status]),
    [
      ['cs_new_2', 'Entropy Sign', 'unresolved'],
      ['c_hill', 'Hill Coefficient', 'shaky'],
      ['c_keq', 'Keq vs Q', 'understood'],
    ]
  );

  const assembled = assembleContextPrompt({
    memory: { ...createEmptyMemory(2000), learnerState: merged },
    messages: [{ id: 'm1', role: 'user', content: 'Continue', createdAt: 2000 }],
  });
  assert.ok(assembled.systemPrompt.includes('### Blindspots & Open Gaps'));
  assert.ok(assembled.systemPrompt.includes('### Understanding Improvements & Mastered'));
  assert.ok(assembled.systemPrompt.includes('Improved: correctly used Q < Keq'));
});

test('formatTextbookImageLabel, computeResizedFigureWidthPct, and appendDroppedTextToTextbook behave cleanly', () => {
  assert.equal(formatTextbookImageLabel('IMG-1', 1), 'Image 1');
  assert.equal(formatTextbookImageLabel('img_12', 1), 'Image 12');
  assert.equal(formatTextbookImageLabel(undefined, 3), 'Image 3');

  // Left-aligned figure dragged +80px in 800px container (+10%) -> 40% to 50%
  assert.equal(computeResizedFigureWidthPct('left', 40, 80, 800), 50);
  // Right-aligned figure dragged -80px leftward (+10%) -> 40% to 50%
  assert.equal(computeResizedFigureWidthPct('right', 40, -80, 800), 50);
  // Clamped at MAX_FLOAT_WIDTH_PCT (72%) for floated figures
  assert.equal(computeResizedFigureWidthPct('left', 68, 200, 800), 72);
  // Center-aligned figure scales symmetrically (deltaX * 2) up to 100%
  assert.equal(computeResizedFigureWidthPct('center', 50, 80, 800), 70);
  // Dragging left handle of a center-aligned figure leftward (-40px) increases width symmetrically (+10%)
  assert.equal(computeResizedFigureWidthPct('center', 50, -40, 800, 'left'), 60);

  // Dropping text when canvas has no committed blocks appends to tailText
  const onEmpty = appendDroppedTextToTextbook([], 'Intro', 'Cardiac cycle overview.', 'tail_1', 'blk_1');
  assert.equal(onEmpty.committedBlocks.length, 0);
  assert.equal(onEmpty.tailText, 'Intro\n\nCardiac cycle overview.');

  // Dropping text when committed blocks exist flushes tailText and appends a new text block
  const existing = [
    { id: 'f1', type: 'figure' as const, pageNumber: 0, figureId: 'fig1', figureCode: 'IMG-1', align: 'left' as const, widthPct: 42 },
  ];
  const onPopulated = appendDroppedTextToTextbook(existing, 'Side note', 'Ventricles contract during systole.', 'tail_2', 'blk_2');
  assert.equal(onPopulated.tailText, '');
  assert.equal(onPopulated.addedBlockId, 'blk_2');
  assert.deepEqual(onPopulated.committedBlocks.map((b) => b.content), [
    undefined,
    'Side note',
    'Ventricles contract during systole.',
  ]);

  // Moving a figure block to the tail area flushes any tailText above it and places the figure below
  const tailMove = moveTextbookBlockToTail(existing, 'Closing paragraph.', 'tail_3', 'f1');
  assert.equal(tailMove.committedTail, true);
  assert.equal(tailMove.tailText, '');
  assert.deepEqual(tailMove.committedBlocks.map((b) => b.id), ['tail_3', 'f1']);

  // 3-position horizontal snap zones ('left' | 'center' | 'right') with boundary hysteresis
  assert.equal(resolveHorizontalSnapAlign(0.15), 'left');
  assert.equal(resolveHorizontalSnapAlign(0.5), 'center');
  assert.equal(resolveHorizontalSnapAlign(0.85), 'right');
  assert.equal(resolveHorizontalSnapAlign(0.35, 'left'), 'left');
  assert.equal(resolveHorizontalSnapAlign(0.35, 'center'), 'center');
  assert.equal(resolveHorizontalSnapAlign(0.65, 'right'), 'right');
  assert.equal(resolveHorizontalSnapAlign(0.65, 'center'), 'center');

  // applyDraggedFigurePlacement moves figure cleanly before text for Left wrap and below tail text when requested
  const txtBlock = { id: 't1', type: 'text' as const, pageNumber: 0, content: 'Intro paragraph' };
  const figBlock = { id: 'f1', type: 'figure' as const, pageNumber: 0, figureId: 'fig1', figureCode: 'IMG-1', align: 'center' as const, widthPct: 85 };
  const placedBeforeLeft = applyDraggedFigurePlacement([txtBlock, figBlock], '', 'tail_4', 'f1', 0, 'left', false);
  assert.deepEqual(placedBeforeLeft.committedBlocks.map((b) => b.id), ['f1', 't1']);
  assert.equal(placedBeforeLeft.committedBlocks[0].align, 'left');
  assert.equal(placedBeforeLeft.committedBlocks[0].widthPct, 42);

  const moderateFig = { ...figBlock, widthPct: 50 };
  const placedRightPreservingWidth = applyDraggedFigurePlacement([txtBlock, moderateFig], '', 'tail_4b', 'f1', 0, 'right', false);
  assert.equal(placedRightPreservingWidth.committedBlocks[0].align, 'right');
  assert.equal(placedRightPreservingWidth.committedBlocks[0].widthPct, 50);

  const placedBelowTail = applyDraggedFigurePlacement([figBlock, txtBlock], 'Ending note', 'tail_5', 'f1', 1, 'right', true);
  assert.equal(placedBelowTail.committedTail, true);
  assert.equal(placedBelowTail.tailText, '');
  assert.deepEqual(placedBelowTail.committedBlocks.map((b) => b.id), ['t1', 'tail_5', 'f1']);
  assert.equal(placedBelowTail.committedBlocks[2].align, 'right');

  // Card visual center snapping works intuitively even for ~56%-wide cards
  // Flow 400px wide (left=100), Card 224px wide:
  // Center card (left=188, center=300 => 50%) -> 'center'
  assert.equal(resolveCardHorizontalSnapAlign(188, 224, 100, 400, 'center'), 'center');
  // Shifted left 55px (left=133, center=245 => 36.25%) -> snaps cleanly to 'left'
  assert.equal(resolveCardHorizontalSnapAlign(133, 224, 100, 400, 'center'), 'left');
  // Shifted right 55px (left=243, center=355 => 63.75%) -> snaps cleanly to 'right'
  assert.equal(resolveCardHorizontalSnapAlign(243, 224, 100, 400, 'center'), 'right');

  // Responsive vertical drag: dragging a tall figure (240px) up by just 40px past paragraph bottom (210)
  // immediately activates index 0 without requiring the user to drag to the top of the screen
  const paraRects = [{ id: 'p1', type: 'text' as const, top: 120, bottom: 210, height: 90 }];
  assert.equal(
    resolveDraggedFigureInsertIndex({
      remainingRects: paraRects,
      currentIndex: 1,
      targetAlign: 'center',
      cardTop: 186, // only 40px up from 226
      cardHeight: 240,
      movingUp: true,
      movingDown: false,
    }),
    0
  );
  // Dragging down while side-by-side with short paragraph activates index 1 as soon as cardTop clears paragraph bottom
  assert.equal(
    resolveDraggedFigureInsertIndex({
      remainingRects: paraRects,
      currentIndex: 0,
      targetAlign: 'left',
      cardTop: 222,
      cardHeight: 240,
      movingUp: false,
      movingDown: true,
      placeholderBottom: 360,
    }),
    1
  );
});

test('line-based vertical drag helpers coalesce text, map rendered lines safely around math, step line-by-line, and split paragraphs cleanly', () => {
  // coalesceAdjacentTextBlocks joins mid-sentence fragments with space and complete sentences with blank line
  const coalesced = coalesceAdjacentTextBlocks([
    { id: 't1', type: 'text', pageNumber: 0, content: 'Hemoglobin binds oxygen inside' },
    { id: 't2', type: 'text', pageNumber: 0, content: 'the alveolar capillaries efficiently.' },
    { id: 't3', type: 'text', pageNumber: 0, content: 'Lower pH causes a Bohr shift.' },
  ]);
  assert.equal(coalesced.length, 1);
  assert.equal(
    coalesced[0].content,
    'Hemoglobin binds oxygen inside the alveolar capillaries efficiently.\n\nLower pH causes a Bohr shift.'
  );

  // buildDragBaseFlow strips the dragged figure, pulls in tailText, and reunites surrounding text
  const built = buildDragBaseFlow(
    [
      { id: 'b1', type: 'text', pageNumber: 0, content: 'First half of sentence' },
      { id: 'fig1', type: 'figure', pageNumber: 0, figureId: 'f1', align: 'left', widthPct: 42 },
      { id: 'b2', type: 'text', pageNumber: 0, content: 'continues right here.' },
    ],
    'And a trailing paragraph.',
    'tail_x',
    'fig1'
  );
  assert.equal(built.hadTailText, true);
  assert.equal(built.baseBlocks.length, 1);
  assert.equal(
    built.baseBlocks[0].content,
    'First half of sentence continues right here.\n\nAnd a trailing paragraph.'
  );

  // mapRenderedLineStartTokensToRawOffsets avoids breaking inside inline KaTeX $...$ and disambiguates repeated phrases
  const mathAndRepeatRaw =
    'We track the heart before the heart pumps with $E = mc^2$ inside active muscle capillaries today.';
  const offsets = mapRenderedLineStartTokensToRawOffsets(mathAndRepeatRaw, [
    { firstWords: ['We', 'track', 'the'], approxCharLength: 26 },
    { firstWords: ['the', 'heart', 'pumps'], approxCharLength: 18 },
    { firstWords: ['inside', 'active', 'muscle'], approxCharLength: 30 },
  ]);
  assert.equal(offsets[0], 0);
  // Line 2 must match the SECOND "the heart pumps" (index 26), NOT the first "the heart" (index 9)!
  assert.equal(mathAndRepeatRaw.slice(offsets[1], offsets[1] + 15), 'the heart pumps');
  // Line 3 starts cleanly after the $E = mc^2$ span
  assert.equal(mathAndRepeatRaw.slice(offsets[2], offsets[2] + 13), 'inside active');
  assert.deepEqual(resolveSplitTextParts(mathAndRepeatRaw, offsets[1]), {
    before: 'We track the heart before',
    after: 'the heart pumps with $E = mc^2$ inside active muscle capillaries today.',
  });

  // resolveLineDragTarget steps 1 line at a time in Left/Right wrap mode and Center mode
  const lineTargets = [
    { blockIndex: 0, splitOffset: 0, lineTop: 100, lineBottom: 124 },
    { blockIndex: 0, splitOffset: 42, lineTop: 124, lineBottom: 148 },
    { blockIndex: 0, splitOffset: 84, lineTop: 148, lineBottom: 172 },
    { blockIndex: 0, splitOffset: 126, lineTop: 172, lineBottom: 196 },
    { blockIndex: 1, splitOffset: 0, lineTop: 196, lineBottom: 236 },
  ];
  // Moving UP from end-of-doc (idx 4) onto line 3 (lineBottom 196)
  assert.equal(
    resolveLineDragTarget({
      targets: lineTargets,
      currentTargetIdx: 4,
      targetAlign: 'left',
      cardTop: 185,
      cardHeight: 160,
      placeholderHeight: 160,
      movingUp: true,
      movingDown: false,
    }),
    3
  );
  // Moving DOWN 1 line in Left wrap mode from line 1 (124..148) -> line 2 when cardTop crosses 146
  assert.equal(
    resolveLineDragTarget({
      targets: lineTargets,
      currentTargetIdx: 1,
      targetAlign: 'left',
      cardTop: 147,
      cardHeight: 160,
      placeholderHeight: 160,
      movingUp: false,
      movingDown: true,
    }),
    2
  );
  // Moving DOWN 1 line in Center mode also activates immediately in ~23px without waiting to drag past full 160px card height
  assert.equal(
    resolveLineDragTarget({
      targets: lineTargets,
      currentTargetIdx: 1,
      targetAlign: 'center',
      cardTop: 147,
      cardHeight: 160,
      placeholderHeight: 160,
      movingUp: false,
      movingDown: true,
    }),
    2
  );

  // applyLineDraggedFigurePlacement splits target text cleanly mid-paragraph on drop
  let newIdCounter = 0;
  const committed = applyLineDraggedFigurePlacement({
    committedBlocks: [
      { id: 't_all', type: 'text', pageNumber: 0, content: 'Line one text.\n\nLine two wraps beside figure.' },
      { id: 'fig_1', type: 'figure', pageNumber: 0, figureId: 'f_1', align: 'center', widthPct: 56 },
    ],
    tailText: '',
    tailBlockId: 'tail_0',
    dragBlockId: 'fig_1',
    targetBlockIndex: 0,
    targetSplitOffset: 16,
    targetAlign: 'left',
    createNewBlockId: () => `new_${++newIdCounter}`,
  });
  assert.equal(committed.committedBlocks.length, 3);
  assert.equal(committed.committedBlocks[0].content, 'Line one text.');
  assert.equal(committed.committedBlocks[1].id, 'fig_1');
  assert.equal(committed.committedBlocks[1].align, 'left');
  assert.equal(committed.committedBlocks[1].widthPct, 56);
  assert.equal(committed.committedBlocks[2].id, 'new_1');
  assert.equal(committed.committedBlocks[2].content, 'Line two wraps beside figure.');
});

test('paragraph splitting, full-width figure normalization, and consistent figure caption cleanup work cleanly', () => {
  const md = [
    '# فصل ۴',
    '## گردش مواد در بدن',
    'در سال‌های گذشته آموختید که دستگاه گردش مواد شامل قلب، رگ‌ها و خون است.',
    '',
    '- مورد اول',
    '- مورد دوم',
    '',
    '$$',
    'CO = HR \\times SV',
    '$$',
    '',
    '```ts',
    'const x = 1;',
    '',
    'const y = 2;',
    '```',
  ].join('\n');

  const paragraphs = splitMarkdownIntoParagraphs(md);
  assert.deepEqual(paragraphs, [
    '# فصل ۴',
    '## گردش مواد در بدن',
    'در سال‌های گذشته آموختید که دستگاه گردش مواد شامل قلب، رگ‌ها و خون است.',
    '- مورد اول\n- مورد دوم',
    '$$\nCO = HR \\times SV\n$$',
    '```ts\nconst x = 1;\n\nconst y = 2;\n```',
  ]);

  let seq = 0;
  const normalized = normalizeBlocksToParagraphs(
    [
      { id: 't1', type: 'text', pageNumber: 1, content: 'Para 1.\n\nPara 2.' },
      { id: 'f1', type: 'figure', pageNumber: 1, figureId: 'fig1', align: 'left', widthPct: 45 },
    ],
    () => `gen_${++seq}`,
    true
  );
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].id, 't1');
  assert.equal(normalized[0].content, 'Para 1.');
  assert.equal(normalized[1].id, 'gen_1');
  assert.equal(normalized[1].content, 'Para 2.');
  assert.equal(normalized[2].align, 'full');
  assert.equal(normalized[2].widthPct, 100);

  // Caption cleanup & generic detection
  assert.equal(isGenericOrEmptyFigureCaption(''), true);
  assert.equal(isGenericOrEmptyFigureCaption('Figure 1 (Page 4)'), true);
  assert.equal(isGenericOrEmptyFigureCaption('شکل ۱'), true);
  assert.equal(isGenericOrEmptyFigureCaption('سطح شکمی قلب'), false);

  assert.equal(cleanConsistentFigureCaption('Figure 1 (Page 4)'), '');
  assert.equal(cleanConsistentFigureCaption('شکل ۱ـ قلب و رگ‌های متصل به آن'), 'قلب و رگ‌های متصل به آن');
  assert.equal(
    cleanConsistentFigureCaption('شکل ۶ ـ ساختار ماهیچه قلب و ارتباط‌های یاخته‌ای آن'),
    'ساختار ماهیچه قلب و ارتباط‌های یاخته‌ای آن'
  );
  assert.equal(cleanConsistentFigureCaption('Figure 4.2: Cardiac Cycle (Page 8)'), 'Cardiac Cycle');
  assert.equal(cleanConsistentFigureCaption('سطح شکمی قلب'), 'سطح شکمی قلب');

  // New synced formatting markers (pathway chains, interactive cloze, process/vocab/compare callouts)
  assert.equal(
    stripHighlightMarkup(
      '> [!PROCESS] ^^SA node -> AV node -> Bundle of His^^ delivers %%electrical impulse%% while ignoring C++ and $x^2$.'
    ),
    '> SA node -> AV node -> Bundle of His delivers electrical impulse while ignoring C++ and $x^2$.'
  );

  const calloutMd = [
    '## بافت گرهی قلب',
    '> [!VOCAB] **واژه‌شناسی**',
    '> **تاجی (Coronary) / کرونر**',
    '> کلمه کرونر به معنای تاجی است.',
    'پاراگراف بعدی بلافاصله بعد از کادر.',
  ].join('\n');
  assert.deepEqual(splitMarkdownIntoParagraphs(calloutMd), [
    '## بافت گرهی قلب',
    '> [!VOCAB] **واژه‌شناسی**\n> **تاجی (Coronary) / کرونر**\n> کلمه کرونر به معنای تاجی است.',
    'پاراگراف بعدی بلافاصله بعد از کادر.',
  ]);

  const activityBoxMd = [
    '> ### فعالیت ۱',
    '> ### تشریح قلب گوسفند',
    '> **وسایل و مواد لازم:** قلب سالم گوسفند، تشتک تشریح',
    '>',
    '> **الف) مشاهده شکل ظاهری:** سطح پشتی و شکمی را مشخص کنید.',
  ].join('\n');
  assert.deepEqual(splitMarkdownIntoParagraphs(activityBoxMd), [activityBoxMd]);
});

test('cross-page merging and coalescing never glue prose onto headings or Persian ordered lists', () => {
  const merged = mergeContinuousTextbookBlocks([
    { id: 'h1', type: 'text', pageNumber: 1, content: '## گردش مواد در بدن' },
    { id: 'p1', type: 'text', pageNumber: 2, content: 'دستگاه گردش مواد شامل قلب و رگ‌ها است.' },
    { id: 'l1', type: 'text', pageNumber: 2, content: '۱. دهلیز راست خون تیره را دریافت می‌کند' },
    { id: 'p2', type: 'text', pageNumber: 3, content: 'و به بطن راست می‌فرستد.' },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0].content,
    '## گردش مواد در بدن\n\nدستگاه گردش مواد شامل قلب و رگ‌ها است.\n\n۱. دهلیز راست خون تیره را دریافت می‌کند\n\nو به بطن راست می‌فرستد.'
  );

  const coalesced = coalesceAdjacentTextBlocks([
    { id: 'h1', type: 'text', pageNumber: 1, content: '## ساختار قلب' },
    { id: 'p1', type: 'text', pageNumber: 1, content: 'قلب در قفسه سینه قرار دارد.' },
    { id: 'l1', type: 'text', pageNumber: 1, content: '۱. لایه درونی' },
    { id: 'p2', type: 'text', pageNumber: 1, content: 'پاراگراف بعدی پس از فهرست.' },
  ]);

  assert.deepEqual(coalesced.map((b) => b.content), [
    '## ساختار قلب\n\nقلب در قفسه سینه قرار دارد.\n\n۱. لایه درونی\n\nپاراگراف بعدی پس از فهرست.',
  ]);
});

test('parseAnalyzedMarkdownWithImageBoxes extracts ordered text, subtitled image placeholder boxes, and skips lone page numbers', () => {
  const raw = [
    'در سال‌های گذشته آموختید که دستگاه گردش مواد از قلب، رگ‌ها و خون تشکیل شده است.',
    '',
    '۴۸',
    '',
    '[[IMAGE_BOX: شکل ۱ـ قلب و رگ‌های متصل به آن]]',
    '',
    'صفحه 49',
    '',
    'با گردش خون عمومی و ششی آشنا هستید.',
    '',
    '```md',
    '[[IMAGE_BOX: literal example inside code block should stay text]]',
    '48',
    '```',
  ].join('\n');

  const blocks = parseAnalyzedMarkdownWithImageBoxes(raw);
  assert.deepEqual(blocks, [
    {
      type: 'text',
      content: 'در سال‌های گذشته آموختید که دستگاه گردش مواد از قلب، رگ‌ها و خون تشکیل شده است.',
    },
    {
      type: 'figure',
      caption: 'شکل ۱ـ قلب و رگ‌های متصل به آن',
    },
    {
      type: 'text',
      content:
        'با گردش خون عمومی و ششی آشنا هستید.\n\n```md\n[[IMAGE_BOX: literal example inside code block should stay text]]\n48\n```',
    },
  ]);

  // Unfilled placeholder boxes stay clearly labeled alongside filled textbook figures without emitting IMG-N codes
  const serialized = serializeConvertedBlocksForPrompt([
    { id: 't1', type: 'text', pageNumber: 1, content: 'Intro text.' },
    { id: 'ph1', type: 'figure', pageNumber: 1, caption: 'شکل ۱ـ قلب و رگ‌های متصل به آن' },
    { id: 'f1', type: 'figure', pageNumber: 1, figureId: 'fig_1', caption: 'Blood cells' },
  ]);
  assert.ok(serialized.includes('[Image Placeholder (awaiting user upload): شکل ۱ـ قلب و رگ‌های متصل به آن]'));
  assert.ok(serialized.includes('[Figure from Page 1: Blood cells]'));
  assert.ok(!serialized.includes('[Image Code:'));
});

test('undoHistory supports multi-step undo/redo, deduping, depth cap, and Persian/English Ctrl+Z shortcuts', () => {
  let hist = createUndoHistory<{ text: string }>(3);
  const eq = (a: { text: string }, b: { text: string }) => a.text === b.text;

  hist = pushUndoSnapshot(hist, { text: 'v1' }, eq);
  hist = pushUndoSnapshot(hist, { text: 'v1' }, eq); // deduped
  hist = pushUndoSnapshot(hist, { text: 'v2' }, eq);
  hist = pushUndoSnapshot(hist, { text: 'v3' }, eq);
  hist = pushUndoSnapshot(hist, { text: 'v4' }, eq); // maxDepth=3 drops 'v1'
  assert.deepEqual(hist.past.map((x) => x.text), ['v2', 'v3', 'v4']);

  const u1 = stepUndo(hist, { text: 'v5' });
  assert.ok(u1);
  assert.equal(u1.nextState.text, 'v4');
  assert.deepEqual(u1.history.future.map((x) => x.text), ['v5']);

  const u2 = stepUndo(u1.history, u1.nextState);
  assert.ok(u2);
  assert.equal(u2.nextState.text, 'v3');

  const r1 = stepRedo(u2.history, u2.nextState);
  assert.ok(r1);
  assert.equal(r1.nextState.text, 'v4');

  // Pushing new snapshot clears redo future
  const afterNewEdit = pushUndoSnapshot(r1.history, { text: 'v4-edited' }, eq);
  assert.equal(afterNewEdit.future.length, 0);

  // Shortcuts work for both English ('z'/'y') and Persian ('ض'/'غ') via physical key code
  assert.equal(
    isUndoShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'z', code: 'KeyZ' }),
    true
  );
  assert.equal(
    isUndoShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'ض', code: 'KeyZ' }),
    true
  );
  assert.equal(
    isUndoShortcut({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: 'z', code: 'KeyZ' }),
    true
  );
  assert.equal(
    isUndoShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, key: 'Z', code: 'KeyZ' }),
    false
  );
  assert.equal(
    isRedoShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, key: 'ض', code: 'KeyZ' }),
    true
  );
  assert.equal(
    isRedoShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'غ', code: 'KeyY' }),
    true
  );
});

test('extractStandaloneUrlsFromPaste and extractUrlsFromDropData isolate pure URL pastes and drops safely', () => {
  // Single URL (including angle-bracket wrapped or trailing whitespace)
  assert.deepEqual(
    extractStandaloneUrlsFromPaste('  https://www.theguardian.com/film/2026/nov/26/story  '),
    ['https://www.theguardian.com/film/2026/nov/26/story']
  );
  assert.deepEqual(
    extractStandaloneUrlsFromPaste('<http://localhost:3000/article>'),
    ['http://localhost:3000/article']
  );

  // Multi-URL paste with duplicates and mixed whitespace
  assert.deepEqual(
    extractStandaloneUrlsFromPaste(
      'https://example.com/one\nhttps://example.com/two  https://example.com/one'
    ),
    ['https://example.com/one', 'https://example.com/two']
  );

  // Reject more than 5 unique/non-unique tokens at once
  assert.equal(
    extractStandaloneUrlsFromPaste(
      Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join('\n')
    ),
    null
  );

  // Reject prose containing inline URLs, bare words, or non-http(s) schemes
  assert.equal(
    extractStandaloneUrlsFromPaste('Read this article: https://example.com/story'),
    null
  );
  assert.equal(extractStandaloneUrlsFromPaste('javascript:alert(1)'), null);
  assert.equal(extractStandaloneUrlsFromPaste('ftp://files.example.com/a.pdf'), null);
  assert.equal(extractStandaloneUrlsFromPaste('not a url'), null);
  assert.equal(extractStandaloneUrlsFromPaste('https://singleword'), null);

  // Drop data strips text/uri-list # comment lines and falls back to text/plain
  assert.deepEqual(
    extractUrlsFromDropData(
      '# Bookmark from browser\r\nhttps://www.theguardian.com/science/story\r\n',
      'https://www.theguardian.com/science/story'
    ),
    ['https://www.theguardian.com/science/story']
  );
  assert.deepEqual(
    extractUrlsFromDropData('', 'https://en.wikipedia.org/wiki/Bohr_effect'),
    ['https://en.wikipedia.org/wiki/Bohr_effect']
  );
  assert.equal(
    extractUrlsFromDropData('# comment only', 'Just normal dragged prose'),
    null
  );
});

test('convertMarkdownImagesToImageBoxes converts article images into IMAGE_BOX placeholders while skipping UI noise and fenced code', () => {
  const scraped = [
    '# Sample Article',
    '',
    '![Author avatar](https://cdn.example.com/avatar/jane.png)',
    '![Site logo](https://cdn.example.com/logo.svg)',
    '[![Sponsor banner](https://ads.example.com/banner.jpg)](https://ads.example.com/click)',
    '',
    '![Amanda Seyfried smiling on the red carpet](https://media.example.com/photo-1.jpg)',
    '',
    'Opening paragraph preserved verbatim.',
    '',
    '[![Diagram of the Bohr shift](https://media.example.com/bohr.png)](https://example.com/zoom)',
    '',
    '```markdown',
    '![Keep literal markdown example](https://example.com/code.png)',
    '```',
  ].join('\n');

  const converted = convertMarkdownImagesToImageBoxes(scraped);
  assert.equal(converted.includes('avatar'), false);
  assert.equal(converted.includes('logo'), false);
  assert.equal(converted.includes('Sponsor'), false);
  assert.ok(converted.includes('[[IMAGE_BOX: Amanda Seyfried smiling on the red carpet]]'));
  assert.ok(converted.includes('[[IMAGE_BOX: Diagram of the Bohr shift]]'));
  assert.ok(converted.includes('![Keep literal markdown example](https://example.com/code.png)'));

  const parsed = parseAnalyzedMarkdownWithImageBoxes(converted);
  assert.deepEqual(parsed, [
    { type: 'text', content: '# Sample Article' },
    { type: 'figure', caption: 'Amanda Seyfried smiling on the red carpet' },
    { type: 'text', content: 'Opening paragraph preserved verbatim.' },
    { type: 'figure', caption: 'Diagram of the Bohr shift' },
    {
      type: 'text',
      content: '```markdown\n![Keep literal markdown example](https://example.com/code.png)\n```',
    },
  ]);
});

test('detectDominantDirection and computePathwayConnectors handle RTL mixed prose and bent row-wrap train connectors', () => {
  // Mixed Persian pathway starting with a Latin loanword still resolves to RTL
  assert.equal(
    detectDominantDirection('improvising و تمرینات طولانی با بازیگران -> رسیدن به عمل دقیق -> فیلم‌برداری'),
    'rtl'
  );
  // Pure English pathway resolves to LTR even with RTL fallback
  assert.equal(detectDominantDirection('ATP -> ADP -> AMP', 'rtl'), 'ltr');

  // RTL layout: Row 1 has wide step 0 on the right; Row 2 has step 1 on the right and step 2 to its left
  const rtlLayout = computePathwayConnectors({
    flowDir: 'rtl',
    containerWidth: 500,
    connectors: ['->', '->'],
    rects: [
      { left: 40, top: 0, width: 460, height: 56 },
      { left: 340, top: 84, width: 160, height: 32 },
      { left: 202, top: 84, width: 110, height: 32 },
    ],
  });

  assert.equal(rtlLayout.isMultiRow, true);
  assert.equal(rtlLayout.paths.length, 2);
  // First connector bends from left of step 0 down and across to right side of step 1
  assert.equal(rtlLayout.paths[0].isWrap, true);
  assert.equal(rtlLayout.paths[0].startX, 40);
  assert.ok(rtlLayout.paths[0].d.includes('Q '), 'Expected rounded bend in wrapped connector path');
  assert.ok(rtlLayout.paths[0].d.endsWith('82.5'), 'Expected downward entry into top of Row 2 step');
  // Second connector connects same-row RTL from step 1 left (340) to step 2 right (312)
  assert.equal(rtlLayout.paths[1].isWrap, false);
  assert.equal(rtlLayout.paths[1].startX, 340);

  // LTR layout: Row 1 step 0 wraps down to Row 2 step 1 on the left
  const ltrLayout = computePathwayConnectors({
    flowDir: 'ltr',
    containerWidth: 500,
    connectors: ['↔'],
    rects: [
      { left: 0, top: 0, width: 450, height: 32 },
      { left: 0, top: 60, width: 180, height: 32 },
    ],
  });

  assert.equal(ltrLayout.isMultiRow, true);
  assert.equal(ltrLayout.paths[0].isWrap, true);
  assert.equal(ltrLayout.paths[0].isBidirectional, true);
  assert.equal(ltrLayout.paths[0].startX, 450);
  assert.ok(ltrLayout.paths[0].d.includes('Q '));
});

test('precleanWebpageMarkdown and cleanScrapedWebpageFallback isolate main article and strip webpage chrome', () => {
  const noisy = [
    '[Skip to main content](https://www.theguardian.com/world#maincontent)[Skip to navigation](https://www.theguardian.com/world#navigation)',
    '',
    'Close dialogue 1/3 Next image Previous image Toggle caption',
    '',
    'Support the Guardian',
    'Fund independent journalism with $7.50 per month [Make a year-end gift](https://support.theguardian.com/?REFPVID=abc&INTCMP=test)',
    '',
    '[News](https://www.theguardian.com/news)',
    '[Opinion](https://www.theguardian.com/opinion)',
    '[Sport](https://www.theguardian.com/sport)',
    '[Culture](https://www.theguardian.com/culture)',
    '',
    '# ‘I’m no longer a UAE official’: UN hopeful Lana Nusseibeh tries to shake off Sudan record',
    '',
    '![Lana Nusseibeh speaking at the UN](https://media.example.com/photo.jpg)',
    '',
    'In an interview with [The Guardian](https://www.theguardian.com/profile), the diplomat addressed questions about Sudan and regional diplomacy in detailed remarks over several paragraphs of substantive reporting.',
    '',
    'She argued that diplomatic engagement remained vital for humanitarian corridors and long-term stability across the region, rejecting allegations made by critics.',
    '',
    'Support the Guardian Available for everyone, funded by readers [Support us](https://support.theguardian.com/)',
    '[Back to top](https://www.theguardian.com/#top)',
    '© 2026 Guardian News & Media Limited or its affiliated companies. All rights reserved.(dcr)',
    '',
    'Now live: Our critical year-end fundraiser',
    'Please contribute if you can $964,693 of $2,000,000 goal',
    '- Far fewer asks for support',
    '- Ad-free reading on all your devices',
    'Black Friday offer Support another way',
    '[Continue](https://support.theguardian.com/us/contribute?REFPVID=xyz)',
    'Collapse banner',
  ].join('\n');

  const precleaned = precleanWebpageMarkdown(noisy);
  assert.equal(precleaned.includes('Skip to main content'), false);
  assert.equal(precleaned.includes('Close dialogue'), false);
  assert.equal(precleaned.includes('Support the Guardian'), false);
  assert.equal(precleaned.includes('Black Friday offer'), false);
  assert.equal(precleaned.includes('REFPVID'), false);
  assert.equal(precleaned.includes('https://www.theguardian.com/news'), false);
  assert.ok(precleaned.includes('# ‘I’m no longer a UAE official’'));
  assert.ok(precleaned.includes('In an interview with The Guardian, the diplomat addressed'));

  const fallback = cleanScrapedWebpageFallback(noisy);
  assert.ok(fallback.includes('[[IMAGE_BOX: Lana Nusseibeh speaking at the UN]]'));
  assert.equal(fallback.includes('year-end fundraiser'), false);
});

test('extractWebpageMetadataFromHtml and ensureWebpageMarkdownHasTitle recover out-of-article headlines and bylines cleanly', () => {
  const html = `<!doctype html>
    <html>
      <head>
        <title>Germany proposes crisis core network for mobile service | Telecoms Tech News</title>
        <meta property="og:site_name" content="Telecoms Tech News" />
        <meta property="og:title" content="Germany proposes crisis core network for mobile service" />
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "NewsArticle",
            "headline": "Germany proposes crisis core network for mobile service",
            "author": { "@type": "Person", "name": "Ryan Daws" },
            "datePublished": "2026-11-26T09:00:00Z"
          }
        </script>
      </head>
      <body>
        <header><h1>TELECOMS</h1></header>
        <div class="hero-header">
          <h1 class="entry-title">Germany proposes crisis core network for mobile service</h1>
          <time datetime="2026-11-26">26th November 2026</time>
        </div>
        <main>
          <article>
            <figure>
              <img src="https://cdn.example.com/crisis-tower.jpg" alt="Telecom engineer working on mast" />
              <figcaption>Engineer inspecting mobile relay tower infrastructure</figcaption>
            </figure>
            <p>Germany's Federal Network Agency proposes a crisis core network.</p>
          </article>
        </main>
      </body>
    </html>`;

  const meta = extractWebpageMetadataFromHtml(
    html,
    'https://www.telecomstechnews.com/news/germany-crisis-core-network-for-mobile-service/'
  );
  assert.equal(meta.title, 'Germany proposes crisis core network for mobile service');
  assert.equal(meta.author, 'Ryan Daws');
  assert.equal(meta.publishedDate, '26th November 2026');
  assert.equal(meta.heroImageUrl, 'https://cdn.example.com/crisis-tower.jpg');
  assert.equal(meta.heroImageAlt, 'Engineer inspecting mobile relay tower infrastructure');

  // Prepends title when missing
  assert.equal(
    ensureWebpageMarkdownHasTitle('Opening paragraph verbatim.', meta.title),
    '# Germany proposes crisis core network for mobile service\n\nOpening paragraph verbatim.'
  );

  // Upgrades matching H2 without duplicating
  assert.equal(
    ensureWebpageMarkdownHasTitle(
      '## Germany proposes crisis core network for mobile service\n\nOpening paragraph verbatim.',
      meta.title
    ),
    '# Germany proposes crisis core network for mobile service\n\nOpening paragraph verbatim.'
  );

  // Keeps existing top-level H1 intact
  assert.equal(
    ensureWebpageMarkdownHasTitle('# Existing Headline\n\nBody text.', meta.title),
    '# Existing Headline\n\nBody text.'
  );
});

test('coalesceAdjacentTextBlocks and mergeContinuousTextbookBlocks respect delimited endings and standalone bylines', () => {
  const coalesced = coalesceAdjacentTextBlocks([
    { id: 't1', type: 'text', pageNumber: 0, content: '*Ryan Daws · 26th November 2026*' },
    { id: 't2', type: 'text', pageNumber: 0, content: 'It preserves ==cellular redundancy.==' },
    { id: 't3', type: 'text', pageNumber: 0, content: 'Next paragraph starts cleanly.' },
  ]);
  assert.equal(coalesced.length, 1);
  assert.equal(
    coalesced[0].content,
    '*Ryan Daws · 26th November 2026*\n\nIt preserves ==cellular redundancy.==\n\nNext paragraph starts cleanly.'
  );

  const merged = mergeContinuousTextbookBlocks([
    { id: 'p1', type: 'text', pageNumber: 1, content: '*Ryan Daws · 26th November 2026*' },
    { id: 'p2', type: 'text', pageNumber: 1, content: 'First sentence **complete.**' },
    { id: 'p3', type: 'text', pageNumber: 2, content: 'Second paragraph stays distinct.' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(
    merged[0].content,
    '*Ryan Daws · 26th November 2026*\n\nFirst sentence **complete.**\n\nSecond paragraph stays distinct.'
  );
});




