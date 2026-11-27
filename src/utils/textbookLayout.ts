import type { TextbookConvertedBlock, TextbookFigureAlign } from '../types/talk';

export const DEFAULT_FLOAT_WIDTH_PCT = 42;
export const DEFAULT_CENTER_WIDTH_PCT = 64;
export const MIN_FIGURE_WIDTH_PCT = 24;
export const MAX_FLOAT_WIDTH_PCT = 72;

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeFigureAlign(raw?: string | null): TextbookFigureAlign {
  if (raw === 'left' || raw === 'center' || raw === 'right' || raw === 'full') {
    return raw;
  }
  return 'center';
}

export function normalizeFigureWidthPct(
  align: TextbookFigureAlign,
  rawWidthPct?: number
): number {
  if (align === 'full') return 100;
  if (align === 'left' || align === 'right') {
    if (typeof rawWidthPct !== 'number' || !Number.isFinite(rawWidthPct) || rawWidthPct > MAX_FLOAT_WIDTH_PCT) {
      return DEFAULT_FLOAT_WIDTH_PCT;
    }
    return clampNumber(rawWidthPct, MIN_FIGURE_WIDTH_PCT, MAX_FLOAT_WIDTH_PCT);
  }
  if (typeof rawWidthPct !== 'number' || !Number.isFinite(rawWidthPct)) {
    return DEFAULT_CENTER_WIDTH_PCT;
  }
  return clampNumber(rawWidthPct, MIN_FIGURE_WIDTH_PCT, 100);
}

/**
 * Resolves the default paper-design placement (left / center / right / full and width%)
 * for an auto-analyzed textbook figure, preferring explicit AI spatial metadata and
 * falling back to the cropped box's horizontal position on the page.
 */
export function inferFigureBoxLayout(
  box_2d?: [number, number, number, number],
  aiAlign?: string | null,
  aiWidthPct?: number
): { align: TextbookFigureAlign; widthPct: number } {
  const validAiAlign =
    aiAlign === 'left' || aiAlign === 'center' || aiAlign === 'right' || aiAlign === 'full'
      ? aiAlign
      : null;

  if (validAiAlign) {
    return {
      align: validAiAlign,
      widthPct: normalizeFigureWidthPct(validAiAlign, aiWidthPct),
    };
  }

  if (box_2d && box_2d.length === 4) {
    const rawXMin = Math.min(box_2d[1], box_2d[3]);
    const rawXMax = Math.max(box_2d[1], box_2d[3]);
    const span = Math.max(100, rawXMax - rawXMin);
    const spanPct = Math.round(span / 10);

    if (span >= 880) {
      return { align: 'full', widthPct: 100 };
    }
    if (span >= 680) {
      return {
        align: 'center',
        widthPct: clampNumber(spanPct, 45, 92),
      };
    }
    if (rawXMin <= 180 && rawXMax <= 620) {
      return {
        align: 'left',
        widthPct: clampNumber(spanPct, 28, 56),
      };
    }
    if (rawXMin >= 380 && rawXMax >= 820) {
      return {
        align: 'right',
        widthPct: clampNumber(spanPct, 28, 56),
      };
    }
    return {
      align: 'center',
      widthPct: clampNumber(spanPct, 36, 75),
    };
  }

  return {
    align: 'center',
    widthPct: normalizeFigureWidthPct('center', aiWidthPct),
  };
}

export function getBlockFigureAlign(block: TextbookConvertedBlock): TextbookFigureAlign {
  return normalizeFigureAlign(block.align);
}

export function getBlockFigureWidthPct(block: TextbookConvertedBlock): number {
  return normalizeFigureWidthPct(getBlockFigureAlign(block), block.widthPct);
}

export function updateFigureBlockLayout(
  blocks: TextbookConvertedBlock[],
  blockId: string,
  patch: { align?: TextbookFigureAlign; widthPct?: number }
): TextbookConvertedBlock[] {
  return blocks.map((block) => {
    if (block.id !== blockId || block.type !== 'figure') return block;

    const currentAlign = getBlockFigureAlign(block);
    const nextAlign = patch.align ?? currentAlign;

    let nextWidthPct: number;
    if (typeof patch.widthPct === 'number') {
      nextWidthPct = normalizeFigureWidthPct(nextAlign, patch.widthPct);
    } else if (patch.align && patch.align !== currentAlign) {
      if (nextAlign === 'full') {
        nextWidthPct = 100;
      } else if (nextAlign === 'left' || nextAlign === 'right') {
        const prevW = typeof block.widthPct === 'number' ? block.widthPct : DEFAULT_FLOAT_WIDTH_PCT;
        nextWidthPct = prevW > MAX_FLOAT_WIDTH_PCT ? DEFAULT_FLOAT_WIDTH_PCT : normalizeFigureWidthPct(nextAlign, prevW);
      } else {
        // Switching to 'center'
        const prevW = typeof block.widthPct === 'number' ? block.widthPct : DEFAULT_CENTER_WIDTH_PCT;
        nextWidthPct = prevW >= 95 ? DEFAULT_CENTER_WIDTH_PCT : normalizeFigureWidthPct('center', prevW);
      }
    } else {
      nextWidthPct = normalizeFigureWidthPct(nextAlign, block.widthPct);
    }

    return {
      ...block,
      align: nextAlign,
      widthPct: nextWidthPct,
    };
  });
}

export function moveTextbookBlock(
  blocks: TextbookConvertedBlock[],
  blockId: string,
  direction: 'up' | 'down'
): TextbookConvertedBlock[] {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1) return blocks;
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= blocks.length) return blocks;
  const copy = [...blocks];
  const [item] = copy.splice(idx, 1);
  copy.splice(targetIdx, 0, item);
  return copy;
}

export function reorderTextbookBlock(
  blocks: TextbookConvertedBlock[],
  sourceId: string,
  targetId: string
): TextbookConvertedBlock[] {
  if (sourceId === targetId) return blocks;
  const fromIdx = blocks.findIndex((b) => b.id === sourceId);
  const toIdx = blocks.findIndex((b) => b.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return blocks;
  const copy = [...blocks];
  const [moved] = copy.splice(fromIdx, 1);
  copy.splice(toIdx, 0, moved);
  return copy;
}

export function splitTextBlockAtOffset(
  blocks: TextbookConvertedBlock[],
  blockId: string,
  cursorOffset: number | undefined,
  newBlockId: string
): TextbookConvertedBlock[] {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1) return blocks;
  const target = blocks[idx];
  if (target.type !== 'text') return blocks;

  const raw = target.content ?? '';
  let splitPos =
    typeof cursorOffset === 'number' && cursorOffset > 0 && cursorOffset < raw.length
      ? cursorOffset
      : -1;

  // If cursor is at start/end or not provided, split at the nearest paragraph break (\n\n)
  if (splitPos === -1) {
    const mid = Math.floor(raw.length / 2);
    const forward = raw.indexOf('\n\n', Math.max(0, mid - Math.floor(raw.length / 3)));
    const backward = raw.lastIndexOf('\n\n', mid);
    if (forward !== -1) splitPos = forward;
    else if (backward !== -1) splitPos = backward;
  }

  if (splitPos <= 0 || splitPos >= raw.length) return blocks;

  const firstPart = raw.slice(0, splitPos).trimEnd();
  const secondPart = raw.slice(splitPos).trimStart();
  if (!firstPart || !secondPart) return blocks;

  const next = [...blocks];
  next.splice(
    idx,
    1,
    { ...target, content: firstPart },
    {
      id: newBlockId,
      type: 'text',
      pageNumber: target.pageNumber,
      content: secondPart,
    }
  );
  return next;
}

export function mergeTextBlockWithNext(
  blocks: TextbookConvertedBlock[],
  blockId: string
): TextbookConvertedBlock[] {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1 || idx >= blocks.length - 1) return blocks;
  const curr = blocks[idx];
  const nextBlock = blocks[idx + 1];
  if (curr.type !== 'text' || nextBlock.type !== 'text') return blocks;

  const combined = [curr.content?.trimEnd(), nextBlock.content?.trimStart()]
    .filter((s) => Boolean(s && s.length > 0))
    .join('\n\n');

  const copy = [...blocks];
  copy.splice(idx, 2, {
    ...curr,
    content: combined,
  });
  return copy;
}

export function insertTextBlockAdjacent(
  blocks: TextbookConvertedBlock[],
  anchorBlockId: string,
  position: 'before' | 'after',
  newBlockId: string,
  initialContent = ''
): TextbookConvertedBlock[] {
  const idx = blocks.findIndex((b) => b.id === anchorBlockId);
  const newBlock: TextbookConvertedBlock = {
    id: newBlockId,
    type: 'text',
    pageNumber: 0,
    content: initialContent,
  };
  if (idx === -1) {
    return [...blocks, newBlock];
  }
  const copy = [...blocks];
  const insertIdx = position === 'before' ? idx : idx + 1;
  copy.splice(insertIdx, 0, newBlock);
  return copy;
}

/**
 * Formats an internal figure code (e.g. "IMG-1") into a clean reader-facing label ("Image 1").
 */
export function formatTextbookImageLabel(code?: string | null, fallbackNumber = 1): string {
  if (code) {
    const match = code.trim().match(/^IMG[-_\s]?(\d+)$/i);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > 0) return `Image ${n}`;
    }
  }
  const safeNum = Number.isFinite(fallbackNumber) && fallbackNumber > 0 ? Math.round(fallbackNumber) : 1;
  return `Image ${safeNum}`;
}

/**
 * Computes the next width percentage during a horizontal edge drag resize on a figure frame.
 */
export function computeResizedFigureWidthPct(
  align: TextbookFigureAlign,
  startWidthPct: number,
  deltaX: number,
  containerWidthPx: number,
  handleSide?: 'left' | 'right'
): number {
  if (align === 'full' || !Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
    return align === 'full' ? 100 : normalizeFigureWidthPct(align, startWidthPct);
  }
  const side = handleSide ?? (align === 'right' ? 'left' : 'right');
  const signedDelta = side === 'left' ? -deltaX : deltaX;
  const effectiveDeltaX = align === 'center' ? signedDelta * 2 : signedDelta;
  const deltaPct = (effectiveDeltaX / containerWidthPx) * 100;
  const maxPct = align === 'center' ? 100 : MAX_FLOAT_WIDTH_PCT;
  return clampNumber(startWidthPct + deltaPct, MIN_FIGURE_WIDTH_PCT, maxPct);
}

/**
 * Appends dropped plain text into the unified textbook layout cleanly:
 * - If committedBlocks already exist, flushes any pending tailText and appends a new text block.
 * - If no committedBlocks exist yet, appends to tailText seamlessly.
 */
export function appendDroppedTextToTextbook(
  committedBlocks: TextbookConvertedBlock[],
  tailText: string,
  droppedText: string,
  tailBlockId: string,
  newBlockId: string
): {
  committedBlocks: TextbookConvertedBlock[];
  tailText: string;
  addedBlockId: string | null;
} {
  const clean = droppedText.replace(/\r\n/g, '\n').trim();
  if (!clean) {
    return { committedBlocks, tailText, addedBlockId: null };
  }

  if (committedBlocks.length === 0) {
    const nextTail = tailText.trim() ? `${tailText.trimEnd()}\n\n${clean}` : clean;
    return {
      committedBlocks,
      tailText: nextTail,
      addedBlockId: null,
    };
  }

  const nextBlocks = [...committedBlocks];
  if (tailText.trim()) {
    nextBlocks.push({
      id: tailBlockId,
      type: 'text',
      pageNumber: 0,
      content: tailText.trim(),
    });
  }
  nextBlocks.push({
    id: newBlockId,
    type: 'text',
    pageNumber: 0,
    content: clean,
  });

  return {
    committedBlocks: nextBlocks,
    tailText: '',
    addedBlockId: newBlockId,
  };
}

/**
 * Moves an existing committed block to the end of the textbook flow (below all text).
 * If unsaved tailText exists, commits that paragraph before the moved block so the
 * dragged image/block cleanly lands underneath it.
 */
export function moveTextbookBlockToTail(
  committedBlocks: TextbookConvertedBlock[],
  tailText: string,
  tailBlockId: string,
  sourceId: string
): {
  committedBlocks: TextbookConvertedBlock[];
  tailText: string;
  committedTail: boolean;
} {
  const idx = committedBlocks.findIndex((b) => b.id === sourceId);
  if (idx === -1) {
    return { committedBlocks, tailText, committedTail: false };
  }

  const trimmedTail = tailText.trim();
  const withoutSource = committedBlocks.filter((b) => b.id !== sourceId);
  const movedBlock = committedBlocks[idx];

  if (trimmedTail.length > 0) {
    return {
      committedBlocks: [
        ...withoutSource,
        {
          id: tailBlockId,
          type: 'text',
          pageNumber: 0,
          content: trimmedTail,
        },
        movedBlock,
      ],
      tailText: '',
      committedTail: true,
    };
  }

  if (idx === committedBlocks.length - 1) {
    return { committedBlocks, tailText, committedTail: false };
  }

  return {
    committedBlocks: [...withoutSource, movedBlock],
    tailText,
    committedTail: false,
  };
}

/**
 * Resolves the 3 horizontal placement positions ('left' | 'center' | 'right')
 * from a normalized horizontal pointer ratio [0..1] inside the textbook flow canvas,
 * using a small hysteresis margin around 1/3 and 2/3 thresholds to avoid edge jitter.
 */
export function resolveHorizontalSnapAlign(
  relativeX: number,
  currentAlign?: TextbookFigureAlign
): 'left' | 'center' | 'right' {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(relativeX) ? relativeX : 0.5));
  const leftExit = currentAlign === 'left' ? 0.37 : 0.33;
  const rightEnter = currentAlign === 'right' ? 0.63 : 0.67;

  if (clamped < leftExit) return 'left';
  if (clamped > rightEnter) return 'right';
  return 'center';
}

/**
 * Computes the updated blocks and tail text when placing a dragged figure
 * at an exact horizontal alignment ('left' | 'center' | 'right') and vertical
 * insertion slot among the remaining blocks (or below tail text).
 */
export function applyDraggedFigurePlacement(
  committedBlocks: TextbookConvertedBlock[],
  tailText: string,
  tailBlockId: string,
  dragBlockId: string,
  otherBlockInsertIndex: number,
  targetAlign: 'left' | 'center' | 'right',
  placeBelowTail = false
): {
  committedBlocks: TextbookConvertedBlock[];
  tailText: string;
  committedTail: boolean;
} {
  const dragBlock = committedBlocks.find((b) => b.id === dragBlockId && b.type === 'figure');
  if (!dragBlock) {
    return { committedBlocks, tailText, committedTail: false };
  }

  const updatedDragBlock: TextbookConvertedBlock = {
    ...dragBlock,
    align: targetAlign,
    widthPct: normalizeFigureWidthPct(targetAlign, dragBlock.widthPct),
  };

  const remaining = committedBlocks.filter((b) => b.id !== dragBlockId);
  const trimmedTail = tailText.trim();

  if (placeBelowTail && trimmedTail.length > 0) {
    return {
      committedBlocks: [
        ...remaining,
        {
          id: tailBlockId,
          type: 'text',
          pageNumber: 0,
          content: trimmedTail,
        },
        updatedDragBlock,
      ],
      tailText: '',
      committedTail: true,
    };
  }

  const clampedIdx = Math.max(0, Math.min(remaining.length, otherBlockInsertIndex));
  const nextBlocks = [...remaining];
  nextBlocks.splice(clampedIdx, 0, updatedDragBlock);

  return {
    committedBlocks: nextBlocks,
    tailText,
    committedTail: false,
  };
}

export interface DragBlockRect {
  id: string;
  type: 'text' | 'figure';
  top: number;
  bottom: number;
  height: number;
}

/**
 * Resolves Left / Center / Right placement from the dragged card's horizontal
 * visual center inside the textbook flow canvas rather than raw cursor X, with
 * mild center-offset amplification (1.38x) so wider cards snap cleanly to Left
 * or Right without needing to hit the container wall.
 */
export function resolveCardHorizontalSnapAlign(
  cardLeft: number,
  cardWidth: number,
  flowLeft: number,
  flowWidth: number,
  currentAlign: 'left' | 'center' | 'right'
): 'left' | 'center' | 'right' {
  if (!Number.isFinite(flowWidth) || flowWidth <= 0) return currentAlign;
  const cardCenterRelX = (cardLeft + cardWidth / 2 - flowLeft) / flowWidth;
  const effectiveRelX = 0.5 + (cardCenterRelX - 0.5) * 1.38;
  return resolveHorizontalSnapAlign(effectiveRelX, currentAlign);
}

/**
 * Resolves the target vertical insertion index among non-dragged blocks using
 * the dragged card's leading edge/center and drag direction so vertical moves
 * activate quickly without layout flip-flop.
 */
export function resolveDraggedFigureInsertIndex(params: {
  remainingRects: DragBlockRect[];
  currentIndex: number;
  targetAlign: 'left' | 'center' | 'right';
  cardTop: number;
  cardHeight: number;
  movingUp: boolean;
  movingDown: boolean;
  placeholderBottom?: number;
}): number {
  const {
    remainingRects,
    currentIndex,
    targetAlign,
    cardTop,
    cardHeight,
    movingUp,
    movingDown,
    placeholderBottom,
  } = params;
  const clampedIdx = Math.max(0, Math.min(remainingRects.length, currentIndex));
  const cardCenterY = cardTop + cardHeight / 2;

  if (movingUp) {
    for (let k = 0; k < clampedIdx; k++) {
      const r = remainingRects[k];
      if (cardTop < r.bottom - Math.min(18, r.height * 0.25)) {
        return k;
      }
    }
    return clampedIdx;
  }

  if (movingDown) {
    let nextIdx = clampedIdx;
    for (let k = clampedIdx; k < remainingRects.length; k++) {
      const r = remainingRects[k];
      const isSideBySideRow =
        k === clampedIdx &&
        r.type === 'text' &&
        (targetAlign === 'left' || targetAlign === 'right');

      if (isSideBySideRow) {
        const isShortParagraph =
          placeholderBottom !== undefined && r.bottom < placeholderBottom - 16;
        const passedRow = isShortParagraph
          ? cardTop > r.bottom + 8
          : cardCenterY > r.bottom - Math.min(24, r.height * 0.25);
        if (passedRow) {
          nextIdx = k + 1;
        } else {
          break;
        }
      } else {
        if (cardCenterY > r.top + Math.min(44, r.height * 0.45)) {
          nextIdx = k + 1;
        } else {
          break;
        }
      }
    }
    return nextIdx;
  }

  return clampedIdx;
}

export interface LineSnapTarget {
  /** Block index inside dragBaseBlocks (0..baseBlocks.length, where === baseBlocks.length means end of doc) */
  blockIndex: number;
  /** Character offset inside baseBlocks[blockIndex].content (0 = before block, length = after block) */
  splitOffset: number;
  /** Unsplit visual top of the target line (relative to viewport) */
  lineTop: number;
  /** Unsplit visual bottom of the target line (relative to viewport) */
  lineBottom: number;
}

/**
 * Merges consecutive text blocks cleanly so picking up or removing a figure
 * seamlessly reunites prose that had been split across a figure.
 */
export function coalesceAdjacentTextBlocks(
  blocks: TextbookConvertedBlock[]
): TextbookConvertedBlock[] {
  const merged: TextbookConvertedBlock[] = [];
  for (const block of blocks) {
    if (block.type !== 'text') {
      merged.push(block);
      continue;
    }
    const text = (block.content || '').trim();
    if (!text) continue;

    const prev = merged[merged.length - 1];
    if (prev && prev.type === 'text' && prev.content) {
      const prevTrimmed = prev.content.trimEnd();
      const prevLastLine = (prevTrimmed.split('\n').pop() || '').trim();
      const prevCleanEnd = prevTrimmed
        .replace(/(?:==|!!|\+\+|@@|\^\^|%%|\*\*|__|~~|\*)+$/g, '')
        .trimEnd();
      const endsStructural =
        /^(#{1,6}\s|[-*•]\s|[0-9۰-۹٠-٩]+[.)]\s|[|>`])/.test(prevLastLine) ||
        /\$\$$/.test(prevTrimmed);
      const endsComplete =
        endsStructural ||
        /[.!?؟:»"')\]…—–-]$/.test(prevCleanEnd) ||
        /```$/.test(prevTrimmed) ||
        /\|$/.test(prevTrimmed) ||
        (!prevTrimmed.includes('\n') &&
          (/^\*[^*\n]+\*$/.test(prevTrimmed) ||
            /^\*\*[^*\n]+\*\*$/.test(prevTrimmed) ||
            /\b(?:19|20)\d{2}$/.test(prevCleanEnd)));
      const startsStructural =
        /^(#{1,6}\s|[-*•]\s|[0-9۰-۹٠-٩]+[.)]\s|[|>`])/.test(text) ||
        /\$\$/.test(text.split('\n')[0] || '') ||
        /^[A-Z0-9\u0600-\u06FF].*:\s/.test(text.split('\n')[0] || '');

      const separator = !endsComplete && !startsStructural ? ' ' : '\n\n';
      merged[merged.length - 1] = {
        ...prev,
        content: `${prevTrimmed}${separator}${text}`,
      };
      continue;
    }

    merged.push({ ...block, content: text });
  }
  return merged;
}

/**
 * Builds the continuous base block sequence during a figure drag:
 * removes the dragged figure, includes any uncommitted tailText, and coalesces
 * adjacent text blocks so the user can drop the figure at any visual line.
 */
export function buildDragBaseFlow(
  committedBlocks: TextbookConvertedBlock[],
  tailText: string,
  tailBlockId: string,
  dragBlockId: string
): { baseBlocks: TextbookConvertedBlock[]; hadTailText: boolean } {
  const withoutDrag = committedBlocks.filter((b) => b.id !== dragBlockId);
  const trimmedTail = tailText.trim();
  const hadTailText = trimmedTail.length > 0;
  const combined = hadTailText
    ? [
        ...withoutDrag,
        {
          id: tailBlockId,
          type: 'text' as const,
          pageNumber: 0,
          content: trimmedTail,
        },
      ]
    : withoutDrag;

  return {
    baseBlocks: coalesceAdjacentTextBlocks(combined),
    hadTailText,
  };
}

/**
 * Returns sorted [start, end] ranges in raw markdown that should never be split in the middle
 * (fenced code blocks, block/inline math, inline code, and markdown links).
 */
export function computeProtectedMarkdownSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const patterns = [
    /```[\s\S]*?```/g,
    /\$\$[\s\S]*?\$\$/g,
    /\$[^$\n]+?\$/g,
    /`[^`\n]+?`/g,
    /\[[^\]]+\]\([^)]+\)/g,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length > 1) {
        spans.push([m.index, m.index + m[0].length]);
      }
    }
  }

  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) {
      last[1] = Math.max(last[1], s[1]);
    } else {
      merged.push([s[0], s[1]]);
    }
  }
  return merged;
}

function clampOutsideProtectedSpans(
  offset: number,
  spans: Array<[number, number]>,
  textLength: number
): number {
  let out = Math.max(0, Math.min(textLength, offset));
  for (const [start, end] of spans) {
    if (out > start && out < end) {
      out = out - start <= end - out ? start : end;
      break;
    }
  }
  return out;
}

/**
 * Maps ordered visual lines (from DOM Range measurements) back to clean character split
 * offsets inside `rawText`, keeping offsets monotonic and safe around markdown/math syntax.
 */
export function mapRenderedLineStartTokensToRawOffsets(
  rawText: string,
  lines: Array<{ firstWords: string[]; approxCharLength?: number }>
): number[] {
  if (!rawText || lines.length === 0) return [0];
  const spans = computeProtectedMarkdownSpans(rawText);
  const offsets: number[] = [0];
  let cursor = 0;

  for (let i = 1; i < lines.length; i++) {
    const words = lines[i].firstWords.filter((w) => w.length > 0);
    const prevApproxLen = lines[i - 1].approxCharLength ?? 0;
    const minStep =
      prevApproxLen > 0 ? Math.max(1, Math.floor(prevApproxLen * 0.55) - 6) : 1;
    const searchFrom = Math.min(rawText.length, cursor + minStep);
    let matchedIdx = -1;

    // Try matching up to 4 words down to 1 word for accurate disambiguation
    const candidates: string[] = [];
    for (let len = Math.min(4, words.length); len >= 1; len--) {
      candidates.push(words.slice(0, len).join(' '));
    }

    for (const needle of candidates) {
      const idx = rawText.indexOf(needle, searchFrom);
      if (idx !== -1) {
        matchedIdx = idx;
        break;
      }
      const lowerRest = rawText.slice(searchFrom).toLowerCase();
      const ciIdx = lowerRest.indexOf(needle.toLowerCase());
      if (ciIdx !== -1) {
        matchedIdx = searchFrom + ciIdx;
        break;
      }
    }

    if (matchedIdx !== -1) {
      // Step back over leading markdown markers on the same line (e.g. **, _, #, -, >)
      let start = matchedIdx;
      while (start > cursor && /[*_~`]/.test(rawText[start - 1])) {
        start--;
      }
      const lineBreakBefore = rawText.lastIndexOf('\n', start - 1);
      const between = rawText.slice(lineBreakBefore + 1, start);
      if (/^\s*(?:#{1,6}\s+|[-*•>]\s+|\d+[.)]\s+)$/.test(between)) {
        start = lineBreakBefore + 1;
      }
      start = clampOutsideProtectedSpans(start, spans, rawText.length);
      if (start > cursor && start < rawText.length) {
        cursor = start;
      }
    } else {
      // Fallback: advance proportionally to the next whitespace outside protected spans
      const approx = Math.round((i / lines.length) * rawText.length);
      let ws = rawText.indexOf(' ', Math.max(cursor + 1, approx));
      if (ws === -1) ws = rawText.indexOf('\n', cursor + 1);
      if (ws !== -1 && ws < rawText.length) {
        const safe = clampOutsideProtectedSpans(ws + 1, spans, rawText.length);
        if (safe > cursor && safe < rawText.length) {
          cursor = safe;
        }
      }
    }

    offsets.push(cursor);
  }

  return offsets;
}

export function resolveSplitTextParts(
  rawText: string,
  splitOffset: number
): { before: string; after: string } {
  if (splitOffset <= 0) {
    return { before: '', after: rawText.trim() };
  }
  if (splitOffset >= rawText.length) {
    return { before: rawText.trim(), after: '' };
  }
  return {
    before: rawText.slice(0, splitOffset).trimEnd(),
    after: rawText.slice(splitOffset).trimStart(),
  };
}

/**
 * Selects the target line index inside `targets` based on card vertical position
 * and drag direction, supporting smooth 1-line-at-a-time movement in Left, Center,
 * and Right placements without flip-flop.
 */
export function resolveLineDragTarget(params: {
  targets: LineSnapTarget[];
  currentTargetIdx: number;
  targetAlign: 'left' | 'center' | 'right';
  cardTop: number;
  cardHeight: number;
  placeholderHeight: number;
  movingUp: boolean;
  movingDown: boolean;
}): number {
  const {
    targets,
    currentTargetIdx,
    cardTop,
    movingUp,
    movingDown,
  } = params;
  if (targets.length === 0) return 0;
  const clampedIdx = Math.max(0, Math.min(targets.length - 1, currentTargetIdx));

  if (movingUp) {
    for (let i = 0; i < clampedIdx; i++) {
      const t = targets[i];
      const lineHeight = Math.max(16, t.lineBottom - t.lineTop);
      const enterInset =
        lineHeight > 64
          ? Math.min(28, lineHeight * 0.25)
          : Math.min(8, lineHeight * 0.3);
      if (cardTop < t.lineBottom - enterInset) {
        return i;
      }
    }
    return clampedIdx;
  }

  if (movingDown) {
    let nextIdx = clampedIdx;
    for (let i = clampedIdx; i < targets.length - 1; i++) {
      const t = targets[i];
      const lineHeight = Math.max(16, t.lineBottom - t.lineTop);
      const passThreshold =
        lineHeight > 64
          ? t.lineTop + Math.min(72, lineHeight * 0.4)
          : t.lineBottom - 2;
      if (cardTop > passThreshold) {
        nextIdx = i + 1;
      } else {
        break;
      }
    }
    return nextIdx;
  }

  return clampedIdx;
}

/**
 * Commits a line-based figure drop into `baseBlocks`, splitting any target text block
 * cleanly at `targetSplitOffset` when landing mid-paragraph.
 */
export function applyLineDraggedFigurePlacement(params: {
  committedBlocks: TextbookConvertedBlock[];
  tailText: string;
  tailBlockId: string;
  dragBlockId: string;
  targetBlockIndex: number;
  targetSplitOffset: number;
  targetAlign: 'left' | 'center' | 'right';
  createNewBlockId: () => string;
}): {
  committedBlocks: TextbookConvertedBlock[];
  tailText: string;
  committedTail: boolean;
} {
  const {
    committedBlocks,
    tailText,
    tailBlockId,
    dragBlockId,
    targetBlockIndex,
    targetSplitOffset,
    targetAlign,
    createNewBlockId,
  } = params;

  const dragBlock = committedBlocks.find(
    (b) => b.id === dragBlockId && b.type === 'figure'
  );
  if (!dragBlock) {
    return { committedBlocks, tailText, committedTail: false };
  }

  const updatedFigure: TextbookConvertedBlock = {
    ...dragBlock,
    align: targetAlign,
    widthPct: normalizeFigureWidthPct(targetAlign, dragBlock.widthPct),
  };

  const { baseBlocks, hadTailText } = buildDragBaseFlow(
    committedBlocks,
    tailText,
    tailBlockId,
    dragBlockId
  );

  if (baseBlocks.length === 0 || targetBlockIndex >= baseBlocks.length) {
    return {
      committedBlocks: [...baseBlocks, updatedFigure],
      tailText: '',
      committedTail: hadTailText,
    };
  }

  const safeIdx = Math.max(0, targetBlockIndex);
  const targetBlock = baseBlocks[safeIdx];

  if (targetBlock.type !== 'text' || targetSplitOffset <= 0) {
    const next = [...baseBlocks];
    next.splice(safeIdx, 0, updatedFigure);
    return {
      committedBlocks: next,
      tailText: '',
      committedTail: hadTailText,
    };
  }

  const raw = targetBlock.content || '';
  if (targetSplitOffset >= raw.length) {
    const next = [...baseBlocks];
    next.splice(safeIdx + 1, 0, updatedFigure);
    return {
      committedBlocks: next,
      tailText: '',
      committedTail: hadTailText,
    };
  }

  const { before, after } = resolveSplitTextParts(raw, targetSplitOffset);
  const next = [...baseBlocks];

  if (!before) {
    next.splice(safeIdx, 0, updatedFigure);
  } else if (!after) {
    next.splice(safeIdx + 1, 0, updatedFigure);
  } else {
    next.splice(
      safeIdx,
      1,
      { ...targetBlock, content: before },
      updatedFigure,
      {
        id: createNewBlockId(),
        type: 'text',
        pageNumber: targetBlock.pageNumber,
        content: after,
      }
    );
  }

  return {
    committedBlocks: next,
    tailText: '',
    committedTail: hadTailText,
  };
}

/**
 * Splits a Markdown/LaTeX string into discrete paragraph-level chunks at blank lines
 * (and before headings) while keeping fenced code blocks, display math blocks ($$...$$),
 * tables, and single-spaced lists intact.
 */
export function splitMarkdownIntoParagraphs(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const chunks: string[] = [];
  let buf: string[] = [];
  let inCodeFence = false;
  let codeFenceMarker = '';
  let inDisplayMath = false;

  const flushBuf = () => {
    const joined = buf.join('\n').trim();
    if (joined) {
      chunks.push(joined);
    }
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inDisplayMath) {
      const fenceMatch = trimmed.match(/^(```+|~~~+)/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!inCodeFence) {
          inCodeFence = true;
          codeFenceMarker = marker;
        } else if (codeFenceMarker === marker) {
          inCodeFence = false;
          codeFenceMarker = '';
        }
        buf.push(line);
        continue;
      }
    }

    if (inCodeFence) {
      buf.push(line);
      continue;
    }

    // Toggle multi-line $$ ... $$ math blocks (ignore single-line $$ ... $$)
    if (trimmed.startsWith('$$')) {
      const isSingleLineDisplayMath = trimmed.length > 2 && trimmed.endsWith('$$');
      if (!isSingleLineDisplayMath) {
        inDisplayMath = !inDisplayMath;
      }
      buf.push(line);
      continue;
    }

    if (inDisplayMath) {
      buf.push(line);
      continue;
    }

    if (trimmed === '') {
      flushBuf();
      continue;
    }

    // Keep contiguous blockquote/callout blocks (> ...) grouped together as one unit,
    // and separate them from adjacent non-quote prose lines
    const isQuoteLine = trimmed.startsWith('>');
    const bufIsQuote = buf.length > 0 && buf[0].trim().startsWith('>');
    if (isQuoteLine && buf.length > 0 && !bufIsQuote) {
      flushBuf();
    } else if (!isQuoteLine && bufIsQuote) {
      flushBuf();
    }

    // Treat Markdown headings as standalone blocks even if separated by a single newline
    if (!isQuoteLine && /^#{1,6}\s+/.test(trimmed)) {
      if (buf.length > 0) {
        flushBuf();
      }
      chunks.push(trimmed);
      continue;
    }

    buf.push(line);
  }

  flushBuf();
  return chunks;
}

/**
 * Expands multi-paragraph text blocks into individual paragraph blocks and optionally
 * normalizes figure blocks to full-width layout.
 */
export function normalizeBlocksToParagraphs(
  blocks: TextbookConvertedBlock[],
  createNewBlockId: () => string,
  forceFullWidthFigures = false
): TextbookConvertedBlock[] {
  const out: TextbookConvertedBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'figure') {
      out.push(
        forceFullWidthFigures
          ? { ...block, align: 'full', widthPct: 100 }
          : block
      );
      continue;
    }
    const raw = block.content ?? '';
    if (!raw.trim()) continue;
    const parts = splitMarkdownIntoParagraphs(raw);
    if (parts.length === 0) continue;
    parts.forEach((part, idx) => {
      out.push({
        ...block,
        id: idx === 0 ? block.id : createNewBlockId(),
        content: part,
      });
    });
  }
  return out;
}

const GENERIC_CAPTION_ONLY_RE =
  /^(?:figure|fig\.?|image|img|diagram|chart|graph|photo|picture|illustration|table|شکل|تصویر|نمودار|جدول)\s*[0-9۰-۹٠-٩]*(?:[./\-–—][0-9۰-۹٠-٩]+)*\s*[-–—ـ:.]?\s*(?:\((?:page|p\.?|صفحه)\s*[0-9۰-۹٠-٩]+\))?$/i;

const LEADING_FIGURE_PREFIX_RE =
  /^(?:figure|fig\.?|image|img|diagram|chart|graph|photo|picture|illustration|شکل|تصویر|نمودار)\s*[0-9۰-۹٠-٩]+(?:[./\-–—][0-9۰-۹٠-٩]+)*\s*[-–—ـ:.]\s*/i;

const TRAILING_PAGE_PARENS_RE =
  /\s*\((?:page|p\.?|صفحه)\s*[0-9۰-۹٠-٩]+\)\s*$/i;

export function isGenericOrEmptyFigureCaption(caption: string | undefined | null): boolean {
  const trimmed = (caption ?? '').trim();
  if (!trimmed) return true;
  return GENERIC_CAPTION_ONLY_RE.test(trimmed);
}

/**
 * Produces a consistent, clean descriptive title under every figure:
 * - Removes generic placeholders ("Figure 1 (Page 4)", "شکل ۱", etc.)
 * - Strips leading numbering prefixes ("شکل ۱ـ ", "Figure 4.2: ", "Fig. 1 - ") when followed by an actual title
 * - Strips trailing "(Page N)" suffixes
 */
export function cleanConsistentFigureCaption(caption: string | undefined | null): string {
  const trimmed = (caption ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed || GENERIC_CAPTION_ONLY_RE.test(trimmed)) {
    return '';
  }
  const withoutTrailingPage = trimmed.replace(TRAILING_PAGE_PARENS_RE, '').trim();
  const withoutPrefix = withoutTrailingPage.replace(LEADING_FIGURE_PREFIX_RE, '').trim();
  const candidate = withoutPrefix || withoutTrailingPage;
  if (!candidate || GENERIC_CAPTION_ONLY_RE.test(candidate)) {
    return '';
  }
  return candidate;
}

export interface AnalyzedMarkdownBlock {
  type: 'text' | 'figure';
  content?: string;
  caption?: string;
}

/**
 * Splits extracted book-page Markdown into ordered text and image-placeholder blocks
 * whenever `[[IMAGE_BOX: <subtitle>]]` (or `[[IMAGE_SLOT: <subtitle>]]`) markers appear.
 * Fenced code blocks are respected so literal examples inside code are never split.
 */
export function parseAnalyzedMarkdownWithImageBoxes(rawMarkdown: string): AnalyzedMarkdownBlock[] {
  const normalized = (rawMarkdown || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const blocks: AnalyzedMarkdownBlock[] = [];
  let textLines: string[] = [];
  let inCodeFence = false;
  let codeFenceMarker = '';
  let inDisplayMath = false;

  const isLonePageNumberLine = (trimmedLine: string): boolean => {
    if (!trimmedLine) return false;
    return /^(?:(?:[-–—•·]\s*)?[0-9۰-۹٠-٩]{1,4}(?:\s*[-–—•·])?|(?:صفحه|ص\.?|page|p\.?)\s*[0-9۰-۹٠-٩]{1,4})$/i.test(
      trimmedLine
    );
  };

  const flushText = () => {
    const joined = textLines.join('\n').trim();
    textLines = [];
    if (joined) {
      blocks.push({ type: 'text', content: joined });
    }
  };

  const markerRegex = /\[\[\s*(?:IMAGE_BOX|IMAGE_SLOT)(?:\s*:\s*([^\]]*?))?\s*\]\]/gi;

  for (const line of normalized.split('\n')) {
    const trimmed = line.trim();
    if (!inDisplayMath) {
      const fenceMatch = trimmed.match(/^(```+|~~~+)/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!inCodeFence) {
          inCodeFence = true;
          codeFenceMarker = marker;
        } else if (codeFenceMarker === marker) {
          inCodeFence = false;
          codeFenceMarker = '';
        }
        textLines.push(line);
        continue;
      }
    }

    if (inCodeFence) {
      textLines.push(line);
      continue;
    }

    if (trimmed.startsWith('$$')) {
      const isSingleLineDisplayMath = trimmed.length > 2 && trimmed.endsWith('$$');
      if (!isSingleLineDisplayMath) {
        inDisplayMath = !inDisplayMath;
      }
      textLines.push(line);
      continue;
    }

    if (inDisplayMath) {
      textLines.push(line);
      continue;
    }

    if (isLonePageNumberLine(trimmed)) {
      continue;
    }

    markerRegex.lastIndex = 0;
    if (!markerRegex.test(line)) {
      textLines.push(line);
      continue;
    }

    // Handle one or more [[IMAGE_BOX: ...]] markers on this line
    markerRegex.lastIndex = 0;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = markerRegex.exec(line)) !== null) {
      const before = line.slice(cursor, match.index).replace(/^>\s*/, '').trim();
      if (before) {
        textLines.push(before);
      }
      flushText();
      const subtitle = (match[1] ?? '').replace(/\s+/g, ' ').trim();
      blocks.push({
        type: 'figure',
        caption: subtitle,
      });
      cursor = match.index + match[0].length;
    }

    const after = line.slice(cursor).replace(/^>\s*/, '').trim();
    if (after) {
      textLines.push(after);
    }
  }

  flushText();
  return blocks;
}

const MAX_SCRAPE_URLS_PER_PASTE = 5;

function parseHttpUrlToken(rawToken: string): string | null {
  const token = rawToken.trim().replace(/^<+|>+$/g, '');
  if (!token || !/^https?:\/\//i.test(token)) return null;
  try {
    const parsed = new URL(token);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Detects when clipboard plain text consists exclusively of one or more standalone
 * http(s) website URLs (rather than normal prose containing an inline link).
 */
export function extractStandaloneUrlsFromPaste(rawText: string): string[] | null {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > MAX_SCRAPE_URLS_PER_PASTE) {
    return null;
  }

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const normalized = parseHttpUrlToken(token);
    if (!normalized) return null;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }

  return urls.length > 0 ? urls : null;
}

/**
 * Extracts standalone URLs from drag-and-drop DataTransfer text/uri-list or text/plain.
 */
export function extractUrlsFromDropData(
  uriList: string | undefined | null,
  plainText: string | undefined | null
): string[] | null {
  if (uriList && uriList.trim()) {
    const cleaned = uriList
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .join('\n');
    const fromUriList = extractStandaloneUrlsFromPaste(cleaned);
    if (fromUriList) return fromUriList;
  }
  return extractStandaloneUrlsFromPaste(plainText || '');
}

const NOISE_IMAGE_ALT_OR_URL_RE =
  /\b(?:avatar|logo|icon|badge|sponsor|sponsored|advert(?:isement)?|banner|promo|share|twitter|facebook|instagram|linkedin|whatsapp|telegram|youtube|pinterest|reddit|cookie|subscribe|newsletter|1x1|pixel|tracking|favicon|masthead)\b/i;

/**
 * Deterministic fallback cleaner for scraped webpage Markdown:
 * converts meaningful inline Markdown images into `[[IMAGE_BOX: caption]]`
 * while skipping UI/ad/avatar icons and preserving fenced code blocks.
 */
export function convertMarkdownImagesToImageBoxes(rawMarkdown: string): string {
  const normalized = (rawMarkdown || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const lines = normalized.split('\n');
  const out: string[] = [];
  let inCodeFence = false;
  let codeFenceMarker = '';

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inCodeFence) {
        inCodeFence = true;
        codeFenceMarker = marker;
      } else if (codeFenceMarker === marker) {
        inCodeFence = false;
        codeFenceMarker = '';
      }
      out.push(line);
      continue;
    }

    if (inCodeFence) {
      out.push(line);
      continue;
    }

    // Handle clickable markdown image [![alt](imgUrl)](linkUrl) or plain ![alt](imgUrl)
    let nextLine = line.replace(
      /\[!\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)\]\(([^)]+)\)/g,
      (_full, rawAlt: string, rawSrc: string) => {
        const alt = rawAlt.replace(/\s+/g, ' ').trim();
        if (!alt || NOISE_IMAGE_ALT_OR_URL_RE.test(alt) || NOISE_IMAGE_ALT_OR_URL_RE.test(rawSrc)) {
          return '';
        }
        return `\n\n[[IMAGE_BOX: ${alt}]]\n\n`;
      }
    );

    nextLine = nextLine.replace(
      /!\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g,
      (_full, rawAlt: string, rawSrc: string) => {
        const alt = rawAlt.replace(/\s+/g, ' ').trim();
        if (!alt || NOISE_IMAGE_ALT_OR_URL_RE.test(alt) || NOISE_IMAGE_ALT_OR_URL_RE.test(rawSrc)) {
          return '';
        }
        return `\n\n[[IMAGE_BOX: ${alt}]]\n\n`;
      }
    );

    if (nextLine.trim() || line === '') {
      out.push(nextLine);
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const WEBPAGE_CHROME_LINE_RE = new RegExp(
  [
    '^\\s*(?:\\[(?:skip to (?:main content|navigation|content|footer|search)|jump to (?:content|navigation)|back to top)\\]\\([^)]*\\)\\s*)+$',
    '^\\s*(?:skip to (?:main content|navigation|content|footer|search)|jump to (?:content|navigation)|back to top)\\s*$',
    '^\\s*(?:close dialog(?:ue)?|next image|previous image|toggle caption|view image in fullscreen)(?:\\s+\\d+\\/\\d+|\\s+(?:close dialog(?:ue)?|next image|previous image|toggle caption))*\\s*$',
    '^\\s*(?:#{1,6}\\s+|\\*{1,2})?support the guardian\\b.*$',
    '^\\s*(?:available for everyone,? funded by readers|fund independent journalism with|support once from just \\$|please contribute if you can \\$[\\d,]+ of \\$[\\d,]+ goal|the guardian has something us newsrooms don[\'’]t|can you spare \\d+ seconds to support our year-end fundraiser)\\b.*$',
    '^\\s*(?:[-*•]\\s+)?(?:far fewer asks for support|ad-free reading on all your devices|we welcome support of any size,? any time|collapse banner|black friday offer\\b.*|support another way\\b.*)$',
    '^\\s*now live:\\s*our critical year-end fundraiser\\b.*$',
    '^\\s*©\\s*\\d{4}\\s+.*all rights reserved.*$',
    '^\\s*(?:advertisement|sponsored|cookie policy|manage cookies|accept all cookies|reject all|sign in|create account|subscribe now|follow us|share this article|copy link|print this page|continue|make a year-end gift|support us)\\s*$',
  ].join('|'),
  'i'
);

const WEBPAGE_FOOTER_START_RE = new RegExp(
  [
    '^\\s*(?:#{1,6}\\s+)?(?:explore more on these topics|more on this story|most viewed|most popular|related stories|recommended for you)\\s*$',
    '^\\s*(?:#{1,6}\\s+)?now live:\\s*our critical year-end fundraiser\\b',
    '^\\s*©\\s*\\d{4}\\s+.*all rights reserved',
    '^\\s*(?:\\[?back to top\\]?(?:\\([^)]*\\))?)\\s*$',
  ].join('|'),
  'i'
);

function isPureMarkdownLinkLine(trimmed: string): boolean {
  const cleaned = trimmed.replace(/^[-*•]\s+/, '').trim();
  return /^\[[^\]\n]+\]\(https?:\/\/[^)\s]+(?:\s+"[^"]*")?\)$/.test(cleaned);
}

/**
 * Deterministically strips webpage navigation chrome, skip links, lightbox controls,
 * donation/fundraiser banners, tracking URLs, and footer link blocks while preserving
 * fenced code blocks and editorial image tags.
 */
export function precleanWebpageMarkdown(rawMarkdown: string): string {
  const normalized = (rawMarkdown || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const rawLines = normalized.split('\n');

  // Pass 1: Drop runs of >= 4 pure navigation link lines (navbars / footer menus) outside code fences
  const withoutNavRuns: string[] = [];
  let inCodeFence = false;
  let codeFenceMarker = '';
  let rIdx = 0;

  while (rIdx < rawLines.length) {
    const line = rawLines[rIdx];
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inCodeFence) {
        inCodeFence = true;
        codeFenceMarker = marker;
      } else if (codeFenceMarker === marker) {
        inCodeFence = false;
        codeFenceMarker = '';
      }
      withoutNavRuns.push(line);
      rIdx++;
      continue;
    }

    if (!inCodeFence && isPureMarkdownLinkLine(trimmed)) {
      let end = rIdx;
      let linkCount = 0;
      while (end < rawLines.length) {
        const cand = rawLines[end].trim();
        if (cand === '') {
          end++;
          continue;
        }
        if (isPureMarkdownLinkLine(cand)) {
          linkCount++;
          end++;
          continue;
        }
        break;
      }
      if (linkCount >= 4) {
        rIdx = end;
        continue;
      }
    }

    withoutNavRuns.push(line);
    rIdx++;
  }

  // Pass 2: Protect code fences, drop trailing footer blocks & chrome lines, unwrap clickable images & links
  const out: string[] = [];
  inCodeFence = false;
  codeFenceMarker = '';
  let proseCharsSeen = 0;

  for (let i = 0; i < withoutNavRuns.length; i++) {
    const line = withoutNavRuns[i];
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inCodeFence) {
        inCodeFence = true;
        codeFenceMarker = marker;
      } else if (codeFenceMarker === marker) {
        inCodeFence = false;
        codeFenceMarker = '';
      }
      out.push(line);
      continue;
    }

    if (inCodeFence) {
      out.push(line);
      continue;
    }

    if (
      proseCharsSeen >= 500 &&
      i >= Math.floor(withoutNavRuns.length * 0.45) &&
      WEBPAGE_FOOTER_START_RE.test(trimmed)
    ) {
      break;
    }

    if (WEBPAGE_CHROME_LINE_RE.test(trimmed)) {
      continue;
    }

    // Preserve clickable editorial images as plain Markdown images so image boxes survive
    let cleanedLine = line.replace(
      /\[!\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)\]\(([^)]+)\)/g,
      '![$1]($2)'
    );

    // Strip tracking-heavy inline markdown links to readable anchor text (never raw URLs)
    cleanedLine = cleanedLine.replace(
      /(?<!!)\[([^\]\n]+)\]\(https?:\/\/[^)\s]+(?:\s+"[^"]*")?\)/g,
      '$1'
    );

    const cleanedTrimmed = cleanedLine.trim();
    if (cleanedTrimmed && WEBPAGE_CHROME_LINE_RE.test(cleanedTrimmed)) {
      continue;
    }

    if (cleanedTrimmed.length > 0) {
      proseCharsSeen += cleanedTrimmed.length;
    }
    out.push(cleanedLine);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Deterministic reader-mode fallback when Gemini webpage structuring is unavailable.
 */
export function cleanScrapedWebpageFallback(rawMarkdown: string): string {
  const precleaned = precleanWebpageMarkdown(rawMarkdown);
  return convertMarkdownImagesToImageBoxes(precleaned);
}

export function decodeHtmlEntities(input: string): string {
  return (input || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    });
}

export interface WebpageHtmlMetadata {
  title?: string;
  author?: string;
  publishedDate?: string;
  heroImageAlt?: string;
  heroImageUrl?: string;
}

function getHtmlMetaTagContent(html: string, attrVal: string): string {
  const escaped = attrVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagRe = new RegExp(`<meta\\b[^>]*?(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*>`, 'gi');
  const altOrderRe = new RegExp(`<meta\\b[^>]*?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*>`, 'i');

  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    const contentMatch = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const val = (contentMatch?.[1] ?? contentMatch?.[2] ?? '').trim();
    if (val) return decodeHtmlEntities(val).replace(/\s+/g, ' ').trim();
  }

  const altMatch = html.match(altOrderRe);
  if (altMatch?.[1]) {
    return decodeHtmlEntities(altMatch[1]).replace(/\s+/g, ' ').trim();
  }
  return '';
}

function stripSiteNameFromPageTitle(rawTitle: string, siteName: string, pageUrl: string): string {
  let cleaned = rawTitle.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  let hostBrand = '';
  try {
    hostBrand = new URL(pageUrl).hostname.replace(/^www\./i, '').split('.')[0] || '';
  } catch {
    hostBrand = '';
  }

  const sepSplit = cleaned.split(/\s+(?:\||—|–|·|::|»|-)\s+/);
  if (sepSplit.length >= 2) {
    const lastPart = sepSplit[sepSplit.length - 1].trim().toLowerCase();
    const siteLower = siteName.trim().toLowerCase();
    const matchesSite =
      (siteLower && (lastPart === siteLower || siteLower.includes(lastPart) || lastPart.includes(siteLower))) ||
      (hostBrand && hostBrand.length >= 3 && lastPart.replace(/[^a-z0-9]/g, '').includes(hostBrand.toLowerCase()));
    if (matchesSite || (sepSplit.length === 2 && lastPart.length <= 28 && sepSplit[0].trim().length >= 16)) {
      cleaned = sepSplit.slice(0, -1).join(' — ').trim();
    }
  }
  return cleaned;
}

function isLikelyChromeHeading(text: string, siteName: string, pageUrl: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower || lower.length < 4 || lower.length > 260) return true;
  if (/^(?:menu|navigation|search|subscribe|sign in|log in|cookie|table of contents|related|skip to)/i.test(lower)) {
    return true;
  }
  if (siteName && lower === siteName.trim().toLowerCase()) return true;
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./i, '').toLowerCase();
    const root = host.split('.')[0];
    if (lower === host || (root.length >= 3 && lower === root)) return true;
  } catch {
    // ignore URL parse error
  }
  return false;
}

function extractJsonLdArticleMetadata(html: string): {
  headline?: string;
  author?: string;
  datePublished?: string;
  imageUrl?: string;
  imageCaption?: string;
} {
  const scriptRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const articleTypes = /Article|NewsArticle|BlogPosting|TechArticle|ReportageNewsArticle/i;

  const inspectNode = (node: unknown): ReturnType<typeof extractJsonLdArticleMetadata> | null => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const res = inspectNode(item);
        if (res) return res;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) {
      const fromGraph = inspectNode(obj['@graph']);
      if (fromGraph) return fromGraph;
    }
    const rawType = Array.isArray(obj['@type']) ? obj['@type'].join(' ') : String(obj['@type'] || '');
    if (articleTypes.test(rawType) || (typeof obj.headline === 'string' && obj.headline.trim().length > 8)) {
      const headline = typeof obj.headline === 'string' ? decodeHtmlEntities(obj.headline).replace(/\s+/g, ' ').trim() : undefined;
      let author: string | undefined;
      const rawAuthor = obj.author;
      if (typeof rawAuthor === 'string') {
        author = decodeHtmlEntities(rawAuthor).trim();
      } else if (Array.isArray(rawAuthor) && rawAuthor[0] && typeof rawAuthor[0] === 'object') {
        const name = (rawAuthor[0] as Record<string, unknown>).name;
        if (typeof name === 'string') author = decodeHtmlEntities(name).trim();
      } else if (rawAuthor && typeof rawAuthor === 'object') {
        const name = (rawAuthor as Record<string, unknown>).name;
        if (typeof name === 'string') author = decodeHtmlEntities(name).trim();
      }
      const datePublished =
        typeof obj.datePublished === 'string' ? obj.datePublished.trim() : undefined;

      let imageUrl: string | undefined;
      let imageCaption: string | undefined;
      const rawImg = obj.image;
      if (typeof rawImg === 'string') {
        imageUrl = rawImg.trim();
      } else if (Array.isArray(rawImg) && rawImg.length > 0) {
        const first = rawImg[0];
        if (typeof first === 'string') imageUrl = first.trim();
        else if (first && typeof first === 'object') {
          const imgObj = first as Record<string, unknown>;
          if (typeof imgObj.url === 'string') imageUrl = imgObj.url.trim();
          if (typeof imgObj.caption === 'string') imageCaption = decodeHtmlEntities(imgObj.caption).trim();
        }
      } else if (rawImg && typeof rawImg === 'object') {
        const imgObj = rawImg as Record<string, unknown>;
        if (typeof imgObj.url === 'string') imageUrl = imgObj.url.trim();
        if (typeof imgObj.caption === 'string') imageCaption = decodeHtmlEntities(imgObj.caption).trim();
      }

      return { headline, author, datePublished, imageUrl, imageCaption };
    }
    return null;
  };

  while ((m = scriptRe.exec(html)) !== null) {
    const rawJson = (m[1] || '').trim();
    if (!rawJson) continue;
    try {
      const parsed = JSON.parse(rawJson);
      const hit = inspectNode(parsed);
      if (hit) return hit;
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }
  return {};
}

function formatReadablePublishedDate(rawDate: string | undefined): string | undefined {
  const trimmed = (rawDate || '').trim();
  if (!trimmed) return undefined;
  // Already human-formatted like "26th November 2026"
  if (/[A-Za-z]{3,}/.test(trimmed) && !/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return trimmed;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return trimmed;
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(parsed));
  } catch {
    return trimmed;
  }
}

/**
 * Extracts clean editorial metadata (headline, author, date, hero image) from raw HTML
 * when article scrapers omit top-of-page headers situated outside the inner prose container.
 */
export function extractWebpageMetadataFromHtml(
  html: string,
  pageUrl: string
): WebpageHtmlMetadata {
  if (!html || typeof html !== 'string') return {};

  const siteName = getHtmlMetaTagContent(html, 'og:site_name');
  const ogTitleRaw =
    getHtmlMetaTagContent(html, 'og:title') ||
    getHtmlMetaTagContent(html, 'twitter:title');
  const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const docTitleRaw = titleTagMatch?.[1]
    ? decodeHtmlEntities(titleTagMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    : '';
  const jsonLd = extractJsonLdArticleMetadata(html);

  const ogTitle = stripSiteNameFromPageTitle(ogTitleRaw, siteName, pageUrl);
  const docTitle = stripSiteNameFromPageTitle(docTitleRaw, siteName, pageUrl);

  // Strip scripts, styles, and navbars before scanning on-page <h1> tags
  const strippedForH1 = html
    .replace(/<(script|style|noscript|svg|nav)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const h1Matches: string[] = [];
  const h1Re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
  let h1Match: RegExpExecArray | null;
  while ((h1Match = h1Re.exec(strippedForH1)) !== null) {
    const plain = decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (plain && !isLikelyChromeHeading(plain, siteName, pageUrl)) {
      h1Matches.push(plain);
    }
  }

  let bestH1 = h1Matches[0] || '';
  if (h1Matches.length > 1) {
    const targetRef = (ogTitle || docTitle || jsonLd.headline || '').toLowerCase();
    const matchingH1 = h1Matches.find((h) => {
      const hl = h.toLowerCase();
      return targetRef && (targetRef.includes(hl) || hl.includes(targetRef));
    });
    if (matchingH1) bestH1 = matchingH1;
  }

  const title = bestH1 || jsonLd.headline || ogTitle || docTitle || undefined;

  const metaAuthor =
    getHtmlMetaTagContent(html, 'author') ||
    getHtmlMetaTagContent(html, 'article:author');
  const author =
    (metaAuthor && !/^https?:\/\//i.test(metaAuthor) ? metaAuthor : undefined) ||
    jsonLd.author;

  // Prefer visible <time> text if concise; otherwise format published_time / JSON-LD datePublished
  const timeMatch = strippedForH1.match(/<time\b[^>]*>([\s\S]*?)<\/time>/i);
  const visibleTime = timeMatch?.[1]
    ? decodeHtmlEntities(timeMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    : '';
  const metaPubTime =
    getHtmlMetaTagContent(html, 'article:published_time') ||
    getHtmlMetaTagContent(html, 'og:published_time') ||
    jsonLd.datePublished;
  const publishedDate =
    (visibleTime && visibleTime.length >= 6 && visibleTime.length <= 42 ? visibleTime : undefined) ||
    formatReadablePublishedDate(metaPubTime);

  const ogImageUrl =
    getHtmlMetaTagContent(html, 'og:image') ||
    getHtmlMetaTagContent(html, 'twitter:image') ||
    jsonLd.imageUrl;
  const ogImageAlt =
    getHtmlMetaTagContent(html, 'og:image:alt') ||
    getHtmlMetaTagContent(html, 'twitter:image:alt') ||
    jsonLd.imageCaption;

  let heroImageUrl: string | undefined =
    ogImageUrl && !NOISE_IMAGE_ALT_OR_URL_RE.test(ogImageUrl) ? ogImageUrl : undefined;
  let heroImageAlt: string | undefined =
    ogImageAlt && !NOISE_IMAGE_ALT_OR_URL_RE.test(ogImageAlt) ? ogImageAlt : undefined;

  // Look for a matching <figure>/<img alt> or <figcaption> in the main HTML if alt is missing
  if (!heroImageAlt) {
    const scope =
      html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ||
      html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ||
      html;
    const figureMatch = scope.match(
      /<figure\b[^>]*>([\s\S]{0,1800}?)<\/figure>/i
    );
    if (figureMatch) {
      const figInner = figureMatch[1];
      const capMatch = figInner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
      const figCap = capMatch?.[1]
        ? decodeHtmlEntities(capMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
        : '';
      const imgMatch = figInner.match(/<img\b[^>]*>/i);
      const imgAltMatch = imgMatch?.[0]?.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const imgAlt = decodeHtmlEntities((imgAltMatch?.[1] || imgAltMatch?.[2] || '').trim());
      const imgSrcMatch = imgMatch?.[0]?.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const imgSrc = (imgSrcMatch?.[1] || imgSrcMatch?.[2] || '').trim();
      if (imgSrc && !NOISE_IMAGE_ALT_OR_URL_RE.test(imgSrc)) {
        if (!heroImageUrl) heroImageUrl = imgSrc;
        const picked = figCap || imgAlt;
        if (picked && !NOISE_IMAGE_ALT_OR_URL_RE.test(picked)) {
          heroImageAlt = picked;
        }
      }
    }
  }

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(publishedDate ? { publishedDate } : {}),
    ...(heroImageUrl ? { heroImageUrl } : {}),
    ...(heroImageAlt ? { heroImageAlt } : {}),
  };
}

function normalizeComparableTitle(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/[#*_`~]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function markdownStartsWithArticleTitle(markdown: string): boolean {
  const topLines = (markdown || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3);
  return topLines.some((line) => /^#\s+\S/.test(line));
}

/**
 * Guarantees a scraped webpage document begins with a clear top-level `# <Title>` heading
 * when a genuine article headline was discovered, upgrading an initial `## Title` or plain
 * duplicate title line instead of skipping or duplicating it.
 */
export function ensureWebpageMarkdownHasTitle(
  markdown: string,
  resolvedTitle?: string
): string {
  const trimmedMd = (markdown || '').replace(/\r\n/g, '\n').trim();
  const cleanTitle = (resolvedTitle || '').replace(/\s+/g, ' ').trim();
  if (!trimmedMd) {
    return cleanTitle ? `# ${cleanTitle}` : '';
  }

  if (markdownStartsWithArticleTitle(trimmedMd)) {
    return trimmedMd;
  }

  if (!cleanTitle) {
    return trimmedMd;
  }

  const lines = trimmedMd.split('\n');
  const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmptyIdx !== -1) {
    const firstLine = lines[firstNonEmptyIdx].trim();
    const firstStripped = firstLine.replace(/^#{1,3}\s+/, '').trim();
    if (normalizeComparableTitle(firstStripped) === normalizeComparableTitle(cleanTitle)) {
      lines[firstNonEmptyIdx] = `# ${firstStripped}`;
      return lines.join('\n').trim();
    }
  }

  return `# ${cleanTitle}\n\n${trimmedMd}`;
}

