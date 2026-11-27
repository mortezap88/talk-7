import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BLUEPRINT_LIMITS,
  isValidBlueprintId,
  stripUndefinedDeep,
  validateAppSettingsPayload,
  validateChatMessagePayload,
  validateChatPayload,
  validateUserProfilePayload,
} from './src/firebase/schemaConstraints.ts';

const NOW_TOKEN = { _sentinel: 'serverTimestamp' };

test('firestore.rules includes default-deny catch-all, email_verified check, null-safe get/delete, and all blueprint collections', () => {
  const rules = fs.readFileSync('firestore.rules', 'utf8');
  assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  assert.match(rules, /request\.auth\.token\.email_verified == true/);
  assert.match(rules, /\(resource == null \|\| existing\(\)\.uid == request\.auth\.uid\)/);
  assert.match(rules, /\(resource == null \|\| existing\(\)\.userId == request\.auth\.uid\)/);
  for (const pathSegment of [
    '/private/profile',
    '/settings/app',
    '/flashcards/{cardId}',
    '/chats/{chatId}',
    '/messages/{messageId}',
    '/workspace/note',
    '/workspace/textbook',
    '/workspace/memory',
    '/textbookFigures/{figureId}',
    '/questions/{questionId}',
  ]) {
    assert.ok(rules.includes(pathSegment), `Expected rule match block for ${pathSegment}`);
  }
});

test('Dirty Dozen security payloads are rejected by blueprint validators', () => {
  const validCtx = { authUid: 'user_alice', emailVerified: true, parentChatOwnerUid: 'user_alice' };

  // 1. Cross-user access
  assert.equal(
    validateChatPayload(
      {
        id: 'chat_1',
        userId: 'user_bob',
        title: 'Study',
        messageCount: 0,
        updatedAtMs: 1,
        createdAt: NOW_TOKEN,
        updatedAt: NOW_TOKEN,
      },
      validCtx,
      'user_bob',
      'chat_1'
    ),
    false
  );

  // 2. Unverified email write
  assert.equal(
    validateChatPayload(
      {
        id: 'chat_1',
        userId: 'user_alice',
        title: 'Study',
        messageCount: 0,
        updatedAtMs: 1,
        createdAt: NOW_TOKEN,
        updatedAt: NOW_TOKEN,
      },
      { authUid: 'user_alice', emailVerified: false },
      'user_alice',
      'chat_1'
    ),
    false
  );

  // 3. Owner spoofing on create
  assert.equal(
    validateChatPayload(
      {
        id: 'chat_1',
        userId: 'user_bob',
        title: 'Study',
        messageCount: 0,
        updatedAtMs: 1,
        createdAt: NOW_TOKEN,
        updatedAt: NOW_TOKEN,
      },
      validCtx,
      'user_alice',
      'chat_1'
    ),
    false
  );

  // 4 & 5. Ghost/shadow field injection (isAdmin: true)
  assert.equal(
    validateUserProfilePayload(
      {
        uid: 'user_alice',
        email: 'alice@example.com',
        displayName: 'Alice',
        photoURL: '',
        isAdmin: true,
        createdAt: NOW_TOKEN,
        updatedAt: NOW_TOKEN,
      },
      validCtx,
      'user_alice'
    ),
    false
  );

  // 6. ID poisoning (invalid characters or > 128 chars)
  assert.equal(isValidBlueprintId('bad..id/with$chars'), false);
  assert.equal(isValidBlueprintId('a'.repeat(BLUEPRINT_LIMITS.ID_MAX_LEN + 1)), false);

  // 8. Orphaned message write without parent chat
  assert.equal(
    validateChatMessagePayload(
      {
        id: 'msg_1',
        userId: 'user_alice',
        chatId: 'chat_missing',
        role: 'user',
        content: 'Hello',
        createdAtMs: 1,
        createdAt: NOW_TOKEN,
        updatedAt: NOW_TOKEN,
      },
      { authUid: 'user_alice', emailVerified: true, parentChatOwnerUid: null },
      'user_alice',
      'chat_missing',
      'msg_1'
    ),
    false
  );

  // 9. Resource exhaustion (> 200,000 chars or > 32 subjects)
  assert.equal(
    validateChatMessagePayload(
      {
        id: 'msg_1',
        userId: 'user_alice',
        chatId: 'chat_1',
        role: 'user',
        content: 'x'.repeat(BLUEPRINT_LIMITS.MESSAGE_CONTENT_MAX_LEN + 1),
        createdAtMs: 1,
        createdAt: NOW_TOKEN,
        updatedAt: NOW_TOKEN,
      },
      validCtx,
      'user_alice',
      'chat_1',
      'msg_1'
    ),
    false
  );

  // 10. Invalid enum value
  assert.equal(
    validateAppSettingsPayload(
      {
        userId: 'user_alice',
        provider: 'gemini',
        geminiModel: 'gpt-spoofed',
        thinkingLevel: 'medium',
        themeMode: 'system',
        subjects: ['Biology'],
        createdAt: NOW_TOKEN,
        updatedAt: NOW_TOKEN,
      },
      validCtx,
      'user_alice'
    ),
    false
  );

  // 11. Chat ID mismatch
  assert.equal(
    validateChatMessagePayload(
      {
        id: 'msg_1',
        userId: 'user_alice',
        chatId: 'chat_other',
        role: 'user',
        content: 'Hello',
        createdAtMs: 1,
        createdAt: NOW_TOKEN,
        updatedAt: NOW_TOKEN,
      },
      validCtx,
      'user_alice',
      'chat_1',
      'msg_1'
    ),
    false
  );

  // 12. PII snooping
  assert.equal(
    validateUserProfilePayload(
      {
        uid: 'user_victim',
        email: 'victim@example.com',
        displayName: 'Victim',
        photoURL: '',
        createdAt: NOW_TOKEN,
        updatedAt: NOW_TOKEN,
      },
      validCtx,
      'user_victim'
    ),
    false
  );
});

test('stripUndefinedDeep removes undefined keys without touching nested primitives', () => {
  const cleaned = stripUndefinedDeep({
    id: 'msg_1',
    attachments: undefined,
    nested: { a: 1, b: undefined },
  });
  assert.deepEqual(cleaned, { id: 'msg_1', nested: { a: 1 } });
  assert.equal('attachments' in cleaned, false);
});
