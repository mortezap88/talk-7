import { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Database,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type {
  ChatMemory,
  ChatMessage,
  ConceptStatus,
  MemoryPack,
} from '../types/talk';
import {
  ACTIVE_WINDOW_MAX_MESSAGES,
  analyzeActiveWindow,
  COMPACTION_TRIGGER_TOKENS,
  getRollingPacks,
  MAX_LEARNER_CONCEPTS,
  PACK_SLOTS,
  sortLearnerState,
  stripHighlightMarkup,
} from '../utils/memoryEngine';
import { formatRelativeTime } from '../utils/formatters';
import { RichInlineText } from './RichMessage';

interface MemoryPanelProps {
  memory: ChatMemory;
  messages: ChatMessage[];
  isCompacting: boolean;
  onCompactNow: () => void;
  onRemoveConcept?: (conceptId: string) => void;
  onDeletePack: (packId: string) => void;
}

const STATUS_STYLE: Record<ConceptStatus, { label: string; colorClass: string }> = {
  misunderstood: {
    label: 'Misunderstood',
    colorClass:
      'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/50 border-red-200 dark:border-red-900/70',
  },
  unresolved: {
    label: 'Unresolved',
    colorClass:
      'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-900/70',
  },
  shaky: {
    label: 'Shaky',
    colorClass:
      'text-sky-700 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/50 border-sky-200 dark:border-sky-900/70',
  },
  understood: {
    label: 'Understood',
    colorClass:
      'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-900/70',
  },
};

function getSlotColorClass(slotIdx: number): string {
  if (slotIdx <= 2) {
    return 'bg-sky-600 text-white border-sky-700 dark:bg-sky-500 dark:border-sky-400';
  }
  if (slotIdx <= 6) {
    return 'bg-sky-500/80 text-white border-sky-600 dark:bg-sky-600/80 dark:border-sky-500';
  }
  if (slotIdx <= 10) {
    return 'bg-sky-200 text-sky-950 border-sky-300 dark:bg-sky-900/80 dark:text-sky-100 dark:border-sky-700';
  }
  return 'bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700';
}

export function MemoryPanel({
  memory,
  messages,
  isCompacting,
  onCompactNow,
  onRemoveConcept,
  onDeletePack,
}: MemoryPanelProps) {
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);

  const analysis = analyzeActiveWindow(messages, memory.compactedCount);
  const sortedConcepts = sortLearnerState(memory.learnerState);
  const blindspotCount = sortedConcepts.filter((c) => c.status !== 'understood').length;
  const understoodCount = sortedConcepts.length - blindspotCount;

  const rollingPacks = getRollingPacks(memory.packs);
  const selectedSlotIndex = selectedPackId
    ? rollingPacks.findIndex((p) => p.id === selectedPackId)
    : -1;
  const selectedPack: MemoryPack | null =
    selectedSlotIndex >= 0 ? rollingPacks[selectedSlotIndex] : null;

  const progressTokens = Math.min(COMPACTION_TRIGGER_TOKENS, analysis.uncompactedOutsideTokens);
  const progressPct = Math.round((progressTokens / COMPACTION_TRIGGER_TOKENS) * 100);

  return (
    <div className="doc-scroll flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-slate-950 px-4 sm:px-5 pt-14 pb-5">
      <div className="max-w-4xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-sky-600 dark:text-sky-400" />
            <div>
              <h1 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                Memory Inspector
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {memory.compactedCount} packed msgs · {memory.compactedTokens.toLocaleString()} tok
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={isCompacting || analysis.uncompactedTotalCount === 0}
            onClick={onCompactNow}
            className="px-3.5 py-2 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            {isCompacting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Packing…</span>
              </>
            ) : memory.lastError ? (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry pack</span>
              </>
            ) : (
              <span>Pack now</span>
            )}
          </button>
        </div>

        {/* Next Pack Progress */}
        <section
          aria-label="Next pack progress"
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2"
        >
          <div className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-200 tabular-nums font-medium">
            <span>
              Next Pack · {analysis.uncompactedOutsideTokens.toLocaleString()} /{' '}
              {COMPACTION_TRIGGER_TOKENS.toLocaleString()} tok
            </span>
            <span>{progressPct}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-sky-600 dark:bg-sky-500 transition-all duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {analysis.uncompactedOutsideWindow.length > 0
              ? `${analysis.uncompactedOutsideWindow.length} older msg${analysis.uncompactedOutsideWindow.length === 1 ? '' : 's'} queued beyond the last 10.`
              : 'Last 10 messages stay verbatim; older messages count toward 1,000 tok.'}
          </p>

          {memory.lastError ? (
            <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-400 pt-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{memory.lastError}</span>
            </div>
          ) : null}
        </section>

        {/* Blindspots & Understanding Progress (Living Learner State) */}
        <section
          aria-label="Blindspots and understanding progress"
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Blindspots &amp; Understanding Progress
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Updated automatically when memory packs run so the tutor tracks open gaps and breakthroughs.
              </p>
            </div>
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {blindspotCount} blindspot{blindspotCount === 1 ? '' : 's'} · {understoodCount} understood ({sortedConcepts.length}/{MAX_LEARNER_CONCEPTS})
            </span>
          </div>

          {sortedConcepts.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-4 text-center rounded-lg border border-dashed border-slate-200 dark:border-slate-800">
              No blindspots or concept improvements tracked yet. Pack a conversation segment to record them.
            </p>
          ) : (
            <div className="space-y-2">
              {sortedConcepts.map((item) => {
                const style = STATUS_STYLE[item.status];
                return (
                  <div
                    key={item.id}
                    className="group p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        dir="auto"
                        className="bidi-plaintext text-xs font-semibold text-slate-900 dark:text-slate-100"
                      >
                        {stripHighlightMarkup(item.concept)}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className={`px-2 py-0.5 text-[11px] font-medium rounded border ${style.colorClass}`}
                        >
                          {style.label}
                        </span>
                        {onRemoveConcept ? (
                          <button
                            type="button"
                            onClick={() => onRemoveConcept(item.id)}
                            aria-label={`Remove concept ${item.concept}`}
                            title="Remove concept"
                            className="opacity-70 group-hover:opacity-100 focus:opacity-100 h-6 w-6 inline-flex items-center justify-center rounded text-slate-400 hover:text-red-600 transition-opacity"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {item.note ? (
                      <p
                        dir="auto"
                        className="bidi-plaintext text-xs text-slate-600 dark:text-slate-300 leading-snug"
                      >
                        {stripHighlightMarkup(item.note)}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Rolling Memory Packs (P1 -> P15) + Inline Inspector */}
        <section
          aria-label="Memory packs"
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Rolling Memory Packs
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {rollingPacks.length} / {PACK_SLOTS} slots
            </span>
          </div>

          <div className="grid grid-cols-5 gap-2">
            {Array.from({ length: PACK_SLOTS }, (_, slotIdx) => {
              const pack = rollingPacks[slotIdx];
              const slotLabel = `P${slotIdx + 1}`;
              if (!pack) {
                return (
                  <div
                    key={slotLabel}
                    className="h-12 rounded-md border border-dashed border-slate-300 dark:border-slate-700 flex items-center justify-center text-xs text-slate-400 dark:text-slate-600 font-mono"
                  >
                    {slotLabel}
                  </div>
                );
              }
              const isSelected = selectedPackId === pack.id;
              const colorClass = getSlotColorClass(slotIdx);
              return (
                <button
                  key={pack.id}
                  type="button"
                  onClick={() => setSelectedPackId(isSelected ? null : pack.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (selectedPackId === pack.id) setSelectedPackId(null);
                    onDeletePack(pack.id);
                  }}
                  title={`${slotLabel} (${pack.tokenCount} tok) — click to inspect, right-click to delete`}
                  className={`h-12 rounded-md border flex flex-col items-center justify-center text-xs font-mono transition-transform hover:scale-[1.02] ${colorClass} ${
                    isSelected ? 'ring-2 ring-offset-1 ring-sky-500 dark:ring-offset-slate-900' : ''
                  }`}
                >
                  <span className="font-semibold">{slotLabel}</span>
                  <span className="text-[10px] opacity-85 tabular-nums">{pack.tokenCount}t</span>
                </button>
              );
            })}
          </div>

          {selectedPack ? (
            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedPackId(null)}
                    className="h-7 px-2 rounded-md border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Close pack</span>
                  </button>
                  <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Pack P{selectedSlotIndex + 1}
                    {selectedSlotIndex === 0 ? ' (Newest)' : ''}
                  </h3>
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {selectedPack.tokenCount} tok
                </span>
              </div>

              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">
                  Packed Study Memory (Subtopics, Conclusions, Blindspots &amp; Progress)
                </div>
                <p
                  dir="auto"
                  className="bidi-plaintext whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-200 leading-relaxed"
                >
                  <RichInlineText text={stripHighlightMarkup(selectedPack.summary)} />
                </p>
              </div>

              {selectedPack.bullets.length > 0 ? (
                <div>
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
                    Key Takeaways
                  </div>
                  <ul className="space-y-2">
                    {selectedPack.bullets.map((b, i) => (
                      <li
                        key={i}
                        dir="auto"
                        className="bidi-plaintext p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 leading-relaxed"
                      >
                        <RichInlineText text={stripHighlightMarkup(b)} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* Active Window */}
        <section
          aria-label="Active window"
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Active Window
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {analysis.activeWindow.length} / {ACTIVE_WINDOW_MAX_MESSAGES} msgs ·{' '}
              {analysis.activeTokens.toLocaleString()} tok
            </span>
          </div>

          <div className="space-y-2">
            {analysis.activeWindow.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
                No messages in active window yet.
              </p>
            ) : (
              analysis.activeWindow.map((msg) => (
                <div
                  key={msg.id}
                  className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 text-xs"
                >
                  <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">
                      {msg.role === 'user' ? 'Student' : 'Tutor'}
                    </span>
                    <span className="tabular-nums">{formatRelativeTime(msg.createdAt)}</span>
                  </div>
                  <p
                    dir="auto"
                    className="bidi-plaintext text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words leading-relaxed"
                  >
                    {msg.content}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
