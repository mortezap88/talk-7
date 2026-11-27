export interface UndoHistory<T> {
  past: T[];
  future: T[];
  maxDepth: number;
}

export function createUndoHistory<T>(maxDepth = 60): UndoHistory<T> {
  return {
    past: [],
    future: [],
    maxDepth,
  };
}

export function pushUndoSnapshot<T>(
  history: UndoHistory<T>,
  snapshot: T,
  isEqual: (a: T, b: T) => boolean = Object.is
): UndoHistory<T> {
  const last = history.past[history.past.length - 1];
  if (last !== undefined && isEqual(last, snapshot)) {
    return history;
  }
  const nextPast = [...history.past, snapshot];
  if (nextPast.length > history.maxDepth) {
    nextPast.splice(0, nextPast.length - history.maxDepth);
  }
  return {
    past: nextPast,
    future: [],
    maxDepth: history.maxDepth,
  };
}

export function stepUndo<T>(
  history: UndoHistory<T>,
  current: T
): { history: UndoHistory<T>; nextState: T } | null {
  if (history.past.length === 0) return null;
  const previous = history.past[history.past.length - 1];
  const nextPast = history.past.slice(0, -1);
  const nextFuture = [current, ...history.future].slice(0, history.maxDepth);
  return {
    history: {
      past: nextPast,
      future: nextFuture,
      maxDepth: history.maxDepth,
    },
    nextState: previous,
  };
}

export function stepRedo<T>(
  history: UndoHistory<T>,
  current: T
): { history: UndoHistory<T>; nextState: T } | null {
  if (history.future.length === 0) return null;
  const next = history.future[0];
  const nextFuture = history.future.slice(1);
  const nextPast = [...history.past, current];
  if (nextPast.length > history.maxDepth) {
    nextPast.splice(0, nextPast.length - history.maxDepth);
  }
  return {
    history: {
      past: nextPast,
      future: nextFuture,
      maxDepth: history.maxDepth,
    },
    nextState: next,
  };
}

export interface UndoKeyLike {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code?: string;
}

export function isUndoShortcut(e: UndoKeyLike): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
  return e.code === 'KeyZ' || e.key.toLowerCase() === 'z';
}

export function isRedoShortcut(e: UndoKeyLike): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  if (e.shiftKey) {
    return e.code === 'KeyZ' || e.key.toLowerCase() === 'z';
  }
  return e.code === 'KeyY' || e.key.toLowerCase() === 'y';
}
