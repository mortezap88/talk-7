import type {
  ChatAttachment,
  ChatMemory,
  ChatMessage,
  TextbookData,
  TextbookFigure,
} from '../types/talk';

export const TEXTBOOK_IMAGE_TOKEN_SOURCE = '\\[\\[\\s*IMG[-_\\s]?(\\d+)\\s*\\]\\]';

export interface TextbookImageEntry {
  code: string;
  figureId: string;
  pageNumber?: number;
  caption: string;
  image: ChatAttachment;
}

export function normalizeTextbookImageCode(rawCode?: string | null): string | null {
  if (!rawCode) return null;
  const match = rawCode.trim().match(/^IMG[-_\s]?(\d+)$/i);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) && num > 0 ? `IMG-${num}` : null;
}

export function parseTextbookImageCodeNumber(code?: string | null): number {
  if (!code) return 0;
  const match = code.trim().match(/^IMG[-_\s]?(\d+)$/i);
  if (!match) return 0;
  const num = Number(match[1]);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

export function getNextTextbookImageCode(existingFigures: TextbookFigure[]): string {
  let maxNum = 0;
  for (let i = 0; i < existingFigures.length; i++) {
    const parsed = parseTextbookImageCodeNumber(existingFigures[i].code);
    if (parsed > maxNum) {
      maxNum = parsed;
    } else if (parsed === 0 && i + 1 > maxNum) {
      maxNum = i + 1;
    }
  }
  return `IMG-${maxNum + 1}`;
}

/**
 * Ensures every TextbookFigure carries a unique, stable `IMG-N` code.
 * Preserves existing valid codes and assigns sequential next codes only when missing or duplicated.
 */
export function normalizeTextbookFigureCodes(figures: TextbookFigure[]): TextbookFigure[] {
  const preReserved = new Set<string>();
  for (const fig of figures) {
    const normalized = normalizeTextbookImageCode(fig.code);
    if (normalized) {
      preReserved.add(normalized);
    }
  }

  const used = new Set<string>();
  let nextNum = 1;

  return figures.map((fig) => {
    const normalized = normalizeTextbookImageCode(fig.code);
    let code = normalized;
    if (!code || used.has(code)) {
      while (preReserved.has(`IMG-${nextNum}`) || used.has(`IMG-${nextNum}`)) {
        nextNum++;
      }
      code = `IMG-${nextNum}`;
      nextNum++;
    }
    used.add(code);
    return {
      ...fig,
      code,
      image: {
        ...fig.image,
        textbookCode: code,
        caption: fig.caption,
        pageNumber: fig.pageNumber,
      },
    };
  });
}

/**
 * Builds the canonical ordered list of textbook images with unique `IMG-N` codes
 * from either converted Book Pages or legacy unconverted textbook images.
 */
export function buildTextbookImageCatalog(
  textbook?: TextbookData | null,
  maxImages = Infinity
): TextbookImageEntry[] {
  if (!textbook) return [];

  const blocks = textbook.convertedBlocks ?? [];
  const figures = textbook.convertedFigures ?? [];

  if (blocks.length > 0 && figures.length > 0) {
    const normalizedFigures = normalizeTextbookFigureCodes(figures);
    const figMap = new Map(normalizedFigures.map((f) => [f.id, f]));
    const entries: TextbookImageEntry[] = [];
    const seenIds = new Set<string>();

    for (const block of blocks) {
      if (block.type !== 'figure' || !block.figureId) continue;
      if (seenIds.has(block.figureId)) continue;
      const fig = figMap.get(block.figureId);
      if (!fig || !fig.image?.dataUrl) continue;
      seenIds.add(fig.id);
      const code = normalizeTextbookImageCode(block.figureCode) || fig.code || `IMG-${entries.length + 1}`;
      const pageNum = fig.pageNumber > 0 ? fig.pageNumber : undefined;
      const caption = (
        block.caption ||
        fig.caption ||
        (pageNum ? `Page ${pageNum} Figure` : `Picture ${code}`)
      ).trim();
      entries.push({
        code,
        figureId: fig.id,
        pageNumber: pageNum,
        caption,
        image: {
          ...fig.image,
          textbookCode: code,
          caption,
          pageNumber: pageNum,
        },
      });
      if (Number.isFinite(maxImages) && entries.length >= maxImages) break;
    }
    return entries;
  }

  const legacyImages = (textbook.images || []).filter(
    (img) => img.kind === 'image' && Boolean(img.dataUrl)
  );
  const limitedLegacyImages = Number.isFinite(maxImages)
    ? legacyImages.slice(0, maxImages)
    : legacyImages;

  return limitedLegacyImages
    .map((img, idx) => {
      const code = normalizeTextbookImageCode(img.textbookCode) || `IMG-${idx + 1}`;
      const caption = (img.caption || img.name || `Textbook Image ${idx + 1}`).trim();
      return {
        code,
        figureId: img.id,
        pageNumber: img.pageNumber,
        caption,
        image: {
          ...img,
          textbookCode: code,
          caption,
        },
      };
    });
}

/**
 * Extracts unique normalized `IMG-N` codes from `[[IMG-N]]` markers in order of appearance.
 */
export function extractTextbookImageCodes(text: string): string[] {
  if (!text) return [];
  const re = new RegExp(TEXTBOOK_IMAGE_TOKEN_SOURCE, 'gi');
  const seen = new Set<string>();
  const ordered: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const code = `IMG-${Number(match[1])}`;
    if (!seen.has(code)) {
      seen.add(code);
      ordered.push(code);
    }
  }
  return ordered;
}

/**
 * Scans assistant chat history (plus memory packs if present) to find every
 * textbook image code already displayed in this conversation so the tutor never repeats them.
 */
export function collectShownTextbookImageCodes(
  messages: ChatMessage[],
  memory?: ChatMemory | null
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const record = (text: string) => {
    for (const code of extractTextbookImageCodes(text)) {
      if (!seen.has(code)) {
        seen.add(code);
        ordered.push(code);
      }
    }
  };

  if (memory?.packs) {
    for (const pack of memory.packs) {
      record(pack.summary);
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant' || msg.memoryStage) continue;
    record(msg.content);
  }

  return ordered;
}
