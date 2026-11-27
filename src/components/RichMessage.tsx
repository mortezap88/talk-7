import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import katex from 'katex';
import {
  AlertTriangle,
  BookMarked,
  Check,
  Copy,
  Eye,
  EyeOff,
  FlaskConical,
  GitCompare,
  Lightbulb,
  ListChecks,
  Quote,
  Sparkles,
} from 'lucide-react';
import { parseMessageSegments } from '../utils/qaParser';
import {
  computePathwayConnectors,
  detectDominantDirection,
  type PathwayConnector,
  type TextDirection,
} from '../utils/pathwayLayout';

export type MessageVariant = 'assistant' | 'user';

function detectBaseDirection(text: string): 'rtl' | 'ltr' {
  return detectDominantDirection(text, 'ltr');
}


function sanitizeLatex(raw: string): string {
  // AI occasionally emits `\-` for a chemical bond inside math mode; KaTeX expects `-`.
  return raw.replace(/\\-(?=[A-Za-z0-9\\({[])/g, '-').trim();
}

function InteractiveTitleFrame({
  bookPage,
  children,
}: {
  bookPage: boolean;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = frameRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.setProperty('--mx', `${x.toFixed(1)}px`);
    el.style.setProperty('--my', `${y.toFixed(1)}px`);
    el.style.setProperty('--glow', '1');

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!prefersReducedMotion) {
      const nx = (x / rect.width - 0.5) * 2;
      const ny = (y / rect.height - 0.5) * 2;
      const maxTilt = 1.15;
      el.style.setProperty('--rx', `${(-ny * maxTilt).toFixed(2)}deg`);
      el.style.setProperty('--ry', `${(nx * maxTilt).toFixed(2)}deg`);
      el.style.setProperty('--ty', '-1px');
    }
  };

  const handlePointerDown = () => {
    const el = frameRef.current;
    if (!el) return;
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!prefersReducedMotion) {
      el.style.setProperty('--sc', '0.996');
      el.style.setProperty('--ty', '0px');
    }
  };

  const handlePointerUp = () => {
    const el = frameRef.current;
    if (!el) return;
    el.style.setProperty('--sc', '1');
    el.style.setProperty('--ty', '-1px');
  };

  const handlePointerLeave = () => {
    const el = frameRef.current;
    if (!el) return;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--ty', '0px');
    el.style.setProperty('--sc', '1');
    el.style.setProperty('--glow', '0');
  };

  return (
    <div
      ref={frameRef}
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      className={`rich-title-frame ${
        bookPage
          ? 'px-4 py-3 sm:px-5 sm:py-4'
          : 'px-3.5 py-2.5 sm:px-4 sm:py-3'
      }`}
    >
      {children}
    </div>
  );
}

function MathSpan({
  expr,
  displayMode = false,
}: {
  expr: string;
  displayMode?: boolean;
  variant?: MessageVariant;
}) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const cleaned = useMemo(() => sanitizeLatex(expr), [expr]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    try {
      katex.render(cleaned, el, {
        displayMode,
        throwOnError: false,
        strict: false,
        trust: false,
      });
    } catch {
      el.textContent = expr;
    }
  }, [cleaned, displayMode, expr]);

  if (displayMode) {
    return (
      <div
        dir="ltr"
        className="rich-block-enter my-2 px-3.5 py-2.5 rounded-lg border overflow-x-auto text-center border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 text-slate-900 dark:text-slate-100"
      >
        <span ref={containerRef} className="inline-block" />
      </div>
    );
  }

  return (
    <span
      ref={containerRef}
      dir="ltr"
      className="inline-block align-baseline mx-0.5 px-0.5"
    />
  );
}

function ClozeSpan({
  text,
  variant,
  depth,
  parentDir,
}: {
  text: string;
  variant: MessageVariant;
  depth: number;
  parentDir?: TextDirection;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setRevealed((prev) => !prev);
      }}
      title={revealed ? 'Click to hide recall blank' : 'Click to reveal recall blank'}
      aria-pressed={revealed}
      className={`inline-flex items-center gap-1 mx-0.5 px-2 py-0.5 rounded-md border align-baseline text-[0.94em] font-medium transition-all duration-200 cursor-pointer ${
        revealed
          ? 'bg-emerald-50/90 dark:bg-emerald-950/65 text-emerald-900 dark:text-emerald-100 border-emerald-300/90 dark:border-emerald-700/80 shadow-2xs'
          : 'rich-cloze-shimmer bg-slate-100/95 dark:bg-slate-800/90 text-slate-700 dark:text-slate-200 border-indigo-300/80 dark:border-indigo-700/70 hover:border-indigo-400 dark:hover:border-indigo-500'
      }`}
    >
      {revealed ? (
        <EyeOff className="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Eye className="w-3 h-3 shrink-0 text-indigo-500 dark:text-indigo-400" />
      )}
      <span
        className={`transition-all duration-200 ${
          revealed ? 'blur-0 opacity-100' : 'blur-[4.5px] opacity-65 select-none'
        }`}
      >
        <RichInlineText
          text={text}
          variant={variant}
          depth={depth + 1}
          parentDir={parentDir}
        />
      </span>
    </button>
  );
}

const PATHWAY_SPLIT_RE = /\s*(->|=>|→|↔|⇌)\s*/;

function PathwaySpan({
  text,
  variant,
  depth,
  parentDir,
}: {
  text: string;
  variant: MessageVariant;
  depth: number;
  parentDir?: TextDirection;
}) {
  const parts = useMemo(() => text.split(PATHWAY_SPLIT_RE), [text]);
  const isChain = parts.length >= 3;
  const flowDir = useMemo(
    () => detectDominantDirection(text, parentDir ?? 'ltr'),
    [text, parentDir]
  );

  const steps = useMemo(() => {
    if (!isChain) return [];
    const list: Array<{ label: string; connectorAfter?: string }> = [];
    for (let i = 0; i < parts.length; i += 2) {
      const label = (parts[i] ?? '').trim();
      const connectorAfter = parts[i + 1];
      if (label) {
        list.push({ label, connectorAfter });
      }
    }
    return list;
  }, [isChain, parts]);

  const containerRef = useRef<HTMLSpanElement | null>(null);
  const nodeRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [paths, setPaths] = useState<PathwayConnector[]>([]);
  const [isMultiRow, setIsMultiRow] = useState(false);
  const uid = useId().replace(/:/g, '');

  const recomputeConnectors = useMemo(() => {
    return () => {
      const container = containerRef.current;
      if (!container || steps.length < 2) {
        setPaths([]);
        setIsMultiRow(false);
        return;
      }
      const cRect = container.getBoundingClientRect();
      if (cRect.width <= 0) return;

      const rects = steps.map((_, idx) => {
        const node = nodeRefs.current[idx];
        if (!node) return { left: 0, top: 0, width: 0, height: 0 };
        const nRect = node.getBoundingClientRect();
        return {
          left: nRect.left - cRect.left,
          top: nRect.top - cRect.top,
          width: nRect.width,
          height: nRect.height,
        };
      });

      const computed = computePathwayConnectors({
        rects,
        connectors: steps.map((s) => s.connectorAfter),
        flowDir,
        containerWidth: cRect.width,
      });
      setPaths(computed.paths);
      setIsMultiRow(computed.isMultiRow);
    };
  }, [flowDir, steps]);

  useLayoutEffect(() => {
    if (!isChain || steps.length < 2) return;
    recomputeConnectors();
  }, [isChain, steps.length, recomputeConnectors]);

  useEffect(() => {
    if (!isChain || steps.length < 2) return;
    const container = containerRef.current;
    if (!container) return;

    let rafId = 0;
    const scheduleRecompute = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(recomputeConnectors);
    };

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleRecompute)
        : null;
    observer?.observe(container);
    nodeRefs.current.forEach((node) => {
      if (node) observer?.observe(node);
    });

    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(scheduleRecompute).catch(() => {});
    }

    return () => {
      cancelAnimationFrame(rafId);
      observer?.disconnect();
    };
  }, [isChain, steps.length, recomputeConnectors]);

  if (!isChain || steps.length < 2) {
    return (
      <span
        dir={flowDir}
        className="rich-concept-chip px-1.5 py-0.5 mx-0.5 rounded-md font-medium bg-indigo-50/90 dark:bg-indigo-950/60 text-indigo-800 dark:text-indigo-200 border border-indigo-200/90 dark:border-indigo-800/70 shadow-2xs"
      >
        <RichInlineText
          text={text}
          variant={variant}
          depth={depth + 1}
          parentDir={flowDir}
        />
      </span>
    );
  }

  const arrowEndId = `pathway-arrow-end-${uid}`;
  const arrowStartId = `pathway-arrow-start-${uid}`;

  return (
    <span
      ref={containerRef}
      dir={flowDir}
      style={{ columnGap: '28px', rowGap: '28px' }}
      className={`relative inline-flex flex-wrap items-center max-w-full ${
        isMultiRow ? 'my-2 align-middle' : 'my-1 align-middle'
      }`}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 w-full h-full overflow-visible text-sky-600 dark:text-sky-400"
      >
        <defs>
          <marker
            id={arrowEndId}
            markerUnits="userSpaceOnUse"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M 0.5 1.1 L 7.2 4 L 0.5 6.9 Z" fill="currentColor" />
          </marker>
          <marker
            id={arrowStartId}
            markerUnits="userSpaceOnUse"
            markerWidth="8"
            markerHeight="8"
            refX="1"
            refY="4"
            orient="auto"
          >
            <path d="M 7.5 1.1 L 0.8 4 L 7.5 6.9 Z" fill="currentColor" />
          </marker>
        </defs>
        {paths.map((p) => (
          <g key={p.id}>
            <path
              d={p.d}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity="0.88"
              markerStart={p.isBidirectional ? `url(#${arrowStartId})` : undefined}
              markerEnd={`url(#${arrowEndId})`}
            />
            <path
              d={p.d}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="pathway-train-pulse"
            />
            {!p.isBidirectional ? (
              <circle
                cx={p.startX}
                cy={p.startY}
                r="2.4"
                fill="currentColor"
                opacity="0.95"
              />
            ) : null}
          </g>
        ))}
      </svg>

      {steps.map((step, sIdx) => {
        const stepDir = detectDominantDirection(step.label, flowDir);
        return (
          <span
            key={sIdx}
            ref={(el) => {
              nodeRefs.current[sIdx] = el;
            }}
            dir={stepDir}
            style={{ '--stagger-idx': sIdx } as CSSProperties}
            className="rich-block-enter relative z-10 inline-block max-w-full rounded-lg border border-sky-200/95 dark:border-sky-700/75 bg-white/95 dark:bg-slate-900/95 px-2.5 py-1 text-[0.92em] font-medium leading-snug text-slate-900 dark:text-slate-100 shadow-2xs transition-colors hover:border-sky-400 dark:hover:border-sky-500"
          >
            <span className="bidi-plaintext block">
              <RichInlineText
                text={step.label}
                variant={variant}
                depth={depth + 1}
                parentDir={stepDir}
              />
            </span>
            {sIdx < steps.length - 1 && step.connectorAfter ? (
              <span className="sr-only">{` ${step.connectorAfter} `}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

const INLINE_TOKEN_RE =
  /(\$\$(?:[^$\n]|\\\$)+\$\$|\$(?!\s)(?:[^$\n]|\\\$)+?(?<!\s)\$|\\\((?:[^)\n]|\\\))+?\\\)|\[\[\s*[Ii][Mm][Gg][-_\s]?\d+\s*\]\]|`[^`\n]+`|==[^=\n]+==|!![^!\n]+!!|\+\+[^+\n]+\+\+|@@[^@\n]+@@|\^\^(?!\s)[^\^\n]+?(?<!\s)\^\^|%%(?!\s)(?:[^%\n]|%(?!%))*?(?<!\s)%%|~~[^~\n]+~~|__[^_\n]+__|\*\*[^\s*](?:[^\n]*?[^\s*])?\*\*|\*[^\s*](?:[^*\n]*?[^\s*])?\*)/;

const TEXTBOOK_CHIP_RE = /^\[\[\s*IMG[-_\s]?(\d+)\s*\]\]$/i;

export function RichInlineText({
  text,
  variant = 'assistant',
  depth = 0,
  parentDir,
}: {
  text: string;
  variant?: MessageVariant;
  depth?: number;
  parentDir?: TextDirection;
}) {
  if (!text) return null;
  if (depth > 4) return <>{text}</>;

  const nodes: ReactNode[] = [];
  let remaining = text;
  let keyCounter = 0;

  while (remaining.length > 0) {
    const match = INLINE_TOKEN_RE.exec(remaining);
    if (!match || match.index === undefined) {
      nodes.push(remaining);
      break;
    }

    if (match.index > 0) {
      nodes.push(remaining.slice(0, match.index));
    }

    const token = match[0];
    const k = `${depth}_${keyCounter++}`;

    if (token.startsWith('$$') && token.endsWith('$$') && token.length > 4) {
      nodes.push(<MathSpan key={k} expr={token.slice(2, -2)} variant={variant} />);
    } else if (token.startsWith('$') && token.endsWith('$') && token.length > 2) {
      nodes.push(<MathSpan key={k} expr={token.slice(1, -1)} variant={variant} />);
    } else if (token.startsWith('\\(') && token.endsWith('\\)') && token.length > 4) {
      nodes.push(<MathSpan key={k} expr={token.slice(2, -2)} variant={variant} />);
    } else if (TEXTBOOK_CHIP_RE.test(token)) {
      // Textbook figures live in the Textbook tab; ignore any legacy [[IMG-N]] markers in text.
    } else if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      const inner = token.slice(1, -1);
      if (/^(==[^=\n]+==|!![^!\n]+!!|\+\+[^+\n]+\+\+|@@[^@\n]+@@|\^\^[^\^\n]+\^\^|%%[^%\n]+%%)$/.test(inner)) {
        nodes.push(
          <RichInlineText
            key={k}
            text={inner}
            variant={variant}
            depth={depth + 1}
            parentDir={parentDir}
          />
        );
      } else {
        nodes.push(
          <code
            key={k}
            dir="ltr"
            className="inline-block px-1.5 py-0.5 rounded font-mono text-[0.85em] bg-slate-100 dark:bg-slate-800/90 text-sky-700 dark:text-sky-300 border border-slate-200/80 dark:border-slate-700"
          >
            {inner}
          </code>
        );
      }
    } else if (token.startsWith('==') && token.endsWith('==') && token.length > 4) {
      nodes.push(
        <mark
          key={k}
          className="rich-ink-mark px-1.5 py-0.5 rounded font-medium bg-transparent dark:bg-amber-950/55 bg-gradient-to-r from-amber-200/85 via-amber-100/90 to-amber-200/80 dark:from-amber-500/25 dark:via-amber-500/18 dark:to-amber-400/25 text-slate-900 dark:text-amber-100 border-b border-amber-400/70 dark:border-amber-400/60"
        >
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            parentDir={parentDir}
          />
        </mark>
      );
    } else if (token.startsWith('!!') && token.endsWith('!!') && token.length > 4) {
      nodes.push(
        <span
          key={k}
          className="rich-pitfall-chip inline-block px-1.5 py-0.5 rounded-md font-medium bg-rose-100/90 dark:bg-rose-950/75 text-rose-800 dark:text-rose-200 border border-rose-300/85 dark:border-rose-800/80 underline decoration-wavy decoration-rose-400/80 underline-offset-3"
        >
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            parentDir={parentDir}
          />
        </span>
      );
    } else if (token.startsWith('++') && token.endsWith('++') && token.length > 4) {
      nodes.push(
        <span
          key={k}
          className="rich-ink-mark px-1.5 py-0.5 rounded-md font-medium bg-gradient-to-r from-emerald-100/90 via-teal-50/90 to-emerald-100/90 dark:from-emerald-950/75 dark:via-teal-950/60 dark:to-emerald-950/75 text-emerald-900 dark:text-emerald-100 border border-emerald-300/80 dark:border-emerald-700/70"
        >
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            parentDir={parentDir}
          />
        </span>
      );
    } else if (token.startsWith('@@') && token.endsWith('@@') && token.length > 4) {
      nodes.push(
        <span
          key={k}
          className="rich-concept-chip px-1.5 py-0.5 mx-0.5 rounded-md font-medium bg-sky-100/85 dark:bg-sky-950/70 text-sky-900 dark:text-sky-100 border border-sky-300/80 dark:border-sky-700/75 shadow-2xs"
        >
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            parentDir={parentDir}
          />
        </span>
      );
    } else if (token.startsWith('^^') && token.endsWith('^^') && token.length > 4) {
      nodes.push(
        <PathwaySpan
          key={k}
          text={token.slice(2, -2)}
          variant={variant}
          depth={depth}
          parentDir={parentDir ?? detectDominantDirection(text)}
        />
      );
    } else if (token.startsWith('%%') && token.endsWith('%%') && token.length > 4) {
      nodes.push(
        <ClozeSpan
          key={k}
          text={token.slice(2, -2)}
          variant={variant}
          depth={depth}
          parentDir={parentDir}
        />
      );
    } else if (token.startsWith('~~') && token.endsWith('~~') && token.length > 4) {
      nodes.push(
        <del key={k} className="line-through opacity-70 decoration-rose-500/80">
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            parentDir={parentDir}
          />
        </del>
      );
    } else if (token.startsWith('__') && token.endsWith('__') && token.length > 4) {
      nodes.push(
        <span
          key={k}
          className="underline decoration-2 underline-offset-4 decoration-sky-500/75"
        >
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            parentDir={parentDir}
          />
        </span>
      );
    } else if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      nodes.push(
        <strong key={k} className="font-semibold text-slate-950 dark:text-white">
          <RichInlineText
            text={token.slice(2, -2)}
            variant={variant}
            depth={depth + 1}
            parentDir={parentDir}
          />
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      nodes.push(
        <em key={k} className="italic">
          <RichInlineText
            text={token.slice(1, -1)}
            variant={variant}
            depth={depth + 1}
            parentDir={parentDir}
          />
        </em>
      );
    } else {
      nodes.push(token);
    }

    remaining = remaining.slice(match.index + token.length);
  }

  return <>{nodes}</>;
}

type CalloutKind = 'key' | 'tip' | 'trap' | 'example' | 'process' | 'vocab' | 'compare';

const CALLOUT_CONFIG: Record<
  CalloutKind,
  {
    title: string;
    icon: typeof Lightbulb;
    wrapperClass: string;
    iconBoxClass: string;
    titleClass: string;
    topBarClass: string;
  }
> = {
  key: {
    title: 'Key Point',
    icon: Lightbulb,
    wrapperClass:
      'border-sky-200/90 dark:border-sky-800/80 bg-gradient-to-br from-sky-50/85 via-white to-sky-50/40 dark:from-sky-950/45 dark:via-slate-900 dark:to-sky-950/20 text-slate-900 dark:text-slate-100',
    iconBoxClass:
      'bg-sky-100/90 dark:bg-sky-900/70 text-sky-600 dark:text-sky-300 border-sky-200/90 dark:border-sky-700/70',
    titleClass: 'text-sky-700 dark:text-sky-300',
    topBarClass: 'from-sky-400 via-cyan-400 to-transparent',
  },
  tip: {
    title: 'Study Tip',
    icon: Sparkles,
    wrapperClass:
      'border-emerald-200/90 dark:border-emerald-800/80 bg-gradient-to-br from-emerald-50/85 via-white to-teal-50/40 dark:from-emerald-950/45 dark:via-slate-900 dark:to-teal-950/20 text-slate-900 dark:text-slate-100',
    iconBoxClass:
      'bg-emerald-100/90 dark:bg-emerald-900/70 text-emerald-600 dark:text-emerald-300 border-emerald-200/90 dark:border-emerald-700/70',
    titleClass: 'text-emerald-700 dark:text-emerald-300',
    topBarClass: 'from-emerald-400 via-teal-400 to-transparent',
  },
  trap: {
    title: 'Watch Out',
    icon: AlertTriangle,
    wrapperClass:
      'border-rose-200/90 dark:border-rose-800/80 bg-gradient-to-br from-rose-50/85 via-white to-amber-50/35 dark:from-rose-950/45 dark:via-slate-900 dark:to-rose-950/20 text-slate-900 dark:text-slate-100',
    iconBoxClass:
      'bg-rose-100/90 dark:bg-rose-900/70 text-rose-600 dark:text-rose-300 border-rose-200/90 dark:border-rose-700/70',
    titleClass: 'text-rose-700 dark:text-rose-300',
    topBarClass: 'from-rose-400 via-amber-400 to-transparent',
  },
  example: {
    title: 'Example',
    icon: FlaskConical,
    wrapperClass:
      'border-indigo-200/90 dark:border-indigo-800/80 bg-gradient-to-br from-indigo-50/85 via-white to-sky-50/40 dark:from-indigo-950/45 dark:via-slate-900 dark:to-indigo-950/20 text-slate-900 dark:text-slate-100',
    iconBoxClass:
      'bg-indigo-100/90 dark:bg-indigo-900/70 text-indigo-600 dark:text-indigo-300 border-indigo-200/90 dark:border-indigo-700/70',
    titleClass: 'text-indigo-700 dark:text-indigo-300',
    topBarClass: 'from-indigo-400 via-sky-400 to-transparent',
  },
  vocab: {
    title: 'Terminology',
    icon: BookMarked,
    wrapperClass:
      'border-amber-200/90 dark:border-amber-800/80 bg-gradient-to-br from-amber-50/80 via-white to-orange-50/35 dark:from-amber-950/40 dark:via-slate-900 dark:to-amber-950/20 text-slate-900 dark:text-slate-100',
    iconBoxClass:
      'bg-amber-100/90 dark:bg-amber-900/70 text-amber-700 dark:text-amber-300 border-amber-200/90 dark:border-amber-700/70',
    titleClass: 'text-amber-800 dark:text-amber-300',
    topBarClass: 'from-amber-400 via-orange-300 to-transparent',
  },
  process: {
    title: 'Sequence',
    icon: ListChecks,
    wrapperClass:
      'border-cyan-200/90 dark:border-cyan-800/80 bg-gradient-to-br from-cyan-50/80 via-white to-sky-50/40 dark:from-cyan-950/40 dark:via-slate-900 dark:to-sky-950/20 text-slate-900 dark:text-slate-100',
    iconBoxClass:
      'bg-cyan-100/90 dark:bg-cyan-900/70 text-cyan-700 dark:text-cyan-300 border-cyan-200/90 dark:border-cyan-700/70',
    titleClass: 'text-cyan-700 dark:text-cyan-300',
    topBarClass: 'from-cyan-400 via-sky-400 to-transparent',
  },
  compare: {
    title: 'Comparison',
    icon: GitCompare,
    wrapperClass:
      'border-violet-200/90 dark:border-violet-800/80 bg-gradient-to-br from-violet-50/80 via-white to-sky-50/35 dark:from-violet-950/40 dark:via-slate-900 dark:to-slate-900 text-slate-900 dark:text-slate-100',
    iconBoxClass:
      'bg-violet-100/90 dark:bg-violet-900/70 text-violet-700 dark:text-violet-300 border-violet-200/90 dark:border-violet-700/70',
    titleClass: 'text-violet-700 dark:text-violet-300',
    topBarClass: 'from-violet-400 via-indigo-400 to-transparent',
  },
};

function mapCalloutTag(rawTag: string): CalloutKind {
  const upper = rawTag.toUpperCase();
  if (upper === 'TIP') return 'tip';
  if (upper === 'TRAP' || upper === 'WARNING' || upper === 'CAUTION' || upper === 'IMPORTANT') {
    return 'trap';
  }
  if (upper === 'EXAMPLE') return 'example';
  if (upper === 'PROCESS' || upper === 'STEPS' || upper === 'FLOW') return 'process';
  if (upper === 'VOCAB' || upper === 'TERM' || upper === 'ETYMOLOGY' || upper === 'WORDS') {
    return 'vocab';
  }
  if (upper === 'COMPARE' || upper === 'VS' || upper === 'CONTRAST') return 'compare';
  return 'key';
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  return (
    /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(trimmed) ||
    /^\|(\s*:?-{3,}:?\s*\|)+$/.test(trimmed)
  );
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function RichTextBlock({
  content,
  variant = 'assistant',
  bookPage = false,
  quoteDepth = 0,
}: {
  content: string;
  variant?: MessageVariant;
  bookPage?: boolean;
  quoteDepth?: number;
}) {

  const lines = content.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let lastBlockType: 'boxed' | 'heading' | 'hr' | 'prose' | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line
    if (!trimmed) {
      i++;
      continue;
    }

    // Display math block $$...$$ or \[...\]
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      const isBracket = trimmed.startsWith('\\[');
      const closeDelim = isBracket ? '\\]' : '$$';
      const openLen = 2;

      if (trimmed.length > 4 && trimmed.endsWith(closeDelim)) {
        blocks.push(
          <MathSpan
            key={`dm_${i}`}
            expr={trimmed.slice(openLen, -2)}
            displayMode
            variant={variant}
          />
        );
        lastBlockType = 'boxed';
        i++;
        continue;
      }

      const mathLines: string[] = [trimmed.slice(openLen)];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const nextLine = lines[j];
        const closeIdx = nextLine.indexOf(closeDelim);
        if (closeIdx !== -1) {
          mathLines.push(nextLine.slice(0, closeIdx));
          closed = true;
          j++;
          break;
        }
        mathLines.push(nextLine);
        j++;
      }

      if (closed) {
        blocks.push(
          <MathSpan
            key={`dm_${i}`}
            expr={mathLines.join('\n')}
            displayMode
            variant={variant}
          />
        );
        lastBlockType = 'boxed';
        i = j;
        continue;
      }
    }

    // Horizontal rule — omit when adjacent to boxed blocks (callouts/quotes/tables/h1) or headings
    // so cards never get a stray line rendered directly beneath them.
    if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
      let nextTrimmed = '';
      for (let k = i + 1; k < lines.length; k++) {
        const candidate = lines[k].trim();
        if (candidate) {
          nextTrimmed = candidate;
          break;
        }
      }
      const nextIsStructural =
        !nextTrimmed ||
        /^#{1,6}\s+/.test(nextTrimmed) ||
        /^>/.test(nextTrimmed) ||
        /^(?:---+|\*\*\*+|___+)$/.test(nextTrimmed) ||
        nextTrimmed.startsWith('$$') ||
        nextTrimmed.startsWith('\\[');

      const suppressHr =
        lastBlockType === null ||
        lastBlockType === 'boxed' ||
        lastBlockType === 'heading' ||
        lastBlockType === 'hr' ||
        nextIsStructural;

      if (!suppressHr) {
        blocks.push(
          <div
            key={`hr_${i}`}
            className="my-3 h-px w-full bg-slate-200/75 dark:bg-slate-800/80"
          />
        );
        lastBlockType = 'hr';
      }
      i++;
      continue;
    }

    // Headings (#, ##, ###, ####, #####, ######)
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const headingDir = detectBaseDirection(text);

      if (level === 1) {
        blocks.push(
          <div
            key={`h_${i}`}
            dir={headingDir}
            className={`rich-block-enter ${bookPage ? 'pt-1.5 pb-2' : 'pt-1 pb-1.5'}`}
          >
            <InteractiveTitleFrame bookPage={bookPage}>
              <h1
                className={`relative z-10 bidi-plaintext font-display font-bold tracking-tight text-slate-950 dark:text-white text-balance ${
                  bookPage ? 'text-[20px] sm:text-[22px] leading-snug' : 'text-lg sm:text-xl leading-snug'
                }`}
              >
                <RichInlineText
                  text={text}
                  variant={variant}
                  parentDir={headingDir}
                />
              </h1>
            </InteractiveTitleFrame>
          </div>
        );
      } else if (level === 2) {
        blocks.push(
          <div
            key={`h_${i}`}
            dir={headingDir}
            className={`rich-block-enter ${bookPage ? 'pt-2.5 pb-0.5' : 'pt-2 pb-0.5'}`}
          >
            <h2
              className={`bidi-plaintext font-display font-bold tracking-tight text-slate-950 dark:text-white text-balance ${
                bookPage ? 'text-[17.5px] leading-snug' : 'text-[17px] leading-snug'
              }`}
            >
              <RichInlineText
                text={text}
                variant={variant}
                parentDir={headingDir}
              />
            </h2>
            <div
              aria-hidden="true"
              className={`rich-heading-bar mt-1.5 h-[2px] w-24 rounded-full ${
                headingDir === 'rtl'
                  ? 'bg-gradient-to-l from-sky-500/80 via-indigo-400/55 to-transparent'
                  : 'bg-gradient-to-r from-sky-500/80 via-indigo-400/55 to-transparent'
              }`}
            />
          </div>
        );
      } else if (level === 3) {
        blocks.push(
          <h3
            key={`h_${i}`}
            dir={headingDir}
            className={`rich-block-enter flex items-center gap-2 font-display font-semibold text-slate-900 dark:text-slate-100 text-balance ${
              bookPage ? 'pt-1.5 text-[15.5px]' : 'pt-1 text-[15px]'
            }`}
          >
            <span
              aria-hidden="true"
              className="w-2 h-2 rounded-[2px] rotate-45 bg-sky-500 dark:bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.45)] shrink-0"
            />
            <span className="bidi-plaintext flex-1 min-w-0">
              <RichInlineText
                text={text}
                variant={variant}
                parentDir={headingDir}
              />
            </span>
          </h3>
        );
      } else {
        blocks.push(
          <h4
            key={`h_${i}`}
            dir={headingDir}
            className={`rich-block-enter bidi-plaintext font-display font-semibold text-slate-700 dark:text-slate-200 ${
              bookPage ? 'text-[14.5px]' : 'text-sm'
            }`}
          >
            <RichInlineText
              text={text}
              variant={variant}
              parentDir={headingDir}
            />
          </h4>
        );
      }
      lastBlockType = level === 1 ? 'boxed' : 'heading';
      i++;
      continue;
    }

    // Markdown table
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      const tableDir = detectBaseDirection(headers.join(' '));
      blocks.push(
        <div
          key={`tbl_${i}`}
          dir={tableDir}
          className="rich-block-enter my-2 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/50 shadow-2xs"
        >
          <table className="w-full border-collapse text-xs sm:text-[13px] tabular-nums">
            <thead>
              <tr className="bg-gradient-to-r from-slate-100/95 via-sky-50/60 to-slate-100/95 dark:from-slate-800/90 dark:via-sky-950/35 dark:to-slate-800/90 border-b border-slate-200 dark:border-slate-700">
                {headers.map((h, hIdx) => (
                  <th
                    key={hIdx}
                    dir={detectDominantDirection(h, tableDir)}
                    className="bidi-plaintext px-3.5 py-2.5 font-semibold text-start text-slate-900 dark:text-slate-100"
                  >
                    <RichInlineText
                      text={h}
                      variant={variant}
                      parentDir={detectDominantDirection(h, tableDir)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/75 dark:divide-slate-800/80">
              {rows.map((row, rIdx) => (
                <tr
                  key={rIdx}
                  className="transition-colors hover:bg-sky-50/45 dark:hover:bg-sky-950/25"
                >
                  {headers.map((_, cIdx) => {
                    const cellText = row[cIdx] ?? '';
                    const cellDir = detectDominantDirection(cellText, tableDir);
                    return (
                      <td
                        key={cIdx}
                        dir={cellDir}
                        className="bidi-plaintext px-3.5 py-2 align-top text-start text-slate-700 dark:text-slate-300"
                      >
                        <RichInlineText
                          text={cellText}
                          variant={variant}
                          parentDir={cellDir}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      lastBlockType = 'boxed';
      i = j;
      continue;
    }

    // Blockquote or Kinetic Study Callout (> [!KEY], [!TIP], [!TRAP], [!EXAMPLE], [!PROCESS], [!VOCAB], [!COMPARE])
    if (trimmed.startsWith('>') && quoteDepth < 3) {
      const quoteLines: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith('>')) {
        quoteLines.push(lines[j].trim().replace(/^>\s?/, ''));
        j++;
      }

      const first = quoteLines[0] || '';
      const calloutMatch = first.match(
        /^\[!(KEY|NOTE|TIP|TRAP|WARNING|CAUTION|IMPORTANT|EXAMPLE|PROCESS|STEPS|FLOW|VOCAB|TERM|ETYMOLOGY|WORDS|COMPARE|VS|CONTRAST)\]\s*(.*)$/i
      );

      if (calloutMatch && variant === 'assistant') {
        const kind = mapCalloutTag(calloutMatch[1]);
        const cfg = CALLOUT_CONFIG[kind];
        const Icon = cfg.icon;
        const bodyLines = [calloutMatch[2], ...quoteLines.slice(1)].filter(
          (l, idx) => idx > 0 || l.trim().length > 0
        );
        const calloutDir = detectBaseDirection(bodyLines.join(' '));
        const nonEmptyLines = bodyLines.filter((l) => l.trim().length > 0);

        const renderCalloutBody = () => {
          if (kind === 'process' && nonEmptyLines.length > 0) {
            const steps = nonEmptyLines.map((rawLine) => {
              const stripped = rawLine
                .trim()
                .replace(/^(?:[-*•]|[0-9۰-۹٠-٩]+[.)])\s+/, '');
              return stripped;
            });
            return (
              <div className="relative space-y-2.5 pt-1">
                {steps.map((stepText, sIdx) => (
                  <div
                    key={sIdx}
                    style={{ '--stagger-idx': sIdx } as CSSProperties}
                    className="rich-block-enter relative flex items-start gap-2.5"
                  >
                    <div className="relative flex flex-col items-center shrink-0">
                      <span className="w-5 h-5 rounded-full bg-white dark:bg-slate-900 border border-cyan-400/80 dark:border-cyan-600/80 text-[11px] font-semibold tabular-nums text-cyan-700 dark:text-cyan-300 inline-flex items-center justify-center shadow-2xs z-10">
                        {sIdx + 1}
                      </span>
                      {sIdx < steps.length - 1 ? (
                        <span
                          aria-hidden="true"
                          className="w-px h-4 bg-gradient-to-b from-cyan-400/70 to-transparent mt-0.5"
                        />
                      ) : null}
                    </div>
                    <p dir={detectDominantDirection(stepText, calloutDir)} className="bidi-plaintext text-sm leading-relaxed flex-1 min-w-0">
                      <RichInlineText
                        text={stepText}
                        variant={variant}
                        parentDir={detectDominantDirection(stepText, calloutDir)}
                      />
                    </p>
                  </div>
                ))}
              </div>
            );
          }

          if (kind === 'compare' && nonEmptyLines.some((l) => l.includes('||'))) {
            const pairs = nonEmptyLines.map((l) => {
              const clean = l.trim().replace(/^[-*•]\s+/, '');
              const splitIdx = clean.indexOf('||');
              if (splitIdx === -1) return { left: clean, right: '' };
              return {
                left: clean.slice(0, splitIdx).trim(),
                right: clean.slice(splitIdx + 2).trim(),
              };
            });
            return (
              <div className="space-y-2 pt-0.5">
                {pairs.map((pair, pIdx) => (
                  <div
                    key={pIdx}
                    style={{ '--stagger-idx': pIdx } as CSSProperties}
                    className="rich-block-enter grid grid-cols-1 sm:grid-cols-2 gap-2"
                  >
                    <div
                      dir={detectDominantDirection(pair.left, calloutDir)}
                      className="bidi-plaintext rounded-lg border border-violet-200/75 dark:border-violet-800/60 bg-white/80 dark:bg-slate-900/70 px-3 py-2 text-xs sm:text-sm leading-relaxed"
                    >
                      <RichInlineText
                        text={pair.left}
                        variant={variant}
                        parentDir={detectDominantDirection(pair.left, calloutDir)}
                      />
                    </div>
                    {pair.right ? (
                      <div
                        dir={detectDominantDirection(pair.right, calloutDir)}
                        className="bidi-plaintext rounded-lg border border-sky-200/75 dark:border-sky-800/60 bg-white/80 dark:bg-slate-900/70 px-3 py-2 text-xs sm:text-sm leading-relaxed"
                      >
                        <RichInlineText
                          text={pair.right}
                          variant={variant}
                          parentDir={detectDominantDirection(pair.right, calloutDir)}
                        />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            );
          }

          return (
            <div className="text-sm leading-relaxed">
              <RichTextBlock
                content={bodyLines.join('\n')}
                variant={variant}
                bookPage={bookPage}
                quoteDepth={quoteDepth + 1}
              />
            </div>
          );
        };

        blocks.push(
          <div
            key={`call_${i}`}
            dir={calloutDir}
            className={`rich-block-enter rich-callout-card relative overflow-hidden my-2 rounded-xl border px-4 py-3 space-y-2 shadow-2xs ${cfg.wrapperClass}`}
          >
            <div
              aria-hidden="true"
              className={`absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r ${cfg.topBarClass} ${
                calloutDir === 'rtl' ? 'bg-gradient-to-l' : ''
              }`}
            />
            <div className={`flex items-center gap-2 text-xs font-semibold ${cfg.titleClass}`}>
              <span
                className={`w-6 h-6 rounded-lg border inline-flex items-center justify-center shrink-0 ${cfg.iconBoxClass}`}
              >
                <Icon className="w-3.5 h-3.5" />
              </span>
              <span>{cfg.title}</span>
            </div>
            {renderCalloutBody()}
          </div>
        );
      } else {
        const quoteDir = detectBaseDirection(quoteLines.join(' '));
        blocks.push(
          <blockquote
            key={`q_${i}`}
            dir={quoteDir}
            className={
              bookPage
                ? 'rich-block-enter my-2 rounded-xl border border-slate-200/90 dark:border-slate-700/80 border-s-[3.5px] border-s-sky-500 dark:border-s-sky-400 bg-slate-50/85 dark:bg-slate-800/45 px-4 py-3 space-y-1.5 text-[14.5px] leading-[1.75] text-slate-800 dark:text-slate-200'
                : 'rich-block-enter my-2 rounded-xl border border-slate-200/90 dark:border-slate-700/80 bg-slate-50/75 dark:bg-slate-900/50 px-4 py-3 space-y-1.5 text-slate-700 dark:text-slate-300'
            }
          >
            <div className="flex items-start gap-2.5">
              {!bookPage ? (
                <Quote
                  aria-hidden="true"
                  className="w-3.5 h-3.5 mt-1 text-sky-500/80 dark:text-sky-400/80 shrink-0"
                />
              ) : null}
              <div className="flex-1 min-w-0">
                <RichTextBlock
                  content={quoteLines.join('\n')}
                  variant={variant}
                  bookPage={bookPage}
                  quoteDepth={quoteDepth + 1}
                />
              </div>
            </div>
          </blockquote>
        );
      }
      lastBlockType = 'boxed';
      i = j;
      continue;
    }

    // Unordered list (- item or * item or • item)
    const ulMatch = line.match(/^\s*[-*•]\s+(.+)$/);
    if (ulMatch) {
      const items: string[] = [];
      let j = i;
      while (j < lines.length) {
        const m = lines[j].match(/^\s*[-*•]\s+(.+)$/);
        if (!m) break;
        items.push(m[1]);
        j++;
      }
      const listDir = detectBaseDirection(items.join(' '));
      blocks.push(
        <ul key={`ul_${i}`} dir={listDir} className="space-y-1.5 py-0.5">
          {items.map((item, idx) => {
            const itemDir = detectDominantDirection(item, listDir);
            return (
              <li
                key={idx}
                style={{ '--stagger-idx': idx } as CSSProperties}
                className="rich-block-enter flex items-start gap-2.5 rounded-md px-1.5 py-0.5 -mx-1.5 transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/35"
              >
                <span
                  aria-hidden="true"
                  className="w-1.5 h-1.5 rounded-[1.5px] rotate-45 bg-sky-500/85 dark:bg-sky-400/85 mt-[0.58em] shrink-0"
                />
                <div dir={itemDir} className="bidi-plaintext flex-1 min-w-0">
                  <RichInlineText
                    text={item}
                    variant={variant}
                    parentDir={itemDir}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      );
      lastBlockType = 'prose';
      i = j;
      continue;
    }

    // Ordered list (1. item or ۱) item)
    const olMatch = line.match(/^\s*([0-9۰-۹٠-٩]+)[.)]\s+(.+)$/);
    if (olMatch) {
      const items: Array<{ marker: string; text: string }> = [];
      let j = i;
      while (j < lines.length) {
        const m = lines[j].match(/^\s*([0-9۰-۹٠-٩]+)[.)]\s+(.+)$/);
        if (!m) break;
        items.push({ marker: m[1], text: m[2] });
        j++;
      }
      const listDir = detectBaseDirection(items.map((x) => x.text).join(' '));
      blocks.push(
        <ol key={`ol_${i}`} dir={listDir} className="space-y-2 py-0.5">
          {items.map((item, idx) => {
            const itemDir = detectDominantDirection(item.text, listDir);
            return (
              <li
                key={idx}
                style={{ '--stagger-idx': idx } as CSSProperties}
                className="rich-block-enter flex items-start gap-2.5 rounded-md px-1.5 py-0.5 -mx-1.5 transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/35"
              >
                <span className="shrink-0 min-w-[1.45rem] h-[1.45rem] px-1 mt-0.5 rounded-md bg-sky-50 dark:bg-sky-950/60 border border-sky-200/85 dark:border-sky-800/75 text-xs font-semibold tabular-nums text-sky-700 dark:text-sky-300 inline-flex items-center justify-center">
                  {item.marker}
                </span>
                <div dir={itemDir} className="bidi-plaintext flex-1 min-w-0">
                  <RichInlineText
                    text={item.text}
                    variant={variant}
                    parentDir={itemDir}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      );
      lastBlockType = 'prose';
      i = j;
      continue;
    }

    // Skip standalone legacy textbook image marker line(s), e.g. "[[IMG-1]]"
    if (/^(?:\[\[\s*IMG[-_\s]?\d+\s*\]\]\s*)+$/i.test(trimmed)) {
      i++;
      continue;
    }

    // Regular paragraph line
    const paraDir = detectDominantDirection(line);
    blocks.push(
      <p key={`p_${i}`} dir={paraDir} className="rich-block-enter bidi-plaintext whitespace-pre-wrap">
        <RichInlineText
          text={line}
          variant={variant}
          parentDir={paraDir}
        />
      </p>
    );
    lastBlockType = 'prose';
    i++;
  }

  return <div className="space-y-2">{blocks}</div>;
}

export function RichMessage({
  content,
  variant = 'assistant',
  bookPage = false,
}: {
  content: string;
  variant?: MessageVariant;
  bookPage?: boolean;
}) {
  const segments = useMemo(() => parseMessageSegments(content), [content]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  return (
    <div
      className={
        bookPage
          ? 'space-y-3.5 text-[15.5px] leading-[1.82] text-slate-800 dark:text-slate-200 break-words'
          : 'space-y-3 text-[15px] leading-relaxed break-words'
      }
    >
      {segments.map((seg, idx) => {
        if (seg.type === 'code') {
          return (
            <div
              key={idx}
              dir="ltr"
              className="rich-block-enter text-left rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-900 dark:bg-slate-950 text-slate-100 overflow-hidden shadow-2xs"
            >
              <div className="px-3 py-1.5 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
                <span className="font-mono">{seg.language || 'code'}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard?.writeText(seg.content);
                    setCopiedIdx(idx);
                    setTimeout(() => setCopiedIdx(null), 1400);
                  }}
                  aria-label="Copy code block"
                  className="inline-flex items-center gap-1 hover:text-slate-200 transition-colors"
                >
                  {copiedIdx === idx ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>{copiedIdx === idx ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="p-3 overflow-x-auto text-xs leading-relaxed font-mono">
                <code>{seg.content}</code>
              </pre>
            </div>
          );
        }

        return (
          <RichTextBlock
            key={idx}
            content={seg.content}
            variant={variant}
            bookPage={bookPage}
          />
        );
      })}
    </div>
  );
}
