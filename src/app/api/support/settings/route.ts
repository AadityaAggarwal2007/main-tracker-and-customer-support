import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';

// GET /api/support/settings?businessId=xxx
// POST /api/support/settings — save settings

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('businessId');
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  const settings = await queryOne<{
    id: string; ai_mode: string; ai_provider: string; ai_model: string;
    ai_base_url: string; imap_host: string; imap_port: number;
    imap_user: string; imap_folder: string; auto_reply_enabled: boolean;
    has_ai_key: boolean; has_imap_password: boolean;
  }>(
    `SELECT id, ai_mode, ai_provider, ai_model, ai_base_url,
            imap_host, imap_port, imap_user, imap_folder, auto_reply_enabled,
            (ai_api_key IS NOT NULL AND ai_api_key != '') as has_ai_key,
            (imap_password IS NOT NULL AND imap_password != '') as has_imap_password
     FROM support_settings WHERE business_id = $1`,
    [businessId]
  );

  return NextResponse.json({ settings: settings || null });
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  const body = await request.json();
  const {
    businessId, aiMode, aiProvider, aiApiKey, aiModel, aiBaseUrl,
    imapHost, imapPort, imapUser, imapPassword, imapFolder, autoReplyEnabled,
  } = body;

  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  // Upsert support settings
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM support_settings WHERE business_id = $1`, [businessId]
  );

  if (existing) {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let pi = 1;

    if (aiMode) { sets.push(`ai_mode = $${pi++}`); values.push(aiMode); }
    if (aiProvider) { sets.push(`ai_provider = $${pi++}`); values.push(aiProvider); }
    if (aiApiKey !== undefined && aiApiKey !== '') { sets.push(`ai_api_key = $${pi++}`); values.push(aiApiKey); }
    if (aiModel) { sets.push(`ai_model = $${pi++}`); values.push(aiModel); }
    if (aiBaseUrl !== undefined) { sets.push(`ai_base_url = $${pi++}`); values.push(aiBaseUrl || null); }
    if (imapHost) { sets.push(`imap_host = $${pi++}`); values.push(imapHost); }
    if (imapPort) { sets.push(`imap_port = $${pi++}`); values.push(imapPort); }
    if (imapUser !== undefined) { sets.push(`imap_user = $${pi++}`); values.push(imapUser || null); }
    if (imapPassword !== undefined && imapPassword !== '') { sets.push(`imap_password = $${pi++}`); values.push(imapPassword); }
    if (imapFolder) { sets.push(`imap_folder = $${pi++}`); values.push(imapFolder); }
    if (autoReplyEnabled !== undefined) { sets.push(`auto_reply_enabled = $${pi++}`); values.push(autoReplyEnabled); }

    values.push(businessId);
    await query(`UPDATE support_settings SET ${sets.join(', ')} WHERE business_id = $${pi}`, values);
  } else {
    await query(
      `INSERT INTO support_settings (business_id, ai_mode, ai_provider, ai_api_key, ai_model, ai_base_url,
        imap_host, imap_port, imap_user, imap_password, imap_folder, auto_reply_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        businessId, aiMode || 'human_first', aiProvider || 'gemini', aiApiKey || null,
        aiModel || 'gemini-1.5-flash', aiBaseUrl || null,
        imapHost || 'imap.gmail.com', imapPort || 993, imapUser || null,
        imapPassword || null, imapFolder || 'INBOX', autoReplyEnabled || false,
      ]
    );
  }

  return NextResponse.json({ success: true });
}
