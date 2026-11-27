import { useEffect, useMemo, useState } from 'react';
import { talkApi } from '../api/talkClient';
import type {
  ChatAttachment,
  ChatMemory,
  ChatMessage,
  GeminiModel,
  NoteData,
  StoredQuestion,
  TextbookData,
  TokenUsageSnapshot,
} from '../types/talk';
import {
  computeNextRequestTokenBreakdown,
  GEMINI_CONTEXT_WINDOW_TOKENS,
} from '../utils/memoryEngine';

export interface TokenBudgetMetrics {
  displayTotalTokens: number;
  maxTokens: number;
  usagePct: number;
  isSyncingTokens: boolean;
  isExactCount: boolean;
  effectiveDraftTokens: number;
  tokenBreakdown: ReturnType<typeof computeNextRequestTokenBreakdown>;
  lastReplyUsage: TokenUsageSnapshot | null;
  webSearchArmed: boolean;
}

export function useTokenBudgetMetrics(params: {
  chatId: string;
  messages: ChatMessage[];
  savedQuestions: StoredQuestion[];
  note: NoteData;
  memory: ChatMemory;
  textbook: TextbookData;
  geminiModel: GeminiModel;
  draftText: string;
  draftAttachments: ChatAttachment[];
  webSearchArmed: boolean;
}): TokenBudgetMetrics {
  const {
    chatId,
    messages,
    savedQuestions,
    note,
    memory,
    textbook,
    geminiModel,
    draftText,
    draftAttachments,
    webSearchArmed,
  } = params;

  const [exactBaseTokens, setExactBaseTokens] = useState<number | null>(null);
  const [exactDraftTokens, setExactDraftTokens] = useState<number | null>(null);
  const [isSyncingTokens, setIsSyncingTokens] = useState(false);

  const tokenBreakdown = useMemo(
    () =>
      computeNextRequestTokenBreakdown({
        memory,
        note,
        textbook,
        questions: savedQuestions,
        messages,
        draftText,
        draftAttachments,
      }),
    [memory, note, textbook, savedQuestions, messages, draftText, draftAttachments]
  );

  const lastReplyUsage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && !m.memoryStage && m.tokenUsage) {
        return m.tokenUsage;
      }
    }
    return null;
  }, [messages]);

  const baseContextSignature = useMemo(
    () =>
      JSON.stringify({
        chatId,
        geminiModel,
        systemLen: tokenBreakdown.assembledBase.systemPrompt.length,
        packIds: tokenBreakdown.assembledBase.includedPackIds,
        noteUpdated: note.updatedAt,
        textbookUpdated: textbook.updatedAt,
        tbImgIds: tokenBreakdown.assembledBase.textbookImagesForLatestUser.map((i) => i.id),
        qCount: savedQuestions.length,
        msgIds: tokenBreakdown.assembledBase.selectedMessages.map((m) => m.id),
      }),
    [
      chatId,
      geminiModel,
      tokenBreakdown.assembledBase.systemPrompt.length,
      tokenBreakdown.assembledBase.includedPackIds,
      note.updatedAt,
      textbook.updatedAt,
      tokenBreakdown.assembledBase.textbookImagesForLatestUser,
      savedQuestions.length,
      tokenBreakdown.assembledBase.selectedMessages,
    ]
  );

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    setExactBaseTokens(null);
    const timer = setTimeout(async () => {
      setIsSyncingTokens(true);
      try {
        const res = await talkApi.countTokens({
          systemPrompt: tokenBreakdown.assembledBase.systemPrompt,
          messages: tokenBreakdown.assembledBase.selectedMessages,
          textbookImages: tokenBreakdown.assembledBase.textbookImagesForLatestUser,
        });
        if (!cancelled) {
          setExactBaseTokens(res.totalTokens);
        }
      } catch {
        // Fallback smoothly to live local breakdown estimate
      } finally {
        if (!cancelled) setIsSyncingTokens(false);
      }
    }, 450);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [baseContextSignature, chatId]);

  const draftSignature = useMemo(
    () =>
      JSON.stringify({
        geminiModel,
        draftText,
        attIds: draftAttachments.map((a) => `${a.id}:${a.textContent?.length || 0}`),
      }),
    [geminiModel, draftText, draftAttachments]
  );

  useEffect(() => {
    const draftMsg = tokenBreakdown.draftMessage;
    if (!draftMsg) {
      setExactDraftTokens(0);
      return;
    }

    let cancelled = false;
    setExactDraftTokens(null);
    const timer = setTimeout(async () => {
      try {
        const res = await talkApi.countTokens({
          systemPrompt: '',
          messages: [draftMsg],
          textbookImages: [],
        });
        if (!cancelled) {
          setExactDraftTokens(res.totalTokens);
        }
      } catch {
        // Fallback smoothly to local estimate
      }
    }, 550);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draftSignature]);

  const effectiveBaseTokens = exactBaseTokens ?? tokenBreakdown.estimatedBaseTokens;
  const effectiveDraftTokens = exactDraftTokens ?? tokenBreakdown.estimatedDraftTokens;
  const displayTotalTokens = effectiveBaseTokens + effectiveDraftTokens;
  const isExactCount = exactBaseTokens !== null && exactDraftTokens !== null;
  const usagePct = Math.min(100, (displayTotalTokens / GEMINI_CONTEXT_WINDOW_TOKENS) * 100);

  return {
    displayTotalTokens,
    maxTokens: GEMINI_CONTEXT_WINDOW_TOKENS,
    usagePct,
    isSyncingTokens,
    isExactCount,
    effectiveDraftTokens,
    tokenBreakdown,
    lastReplyUsage,
    webSearchArmed,
  };
}
