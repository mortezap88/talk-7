import type { GeminiModel, ThinkingLevel } from '../types/talk';

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 45) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
}

export function createId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function computeComposerLayout(
  scrollHeight: number,
  borderHeight = 2,
  minHeight = 36,
  maxHeight = 180
): { heightPx: number; overflowY: 'hidden' | 'auto' } {
  const naturalHeight = Math.max(minHeight, Math.ceil(scrollHeight + borderHeight));
  if (naturalHeight > maxHeight) {
    return { heightPx: maxHeight, overflowY: 'auto' };
  }
  return { heightPx: naturalHeight, overflowY: 'hidden' };
}

export function supportsXhighThinking(model: GeminiModel): boolean {
  return model === 'gemini-4-hydrogen';
}

export function normalizeThinkingLevelForModel(
  level: ThinkingLevel,
  model: GeminiModel
): ThinkingLevel {
  if (level === 'xhigh' && !supportsXhighThinking(model)) {
    return 'high';
  }
  return level;
}
