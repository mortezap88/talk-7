export type TextDirection = 'rtl' | 'ltr';

export interface PathwayNodeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PathwayConnector {
  id: number;
  d: string;
  startX: number;
  startY: number;
  isWrap: boolean;
  isBidirectional: boolean;
}

export interface ComputedPathwayLayout {
  paths: PathwayConnector[];
  isMultiRow: boolean;
}

const RTL_CHAR_RE = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
const LTR_CHAR_RE = /[A-Za-z]/;

function countScriptChars(text: string): { rtlCount: number; ltrCount: number } {
  let rtlCount = 0;
  let ltrCount = 0;
  for (const ch of text) {
    if (RTL_CHAR_RE.test(ch)) {
      rtlCount++;
    } else if (LTR_CHAR_RE.test(ch)) {
      ltrCount++;
    }
  }
  return { rtlCount, ltrCount };
}

function stripNonProseForDirection(text: string): string {
  return text
    .replace(/\$\$[\s\S]*?\$\$|\$(?!\s)(?:[^$\n]|\\\$)+?(?<!\s)\$|\\\([\s\S]*?\\\)/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');
}

/**
 * Determines dominant reading direction (RTL vs LTR) without being fooled by a
 * single leading loanword (e.g. "improvising و تمرینات طولانی...") or LaTeX syntax.
 */
export function detectDominantDirection(
  text: string,
  fallback: TextDirection = 'ltr'
): TextDirection {
  const cleaned = stripNonProseForDirection(text);
  let counts = countScriptChars(cleaned);
  if (counts.rtlCount === 0 && counts.ltrCount === 0) {
    counts = countScriptChars(text);
  }
  if (counts.rtlCount === 0 && counts.ltrCount === 0) {
    return fallback;
  }
  if (counts.rtlCount > 0 && (counts.rtlCount >= counts.ltrCount || fallback === 'rtl')) {
    return 'rtl';
  }
  return counts.rtlCount > counts.ltrCount ? 'rtl' : 'ltr';
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '0';
}

export function computePathwayConnectors(params: {
  rects: PathwayNodeRect[];
  connectors: Array<string | undefined>;
  flowDir: TextDirection;
  containerWidth: number;
}): ComputedPathwayLayout {
  const { rects, connectors, flowDir, containerWidth } = params;
  if (rects.length < 2) {
    return { paths: [], isMultiRow: false };
  }

  const paths: PathwayConnector[] = [];
  let isMultiRow = false;

  for (let i = 0; i < rects.length - 1; i++) {
    const rectA = rects[i];
    const rectB = rects[i + 1];
    if (!rectA || !rectB) continue;

    const connector = connectors[i];
    const isBidirectional = connector === '↔' || connector === '⇌';

    const aRight = rectA.left + rectA.width;
    const aBottom = rectA.top + rectA.height;
    const aCenterY = rectA.top + rectA.height / 2;

    const bRight = rectB.left + rectB.width;
    const bBottom = rectB.top + rectB.height;
    const bCenterY = rectB.top + rectB.height / 2;

    const verticalOverlap = Math.min(aBottom, bBottom) - Math.max(rectA.top, rectB.top);
    const sameRow = verticalOverlap > Math.min(rectA.height, rectB.height) * 0.35;

    if (sameRow) {
      let startX: number;
      let endX: number;
      if (flowDir === 'rtl') {
        startX = rectA.left;
        endX = bRight + 1.5;
      } else {
        startX = aRight;
        endX = rectB.left - 1.5;
      }
      const startY = aCenterY;
      const endY = bCenterY;

      let d: string;
      if (Math.abs(startY - endY) <= 1.5) {
        d = `M ${fmt(startX)} ${fmt(startY)} L ${fmt(endX)} ${fmt(endY)}`;
      } else {
        const midX = (startX + endX) / 2;
        d = `M ${fmt(startX)} ${fmt(startY)} C ${fmt(midX)} ${fmt(startY)} ${fmt(midX)} ${fmt(endY)} ${fmt(endX)} ${fmt(endY)}`;
      }

      paths.push({
        id: i,
        d,
        startX,
        startY,
        isWrap: false,
        isBidirectional,
      });
      continue;
    }

    isMultiRow = true;
    const yMid = (aBottom + rectB.top) / 2;
    const endY = rectB.top - 1.5;

    if (flowDir === 'rtl') {
      const entryX = Math.max(rectB.left + 10, bRight - Math.min(24, rectB.width * 0.25));
      const leftSpace = rectA.left;

      let startX: number;
      let startY: number;
      let d: string;

      if (leftSpace >= 16) {
        startX = rectA.left;
        startY = aCenterY;
        const turnX = Math.max(4, rectA.left - 14);
        const horizOut = startX - turnX;
        const drop1 = yMid - startY;
        const drop2 = endY - yMid;
        const horizAcross = entryX - turnX;

        if (horizAcross >= 14 && drop1 >= 10 && drop2 >= 6) {
          const r1 = Math.min(7, horizOut * 0.85, drop1 * 0.45);
          const r2 = Math.min(7, drop1 * 0.45, horizAcross * 0.4, drop2 * 0.55);
          const r3 = Math.min(7, horizAcross * 0.4, drop2 * 0.55);
          d = [
            `M ${fmt(startX)} ${fmt(startY)}`,
            `L ${fmt(turnX + r1)} ${fmt(startY)}`,
            `Q ${fmt(turnX)} ${fmt(startY)} ${fmt(turnX)} ${fmt(startY + r1)}`,
            `L ${fmt(turnX)} ${fmt(yMid - r2)}`,
            `Q ${fmt(turnX)} ${fmt(yMid)} ${fmt(turnX + r2)} ${fmt(yMid)}`,
            `L ${fmt(entryX - r3)} ${fmt(yMid)}`,
            `Q ${fmt(entryX)} ${fmt(yMid)} ${fmt(entryX)} ${fmt(yMid + r3)}`,
            `L ${fmt(entryX)} ${fmt(endY)}`,
          ].join(' ');
        } else {
          const ctrlX = Math.min(turnX, entryX - 18);
          d = `M ${fmt(startX)} ${fmt(startY)} C ${fmt(ctrlX)} ${fmt(startY)} ${fmt(entryX)} ${fmt(yMid - 12)} ${fmt(entryX)} ${fmt(endY)}`;
        }
      } else {
        startX = Math.min(aRight - 10, rectA.left + Math.min(24, rectA.width * 0.25));
        startY = aBottom;
        const drop1 = yMid - startY;
        const drop2 = endY - yMid;
        const horizAcross = entryX - startX;

        if (horizAcross >= 14 && drop1 >= 6 && drop2 >= 6) {
          const r = Math.min(6, drop1 * 0.5, drop2 * 0.5, horizAcross * 0.4);
          d = [
            `M ${fmt(startX)} ${fmt(startY)}`,
            `L ${fmt(startX)} ${fmt(yMid - r)}`,
            `Q ${fmt(startX)} ${fmt(yMid)} ${fmt(startX + r)} ${fmt(yMid)}`,
            `L ${fmt(entryX - r)} ${fmt(yMid)}`,
            `Q ${fmt(entryX)} ${fmt(yMid)} ${fmt(entryX)} ${fmt(yMid + r)}`,
            `L ${fmt(entryX)} ${fmt(endY)}`,
          ].join(' ');
        } else {
          d = `M ${fmt(startX)} ${fmt(startY)} C ${fmt(startX)} ${fmt(yMid)} ${fmt(entryX)} ${fmt(yMid)} ${fmt(entryX)} ${fmt(endY)}`;
        }
      }

      paths.push({
        id: i,
        d,
        startX,
        startY,
        isWrap: true,
        isBidirectional,
      });
    } else {
      const entryX = Math.min(bRight - 10, rectB.left + Math.min(24, rectB.width * 0.25));
      const rightSpace = containerWidth - aRight;

      let startX: number;
      let startY: number;
      let d: string;

      if (rightSpace >= 16) {
        startX = aRight;
        startY = aCenterY;
        const turnX = Math.min(containerWidth - 4, aRight + 14);
        const horizOut = turnX - startX;
        const drop1 = yMid - startY;
        const drop2 = endY - yMid;
        const horizAcross = turnX - entryX;

        if (horizAcross >= 14 && drop1 >= 10 && drop2 >= 6) {
          const r1 = Math.min(7, horizOut * 0.85, drop1 * 0.45);
          const r2 = Math.min(7, drop1 * 0.45, horizAcross * 0.4, drop2 * 0.55);
          const r3 = Math.min(7, horizAcross * 0.4, drop2 * 0.55);
          d = [
            `M ${fmt(startX)} ${fmt(startY)}`,
            `L ${fmt(turnX - r1)} ${fmt(startY)}`,
            `Q ${fmt(turnX)} ${fmt(startY)} ${fmt(turnX)} ${fmt(startY + r1)}`,
            `L ${fmt(turnX)} ${fmt(yMid - r2)}`,
            `Q ${fmt(turnX)} ${fmt(yMid)} ${fmt(turnX - r2)} ${fmt(yMid)}`,
            `L ${fmt(entryX + r3)} ${fmt(yMid)}`,
            `Q ${fmt(entryX)} ${fmt(yMid)} ${fmt(entryX)} ${fmt(yMid + r3)}`,
            `L ${fmt(entryX)} ${fmt(endY)}`,
          ].join(' ');
        } else {
          const ctrlX = Math.max(turnX, entryX + 18);
          d = `M ${fmt(startX)} ${fmt(startY)} C ${fmt(ctrlX)} ${fmt(startY)} ${fmt(entryX)} ${fmt(yMid - 12)} ${fmt(entryX)} ${fmt(endY)}`;
        }
      } else {
        startX = Math.max(rectA.left + 10, aRight - Math.min(24, rectA.width * 0.25));
        startY = aBottom;
        const drop1 = yMid - startY;
        const drop2 = endY - yMid;
        const horizAcross = startX - entryX;

        if (horizAcross >= 14 && drop1 >= 6 && drop2 >= 6) {
          const r = Math.min(6, drop1 * 0.5, drop2 * 0.5, horizAcross * 0.4);
          d = [
            `M ${fmt(startX)} ${fmt(startY)}`,
            `L ${fmt(startX)} ${fmt(yMid - r)}`,
            `Q ${fmt(startX)} ${fmt(yMid)} ${fmt(startX - r)} ${fmt(yMid)}`,
            `L ${fmt(entryX + r)} ${fmt(yMid)}`,
            `Q ${fmt(entryX)} ${fmt(yMid)} ${fmt(entryX)} ${fmt(yMid + r)}`,
            `L ${fmt(entryX)} ${fmt(endY)}`,
          ].join(' ');
        } else {
          d = `M ${fmt(startX)} ${fmt(startY)} C ${fmt(startX)} ${fmt(yMid)} ${fmt(entryX)} ${fmt(yMid)} ${fmt(entryX)} ${fmt(endY)}`;
        }
      }

      paths.push({
        id: i,
        d,
        startX,
        startY,
        isWrap: true,
        isBidirectional,
      });
    }
  }

  return { paths, isMultiRow };
}
