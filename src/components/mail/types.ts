// Shapes the Mail tab reads from /api/mail/* (the server side: src/lib/chat/mail-inbox.ts).
export interface Box { id: string; email: string; siteName: string; panelId: string | null; panelName: string; status: { ok: boolean; error: string | null; checkedAt: number } | null }
export interface Item { uid: number; from: string; fromAddress: string; subject: string; date: string; unread: boolean; hasAttachment: boolean; answered: boolean; authPass?: boolean }
export interface Att { index: number; filename: string; contentType: string; size: number; inline: boolean }
export interface Ver { orderId: string; byName: string; at: string; chatId: string | null }
export interface Full {
  uid: number; subject: string; date: string; from: string; fromAddress: string; to: string; cc: string; replyTo: string;
  frame: string; remoteImages: boolean; imagesShown: boolean; attachments: Att[]; unread: boolean; answered: boolean;
}
export interface ListEntry { items: Item[]; verified: Record<string, Ver[]>; truncated: boolean; at: number }
