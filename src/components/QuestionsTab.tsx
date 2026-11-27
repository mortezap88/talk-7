import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import type { FlashcardItem, StoredQuestion } from '../types/talk';
import { isRedoShortcut, isUndoShortcut } from '../utils/undoHistory';
import { RichInlineText } from './RichMessage';

interface QuestionsTabProps {
  questions: StoredQuestion[];
  cards: FlashcardItem[];
  onAddQuestion: (question: string, answer: string) => Promise<void>;
  onUpdateQuestion: (id: string, question: string, answer: string) => Promise<void>;
  onDeleteQuestion: (id: string) => Promise<void>;
}

type QuestionUndoAction =
  | { type: 'delete'; question: string; answer: string }
  | { type: 'add'; question: string; answer: string }
  | {
      type: 'edit';
      prevQuestion: string;
      prevAnswer: string;
      nextQuestion: string;
      nextAnswer: string;
    };

export function QuestionsTab({
  questions,
  cards,
  onAddQuestion,
  onUpdateQuestion,
  onDeleteQuestion,
}: QuestionsTabProps) {
  const [editing, setEditing] = useState<{
    mode: 'add' | 'edit';
    id?: string;
    question: string;
    answer: string;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  const callbacksRef = useRef({ onAddQuestion, onUpdateQuestion, onDeleteQuestion });
  callbacksRef.current = { onAddQuestion, onUpdateQuestion, onDeleteQuestion };

  const historyRef = useRef<{
    past: QuestionUndoAction[];
    future: QuestionUndoAction[];
  }>({ past: [], future: [] });

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEditing(null);
        return;
      }
      const undoPressed = isUndoShortcut(e);
      const redoPressed = !undoPressed && isRedoShortcut(e);
      if (!undoPressed && !redoPressed) return;
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') &&
        e.key.toLowerCase() !== 'z' &&
        e.key.toLowerCase() !== 'y' &&
        typeof document.execCommand === 'function'
      ) {
        e.preventDefault();
        document.execCommand(undoPressed ? 'undo' : 'redo');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

  useEffect(() => {
    const onUndoRedoKeyDown = (e: KeyboardEvent) => {
      if (editing) return;
      const undoPressed = isUndoShortcut(e);
      const redoPressed = !undoPressed && isRedoShortcut(e);
      if (!undoPressed && !redoPressed) return;

      const active = document.activeElement as HTMLElement | null;
      const isAnyEditable = Boolean(
        active &&
          (active.tagName === 'TEXTAREA' ||
            active.isContentEditable ||
            (active.tagName === 'INPUT' && (active as HTMLInputElement).type !== 'range'))
      );
      if (active && isAnyEditable && !containerRef.current?.contains(active)) {
        return;
      }

      if (undoPressed) {
        const action = historyRef.current.past.pop();
        if (!action) return;
        e.preventDefault();
        historyRef.current.future.unshift(action);

        if (action.type === 'delete') {
          void callbacksRef.current.onAddQuestion(action.question, action.answer).catch(() => {});
        } else if (action.type === 'add') {
          const match = questionsRef.current.find(
            (q) =>
              q.question.trim() === action.question.trim() &&
              q.answer.trim() === action.answer.trim()
          );
          if (match) {
            void callbacksRef.current.onDeleteQuestion(match.id).catch(() => {});
          }
        } else if (action.type === 'edit') {
          const match = questionsRef.current.find(
            (q) =>
              q.question.trim() === action.nextQuestion.trim() &&
              q.answer.trim() === action.nextAnswer.trim()
          );
          if (match) {
            void callbacksRef.current
              .onUpdateQuestion(match.id, action.prevQuestion, action.prevAnswer)
              .catch(() => {});
          }
        }
      } else if (redoPressed) {
        const action = historyRef.current.future.shift();
        if (!action) return;
        e.preventDefault();
        historyRef.current.past.push(action);

        if (action.type === 'delete') {
          const match = questionsRef.current.find(
            (q) =>
              q.question.trim() === action.question.trim() &&
              q.answer.trim() === action.answer.trim()
          );
          if (match) {
            void callbacksRef.current.onDeleteQuestion(match.id).catch(() => {});
          }
        } else if (action.type === 'add') {
          void callbacksRef.current.onAddQuestion(action.question, action.answer).catch(() => {});
        } else if (action.type === 'edit') {
          const match = questionsRef.current.find(
            (q) =>
              q.question.trim() === action.prevQuestion.trim() &&
              q.answer.trim() === action.prevAnswer.trim()
          );
          if (match) {
            void callbacksRef.current
              .onUpdateQuestion(match.id, action.nextQuestion, action.nextAnswer)
              .catch(() => {});
          }
        }
      }
    };

    window.addEventListener('keydown', onUndoRedoKeyDown);
    return () => window.removeEventListener('keydown', onUndoRedoKeyDown);
  }, [editing]);

  const handleSaveDialog = async () => {
    if (!editing) return;
    const q = editing.question.trim();
    const a = editing.answer.trim();
    if (!q) return;
    if (editing.mode === 'add') {
      await onAddQuestion(q, a);
      historyRef.current.past.push({ type: 'add', question: q, answer: a });
      historyRef.current.future = [];
    } else if (editing.id) {
      const prev = questions.find((item) => item.id === editing.id);
      await onUpdateQuestion(editing.id, q, a);
      if (prev && (prev.question !== q || prev.answer !== a)) {
        historyRef.current.past.push({
          type: 'edit',
          prevQuestion: prev.question,
          prevAnswer: prev.answer,
          nextQuestion: q,
          nextAnswer: a,
        });
        historyRef.current.future = [];
      }
    }
    setEditing(null);
  };

  const handleDeleteQuestion = async (item: StoredQuestion) => {
    await onDeleteQuestion(item.id);
    historyRef.current.past.push({
      type: 'delete',
      question: item.question,
      answer: item.answer,
    });
    historyRef.current.future = [];
  };

  return (
    <div
      ref={containerRef}
      className="doc-scroll flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-slate-950 px-4 sm:px-5 pt-14 pb-5"
    >
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
              Study Questions
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {questions.length} saved in this chat · {cards.length} synced flashcards (EXAM)
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditing({ mode: 'add', question: '', answer: '' })}
            className="px-3.5 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add question</span>
          </button>
        </div>

        {questions.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center space-y-2">
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
              No saved questions in this conversation yet
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Check a Q&A suggestion card in Chat, type &ldquo;add this question&rdquo;, or click Add question above.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {questions.map((item, idx) => {
              const linkedCard = cards.find((c) => c.id === item.flashcardId || c.questionId === item.id);
              return (
                <div
                  key={item.id}
                  className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      <span>Question {idx + 1}</span>
                      {linkedCard ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>
                            Flashcard {linkedCard.type} / {linkedCard.status}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <h2 dir="auto" className="bidi-plaintext text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug">
                      <RichInlineText text={item.question} />
                    </h2>
                    {item.answer ? (
                      <p dir="auto" className="bidi-plaintext text-xs text-slate-600 dark:text-slate-400 leading-relaxed whitespace-pre-wrap">
                        <RichInlineText text={item.answer} />
                      </p>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setEditing({
                          mode: 'edit',
                          id: item.id,
                          question: item.question,
                          answer: item.answer,
                        })
                      }
                      aria-label={`Edit question ${idx + 1}`}
                      title="Edit"
                      className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteQuestion(item)}
                      aria-label={`Delete question ${idx + 1}`}
                      title="Delete"
                      className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-950/60 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit / Add Question Dialog */}
      {editing ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/45"
          onClick={() => setEditing(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="question-dialog-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden"
          >
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h2 id="question-dialog-title" className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                {editing.mode === 'add' ? 'Add Question' : 'Edit Question'}
              </h2>
              <button
                type="button"
                onClick={() => setEditing(null)}
                aria-label="Close question dialog"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label htmlFor="q-dialog-question" className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Question
                </label>
                <textarea
                  id="q-dialog-question"
                  dir="auto"
                  rows={3}
                  value={editing.question}
                  onChange={(e) => setEditing({ ...editing, question: e.target.value })}
                  placeholder="Enter the study question…"
                  className="bidi-plaintext w-full px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label htmlFor="q-dialog-answer" className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Answer
                </label>
                <textarea
                  id="q-dialog-answer"
                  dir="auto"
                  rows={5}
                  value={editing.answer}
                  onChange={(e) => setEditing({ ...editing, answer: e.target.value })}
                  placeholder="Enter the reference answer…"
                  className="bidi-plaintext w-full px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!editing.question.trim()}
                onClick={handleSaveDialog}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 hover:bg-sky-700 disabled:opacity-45 text-white"
              >
                Save question
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
