import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import {
  ArrowDown,
  Loader2,
  Mic,
  Square,
  X,
} from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import type {
  ChatAttachment,
  ChatMessage,
  StoredQuestion,
} from '../types/talk';
import {
  splitAssistantMessageByQa,
  type ParsedQaSuggestion,
} from '../utils/qaParser';
import { computeComposerLayout } from '../utils/formatters';
import { SilenceAudioChunker } from '../utils/voiceChunker';
import { isRedoShortcut, isUndoShortcut } from '../utils/undoHistory';
import { RichInlineText, RichMessage } from './RichMessage';
import { ChatWaitingHero } from './ChatWaitingStage';

interface ChatTabProps {
  chatId: string;
  chatTitle: string;
  messages: ChatMessage[];
  savedQuestions: StoredQuestion[];
  streamingText: string | null;
  isStreaming: boolean;
  isSearchingWeb: boolean;
  errorBanner: string | null;
  onDismissError: () => void;
  input: string;
  onChangeInput: (value: string) => void;
  attachments: ChatAttachment[];
  onRemoveAttachment: (id: string) => void;
  onClearAttachments: () => void;
  onProcessFiles: (files: FileList | File[]) => Promise<void>;
  webSearchArmed: boolean;
  onClearWebSearch: () => void;
  onSendMessage: (
    text: string,
    attachments: ChatAttachment[],
    useWebSearch: boolean
  ) => Promise<void>;
  onCancelStream: () => void;
  onToggleSuggestedQa: (suggestion: ParsedQaSuggestion, checked: boolean) => void;
  onTranscribeAudio: (blob: Blob) => Promise<string>;
}

export function ChatTab({
  chatId,
  chatTitle,
  messages,
  savedQuestions,
  streamingText,
  isStreaming,
  isSearchingWeb,
  errorBanner,
  onDismissError,
  input,
  onChangeInput,
  attachments,
  onRemoveAttachment,
  onClearAttachments,
  onProcessFiles,
  webSearchArmed,
  onClearWebSearch,
  onSendMessage,
  onCancelStream,
  onToggleSuggestedQa,
  onTranscribeAudio,
}: ChatTabProps) {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; name: string } | null>(null);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [botExitDir, setBotExitDir] = useState<1 | -1>(() =>
    Math.random() < 0.5 ? 1 : -1
  );

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const voiceCaptureRef = useRef<{
    sessionId: number;
    stop: (abort?: boolean) => Promise<void>;
  } | null>(null);
  const voiceSessionCounterRef = useRef(0);
  const pendingTranscriptionsRef = useRef(0);
  const latestInputRef = useRef(input);
  latestInputRef.current = input;
  const onChangeInputRef = useRef(onChangeInput);
  onChangeInputRef.current = onChangeInput;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const hasMessagesRef = useRef(messages.length > 0 || streamingText !== null);
  hasMessagesRef.current = messages.length > 0 || streamingText !== null;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const webSearchArmedRef = useRef(webSearchArmed);
  webSearchArmedRef.current = webSearchArmed;
  const onSendMessageRef = useRef(onSendMessage);
  onSendMessageRef.current = onSendMessage;
  const onClearAttachmentsRef = useRef(onClearAttachments);
  onClearAttachmentsRef.current = onClearAttachments;
  const onClearWebSearchRef = useRef(onClearWebSearch);
  onClearWebSearchRef.current = onClearWebSearch;

  // On switching chats: leave empty chats unfocused so the bot greets first until user activates the box
  useEffect(() => {
    if (hasMessagesRef.current) {
      textareaRef.current?.focus();
    } else {
      textareaRef.current?.blur();
      setIsComposerFocused(false);
    }
    setShowJumpBottom(false);
    return () => {
      voiceSessionCounterRef.current++;
      pendingTranscriptionsRef.current = 0;
      setIsRecording(false);
      setIsTranscribing(false);
      if (voiceCaptureRef.current) {
        void voiceCaptureRef.current.stop(true);
        voiceCaptureRef.current = null;
      }
    };
  }, [chatId]);

  // Auto-grow composer vertically on input changes and keep scrollbar hidden until max height
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const borderHeight = el.offsetHeight - el.clientHeight;
    el.style.height = '32px';
    const { heightPx, overflowY } = computeComposerLayout(el.scrollHeight, borderHeight, 32, 180);
    el.style.height = `${heightPx}px`;
    el.style.overflowY = overflowY;
  }, [input, chatId]);

  // Close lightbox on Escape
  useEffect(() => {
    if (!lightboxImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxImage(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxImage]);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 180) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, streamingText]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpBottom(distance > 140);
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const imageFiles: File[] = [];
    const seen = new Set<string>();
    const addIfImage = (file: File | null, forceImage = false) => {
      if (!file) return;
      const isImg =
        forceImage ||
        file.type.startsWith('image/') ||
        /\.(png|jpe?g|webp|gif|bmp|heic|heif|svg)$/i.test(file.name || '');
      if (!isImg) return;
      const key = `${file.name}:${file.size}:${file.type}`;
      if (seen.has(key)) return;
      seen.add(key);
      imageFiles.push(file);
    };
    for (const item of Array.from(dt.items || [])) {
      if (item.kind === 'file') {
        addIfImage(item.getAsFile(), item.type.startsWith('image/'));
      }
    }
    for (const file of Array.from(dt.files || [])) {
      addIfImage(file, false);
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      await onProcessFiles(imageFiles);
    }
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer?.files?.length) {
      await onProcessFiles(e.dataTransfer.files);
    }
  };

  const handleToggleMic = async () => {
    setMicError(null);
    if (isRecording) {
      setIsRecording(false);
      const capture = voiceCaptureRef.current;
      voiceCaptureRef.current = null;
      if (capture) {
        await capture.stop(false);
      }
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!navigator.mediaDevices?.getUserMedia || !AudioCtx) {
      setMicError('Microphone recording is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const audioCtx = new AudioCtx();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;

      const sessionId = ++voiceSessionCounterRef.current;
      pendingTranscriptionsRef.current = 0;
      let nextSeq = 0;
      let nextFlushSeq = 0;
      const results = new Map<number, string>();
      let anyTranscriptEmitted = false;
      let recordingEnded = false;

      const focusComposerAtEnd = () => {
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          const len = el.value.length;
          el.setSelectionRange(len, len);
        });
      };

      const flushOrdered = () => {
        // Hold delivering transcript chunks into the input box until the user stops recording,
        // so background chunks never shift the text while they are still speaking or editing.
        if (!recordingEnded) return;
        let appended = false;
        while (results.has(nextFlushSeq)) {
          const text = (results.get(nextFlushSeq) || '').trim();
          results.delete(nextFlushSeq);
          nextFlushSeq++;
          if (text && sessionId === voiceSessionCounterRef.current) {
            anyTranscriptEmitted = true;
            appended = true;
            const cur = latestInputRef.current;
            const nextVal = cur.trim() ? `${cur.trimEnd()} ${text}` : text;
            latestInputRef.current = nextVal;
            onChangeInputRef.current(nextVal);
          }
        }
        if (appended) {
          focusComposerAtEnd();
        }
      };

      const finishVoiceSession = () => {
        flushOrdered();
        setIsTranscribing(false);
        if (!anyTranscriptEmitted) {
          setMicError((prev) => prev || 'No speech was detected in the recording.');
          focusComposerAtEnd();
          return;
        }
        const finalText = latestInputRef.current.trim();
        if (finalText && !isStreamingRef.current) {
          const atts = [...attachmentsRef.current];
          const useSearch = webSearchArmedRef.current;
          latestInputRef.current = '';
          onChangeInputRef.current('');
          onClearAttachmentsRef.current();
          onClearWebSearchRef.current();
          void onSendMessageRef.current(finalText, atts, useSearch);
        } else {
          focusComposerAtEnd();
        }
      };

      const dispatchChunk = (wavBlob: Blob) => {
        if (sessionId !== voiceSessionCounterRef.current) return;
        const seq = nextSeq++;
        pendingTranscriptionsRef.current++;

        void onTranscribeAudio(wavBlob)
          .then((transcript) => {
            if (sessionId !== voiceSessionCounterRef.current) return;
            results.set(seq, (transcript || '').trim());
            flushOrdered();
          })
          .catch((err) => {
            if (sessionId !== voiceSessionCounterRef.current) return;
            results.set(seq, '');
            flushOrdered();
            setMicError((err as Error).message || 'Transcription failed');
          })
          .finally(() => {
            if (sessionId !== voiceSessionCounterRef.current) return;
            pendingTranscriptionsRef.current = Math.max(
              0,
              pendingTranscriptionsRef.current - 1
            );
            if (recordingEnded && pendingTranscriptionsRef.current === 0) {
              finishVoiceSession();
            }
          });
      };

      const chunker = new SilenceAudioChunker({
        sampleRate: audioCtx.sampleRate,
        silenceCutMs: 300,
        minPatchMs: 20000,
        maxPatchMs: 45000,
        onChunk: dispatchChunk,
      });

      processor.onaudioprocess = (ev) => {
        if (recordingEnded || sessionId !== voiceSessionCounterRef.current) return;
        chunker.push(ev.inputBuffer.getChannelData(0));
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      const stop = async (abort = false) => {
        if (recordingEnded) return;
        recordingEnded = true;
        processor.onaudioprocess = null;
        try {
          source.disconnect();
          processor.disconnect();
          silentGain.disconnect();
        } catch {
          // ignore disconnect errors
        }
        stream.getTracks().forEach((t) => t.stop());

        if (!abort && sessionId === voiceSessionCounterRef.current) {
          chunker.flush();
          flushOrdered();
          if (pendingTranscriptionsRef.current > 0) {
            setIsTranscribing(true);
          } else {
            finishVoiceSession();
          }
        }

        if (audioCtx.state !== 'closed') {
          await audioCtx.close().catch(() => {});
        }
      };

      voiceCaptureRef.current = { sessionId, stop };
      setIsTranscribing(false);
      setIsRecording(true);
    } catch (err) {
      setMicError((err as Error).message || 'Could not access microphone');
    }
  };

  const submitMessage = async () => {
    if (isStreaming) return;
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const useSearch = webSearchArmed;
    const atts = [...attachments];
    onChangeInput('');
    onClearAttachments();
    onClearWebSearch();
    await onSendMessage(text, atts, useSearch);
  };

  const savedQuestionNormalized = useMemo(
    () => new Set(savedQuestions.map((q) => q.question.trim().toLowerCase())),
    [savedQuestions]
  );

  const isFirstMessageMode = messages.length === 0 && streamingText === null;

  useEffect(() => {
    if (isFirstMessageMode) {
      setBotExitDir(Math.random() < 0.5 ? 1 : -1);
    }
  }, [isFirstMessageMode, chatId]);

  const waitingExitCustom = {
    dir: botExitDir,
    dist: Math.max(320, (scrollRef.current?.clientWidth || 720) * 0.62),
  };

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="relative flex-1 min-h-0 flex flex-col bg-slate-50 dark:bg-slate-950 overflow-hidden"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDraggingOver(false);
          }
        }}
        onDrop={handleDrop}
      >
        {/* Top dismissible error banner */}
        {errorBanner ? (
          <div
            role="alert"
            className="relative z-20 shrink-0 pl-16 pr-4 py-2.5 bg-red-50 dark:bg-red-950/70 border-b border-red-200 dark:border-red-900 flex items-center justify-between gap-3 text-sm text-red-800 dark:text-red-200"
          >
            <span className="truncate">{errorBanner}</span>
            <button
              type="button"
              onClick={onDismissError}
              aria-label="Dismiss error"
              className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-900/60 shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : null}

        {/* Top Area: Centered Cute Bot Buddy on empty chat -> Scrollable Message Feed once started */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={
            isFirstMessageMode
              ? 'relative z-10 chat-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden pl-16 pr-4 sm:px-16 pt-10 pb-3 flex flex-col items-center justify-end'
              : 'relative z-10 chat-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden pl-16 pr-4 sm:pr-6 lg:pr-8 pt-6 pb-4'
          }
        >
          <AnimatePresence mode="popLayout" custom={waitingExitCustom}>
            {isFirstMessageMode ? (
              <motion.div
                key="waiting-bot-stage"
                custom={waitingExitCustom}
                variants={{
                  initial: { opacity: 0, scale: 0.96 },
                  animate: {
                    opacity: 1,
                    scale: 1,
                    transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const },
                  },
                  exit: (custom: { dir: 1 | -1; dist: number }) => ({
                    x: custom.dir * custom.dist,
                    rotate: custom.dir * 8,
                    opacity: [1, 1, 0],
                    transition: {
                      x: { duration: 0.84, ease: [0.22, 1, 0.36, 1] as const },
                      rotate: { duration: 0.84, ease: [0.22, 1, 0.36, 1] as const },
                      opacity: { duration: 0.84, times: [0, 0.68, 1], ease: 'linear' as const },
                    },
                  }),
                }}
                initial="initial"
                animate="animate"
                exit="exit"
                className="w-full flex justify-center pointer-events-auto"
              >
                <ChatWaitingHero
                  chatId={chatId}
                  inputValue={input}
                  isComposerFocused={isComposerFocused}
                  textareaRef={textareaRef}
                  onFocusComposer={() => {
                    textareaRef.current?.focus();
                  }}
                />
              </motion.div>
            ) : (
              <motion.div
                key="active-chat-feed"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.48, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
                className="max-w-[78rem] mx-auto"
              >

          {messages.map((msg, idx) => {
            const prevMsg = idx > 0 ? messages[idx - 1] : null;
            const isSameSender =
              Boolean(prevMsg) &&
              !prevMsg?.memoryStage &&
              !msg.memoryStage &&
              prevMsg?.role === msg.role;
            const topGapClass = idx === 0 ? '' : isSameSender ? 'mt-1.5' : 'mt-3.5';

            if (msg.memoryStage) {
              return (
                <div
                  key={msg.id}
                  className={`${topGapClass} max-w-[68rem] mx-auto p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/60 text-xs text-slate-600 dark:text-slate-300 space-y-1`}
                >
                  <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 font-medium">
                    <span>Legacy Embedded Memory · Stage {msg.memoryStage}</span>
                  </div>
                  <p className="leading-relaxed text-slate-700 dark:text-slate-300">{msg.content}</p>
                </div>
              );
            }

            const isUser = msg.role === 'user';
            const assistantSegments = !isUser ? splitAssistantMessageByQa(msg.content) : null;
            const hasInlineQa = Boolean(assistantSegments?.some((s) => s.type === 'qa'));

            return (
              <div key={msg.id} className={`${topGapClass} flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                <div
                  className={
                    isUser
                      ? 'max-w-[85%] px-1 py-0.5 text-slate-900 dark:text-slate-100'
                      : 'max-w-[68rem] w-full rounded-xl px-4 py-2.5 border bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border-slate-200 dark:border-slate-800'
                  }
                >
                  {hasInlineQa && assistantSegments ? (
                    <div className="space-y-3">
                      {assistantSegments.map((seg, sIdx) => {
                        if (seg.type === 'markdown') {
                          return (
                            <RichMessage
                              key={`${msg.id}_md_${sIdx}`}
                              content={seg.content}
                              variant="assistant"
                            />
                          );
                        }
                        const item = seg.suggestion;
                        const isChecked = savedQuestionNormalized.has(
                          item.question.trim().toLowerCase()
                        );
                        return (
                          <div
                            key={`${msg.id}_qa_${sIdx}`}
                            className={`rounded-xl border p-3.5 transition-colors space-y-2 ${
                              isChecked
                                ? 'bg-sky-50/70 dark:bg-sky-950/35 border-sky-300 dark:border-sky-800'
                                : 'bg-slate-50/70 dark:bg-slate-950/50 border-slate-200 dark:border-slate-800'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1 flex items-start gap-2.5 text-[15px] leading-relaxed">
                                {item.marker ? (
                                  <span className="shrink-0 min-w-[1.45rem] h-[1.45rem] px-1 mt-0.5 rounded-md bg-sky-50 dark:bg-sky-950/60 border border-sky-200/85 dark:border-sky-800/75 text-xs font-semibold tabular-nums text-sky-700 dark:text-sky-300 inline-flex items-center justify-center">
                                    {item.marker}
                                  </span>
                                ) : null}
                                <div
                                  dir="auto"
                                  className="bidi-plaintext flex-1 min-w-0 font-medium text-slate-900 dark:text-slate-100"
                                >
                                  <RichInlineText text={item.question} variant="assistant" />
                                </div>
                              </div>
                              <label
                                title="Save to Questions & Flashcards"
                                className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-medium cursor-pointer select-none transition-colors ${
                                  isChecked
                                    ? 'bg-sky-100/80 dark:bg-sky-900/50 border-sky-300 dark:border-sky-700 text-sky-700 dark:text-sky-300'
                                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => onToggleSuggestedQa(item, e.target.checked)}
                                  className="h-3.5 w-3.5 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                                />
                                <span>{isChecked ? 'Saved' : 'Save'}</span>
                              </label>
                            </div>

                            <div className="text-xs sm:text-[13.5px] text-slate-700 dark:text-slate-300 leading-relaxed ps-0.5">
                              <span className="font-semibold text-slate-700 dark:text-slate-300">
                                Answer:{' '}
                              </span>
                              <div className="mt-1">
                                <RichMessage content={item.answer} variant="assistant" />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <RichMessage
                      content={msg.content}
                      variant={isUser ? 'user' : 'assistant'}
                    />
                  )}

                  {/* Image attachment thumbnails */}
                  {msg.attachments && msg.attachments.some((a) => a.kind === 'image' && a.dataUrl) ? (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {msg.attachments
                        .filter((a) => a.kind === 'image' && a.dataUrl)
                        .map((img) => (
                          <button
                            key={img.id}
                            type="button"
                            onClick={() =>
                              setLightboxImage({ src: img.dataUrl!, name: img.name })
                            }
                            aria-label={`Zoom image ${img.name}`}
                            className="group relative rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 focus-visible:outline-2 focus-visible:outline-sky-500"
                          >
                            <img
                              src={img.dataUrl}
                              alt={img.name}
                              referrerPolicy="no-referrer"
                              className="h-32 w-48 object-cover transition-transform duration-150 group-hover:scale-105"
                            />
                          </button>
                        ))}
                    </div>
                  ) : null}

                </div>
              </div>
            );
          })}

          {/* Live streaming assistant reply */}
          {streamingText !== null ? (
            <div
              className={`${
                messages.length === 0
                  ? ''
                  : !messages[messages.length - 1]?.memoryStage &&
                    messages[messages.length - 1]?.role === 'assistant'
                  ? 'mt-1.5'
                  : 'mt-3.5'
              } flex flex-col items-start`}
            >
              <div className="max-w-[68rem] w-full rounded-xl px-4 py-2.5 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
                {streamingText ? (
                  <RichMessage
                    content={streamingText}
                    variant="assistant"
                  />
                ) : (
                  <div className="inline-flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
                    <span>Thinking…</span>
                  </div>
                )}
              </div>
            </div>
          ) : null}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Jump-to-bottom button */}
        {!isFirstMessageMode && showJumpBottom ? (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            aria-label="Jump to bottom"
            className="absolute bottom-20 right-6 z-20 h-9 px-3 rounded-full border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md shadow-md text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span>Jump to bottom</span>
          </button>
        ) : null}

        {/* Drag-over indicator */}
        {isDraggingOver ? (
          <div className="absolute inset-4 z-30 rounded-xl border-2 border-dashed border-sky-500 bg-sky-50/90 dark:bg-sky-950/85 flex items-center justify-center pointer-events-none">
            <p className="font-display text-base font-semibold text-sky-800 dark:text-sky-200">
              Drop images or text files to attach
            </p>
          </div>
        ) : null}

        {/* Persistent Prompt Bar: centered on first message, glides slowly down & widens on send */}
        <motion.footer
          layout="position"
          transition={{ layout: { duration: 0.78, ease: [0.22, 1, 0.36, 1] } }}
          className={
            isFirstMessageMode
              ? 'pointer-events-none relative z-20 shrink-0 w-full max-w-[44rem] mx-auto pl-16 pr-4 sm:px-16 pt-0 pb-2 flex flex-col gap-2 select-none transition-[max-width,padding] duration-[780ms] ease-[cubic-bezier(0.22,1,0.36,1)]'
              : 'pointer-events-none relative z-20 shrink-0 w-full max-w-[120rem] mx-auto px-4 pt-2 pb-[14px] flex flex-col gap-2 select-none transition-[max-width,padding] duration-[780ms] ease-[cubic-bezier(0.22,1,0.36,1)]'
          }
        >
          {isSearchingWeb || webSearchArmed || micError || attachments.length > 0 ? (
            <div className="pointer-events-auto rounded-xl border border-[#e2e8f0] dark:border-slate-700/80 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md shadow-[0_4px_14px_rgba(15,23,42,0.06)] px-3 py-2 space-y-2">
              {isSearchingWeb ? (
                <div className="flex items-center gap-2 text-xs text-sky-700 dark:text-sky-300 font-medium">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Searching the web with Tavily before sending…</span>
                </div>
              ) : webSearchArmed ? (
                <div className="text-xs text-sky-700 dark:text-sky-300 font-medium">
                  Web search enabled — next message will include live Tavily results.
                </div>
              ) : null}

              {micError ? (
                <div className="text-xs text-red-600 dark:text-red-400">{micError}</div>
              ) : null}

              {attachments.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {attachments.map((att) => (
                    <div
                      key={att.id}
                      className="relative group rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-800"
                    >
                      {att.dataUrl ? (
                        <img
                          src={att.dataUrl}
                          alt={att.name}
                          referrerPolicy="no-referrer"
                          className="h-14 w-20 object-cover"
                        />
                      ) : null}
                      <button
                        type="button"
                        onClick={() => onRemoveAttachment(att.id)}
                        aria-label={`Remove ${att.name}`}
                        className="absolute top-1 right-1 h-5 w-5 rounded-full bg-slate-900/75 text-white inline-flex items-center justify-center hover:bg-slate-900"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitMessage();
            }}
            className={`pointer-events-auto w-full min-w-0 min-h-10 py-[3px] pl-[14px] pr-[5px] rounded-xl border bg-white/95 dark:bg-slate-900/95 backdrop-blur-md flex items-end gap-1.5 transition-[border-color,box-shadow] duration-200 focus-within:border-slate-300 dark:focus-within:border-slate-600 focus-within:shadow-[0_10px_28px_-10px_rgba(15,23,42,0.14)] ${
              isFirstMessageMode
                ? 'border-slate-200/90 dark:border-slate-700/80 shadow-[0_8px_24px_-10px_rgba(15,23,42,0.1)]'
                : 'border-[#e2e8f0] dark:border-slate-700/80 shadow-[0_4px_14px_rgba(15,23,42,0.06)]'
            }`}
          >
            <label htmlFor="chat-composer-input" className="sr-only">
              Ask your study tutor
            </label>
            <textarea
              id="chat-composer-input"
              ref={textareaRef}
              dir="auto"
              rows={1}
              value={input}
              onFocus={() => setIsComposerFocused(true)}
              onBlur={() => setIsComposerFocused(false)}
              onChange={(e) => {
                onChangeInput(e.target.value);
              }}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submitMessage();
                  return;
                }
                const undoPressed = isUndoShortcut(e);
                const redoPressed = !undoPressed && isRedoShortcut(e);
                if (
                  (undoPressed || redoPressed) &&
                  e.key.toLowerCase() !== 'z' &&
                  e.key.toLowerCase() !== 'y' &&
                  typeof document.execCommand === 'function'
                ) {
                  e.preventDefault();
                  document.execCommand(undoPressed ? 'undo' : 'redo');
                }
              }}
              placeholder="Ask a question..."
              className="bidi-plaintext flex-1 min-w-0 self-center min-h-8 resize-none overflow-hidden border-0 bg-transparent py-[5px] text-[13.5px] leading-[22px] text-[#0f172a] dark:text-slate-100 placeholder:text-[#94a3b8] dark:placeholder:text-slate-500 focus:outline-none"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={onCancelStream}
                aria-label="Stop generating"
                title="Stop generating"
                className="h-[30px] mb-[1px] px-2.5 rounded-lg bg-slate-800 dark:bg-slate-700 hover:bg-slate-900 text-white text-xs font-medium inline-flex items-center gap-1.5 shrink-0 transition-colors"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>Stop</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleToggleMic}
              disabled={!isRecording && isTranscribing}
              aria-pressed={isRecording}
              aria-label={
                isRecording
                  ? 'Stop recording'
                  : isTranscribing
                  ? 'Finishing transcription'
                  : 'Voice input'
              }
              title={isRecording ? 'Stop recording and send' : 'Voice input'}
              className={`w-[30px] h-[30px] mb-[1px] rounded-lg border inline-flex items-center justify-center shrink-0 transition-all duration-150 focus-visible:outline-2 focus-visible:outline-sky-600 ${
                isRecording
                  ? 'bg-[#eff6ff] dark:bg-sky-950/60 border-[#93c5fd] dark:border-sky-500/70 text-[#2563eb] dark:text-sky-400'
                  : 'border-transparent bg-transparent text-[#64748b] dark:text-slate-400 hover:bg-[#f1f5f9] dark:hover:bg-slate-800 hover:text-[#0f172a] dark:hover:text-slate-100'
              }`}
            >
              {isRecording ? (
                <Square className="w-3.5 h-3.5 fill-current" />
              ) : isTranscribing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>
          </form>
        </motion.footer>

        {/* Bottom balance spacer keeps Hero + Composer centered when empty, collapses on first message */}
        <div
          aria-hidden="true"
          className={
            isFirstMessageMode
              ? 'flex-[0.85] min-h-4 pointer-events-none'
              : 'h-0 overflow-hidden pointer-events-none'
          }
        />

        {/* Image Zoom Lightbox */}
        {lightboxImage ? (
          <div
            className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-6"
            onClick={() => setLightboxImage(null)}
          >
            <div
              className="relative max-w-6xl max-h-[90vh] flex flex-col items-center gap-3"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setLightboxImage(null)}
                aria-label="Close image zoom"
                className="self-end h-9 px-3 rounded-lg bg-slate-900/90 text-white text-xs font-medium inline-flex items-center gap-1.5 hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
                <span>Close</span>
              </button>
              <img
                src={lightboxImage.src}
                alt={lightboxImage.name}
                referrerPolicy="no-referrer"
                className="max-w-full max-h-[80vh] rounded-xl bg-white object-contain shadow-2xl"
              />
              <div className="text-xs text-slate-300">{lightboxImage.name}</div>
            </div>
          </div>
        ) : null}
      </div>
    </MotionConfig>
  );
}
