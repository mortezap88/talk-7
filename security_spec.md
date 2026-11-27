# Security Specification — Talk Study Tutor Firestore Rules

## 1. Data Invariants
1. **Strict Ownership**: Every document in `/users/{userId}/...` belongs solely to `userId` (`request.auth.uid == userId`), and the user must have a verified email (`request.auth.token.email_verified == true`).
2. **PII Isolation**: User email, display name, and photo URL reside exclusively in `/users/{userId}/private/profile`, readable and writable only by the owning user.
3. **Parent Chat Integrity (Master Gate)**: Subcollections under `/users/{userId}/chats/{chatId}/...` (`messages`, `workspace/*`, `textbookFigures`, `questions`) require the parent `/users/{userId}/chats/{chatId}` document to exist (or be created atomically in the same batch via `existsAfter` / `getAfter`) and belong to `request.auth.uid`.
4. **Immutable Ownership & Creation Timestamps**: `userId`, `uid`, `id`, `chatId`, and `createdAt` cannot be modified after creation. `createdAt == request.time` on create; `updatedAt == request.time` on create and update.
5. **Strict Key & Size Bounds**: Every `create` checks `keys().hasAll(...)` and `keys().hasOnly(...)`; every `update` uses action-based `affectedKeys().hasOnly(...)` combined with `isValid[Entity](incoming())`; every string, ID, and array has strict `.size()` and regex (`^[a-zA-Z0-9_\-]+$`) checks matching `firebase-blueprint.json`.
6. **Zero Blanket Access**: Default-deny catch-all `match /{document=**} { allow read, write: if false; }` is enforced at the top of `match /databases/{database}/documents`.

## 2. The "Dirty Dozen" Attack Payloads (All Must Fail with `PERMISSION_DENIED`)
1. **Cross-User Read/Write**: Signed-in user `uid_attacker` attempts to read or create `/users/uid_victim/chats/chat_1`.
2. **Unverified Email Write**: Signed-in user with `email_verified == false` attempts to create a chat or message.
3. **Owner Spoofing on Create**: User `uid_a` attempts to create `/users/uid_a/chats/chat_1` with `userId: "uid_b"`.
4. **Owner Hijack on Update**: User `uid_a` attempts to update `/users/uid_a/chats/chat_1` changing `userId` to `"uid_b"`.
5. **Shadow / Ghost Field Injection**: User `uid_a` includes `{ ..., isAdmin: true }` on `UserProfile` or `ChatDoc` create/update.
6. **ID Poisoning**: User attempts to write `/users/uid_a/chats/bad..id$with/chars` or a 1,500-character document ID.
7. **Timestamp Forgery**: Client submits `createdAt: Timestamp(2020-01-01)` instead of `request.time`, or mutates `createdAt` on update.
8. **Orphaned Subcollection Write**: User attempts to write `/users/uid_a/chats/nonexistent_chat/messages/msg_1` without a parent chat document.
9. **Unbounded Array / Resource Exhaustion**: Client attempts to store >32 subjects, >30 note tags, >20 note images, >400 textbook blocks, >24 learnerState entries, >15 memory packs, or >200,000-char message content.
10. **Invalid Enum Value**: Client attempts to set `geminiModel: "unknown-model"`, `role: "admin"`, or `status: "CHEATED"` on a flashcard.
11. **Chat ID Mismatch**: Client writes a message at `/users/uid_a/chats/chat_A/messages/msg_1` with `chatId: "chat_B"`.
12. **PII Snooping**: User `uid_attacker` attempts `get` on `/users/uid_victim/private/profile`.
