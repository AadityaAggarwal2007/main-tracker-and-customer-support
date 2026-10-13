import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { addNote, changeNote, listNotes, type NotesResult } from '@/lib/chat/reply-notes';

export const dynamic = 'force-dynamic';

// Saved replies, "Notes" (owner 2026-10-13; reply-notes.ts):
//   GET   /api/reply-notes?panel=<id>                 the panel's notes + its brand name
//   POST  /api/reply-notes {panel, segment, title, body}
//   PATCH /api/reply-notes {panel, id, segment, title, body} | {panel, id, remove: true}
// Anyone who replies to customers in that panel; the writer, the Manager or the Super Admin change / remove. Nothing is sent.
const answer = <T,>(r: NotesResult<T>, key: string) =>
  'error' in r ? NextResponse.json({ error: r.error }, { status: r.status }) : NextResponse.json({ [key]: r.value });

export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const r = await listNotes(user, new URL(request.url).searchParams.get('panel') || '');
    return 'error' in r ? NextResponse.json({ error: r.error }, { status: r.status }) : NextResponse.json(r.value);
  } catch (e) { console.error('[reply-note] list:', (e as Error).message); return NextResponse.json({ error: 'Could not read the notes' }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  try { return answer(await addNote(user, String(body.panel || ''), body), 'note'); }
  catch (e) { console.error('[reply-note] add:', (e as Error).message); return NextResponse.json({ error: 'Could not save the note' }, { status: 500 }); }
}

export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  try { return answer(await changeNote(user, String(body.panel || ''), String(body.id || ''), body, body.remove === true), 'note'); }
  catch (e) { console.error('[reply-note] change:', (e as Error).message); return NextResponse.json({ error: 'Could not change the note' }, { status: 500 }); }
}
