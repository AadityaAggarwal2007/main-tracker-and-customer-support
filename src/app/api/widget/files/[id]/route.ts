import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { ATTACHMENT_ID_PATTERN } from '@/lib/chat/attachment-rules';
import { WIDGET_CORS, widgetPreflight } from '@/lib/chat/widget-api';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

// GET /api/widget/files/:id[?download=1]
// A file an agent sent in a chat. The customer's widget loads it from a
// storefront with no session, so the unguessable id is the only key — the same
// way the site key guards the rest of /api/widget. A file is served only once
// it belongs to a sent message, never while it is still a draft upload.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const notFound = () => new NextResponse('Not found', {
    status: 404, headers: { ...WIDGET_CORS, 'Content-Type': 'text/plain; charset=utf-8' },
  });

  if (!ATTACHMENT_ID_PATTERN.test(params.id)) return notFound();

  try {
    const file = await queryOne<{ file_name: string; mime_type: string; kind: string; data: Buffer }>(
      `SELECT file_name, mime_type, kind, data
         FROM chat_attachments
        WHERE id = $1 AND message_id IS NOT NULL`,
      [params.id]
    );
    if (!file) return notFound();

    const download = new URL(request.url).searchParams.get('download') === '1';
    const asciiName = file.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const disposition = `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`;

    const headers: Record<string, string> = {
      ...WIDGET_CORS,
      'Content-Type': file.mime_type,
      'Content-Disposition': disposition,
      // A file never changes under its id.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // Storefronts on other domains show these images.
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Referrer-Policy': 'no-referrer',
    };
    // An image opened in its own tab gets no script at all. PDFs are left
    // without this: a sandboxed document stops the browser's PDF viewer.
    if (file.kind === 'image') {
      headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
    }

    // pg hands back a Buffer, which is already a Uint8Array; passing it as-is
    // avoids a second copy of the file in memory.
    return new NextResponse(file.data as unknown as BodyInit, { status: 200, headers });
  } catch (err) {
    console.error('[widget] file error:', err);
    return new NextResponse('Could not load that file', {
      status: 500, headers: { ...WIDGET_CORS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
