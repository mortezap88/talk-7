import type { TextbookConvertedBlock } from '../types/talk';
import {
  mapRenderedLineStartTokensToRawOffsets,
  type LineSnapTarget,
} from './textbookLayout';

interface DomVisualLine {
  top: number;
  bottom: number;
  midY: number;
  height: number;
  firstWords: string[];
  approxCharLength: number;
}

function isHiddenFromLineScan(node: Node): boolean {
  let el: HTMLElement | null = node.parentElement;
  while (el) {
    if (
      el.classList.contains('katex-mathml') ||
      el.getAttribute('aria-hidden') === 'true' ||
      el.dataset.noLineScan === 'true'
    ) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Extracts rendered visual line bands and starting words from a text block element
 * using browser Range client rects.
 */
export function scanElementVisualLines(containerEl: HTMLElement): DomVisualLine[] {
  const lines: DomVisualLine[] = [];
  const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
  const range = document.createRange();

  let currentNode: Node | null;
  while ((currentNode = walker.nextNode()) !== null) {
    if (isHiddenFromLineScan(currentNode)) continue;
    const textVal = currentNode.nodeValue;
    if (!textVal || !textVal.trim()) continue;

    const wordRe = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = wordRe.exec(textVal)) !== null) {
      const word = match[0];
      range.setStart(currentNode, match.index);
      range.setEnd(currentNode, match.index + word.length);
      const rects = range.getClientRects();
      if (!rects || rects.length === 0) continue;

      const rect = rects[0];
      if (rect.width <= 0 || rect.height <= 0) continue;
      const midY = (rect.top + rect.bottom) / 2;

      const lastLine = lines[lines.length - 1];
      const tolerance = lastLine
        ? Math.max(7, Math.min(rect.height, lastLine.height) * 0.48)
        : 0;

      if (lastLine && Math.abs(midY - lastLine.midY) <= tolerance) {
        lastLine.top = Math.min(lastLine.top, rect.top);
        lastLine.bottom = Math.max(lastLine.bottom, rect.bottom);
        lastLine.midY = (lastLine.top + lastLine.bottom) / 2;
        lastLine.height = Math.max(lastLine.height, rect.height);
        lastLine.approxCharLength += word.length + 1;
        if (lastLine.firstWords.length < 4) {
          lastLine.firstWords.push(word);
        }
      } else {
        lines.push({
          top: rect.top,
          bottom: rect.bottom,
          midY,
          height: rect.height,
          firstWords: [word],
          approxCharLength: word.length,
        });
      }
    }
  }

  return lines;
}

/**
 * Builds an ordered array of visual line snap targets across `baseBlocks` by inspecting
 * the rendered unsplit block DOM elements right at drag start.
 */
export function measureDragBaseLineTargets(
  baseBlocks: TextbookConvertedBlock[],
  getBlockElement: (blockId: string) => HTMLElement | null | undefined,
  fallbackTop = 120
): LineSnapTarget[] {
  const targets: LineSnapTarget[] = [];
  let lastBottom = fallbackTop;

  for (let blockIndex = 0; blockIndex < baseBlocks.length; blockIndex++) {
    const block = baseBlocks[blockIndex];
    const el = getBlockElement(block.id);
    const blockRect = el?.getBoundingClientRect();

    if (block.type !== 'text') {
      const top = blockRect ? blockRect.top : lastBottom;
      const bottom = blockRect ? blockRect.bottom : top + 120;
      targets.push({
        blockIndex,
        splitOffset: 0,
        lineTop: top,
        lineBottom: bottom,
      });
      lastBottom = bottom;
      continue;
    }

    const rawText = block.content || '';
    const domLines = el ? scanElementVisualLines(el) : [];

    if (domLines.length === 0) {
      const top = blockRect ? blockRect.top : lastBottom;
      const bottom = blockRect ? blockRect.bottom : top + 28;
      targets.push({
        blockIndex,
        splitOffset: 0,
        lineTop: top,
        lineBottom: bottom,
      });
      lastBottom = bottom;
      continue;
    }

    const rawOffsets = mapRenderedLineStartTokensToRawOffsets(rawText, domLines);
    let lastPushedOffset = -1;

    for (let li = 0; li < domLines.length; li++) {
      const line = domLines[li];
      const offset = rawOffsets[li] ?? 0;
      if (li > 0 && offset <= lastPushedOffset) {
        // Skip degenerate duplicate offsets while expanding previous line's bottom
        if (targets.length > 0) {
          targets[targets.length - 1].lineBottom = Math.max(
            targets[targets.length - 1].lineBottom,
            line.bottom
          );
        }
        continue;
      }
      targets.push({
        blockIndex,
        splitOffset: offset,
        lineTop: line.top,
        lineBottom: line.bottom,
      });
      lastPushedOffset = offset;
    }

    lastBottom = Math.max(
      lastBottom,
      blockRect ? blockRect.bottom : domLines[domLines.length - 1].bottom
    );
  }

  targets.push({
    blockIndex: baseBlocks.length,
    splitOffset: 0,
    lineTop: lastBottom,
    lineBottom: lastBottom + 40,
  });

  return targets;
}

/**
 * Picks the initial line target index closest to where the dragged figure started.
 */
export function findInitialLineTargetIndex(
  targets: LineSnapTarget[],
  startRectTop: number
): number {
  if (targets.length <= 1) return 0;
  let bestIdx = 0;
  for (let i = 0; i < targets.length; i++) {
    if (targets[i].lineTop <= startRectTop + 2) {
      bestIdx = i;
    } else {
      break;
    }
  }
  return bestIdx;
}
