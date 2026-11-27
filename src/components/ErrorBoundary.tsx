import { Component, type ErrorInfo, type ReactNode } from 'react';
import { tryParseFirestoreError } from '../firebase/firestoreError';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Application ErrorBoundary caught error:', error, info);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    const fsInfo = tryParseFirestoreError(this.state.error);
    const isQuotaError =
      this.state.error.message.includes('Quota exceeded') ||
      (fsInfo?.error.includes('Quota exceeded') ?? false);

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
        <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-lg space-y-4">
          <h1 className="font-display text-lg font-semibold">
            {isQuotaError ? 'Firestore daily quota reached' : 'Something went wrong'}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            {isQuotaError
              ? 'Your Firestore free-tier daily quota was exceeded. Quota resets automatically the next day.'
              : fsInfo
                ? `Firestore ${fsInfo.operationType} failed on ${fsInfo.path ?? 'unknown path'}: ${fsInfo.error}`
                : this.state.error.message || 'An unexpected error occurred.'}
          </p>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-700 text-white transition-colors"
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
