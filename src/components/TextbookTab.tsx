import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  ImagePlus,
  Merge,
  RotateCcw,
  Scissors,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { motion } from 'motion/react';
import type {
  ChatAttachment,
  GeminiModel,
  TextbookConvertedBlock,
  TextbookData,
  TextbookFigure,
} from '../types/talk';
import { talkApi } from '../api/talkClient';
import {
  mergeContinuousTextbookBlocks,
  preparePageImageDataUrl,
  sortImageFilesNaturally,
} from '../utils/imageCrop';
import {
  findInitialLineTargetIndex,
  measureDragBaseLineTargets,
} from '../utils/lineMetrics';
import {
  getNextTextbookImageCode,
  normalizeTextbookFigureCodes,
} from '../utils/textbookImages';
import {
  appendDroppedTextToTextbook,
  applyLineDraggedFigurePlacement,
  buildDragBaseFlow,
  cleanConsistentFigureCaption,
  coalesceAdjacentTextBlocks,
  extractStandaloneUrlsFromPaste,
  extractUrlsFromDropData,
  formatTextbookImageLabel,
  type LineSnapTarget,
  mergeTextBlockWithNext,
  moveTextbookBlock,
  moveTextbookBlockToTail,
  normalizeBlocksToParagraphs,
  reorderTextbookBlock,
  resolveLineDragTarget,
  resolveSplitTextParts,
  splitMarkdownIntoParagraphs,
  splitTextBlockAtOffset,
} from '../utils/textbookLayout';
import { createId } from '../utils/formatters';
import {
  createUndoHistory,
  isRedoShortcut,
  isUndoShortcut,
  pushUndoSnapshot,
  stepRedo,
  stepUndo,
  type UndoHistory,
} from '../utils/undoHistory';
import { RichMessage } from './RichMessage';

const BLOCK_DRAG_MIME = 'application/x-talk-block-id';
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|heic|heif|svg)$/i;
const TEXT_EXT_RE = /\.(txt|md|markdown)$/i;
const SPRING_LAYOUT = {
  type: 'spring' as const,
  stiffness: 440,
  damping: 32,
  mass: 0.85,
};

interface ActiveFigureDragState {
  blockId: string;
  figureId: string;
  src: string;
  caption: string;
  imageLabel: string;
  pageNumber: number;
  figCode?: string;
  startRect: { left: number; top: number; width: number; height: number };
  startFlowTop: number;
  startCardTopInFlow: number;
  startScrollTop: number;
  baseWidthPct: number;
  baseHeightPx: number;
  baseBlocks: TextbookConvertedBlock[];
  hadTailText: boolean;
  lineTargets: LineSnapTarget[] | null;
  targetIdx: number;
  targetAlign: 'left' | 'center' | 'right';
}

interface TextbookTabProps {
  chatId: string;
  textbook: TextbookData;
  geminiModel?: GeminiModel;
  onSaveTextbook: (chatId: string, next: TextbookData) => Promise<void>;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result) {
        resolve(reader.result);
      } else {
        reject(new Error(`Could not read ${file.name || 'image'}`));
      }
    };
    reader.onerror = () => reject(new Error(`Failed reading ${file.name || 'image'}`));
    reader.readAsDataURL(file);
  });
}

function rasterizeSvgDataUrl(svgDataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const rawW = img.naturalWidth || 1200;
        const rawH = img.naturalHeight || 900;
        const scale = Math.min(2, 1600 / Math.max(rawW, rawH, 1));
        const width = Math.max(1, Math.round(rawW * scale));
        const height = Math.max(1, Math.round(rawH * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not prepare SVG image for text extraction.'));
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        reject(new Error('Could not rasterize SVG image for text extraction.'));
      }
    };
    img.onerror = () => reject(new Error('Could not load SVG image for text extraction.'));
    img.src = svgDataUrl;
  });
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXT_RE.test(file.name || '');
}

function isTextFile(file: File): boolean {
  return (
    file.type === 'text/plain' ||
    file.type === 'text/markdown' ||
    TEXT_EXT_RE.test(file.name || '')
  );
}

function buildTextbookImages(
  figures: TextbookFigure[],
  blocks: TextbookConvertedBlock[]
): ChatAttachment[] {
  const normalizedFigures = normalizeTextbookFigureCodes(figures);
  const activeFigureIds = new Set(
    blocks.filter((b) => b.type === 'figure' && b.figureId).map((b) => b.figureId!)
  );
  return normalizedFigures
    .filter((f) => activeFigureIds.has(f.id))
    .map((f) => f.image);
}

/**
 * Normalizes any existing TextbookData (including legacy separate `body` + `images` fields)
 * into a single ordered sequence of blocks + figures, separating any trailing user-authored
 * text block so the bottom composer stays seamlessly editable.
 */
function hydrateUnifiedTextbook(textbook: TextbookData): {
  committedBlocks: TextbookConvertedBlock[];
  tailText: string;
  tailBlockId: string;
  figures: TextbookFigure[];
  sourcePageCount: number;
} {
  let blocks: TextbookConvertedBlock[] = [...(textbook.convertedBlocks ?? [])];
  let figures: TextbookFigure[] = normalizeTextbookFigureCodes(textbook.convertedFigures ?? []);

  // Migrate legacy Box 1 text if present
  if (textbook.body && textbook.body.trim()) {
    const bodyTrimmed = textbook.body.trim();
    const alreadyPresent = blocks.some(
      (b) => b.type === 'text' && (b.content || '').trim() === bodyTrimmed
    );
    if (!alreadyPresent) {
      blocks = [
        {
          id: createId('tbb'),
          type: 'text',
          pageNumber: 0,
          content: textbook.body,
        },
        ...blocks,
      ];
    }
  }

  // Migrate legacy unconverted images if no converted blocks/figures were stored yet
  if (blocks.length === 0 && figures.length === 0 && textbook.images?.length > 0) {
    const migratedFigures: TextbookFigure[] = [];
    const migratedBlocks: TextbookConvertedBlock[] = [];
    textbook.images
      .filter((img) => img.kind === 'image' && Boolean(img.dataUrl))
      .forEach((img) => {
        const figId = img.id || createId('tbfig');
        const code = img.textbookCode || getNextTextbookImageCode(migratedFigures);
        const caption = cleanConsistentFigureCaption(img.caption || cleanImageLabel(img.name));
        migratedFigures.push({
          id: figId,
          code,
          pageNumber: img.pageNumber ?? 0,
          caption,
          image: {
            ...img,
            id: figId,
            textbookCode: code,
            caption,
          },
        });
        migratedBlocks.push({
          id: createId('tbb'),
          type: 'figure',
          pageNumber: img.pageNumber ?? 0,
          figureId: figId,
          figureCode: code,
          caption,
          align: 'full',
          widthPct: 100,
        });
      });
    figures = normalizeTextbookFigureCodes(migratedFigures);
    blocks = migratedBlocks;
  }

  // Keep every paragraph as an independent formatted block; bottom tail stays ready for new input
  const normalizedBlocks = normalizeBlocksToParagraphs(blocks, () => createId('tbb'), true);

  return {
    committedBlocks: normalizedBlocks,
    tailText: '',
    tailBlockId: createId('tbb'),
    figures,
    sourcePageCount: textbook.sourcePageCount ?? 0,
  };
}

function cleanImageLabel(fileName: string | undefined): string {
  if (!fileName) return '';
  const withoutExt = fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  if (!withoutExt || /^(image|pasted[-\s]?image[-\s]?\d*)$/i.test(withoutExt)) {
    return '';
  }
  return withoutExt;
}

function extractTextbookContextHint(blocks: TextbookConvertedBlock[]): string {
  const prose = blocks
    .filter((b) => b.type === 'text' && b.content?.trim())
    .map((b) => b.content!.trim())
    .join('\n\n');
  if (!prose) return '';
  return prose.length > 1000 ? prose.slice(-1000) : prose;
}

function normalizeEditableText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\u200B/g, '');
}

function dataUrlToFile(dataUrl: string, fallbackName: string): File | null {
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return null;
    const header = dataUrl.slice(0, commaIdx);
    const body = dataUrl.slice(commaIdx + 1);
    const mimeMatch = header.match(/^data:([^;]+)/i);
    const mimeType = mimeMatch ? mimeMatch[1].toLowerCase() : 'image/png';
    if (!mimeType.startsWith('image/')) return null;

    let bytes: Uint8Array<ArrayBuffer>;
    if (/;base64/i.test(header)) {
      const bin = atob(body);
      bytes = new Uint8Array(new ArrayBuffer(bin.length));
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
    } else {
      const decoded = decodeURIComponent(body);
      const encoded = new TextEncoder().encode(decoded);
      bytes = new Uint8Array(new ArrayBuffer(encoded.length));
      bytes.set(encoded);
    }
    const ext = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
    return new File([bytes], `${fallbackName}.${ext}`, { type: mimeType });
  } catch {
    return null;
  }
}

function inspectClipboardImages(dt: DataTransfer | null): {
  files: File[];
  dataImageUrls: string[];
} {
  if (!dt) return { files: [], dataImageUrls: [] };
  const files: File[] = [];
  const seen = new Set<string>();
  const pushFile = (file: File | null, forceImage = false) => {
    if (!file) return;
    if (!forceImage && !isImageFile(file)) return;
    const key = `${file.name}:${file.size}:${file.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };

  for (const item of Array.from(dt.items || [])) {
    if (item.kind === 'file') {
      const itemIsImage = item.type.startsWith('image/');
      const file = item.getAsFile();
      if (file) {
        pushFile(file, itemIsImage);
      }
    }
  }
  for (const file of Array.from(dt.files || [])) {
    pushFile(file, false);
  }

  const dataImageUrls: string[] = [];
  if (files.length === 0) {
    const html = dt.getData('text/html') || '';
    const htmlMatch = html.match(/<img[^>]+src=["'](data:image\/[^"']+)["']/i);
    if (htmlMatch?.[1]) {
      dataImageUrls.push(htmlMatch[1]);
    } else {
      const plain = (dt.getData('text/plain') || '').trim();
      if (/^data:image\/[a-z0-9.+-]+;/i.test(plain)) {
        dataImageUrls.push(plain);
      }
    }
  }

  return { files, dataImageUrls };
}

function clipboardPayloadToImageFiles(dt: DataTransfer | null): File[] {
  const { files, dataImageUrls } = inspectClipboardImages(dt);
  if (files.length > 0) return files;
  return dataImageUrls
    .map((url, idx) => dataUrlToFile(url, `pasted-image-${idx + 1}`))
    .filter((f): f is File => f !== null);
}

function getEditableCaretOffset(el: HTMLElement): number | undefined {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return undefined;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return undefined;
  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

function insertPlainTextAtSelection(text: string): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  if (typeof document.execCommand === 'function') {
    try {
      if (document.execCommand('insertText', false, text)) {
        return true;
      }
    } catch {
      // Fallback to direct DOM range insertion below
    }
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

function focusEditableAtPointOrEnd(
  el: HTMLElement | null,
  point?: { x: number; y: number } | null
) {
  if (!el) return;
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;

  if (point) {
    try {
      const docWithCaret = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (
          x: number,
          y: number
        ) => { offsetNode: Node; offset: number } | null;
      };
      let caretRange: Range | null = null;
      if (typeof docWithCaret.caretRangeFromPoint === 'function') {
        caretRange = docWithCaret.caretRangeFromPoint(point.x, point.y);
      } else if (typeof docWithCaret.caretPositionFromPoint === 'function') {
        const pos = docWithCaret.caretPositionFromPoint(point.x, point.y);
        if (pos) {
          caretRange = document.createRange();
          caretRange.setStart(pos.offsetNode, pos.offset);
          caretRange.collapse(true);
        }
      }
      if (caretRange && el.contains(caretRange.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(caretRange);
        return;
      }
    } catch {
      // Fallback to end of element
    }
  }

  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

interface SeamlessEditableTextProps {
  blockId: string;
  value: string;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  onChange: (nextVal: string, meta?: { isNativeHistory?: boolean }) => void;
  onPasteImages?: (files: File[], caretOffset?: number) => void;
  onPasteUrls?: (urls: string[], caretOffset?: number) => void;
  onBlur?: (nextVal: string, relatedTarget: EventTarget | null) => void;
  onBlurEmpty?: () => void;
  registerRef: (el: HTMLDivElement | null) => void;
}

function SeamlessEditableText({
  blockId,
  value,
  placeholder = '',
  ariaLabel,
  className = 'min-h-[1.6em]',
  onChange,
  onPasteImages,
  onPasteUrls,
  onBlur,
  onBlurEmpty,
  registerRef,
}: SeamlessEditableTextProps) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const lastEmittedRef = useRef<string>(value);
  const pendingEmittedRef = useRef<string[]>([]);
  const nativeUndoDepthRef = useRef(0);
  const nativeRedoDepthRef = useRef(0);

  const syncDatasetHistory = (el: HTMLDivElement | null) => {
    if (!el) return;
    el.dataset.nativeUndoDepth = String(nativeUndoDepthRef.current);
    el.dataset.nativeRedoDepth = String(nativeRedoDepthRef.current);
  };

  useLayoutEffect(() => {
    nativeUndoDepthRef.current = 0;
    nativeRedoDepthRef.current = 0;
    syncDatasetHistory(innerRef.current);
  }, [blockId]);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const pendingIdx = pendingEmittedRef.current.indexOf(value);
    if (pendingIdx !== -1) {
      pendingEmittedRef.current.splice(0, pendingIdx + 1);
      return;
    }
    pendingEmittedRef.current = [];
    const domText = normalizeEditableText(el.textContent ?? '');
    if (value !== domText) {
      el.textContent = value;
      nativeUndoDepthRef.current = 0;
      nativeRedoDepthRef.current = 0;
      syncDatasetHistory(el);
      if (document.activeElement === el) {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    }
    lastEmittedRef.current = value;
  }, [blockId, value]);

  const syncFromDom = (el: HTMLDivElement, inputType?: string) => {
    if ((el.textContent ?? '') === '' && el.childNodes.length > 0) {
      el.textContent = '';
    }
    const isHistory = inputType === 'historyUndo' || inputType === 'historyRedo';
    if (inputType === 'historyUndo') {
      nativeUndoDepthRef.current = Math.max(0, nativeUndoDepthRef.current - 1);
      nativeRedoDepthRef.current += 1;
      syncDatasetHistory(el);
    } else if (inputType === 'historyRedo') {
      nativeRedoDepthRef.current = Math.max(0, nativeRedoDepthRef.current - 1);
      nativeUndoDepthRef.current += 1;
      syncDatasetHistory(el);
    } else if (inputType !== undefined) {
      nativeUndoDepthRef.current += 1;
      nativeRedoDepthRef.current = 0;
      syncDatasetHistory(el);
    }
    const nextVal = normalizeEditableText(el.textContent ?? '');
    if (nextVal !== lastEmittedRef.current) {
      lastEmittedRef.current = nextVal;
      pendingEmittedRef.current.push(nextVal);
      onChange(nextVal, { isNativeHistory: isHistory });
    }
    return nextVal;
  };

  const handleEditablePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const pastedImages = clipboardPayloadToImageFiles(e.clipboardData);
    if (pastedImages.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      const offset = getEditableCaretOffset(e.currentTarget);
      onPasteImages?.(pastedImages, offset);
      return;
    }
    const plain = e.clipboardData?.getData('text/plain');
    if (plain && plain.length > 0) {
      const pastedUrls = onPasteUrls ? extractStandaloneUrlsFromPaste(plain) : null;
      if (pastedUrls && pastedUrls.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const offset = getEditableCaretOffset(e.currentTarget);
        onPasteUrls?.(pastedUrls, offset);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const normalized = plain.replace(/\r\n/g, '\n');
      if (insertPlainTextAtSelection(normalized)) {
        syncFromDom(e.currentTarget, 'insertFromPaste');
      }
    }
  };

  const handleEditableKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.blur();
      return;
    }
    if (e.key === 'Enter' && e.currentTarget.contentEditable !== 'plaintext-only') {
      e.preventDefault();
      if (insertPlainTextAtSelection('\n')) {
        syncFromDom(e.currentTarget, 'insertLineBreak');
      }
    }
  };

  return (
    <div
      ref={(el) => {
        innerRef.current = el;
        syncDatasetHistory(el);
        registerRef(el);
      }}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      data-placeholder={placeholder}
      dir="auto"
      onBlur={(e) => {
        const syncedVal = syncFromDom(e.currentTarget);
        if (!syncedVal.trim()) {
          onBlurEmpty?.();
        }
        onBlur?.(syncedVal, e.relatedTarget);
      }}
      onInput={(e) => {
        const inputType = (e.nativeEvent as InputEvent | undefined)?.inputType || 'insertText';
        syncFromDom(e.currentTarget, inputType);
      }}
      onPaste={handleEditablePaste}
      onKeyDown={handleEditableKeyDown}
      onDrop={(e) => {
        if (e.dataTransfer?.types?.includes(BLOCK_DRAG_MIME)) {
          e.preventDefault();
        }
      }}
      className={`bidi-plaintext whitespace-pre-wrap break-words text-[15.5px] leading-[1.82] text-slate-900 dark:text-slate-100 focus:outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-slate-400 dark:empty:before:text-slate-500 empty:before:pointer-events-none ${className}`}
    />
  );
}

interface TextbookProgressState {
  kind: 'images' | 'website';
  anchorIndex: number;
  current: number;
  total: number;
  percent: number;
  stageLabel: string;
  fileName: string;
}

function WateryPredictionBlock({ progress }: { progress: TextbookProgressState }) {
  const waveHeadingStyle = { '--wave-idx': 0 } as CSSProperties;
  const lineWidths = ['w-[96%]', 'w-[89%]', 'w-[74%]', 'w-[93%]', 'w-[62%]'];

  return (
    <div
      role="status"
      aria-live="polite"
      data-watery-prediction={progress.kind}
      className="clear-both my-4 px-5 py-5 watery-prediction-surface select-none"
    >
      <div aria-hidden="true" className="watery-caustic-a" />
      <div aria-hidden="true" className="watery-caustic-b" />
      <div aria-hidden="true" className="watery-teleport-crest" />

      <div className="relative z-10 flex items-baseline justify-between gap-4 mb-3.5 text-xs">
        <div className="min-w-0 flex items-baseline gap-2 text-sky-900/85 dark:text-sky-100/90">
          <span className="font-semibold shrink-0">{progress.stageLabel}</span>
          <span aria-hidden="true" className="text-sky-700/50 dark:text-sky-300/50">·</span>
          <span className="truncate text-sky-800/75 dark:text-sky-200/75">
            {progress.fileName}
          </span>
        </div>
        <span className="tabular-nums shrink-0 font-medium text-sky-800/70 dark:text-sky-200/75">
          {Math.max(4, Math.min(100, Math.round(progress.percent)))}%
        </span>
      </div>

      {/* Ghostly undulating predicted text ribbons waiting to resolve into crisp prose */}
      <div aria-hidden="true" className="relative z-10 space-y-2.5">
        <div style={waveHeadingStyle} className="watery-predict-heading w-[54%] mb-3" />
        {lineWidths.map((widthClass, idx) => (
          <div
            key={idx}
            style={{ '--wave-idx': idx + 1 } as CSSProperties}
            className={`watery-predict-line ${widthClass}`}
          />
        ))}
      </div>

      <div
        aria-hidden="true"
        className="relative z-10 mt-4 h-[2px] w-full rounded-full bg-sky-900/10 dark:bg-sky-200/10 overflow-hidden"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-sky-400/70 via-cyan-500/80 to-indigo-400/70 transition-all duration-500 ease-out"
          style={{ width: `${Math.max(6, Math.min(100, progress.percent))}%` }}
        />
      </div>
    </div>
  );
}

export function TextbookTab({
  chatId,
  textbook,
  geminiModel,
  onSaveTextbook,
}: TextbookTabProps) {
  const initial = useMemo(() => hydrateUnifiedTextbook(textbook), []);

  const [committedBlocks, setCommittedBlocks] = useState<TextbookConvertedBlock[]>(
    initial.committedBlocks
  );
  const [tailText, setTailText] = useState<string>(initial.tailText);
  const [tailBlockId, setTailBlockId] = useState<string>(initial.tailBlockId);
  const [figures, setFigures] = useState<TextbookFigure[]>(initial.figures);
  const [sourcePageCount, setSourcePageCount] = useState<number>(initial.sourcePageCount);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null);
  const [dragOverBlockId, setDragOverBlockId] = useState<string | null>(null);
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [editingTextBlockId, setEditingTextBlockId] = useState<string | null>(null);
  const [selectedFigureBlockId, setSelectedFigureBlockId] = useState<string | null>(null);
  const [dragOverSlotBlockId, setDragOverSlotBlockId] = useState<string | null>(null);
  const [activeFigureDrag, setActiveFigureDrag] = useState<ActiveFigureDragState | null>(null);
  const [analyzeProgress, setAnalyzeProgress] = useState<TextbookProgressState | null>(null);
  const [arrivingBlockStagger, setArrivingBlockStagger] = useState<Record<string, number>>({});
  const [analyzeNotice, setAnalyzeNotice] = useState<string | null>(null);
  const [lightboxFigure, setLightboxFigure] = useState<{
    src: string;
    caption: string;
    label: string;
  } | null>(null);

  const sectionRef = useRef<HTMLElement | null>(null);
  const slotFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingPickerSlotIdRef = useRef<string | null>(null);
  const editableTextRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tailEditableRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pageSheetRef = useRef<HTMLDivElement | null>(null);
  const flowRootRef = useRef<HTMLDivElement | null>(null);
  const tailDropZoneRef = useRef<HTMLDivElement | null>(null);
  const blockRefs = useRef<Record<string, HTMLElement | null>>({});
  const dragFloatingCardRef = useRef<HTMLDivElement | null>(null);
  const dragPlaceholderRef = useRef<HTMLDivElement | null>(null);
  const activeFigureDragRef = useRef<ActiveFigureDragState | null>(null);
  const lineTargetsRef = useRef<LineSnapTarget[] | null>(null);
  const restoreScrollTopRef = useRef<number | null>(null);
  const internalDragRef = useRef(false);
  const suppressFigureClickRef = useRef(false);
  const pendingFocusCoordsRef = useRef<{ x: number; y: number } | null>(null);
  const suppressTailBlurCommitRef = useRef(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arriveClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef(false);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const onSaveTextbookRef = useRef(onSaveTextbook);
  onSaveTextbookRef.current = onSaveTextbook;
  const geminiModelRef = useRef(geminiModel);
  geminiModelRef.current = geminiModel;
  const lastSavedUpdatedAtRef = useRef<number>(textbook.updatedAt);

  type TextbookSnapshot = {
    committedBlocks: TextbookConvertedBlock[];
    tailText: string;
    tailBlockId: string;
    figures: TextbookFigure[];
    sourcePageCount: number;
  };

  const cloneTextbookSnapshot = (snap: TextbookSnapshot): TextbookSnapshot => ({
    committedBlocks: snap.committedBlocks.map((b) => ({ ...b })),
    tailText: snap.tailText,
    tailBlockId: snap.tailBlockId,
    figures: snap.figures.map((f) => ({ ...f, image: { ...f.image } })),
    sourcePageCount: snap.sourcePageCount,
  });

  const areTextbookSnapshotsEqual = (a: TextbookSnapshot, b: TextbookSnapshot): boolean => {
    if (
      a.tailText !== b.tailText ||
      a.tailBlockId !== b.tailBlockId ||
      a.sourcePageCount !== b.sourcePageCount ||
      a.committedBlocks.length !== b.committedBlocks.length ||
      a.figures.length !== b.figures.length
    ) {
      return false;
    }
    for (let i = 0; i < a.committedBlocks.length; i++) {
      const ba = a.committedBlocks[i];
      const bb = b.committedBlocks[i];
      if (
        ba.id !== bb.id ||
        ba.type !== bb.type ||
        ba.content !== bb.content ||
        ba.caption !== bb.caption ||
        ba.figureId !== bb.figureId ||
        ba.figureCode !== bb.figureCode ||
        ba.widthPct !== bb.widthPct ||
        ba.align !== bb.align
      ) {
        return false;
      }
    }
    for (let i = 0; i < a.figures.length; i++) {
      const fa = a.figures[i];
      const fb = b.figures[i];
      if (
        fa.id !== fb.id ||
        fa.code !== fb.code ||
        fa.caption !== fb.caption ||
        fa.image?.dataUrl !== fb.image?.dataUrl
      ) {
        return false;
      }
    }
    return true;
  };

  const latestRef = useRef<TextbookSnapshot>({
    committedBlocks: initial.committedBlocks,
    tailText: initial.tailText,
    tailBlockId: initial.tailBlockId,
    figures: initial.figures,
    sourcePageCount: initial.sourcePageCount,
  });

  const historyRef = useRef<UndoHistory<TextbookSnapshot>>(createUndoHistory(60));
  const lastTypingBurstRef = useRef<{
    key: string;
    kind: 'insert' | 'delete';
    at: number;
  } | null>(null);

  const recordUndoCheckpoint = (
    prevSnapshot: TextbookSnapshot,
    mode: 'immediate' | 'typing',
    typingKey?: string,
    typingKind: 'insert' | 'delete' = 'insert'
  ) => {
    if (mode === 'immediate') {
      lastTypingBurstRef.current = null;
      historyRef.current = pushUndoSnapshot(
        historyRef.current,
        cloneTextbookSnapshot(prevSnapshot),
        areTextbookSnapshotsEqual
      );
      return;
    }
    const now = Date.now();
    const prevBurst = lastTypingBurstRef.current;
    const isSameBurst =
      Boolean(prevBurst) &&
      prevBurst!.key === typingKey &&
      prevBurst!.kind === typingKind &&
      now - prevBurst!.at < 900;
    if (!isSameBurst) {
      historyRef.current = pushUndoSnapshot(
        historyRef.current,
        cloneTextbookSnapshot(prevSnapshot),
        areTextbookSnapshotsEqual
      );
    }
    lastTypingBurstRef.current = { key: typingKey || '', kind: typingKind, at: now };
  };

  useEffect(() => {
    if (textbook.updatedAt === lastSavedUpdatedAtRef.current) {
      return;
    }
    const hydrated = hydrateUnifiedTextbook(textbook);
    setCommittedBlocks(hydrated.committedBlocks);
    setTailText(hydrated.tailText);
    setTailBlockId(hydrated.tailBlockId);
    setFigures(hydrated.figures);
    setSourcePageCount(hydrated.sourcePageCount);
    setEditingTextBlockId(null);
    latestRef.current = hydrated;
    lastSavedUpdatedAtRef.current = textbook.updatedAt;
  }, [textbook]);

  useEffect(() => {
    if (!focusBlockId) return;
    setEditingTextBlockId(focusBlockId);
    const el = editableTextRefs.current[focusBlockId];
    if (el) {
      focusEditableAtPointOrEnd(el, pendingFocusCoordsRef.current);
      pendingFocusCoordsRef.current = null;
      setFocusBlockId(null);
    }
  }, [focusBlockId, committedBlocks, editingTextBlockId]);

  useLayoutEffect(() => {
    if (!editingTextBlockId) return;
    const el = editableTextRefs.current[editingTextBlockId];
    if (el && document.activeElement !== el) {
      focusEditableAtPointOrEnd(el, pendingFocusCoordsRef.current);
      pendingFocusCoordsRef.current = null;
    }
  }, [editingTextBlockId]);

  useEffect(() => {
    historyRef.current = createUndoHistory(60);
    lastTypingBurstRef.current = null;
    setSelectedFigureBlockId(null);
    setEditingTextBlockId(null);
    pendingFocusCoordsRef.current = null;
    activeFigureDragRef.current = null;
    lineTargetsRef.current = null;
    setActiveFigureDrag(null);
  }, [chatId]);

  useLayoutEffect(() => {
    if (!activeFigureDrag) {
      restoreScrollTopRef.current = null;
      return;
    }
    if (activeFigureDrag.lineTargets !== null) {
      if (restoreScrollTopRef.current !== null && scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = restoreScrollTopRef.current;
        restoreScrollTopRef.current = null;
      }
      return;
    }

    const flowTop =
      flowRootRef.current?.getBoundingClientRect().top ?? activeFigureDrag.startFlowTop;
    const rawTargets = measureDragBaseLineTargets(
      activeFigureDrag.baseBlocks,
      (id) => blockRefs.current[id],
      activeFigureDrag.startCardTopInFlow + flowTop
    );
    const targets = rawTargets.map((t) => ({
      ...t,
      lineTop: t.lineTop - flowTop,
      lineBottom: t.lineBottom - flowTop,
    }));
    const initIdx = findInitialLineTargetIndex(targets, activeFigureDrag.startCardTopInFlow);
    lineTargetsRef.current = targets;
    restoreScrollTopRef.current = activeFigureDrag.startScrollTop;
    const nextDrag: ActiveFigureDragState = {
      ...activeFigureDrag,
      lineTargets: targets,
      targetIdx: initIdx,
    };
    activeFigureDragRef.current = nextDrag;
    setActiveFigureDrag(nextDrag);
  }, [activeFigureDrag]);

  useEffect(() => {
    if (!draggingBlockId) return;
    const resetDragState = () => {
      internalDragRef.current = false;
      setDraggingBlockId(null);
      setDragOverBlockId(null);
    };
    window.addEventListener('dragend', resetDragState);
    window.addEventListener('drop', resetDragState);
    return () => {
      window.removeEventListener('dragend', resetDragState);
      window.removeEventListener('drop', resetDragState);
    };
  }, [draggingBlockId]);

  useEffect(() => {
    if (!lightboxFigure) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxFigure(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxFigure]);

  const buildTextbookPayload = (snapshot: typeof latestRef.current): TextbookData => {
    const normalizedFigures = normalizeTextbookFigureCodes(snapshot.figures);
    const fullBlocks: TextbookConvertedBlock[] = snapshot.tailText.trim()
      ? [
          ...snapshot.committedBlocks,
          {
            id: snapshot.tailBlockId,
            type: 'text',
            pageNumber: 0,
            content: snapshot.tailText,
          },
        ]
      : snapshot.committedBlocks;

    const images = buildTextbookImages(normalizedFigures, fullBlocks);
    const updatedAt = Date.now();
    lastSavedUpdatedAtRef.current = updatedAt;

    return {
      title: '',
      body: '',
      images,
      convertedBlocks: fullBlocks,
      convertedFigures: normalizedFigures,
      sourcePageCount: snapshot.sourcePageCount,
      updatedAt,
    };
  };

  useEffect(() => {
    const mountedChatId = chatId;
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (arriveClearTimerRef.current) {
        clearTimeout(arriveClearTimerRef.current);
        arriveClearTimerRef.current = null;
      }
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        const payload = buildTextbookPayload(latestRef.current);
        void onSaveTextbookRef.current(mountedChatId, payload).catch(() => {});
      }
    };
  }, [chatId]);

  const persistSnapshot = async (
    snapshot: typeof latestRef.current,
    targetChatId = chatIdRef.current
  ) => {
    pendingSaveRef.current = false;
    const payload = buildTextbookPayload(snapshot);
    await onSaveTextbookRef.current(targetChatId, payload);
    setSaveError(null);
  };

  const scheduleSave = (snapshot: typeof latestRef.current, immediate = false) => {
    latestRef.current = snapshot;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (immediate) {
      pendingSaveRef.current = false;
      void persistSnapshot(snapshot, chatIdRef.current).catch((err) => {
        setSaveError((err as Error).message || 'Could not save textbook.');
      });
      return;
    }

    pendingSaveRef.current = true;
    const targetChatId = chatIdRef.current;
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      try {
        await persistSnapshot(latestRef.current, targetChatId);
      } catch (err) {
        setSaveError((err as Error).message || 'Could not save textbook.');
      }
    }, 500);
  };

  const flushTailTextToCommitted = (snapshot: typeof latestRef.current) => {
    if (!snapshot.tailText.trim()) {
      return {
        blocks: [...snapshot.committedBlocks],
        tailText: '',
        tailBlockId: snapshot.tailBlockId,
      };
    }
    const tailParagraphs = splitMarkdownIntoParagraphs(snapshot.tailText);
    const tailBlocks: TextbookConvertedBlock[] = tailParagraphs.map((p, idx) => ({
      id: idx === 0 ? snapshot.tailBlockId : createId('tbb'),
      type: 'text',
      pageNumber: 0,
      content: p,
    }));
    return {
      blocks: [...snapshot.committedBlocks, ...tailBlocks],
      tailText: '',
      tailBlockId: createId('tbb'),
    };
  };

  const appendPlainText = (rawText: string) => {
    const cur = latestRef.current;
    recordUndoCheckpoint(cur, 'immediate');
    const newId = createId('tbb');
    const result = appendDroppedTextToTextbook(
      cur.committedBlocks,
      cur.tailText,
      rawText,
      cur.tailBlockId,
      newId
    );
    const normalizedCommitted = normalizeBlocksToParagraphs(
      result.committedBlocks,
      () => createId('tbb'),
      true
    );
    const nextSnapshot = {
      ...cur,
      committedBlocks: normalizedCommitted,
      tailText: result.tailText,
      tailBlockId: result.addedBlockId ? createId('tbb') : cur.tailBlockId,
    };
    setCommittedBlocks(nextSnapshot.committedBlocks);
    setTailText(nextSnapshot.tailText);
    setTailBlockId(nextSnapshot.tailBlockId);
    scheduleSave(nextSnapshot, true);
  };

  const commitTailTextToBlocks = () => {
    if (suppressTailBlurCommitRef.current || analyzeProgress !== null) return;
    const cur = latestRef.current;
    const domVal = tailEditableRef.current
      ? normalizeEditableText(tailEditableRef.current.textContent ?? '')
      : cur.tailText;
    if (!domVal.trim()) {
      if (cur.tailText !== '') {
        recordUndoCheckpoint(cur, 'immediate');
        setTailText('');
        scheduleSave({ ...cur, tailText: '' }, false);
      }
      return;
    }
    recordUndoCheckpoint(cur, 'immediate');
    const flushed = flushTailTextToCommitted({ ...cur, tailText: domVal });
    const nextSnapshot = {
      ...cur,
      committedBlocks: flushed.blocks,
      tailText: flushed.tailText,
      tailBlockId: flushed.tailBlockId,
    };
    setCommittedBlocks(nextSnapshot.committedBlocks);
    setTailText(nextSnapshot.tailText);
    setTailBlockId(nextSnapshot.tailBlockId);
    scheduleSave(nextSnapshot, true);
  };

  const finishEditingTextBlock = (blockId: string, overrideText?: string) => {
    const cur = latestRef.current;
    const idx = cur.committedBlocks.findIndex((b) => b.id === blockId && b.type === 'text');
    if (idx === -1) {
      setEditingTextBlockId((prev) => (prev === blockId ? null : prev));
      return;
    }

    const domEl = editableTextRefs.current[blockId];
    const rawContent =
      overrideText ??
      (domEl ? normalizeEditableText(domEl.textContent ?? '') : cur.committedBlocks[idx].content ?? '');

    const targetBlock = cur.committedBlocks[idx];
    const prevRaw = targetBlock.content ?? '';
    const paragraphs = splitMarkdownIntoParagraphs(rawContent);
    const nextBlocks = [...cur.committedBlocks];

    if (paragraphs.length === 0) {
      nextBlocks.splice(idx, 1);
    } else {
      const replacement: TextbookConvertedBlock[] = paragraphs.map((p, pIdx) => ({
        ...targetBlock,
        id: pIdx === 0 ? targetBlock.id : createId('tbb'),
        content: p,
      }));
      nextBlocks.splice(idx, 1, ...replacement);
    }

    const unchanged =
      nextBlocks.length === cur.committedBlocks.length &&
      nextBlocks[idx]?.content === prevRaw;

    if (!unchanged && !(paragraphs.length === 0 && !prevRaw.trim())) {
      recordUndoCheckpoint(cur, 'immediate');
    }
    setEditingTextBlockId((prev) => (prev === blockId ? null : prev));
    if (!unchanged) {
      setCommittedBlocks(nextBlocks);
      scheduleSave({ ...cur, committedBlocks: nextBlocks }, true);
    }
  };

  const markBlocksAsMaterializing = (blockIds: string[]) => {
    if (blockIds.length === 0) return;
    setArrivingBlockStagger((prev) => {
      const next = { ...prev };
      blockIds.forEach((id, idx) => {
        next[id] = idx;
      });
      return next;
    });
    if (arriveClearTimerRef.current) {
      clearTimeout(arriveClearTimerRef.current);
    }
    arriveClearTimerRef.current = setTimeout(() => {
      arriveClearTimerRef.current = null;
      setArrivingBlockStagger({});
    }, 1500);
  };

  const prepareInsertionAnchor = (insertAnchor?: { blockId: string; offset?: number }) => {
    const curSnap = latestRef.current;
    recordUndoCheckpoint(curSnap, 'immediate');
    let runningBlocks: TextbookConvertedBlock[] = [...curSnap.committedBlocks];
    let nextTailText = curSnap.tailText;
    let nextTailBlockId = curSnap.tailBlockId;
    let insertCursor = runningBlocks.length;

    if (insertAnchor && insertAnchor.blockId === curSnap.tailBlockId) {
      const rawTail = curSnap.tailText;
      const splitAt =
        typeof insertAnchor.offset === 'number'
          ? Math.max(0, Math.min(rawTail.length, insertAnchor.offset))
          : rawTail.length;
      const beforeTail = rawTail.slice(0, splitAt).trimEnd();
      const afterTail = rawTail.slice(splitAt).trimStart();
      if (beforeTail) {
        for (const p of splitMarkdownIntoParagraphs(beforeTail)) {
          runningBlocks.push({
            id: runningBlocks.length === curSnap.committedBlocks.length ? curSnap.tailBlockId : createId('tbb'),
            type: 'text',
            pageNumber: 0,
            content: p,
          });
        }
        nextTailBlockId = createId('tbb');
      }
      nextTailText = afterTail;
      insertCursor = runningBlocks.length;
    } else if (insertAnchor) {
      const targetIdx = runningBlocks.findIndex(
        (b) => b.id === insertAnchor.blockId && b.type === 'text'
      );
      if (targetIdx !== -1) {
        const targetBlock = runningBlocks[targetIdx];
        const rawBlockText = targetBlock.content ?? '';
        const splitAt =
          typeof insertAnchor.offset === 'number'
            ? Math.max(0, Math.min(rawBlockText.length, insertAnchor.offset))
            : rawBlockText.length;
        const beforePart = rawBlockText.slice(0, splitAt).trimEnd();
        const afterPart = rawBlockText.slice(splitAt).trimStart();
        if (!beforePart) {
          insertCursor = targetIdx;
        } else if (!afterPart) {
          insertCursor = targetIdx + 1;
        } else {
          runningBlocks.splice(
            targetIdx,
            1,
            { ...targetBlock, content: beforePart },
            {
              id: createId('tbb'),
              type: 'text',
              pageNumber: targetBlock.pageNumber,
              content: afterPart,
            }
          );
          insertCursor = targetIdx + 1;
        }
      } else {
        const flushed = flushTailTextToCommitted(curSnap);
        runningBlocks = [...flushed.blocks];
        nextTailText = flushed.tailText;
        nextTailBlockId = flushed.tailBlockId;
        insertCursor = runningBlocks.length;
      }
    } else {
      const flushed = flushTailTextToCommitted(curSnap);
      runningBlocks = [...flushed.blocks];
      nextTailText = flushed.tailText;
      nextTailBlockId = flushed.tailBlockId;
      insertCursor = runningBlocks.length;
    }

    const existingFigures = [...curSnap.figures];
    const runningPageCount = curSnap.sourcePageCount;

    setCommittedBlocks(runningBlocks);
    setTailText(nextTailText);
    setTailBlockId(nextTailBlockId);
    latestRef.current = {
      committedBlocks: runningBlocks,
      tailText: nextTailText,
      tailBlockId: nextTailBlockId,
      figures: existingFigures,
      sourcePageCount: runningPageCount,
    };

    return {
      runningBlocks,
      nextTailText,
      nextTailBlockId,
      insertCursor,
      existingFigures,
      runningPageCount,
    };
  };

  /**
   * Scrapes one or more pasted/dropped website URLs via Tavily Extract + reader-mode formatting
   * and inserts clean body text + subtitled figure placeholder boxes at the cursor position.
   */
  const processWebsiteUrls = async (
    urls: string[],
    insertAnchor?: { blockId: string; offset?: number }
  ) => {
    if (urls.length === 0 || analyzeProgress) return;

    suppressTailBlurCommitRef.current = true;
    setEditingTextBlockId(null);
    setAnalyzeNotice(null);

    const anchorState = prepareInsertionAnchor(insertAnchor);
    let runningBlocks = anchorState.runningBlocks;
    const { nextTailText, nextTailBlockId, existingFigures } = anchorState;
    let insertCursor = anchorState.insertCursor;
    let runningPageCount = anchorState.runningPageCount;

    const formatHostLabel = (urlList: string[]) => {
      try {
        const firstHost = new URL(urlList[0]).hostname.replace(/^www\./i, '');
        return urlList.length > 1 ? `${firstHost} + ${urlList.length - 1} more` : firstHost;
      } catch {
        return urlList[0];
      }
    };

    const hostLabel = formatHostLabel(urls);
    setAnalyzeProgress({
      kind: 'website',
      anchorIndex: insertCursor,
      current: 0,
      total: urls.length,
      percent: 16,
      stageLabel: urls.length > 1 ? `Reading ${urls.length} websites…` : 'Reading website article…',
      fileName: hostLabel,
    });

    try {
      const response = await talkApi.scrapeTextbookUrls({
        urls,
        documentContext: extractTextbookContextHint(runningBlocks) || undefined,
        model: geminiModelRef.current,
      });

      const scrapedPages = Array.isArray(response.pages) ? response.pages : [];
      const incomingBlocks: TextbookConvertedBlock[] = [];

      for (const page of scrapedPages) {
        const nextPageNumber = runningPageCount + 1;
        const pageBlocks: TextbookConvertedBlock[] = [];
        for (const rawBlock of page.blocks || []) {
          if (rawBlock.type === 'figure') {
            pageBlocks.push({
              id: createId('tbb'),
              type: 'figure',
              pageNumber: nextPageNumber,
              caption: (rawBlock.caption || '').replace(/\s+/g, ' ').trim(),
              align: 'full',
              widthPct: 100,
            });
            continue;
          }
          if (rawBlock.type === 'text' && rawBlock.content?.trim()) {
            for (const paragraph of splitMarkdownIntoParagraphs(rawBlock.content)) {
              pageBlocks.push({
                id: createId('tbb'),
                type: 'text',
                pageNumber: nextPageNumber,
                content: paragraph,
              });
            }
          }
        }
        if (pageBlocks.length > 0) {
          runningPageCount = nextPageNumber;
          incomingBlocks.push(...pageBlocks);
        }
      }

      if (incomingBlocks.length > 0) {
        const prevContentById = new Map(runningBlocks.map((b) => [b.id, b.content]));
        if (insertCursor >= runningBlocks.length) {
          runningBlocks = normalizeBlocksToParagraphs(
            mergeContinuousTextbookBlocks([...runningBlocks, ...incomingBlocks]),
            () => createId('tbb'),
            true
          );
          insertCursor = runningBlocks.length;
        } else {
          const mergedChunk = normalizeBlocksToParagraphs(
            mergeContinuousTextbookBlocks(incomingBlocks),
            () => createId('tbb'),
            true
          );
          const nextRunning = [...runningBlocks];
          nextRunning.splice(insertCursor, 0, ...mergedChunk);
          runningBlocks = nextRunning;
          insertCursor += mergedChunk.length;
        }

        const materializedIds = runningBlocks
          .filter((b) => !prevContentById.has(b.id) || prevContentById.get(b.id) !== b.content)
          .map((b) => b.id);
        markBlocksAsMaterializing(materializedIds);

        const nextSnapshot = {
          committedBlocks: runningBlocks,
          tailText: nextTailText,
          tailBlockId: nextTailBlockId,
          figures: existingFigures,
          sourcePageCount: runningPageCount,
        };
        setCommittedBlocks(runningBlocks);
        setSourcePageCount(runningPageCount);
        latestRef.current = nextSnapshot;
        await persistSnapshot(nextSnapshot);
      } else {
        setAnalyzeNotice('No readable article content was found at that URL.');
      }

      if (response.failed && response.failed.length > 0) {
        setAnalyzeNotice(`Could not scrape ${response.failed[0].url}: ${response.failed[0].error}`);
      }
    } catch (err) {
      setAnalyzeNotice((err as Error).message || 'Could not scrape that website URL.');
    } finally {
      suppressTailBlurCommitRef.current = false;
      setAnalyzeProgress(null);
    }
  };

  /**
   * Unified text-only ingestion for dropped, pasted, or uploaded images & text files:
   * - Never stores or inserts image/figure blocks into the textbook
   * - Extracts verbatim text from every picture and formats it into clean, editable book-page blocks
   * - Plain .txt/.md files append directly as editable paragraphs
   */
  const processDroppedFiles = async (
    fileList: FileList | File[],
    insertAnchor?: { blockId: string; offset?: number }
  ) => {
    const allFiles = Array.from(fileList);
    const rawImages = allFiles.filter(isImageFile);
    const rawTextFiles = allFiles.filter((f) => !isImageFile(f) && isTextFile(f));

    if ((rawImages.length === 0 && rawTextFiles.length === 0) || analyzeProgress) return;

    suppressTailBlurCommitRef.current = true;
    setEditingTextBlockId(null);
    setAnalyzeNotice(null);

    // Read any dropped text files first and append cleanly
    if (rawTextFiles.length > 0) {
      const texts: string[] = [];
      for (const tf of sortImageFilesNaturally(rawTextFiles)) {
        try {
          const txt = await tf.text();
          if (txt.trim()) texts.push(txt.trim());
        } catch {
          // ignore unreadable text file
        }
      }
      if (texts.length > 0) {
        appendPlainText(texts.join('\n\n'));
      }
    }

    if (rawImages.length === 0) {
      suppressTailBlurCommitRef.current = false;
      return;
    }

    const sortedFiles = sortImageFilesNaturally(rawImages);
    const anchorState = prepareInsertionAnchor(insertAnchor);
    let runningBlocks = anchorState.runningBlocks;
    const { nextTailText, nextTailBlockId, existingFigures } = anchorState;
    let insertCursor = anchorState.insertCursor;
    let runningPageCount = anchorState.runningPageCount;

    const failedMessages: string[] = [];
    let extractedBlockCount = 0;

    type PreparedItem = {
      file: File;
      dataUrl: string;
      mimeType: string;
      assignedPageNumber: number;
      itemIndex: number;
    };

    try {
      const preparedItems: PreparedItem[] = [];
      for (let i = 0; i < sortedFiles.length; i++) {
        const file = sortedFiles[i];
        setAnalyzeProgress({
          kind: 'images',
          anchorIndex: insertCursor,
          current: 0,
          total: sortedFiles.length,
          percent: Math.max(2, Math.round(((i + 1) / sortedFiles.length) * 10)),
          stageLabel: `Preparing ${i + 1} of ${sortedFiles.length}…`,
          fileName: file.name || `Image ${i + 1}`,
        });

        const rawDataUrl = await readFileAsDataUrl(file);
        const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '');
        const rasterUrl = isSvg ? await rasterizeSvgDataUrl(rawDataUrl) : rawDataUrl;
        const prepared = await preparePageImageDataUrl(
          rasterUrl,
          isSvg ? 'image/png' : file.type || 'image/jpeg'
        );

        preparedItems.push({
          file,
          dataUrl: prepared.dataUrl,
          mimeType: prepared.mimeType,
          assignedPageNumber: runningPageCount + i + 1,
          itemIndex: i,
        });
      }

      // Phase 1: When multiple images are uploaded together, scan them in one batch
      // so all pages share one consistent language and book structure.
      type BatchPlan = Awaited<ReturnType<typeof talkApi.planTextbookBatch>>;
      type PageGuidance = NonNullable<
        Parameters<typeof talkApi.analyzeTextbookPage>[0]['batchGuidance']
      >;
      const guidanceByItemIdx = new Map<number, PageGuidance>();

      if (preparedItems.length > 1) {
        const PLAN_CHUNK = 8;
        const initialContext = extractTextbookContextHint(runningBlocks);
        for (let start = 0; start < preparedItems.length; start += PLAN_CHUNK) {
          const slice = preparedItems.slice(start, start + PLAN_CHUNK);
          setAnalyzeProgress({
            kind: 'images',
            anchorIndex: insertCursor,
            current: 0,
            total: preparedItems.length,
            percent: 15,
            stageLabel:
              preparedItems.length > PLAN_CHUNK
                ? `Scanning pages ${start + 1}–${start + slice.length} of ${preparedItems.length} together…`
                : `Scanning ${preparedItems.length} pages together…`,
            fileName: 'Matching chapter language and book structure',
          });
          try {
            const plan: BatchPlan = await talkApi.planTextbookBatch({
              pages: slice.map((item) => ({
                imageDataUrl: item.dataUrl,
                mimeType: item.mimeType,
                pageNumber: item.assignedPageNumber,
              })),
              documentContext: initialContext || undefined,
              model: geminiModelRef.current,
            });
            slice.forEach((item, localIdx) => {
              const pagePlan =
                plan.pages.find((p) => p.pageIndex === localIdx) ?? plan.pages[localIdx];
              guidanceByItemIdx.set(item.itemIndex, {
                primaryLanguage: plan.primaryLanguage,
                chapterContext: plan.chapterContext,
                expectedPageKind: pagePlan?.pageKind,
                expectedSourceType: pagePlan?.sourceType,
              });
            });
          } catch {
            // Non-fatal: per-page extractor still runs with running documentContext
          }
        }
      }

      const basePercent = preparedItems.length > 1 ? 18 : 10;
      const totalItems = preparedItems.length;

      // Phase 2: Extract verbatim book-page text 1-by-1 in sequence (never insert or store images)
      for (let idx = 0; idx < totalItems; idx++) {
        const item = preparedItems[idx];
        const file = item.file;
        const stepStartPct = Math.round(basePercent + (idx / totalItems) * (100 - basePercent));
        const stepDonePct = Math.round(basePercent + ((idx + 1) / totalItems) * (100 - basePercent));

        setAnalyzeProgress({
          kind: 'images',
          anchorIndex: insertCursor,
          current: idx + 1,
          total: totalItems,
          percent: stepStartPct,
          stageLabel: `Extracting text from image ${idx + 1} of ${totalItems}`,
          fileName: file.name || `Image ${idx + 1}`,
        });

        const pageBlocks: TextbookConvertedBlock[] = [];
        const nextPageNumber = runningPageCount + 1;
        const documentContext = extractTextbookContextHint(runningBlocks);
        const batchGuidance = guidanceByItemIdx.get(item.itemIndex);
        let analysis: Awaited<ReturnType<typeof talkApi.analyzeTextbookPage>> | null = null;
        let pageErr: unknown = null;

        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            analysis = await talkApi.analyzeTextbookPage({
              imageDataUrl: item.dataUrl,
              mimeType: item.mimeType,
              pageNumber: nextPageNumber,
              documentContext: documentContext || undefined,
              model: geminiModelRef.current,
              batchGuidance,
            });
            break;
          } catch (err) {
            pageErr = err;
            const msg = (err as Error)?.message || '';
            if (/GEMINI_API_KEY|not configured|401|403|400/i.test(msg)) {
              break;
            }
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 900));
            }
          }
        }

        if (!analysis) {
          failedMessages.push(
            (pageErr as Error)?.message || `Could not extract text from ${file.name || 'image'}.`
          );
        } else {
          const analyzedBlocks = Array.isArray(analysis.blocks) ? analysis.blocks : [];
          for (const rawBlock of analyzedBlocks) {
            if (rawBlock.type === 'figure') {
              pageBlocks.push({
                id: createId('tbb'),
                type: 'figure',
                pageNumber: nextPageNumber,
                caption: (rawBlock.caption || '').replace(/\s+/g, ' ').trim(),
                align: 'full',
                widthPct: 100,
              });
              continue;
            }
            if (rawBlock.type === 'text' && rawBlock.content?.trim()) {
              for (const paragraph of splitMarkdownIntoParagraphs(rawBlock.content)) {
                pageBlocks.push({
                  id: createId('tbb'),
                  type: 'text',
                  pageNumber: nextPageNumber,
                  content: paragraph,
                });
              }
            }
          }
          if (pageBlocks.length > 0) {
            extractedBlockCount += pageBlocks.length;
            runningPageCount = nextPageNumber;
          }
        }

        if (pageBlocks.length > 0) {
          const prevContentById = new Map(runningBlocks.map((b) => [b.id, b.content]));
          if (insertCursor >= runningBlocks.length) {
            runningBlocks = normalizeBlocksToParagraphs(
              mergeContinuousTextbookBlocks([...runningBlocks, ...pageBlocks]),
              () => createId('tbb'),
              true
            );
            insertCursor = runningBlocks.length;
          } else {
            const mergedChunk = normalizeBlocksToParagraphs(
              mergeContinuousTextbookBlocks(pageBlocks),
              () => createId('tbb'),
              true
            );
            const nextRunning = [...runningBlocks];
            nextRunning.splice(insertCursor, 0, ...mergedChunk);
            runningBlocks = nextRunning;
            insertCursor += mergedChunk.length;
          }
          const materializedIds = runningBlocks
            .filter((b) => !prevContentById.has(b.id) || prevContentById.get(b.id) !== b.content)
            .map((b) => b.id);
          markBlocksAsMaterializing(materializedIds);
        }

        const nextSnapshot = {
          committedBlocks: runningBlocks,
          tailText: nextTailText,
          tailBlockId: nextTailBlockId,
          figures: existingFigures,
          sourcePageCount: runningPageCount,
        };

        setCommittedBlocks(runningBlocks);
        setSourcePageCount(runningPageCount);
        latestRef.current = nextSnapshot;
        await persistSnapshot(nextSnapshot);

        setAnalyzeProgress({
          kind: 'images',
          anchorIndex: insertCursor,
          current: idx + 1,
          total: totalItems,
          percent: stepDonePct,
          stageLabel: `Completed image ${idx + 1} of ${totalItems}`,
          fileName: file.name || `Image ${idx + 1}`,
        });
      }

      if (failedMessages.length > 0) {
        setAnalyzeNotice(`Could not extract text: ${failedMessages[0]}`);
      } else if (extractedBlockCount === 0) {
        setAnalyzeNotice('No readable text was found in the image.');
      }
    } catch (err) {
      setAnalyzeNotice((err as Error).message || 'Failed to extract text from image.');
    } finally {
      suppressTailBlurCommitRef.current = false;
      setAnalyzeProgress(null);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
    ) {
      return;
    }
    const pastedImages = clipboardPayloadToImageFiles(e.clipboardData);
    if (pastedImages.length > 0) {
      e.preventDefault();
      void processDroppedFiles(pastedImages);
      return;
    }
    const plain = e.clipboardData?.getData('text/plain');
    const pastedUrls = plain ? extractStandaloneUrlsFromPaste(plain) : null;
    if (pastedUrls && pastedUrls.length > 0) {
      e.preventDefault();
      void processWebsiteUrls(pastedUrls);
    }
  };

  const processFilesRef = useRef(processDroppedFiles);
  processFilesRef.current = processDroppedFiles;
  const processUrlsRef = useRef(processWebsiteUrls);
  processUrlsRef.current = processWebsiteUrls;

  useEffect(() => {
    const onWindowPaste = (e: globalThis.ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        if (sectionRef.current?.contains(target)) {
          return;
        }
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }
      const pastedImages = clipboardPayloadToImageFiles(e.clipboardData);
      if (pastedImages.length > 0) {
        e.preventDefault();
        void processFilesRef.current(pastedImages);
        return;
      }
      const plain = e.clipboardData?.getData('text/plain');
      const pastedUrls = plain ? extractStandaloneUrlsFromPaste(plain) : null;
      if (pastedUrls && pastedUrls.length > 0) {
        e.preventDefault();
        void processUrlsRef.current(pastedUrls);
      }
    };
    window.addEventListener('paste', onWindowPaste);
    return () => window.removeEventListener('paste', onWindowPaste);
  }, []);

  const finishEditingRef = useRef<(blockId: string, overrideText?: string) => void>(() => {});
  const commitTailRef = useRef<() => void>(() => {});

  useEffect(() => {
    const onGlobalPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (editingTextBlockId) {
        const blockContainer = blockRefs.current[editingTextBlockId];
        if (!blockContainer || !target || !blockContainer.contains(target)) {
          finishEditingRef.current(editingTextBlockId);
        }
      }
      if (
        tailEditableRef.current &&
        document.activeElement === tailEditableRef.current &&
        (!tailDropZoneRef.current || !target || !tailDropZoneRef.current.contains(target))
      ) {
        commitTailRef.current();
        tailEditableRef.current.blur();
      }
    };
    window.addEventListener('pointerdown', onGlobalPointerDown, true);
    return () => window.removeEventListener('pointerdown', onGlobalPointerDown, true);
  }, [editingTextBlockId]);

  const handleTailTextChange = (nextVal: string, meta?: { isNativeHistory?: boolean }) => {
    const cur = latestRef.current;
    if (!meta?.isNativeHistory) {
      const delta = nextVal.length - cur.tailText.length;
      const isBulk = Math.abs(delta) > 1 || (cur.tailText.length > 0 && nextVal.length === 0);
      recordUndoCheckpoint(
        cur,
        isBulk ? 'immediate' : 'typing',
        `tail:${cur.tailBlockId}`,
        delta < 0 ? 'delete' : 'insert'
      );
    }
    setTailText(nextVal);
    scheduleSave({
      ...cur,
      tailText: nextVal,
    });
  };

  const handleUpdateCommittedText = (
    blockId: string,
    nextContent: string,
    meta?: { isNativeHistory?: boolean }
  ) => {
    const cur = latestRef.current;
    if (!meta?.isNativeHistory) {
      const prevContent = cur.committedBlocks.find((b) => b.id === blockId)?.content ?? '';
      const delta = nextContent.length - prevContent.length;
      const isBulk = Math.abs(delta) > 1 || (prevContent.length > 0 && nextContent.length === 0);
      recordUndoCheckpoint(
        cur,
        isBulk ? 'immediate' : 'typing',
        `block:${blockId}`,
        delta < 0 ? 'delete' : 'insert'
      );
    }
    const nextBlocks = cur.committedBlocks.map((b) =>
      b.id === blockId ? { ...b, content: nextContent } : b
    );
    setCommittedBlocks(nextBlocks);
    scheduleSave({ ...cur, committedBlocks: nextBlocks });
  };

  const handleRemoveCommittedTextBlock = (blockId: string) => {
    const cur = latestRef.current;
    recordUndoCheckpoint(cur, 'immediate');
    const nextBlocks = cur.committedBlocks.filter((b) => b.id !== blockId);
    setEditingTextBlockId((prev) => (prev === blockId ? null : prev));
    setCommittedBlocks(nextBlocks);
    scheduleSave({ ...cur, committedBlocks: nextBlocks }, true);
  };

  finishEditingRef.current = finishEditingTextBlock;
  commitTailRef.current = commitTailTextToBlocks;

  const handleMoveBlock = (blockId: string, direction: 'up' | 'down') => {
    const cur = latestRef.current;
    const nextBlocks = moveTextbookBlock(cur.committedBlocks, blockId, direction);
    if (nextBlocks === cur.committedBlocks) return;
    recordUndoCheckpoint(cur, 'immediate');
    setCommittedBlocks(nextBlocks);
    scheduleSave({ ...cur, committedBlocks: nextBlocks }, true);
  };

  const handleReorderBlocks = (sourceId: string, targetId: string) => {
    const cur = latestRef.current;
    const nextBlocks = reorderTextbookBlock(cur.committedBlocks, sourceId, targetId);
    if (nextBlocks === cur.committedBlocks) return;
    recordUndoCheckpoint(cur, 'immediate');
    setCommittedBlocks(nextBlocks);
    scheduleSave({ ...cur, committedBlocks: nextBlocks }, true);
  };

  const handleMoveBlockToTail = (sourceId: string) => {
    const cur = latestRef.current;
    const moved = moveTextbookBlockToTail(
      cur.committedBlocks,
      cur.tailText,
      cur.tailBlockId,
      sourceId
    );
    if (moved.committedBlocks === cur.committedBlocks && moved.tailText === cur.tailText) {
      return;
    }
    recordUndoCheckpoint(cur, 'immediate');
    const nextTailId = moved.committedTail ? createId('tbb') : cur.tailBlockId;
    const nextSnapshot = {
      ...cur,
      committedBlocks: moved.committedBlocks,
      tailText: moved.tailText,
      tailBlockId: nextTailId,
    };
    setCommittedBlocks(moved.committedBlocks);
    setTailText(moved.tailText);
    setTailBlockId(nextTailId);
    scheduleSave(nextSnapshot, true);
  };

  const startInternalBlockDrag = (e: DragEvent<HTMLElement>, blockId: string) => {
    internalDragRef.current = true;
    e.stopPropagation();
    e.dataTransfer.setData(BLOCK_DRAG_MIME, blockId);
    e.dataTransfer.effectAllowed = 'move';
    setIsDraggingFiles(false);
    setDraggingBlockId(blockId);
  };

  const endInternalBlockDrag = () => {
    internalDragRef.current = false;
    setDraggingBlockId(null);
    setDragOverBlockId(null);
  };

  /**
   * Line-based ghost-free vertical pointer drag for full-width figure cards:
   * - Lifts a solid opaque copy of the card smoothly under the pointer
   * - Measures visual prose lines once on drag start so the figure can land cleanly above or below any line/paragraph
   * - Shows a full-width landing slot in the flow
   */
  const startFigurePointerDrag = (
    e: ReactPointerEvent<HTMLElement>,
    blockId: string,
    immediateThreshold = false
  ) => {
    if (e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const threshold = immediateThreshold ? 3 : 6;
    let dragActive = false;
    let prevPointerY = startY;
    let lastSwapPointerY = startY;
    let lastSwapDir: 'up' | 'down' | null = null;

    const onMove = (moveEvent: PointerEvent) => {
      if (!dragActive) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < threshold) {
          return;
        }
        const curSnap = latestRef.current;
        const startIdx = curSnap.committedBlocks.findIndex(
          (b) => b.id === blockId && b.type === 'figure'
        );
        if (startIdx === -1) return;
        const dragBlock = curSnap.committedBlocks[startIdx];
        const fig = curSnap.figures.find((f) => f.id === dragBlock.figureId);
        const figEl = blockRefs.current[blockId];
        if (!fig?.image.dataUrl || !figEl) return;

        const rect = figEl.getBoundingClientRect();
        const startFlowTop = flowRootRef.current?.getBoundingClientRect().top ?? 0;
        const startScrollTop = scrollContainerRef.current?.scrollTop ?? 0;
        const curFiguresBefore = curSnap.committedBlocks
          .slice(0, startIdx + 1)
          .filter((b) => b.type === 'figure').length;
        const figCode = fig.code || dragBlock.figureCode;
        const imageLabel = formatTextbookImageLabel(figCode, Math.max(1, curFiguresBefore));

        const { baseBlocks, hadTailText } = buildDragBaseFlow(
          curSnap.committedBlocks,
          curSnap.tailText,
          curSnap.tailBlockId,
          blockId
        );
        lineTargetsRef.current = null;

        const initialDrag: ActiveFigureDragState = {
          blockId,
          figureId: fig.id,
          src: fig.image.dataUrl,
          caption: dragBlock.caption ?? fig.caption ?? '',
          imageLabel,
          pageNumber: fig.pageNumber,
          figCode,
          startRect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
          startFlowTop,
          startCardTopInFlow: rect.top - startFlowTop,
          startScrollTop,
          baseWidthPct: 100,
          baseHeightPx: Math.max(88, Math.round(rect.height)),
          baseBlocks,
          hadTailText,
          lineTargets: null,
          targetIdx: 0,
          targetAlign: 'center',
        };

        dragActive = true;
        suppressFigureClickRef.current = true;
        setEditingTextBlockId(null);
        window.getSelection()?.removeAllRanges();
        activeFigureDragRef.current = initialDrag;
        setActiveFigureDrag(initialDrag);
        setSelectedFigureBlockId(blockId);
      }

      const curDrag = activeFigureDragRef.current;
      if (!curDrag) return;

      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (dragFloatingCardRef.current) {
        dragFloatingCardRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.01)`;
      }

      const curFlowTop = flowRootRef.current?.getBoundingClientRect().top ?? curDrag.startFlowTop;
      const cardTop = curDrag.startRect.top + dy - curFlowTop;
      const cardHeight = curDrag.startRect.height;

      const pointerDeltaY = moveEvent.clientY - prevPointerY;
      const movingUp =
        pointerDeltaY < 0 &&
        (lastSwapDir !== 'down' || lastSwapPointerY - moveEvent.clientY >= 12);
      const movingDown =
        pointerDeltaY > 0 &&
        (lastSwapDir !== 'up' || moveEvent.clientY - lastSwapPointerY >= 12);
      prevPointerY = moveEvent.clientY;

      const targets = lineTargetsRef.current;
      const nextTargetIdx = targets
        ? resolveLineDragTarget({
            targets,
            currentTargetIdx: curDrag.targetIdx,
            targetAlign: 'center',
            cardTop,
            cardHeight,
            placeholderHeight: curDrag.baseHeightPx,
            movingUp,
            movingDown,
          })
        : curDrag.targetIdx;

      if (nextTargetIdx !== curDrag.targetIdx) {
        lastSwapPointerY = moveEvent.clientY;
        lastSwapDir = movingUp ? 'up' : movingDown ? 'down' : lastSwapDir;
        const updatedDrag: ActiveFigureDragState = {
          ...curDrag,
          targetIdx: nextTargetIdx,
        };
        activeFigureDragRef.current = updatedDrag;
        setActiveFigureDrag(updatedDrag);
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (dragActive) {
        const dragState = activeFigureDragRef.current;
        const finalTargets = lineTargetsRef.current;
        activeFigureDragRef.current = null;
        lineTargetsRef.current = null;
        setActiveFigureDrag(null);
        if (dragState) {
          const cur = latestRef.current;
          const chosenTarget = finalTargets?.[dragState.targetIdx];
          const placed = applyLineDraggedFigurePlacement({
            committedBlocks: cur.committedBlocks,
            tailText: cur.tailText,
            tailBlockId: cur.tailBlockId,
            dragBlockId: dragState.blockId,
            targetBlockIndex: chosenTarget?.blockIndex ?? dragState.baseBlocks.length,
            targetSplitOffset: chosenTarget?.splitOffset ?? 0,
            targetAlign: 'center',
            createNewBlockId: () => createId('tbb'),
          });
          const normalizedPlaced = normalizeBlocksToParagraphs(
            placed.committedBlocks,
            () => createId('tbb'),
            true
          );
          const nextTailId = placed.committedTail ? createId('tbb') : cur.tailBlockId;
          const nextSnapshot = {
            ...cur,
            committedBlocks: normalizedPlaced,
            tailText: placed.tailText,
            tailBlockId: nextTailId,
          };
          recordUndoCheckpoint(cur, 'immediate');
          setCommittedBlocks(normalizedPlaced);
          setTailText(placed.tailText);
          setTailBlockId(nextTailId);
          scheduleSave(nextSnapshot, true);
        }
        requestAnimationFrame(() => {
          suppressFigureClickRef.current = false;
        });
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const handleSplitTextBlock = (blockId: string) => {
    const cur = latestRef.current;
    const editableEl = editableTextRefs.current[blockId];
    const cursorOffset = editableEl ? getEditableCaretOffset(editableEl) : undefined;
    const newId = createId('tbb');
    const nextBlocks = splitTextBlockAtOffset(cur.committedBlocks, blockId, cursorOffset, newId);
    if (nextBlocks === cur.committedBlocks) return;
    recordUndoCheckpoint(cur, 'immediate');
    setCommittedBlocks(nextBlocks);
    setFocusBlockId(newId);
    scheduleSave({ ...cur, committedBlocks: nextBlocks }, true);
  };

  const handleMergeWithNext = (blockId: string) => {
    const cur = latestRef.current;
    const nextBlocks = mergeTextBlockWithNext(cur.committedBlocks, blockId);
    if (nextBlocks === cur.committedBlocks) return;
    recordUndoCheckpoint(cur, 'immediate');
    setCommittedBlocks(nextBlocks);
    scheduleSave({ ...cur, committedBlocks: nextBlocks }, true);
  };

  const handleUpdateFigureCaption = (blockId: string, nextCaption: string) => {
    const cur = latestRef.current;
    const targetBlock = cur.committedBlocks.find(
      (b) => b.id === blockId && b.type === 'figure'
    );
    if (!targetBlock) return;
    const prevCaption = targetBlock.caption ?? '';
    const delta = nextCaption.length - prevCaption.length;
    const isBulk = Math.abs(delta) > 1 || (prevCaption.length > 0 && nextCaption.length === 0);
    recordUndoCheckpoint(
      cur,
      isBulk ? 'immediate' : 'typing',
      `caption:${blockId}`,
      delta < 0 ? 'delete' : 'insert'
    );
    const figId = targetBlock.figureId;
    const nextBlocks = cur.committedBlocks.map((b) =>
      b.id === blockId ? { ...b, caption: nextCaption } : b
    );
    const nextFigures = figId
      ? cur.figures.map((f) =>
          f.id === figId
            ? { ...f, caption: nextCaption, image: { ...f.image, caption: nextCaption } }
            : f
        )
      : cur.figures;
    setCommittedBlocks(nextBlocks);
    setFigures(nextFigures);
    scheduleSave({
      ...cur,
      committedBlocks: nextBlocks,
      figures: nextFigures,
    });
  };

  const handleFillFigureSlot = async (blockId: string, file: File) => {
    if (!isImageFile(file)) {
      setAnalyzeNotice('Please drop or choose an image file for that image box.');
      return;
    }

    try {
      const rawDataUrl = await readFileAsDataUrl(file);
      const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '');
      const rasterUrl = isSvg ? await rasterizeSvgDataUrl(rawDataUrl) : rawDataUrl;
      const prepared = await preparePageImageDataUrl(
        rasterUrl,
        isSvg ? 'image/png' : file.type || 'image/jpeg',
        1600
      );

      const cur = latestRef.current;
      const targetBlock = cur.committedBlocks.find(
        (b) => b.id === blockId && b.type === 'figure'
      );
      if (!targetBlock) return;
      recordUndoCheckpoint(cur, 'immediate');

      const existingFig = targetBlock.figureId
        ? cur.figures.find((f) => f.id === targetBlock.figureId)
        : undefined;
      const resolvedCaption = (
        targetBlock.caption ??
        existingFig?.caption ??
        cleanImageLabel(file.name) ??
        ''
      ).trim();

      let nextFigures: TextbookFigure[];
      let figId: string;
      let code: string;

      if (existingFig) {
        figId = existingFig.id;
        code = existingFig.code || targetBlock.figureCode || getNextTextbookImageCode(cur.figures);
        nextFigures = cur.figures.map((f) =>
          f.id === existingFig.id
            ? {
                ...f,
                code,
                caption: resolvedCaption,
                image: {
                  ...f.image,
                  id: figId,
                  kind: 'image',
                  name: file.name || f.image.name || `${code}.jpg`,
                  mimeType: prepared.mimeType,
                  dataUrl: prepared.dataUrl,
                  textbookCode: code,
                  caption: resolvedCaption,
                  pageNumber: targetBlock.pageNumber,
                },
              }
            : f
        );
      } else {
        figId = createId('tbfig');
        code = getNextTextbookImageCode(cur.figures);
        const newFig: TextbookFigure = {
          id: figId,
          code,
          pageNumber: targetBlock.pageNumber,
          caption: resolvedCaption,
          image: {
            id: figId,
            kind: 'image',
            name: file.name || `${code}.jpg`,
            mimeType: prepared.mimeType,
            dataUrl: prepared.dataUrl,
            textbookCode: code,
            caption: resolvedCaption,
            pageNumber: targetBlock.pageNumber,
          },
        };
        nextFigures = normalizeTextbookFigureCodes([...cur.figures, newFig]);
      }

      const assignedCode =
        nextFigures.find((f) => f.id === figId)?.code || code;
      const nextBlocks = cur.committedBlocks.map((b) =>
        b.id === blockId
          ? {
              ...b,
              figureId: figId,
              figureCode: assignedCode,
              caption: resolvedCaption,
            }
          : b
      );

      const nextSnapshot = {
        ...cur,
        committedBlocks: nextBlocks,
        figures: nextFigures,
      };
      setAnalyzeNotice(null);
      setCommittedBlocks(nextBlocks);
      setFigures(nextFigures);
      setSelectedFigureBlockId(blockId);
      scheduleSave(nextSnapshot, true);
    } catch (err) {
      setAnalyzeNotice((err as Error).message || 'Could not load that image into the box.');
    }
  };

  const handleClearFigureImage = (blockId: string) => {
    const cur = latestRef.current;
    const targetBlock = cur.committedBlocks.find(
      (b) => b.id === blockId && b.type === 'figure'
    );
    if (!targetBlock) return;
    recordUndoCheckpoint(cur, 'immediate');
    const removedFigId = targetBlock.figureId;
    const nextBlocks: TextbookConvertedBlock[] = cur.committedBlocks.map((b): TextbookConvertedBlock => {
      if (b.id !== blockId) return b;
      const { figureId: _fId, figureCode: _fCode, ...rest } = b;
      return rest;
    });
    const stillUsedElsewhere = removedFigId
      ? nextBlocks.some((b) => b.type === 'figure' && b.figureId === removedFigId)
      : false;
    const nextFigures =
      removedFigId && !stillUsedElsewhere
        ? cur.figures.filter((f) => f.id !== removedFigId)
        : cur.figures;

    setCommittedBlocks(nextBlocks);
    setFigures(nextFigures);
    scheduleSave(
      {
        ...cur,
        committedBlocks: nextBlocks,
        figures: nextFigures,
      },
      true
    );
  };

  const handleRemoveFigure = (blockId: string) => {
    const cur = latestRef.current;
    const targetBlock = cur.committedBlocks.find(
      (b) => b.id === blockId && b.type === 'figure'
    );
    if (!targetBlock) return;
    recordUndoCheckpoint(cur, 'immediate');
    const removedFigId = targetBlock.figureId;
    const nextBlocks = coalesceAdjacentTextBlocks(
      cur.committedBlocks.filter((b) => b.id !== blockId)
    );
    const stillUsedElsewhere = removedFigId
      ? nextBlocks.some((b) => b.type === 'figure' && b.figureId === removedFigId)
      : false;
    const nextFigures =
      removedFigId && !stillUsedElsewhere
        ? cur.figures.filter((f) => f.id !== removedFigId)
        : cur.figures;
    setSelectedFigureBlockId(null);
    setCommittedBlocks(nextBlocks);
    setFigures(nextFigures);
    scheduleSave(
      {
        ...cur,
        committedBlocks: nextBlocks,
        figures: nextFigures,
      },
      true
    );
  };

  const applyHistorySnapshot = (target: TextbookSnapshot) => {
    const cloned = cloneTextbookSnapshot(target);
    lastTypingBurstRef.current = null;
    setEditingTextBlockId(null);
    setSelectedFigureBlockId(null);
    setCommittedBlocks(cloned.committedBlocks);
    setTailText(cloned.tailText);
    setTailBlockId(cloned.tailBlockId);
    setFigures(cloned.figures);
    setSourcePageCount(cloned.sourcePageCount);
    latestRef.current = cloned;
    scheduleSave(cloned, true);
  };

  const handleUndo = () => {
    if (analyzeProgress !== null) return;
    let res = stepUndo(historyRef.current, cloneTextbookSnapshot(latestRef.current));
    while (res && areTextbookSnapshotsEqual(res.nextState, latestRef.current)) {
      res = stepUndo(res.history, cloneTextbookSnapshot(latestRef.current));
    }
    if (!res) return;
    historyRef.current = res.history;
    applyHistorySnapshot(res.nextState);
  };

  const handleRedo = () => {
    if (analyzeProgress !== null) return;
    let res = stepRedo(historyRef.current, cloneTextbookSnapshot(latestRef.current));
    while (res && areTextbookSnapshotsEqual(res.nextState, latestRef.current)) {
      res = stepRedo(res.history, cloneTextbookSnapshot(latestRef.current));
    }
    if (!res) return;
    historyRef.current = res.history;
    applyHistorySnapshot(res.nextState);
  };

  const undoRef = useRef(handleUndo);
  undoRef.current = handleUndo;
  const redoRef = useRef(handleRedo);
  redoRef.current = handleRedo;

  useEffect(() => {
    const onUndoRedoKeyDown = (e: KeyboardEvent) => {
      if (lightboxFigure) return;
      const undoPressed = isUndoShortcut(e);
      const redoPressed = !undoPressed && isRedoShortcut(e);
      if (!undoPressed && !redoPressed) return;

      const active = document.activeElement as HTMLElement | null;
      const isEditable = Boolean(
        active &&
          (active.tagName === 'TEXTAREA' ||
            active.isContentEditable ||
            (active.tagName === 'INPUT' && (active as HTMLInputElement).type !== 'range'))
      );

      if (active && isEditable && !sectionRef.current?.contains(active)) {
        return;
      }

      if (active && active.isContentEditable) {
        if (undoPressed) {
          const depth = Number(active.dataset.nativeUndoDepth || '0');
          if (depth > 0) {
            if (e.key.toLowerCase() !== 'z' && typeof document.execCommand === 'function') {
              e.preventDefault();
              if (document.execCommand('undo')) return;
            } else {
              return;
            }
          }
        } else {
          const depth = Number(active.dataset.nativeRedoDepth || '0');
          if (depth > 0) {
            if (
              e.key.toLowerCase() !== 'z' &&
              e.key.toLowerCase() !== 'y' &&
              typeof document.execCommand === 'function'
            ) {
              e.preventDefault();
              if (document.execCommand('redo')) return;
            } else {
              return;
            }
          }
        }
      } else if (active && active.tagName === 'INPUT') {
        if (historyRef.current.past.length === 0 && undoPressed) return;
        if (historyRef.current.future.length === 0 && redoPressed) return;
        const depth = Number(active.dataset.nativeUndoDepth || '0');
        if (undoPressed && depth > 0) return;
        const redoDepth = Number(active.dataset.nativeRedoDepth || '0');
        if (redoPressed && redoDepth > 0) return;
      }

      if (undoPressed) {
        if (historyRef.current.past.length === 0) return;
        e.preventDefault();
        undoRef.current();
      } else if (redoPressed) {
        if (historyRef.current.future.length === 0) return;
        e.preventDefault();
        redoRef.current();
      }
    };

    window.addEventListener('keydown', onUndoRedoKeyDown);
    return () => window.removeEventListener('keydown', onUndoRedoKeyDown);
  }, [lightboxFigure]);

  const openFilePickerForSlot = (blockId: string) => {
    pendingPickerSlotIdRef.current = blockId;
    if (slotFileInputRef.current) {
      slotFileInputRef.current.value = '';
      slotFileInputRef.current.click();
    }
  };

  useEffect(() => {
    if (!selectedFigureBlockId || lightboxFigure) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedFigureBlockId(null);
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;

      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const tag = active.tagName;
        const isTextInput =
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          active.isContentEditable ||
          (tag === 'INPUT' && (active as HTMLInputElement).type !== 'range');
        if (isTextInput) return;
      }

      const selectedBlock = latestRef.current.committedBlocks.find(
        (b) => b.id === selectedFigureBlockId && b.type === 'figure'
      );
      if (selectedBlock) {
        e.preventDefault();
        handleRemoveFigure(selectedBlock.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedFigureBlockId, lightboxFigure]);

  const figureMap = new Map(figures.map((f) => [f.id, f]));
  const isAnalyzing = analyzeProgress !== null;

  const figureLabelByBlockId = new Map<string, string>();
  let figureSequence = 0;
  for (const b of committedBlocks) {
    if (b.type !== 'figure' || !b.figureId) continue;
    const f = figureMap.get(b.figureId);
    if (!f || !f.image.dataUrl) continue;
    figureSequence++;
    figureLabelByBlockId.set(
      b.id,
      formatTextbookImageLabel(f.code || b.figureCode, figureSequence)
    );
  }

  const visibleBlocks = activeFigureDrag
    ? activeFigureDrag.baseBlocks
    : committedBlocks;

  const activeDragTarget: LineSnapTarget | null =
    activeFigureDrag && activeFigureDrag.lineTargets
      ? (activeFigureDrag.lineTargets[activeFigureDrag.targetIdx] ?? null)
      : null;

  const renderExactDragPlaceholder = () => {
    if (!activeFigureDrag || !activeDragTarget) return null;

    return (
      <motion.div
        key="__drag-target-slot__"
        ref={dragPlaceholderRef}
        layout
        transition={SPRING_LAYOUT}
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        aria-hidden="true"
        data-drag-placeholder="true"
        data-target-align="full"
        data-target-block-index={activeDragTarget.blockIndex}
        data-target-split-offset={activeDragTarget.splitOffset}
        style={{ height: `${Math.max(96, activeFigureDrag.baseHeightPx)}px` }}
        className="clear-both w-full mb-4 relative rounded-lg border-2 border-dashed border-sky-500 bg-sky-50/75 dark:bg-sky-950/35 flex items-center justify-center pointer-events-none select-none"
      >
        <span className="inline-flex items-center rounded-md bg-white/95 dark:bg-slate-900/95 border border-sky-200 dark:border-sky-800 px-2.5 py-1 text-xs font-medium text-sky-700 dark:text-sky-300 shadow-2xs">
          Drop image here
        </span>
      </motion.div>
    );
  };

  const handleExternalDragOver = (e: DragEvent<HTMLElement>) => {
    if (
      draggingBlockId !== null ||
      activeFigureDrag !== null ||
      internalDragRef.current ||
      e.dataTransfer?.types?.includes(BLOCK_DRAG_MIME)
    ) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      return;
    }
    const types = Array.from(e.dataTransfer?.types || []);
    const hasDroppable =
      types.includes('Files') || types.includes('text/plain') || types.includes('text/uri-list');
    if (!hasDroppable) return;
    e.preventDefault();
    setDragOverSlotBlockId(null);
    if (!isAnalyzing) setIsDraggingFiles(true);
  };

  const handleExternalDrop = (e: DragEvent<HTMLElement>) => {
    const draggedBlock = e.dataTransfer?.getData(BLOCK_DRAG_MIME) || draggingBlockId;
    if (draggedBlock || internalDragRef.current) {
      e.preventDefault();
      e.stopPropagation();
      internalDragRef.current = false;
      setDraggingBlockId(null);
      setDragOverBlockId(null);
      setDragOverSlotBlockId(null);
      setIsDraggingFiles(false);
      if (draggedBlock) {
        const tailRect = tailDropZoneRef.current?.getBoundingClientRect();
        if (tailRect && e.clientY >= tailRect.top - 12) {
          handleMoveBlockToTail(draggedBlock);
        }
      }
      return;
    }
    e.preventDefault();
    setIsDraggingFiles(false);
    setDragOverSlotBlockId(null);
    if (isAnalyzing) return;

    if (e.dataTransfer?.files?.length) {
      void processDroppedFiles(e.dataTransfer.files);
      return;
    }
    const uriList = e.dataTransfer?.getData('text/uri-list');
    const plainText = e.dataTransfer?.getData('text/plain');
    const droppedUrls = extractUrlsFromDropData(uriList, plainText);
    if (droppedUrls && droppedUrls.length > 0) {
      void processWebsiteUrls(droppedUrls);
      return;
    }
    if (plainText && plainText.trim()) {
      appendPlainText(plainText);
    }
  };

  return (
    <>
    <input
      ref={slotFileInputRef}
      type="file"
      accept="image/*"
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        const targetBlockId = pendingPickerSlotIdRef.current;
        pendingPickerSlotIdRef.current = null;
        if (file && targetBlockId) {
          void handleFillFigureSlot(targetBlockId, file);
        }
      }}
    />
    <section
      ref={sectionRef}
      aria-label="Textbook"
      onPaste={handlePaste}
      onDragStartCapture={(e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.isContentEditable
        ) {
          return;
        }
        internalDragRef.current = true;
        setIsDraggingFiles(false);
        setDragOverSlotBlockId(null);
      }}
      onDragOver={handleExternalDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDraggingFiles(false);
          setDragOverSlotBlockId(null);
        }
      }}
      onDrop={handleExternalDrop}
      className={`@container relative flex-1 min-h-0 w-full flex flex-col bg-white dark:bg-slate-900 overflow-hidden transition-colors ${
        isDraggingFiles && !dragOverSlotBlockId ? 'ring-2 ring-inset ring-sky-500/50' : ''
      }`}
    >
      {/* Non-blocking top banner when dragging files around the book page (never covers image boxes) */}
      {isDraggingFiles && !isAnalyzing && !dragOverSlotBlockId ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-14 inset-x-0 z-30 flex justify-center px-4"
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-sky-300/90 dark:border-sky-700 bg-white/95 dark:bg-slate-900/95 px-3.5 py-1.5 text-xs font-medium text-sky-700 dark:text-sky-300 shadow-md backdrop-blur-xs">
            <ImagePlus className="w-3.5 h-3.5 shrink-0" />
            <span>
              Drop around text to extract book-page text, or drop inside an image box to fill it
            </span>
          </div>
        </div>
      ) : null}

      {/* Full-panel Document Canvas matching NotesTab spacing & edge-to-edge layout */}
      <div
        ref={scrollContainerRef}
        onClick={(e) => {
          if (isAnalyzing) return;
          const target = e.target as HTMLElement | null;
          if (!target?.closest('figure')) {
            setSelectedFigureBlockId(null);
          }
          if (
            editingTextBlockId &&
            (e.target === e.currentTarget ||
              e.target === pageSheetRef.current ||
              e.target === flowRootRef.current)
          ) {
            finishEditingTextBlock(editingTextBlockId);
          }
        }}
        className={`doc-scroll relative flex-1 min-h-0 overflow-y-auto bg-white dark:bg-slate-900 px-6 sm:px-8 pt-14 pb-6 transition-colors ${
          isDraggingFiles && !dragOverSlotBlockId ? 'bg-sky-50/25 dark:bg-sky-950/15' : ''
        }`}
      >
        <div
          ref={pageSheetRef}
          className="w-full min-h-full space-y-4"
        >

          {saveError ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 flex items-center justify-between gap-2 text-xs text-red-700 dark:text-red-300"
            >
              <span>{saveError}</span>
              <button
                type="button"
                onClick={() => setSaveError(null)}
                aria-label="Dismiss save error"
                className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/60"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : null}

          {analyzeNotice ? (
            <div
              role="status"
              className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 flex items-center justify-between gap-2 text-xs text-amber-800 dark:text-amber-300"
            >
              <span>{analyzeNotice}</span>
              <button
                type="button"
                onClick={() => setAnalyzeNotice(null)}
                aria-label="Dismiss message"
                className="p-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-900/60"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : null}

          <div ref={flowRootRef} className="flow-root">
              {visibleBlocks.map((block, idx) => {
                  const isFirst = idx === 0;
                  const isLast = idx === visibleBlocks.length - 1;
                  const isDropTarget = dragOverBlockId === block.id && draggingBlockId !== block.id;
                  const showPlaceholderBefore =
                    activeDragTarget !== null && activeDragTarget.blockIndex === idx;
                  const showWateryPredictionBefore =
                    !activeFigureDrag &&
                    isAnalyzing &&
                    analyzeProgress !== null &&
                    analyzeProgress.anchorIndex === idx;
                  const arriveStaggerIdx = arrivingBlockStagger[block.id];
                  const isMaterializing = arriveStaggerIdx !== undefined;
                  const arriveStyle = isMaterializing
                    ? ({ '--arrive-idx': arriveStaggerIdx } as CSSProperties)
                    : undefined;

                  if (block.type === 'text') {
                    const nextBlock = visibleBlocks[idx + 1];
                    const nextIsText = nextBlock?.type === 'text';
                    const contentText = block.content || '';
                    const isEditingThis = editingTextBlockId === block.id;
                    const canSplit =
                      contentText.includes('\n\n') || contentText.trim().length > 16;

                    const blockBoxSpacingClass = 'pt-1 pb-1 mb-3';

                    if (activeFigureDrag) {
                      const renderDragTextContent = (text: string) => (
                        <RichMessage content={text} variant="assistant" bookPage />
                      );

                      if (activeDragTarget === null || activeDragTarget.blockIndex !== idx) {
                        return (
                          <div
                            key={block.id}
                            ref={(el) => {
                              blockRefs.current[block.id] = el;
                            }}
                            className={`relative ${blockBoxSpacingClass} rounded-lg px-2 -mx-2`}
                          >
                            {renderDragTextContent(contentText)}
                          </div>
                        );
                      }

                      if (activeDragTarget.splitOffset <= 0) {
                        return (
                          <div key={block.id} className="contents">
                            {renderExactDragPlaceholder()}
                            <div className={`relative ${blockBoxSpacingClass} rounded-lg px-2 -mx-2`}>
                              {renderDragTextContent(contentText)}
                            </div>
                          </div>
                        );
                      }

                      if (activeDragTarget.splitOffset >= contentText.length) {
                        return (
                          <div key={block.id} className="contents">
                            <div className={`relative ${blockBoxSpacingClass} rounded-lg px-2 -mx-2`}>
                              {renderDragTextContent(contentText)}
                            </div>
                            {renderExactDragPlaceholder()}
                          </div>
                        );
                      }

                      const { before, after } = resolveSplitTextParts(
                        contentText,
                        activeDragTarget.splitOffset
                      );
                      return (
                        <div key={block.id} className="contents">
                          {before ? (
                            <div className={`relative ${blockBoxSpacingClass} rounded-lg px-2 -mx-2`}>
                              {renderDragTextContent(before)}
                            </div>
                          ) : null}
                          {renderExactDragPlaceholder()}
                          {after ? (
                            <div className={`relative ${blockBoxSpacingClass} rounded-lg px-2 -mx-2`}>
                              {renderDragTextContent(after)}
                            </div>
                          ) : null}
                        </div>
                      );
                    }

                    return (
                      <div key={block.id} className="contents">
                        {showWateryPredictionBefore && analyzeProgress ? (
                          <WateryPredictionBlock progress={analyzeProgress} />
                        ) : null}
                        <div
                          style={arriveStyle}
                          ref={(el) => {
                            blockRefs.current[block.id] = el;
                          }}
                          onClick={(e) => {
                            if (isAnalyzing || isEditingThis) return;
                            const selText = window.getSelection()?.toString() || '';
                            if (selText.length > 0) return;
                            e.stopPropagation();
                            setSelectedFigureBlockId(null);
                            pendingFocusCoordsRef.current = { x: e.clientX, y: e.clientY };
                            setEditingTextBlockId(block.id);
                          }}
                          onDragOver={(e) => {
                            if (!draggingBlockId) return;
                            e.preventDefault();
                            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                            setDragOverBlockId(block.id);
                          }}
                          onDrop={(e) => {
                            const srcId = e.dataTransfer?.getData(BLOCK_DRAG_MIME) || draggingBlockId;
                            if (!srcId) return;
                            e.preventDefault();
                            e.stopPropagation();
                            endInternalBlockDrag();
                            handleReorderBlocks(srcId, block.id);
                          }}
                          className={`group relative ${blockBoxSpacingClass} rounded-lg px-2 -mx-2 transition-colors ${
                            isMaterializing ? 'watery-text-materialize' : ''
                          } ${
                            isDropTarget
                              ? 'ring-2 ring-sky-500/40 bg-sky-50/40 dark:bg-sky-950/20'
                              : isEditingThis
                                ? 'ring-1 ring-sky-400/50 dark:ring-sky-500/40 bg-sky-50/35 dark:bg-sky-950/20'
                                : 'cursor-text'
                          }`}
                        >
                          {isEditingThis ? (
                            <SeamlessEditableText
                              blockId={block.id}
                              value={contentText}
                              ariaLabel={`Edit paragraph ${idx + 1}`}
                              placeholder="Write text for this paragraph…"
                              onChange={(nextVal, meta) => handleUpdateCommittedText(block.id, nextVal, meta)}
                              onPasteImages={(files, offset) => {
                                void processDroppedFiles(files, { blockId: block.id, offset });
                              }}
                              onPasteUrls={(urls, offset) => {
                                void processWebsiteUrls(urls, { blockId: block.id, offset });
                              }}
                            onBlur={(nextVal, relatedTarget) => {
                              const targetNode = relatedTarget as Node | null;
                              if (
                                targetNode &&
                                blockRefs.current[block.id]?.contains(targetNode)
                              ) {
                                return;
                              }
                              finishEditingTextBlock(block.id, nextVal);
                            }}
                            registerRef={(el) => {
                              editableTextRefs.current[block.id] = el;
                            }}
                          />
                        ) : (
                          <RichMessage content={contentText} variant="assistant" bookPage />
                        )}
                        <div
                          contentEditable={false}
                          data-no-line-scan="true"
                          onClick={(e) => e.stopPropagation()}
                          className={`absolute -top-2.5 right-1 z-30 flex items-center gap-0.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 px-1 py-0.5 shadow-xs transition-opacity ${
                            isEditingThis
                              ? 'opacity-100 pointer-events-auto'
                              : 'opacity-0 pointer-events-none'
                          }`}
                        >
                          <span
                            draggable
                            onDragStart={(e) => startInternalBlockDrag(e, block.id)}
                            onDragEnd={endInternalBlockDrag}
                            title="Drag to reorder"
                            className="h-5 w-5 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-grab active:cursor-grabbing"
                          >
                            <GripVertical className="w-3 h-3" />
                          </span>
                          <button
                            type="button"
                            disabled={isFirst}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleMoveBlock(block.id, 'up')}
                            aria-label="Move text block up"
                            title="Move up"
                            className="h-5 w-5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 inline-flex items-center justify-center"
                          >
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            disabled={isLast}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleMoveBlock(block.id, 'down')}
                            aria-label="Move text block down"
                            title="Move down"
                            className="h-5 w-5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 inline-flex items-center justify-center"
                          >
                            <ArrowDown className="w-3 h-3" />
                          </button>
                          {isEditingThis && canSplit ? (
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleSplitTextBlock(block.id)}
                              aria-label="Split text block"
                              title="Split at cursor or paragraph break"
                              className="h-5 w-5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center justify-center"
                            >
                              <Scissors className="w-3 h-3" />
                            </button>
                          ) : null}
                          {nextIsText ? (
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleMergeWithNext(block.id)}
                              aria-label="Merge with next paragraph"
                              title="Merge with next paragraph"
                              className="h-5 w-5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center justify-center"
                            >
                              <Merge className="w-3 h-3" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleRemoveCommittedTextBlock(block.id)}
                            aria-label="Delete paragraph"
                            title="Delete paragraph"
                            className="h-5 w-5 rounded text-slate-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400 inline-flex items-center justify-center"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                        </div>
                      </div>
                    );
                  }

                  const fig = block.figureId ? figureMap.get(block.figureId) : undefined;
                  const hasFilledImage = Boolean(fig && fig.image.dataUrl);
                  const figCode = fig?.code || block.figureCode;
                  const imageLabel =
                    figureLabelByBlockId.get(block.id) ||
                    formatTextbookImageLabel(figCode, 1);
                  const captionValue = block.caption ?? fig?.caption ?? '';
                  const isSelected = selectedFigureBlockId === block.id;
                  const isSlotDropActive = dragOverSlotBlockId === block.id;

                  const handleBoxDragOver = (e: DragEvent<HTMLElement>) => {
                    if (
                      draggingBlockId !== null ||
                      activeFigureDrag !== null ||
                      internalDragRef.current ||
                      e.dataTransfer?.types?.includes(BLOCK_DRAG_MIME)
                    ) {
                      if (!draggingBlockId) return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                      setDragOverBlockId(block.id);
                      return;
                    }
                    const types = Array.from(e.dataTransfer?.types || []);
                    if (types.includes('Files') || types.includes('text/uri-list')) {
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                      setIsDraggingFiles(false);
                      setDragOverSlotBlockId(block.id);
                    }
                  };

                  const handleBoxDragLeave = (e: DragEvent<HTMLElement>) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setDragOverSlotBlockId((prev) => (prev === block.id ? null : prev));
                    }
                  };

                  const handleBoxDrop = (e: DragEvent<HTMLElement>) => {
                    const srcId = e.dataTransfer?.getData(BLOCK_DRAG_MIME) || draggingBlockId;
                    if (srcId) {
                      e.preventDefault();
                      e.stopPropagation();
                      endInternalBlockDrag();
                      handleReorderBlocks(srcId, block.id);
                      return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverSlotBlockId(null);
                    setIsDraggingFiles(false);
                    if (isAnalyzing) return;

                    const droppedFiles = Array.from(e.dataTransfer?.files || []);
                    const imgFile = droppedFiles.find(isImageFile) || droppedFiles[0];
                    if (imgFile) {
                      void handleFillFigureSlot(block.id, imgFile);
                      return;
                    }
                    const clipboardFallback = clipboardPayloadToImageFiles(e.dataTransfer);
                    if (clipboardFallback[0]) {
                      void handleFillFigureSlot(block.id, clipboardFallback[0]);
                    }
                  };

                  const handleBoxPaste = (e: ClipboardEvent<HTMLElement>) => {
                    const targetEl = e.target as HTMLElement | null;
                    if (targetEl?.tagName === 'INPUT' || targetEl?.tagName === 'TEXTAREA') {
                      const pastedInInput = clipboardPayloadToImageFiles(e.clipboardData);
                      if (pastedInInput.length === 0) return;
                    }
                    const pastedImages = clipboardPayloadToImageFiles(e.clipboardData);
                    if (pastedImages.length > 0) {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleFillFigureSlot(block.id, pastedImages[0]);
                    }
                  };

                  if (!hasFilledImage) {
                    return (
                      <div key={block.id} className="contents">
                        {showPlaceholderBefore ? renderExactDragPlaceholder() : null}
                        {showWateryPredictionBefore && analyzeProgress ? (
                          <WateryPredictionBlock progress={analyzeProgress} />
                        ) : null}
                        <figure
                          style={arriveStyle}
                          ref={(el) => {
                            blockRefs.current[block.id] = el;
                          }}
                          tabIndex={0}
                          aria-selected={isSelected}
                          aria-label={`Waiting image box: ${captionValue || 'Untitled figure'}. Drop an image file here, paste with Ctrl+V, or click Choose image.`}
                          data-figure-placeholder="true"
                          data-selected={isSelected ? 'true' : 'false'}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedFigureBlockId(block.id);
                            const t = e.target as HTMLElement | null;
                            if (t?.tagName !== 'INPUT' && t?.tagName !== 'BUTTON') {
                              e.currentTarget.focus();
                            }
                          }}
                          onPaste={handleBoxPaste}
                          onDragOver={handleBoxDragOver}
                          onDragLeave={handleBoxDragLeave}
                          onDrop={handleBoxDrop}
                          className={`group relative ${isSelected ? 'z-30' : 'z-20'} clear-both w-full my-4 rounded-xl border-2 transition-all focus:outline-none ${
                            isMaterializing ? 'watery-text-materialize' : ''
                          } ${
                            isSlotDropActive
                              ? 'border-solid border-sky-500 bg-sky-50/90 dark:bg-sky-950/55 ring-4 ring-sky-500/20 shadow-md scale-[1.005]'
                              : isDropTarget
                                ? 'border-solid border-sky-500 ring-2 ring-sky-500/25 bg-sky-50/40 dark:bg-sky-950/20'
                                : isDraggingFiles
                                  ? 'border-dashed border-sky-400 dark:border-sky-500 bg-sky-50/35 dark:bg-sky-950/20'
                                  : isSelected
                                    ? 'border-dashed border-sky-500/80 dark:border-sky-500/70 bg-sky-50/35 dark:bg-sky-950/20 ring-2 ring-sky-500/20'
                                    : 'border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/75 dark:bg-slate-900/50 hover:border-sky-400/80 dark:hover:border-sky-600/80'
                          }`}
                        >
                          {/* Box action bar */}
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className={`absolute -top-2.5 right-2 z-30 flex items-center gap-0.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 px-1 py-0.5 shadow-xs transition-opacity ${
                              isSelected
                                ? 'opacity-100 pointer-events-auto'
                                : 'opacity-0 pointer-events-none'
                            }`}
                          >
                            <span
                              draggable
                              onDragStart={(e) => startInternalBlockDrag(e, block.id)}
                              onDragEnd={endInternalBlockDrag}
                              title="Drag to reorder"
                              className="h-5 w-5 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-grab active:cursor-grabbing"
                            >
                              <GripVertical className="w-3 h-3" />
                            </span>
                            <button
                              type="button"
                              disabled={isFirst}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleMoveBlock(block.id, 'up')}
                              aria-label="Move image box up"
                              title="Move up"
                              className="h-5 w-5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 inline-flex items-center justify-center"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={isLast}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleMoveBlock(block.id, 'down')}
                              aria-label="Move image box down"
                              title="Move down"
                              className="h-5 w-5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 inline-flex items-center justify-center"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleRemoveFigure(block.id)}
                              aria-label="Remove image box"
                              title="Remove image box"
                              className="h-5 w-5 rounded text-slate-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400 inline-flex items-center justify-center"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>

                          <div className="px-4 py-6 sm:py-7 flex flex-col items-center justify-center text-center gap-2.5 cursor-pointer">
                            <div
                              className={`w-10 h-10 rounded-xl border flex items-center justify-center transition-colors ${
                                isSlotDropActive
                                  ? 'bg-sky-500 text-white border-sky-500'
                                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-sky-600 dark:text-sky-400 shadow-2xs'
                              }`}
                            >
                              <ImagePlus className="w-5 h-5" />
                            </div>
                            <div className="space-y-1">
                              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                                {isSlotDropActive
                                  ? 'Drop image into this box'
                                  : 'Waiting for your image'}
                              </p>
                              <p className="text-[11.5px] text-slate-500 dark:text-slate-400">
                                Drop an image directly in this box, press{' '}
                                <kbd className="px-1 py-0.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono text-[10px]">
                                  Ctrl+V
                                </kbd>
                                , or{' '}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openFilePickerForSlot(block.id);
                                  }}
                                  className="font-semibold text-sky-600 dark:text-sky-400 hover:underline focus:outline-none cursor-pointer"
                                >
                                  choose image
                                </button>
                              </p>
                            </div>
                          </div>

                          {/* Subtitle footer directly under the waiting image slot */}
                          <figcaption className="border-t border-slate-200/80 dark:border-slate-700/70 bg-white/75 dark:bg-slate-900/75 rounded-b-[10px] px-3 py-2 flex items-center gap-2">
                            <input
                              type="text"
                              dir="auto"
                              aria-label="Image box subtitle"
                              title={captionValue || 'Image subtitle'}
                              value={captionValue}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedFigureBlockId(block.id);
                              }}
                              onChange={(e) => handleUpdateFigureCaption(block.id, e.target.value)}
                              placeholder="Add subtitle for this image…"
                              className="bidi-plaintext w-full bg-transparent text-xs font-medium text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 text-center rounded px-1.5 py-0.5 border border-transparent hover:border-slate-200 dark:hover:border-slate-700 focus:border-sky-500 focus:bg-white dark:focus:bg-slate-900 focus:outline-none"
                            />
                          </figcaption>
                        </figure>
                      </div>
                    );
                  }

                  return (
                    <div key={block.id} className="contents">
                      {showPlaceholderBefore ? renderExactDragPlaceholder() : null}
                      {showWateryPredictionBefore && analyzeProgress ? (
                        <WateryPredictionBlock progress={analyzeProgress} />
                      ) : null}
                      <motion.figure
                        style={arriveStyle}
                        layout={Boolean(activeFigureDrag) ? false : true}
                        transition={{ layout: SPRING_LAYOUT }}
                        ref={(el) => {
                          blockRefs.current[block.id] = el;
                        }}
                        tabIndex={0}
                        aria-selected={isSelected}
                        aria-label={`${captionValue || imageLabel}. Click to select, hold and drag to reorder, double-click to zoom, drop or paste an image to replace, or press Delete to remove.`}
                        data-figure-code={figCode || ''}
                        data-figure-label={imageLabel}
                        data-figure-align="full"
                        data-figure-width={100}
                        data-selected={isSelected ? 'true' : 'false'}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedFigureBlockId(block.id);
                          const t = e.target as HTMLElement | null;
                          if (t?.tagName !== 'INPUT' && t?.tagName !== 'BUTTON') {
                            e.currentTarget.focus();
                          }
                        }}
                        onPaste={handleBoxPaste}
                        onDragOver={handleBoxDragOver}
                        onDragLeave={handleBoxDragLeave}
                        onDrop={handleBoxDrop}
                        className={`group relative ${isSelected ? 'z-30' : 'z-20'} clear-both w-full my-4 rounded-xl border bg-white dark:bg-slate-950 overflow-visible focus:outline-none transition-all ${
                          isMaterializing ? 'watery-text-materialize' : ''
                        } ${
                          isSlotDropActive
                            ? 'border-sky-500 ring-4 ring-sky-500/25 shadow-md'
                            : isDropTarget || isSelected
                              ? 'border-sky-500 ring-2 ring-sky-500/25 shadow-sm'
                              : 'border-slate-200 dark:border-slate-700/80 hover:border-slate-300 dark:hover:border-slate-600 shadow-2xs'
                        }`}
                      >
                        {/* Filled figure action bar */}
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className={`absolute -top-2.5 right-2 z-30 flex items-center gap-0.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 px-1 py-0.5 shadow-xs transition-opacity ${
                            isSelected
                              ? 'opacity-100 pointer-events-auto'
                              : 'opacity-0 pointer-events-none'
                          }`}
                        >
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => openFilePickerForSlot(block.id)}
                            aria-label="Replace image"
                            title="Replace image"
                            className="h-5 px-1.5 rounded text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                          >
                            <Upload className="w-3 h-3" />
                            <span>Replace</span>
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleClearFigureImage(block.id)}
                            aria-label="Clear image back to placeholder box"
                            title="Clear image (keep placeholder box)"
                            className="h-5 w-5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center justify-center"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleRemoveFigure(block.id)}
                            aria-label="Remove image box"
                            title="Remove image box"
                            className="h-5 w-5 rounded text-slate-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400 inline-flex items-center justify-center"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>

                        <div className="p-2.5">
                          <button
                            type="button"
                            onPointerDown={(e) => startFigurePointerDrag(e, block.id, false)}
                            aria-label={
                              isSelected
                                ? `${captionValue || imageLabel} selected. Hold and drag to move, double-click to zoom, or press Delete to remove.`
                                : `Select or hold to move ${captionValue || imageLabel}`
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              if (suppressFigureClickRef.current) return;
                              setSelectedFigureBlockId(block.id);
                              (e.currentTarget.closest('figure') as HTMLElement | null)?.focus();
                            }}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setLightboxFigure({
                                src: fig!.image.dataUrl!,
                                caption: captionValue,
                                label: imageLabel,
                              });
                            }}
                            className="block w-full overflow-hidden rounded-md bg-slate-50/50 dark:bg-slate-950 focus-visible:outline-2 focus-visible:outline-sky-500 cursor-grab active:cursor-grabbing select-none"
                          >
                            <img
                              src={fig!.image.dataUrl}
                              alt={captionValue || imageLabel}
                              draggable={false}
                              referrerPolicy="no-referrer"
                              className="w-full max-h-[26rem] object-contain select-none pointer-events-none"
                            />
                          </button>

                          {/* Clean descriptive subtitle directly under the full-width image */}
                          <figcaption className="mt-1.5 flex items-center text-xs">
                            <input
                              type="text"
                              dir="auto"
                              aria-label={`Title for ${imageLabel}`}
                              title={captionValue || imageLabel}
                              value={captionValue}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedFigureBlockId(block.id);
                              }}
                              onChange={(e) => handleUpdateFigureCaption(block.id, e.target.value)}
                              placeholder="Add subtitle under image…"
                              className="bidi-plaintext w-full bg-transparent text-xs text-slate-600 dark:text-slate-300 placeholder:text-slate-400 dark:placeholder:text-slate-500 text-center rounded px-1 py-0.5 border border-transparent hover:border-slate-200 dark:hover:border-slate-700 focus:border-sky-500 focus:bg-white dark:focus:bg-slate-900 focus:outline-none"
                            />
                          </figcaption>
                        </div>
                      </motion.figure>
                    </div>
                  );
                })}

                {activeDragTarget && activeDragTarget.blockIndex >= visibleBlocks.length
                  ? renderExactDragPlaceholder()
                  : null}

                {!activeFigureDrag &&
                isAnalyzing &&
                analyzeProgress !== null &&
                analyzeProgress.anchorIndex >= visibleBlocks.length ? (
                  <WateryPredictionBlock progress={analyzeProgress} />
                ) : null}

              {/* Seamless Writing Canvas below blocks — commits into formatted paragraphs on blur */}
              {activeFigureDrag && activeFigureDrag.hadTailText ? null : (
                <div
                  ref={tailDropZoneRef}
                  onClick={(e) => {
                    setSelectedFigureBlockId(null);
                    if (e.target === e.currentTarget && tailEditableRef.current) {
                      focusEditableAtPointOrEnd(tailEditableRef.current);
                    }
                  }}
                  onDragOver={(e) => {
                    if (!draggingBlockId) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                    setDragOverBlockId('__tail__');
                  }}
                  onDrop={(e) => {
                    const srcId = e.dataTransfer?.getData(BLOCK_DRAG_MIME) || draggingBlockId;
                    if (!srcId) return;
                    e.preventDefault();
                    e.stopPropagation();
                    endInternalBlockDrag();
                    handleMoveBlockToTail(srcId);
                  }}
                  className={
                    visibleBlocks.length > 0 || Boolean(activeFigureDrag)
                      ? `clear-both relative rounded-lg px-2 -mx-2 pt-1 cursor-text transition-colors ${
                          dragOverBlockId === '__tail__'
                            ? 'ring-2 ring-sky-500/40 bg-sky-50/40 dark:bg-sky-950/20 pb-2'
                            : 'hover:bg-slate-50/70 dark:hover:bg-slate-800/30'
                        }`
                      : 'clear-both relative cursor-text'
                  }
                >
                  {visibleBlocks.length === 0 &&
                  tailText.length === 0 &&
                  !activeFigureDrag &&
                  !isAnalyzing ? (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none select-none absolute inset-x-0 top-0 max-w-xl text-[13.5px] leading-[1.68] text-slate-400 dark:text-slate-500"
                    >
                      <p className="mb-2.5 text-[14px] font-medium text-slate-500 dark:text-slate-400">
                        Start typing anywhere, or try any of these:
                      </p>
                      <ul className="list-disc pl-5 space-y-2 marker:text-slate-400/75 dark:marker:text-slate-600">
                        <li>
                          <span className="font-medium text-slate-500 dark:text-slate-400">
                            Write or paste text &amp; files:
                          </span>{' '}
                          Type Markdown, LaTeX math, or code directly, or drop{' '}
                          <code className="font-mono text-[12px] text-slate-500 dark:text-slate-400">
                            .txt
                          </code>{' '}
                          /{' '}
                          <code className="font-mono text-[12px] text-slate-500 dark:text-slate-400">
                            .md
                          </code>{' '}
                          files onto the page.
                        </li>
                        <li>
                          <span className="font-medium text-slate-500 dark:text-slate-400">
                            Extract text from book photos:
                          </span>{' '}
                          Press{' '}
                          <kbd className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/80 font-mono text-[11px] text-slate-500 dark:text-slate-300">
                            Ctrl+V
                          </kbd>{' '}
                          or drop one or more textbook page images to extract text and create figure boxes.
                        </li>
                        <li>
                          <span className="font-medium text-slate-500 dark:text-slate-400">
                            Scrape a webpage or article:
                          </span>{' '}
                          Paste or drop any website URL to pull its main article text and image placeholders right here.
                        </li>
                        <li>
                          <span className="font-medium text-slate-500 dark:text-slate-400">
                            Add &amp; arrange figures:
                          </span>{' '}
                          Drop, paste, or upload images into figure boxes, edit subtitles, drag them between any lines of text, or double-click to zoom.
                        </li>
                        <li>
                          <span className="font-medium text-slate-500 dark:text-slate-400">
                            Edit &amp; organize blocks:
                          </span>{' '}
                          Click any paragraph to edit, split or merge sections, reorder with arrows or drag, and undo with{' '}
                          <kbd className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/80 font-mono text-[11px] text-slate-500 dark:text-slate-300">
                            Ctrl+Z
                          </kbd>
                          .
                        </li>
                      </ul>
                    </div>
                  ) : null}
                  <SeamlessEditableText
                    blockId={tailBlockId}
                    value={tailText}
                    ariaLabel="Textbook text"
                    placeholder={
                      visibleBlocks.length > 0 && !activeFigureDrag
                        ? 'Continue writing…'
                        : ''
                    }
                    className={
                      visibleBlocks.length > 0
                        ? 'min-h-[110px]'
                        : 'min-h-[380px]'
                    }
                    onChange={handleTailTextChange}
                    onBlur={(_nextVal, relatedTarget) => {
                      const targetNode = relatedTarget as Node | null;
                      if (targetNode && tailDropZoneRef.current?.contains(targetNode)) {
                        return;
                      }
                      commitTailTextToBlocks();
                    }}
                    onPasteImages={(files, offset) => {
                      void processDroppedFiles(files, { blockId: tailBlockId, offset });
                    }}
                    onPasteUrls={(urls, offset) => {
                      void processWebsiteUrls(urls, { blockId: tailBlockId, offset });
                    }}
                    registerRef={(el) => {
                      tailEditableRef.current = el;
                    }}
                  />
                </div>
              )}
            </div>
        </div>
      </div>

      </section>

      {/* Solid lifted image card following the pointer (no ghost translucency) */}
      {activeFigureDrag ? (
        <div
          ref={dragFloatingCardRef}
          aria-hidden="true"
          data-drag-floating-card="true"
          style={{
            left: activeFigureDrag.startRect.left,
            top: activeFigureDrag.startRect.top,
            width: activeFigureDrag.startRect.width,
            transform: 'translate3d(0px, 0px, 0) scale(1.02)',
          }}
          className="fixed z-60 pointer-events-none rounded-lg border-2 border-sky-500 bg-white dark:bg-slate-950 p-2.5 shadow-2xl ring-2 ring-sky-500/30 select-none"
        >
          <div className="w-full overflow-hidden rounded-md bg-slate-50/50 dark:bg-slate-950">
            <img
              src={activeFigureDrag.src}
              alt={activeFigureDrag.caption || activeFigureDrag.imageLabel}
              draggable={false}
              className="w-full max-h-[26rem] object-contain"
            />
          </div>
          {activeFigureDrag.caption ? (
            <div className="mt-1.5 px-1 py-0.5 text-xs text-slate-600 dark:text-slate-300 truncate">
              {activeFigureDrag.caption}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Lightbox for figures */}
      {lightboxFigure ? (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-6"
          onClick={() => setLightboxFigure(null)}
        >
          <div
            className="relative max-w-6xl max-h-full flex flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setLightboxFigure(null)}
              aria-label="Close figure preview"
              className="self-end h-8 w-8 rounded-full bg-white/15 hover:bg-white/25 text-white inline-flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={lightboxFigure.src}
              alt={lightboxFigure.caption || lightboxFigure.label}
              draggable={false}
              referrerPolicy="no-referrer"
              className="max-h-[78vh] max-w-full rounded-lg bg-white shadow-2xl object-contain select-none"
            />
            {lightboxFigure.caption && lightboxFigure.caption !== lightboxFigure.label ? (
              <p
                dir="auto"
                className="bidi-plaintext text-xs text-slate-200 text-center max-w-2xl"
              >
                {lightboxFigure.caption}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
