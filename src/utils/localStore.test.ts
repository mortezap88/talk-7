import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalWorkspaceStore,
  MemoryStorageBackend,
} from './localStore';
import type { NoteData, StoredQuestion } from '../types/talk';

test('LocalWorkspaceStore seeds initial workspace on first load and persists mutations across reloads', async () => {
  const backend = new MemoryStorageBackend();
  const store1 = new LocalWorkspaceStore(backend);

  const initialChats = await store1.listChats();
  assert.equal(initialChats.length, 2);
  assert.equal(initialChats[0].id, 'chat_bio_bohr');

  const created = await store1.createChat('Thermodynamics Review');
  assert.equal(created.title, 'Thermodynamics Review');

  await store1.setKv<NoteData>(`note:${created.id}`, {
    title: 'Entropy',
    body: 'dS >= dQ / T',
    tags: ['physics'],
    updatedAt: 12345,
  });

  const q: StoredQuestion = {
    id: 'q_thermo_1',
    question: 'What is the Second Law?',
    answer: 'Total entropy of an isolated system never decreases.',
    createdAt: 12345,
    updatedAt: 12345,
  };
  const card = await store1.createCard({
    chatId: created.id,
    questionId: q.id,
    question: q.question,
    answer: q.answer,
    subject: created.title,
  });
  await store1.setKv(`questions:${created.id}`, [{ ...q, flashcardId: card.id }]);

  await store1.updateSettings({
    themeMode: 'dark',
    geminiModel: 'gemini-3.8-flash',
    thinkingLevel: 'high',
  });

  // Simulate full browser reload with a fresh store instance backed by the same storage
  const store2 = new LocalWorkspaceStore(backend);
  const reloadedChats = await store2.listChats();
  assert.equal(reloadedChats.length, 3);
  assert.equal(reloadedChats[0].id, created.id);

  const reloadedNote = await store2.getKv<NoteData>(`note:${created.id}`);
  assert.equal(reloadedNote?.title, 'Entropy');
  assert.equal(reloadedNote?.body, 'dS >= dQ / T');

  const reloadedCards = await store2.listCards(created.id);
  assert.equal(reloadedCards.length, 1);
  assert.equal(reloadedCards[0].question, 'What is the Second Law?');

  const reloadedSettings = await store2.getSettings();
  assert.equal(reloadedSettings.themeMode, 'dark');
  assert.equal(reloadedSettings.geminiModel, 'gemini-3.8-flash');
  assert.equal(reloadedSettings.thinkingLevel, 'high');
});

test('LocalWorkspaceStore deletes chat and cascades to KV entries and flashcards', async () => {
  const backend = new MemoryStorageBackend();
  const store = new LocalWorkspaceStore(backend);

  const chat = await store.createChat('Temporary Chat');
  await store.createCard({
    chatId: chat.id,
    questionId: 'q_tmp',
    question: 'Temp Q',
    answer: 'Temp A',
    subject: 'Temp',
  });
  assert.equal((await store.listCards(chat.id)).length, 1);

  await store.deleteChat(chat.id);
  assert.equal(await store.getKv(`note:${chat.id}`), null);
  assert.equal(await store.getKv(`questions:${chat.id}`), null);
  assert.equal(await store.getKv(`memory:${chat.id}`), null);
  assert.equal(await store.getKv(`textbook:${chat.id}`), null);
  assert.equal((await store.listCards(chat.id)).length, 0);
});

test('LocalWorkspaceStore exports, imports, rejects invalid backups, and resets to default', async () => {
  const backend = new MemoryStorageBackend();
  const store = new LocalWorkspaceStore(backend);

  const custom = await store.createChat('Custom Session');
  await store.updateSettings({ themeMode: 'light' });
  const exported = await store.exportWorkspace();

  await store.resetWorkspace();
  const afterResetChats = await store.listChats();
  assert.equal(afterResetChats.length, 2);
  assert.equal(afterResetChats.some((c) => c.id === custom.id), false);
  assert.equal((await store.getSettings()).themeMode, 'system');

  await assert.rejects(
    () => store.importWorkspace({ chats: [] }),
    /Invalid Talk workspace backup file/
  );

  await store.importWorkspace(exported);
  const afterImportChats = await store.listChats();
  assert.equal(afterImportChats.length, 3);
  assert.equal(afterImportChats.some((c) => c.id === custom.id), true);
  assert.equal((await store.getSettings()).themeMode, 'light');
});
