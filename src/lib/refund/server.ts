// ── Refund form: everything that reads or writes the refund tables (owner, 2026-10-02) ──
// SERVER ONLY. Spec refund_form_spec.md sections 2.6, 3 and 4. The only callers are:
//   - the Super Admin's Send control   /api/chat/conversations/[id]/refund-form (and the thread GET's
//                                      refund_form block + the Refund-mark gate, slice D)
//   - the customer's form              /api/refund/* (by the link's token only; public.ts guards it)
//   - the Super Admin's list           /api/refunds/*
// Staff, the AI, the learner, search and the team score never reach this file.
//
// Privacy (spec 9): the UPI / bank details are sealed (crypto.ts sealJson, AAD = request id) BEFORE
// any SQL; the token is stored only as its SHA-256; log lines carry ids, refs, steps, statuses and pg
// codes only (logFail). Chat messages are sender 'system' (shown as "Vastora Support"); they never
// claim the chat or change its holder (J2). Owner answer Q3 (2026-10-02): no customer message carries
// the UPI ID or the account, not even masked (texts.ts).
// Owner change 2026-10-02 ~15:00 ("upload yeh sab mat bana, humein sirf bank details mil jaye bahut
// hai"): NO photo / video upload. Nothing here reads or writes refund_files / refund_file_parts, and no
// refund route takes a file (refund-route.js R8 pins it).
//
// Locks, always in this order so two actions cannot deadlock:
//   Send:     chat group (lockChatGroup) -> advisory lock of the order -> its links (FOR UPDATE)
//   Submit:   advisory lock of the order -> the link (FOR UPDATE)
//   Status / "form received": the request (CAS UPDATE / FOR UPDATE) -> the target chat (FOR NO KEY UPDATE)
// Every transaction sets lock_timeout 5 s first: a busy row is a 409 "try again", never a hang.


// Moved out of this file on 2026-10-02 (pure move) into server-shared.ts / server-send.ts /
// server-public.ts / server-admin.ts; re-exported here so no importer changes.
export { adminFailure, chatLang, codeOf, deliverEmail, isMissingTable, logFail, logRefundEvent, msgOf, NOT_INSTALLED, postRefundMessage, publicFailure, targetConversation } from './server-shared';
export type { RefundEvent, Res, TargetChat } from './server-shared';
export { BLOCK_TEXT, cancelRefundLink, refundFormState, refundMarkLocked, refundThreadState, retryFormEmail, sendRefundForm } from './server-send';
export type { Block, RefundConv, RefundThreadState } from './server-send';
export { openLink, postAck, postAckWithRetry, submitRefund } from './server-public';
export { getRefund, listRefunds, patchRefund, refundCounts, refundCountsByPanel, revealPayout, VIEWS } from './server-admin';
