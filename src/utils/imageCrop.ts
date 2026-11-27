import type { TextbookConvertedBlock, TextbookFigure } from '../types/talk';
import { normalizeTextbookFigureCodes, normalizeTextbookImageCode } from './textbookImages';

/**
 * Downscales overly huge photos (>2200px) cleanly via canvas so multi-page textbook uploads
 * remain fast and crisp for both OCR and figure cropping.
 */
export async function preparePageImageDataUrl(
  rawDataUrl: string,
  mimeType = 'image/jpeg',
  maxEdge = 2200
): Promise<{ dataUrl: string; mimeType: string }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not decode dropped image.'));
    el.src = rawDataUrl;
  });

  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest <= maxEdge && rawDataUrl.length < 2_500_000) {
    return { dataUrl: rawDataUrl, mimeType };
  }

  const scale = Math.min(1, maxEdge / longest);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { dataUrl: rawDataUrl, mimeType };
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const outMime = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  return { dataUrl: canvas.toDataURL(outMime, 0.9), mimeType: outMime };
}

/**
 * Sorts image files naturally so page2.jpg comes before page10.jpg.
 */
export function sortImageFilesNaturally(files: File[]): File[] {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/**
 * Normalizes a 0..1000 bounding box [ymin, xmin, ymax, xmax] with slight padding
 * so edge labels are never clipped, returning pixel coordinates or null if degenerate.
 */
export function normalizeBoxToPixels(
  box: [number, number, number, number],
  width: number,
  height: number,
  paddingUnits = 12
): { sx: number; sy: number; sw: number; sh: number } | null {
  const rawYMin = Math.min(box[0], box[2]);
  const rawYMax = Math.max(box[0], box[2]);
  const rawXMin = Math.min(box[1], box[3]);
  const rawXMax = Math.max(box[1], box[3]);

  if (rawYMax - rawYMin < 18 || rawXMax - rawXMin < 18) {
    return null;
  }

  const yMin = Math.max(0, rawYMin - paddingUnits);
  const xMin = Math.max(0, rawXMin - paddingUnits);
  const yMax = Math.min(1000, rawYMax + paddingUnits);
  const xMax = Math.min(1000, rawXMax + paddingUnits);

  const sx = Math.floor((xMin / 1000) * width);
  const sy = Math.floor((yMin / 1000) * height);
  const ex = Math.ceil((xMax / 1000) * width);
  const ey = Math.ceil((yMax / 1000) * height);

  const sw = Math.max(1, ex - sx);
  const sh = Math.max(1, ey - sy);
  return { sx, sy, sw, sh };
}

/**
 * Crops a normalized [ymin, xmin, ymax, xmax] region from an image data URL via canvas.
 */
export async function cropNormalizedRegion(
  imageDataUrl: string,
  box: [number, number, number, number],
  preferredMime = 'image/jpeg'
): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Failed to decode image for figure cropping.'));
    el.src = imageDataUrl;
  });

  const pixels = normalizeBoxToPixels(box, img.naturalWidth, img.naturalHeight);
  if (!pixels) {
    return imageDataUrl;
  }

  // Keep crisp textbook figure resolution up to 1600px on the longest side
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(pixels.sw, pixels.sh));
  const outW = Math.max(1, Math.round(pixels.sw * scale));
  const outH = Math.max(1, Math.round(pixels.sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return imageDataUrl;
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(
    img,
    pixels.sx,
    pixels.sy,
    pixels.sw,
    pixels.sh,
    0,
    0,
    outW,
    outH
  );

  const outputMime = preferredMime === 'image/png' ? 'image/png' : 'image/jpeg';
  return canvas.toDataURL(outputMime, 0.9);
}

/**
 * Deterministically stitches consecutive text blocks across page breaks without altering any words.
 * If the previous text block ends mid-sentence (no terminal punctuation, heading, list, table, or code fence)
 * and the next text block continues prose, joins them with a single space; otherwise preserves paragraph separation.
 */
export function mergeContinuousTextbookBlocks(
  blocks: TextbookConvertedBlock[]
): TextbookConvertedBlock[] {
  const merged: TextbookConvertedBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      const text = (block.content || '').trim();
      if (!text) continue;

      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.type === 'text' &&
        prev.content &&
        prev.pageNumber > 0 &&
        block.pageNumber > 0
      ) {
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
        prev.content = `${prevTrimmed}${separator}${text}`;
        continue;
      }

      merged.push({ ...block, content: text });
    } else {
      merged.push(block);
    }
  }

  return merged;
}

/**
 * Builds clean plain/markdown representation of Box 2's converted continuous textbook
 * for prompt injection, keeping inline figure locations and captions matching attached textbook images.
 */
export function serializeConvertedBlocksForPrompt(
  blocks: TextbookConvertedBlock[],
  figures?: TextbookFigure[]
): string {
  const figureIds = new Set<string>();
  if (figures && figures.length > 0) {
    for (const fig of figures) {
      if (fig.id) figureIds.add(fig.id);
    }
  }

  return blocks
    .map((block) => {
      if (block.type === 'text') {
        return (block.content || '').trim();
      }
      const cap = block.caption ? `: ${block.caption}` : '';
      const hasMappedFigure = Boolean(
        block.figureId && (figureIds.size === 0 || figureIds.has(block.figureId))
      );
      if (!hasMappedFigure && !normalizeTextbookImageCode(block.figureCode)) {
        return `[Image Placeholder (awaiting user upload)${cap}]`;
      }
      const loc =
        block.pageNumber && block.pageNumber > 0
          ? `Figure from Page ${block.pageNumber}`
          : 'Picture';
      return `[${loc}${cap}]`;
    })
    .filter(Boolean)
    .join('\n\n');
}
