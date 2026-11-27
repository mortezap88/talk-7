import { BookOpen, Database, FileText, HelpCircle, Loader2 } from 'lucide-react';
import type { ModeTab } from '../types/talk';

interface RightPanelSwitcherProps {
  activeTab: ModeTab;
  onSelectTab: (tab: ModeTab) => void;
  questionCount: number;
  isCompacting: boolean;
  memoryError?: string;
}

const RIGHT_TABS: Array<{ id: ModeTab; label: string; Icon: typeof BookOpen }> = [
  { id: 'notes', label: 'Notepad', Icon: FileText },
  { id: 'textbook', label: 'Textbook', Icon: BookOpen },
  { id: 'questions', label: 'Questions', Icon: HelpCircle },
  { id: 'memory', label: 'Memory', Icon: Database },
];

export function RightPanelSwitcher({
  activeTab,
  onSelectTab,
  questionCount,
  isCompacting,
  memoryError,
}: RightPanelSwitcherProps) {
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 select-none">

      <nav
        role="tablist"
        aria-orientation="horizontal"
        aria-label="Study workspace right panel"
        className="h-9 inline-flex items-center gap-1 px-1 rounded-lg bg-slate-100/95 dark:bg-slate-800/90 border border-slate-200/80 dark:border-slate-700/70 backdrop-blur-xs shadow-xs"
      >
        {RIGHT_TABS.map(({ id, label, Icon }) => {
          const isActive = activeTab === id;
          const isMemory = id === 'memory';
          const isQuestions = id === 'questions';
          const accessibleName =
            isQuestions && questionCount > 0 ? `${label} (${questionCount})` : label;

          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-label={accessibleName}
              title={
                isMemory && memoryError
                  ? `Memory error: ${memoryError}`
                  : isMemory && isCompacting
                  ? 'Updating memory…'
                  : accessibleName
              }
              onClick={() => onSelectTab(id)}
              className={`relative h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-sky-600 ${
                isActive
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {isMemory && isCompacting ? (
                <Loader2 className="w-4 h-4 animate-spin text-sky-600 dark:text-sky-400" />
              ) : (
                <Icon className="w-4 h-4" />
              )}
              {isQuestions && questionCount > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute -top-1.5 -right-1.5 min-w-3.5 h-3.5 px-1 rounded-full bg-sky-600 text-white text-[9px] font-semibold inline-flex items-center justify-center tabular-nums ring-2 ring-slate-100 dark:ring-slate-800"
                >
                  {questionCount}
                </span>
              ) : null}
              {isMemory && memoryError ? (
                <span
                  aria-label="Memory compaction failed"
                  className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-600 ring-2 ring-slate-100 dark:ring-slate-800"
                />
              ) : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
