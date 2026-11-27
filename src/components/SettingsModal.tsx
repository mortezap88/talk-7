import { useEffect, useState } from 'react';
import { LogIn, LogOut, Monitor, Moon, Sun, X } from 'lucide-react';
import type { GeminiModel, ThemeMode, ThinkingLevel } from '../types/talk';

interface SettingsModalProps {
  isOpen: boolean;
  currentTheme: ThemeMode;
  currentGeminiModel: GeminiModel;
  currentThinkingLevel: ThinkingLevel;
  isFirebaseConnected: boolean;
  userDisplayName?: string | null;
  userEmail?: string | null;
  onSignInWithGoogle: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onSave: (theme: ThemeMode, geminiModel: GeminiModel) => void;
  onClose: () => void;
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Monitor }> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

const GEMINI_MODEL_OPTIONS: Array<{
  value: GeminiModel;
  label: string;
  description: string;
}> = [
  {
    value: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    description: 'Default · balanced reasoning, supports Extra High thinking',
  },
  {
    value: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite',
    description: 'Lightweight & low-latency for fast chat and memory updates',
  },
  {
    value: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    description: 'Fast general-purpose Flash model for chat and memory',
  },
];

export function SettingsModal({
  isOpen,
  currentTheme,
  currentGeminiModel,
  currentThinkingLevel,
  isFirebaseConnected,
  userDisplayName,
  userEmail,
  onSignInWithGoogle,
  onSignOut,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [draftTheme, setDraftTheme] = useState<ThemeMode>(currentTheme);
  const [draftGeminiModel, setDraftGeminiModel] = useState<GeminiModel>(currentGeminiModel);

  useEffect(() => {
    if (isOpen) {
      setDraftTheme(currentTheme);
      setDraftGeminiModel(currentGeminiModel);
    }
  }, [isOpen, currentTheme, currentGeminiModel]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const activeModelSummary = `${draftGeminiModel} (chat & memory) + gemini-3.5-transcribe (mic STT)`;
  const showXhighNotice =
    currentThinkingLevel === 'xhigh' && draftGeminiModel !== 'gemini-4-hydrogen';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 id="settings-modal-title" className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Settings"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
              Appearance
            </div>
            <div
              role="radiogroup"
              aria-label="Appearance theme"
              className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            >
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
                const selected = draftTheme === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setDraftTheme(value)}
                    className={`py-2 px-3 rounded-md text-sm font-medium inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                      selected
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-xs'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Choose how Talk looks across sessions. System follows your operating system preference.
            </p>
          </div>

          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
              Gemini Model
            </div>
            <div
              role="radiogroup"
              aria-label="Gemini Model"
              className="space-y-1.5"
            >
              {GEMINI_MODEL_OPTIONS.map(({ value, label, description }) => {
                const selected = draftGeminiModel === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setDraftGeminiModel(value)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                      selected
                        ? 'border-sky-500/70 bg-sky-50/70 dark:bg-sky-950/30 dark:border-sky-500/60'
                        : 'border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/50 hover:border-slate-300 dark:hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {label}
                      </span>
                      <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        {value}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {description}
                    </p>
                  </button>
                );
              })}
            </div>
            {showXhighNotice && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                Extra High thinking automatically adjusts to High when using this model.
              </p>
            )}
            <p className="mt-2.5 text-xs text-slate-500 dark:text-slate-400 font-mono">
              {activeModelSummary}
            </p>
          </div>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {isFirebaseConnected ? 'Firebase Firestore Sync' : 'Local Browser Mode'}
                </div>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {isFirebaseConnected
                    ? userEmail || userDisplayName || 'Signed in with Google'
                    : 'Sign in with Google to sync chats and study data in Firestore.'}
                </p>
              </div>
              {isFirebaseConnected ? (
                <button
                  type="button"
                  onClick={async () => {
                    onClose();
                    await onSignOut();
                  }}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign out</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    onClose();
                    await onSignInWithGoogle();
                  }}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-xs font-medium text-white transition-colors"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>Sign in</span>
                </button>
              )}
            </div>
          </div>

        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(draftTheme, draftGeminiModel)}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-700 text-white transition-colors"
          >
            Save settings
          </button>
        </div>
      </div>
    </div>
  );
}
