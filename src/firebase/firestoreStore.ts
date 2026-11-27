import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type {
  AppSettings,
  ChatAttachment,
  ChatItem,
  ChatMemory,
  ChatMessage,
  FlashcardItem,
  NoteData,
  StoredQuestion,
  TextbookConvertedBlock,
  TextbookData,
  TextbookFigure,
} from '../types/talk';
import { createId, normalizeThinkingLevelForModel } from '../utils/formatters';
import { DEFAULT_STT_MODEL } from '../utils/localStore';
import { createSeedWorkspace, VALID_GEMINI_MODELS } from '../utils/seedData';
import { db } from './firebase';
import { handleFirestoreError, OperationType } from './firestoreError';
import { compressAttachmentForFirestore } from './imageCompression';
import {
  BLUEPRINT_LIMITS,
  clampString,
  isValidBlueprintId,
  stripUndefinedDeep,
} from './schemaConstraints';

const DEFAULT_SUBJECTS = ['Biology', 'Organic Chemistry', 'Biochemistry', 'General Study'];

function ensureValidId(candidate: string | undefined, prefix: string): string {
  if (candidate && isValidBlueprintId(candidate)) {
    return candidate;
  }
  return createId(prefix);
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export class FirestoreWorkspaceStore {
  private initPromises = new Map<string, Promise<void>>();

  async ensureUserInitialized(user: User): Promise<void> {
    const uid = user.uid;
    const existingPromise = this.initPromises.get(uid);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = this.initializeUserInternal(user).catch((err) => {
      this.initPromises.delete(uid);
      throw err;
    });
    this.initPromises.set(uid, promise);
    return promise;
  }

  private async initializeUserInternal(user: User): Promise<void> {
    const uid = user.uid;
    const profilePath = `users/${uid}/private/profile`;
    const profileRef = doc(db, 'users', uid, 'private', 'profile');

    let profileExists = false;
    try {
      const profileSnap = await getDoc(profileRef);
      profileExists = profileSnap.exists();
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, profilePath);
    }

    const profileFields = {
      email: clampString(user.email, BLUEPRINT_LIMITS.EMAIL_MAX_LEN, ''),
      displayName: clampString(
        user.displayName || user.email?.split('@')[0] || 'Student',
        BLUEPRINT_LIMITS.DISPLAY_NAME_MAX_LEN,
        'Student'
      ),
      photoURL: clampString(user.photoURL, BLUEPRINT_LIMITS.PHOTO_URL_MAX_LEN, ''),
    };

    if (profileExists) {
      try {
        await updateDoc(profileRef, {
          ...profileFields,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, profilePath);
      }
    } else {
      try {
        await setDoc(profileRef, {
          uid,
          ...profileFields,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, profilePath);
      }
    }

    const settingsPath = `users/${uid}/settings/app`;
    const settingsRef = doc(db, 'users', uid, 'settings', 'app');
    let settingsExists = false;
    try {
      const settingsSnap = await getDoc(settingsRef);
      settingsExists = settingsSnap.exists();
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, settingsPath);
    }

    const chatsPath = `users/${uid}/chats`;
    let existingChatsCount = 0;
    try {
      const chatsSnap = await getDocs(
        query(collection(db, 'users', uid, 'chats'), where('userId', '==', uid))
      );
      existingChatsCount = chatsSnap.size;
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, chatsPath);
    }

    if (!settingsExists && existingChatsCount === 0) {
      await this.seedStarterWorkspace(uid);
    } else if (!settingsExists) {
      const seed = createSeedWorkspace();
      try {
        await setDoc(settingsRef, {
          userId: uid,
          provider: 'gemini',
          geminiModel: seed.settings.geminiModel,
          thinkingLevel: seed.settings.thinkingLevel,
          themeMode: seed.settings.themeMode,
          subjects: seed.subjects.slice(0, BLUEPRINT_LIMITS.SUBJECT_MAX_COUNT),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, settingsPath);
      }
    }
  }

  private async seedStarterWorkspace(uid: string): Promise<void> {
    const seed = createSeedWorkspace();
    const parentBatch = writeBatch(db);
    const childWrites: Array<{
      ref: ReturnType<typeof doc>;
      data: Record<string, unknown>;
    }> = [];

    const settingsRef = doc(db, 'users', uid, 'settings', 'app');
    parentBatch.set(settingsRef, {
      userId: uid,
      provider: 'gemini',
      geminiModel: seed.settings.geminiModel,
      thinkingLevel: seed.settings.thinkingLevel,
      themeMode: seed.settings.themeMode,
      subjects: seed.subjects.slice(0, BLUEPRINT_LIMITS.SUBJECT_MAX_COUNT),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    for (const chat of seed.chats) {
      const chatRef = doc(db, 'users', uid, 'chats', chat.id);
      parentBatch.set(chatRef, {
        id: chat.id,
        userId: uid,
        title: clampString(chat.title, BLUEPRINT_LIMITS.CHAT_TITLE_MAX_LEN, 'Study Session'),
        messageCount: chat.messages.length,
        updatedAtMs: chat.updatedAt,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      for (const msg of chat.messages) {
        childWrites.push({
          ref: doc(db, 'users', uid, 'chats', chat.id, 'messages', msg.id),
          data: stripUndefinedDeep({
            id: msg.id,
            userId: uid,
            chatId: chat.id,
            role: msg.role,
            content: clampString(msg.content, BLUEPRINT_LIMITS.MESSAGE_CONTENT_MAX_LEN, ''),
            createdAtMs: msg.createdAt,
            attachments: msg.attachments,
            candidate: msg.candidate,
            candidateState: msg.candidateState,
            memoryStage: msg.memoryStage,
            tokenUsage: msg.tokenUsage,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }),
        });
      }

      const note = (seed.kv[`note:${chat.id}`] as NoteData | undefined) ?? {
        title: '',
        body: '',
        tags: [],
        updatedAt: Date.now(),
      };
      childWrites.push({
        ref: doc(db, 'users', uid, 'chats', chat.id, 'workspace', 'note'),
        data: {
          userId: uid,
          chatId: chat.id,
          title: clampString(note.title, BLUEPRINT_LIMITS.NOTE_TITLE_MAX_LEN, ''),
          body: clampString(note.body, BLUEPRINT_LIMITS.NOTE_BODY_MAX_LEN, ''),
          tags: (note.tags || []).slice(0, BLUEPRINT_LIMITS.NOTE_TAGS_MAX_COUNT),
          images: (note.images || []).slice(0, BLUEPRINT_LIMITS.NOTE_IMAGES_MAX_COUNT),
          updatedAtMs: note.updatedAt,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      });

      const tb = (seed.kv[`textbook:${chat.id}`] as TextbookData | undefined) ?? {
        title: '',
        body: '',
        images: [],
        updatedAt: 0,
      };
      childWrites.push({
        ref: doc(db, 'users', uid, 'chats', chat.id, 'workspace', 'textbook'),
        data: {
          userId: uid,
          chatId: chat.id,
          title: clampString(tb.title, BLUEPRINT_LIMITS.TEXTBOOK_TITLE_MAX_LEN, ''),
          body: clampString(tb.body, BLUEPRINT_LIMITS.TEXTBOOK_BODY_MAX_LEN, ''),
          images: (tb.images || []).slice(0, BLUEPRINT_LIMITS.TEXTBOOK_IMAGES_MAX_COUNT),
          convertedBlocks: (tb.convertedBlocks || []).slice(0, BLUEPRINT_LIMITS.TEXTBOOK_BLOCKS_MAX_COUNT),
          sourcePageCount: tb.sourcePageCount ?? 0,
          updatedAtMs: tb.updatedAt,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      });

      const mem = (seed.kv[`memory:${chat.id}`] as ChatMemory | undefined) ?? {
        version: 2 as const,
        compactedCount: 0,
        compactedTokens: 0,
        epoch: 0,
        learnerState: [],
        packs: [],
        updatedAt: Date.now(),
      };
      childWrites.push({
        ref: doc(db, 'users', uid, 'chats', chat.id, 'workspace', 'memory'),
        data: stripUndefinedDeep({
          userId: uid,
          chatId: chat.id,
          version: 2,
          compactedCount: mem.compactedCount,
          compactedTokens: mem.compactedTokens,
          epoch: mem.epoch,
          learnerState: mem.learnerState.slice(0, BLUEPRINT_LIMITS.LEARNER_STATE_MAX_COUNT),
          packs: mem.packs.slice(0, BLUEPRINT_LIMITS.MEMORY_PACKS_MAX_COUNT),
          condensedArchive: mem.condensedArchive,
          lastError: mem.lastError,
          updatedAtMs: mem.updatedAt,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
      });

      const questions = (seed.kv[`questions:${chat.id}`] as StoredQuestion[] | undefined) ?? [];
      for (const q of questions) {
        childWrites.push({
          ref: doc(db, 'users', uid, 'chats', chat.id, 'questions', q.id),
          data: stripUndefinedDeep({
            id: q.id,
            userId: uid,
            chatId: chat.id,
            question: clampString(q.question, BLUEPRINT_LIMITS.QUESTION_MAX_LEN, 'Question'),
            answer: clampString(q.answer, BLUEPRINT_LIMITS.ANSWER_MAX_LEN, ''),
            flashcardId: q.flashcardId,
            createdAtMs: q.createdAt,
            updatedAtMs: q.updatedAt,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }),
        });
      }
    }

    for (const card of seed.cards) {
      childWrites.push({
        ref: doc(db, 'users', uid, 'flashcards', card.id),
        data: {
          id: card.id,
          userId: uid,
          chatId: card.chatId,
          questionId: card.questionId,
          question: clampString(card.question, BLUEPRINT_LIMITS.QUESTION_MAX_LEN, 'Question'),
          answer: clampString(card.answer, BLUEPRINT_LIMITS.ANSWER_MAX_LEN, ''),
          type: 'EXAM',
          status: card.status,
          subject: clampString(card.subject, BLUEPRINT_LIMITS.FLASHCARD_SUBJECT_MAX_LEN, 'General Study'),
          createdAtMs: card.createdAt,
          updatedAtMs: card.updatedAt,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      });
    }

    try {
      await parentBatch.commit();
      // Keep child batches small (6 docs * 2 hasOwnedChat reads <= 20 Firestore batch read cap).
      for (const chunk of chunkItems(childWrites, 6)) {
        const childBatch = writeBatch(db);
        for (const item of chunk) {
          childBatch.set(item.ref, item.data);
        }
        await childBatch.commit();
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${uid}`);
    }
  }

  private mapMessageDoc(data: Record<string, unknown>, id: string): ChatMessage {
    return stripUndefinedDeep({
      id,
      role: (data.role as ChatMessage['role']) || 'user',
      content: typeof data.content === 'string' ? data.content : '',
      createdAt: toNumber(data.createdAtMs, Date.now()),
      attachments: Array.isArray(data.attachments)
        ? (data.attachments as ChatAttachment[])
        : undefined,
      candidate: Array.isArray(data.candidate)
        ? (data.candidate as ChatMessage['candidate'])
        : undefined,
      candidateState:
        data.candidateState === 'active' || data.candidateState === 'resolved'
          ? data.candidateState
          : undefined,
      memoryStage:
        data.memoryStage === 1 || data.memoryStage === 2 || data.memoryStage === 3
          ? data.memoryStage
          : undefined,
      tokenUsage:
        data.tokenUsage && typeof data.tokenUsage === 'object'
          ? (data.tokenUsage as ChatMessage['tokenUsage'])
          : undefined,
    });
  }

  async listChats(uid: string): Promise<ChatItem[]> {
    const chatsPath = `users/${uid}/chats`;
    try {
      const chatsSnap = await getDocs(
        query(collection(db, 'users', uid, 'chats'), where('userId', '==', uid))
      );

      const items = await Promise.all(
        chatsSnap.docs.map(async (chatDoc) => {
          const data = chatDoc.data();
          const messagesPath = `users/${uid}/chats/${chatDoc.id}/messages`;
          let messages: ChatMessage[] = [];
          try {
            const msgSnap = await getDocs(
              query(
                collection(db, 'users', uid, 'chats', chatDoc.id, 'messages'),
                where('userId', '==', uid)
              )
            );
            messages = msgSnap.docs
              .map((d) => this.mapMessageDoc(d.data(), d.id))
              .sort((a, b) => a.createdAt - b.createdAt);
          } catch (err) {
            handleFirestoreError(err, OperationType.LIST, messagesPath);
          }

          return {
            id: chatDoc.id,
            title: typeof data.title === 'string' ? data.title : 'New study chat',
            messages,
            updatedAt: toNumber(data.updatedAtMs, Date.now()),
          } satisfies ChatItem;
        })
      );

      return items.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, chatsPath);
    }
  }

  subscribeChatsMetadata(
    uid: string,
    onChange: (chatsMeta: Array<{ id: string; title: string; updatedAt: number; messageCount: number }>) => void
  ): Unsubscribe {
    const chatsPath = `users/${uid}/chats`;
    return onSnapshot(
      query(collection(db, 'users', uid, 'chats'), where('userId', '==', uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: d.id,
              title: typeof data.title === 'string' ? data.title : 'New study chat',
              updatedAt: toNumber(data.updatedAtMs, Date.now()),
              messageCount: toNumber(data.messageCount, 0),
            };
          })
          .sort((a, b) => b.updatedAt - a.updatedAt);
        onChange(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, chatsPath)
    );
  }

  subscribeChatMessages(
    uid: string,
    chatId: string,
    onChange: (messages: ChatMessage[]) => void
  ): Unsubscribe {
    const messagesPath = `users/${uid}/chats/${chatId}/messages`;
    return onSnapshot(
      query(
        collection(db, 'users', uid, 'chats', chatId, 'messages'),
        where('userId', '==', uid)
      ),
      (snap) => {
        const messages = snap.docs
          .map((d) => this.mapMessageDoc(d.data(), d.id))
          .sort((a, b) => a.createdAt - b.createdAt);
        onChange(messages);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, messagesPath)
    );
  }

  async createChat(uid: string, title?: string): Promise<ChatItem> {
    const now = Date.now();
    const id = ensureValidId(undefined, 'chat');
    const resolvedTitle = clampString(
      title?.trim() || 'New study chat',
      BLUEPRINT_LIMITS.CHAT_TITLE_MAX_LEN,
      'New study chat'
    );
    const chatPath = `users/${uid}/chats/${id}`;
    const batch = writeBatch(db);

    batch.set(doc(db, 'users', uid, 'chats', id), {
      id,
      userId: uid,
      title: resolvedTitle,
      messageCount: 0,
      updatedAtMs: now,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'users', uid, 'chats', id, 'workspace', 'note'), {
      userId: uid,
      chatId: id,
      title: '',
      body: '',
      tags: [],
      images: [],
      updatedAtMs: now,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'users', uid, 'chats', id, 'workspace', 'textbook'), {
      userId: uid,
      chatId: id,
      title: '',
      body: '',
      images: [],
      convertedBlocks: [],
      sourcePageCount: 0,
      updatedAtMs: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'users', uid, 'chats', id, 'workspace', 'memory'), {
      userId: uid,
      chatId: id,
      version: 2,
      compactedCount: 0,
      compactedTokens: 0,
      epoch: 0,
      learnerState: [],
      packs: [],
      updatedAtMs: now,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, chatPath);
    }

    return {
      id,
      title: resolvedTitle,
      messages: [],
      updatedAt: now,
    };
  }

  async updateChat(
    uid: string,
    id: string,
    patch: Partial<Pick<ChatItem, 'title' | 'messages' | 'updatedAt'>>
  ): Promise<ChatItem> {
    const chatPath = `users/${uid}/chats/${id}`;
    const chatRef = doc(db, 'users', uid, 'chats', id);
    const updatedAtMs = typeof patch.updatedAt === 'number' ? patch.updatedAt : Date.now();

    let currentTitle = 'New study chat';
    try {
      const chatSnap = await getDoc(chatRef);
      if (!chatSnap.exists()) {
        throw new Error('Chat not found');
      }
      const existingData = chatSnap.data();
      currentTitle =
        typeof existingData.title === 'string' ? existingData.title : 'New study chat';
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, chatPath);
    }

    const nextTitle =
      typeof patch.title === 'string'
        ? clampString(patch.title.trim() || currentTitle, BLUEPRINT_LIMITS.CHAT_TITLE_MAX_LEN, currentTitle)
        : currentTitle;

    let syncedMessages: ChatMessage[] = [];
    if (Array.isArray(patch.messages)) {
      const messagesPath = `users/${uid}/chats/${id}/messages`;
      let existingDocs = new Map<string, Record<string, unknown>>();
      try {
        const msgSnap = await getDocs(
          query(
            collection(db, 'users', uid, 'chats', id, 'messages'),
            where('userId', '==', uid)
          )
        );
        existingDocs = new Map(msgSnap.docs.map((d) => [d.id, d.data()]));
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, messagesPath);
      }

      const incomingIds = new Set<string>();
      const preparedMessages: ChatMessage[] = [];

      for (const rawMsg of patch.messages) {
        const msgId = ensureValidId(rawMsg.id, 'msg');
        incomingIds.add(msgId);

        const compressedAttachments = rawMsg.attachments
          ? await Promise.all(
              rawMsg.attachments
                .slice(0, BLUEPRINT_LIMITS.MESSAGE_ATTACHMENTS_MAX_COUNT)
                .map((att) => compressAttachmentForFirestore(att))
            )
          : undefined;

        const cleanMsg: ChatMessage = {
          ...rawMsg,
          id: msgId,
          content: clampString(rawMsg.content, BLUEPRINT_LIMITS.MESSAGE_CONTENT_MAX_LEN, ''),
          ...(compressedAttachments ? { attachments: compressedAttachments } : {}),
        };
        preparedMessages.push(cleanMsg);

        const existingData = existingDocs.get(msgId);
        const msgRef = doc(db, 'users', uid, 'chats', id, 'messages', msgId);
        if (!existingData) {
          try {
            await setDoc(
              msgRef,
              stripUndefinedDeep({
                id: msgId,
                userId: uid,
                chatId: id,
                role: cleanMsg.role,
                content: cleanMsg.content,
                createdAtMs: cleanMsg.createdAt,
                attachments: cleanMsg.attachments,
                candidate: cleanMsg.candidate?.slice(0, BLUEPRINT_LIMITS.MESSAGE_CANDIDATES_MAX_COUNT),
                candidateState: cleanMsg.candidateState,
                memoryStage: cleanMsg.memoryStage,
                tokenUsage: cleanMsg.tokenUsage,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              })
            );
          } catch (err) {
            handleFirestoreError(err, OperationType.CREATE, `${messagesPath}/${msgId}`);
          }
        } else {
          const prevJson = JSON.stringify({
            content: existingData.content ?? '',
            candidate: existingData.candidate ?? null,
            candidateState: existingData.candidateState ?? null,
            tokenUsage: existingData.tokenUsage ?? null,
          });
          const nextJson = JSON.stringify({
            content: cleanMsg.content,
            candidate: cleanMsg.candidate ?? null,
            candidateState: cleanMsg.candidateState ?? null,
            tokenUsage: cleanMsg.tokenUsage ?? null,
          });
          if (prevJson !== nextJson) {
            try {
              await updateDoc(msgRef, {
                content: cleanMsg.content,
                candidate: cleanMsg.candidate
                  ? stripUndefinedDeep(
                      cleanMsg.candidate.slice(0, BLUEPRINT_LIMITS.MESSAGE_CANDIDATES_MAX_COUNT)
                    )
                  : deleteField(),
                candidateState: cleanMsg.candidateState ?? deleteField(),
                tokenUsage: cleanMsg.tokenUsage ? stripUndefinedDeep(cleanMsg.tokenUsage) : deleteField(),
                updatedAt: serverTimestamp(),
              });
            } catch (err) {
              handleFirestoreError(err, OperationType.UPDATE, `${messagesPath}/${msgId}`);
            }
          }
        }
      }

      for (const oldId of existingDocs.keys()) {
        if (!incomingIds.has(oldId)) {
          try {
            await deleteDoc(doc(db, 'users', uid, 'chats', id, 'messages', oldId));
          } catch (err) {
            handleFirestoreError(err, OperationType.DELETE, `${messagesPath}/${oldId}`);
          }
        }
      }

      syncedMessages = preparedMessages;
    } else {
      const msgSnap = await getDocs(
        query(collection(db, 'users', uid, 'chats', id, 'messages'), where('userId', '==', uid))
      ).catch((err) => handleFirestoreError(err, OperationType.LIST, `${chatPath}/messages`));
      syncedMessages = msgSnap.docs
        .map((d) => this.mapMessageDoc(d.data(), d.id))
        .sort((a, b) => a.createdAt - b.createdAt);
    }

    try {
      const chatPatch: Record<string, unknown> = {
        updatedAtMs,
        updatedAt: serverTimestamp(),
      };
      if (typeof patch.title === 'string') {
        chatPatch.title = nextTitle;
      }
      if (Array.isArray(patch.messages)) {
        chatPatch.messageCount = syncedMessages.length;
      }
      await updateDoc(chatRef, chatPatch);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, chatPath);
    }

    return {
      id,
      title: nextTitle,
      messages: syncedMessages,
      updatedAt: updatedAtMs,
    };
  }

  async deleteChat(uid: string, id: string): Promise<void> {
    const chatPath = `users/${uid}/chats/${id}`;
    try {
      const [msgSnap, figSnap, qSnap, cardsSnap] = await Promise.all([
        getDocs(query(collection(db, 'users', uid, 'chats', id, 'messages'), where('userId', '==', uid))),
        getDocs(
          query(collection(db, 'users', uid, 'chats', id, 'textbookFigures'), where('userId', '==', uid))
        ),
        getDocs(query(collection(db, 'users', uid, 'chats', id, 'questions'), where('userId', '==', uid))),
        getDocs(query(collection(db, 'users', uid, 'flashcards'), where('userId', '==', uid))),
      ]);

      const refsToDelete = [
        ...msgSnap.docs.map((d) => d.ref),
        ...figSnap.docs.map((d) => d.ref),
        ...qSnap.docs.map((d) => d.ref),
        ...cardsSnap.docs.filter((d) => d.data().chatId === id).map((d) => d.ref),
        doc(db, 'users', uid, 'chats', id, 'workspace', 'note'),
        doc(db, 'users', uid, 'chats', id, 'workspace', 'textbook'),
        doc(db, 'users', uid, 'chats', id, 'workspace', 'memory'),
      ];

      for (const chunk of chunkItems(refsToDelete, 400)) {
        const batch = writeBatch(db);
        for (const ref of chunk) {
          batch.delete(ref);
        }
        await batch.commit();
      }

      await deleteDoc(doc(db, 'users', uid, 'chats', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, chatPath);
    }
  }

  async getNote(uid: string, chatId: string): Promise<NoteData | null> {
    const notePath = `users/${uid}/chats/${chatId}/workspace/note`;
    try {
      const snap = await getDoc(doc(db, 'users', uid, 'chats', chatId, 'workspace', 'note'));
      if (!snap.exists()) return null;
      const d = snap.data();
      return {
        title: typeof d.title === 'string' ? d.title : '',
        body: typeof d.body === 'string' ? d.body : '',
        tags: Array.isArray(d.tags) ? (d.tags as string[]) : [],
        images: Array.isArray(d.images) ? (d.images as ChatAttachment[]) : [],
        updatedAt: toNumber(d.updatedAtMs, Date.now()),
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, notePath);
    }
  }

  async saveNote(uid: string, chatId: string, note: NoteData): Promise<NoteData> {
    const notePath = `users/${uid}/chats/${chatId}/workspace/note`;
    const noteRef = doc(db, 'users', uid, 'chats', chatId, 'workspace', 'note');

    const compressedImages = await Promise.all(
      (note.images || [])
        .slice(0, BLUEPRINT_LIMITS.NOTE_IMAGES_MAX_COUNT)
        .map((img) => compressAttachmentForFirestore(img, 240_000))
    );

    const payload = stripUndefinedDeep({
      title: clampString(note.title, BLUEPRINT_LIMITS.NOTE_TITLE_MAX_LEN, ''),
      body: clampString(note.body, BLUEPRINT_LIMITS.NOTE_BODY_MAX_LEN, ''),
      tags: (note.tags || [])
        .slice(0, BLUEPRINT_LIMITS.NOTE_TAGS_MAX_COUNT)
        .map((t) => clampString(t, BLUEPRINT_LIMITS.NOTE_TAG_MAX_LEN, ''))
        .filter(Boolean),
      images: compressedImages,
      updatedAtMs: toNumber(note.updatedAt, Date.now()),
    });

    try {
      const snap = await getDoc(noteRef);
      if (snap.exists()) {
        await updateDoc(noteRef, {
          ...payload,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(noteRef, {
          userId: uid,
          chatId,
          ...payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      return {
        title: payload.title,
        body: payload.body,
        tags: payload.tags,
        images: payload.images,
        updatedAt: payload.updatedAtMs,
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, notePath);
    }
  }

  async getTextbook(uid: string, chatId: string): Promise<TextbookData | null> {
    const tbPath = `users/${uid}/chats/${chatId}/workspace/textbook`;
    const figsPath = `users/${uid}/chats/${chatId}/textbookFigures`;
    try {
      const [tbSnap, figsSnap] = await Promise.all([
        getDoc(doc(db, 'users', uid, 'chats', chatId, 'workspace', 'textbook')),
        getDocs(
          query(
            collection(db, 'users', uid, 'chats', chatId, 'textbookFigures'),
            where('userId', '==', uid)
          )
        ),
      ]);
      if (!tbSnap.exists()) return null;
      const d = tbSnap.data();
      const convertedFigures: TextbookFigure[] = figsSnap.docs
        .map((fDoc) => {
          const fd = fDoc.data();
          return stripUndefinedDeep({
            id: fDoc.id,
            code: typeof fd.code === 'string' ? fd.code : undefined,
            pageNumber: toNumber(fd.pageNumber, 0),
            caption: typeof fd.caption === 'string' ? fd.caption : '',
            image: fd.image as ChatAttachment,
          });
        })
        .sort((a, b) => (a.pageNumber - b.pageNumber) || (a.code || '').localeCompare(b.code || ''));

      return {
        title: typeof d.title === 'string' ? d.title : '',
        body: typeof d.body === 'string' ? d.body : '',
        images: Array.isArray(d.images) ? (d.images as ChatAttachment[]) : [],
        convertedBlocks: Array.isArray(d.convertedBlocks)
          ? (d.convertedBlocks as TextbookConvertedBlock[])
          : [],
        convertedFigures,
        sourcePageCount: toNumber(d.sourcePageCount, 0),
        updatedAt: toNumber(d.updatedAtMs, 0),
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `${tbPath} / ${figsPath}`);
    }
  }

  async saveTextbook(uid: string, chatId: string, textbook: TextbookData): Promise<TextbookData> {
    const tbPath = `users/${uid}/chats/${chatId}/workspace/textbook`;
    const figsPath = `users/${uid}/chats/${chatId}/textbookFigures`;
    const tbRef = doc(db, 'users', uid, 'chats', chatId, 'workspace', 'textbook');

    const hasConvertedFigures = (textbook.convertedFigures?.length ?? 0) > 0;
    const compressedLegacyImages = hasConvertedFigures
      ? []
      : await Promise.all(
          (textbook.images || [])
            .slice(0, BLUEPRINT_LIMITS.TEXTBOOK_IMAGES_MAX_COUNT)
            .map((img) => compressAttachmentForFirestore(img, 240_000))
        );

    const blocks = (textbook.convertedBlocks || [])
      .slice(0, BLUEPRINT_LIMITS.TEXTBOOK_BLOCKS_MAX_COUNT)
      .map((block) => stripUndefinedDeep(block));

    const tbPayload = {
      title: clampString(textbook.title, BLUEPRINT_LIMITS.TEXTBOOK_TITLE_MAX_LEN, ''),
      body: clampString(textbook.body, BLUEPRINT_LIMITS.TEXTBOOK_BODY_MAX_LEN, ''),
      images: compressedLegacyImages,
      convertedBlocks: blocks,
      sourcePageCount: toNumber(textbook.sourcePageCount, 0),
      updatedAtMs: toNumber(textbook.updatedAt, Date.now()),
    };

    try {
      const tbSnap = await getDoc(tbRef);
      if (tbSnap.exists()) {
        await updateDoc(tbRef, {
          ...tbPayload,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(tbRef, {
          userId: uid,
          chatId,
          ...tbPayload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      // Sync textbookFigures subcollection
      const existingFigsSnap = await getDocs(
        query(
          collection(db, 'users', uid, 'chats', chatId, 'textbookFigures'),
          where('userId', '==', uid)
        )
      );
      const existingFigMap = new Map(existingFigsSnap.docs.map((d) => [d.id, d.data()]));
      const incomingFigIds = new Set<string>();
      const savedFigures: TextbookFigure[] = [];

      for (const fig of textbook.convertedFigures || []) {
        const figId = ensureValidId(fig.id, 'fig');
        incomingFigIds.add(figId);
        const compressedImg = await compressAttachmentForFirestore(fig.image, 520_000);
        const figFields = stripUndefinedDeep({
          code: fig.code ? clampString(fig.code, BLUEPRINT_LIMITS.TEXTBOOK_CODE_MAX_LEN, '') : undefined,
          pageNumber: toNumber(fig.pageNumber, 0),
          caption: clampString(fig.caption, BLUEPRINT_LIMITS.TEXTBOOK_CAPTION_MAX_LEN, ''),
          image: stripUndefinedDeep(compressedImg),
        });
        savedFigures.push({
          id: figId,
          ...figFields,
        });

        const figRef = doc(db, 'users', uid, 'chats', chatId, 'textbookFigures', figId);
        const existingFig = existingFigMap.get(figId);
        if (!existingFig) {
          await setDoc(figRef, {
            id: figId,
            userId: uid,
            chatId,
            ...figFields,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          const changed =
            (existingFig.code ?? undefined) !== figFields.code ||
            existingFig.pageNumber !== figFields.pageNumber ||
            existingFig.caption !== figFields.caption ||
            JSON.stringify(existingFig.image) !== JSON.stringify(figFields.image);
          if (changed) {
            await updateDoc(figRef, {
              code: figFields.code ?? deleteField(),
              pageNumber: figFields.pageNumber,
              caption: figFields.caption,
              image: figFields.image,
              updatedAt: serverTimestamp(),
            });
          }
        }
      }

      for (const oldId of existingFigMap.keys()) {
        if (!incomingFigIds.has(oldId)) {
          await deleteDoc(doc(db, 'users', uid, 'chats', chatId, 'textbookFigures', oldId));
        }
      }

      return {
        ...tbPayload,
        convertedFigures: savedFigures,
        updatedAt: tbPayload.updatedAtMs,
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `${tbPath} / ${figsPath}`);
    }
  }

  async getQuestions(uid: string, chatId: string): Promise<StoredQuestion[]> {
    const qPath = `users/${uid}/chats/${chatId}/questions`;
    try {
      const snap = await getDocs(
        query(collection(db, 'users', uid, 'chats', chatId, 'questions'), where('userId', '==', uid))
      );
      return snap.docs
        .map((d) => {
          const data = d.data();
          return stripUndefinedDeep({
            id: d.id,
            question: typeof data.question === 'string' ? data.question : '',
            answer: typeof data.answer === 'string' ? data.answer : '',
            flashcardId: typeof data.flashcardId === 'string' ? data.flashcardId : undefined,
            createdAt: toNumber(data.createdAtMs, Date.now()),
            updatedAt: toNumber(data.updatedAtMs, Date.now()),
          });
        })
        .sort((a, b) => a.createdAt - b.createdAt);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, qPath);
    }
  }

  async saveQuestions(
    uid: string,
    chatId: string,
    questions: StoredQuestion[]
  ): Promise<StoredQuestion[]> {
    const qPath = `users/${uid}/chats/${chatId}/questions`;
    try {
      const existingSnap = await getDocs(
        query(collection(db, 'users', uid, 'chats', chatId, 'questions'), where('userId', '==', uid))
      );
      const existingMap = new Map(existingSnap.docs.map((d) => [d.id, d.data()]));
      const incomingIds = new Set<string>();
      const saved: StoredQuestion[] = [];

      for (const q of questions) {
        const qId = ensureValidId(q.id, 'q');
        incomingIds.add(qId);
        const cleanQuestion = clampString(q.question.trim() || 'Question', BLUEPRINT_LIMITS.QUESTION_MAX_LEN, 'Question');
        const cleanAnswer = clampString(q.answer, BLUEPRINT_LIMITS.ANSWER_MAX_LEN, '');
        const cleanFlashcardId =
          q.flashcardId && isValidBlueprintId(q.flashcardId) ? q.flashcardId : undefined;
        const createdAtMs = toNumber(q.createdAt, Date.now());
        const updatedAtMs = toNumber(q.updatedAt, Date.now());

        const outQ: StoredQuestion = stripUndefinedDeep({
          id: qId,
          question: cleanQuestion,
          answer: cleanAnswer,
          flashcardId: cleanFlashcardId,
          createdAt: createdAtMs,
          updatedAt: updatedAtMs,
        });
        saved.push(outQ);

        const qRef = doc(db, 'users', uid, 'chats', chatId, 'questions', qId);
        const prev = existingMap.get(qId);
        if (!prev) {
          await setDoc(
            qRef,
            stripUndefinedDeep({
              id: qId,
              userId: uid,
              chatId,
              question: cleanQuestion,
              answer: cleanAnswer,
              flashcardId: cleanFlashcardId,
              createdAtMs,
              updatedAtMs,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            })
          );
        } else {
          const changed =
            prev.question !== cleanQuestion ||
            prev.answer !== cleanAnswer ||
            (prev.flashcardId ?? undefined) !== cleanFlashcardId ||
            prev.updatedAtMs !== updatedAtMs;
          if (changed) {
            await updateDoc(qRef, {
              question: cleanQuestion,
              answer: cleanAnswer,
              flashcardId: cleanFlashcardId ?? deleteField(),
              updatedAtMs,
              updatedAt: serverTimestamp(),
            });
          }
        }
      }

      for (const oldId of existingMap.keys()) {
        if (!incomingIds.has(oldId)) {
          await deleteDoc(doc(db, 'users', uid, 'chats', chatId, 'questions', oldId));
        }
      }

      return saved;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, qPath);
    }
  }

  async getMemory(uid: string, chatId: string): Promise<ChatMemory | null> {
    const memPath = `users/${uid}/chats/${chatId}/workspace/memory`;
    try {
      const snap = await getDoc(doc(db, 'users', uid, 'chats', chatId, 'workspace', 'memory'));
      if (!snap.exists()) return null;
      const d = snap.data();
      return stripUndefinedDeep({
        version: 2 as const,
        compactedCount: toNumber(d.compactedCount, 0),
        compactedTokens: toNumber(d.compactedTokens, 0),
        epoch: toNumber(d.epoch, 0),
        learnerState: Array.isArray(d.learnerState)
          ? (d.learnerState as ChatMemory['learnerState'])
          : [],
        packs: Array.isArray(d.packs) ? (d.packs as ChatMemory['packs']) : [],
        condensedArchive:
          typeof d.condensedArchive === 'string' ? d.condensedArchive : undefined,
        lastError: typeof d.lastError === 'string' ? d.lastError : undefined,
        updatedAt: toNumber(d.updatedAtMs, Date.now()),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, memPath);
    }
  }

  async saveMemory(uid: string, chatId: string, memory: ChatMemory): Promise<ChatMemory> {
    const memPath = `users/${uid}/chats/${chatId}/workspace/memory`;
    const memRef = doc(db, 'users', uid, 'chats', chatId, 'workspace', 'memory');
    const cleanLearnerState = stripUndefinedDeep(
      (memory.learnerState || []).slice(0, BLUEPRINT_LIMITS.LEARNER_STATE_MAX_COUNT)
    );
    const cleanPacks = stripUndefinedDeep(
      (memory.packs || []).slice(0, BLUEPRINT_LIMITS.MEMORY_PACKS_MAX_COUNT)
    );
    const cleanArchive =
      typeof memory.condensedArchive === 'string'
        ? clampString(memory.condensedArchive, BLUEPRINT_LIMITS.CONDENSED_ARCHIVE_MAX_LEN, '')
        : undefined;
    const cleanError =
      typeof memory.lastError === 'string' && memory.lastError.length > 0
        ? clampString(memory.lastError, BLUEPRINT_LIMITS.MEMORY_ERROR_MAX_LEN, '')
        : undefined;
    const updatedAtMs = toNumber(memory.updatedAt, Date.now());

    try {
      const snap = await getDoc(memRef);
      if (snap.exists()) {
        await updateDoc(memRef, {
          compactedCount: toNumber(memory.compactedCount, 0),
          compactedTokens: toNumber(memory.compactedTokens, 0),
          epoch: toNumber(memory.epoch, 0),
          learnerState: cleanLearnerState,
          packs: cleanPacks,
          condensedArchive: cleanArchive ?? deleteField(),
          lastError: cleanError ?? deleteField(),
          updatedAtMs,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(
          memRef,
          stripUndefinedDeep({
            userId: uid,
            chatId,
            version: 2,
            compactedCount: toNumber(memory.compactedCount, 0),
            compactedTokens: toNumber(memory.compactedTokens, 0),
            epoch: toNumber(memory.epoch, 0),
            learnerState: cleanLearnerState,
            packs: cleanPacks,
            condensedArchive: cleanArchive,
            lastError: cleanError,
            updatedAtMs,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      }

      return stripUndefinedDeep({
        version: 2 as const,
        compactedCount: toNumber(memory.compactedCount, 0),
        compactedTokens: toNumber(memory.compactedTokens, 0),
        epoch: toNumber(memory.epoch, 0),
        learnerState: cleanLearnerState,
        packs: cleanPacks,
        condensedArchive: cleanArchive,
        lastError: cleanError,
        updatedAt: updatedAtMs,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, memPath);
    }
  }

  async listCards(uid: string, chatId?: string): Promise<FlashcardItem[]> {
    const cardsPath = `users/${uid}/flashcards`;
    try {
      const snap = await getDocs(
        query(collection(db, 'users', uid, 'flashcards'), where('userId', '==', uid))
      );
      const cards = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          chatId: typeof data.chatId === 'string' ? data.chatId : '',
          questionId: typeof data.questionId === 'string' ? data.questionId : '',
          question: typeof data.question === 'string' ? data.question : '',
          answer: typeof data.answer === 'string' ? data.answer : '',
          type: 'EXAM' as const,
          status:
            data.status === 'LEARNING' || data.status === 'MASTERED' ? data.status : ('NEW' as const),
          subject: typeof data.subject === 'string' ? data.subject : 'General Study',
          createdAt: toNumber(data.createdAtMs, Date.now()),
          updatedAt: toNumber(data.updatedAtMs, Date.now()),
        } satisfies FlashcardItem;
      });
      return chatId ? cards.filter((c) => c.chatId === chatId) : cards;
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, cardsPath);
    }
  }

  async createCard(
    uid: string,
    input: {
      chatId: string;
      questionId: string;
      question: string;
      answer: string;
      subject: string;
    }
  ): Promise<FlashcardItem> {
    const now = Date.now();
    const id = ensureValidId(undefined, 'fc');
    const cardPath = `users/${uid}/flashcards/${id}`;
    const card: FlashcardItem = {
      id,
      chatId: ensureValidId(input.chatId, 'chat'),
      questionId: ensureValidId(input.questionId, 'q'),
      question: clampString(input.question.trim() || 'Question', BLUEPRINT_LIMITS.QUESTION_MAX_LEN, 'Question'),
      answer: clampString(input.answer, BLUEPRINT_LIMITS.ANSWER_MAX_LEN, ''),
      type: 'EXAM',
      status: 'NEW',
      subject: clampString(
        input.subject?.trim() || 'General Study',
        BLUEPRINT_LIMITS.FLASHCARD_SUBJECT_MAX_LEN,
        'General Study'
      ),
      createdAt: now,
      updatedAt: now,
    };

    try {
      await setDoc(doc(db, 'users', uid, 'flashcards', id), {
        id: card.id,
        userId: uid,
        chatId: card.chatId,
        questionId: card.questionId,
        question: card.question,
        answer: card.answer,
        type: card.type,
        status: card.status,
        subject: card.subject,
        createdAtMs: card.createdAt,
        updatedAtMs: card.updatedAt,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return card;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, cardPath);
    }
  }

  async updateCard(
    uid: string,
    id: string,
    patch: Partial<Pick<FlashcardItem, 'question' | 'answer' | 'status' | 'subject'>>
  ): Promise<FlashcardItem> {
    const cardPath = `users/${uid}/flashcards/${id}`;
    const cardRef = doc(db, 'users', uid, 'flashcards', id);
    const now = Date.now();

    try {
      const snap = await getDoc(cardRef);
      if (!snap.exists()) {
        throw new Error('Card not found');
      }
      const d = snap.data();
      const nextQuestion =
        typeof patch.question === 'string'
          ? clampString(patch.question.trim() || 'Question', BLUEPRINT_LIMITS.QUESTION_MAX_LEN, 'Question')
          : typeof d.question === 'string'
            ? d.question
            : 'Question';
      const nextAnswer =
        typeof patch.answer === 'string'
          ? clampString(patch.answer, BLUEPRINT_LIMITS.ANSWER_MAX_LEN, '')
          : typeof d.answer === 'string'
            ? d.answer
            : '';
      const nextStatus = patch.status ?? (d.status as FlashcardItem['status']) ?? 'NEW';
      const nextSubject =
        typeof patch.subject === 'string'
          ? clampString(
              patch.subject.trim() || 'General Study',
              BLUEPRINT_LIMITS.FLASHCARD_SUBJECT_MAX_LEN,
              'General Study'
            )
          : typeof d.subject === 'string'
            ? d.subject
            : 'General Study';

      await updateDoc(cardRef, {
        question: nextQuestion,
        answer: nextAnswer,
        status: nextStatus,
        subject: nextSubject,
        updatedAtMs: now,
        updatedAt: serverTimestamp(),
      });

      return {
        id,
        chatId: typeof d.chatId === 'string' ? d.chatId : '',
        questionId: typeof d.questionId === 'string' ? d.questionId : '',
        question: nextQuestion,
        answer: nextAnswer,
        type: 'EXAM',
        status: nextStatus,
        subject: nextSubject,
        createdAt: toNumber(d.createdAtMs, now),
        updatedAt: now,
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, cardPath);
    }
  }

  async deleteCard(uid: string, id: string): Promise<void> {
    const cardPath = `users/${uid}/flashcards/${id}`;
    try {
      await deleteDoc(doc(db, 'users', uid, 'flashcards', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, cardPath);
    }
  }

  async listSubjects(uid: string): Promise<string[]> {
    const settingsPath = `users/${uid}/settings/app`;
    try {
      const snap = await getDoc(doc(db, 'users', uid, 'settings', 'app'));
      if (!snap.exists()) return [...DEFAULT_SUBJECTS];
      const d = snap.data();
      return Array.isArray(d.subjects) ? (d.subjects as string[]) : [...DEFAULT_SUBJECTS];
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, settingsPath);
    }
  }

  async getSettings(uid: string): Promise<AppSettings> {
    const settingsPath = `users/${uid}/settings/app`;
    try {
      const snap = await getDoc(doc(db, 'users', uid, 'settings', 'app'));
      const d = snap.exists() ? snap.data() : null;
      const geminiModel =
        d?.geminiModel && VALID_GEMINI_MODELS.includes(d.geminiModel)
          ? (d.geminiModel as AppSettings['geminiModel'])
          : 'gemini-4-hydrogen';
      const thinkingLevel =
        d?.thinkingLevel && ['low', 'medium', 'high', 'xhigh'].includes(d.thinkingLevel)
          ? normalizeThinkingLevelForModel(d.thinkingLevel, geminiModel)
          : 'medium';
      const themeMode =
        d?.themeMode && ['system', 'light', 'dark'].includes(d.themeMode)
          ? (d.themeMode as AppSettings['themeMode'])
          : 'system';
      return {
        provider: 'gemini',
        geminiModel,
        thinkingLevel,
        themeMode,
        chatModel: geminiModel,
        sttModel: DEFAULT_STT_MODEL,
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, settingsPath);
    }
  }

  async updateSettings(
    uid: string,
    patch: Partial<Pick<AppSettings, 'provider' | 'geminiModel' | 'thinkingLevel' | 'themeMode'>>
  ): Promise<AppSettings> {
    const settingsPath = `users/${uid}/settings/app`;
    const settingsRef = doc(db, 'users', uid, 'settings', 'app');

    try {
      const snap = await getDoc(settingsRef);
      const current = snap.exists() ? snap.data() : {};
      const nextModel =
        patch.geminiModel && VALID_GEMINI_MODELS.includes(patch.geminiModel)
          ? patch.geminiModel
          : current.geminiModel && VALID_GEMINI_MODELS.includes(current.geminiModel)
            ? (current.geminiModel as AppSettings['geminiModel'])
            : 'gemini-4-hydrogen';
      const rawThinking =
        patch.thinkingLevel && ['low', 'medium', 'high', 'xhigh'].includes(patch.thinkingLevel)
          ? patch.thinkingLevel
          : current.thinkingLevel && ['low', 'medium', 'high', 'xhigh'].includes(current.thinkingLevel)
            ? (current.thinkingLevel as AppSettings['thinkingLevel'])
            : 'medium';
      const nextThinking = normalizeThinkingLevelForModel(rawThinking, nextModel);
      const nextTheme =
        patch.themeMode && ['system', 'light', 'dark'].includes(patch.themeMode)
          ? patch.themeMode
          : current.themeMode && ['system', 'light', 'dark'].includes(current.themeMode)
            ? (current.themeMode as AppSettings['themeMode'])
            : 'system';
      const nextSubjects = Array.isArray(current.subjects)
        ? (current.subjects as string[]).slice(0, BLUEPRINT_LIMITS.SUBJECT_MAX_COUNT)
        : [...DEFAULT_SUBJECTS];

      if (snap.exists()) {
        await updateDoc(settingsRef, {
          provider: 'gemini',
          geminiModel: nextModel,
          thinkingLevel: nextThinking,
          themeMode: nextTheme,
          subjects: nextSubjects,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(settingsRef, {
          userId: uid,
          provider: 'gemini',
          geminiModel: nextModel,
          thinkingLevel: nextThinking,
          themeMode: nextTheme,
          subjects: nextSubjects,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      return {
        provider: 'gemini',
        geminiModel: nextModel,
        thinkingLevel: nextThinking,
        themeMode: nextTheme,
        chatModel: nextModel,
        sttModel: DEFAULT_STT_MODEL,
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, settingsPath);
    }
  }
}

export const firestoreWorkspaceStore = new FirestoreWorkspaceStore();
