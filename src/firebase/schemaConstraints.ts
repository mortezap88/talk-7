export const FIRESTORE_ID_PATTERN = /^[a-zA-Z0-9_\-]+$/;

export const BLUEPRINT_LIMITS = {
  ID_MAX_LEN: 128,
  EMAIL_MAX_LEN: 320,
  DISPLAY_NAME_MAX_LEN: 160,
  PHOTO_URL_MAX_LEN: 1024,
  SUBJECT_MAX_COUNT: 32,
  SUBJECT_MAX_LEN: 100,
  CHAT_TITLE_MAX_LEN: 200,
  MESSAGE_CONTENT_MAX_LEN: 200000,
  MESSAGE_ATTACHMENTS_MAX_COUNT: 10,
  MESSAGE_CANDIDATES_MAX_COUNT: 20,
  NOTE_TITLE_MAX_LEN: 300,
  NOTE_BODY_MAX_LEN: 300000,
  NOTE_TAGS_MAX_COUNT: 30,
  NOTE_TAG_MAX_LEN: 64,
  NOTE_IMAGES_MAX_COUNT: 20,
  TEXTBOOK_TITLE_MAX_LEN: 300,
  TEXTBOOK_BODY_MAX_LEN: 400000,
  TEXTBOOK_IMAGES_MAX_COUNT: 20,
  TEXTBOOK_BLOCKS_MAX_COUNT: 400,
  TEXTBOOK_CAPTION_MAX_LEN: 2000,
  TEXTBOOK_CODE_MAX_LEN: 32,
  QUESTION_MAX_LEN: 10000,
  ANSWER_MAX_LEN: 20000,
  LEARNER_STATE_MAX_COUNT: 24,
  MEMORY_PACKS_MAX_COUNT: 15,
  CONDENSED_ARCHIVE_MAX_LEN: 100000,
  MEMORY_ERROR_MAX_LEN: 1000,
  FLASHCARD_SUBJECT_MAX_LEN: 200,
} as const;

export const ALLOWED_GEMINI_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
] as const;

export const ALLOWED_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export const ALLOWED_THEME_MODES = ['system', 'light', 'dark'] as const;
export const ALLOWED_CHAT_ROLES = ['user', 'assistant', 'system'] as const;
export const ALLOWED_FLASHCARD_STATUSES = ['NEW', 'LEARNING', 'MASTERED'] as const;

export function isValidBlueprintId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= BLUEPRINT_LIMITS.ID_MAX_LEN &&
    FIRESTORE_ID_PATTERN.test(value)
  );
}

export function clampString(value: unknown, maxLen: number, fallback = ''): string {
  const str = typeof value === 'string' ? value : fallback;
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v !== undefined) {
          out[k] = stripUndefinedDeep(v);
        }
      }
      return out as T;
    }
  }
  return value;
}

export interface RuleSimulationContext {
  authUid: string | null;
  emailVerified: boolean;
  parentChatOwnerUid?: string | null;
}

/**
 * Pure validation mirrors of firestore.rules constraints for local unit testing & pre-flight payload checks.
 */
export function validateChatPayload(
  payload: Record<string, unknown>,
  ctx: RuleSimulationContext,
  pathUserId: string,
  pathChatId: string
): boolean {
  if (!ctx.authUid || !ctx.emailVerified || ctx.authUid !== pathUserId) return false;
  if (!isValidBlueprintId(pathUserId) || !isValidBlueprintId(pathChatId)) return false;

  const required = ['id', 'userId', 'title', 'messageCount', 'updatedAtMs', 'createdAt', 'updatedAt'];
  const keys = Object.keys(payload);
  if (!required.every((k) => keys.includes(k))) return false;
  if (!keys.every((k) => required.includes(k))) return false;

  return (
    isValidBlueprintId(payload.id) &&
    payload.id === pathChatId &&
    isValidBlueprintId(payload.userId) &&
    payload.userId === pathUserId &&
    payload.userId === ctx.authUid &&
    typeof payload.title === 'string' &&
    payload.title.length >= 1 &&
    payload.title.length <= BLUEPRINT_LIMITS.CHAT_TITLE_MAX_LEN &&
    typeof payload.messageCount === 'number' &&
    payload.messageCount >= 0 &&
    payload.messageCount <= 100000 &&
    typeof payload.updatedAtMs === 'number' &&
    payload.updatedAtMs >= 0
  );
}

export function validateChatMessagePayload(
  payload: Record<string, unknown>,
  ctx: RuleSimulationContext,
  pathUserId: string,
  pathChatId: string,
  pathMessageId: string
): boolean {
  if (!ctx.authUid || !ctx.emailVerified || ctx.authUid !== pathUserId) return false;
  if (!isValidBlueprintId(pathUserId) || !isValidBlueprintId(pathChatId) || !isValidBlueprintId(pathMessageId)) {
    return false;
  }
  if (ctx.parentChatOwnerUid !== ctx.authUid) return false;

  const required = ['id', 'userId', 'chatId', 'role', 'content', 'createdAtMs', 'createdAt', 'updatedAt'];
  const allowed = [
    ...required,
    'attachments',
    'candidate',
    'candidateState',
    'memoryStage',
    'tokenUsage',
  ];
  const keys = Object.keys(payload);
  if (!required.every((k) => keys.includes(k))) return false;
  if (!keys.every((k) => allowed.includes(k))) return false;

  if (
    payload.id !== pathMessageId ||
    payload.userId !== pathUserId ||
    payload.userId !== ctx.authUid ||
    payload.chatId !== pathChatId
  ) {
    return false;
  }
  if (!ALLOWED_CHAT_ROLES.includes(payload.role as (typeof ALLOWED_CHAT_ROLES)[number])) return false;
  if (typeof payload.content !== 'string' || payload.content.length > BLUEPRINT_LIMITS.MESSAGE_CONTENT_MAX_LEN) {
    return false;
  }
  if (typeof payload.createdAtMs !== 'number' || payload.createdAtMs < 0) return false;
  if (
    'attachments' in payload &&
    (!Array.isArray(payload.attachments) ||
      payload.attachments.length > BLUEPRINT_LIMITS.MESSAGE_ATTACHMENTS_MAX_COUNT)
  ) {
    return false;
  }
  if (
    'candidate' in payload &&
    (!Array.isArray(payload.candidate) ||
      payload.candidate.length > BLUEPRINT_LIMITS.MESSAGE_CANDIDATES_MAX_COUNT)
  ) {
    return false;
  }
  return true;
}

export function validateUserProfilePayload(
  payload: Record<string, unknown>,
  ctx: RuleSimulationContext,
  pathUserId: string
): boolean {
  if (!ctx.authUid || !ctx.emailVerified || ctx.authUid !== pathUserId) return false;
  if (!isValidBlueprintId(pathUserId)) return false;

  const required = ['uid', 'email', 'displayName', 'photoURL', 'createdAt', 'updatedAt'];
  const keys = Object.keys(payload);
  if (!required.every((k) => keys.includes(k))) return false;
  if (!keys.every((k) => required.includes(k))) return false;

  return (
    isValidBlueprintId(payload.uid) &&
    payload.uid === pathUserId &&
    payload.uid === ctx.authUid &&
    typeof payload.email === 'string' &&
    payload.email.length <= BLUEPRINT_LIMITS.EMAIL_MAX_LEN &&
    typeof payload.displayName === 'string' &&
    payload.displayName.length <= BLUEPRINT_LIMITS.DISPLAY_NAME_MAX_LEN &&
    typeof payload.photoURL === 'string' &&
    payload.photoURL.length <= BLUEPRINT_LIMITS.PHOTO_URL_MAX_LEN
  );
}

export function validateAppSettingsPayload(
  payload: Record<string, unknown>,
  ctx: RuleSimulationContext,
  pathUserId: string
): boolean {
  if (!ctx.authUid || !ctx.emailVerified || ctx.authUid !== pathUserId) return false;
  if (!isValidBlueprintId(pathUserId)) return false;

  const required = [
    'userId',
    'provider',
    'geminiModel',
    'thinkingLevel',
    'themeMode',
    'subjects',
    'createdAt',
    'updatedAt',
  ];
  const keys = Object.keys(payload);
  if (!required.every((k) => keys.includes(k))) return false;
  if (!keys.every((k) => required.includes(k))) return false;

  return (
    payload.userId === pathUserId &&
    payload.userId === ctx.authUid &&
    payload.provider === 'gemini' &&
    ALLOWED_GEMINI_MODELS.includes(payload.geminiModel as (typeof ALLOWED_GEMINI_MODELS)[number]) &&
    ALLOWED_THINKING_LEVELS.includes(payload.thinkingLevel as (typeof ALLOWED_THINKING_LEVELS)[number]) &&
    ALLOWED_THEME_MODES.includes(payload.themeMode as (typeof ALLOWED_THEME_MODES)[number]) &&
    Array.isArray(payload.subjects) &&
    payload.subjects.length <= BLUEPRINT_LIMITS.SUBJECT_MAX_COUNT
  );
}
