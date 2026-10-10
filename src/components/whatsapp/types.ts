import type { TemplateInfo } from '@/lib/chat/whatsapp-templates';
import type { PhoneInfo, Profile } from '@/lib/chat/whatsapp-profile';

export interface WaSettings {
  configured: boolean; verifyTokenSet: boolean; appSecretSet: boolean;
  webhook?: { lastOk: number | null; lastRefused: number | null; refusedReason: string | null; refusedSinceOk: number }; phoneNumberId: string;
  waba: string; messaging: string; dailyLimit?: number | null; alertTo?: string; wabaFromEnv: boolean; appId: string; panel: { id: string; name: string } | null; webhookUrl: string;
  phone: PhoneInfo | null; phoneError: string | null;
}
export interface WaLists { templates: TemplateInfo[]; waba: string; error?: string; categories?: string[]; languages?: { code: string; label: string }[] }
export interface WaProfileData { profile: Profile | null; error?: string; verticals: { code: string; label: string }[] }
export interface WaChat { id: string; name: string | null; phone: string | null; status: string; unread: number; last_message_at: string | null; last_message: string | null; last_sender: string | null; panel: string | null }
export interface WaSent { id: string; conversationId: string; text: string; at: string; name: string | null; phone: string | null; by: string | null; template: string | null; sent: boolean | null; status: string | null; error: string | null }
export interface WaActivity { chats: WaChat[]; sent: WaSent[]; error?: string }

import type { Brand } from '@/lib/chat/whatsapp-brand-rules';
export type { Brand };
import type { AutoOverview } from '@/lib/chat/whatsapp-auto';
export type { AutoOverview };
export type WaTab = 'setup' | 'test' | 'profile' | 'templates' | 'automation' | 'chats' | 'send' | 'activity';
export type Alert = (type: string, message: string) => void;

export const EMPTY_FORM = { name: '', language: 'en_US', category: 'UTILITY', header: '', body: '', footer: '', examples: [] as string[] };
export type TemplateForm = typeof EMPTY_FORM;

export const spin = { animation: 'spin 0.6s linear infinite' } as const;
export const label = { fontSize: '0.75rem', fontWeight: 600 } as const;
export const SECTION = { fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)' } as const;
