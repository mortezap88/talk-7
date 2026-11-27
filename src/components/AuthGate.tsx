import { BookOpen, Database, Loader2, LogIn } from 'lucide-react';

interface AuthGateProps {
  isSigningIn: boolean;
  authError: string | null;
  onSignInWithGoogle: () => Promise<void>;
  onContinueLocal: () => void;
}

export function AuthGate({
  isSigningIn,
  authError,
  onSignInWithGoogle,
  onContinueLocal,
}: AuthGateProps) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-7 shadow-lg space-y-6">
        <div className="space-y-2.5">
          <div className="inline-flex items-center gap-2 text-xs font-medium text-sky-700 dark:text-sky-400">
            <Database className="w-4 h-4" />
            <span>Firebase Firestore Workspace</span>
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Talk — Study Tutor
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            Sign in with Google to save and sync your chat histories, study notes, textbooks, flashcards, and memory in Firebase Firestore.
          </p>
        </div>

        {authError ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 dark:border-rose-900/70 bg-rose-50 dark:bg-rose-950/40 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300"
          >
            {authError}
          </div>
        ) : null}

        <div className="space-y-3">
          <button
            type="button"
            disabled={isSigningIn}
            onClick={() => void onSignInWithGoogle()}
            className="w-full py-2.5 px-4 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white text-sm font-medium inline-flex items-center justify-center gap-2.5 transition-colors shadow-xs"
          >
            {isSigningIn ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Signing in with Google…</span>
              </>
            ) : (
              <>
                <LogIn className="w-4 h-4" />
                <span>Continue with Google</span>
              </>
            )}
          </button>

          <button
            type="button"
            disabled={isSigningIn}
            onClick={onContinueLocal}
            className="w-full py-2 px-4 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/70 text-xs font-medium inline-flex items-center justify-center gap-2 transition-colors"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Continue in local browser mode</span>
          </button>
        </div>
      </div>
    </div>
  );
}
