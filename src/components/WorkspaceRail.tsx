import { useEffect, useRef, useState } from 'react';
import {
  Brain,
  ChevronDown,
  Gauge,
  Globe,
  Menu,
  Settings,
} from 'lucide-react';
import type { GeminiModel, ThinkingLevel } from '../types/talk';
import type { TokenBudgetMetrics } from '../hooks/useTokenBudgetMetrics';
import {
  normalizeThinkingLevelForModel,
  supportsXhighThinking,
} from '../utils/formatters';

interface WorkspaceRailProps {
  showSessionButton: boolean;
  onOpenSessionDrawer: () => void;
  webSearchArmed: boolean;
  onToggleWebSearch: () => void;
  geminiModel: GeminiModel;
  thinkingLevel: ThinkingLevel;
  onSelectThinkingLevel: (level: ThinkingLevel) => void;
  tokenMetrics: TokenBudgetMetrics;
  onOpenSettings: () => void;
}

const THINKING_OPTIONS: Array<{ id: ThinkingLevel; label: string; description: string }> = [
  { id: 'low', label: 'Low', description: 'Fastest responses' },
  { id: 'medium', label: 'Medium', description: 'Balanced reasoning' },
  { id: 'high', label: 'High', description: 'Deep reasoning' },
  { id: 'xhigh', label: 'XHigh', description: 'Maximum reasoning depth' },
];

const THINKING_LABEL: Record<ThinkingLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

export function WorkspaceRail({
  showSessionButton,
  onOpenSessionDrawer,
  webSearchArmed,
  onToggleWebSearch,
  geminiModel,
  thinkingLevel,
  onSelectThinkingLevel,
  tokenMetrics,
  onOpenSettings,
}: WorkspaceRailProps) {
  const [isThinkingOpen, setIsThinkingOpen] = useState(false);
  const [isTokensOpen, setIsTokensOpen] = useState(false);
  const [isTokenBreakdownOpen, setIsTokenBreakdownOpen] = useState(false);
  const thinkingContainerRef = useRef<HTMLDivElement>(null);
  const tokensContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isThinkingOpen && !isTokensOpen) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        isThinkingOpen &&
        thinkingContainerRef.current &&
        !thinkingContainerRef.current.contains(target)
      ) {
        setIsThinkingOpen(false);
      }
      if (
        isTokensOpen &&
        tokensContainerRef.current &&
        !tokensContainerRef.current.contains(target)
      ) {
        setIsTokensOpen(false);
        setIsTokenBreakdownOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsThinkingOpen(false);
        setIsTokensOpen(false);
        setIsTokenBreakdownOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isThinkingOpen, isTokensOpen]);

  const supportsXhigh = supportsXhighThinking(geminiModel);
  const effectiveThinkingLevel = normalizeThinkingLevelForModel(thinkingLevel, geminiModel);
  const availableThinkingOptions = supportsXhigh
    ? THINKING_OPTIONS
    : THINKING_OPTIONS.filter((option) => option.id !== 'xhigh');
  const isElevatedThinking =
    effectiveThinkingLevel === 'high' || effectiveThinkingLevel === 'xhigh';

  const {
    displayTotalTokens,
    maxTokens,
    usagePct,
    isSyncingTokens,
    isExactCount,
    effectiveDraftTokens,
    tokenBreakdown,
    lastReplyUsage,
    webSearchArmed: metricsWebSearchArmed,
  } = tokenMetrics;

  const isHighUsage = usagePct >= 85;
  const isMediumUsage = usagePct >= 60 && usagePct < 85;

  const tokenExpanderBorderClass = isHighUsage
    ? 'border-rose-300 dark:border-rose-700 bg-rose-50/95 dark:bg-rose-950/85 text-rose-700 dark:text-rose-300'
    : isMediumUsage
    ? 'border-amber-300 dark:border-amber-700 bg-amber-50/95 dark:bg-amber-950/85 text-amber-800 dark:text-amber-300'
    : isTokensOpen
    ? 'border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 text-slate-800 dark:text-slate-100'
    : 'border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 text-slate-600 dark:text-slate-300';

  return (
    <div className="absolute top-3 left-3 z-30 flex flex-col items-center gap-1.5 select-none">
      {showSessionButton ? (
        <button
          type="button"
          onClick={onOpenSessionDrawer}
          aria-label="Open Chat Manager"
          aria-expanded={false}
          title="Chat Manager"
          className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs shadow-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-sky-600"
        >
          <Menu className="w-4 h-4" />
        </button>
      ) : null}

      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="Open Settings"
        title="Settings"
        className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs shadow-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-sky-600"
      >
        <Settings className="w-4 h-4" />
      </button>

      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={onToggleWebSearch}
          aria-label="Web search"
          aria-pressed={webSearchArmed}
          title="Toggle Tavily web search for next message"
          className={`h-9 w-9 inline-flex items-center justify-center rounded-lg border backdrop-blur-xs shadow-xs transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-sky-600 ${
            webSearchArmed
              ? 'bg-sky-50 dark:bg-sky-950/80 border-sky-300 dark:border-sky-700 text-sky-700 dark:text-sky-300'
              : 'border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Globe className="w-4 h-4" />
        </button>

        {/* Thinking Depth Expander */}
        <div ref={thinkingContainerRef} className="relative h-9 w-9 shrink-0">
          <div
            data-testid="thinking-expander"
            data-expanded={isThinkingOpen ? 'true' : 'false'}
            className={`absolute left-0 top-0 z-40 h-9 w-max inline-flex items-center rounded-lg border backdrop-blur-xs overflow-hidden transition-all duration-200 ease-out origin-left ${
              isThinkingOpen
                ? 'border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 shadow-md pr-1.5'
                : isElevatedThinking
                ? 'bg-sky-50 dark:bg-sky-950/80 border-sky-300 dark:border-sky-700 shadow-xs'
                : 'border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 shadow-xs'
            }`}
          >
            <button
              type="button"
              onClick={() => {
                setIsTokensOpen(false);
                setIsTokenBreakdownOpen(false);
                setIsThinkingOpen((prev) => !prev);
              }}
              aria-label={`Thinking: ${THINKING_LABEL[effectiveThinkingLevel]}`}
              aria-expanded={isThinkingOpen}
              title={`Thinking: ${THINKING_LABEL[effectiveThinkingLevel]}`}
              className={`h-full w-[34px] inline-flex items-center justify-center shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-sky-600 ${
                isElevatedThinking
                  ? 'text-sky-700 dark:text-sky-300 hover:bg-sky-100/70 dark:hover:bg-sky-900/50'
                  : effectiveThinkingLevel === 'low'
                  ? 'text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-300'
                  : 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Brain className="w-4 h-4" />
            </button>

            <div
              role="radiogroup"
              aria-label="Thinking depth"
              aria-hidden={!isThinkingOpen}
              className={`grid transition-[grid-template-columns,opacity,visibility] duration-200 ease-out ${
                isThinkingOpen
                  ? 'grid-cols-[1fr] opacity-100 visible'
                  : 'grid-cols-[0fr] opacity-0 invisible pointer-events-none'
              }`}
            >
              <div className="min-w-0 overflow-hidden flex items-center gap-0.5 whitespace-nowrap">
                <span className="h-4 w-px bg-slate-200 dark:bg-slate-700 mr-1 shrink-0" />
                {availableThinkingOptions.map((option) => {
                  const selected = effectiveThinkingLevel === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={isThinkingOpen ? 0 : -1}
                      title={option.description}
                      onClick={() => {
                        onSelectThinkingLevel(option.id);
                        setIsThinkingOpen(false);
                      }}
                      className={`h-7 px-2 rounded-md text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-sky-600 ${
                        selected
                          ? 'bg-sky-600 text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Tokens Expander (directly beneath Thinking button, matching shape & smooth horizontal growth) */}
        <div ref={tokensContainerRef} className="relative h-9 w-9 shrink-0">
          <div
            data-testid="tokens-expander"
            data-expanded={isTokensOpen ? 'true' : 'false'}
            className={`absolute left-0 top-0 z-40 h-9 w-max inline-flex items-center rounded-lg border backdrop-blur-xs overflow-hidden transition-all duration-200 ease-out origin-left ${tokenExpanderBorderClass} ${
              isTokensOpen ? 'shadow-md pr-1.5' : 'shadow-xs'
            }`}
          >
            <button
              type="button"
              onClick={() => {
                setIsThinkingOpen(false);
                setIsTokensOpen((prev) => {
                  const next = !prev;
                  if (!next) setIsTokenBreakdownOpen(false);
                  return next;
                });
              }}
              aria-label={`Tokens: ${displayTotalTokens.toLocaleString()} / ${maxTokens.toLocaleString()}`}
              aria-expanded={isTokensOpen}
              title={`Token budget: ${displayTotalTokens.toLocaleString()} / ${maxTokens.toLocaleString()}`}
              className={`h-full w-[34px] inline-flex items-center justify-center shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-sky-600 ${
                isHighUsage
                  ? 'text-rose-700 dark:text-rose-300 hover:bg-rose-100/70 dark:hover:bg-rose-900/50'
                  : isMediumUsage
                  ? 'text-amber-700 dark:text-amber-300 hover:bg-amber-100/70 dark:hover:bg-amber-900/50'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Gauge className="w-4 h-4" />
            </button>

            <div
              aria-hidden={!isTokensOpen}
              className={`grid transition-[grid-template-columns,opacity,visibility] duration-200 ease-out ${
                isTokensOpen
                  ? 'grid-cols-[1fr] opacity-100 visible'
                  : 'grid-cols-[0fr] opacity-0 invisible pointer-events-none'
              }`}
            >
              <div className="min-w-0 overflow-hidden flex items-center gap-1.5 whitespace-nowrap">
                <span className="h-4 w-px bg-slate-200 dark:bg-slate-700 shrink-0" />
                <button
                  type="button"
                  tabIndex={isTokensOpen ? 0 : -1}
                  onClick={() => setIsTokenBreakdownOpen((v) => !v)}
                  aria-expanded={isTokenBreakdownOpen}
                  title="Show detailed token breakdown"
                  className="h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-xs font-medium tabular-nums hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus-visible:outline-2 focus-visible:outline-sky-600"
                >
                  <span>
                    {displayTotalTokens.toLocaleString()} / {maxTokens.toLocaleString()}
                  </span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-150 ${
                      isTokenBreakdownOpen ? 'rotate-180 text-sky-500' : ''
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {isTokensOpen && isTokenBreakdownOpen ? (
            <div
              role="dialog"
              aria-label="Next request token breakdown"
              className="absolute left-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-3.5 text-xs space-y-2.5 z-50"
            >
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-200 dark:border-slate-800">
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  Next Message Token Load
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {isSyncingTokens
                    ? 'Syncing…'
                    : isExactCount
                    ? 'Exact Gemini count'
                    : 'Live estimate'}
                </span>
              </div>

              <div className="space-y-1.5 text-slate-600 dark:text-slate-300 tabular-nums">
                <div className="flex items-center justify-between gap-2">
                  <span>System Prompt</span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {tokenBreakdown.systemAndLearnerTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Memory Packs ({tokenBreakdown.packCount})</span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {tokenBreakdown.memoryPacksTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>
                    Active Chat ({tokenBreakdown.historyMessageCount} msgs
                    {tokenBreakdown.historyImageCount > 0
                      ? `, ${tokenBreakdown.historyImageCount} img`
                      : ''}
                    )
                  </span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {tokenBreakdown.historyMessagesTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Notes</span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {tokenBreakdown.notesTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>
                    Textbook (text
                    {tokenBreakdown.textbookImageCount > 0
                      ? ` + ${tokenBreakdown.textbookImageCount} img`
                      : ''}
                    )
                  </span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {(
                      tokenBreakdown.textbookTextTokens +
                      tokenBreakdown.textbookImagesTokens
                    ).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Saved Questions ({tokenBreakdown.questionCount})</span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {tokenBreakdown.questionsTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>
                    Current Draft
                    {tokenBreakdown.draftImageCount > 0
                      ? ` (+ ${tokenBreakdown.draftImageCount} img)`
                      : ''}
                  </span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {effectiveDraftTokens.toLocaleString()}
                  </span>
                </div>
                {lastReplyUsage ? (
                  <div className="pt-1.5 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                    <span>Last Reply Actual</span>
                    <span>
                      Output {lastReplyUsage.outputTokens.toLocaleString()} · Thinking{' '}
                      {lastReplyUsage.thinkingTokens.toLocaleString()}
                    </span>
                  </div>
                ) : null}
                {metricsWebSearchArmed ? (
                  <div className="text-[11px] text-sky-700 dark:text-sky-300">
                    + Live Tavily web search results will be added on send
                  </div>
                ) : null}
              </div>

              <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-1.5">
                <div className="flex items-center justify-between gap-2 font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                  <span>Total Pressure</span>
                  <span>
                    {displayTotalTokens.toLocaleString()} / {maxTokens.toLocaleString()} (
                    {usagePct.toFixed(1)}%)
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      isHighUsage
                        ? 'bg-rose-600'
                        : isMediumUsage
                        ? 'bg-amber-500'
                        : 'bg-sky-600'
                    }`}
                    style={{ width: `${Math.max(1, usagePct)}%` }}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
