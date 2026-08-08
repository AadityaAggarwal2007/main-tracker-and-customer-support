import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { cleanCSVData } from '@/lib/csv-cleaner';
import { query } from '@/lib/db';
import Papa from 'papaparse';

// ═══════════════════════════════════════════════════════════
// RESYNC: Upload CSV → fixes phone/name/address for ALL orders
// Does NOT delete anything, does NOT queue emails
// Safe to run anytime, as many times as needed
// ═══════════════════════════════════════════════════════════

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    const csvText = await file.text();
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: 'greedy',
      relaxQuotes: true,
      relaxColumnCount: true,
    });

    if (!parsed.data || (parsed.data as Record<string, string>[]).length === 0) {
      return NextResponse.json({ error: 'No valid rows found' }, { status: 400 });
    }

    const { orders } = cleanCSVData(parsed.data as Record<string, string>[]);

    let fixed = 0;
    let notFound = 0;
    const phoneFixed: string[] = [];
    const BATCH = 50;

    for (let i = 0; i < orders.length; i += BATCH) {
      const batch = orders.slice(i, i + BATCH);

      await Promise.all(batch.map(async (order) => {
        // Check if order exists
        const existing = await query<{ order_id: string; customer_mobile: string }>(
          `SELECT order_id, customer_mobile FROM orders WHERE order_id = $1`,
          [order.order_id]
        );

        if (existing.rows.length === 0) {
          notFound++;
          return;
        }

        const oldPhone = existing.rows[0].customer_mobile || '';
        const newPhone = order.customer_mobile || '';

        // Update phone + name + email + address
        await query(
          `UPDATE orders SET
            customer_mobile = $1,
            customer_name   = $2,
            customer_email  = $3,
            address_line1   = $4,
            address_line2   = $5,
            city            = $6,
            state           = $7,
            pincode         = $8
          WHERE order_id = $9`,
          [
            newPhone,
            order.customer_name,
            order.customer_email,
            order.address_line1,
            order.address_line2,
            order.city,
            order.state,
            order.pincode,
            order.order_id,
          ]
        );

        fixed++;

        if (oldPhone !== newPhone) {
          phoneFixed.push(`${order.order_id}: ${oldPhone} → ${newPhone}`);
        }
      }));
    }

    return NextResponse.json({
      success: true,
      fixed,
      notFound,
      phoneChanges: phoneFixed.length,
      sample: phoneFixed.slice(0, 10), // show first 10 phone fixes
      message: `✅ Fixed ${fixed} orders. ${phoneFixed.length} phone numbers corrected. ${notFound} not found in DB.`,
    });

  } catch (err) {
    console.error('Resync error:', err);
    return NextResponse.json({ error: 'Resync failed', detail: String(err) }, { status: 500 });
  }
}
