import { NextRequest } from 'next/server';
import { widgetJson, widgetPreflight } from '@/lib/chat/widget-api';

export const dynamic = 'force-dynamic';

export async function OPTIONS() { return widgetPreflight(); }

// POST /api/widget/resume — RETIRED 2026-09-30 (SHIPTRACK_MASTER_RULES.md 8.1, 8.3, 9).
//
// It used to return the newest chat saved under a phone number, transcript and
// all, to anybody who typed that number. Site keys are printed in every
// storefront's page source, so a person who only knew someone's phone could read
// their orders, products, totals and tracking links. A phone number alone must
// open nothing.
//
// A customer on a new device now continues a chat through the widget's normal
// form (/api/widget/verify): Order ID + full phone, both matching the same
// order. That route already carries on the customer's earlier chat for that
// order. This route stays only so that a widget script cached in a browser gets
// a plain "not found" instead of an error; it never touches the database and
// never returns a message.
export async function POST(_request: NextRequest) {
  return widgetJson({ found: false, error: 'verify_required' });
}
