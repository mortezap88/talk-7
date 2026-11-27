import { useEffect, useRef, useState } from 'react';
import { LogIn, LogOut, Pencil, Pin, PinOff, Plus, Trash2, X } from 'lucide-react';
import type { ChatItem } from '../types/talk';
import { formatRelativeTime } from '../utils/formatters';

interface ChatManagerDrawerProps {
  chats: ChatItem[];
  activeChatId: string | null;
  isOpen: boolean;
  isPinned: boolean;
  isFirebaseConnected: boolean;
  userDisplayName?: string | null;
  userEmail?: string | null;
  onSignInWithGoogle: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onCloseDrawer: () => void;
  onTogglePin: () => void;
  onSelectChat: (chatId: string) => void;
  onCreateChat: () => void;
  onRenameChat: (chatId: string, newTitle: string) => void;
  onDeleteChat: (chatId: string) => void;
}

export function ChatManagerDrawer({
  chats,
  activeChatId,
  isOpen,
  isPinned,
  isFirebaseConnected,
  userDisplayName,
  userEmail,
  onSignInWithGoogle,
  onSignOut,
  onCloseDrawer,
  onTogglePin,
  onSelectChat,
  onCreateChat,
  onRenameChat,
  onDeleteChat,
}: ChatManagerDrawerProps) {
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingChatId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [editingChatId]);

  const startRename = (chat: ChatItem) => {
    setEditingChatId(chat.id);
    setDraftTitle(chat.title);
  };

  const commitRename = () => {
    if (!editingChatId) return;
    const trimmed = draftTitle.trim();
    if (trimmed) {
      onRenameChat(editingChatId, trimmed);
    }
    setEditingChatId(null);
  };

  const cancelRename = () => {
    setEditingChatId(null);
    setDraftTitle('');
  };

  return (
    <>
      {/* Backdrop when open and unpinned */}
      {isOpen && !isPinned ? (
        <div
          aria-hidden="true"
          onClick={onCloseDrawer}
          className="fixed inset-0 bg-slate-950/15 dark:bg-slate-950/40 z-30 transition-opacity"
        />
      ) : null}

      <aside
        aria-label="Chat Manager"
        aria-hidden={!isOpen && !isPinned}
        className={`${
          isPinned
            ? 'relative shrink-0 w-72 border-r border-slate-200 dark:border-slate-800'
            : 'fixed left-0 top-0 bottom-0 w-72 z-40 border-r border-slate-200 dark:border-slate-800 shadow-lg'
        } bg-white dark:bg-slate-900 flex flex-col transition-transform duration-200 ease-out ${
          isOpen || isPinned
            ? 'translate-x-0 visible'
            : '-translate-x-full invisible pointer-events-none'
        }`}
      >
        <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Chat Manager
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onTogglePin}
              aria-label={isPinned ? 'Unpin Chat Manager' : 'Pin Chat Manager'}
              title={isPinned ? 'Unpin drawer' : 'Pin drawer'}
              className={`h-8 w-8 inline-flex items-center justify-center rounded-md transition-colors ${
                isPinned
                  ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {isPinned ? <Pin className="w-4 h-4" /> : <PinOff className="w-4 h-4" />}
            </button>
            {!isPinned ? (
              <button
                type="button"
                onClick={onCloseDrawer}
                aria-label="Close Chat Manager drawer"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="p-3 border-b border-slate-100 dark:border-slate-800/80">
          <button
            type="button"
            onClick={onCreateChat}
            className="w-full py-2 px-3 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>New chat</span>
          </button>
        </div>

        <div className="chat-scroll flex-1 overflow-y-auto p-2 space-y-1">
          {chats.length === 0 ? (
            <p className="px-3 py-6 text-xs text-slate-500 dark:text-slate-400 text-center">
              No chats yet. Start a new conversation above.
            </p>
          ) : (
            chats.map((chat) => {
              const isSelected = chat.id === activeChatId;
              const isEditing = editingChatId === chat.id;
              return (
                <div
                  key={chat.id}
                  className={`group rounded-lg border transition-colors ${
                    isSelected
                      ? 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700'
                      : 'bg-transparent border-transparent hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  {isEditing ? (
                    <div className="p-2">
                      <label className="sr-only" htmlFor={`rename-${chat.id}`}>
                        Rename chat
                      </label>
                      <input
                        id={`rename-${chat.id}`}
                        ref={renameInputRef}
                        type="text"
                        dir="auto"
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelRename();
                          }
                        }}
                        onBlur={cancelRename}
                        className="bidi-plaintext w-full px-2.5 py-1.5 text-sm rounded-md border border-sky-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none"
                      />
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-1 p-2.5">
                      <button
                        type="button"
                        onClick={() => onSelectChat(chat.id)}
                        className="flex-1 min-w-0 text-left focus-visible:outline-2 focus-visible:outline-sky-600 rounded"
                      >
                        <div dir="auto" className="bidi-plaintext text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                          {chat.title}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                          <span>{chat.messages.length} msgs</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatRelativeTime(chat.updatedAt)}</span>
                        </div>
                      </button>

                      <div className="flex items-center gap-0.5 shrink-0 opacity-80 group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() => startRename(chat)}
                          aria-label={`Rename ${chat.title}`}
                          title="Rename"
                          className="h-7 w-7 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteChat(chat.id)}
                          aria-label={`Delete ${chat.title}`}
                          title="Delete"
                          className="h-7 w-7 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-red-100 dark:hover:bg-red-950/60 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="p-2.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/70">
          {isFirebaseConnected ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                  {userDisplayName || 'Signed in'}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  {userEmail || 'Synced to Firestore'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onSignOut()}
                aria-label="Sign out"
                title="Sign out"
                className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void onSignInWithGoogle()}
              className="w-full py-1.5 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center justify-center gap-1.5 transition-colors"
            >
              <LogIn className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
              <span>Sign in with Google</span>
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
