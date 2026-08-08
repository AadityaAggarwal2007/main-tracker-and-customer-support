import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { cleanCSVData, CleanedOrder } from '@/lib/csv-cleaner';
import { query, queryOne } from '@/lib/db';
import { generateTrackingEmail } from '@/lib/email-templates';
import Papa from 'papaparse';
import crypto from 'crypto';

const BATCH_SIZE = 500;

function generateTrackingId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'ST';
  for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function generateTrackingToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://shiptrack.store';

export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const chunkIndex = parseInt(formData.get('chunkIndex') as string || '0');
    const totalChunks = parseInt(formData.get('totalChunks') as string || '1');
    const isLastChunk = chunkIndex === totalChunks - 1;
    // ── PANEL LOCK: user must select which panel this CSV belongs to ──
    const forcedBusinessId = (formData.get('businessId') as string) || null;
    if (!forcedBusinessId) {
      return NextResponse.json(
        { error: 'Please select a panel before uploading. Every CSV must be assigned to a specific panel.' },
        { status: 400 }
      );
    }

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const csvText = await file.text();
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: 'greedy',
      relaxQuotes: true,
      relaxColumnCount: true,
    });

    if (!parsed.data || (parsed.data as Record<string, string>[]).length === 0) {
      return NextResponse.json(
        { error: 'CSV parsing failed — no valid rows found', details: parsed.errors.slice(0, 5) },
        { status: 400 }
      );
    }

    // ── Debug: capture detected column headers to show in response ──
    const detectedColumns = parsed.meta?.fields || Object.keys((parsed.data as Record<string, string>[])[0] || {});

    const { orders, stats } = cleanCSVData(parsed.data as Record<string, string>[]);

    // ── DEBUG: log parse result ──
    console.log(`[UPLOAD] forcedBusinessId=${forcedBusinessId} rawRows=${parsed.data.length} cleanedOrders=${orders.length}`);
    if (orders.length > 0) {
      console.log(`[UPLOAD] sample order_id=${orders[0].order_id} total=${orders[0].order_total} items=${orders[0].items.length}`);
    }

    // ── If 0 orders parsed, return early with debug info ──
    if (orders.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No orders could be read from this CSV. The column names may not match the expected Shopify format.',
        detectedColumns,
        expectedColumns: ['Name', 'Billing Name', 'Total', 'Shipping Address1', 'Shipping City', 'Lineitem price'],
        hint: 'Make sure you are exporting a Shopify Orders CSV (Orders → Export → CSV for Excel).',
        stats,
      }, { status: 422 });
    }

    // ═══ AUTO-DETECT BRANDS → CREATE/FIND BUSINESSES ═══
    const allBrands = new Set<string>();
    orders.forEach((o) => o.items.forEach((item) => { if (item.brand) allBrands.add(item.brand); }));
    const brandArr = Array.from(allBrands).filter((b) => b.length > 0);

    // bizMap: lowercase brand name → business id
    const bizMap = new Map<string, string>();
    // bizBrandingMap: business id → branding info for email generation
    const bizBrandingMap = new Map<string, {
      name: string; logo_url: string; support_email: string;
      support_phone: string; tracking_domain: string | null; primary_color: string | null;
    }>();

    if (brandArr.length > 0) {
      const existingBiz = await query<{
        id: string; name: string; logo_url: string; support_email: string;
        support_phone: string; tracking_domain: string | null; primary_color: string | null;
      }>(`SELECT id, name, logo_url, support_email, support_phone, tracking_domain, primary_color FROM businesses`);

      existingBiz.rows.forEach(b => {
        bizMap.set(b.name.toLowerCase(), b.id);
        bizBrandingMap.set(b.id, b);
      });

      for (const brand of brandArr) {
        if (!bizMap.has(brand.toLowerCase())) {
          const newBiz = await queryOne<{
            id: string; name: string; logo_url: string; support_email: string;
            support_phone: string; tracking_domain: string | null; primary_color: string | null;
          }>(
            `INSERT INTO businesses (name) VALUES ($1) RETURNING id, name, logo_url, support_email, support_phone, tracking_domain, primary_color`,
            [brand]
          );
          if (newBiz) {
            bizMap.set(brand.toLowerCase(), newBiz.id);
            bizBrandingMap.set(newBiz.id, newBiz);
          }
        }
      }
    }

    // ── PANEL LOCK: ALL orders go to the selected panel — no auto-detection
    const getBusinessId = (_order: CleanedOrder): string | null => {
      return forcedBusinessId; // Always use the panel selected by user
    };

    // ═══ FETCH PROGRESSION SETTINGS ═══
    const progResult = await query<{
      step_from: string; step_to: string; delay_minutes: number; step_order: number; is_enabled: boolean;
    }>(`SELECT step_from, step_to, delay_minutes, step_order, is_enabled FROM progression_settings ORDER BY step_order ASC`);
    const progSteps = progResult.rows;

    // Total minutes from Order Placed → Delivered (the full pipeline)
    const totalDeliveryMinutes = progSteps
      .filter(s => s.is_enabled)
      .reduce((sum, s) => sum + s.delay_minutes, 0);

    function calcStatusFromDate(createdAtStr: string, isCancelled: boolean): string {
      if (isCancelled) return 'Cancelled';
      if (!createdAtStr || progSteps.length === 0) return 'Order Placed';
      const createdAt = new Date(createdAtStr);
      if (isNaN(createdAt.getTime())) return 'Order Placed';
      const minutesElapsed = (Date.now() - createdAt.getTime()) / 60000;
      let accumulated = 0;
      let currentStatus = 'Order Placed';
      for (const step of progSteps) {
        if (!step.is_enabled) continue;
        accumulated += step.delay_minutes;
        if (minutesElapsed >= accumulated) { currentStatus = step.step_to; } else { break; }
      }
      return currentStatus;
    }

    // Calculate estimated delivery date from order creation date
    function calcEstimatedDelivery(createdAtStr: string): string | null {
      if (!createdAtStr || totalDeliveryMinutes === 0) return null;
      const createdAt = new Date(createdAtStr);
      if (isNaN(createdAt.getTime())) return null;
      return new Date(createdAt.getTime() + totalDeliveryMinutes * 60000).toISOString();
    }

    // ═══ STEP 1: Batch-check existing orders — SCOPED TO THIS PANEL ═══
    // Two panels can have the same order_id (e.g. LOMORA #1355 ≠ RUHANI #1355)
    // So we check for existing by (order_id + business_id) not order_id alone
    const allOrderIds = orders.map((o) => o.order_id);
    const existingOrderIds = new Set<string>();

    for (let i = 0; i < allOrderIds.length; i += BATCH_SIZE) {
      const batch = allOrderIds.slice(i, i + BATCH_SIZE);
      const result = await query<{ order_id: string }>(
        `SELECT order_id FROM orders
         WHERE order_id = ANY($1::text[])
         AND business_id = $2`,
        [batch, forcedBusinessId]
      );
      result.rows.forEach(d => existingOrderIds.add(d.order_id));
    }

    const newOrders = orders.filter((o) => !existingOrderIds.has(o.order_id));
    const existingOrders = orders.filter((o) => existingOrderIds.has(o.order_id));

    // ── DEBUG: log dedup result ──
    console.log(`[UPLOAD] dedup: existing=${existingOrders.length} new=${newOrders.length} (checked against business_id=${forcedBusinessId})`);

    // ═══ STEP 2: Batch-INSERT new orders ═══
    let newCount = 0;
    // Track inserted orders for email queuing
    const insertedOrders: Array<{
      order_id: string; customer_email: string; customer_name: string;
      tracking_id: string; tracking_token: string; order_total: number;
      city: string; tracking_status: string; estimated_delivery: string | null;
      business_id: string | null; items: CleanedOrder['items'];
    }> = [];

    for (let i = 0; i < newOrders.length; i += BATCH_SIZE) {
      const batch = newOrders.slice(i, i + BATCH_SIZE);

      const insertValues = batch.map(order => {
        const businessId = getBusinessId(order);
        const trackingStatus = calcStatusFromDate(order.created_at, order.is_cancelled);
        const originalDate = order.created_at ? new Date(order.created_at) : null;
        const validOriginalDate = originalDate && !isNaN(originalDate.getTime()) ? originalDate : null;
        const estimatedDelivery = validOriginalDate ? calcEstimatedDelivery(order.created_at) : null;
        const trackingId = generateTrackingId();
        const trackingToken = generateTrackingToken();
        return {
          order_id: order.order_id,
          shopify_id: order.shopify_id,
          payment_method: order.payment_method,
          financial_status: order.financial_status,
          customer_name: order.customer_name,
          customer_email: order.customer_email,
          customer_mobile: order.customer_mobile,
          address_line1: order.address_line1,
          address_line2: order.address_line2,
          address_line3: order.address_line3,
          city: order.city,
          state: order.state,
          pincode: order.pincode,
          order_total: order.order_total,
          is_cancelled: order.is_cancelled,
          tracking_status: trackingStatus,
          tracking_id: trackingId,
          tracking_token: trackingToken,
          business_id: businessId,
          original_created_at: validOriginalDate ? validOriginalDate.toISOString() : null,
          estimated_delivery: estimatedDelivery,
          items: order.items,
        };
      });

      const colCount = 21;
      const placeholders = insertValues.map(
        (_, j) => `(${Array.from({ length: colCount }, (_, k) => `$${j * colCount + k + 1}`).join(', ')})`
      ).join(', ');

      const insertParams: unknown[] = [];
      insertValues.forEach(v => {
        insertParams.push(
          v.order_id, v.shopify_id, v.payment_method, v.financial_status,
          v.customer_name, v.customer_email, v.customer_mobile,
          v.address_line1, v.address_line2, v.address_line3,
          v.city, v.state, v.pincode,
          v.order_total, v.is_cancelled, v.tracking_status,
          v.tracking_id, v.tracking_token, v.business_id,
          v.original_created_at, v.estimated_delivery
        );
      });

      try {
        const result = await query(
          `INSERT INTO orders (
             order_id, shopify_id, payment_method, financial_status,
             customer_name, customer_email, customer_mobile,
             address_line1, address_line2, address_line3,
             city, state, pincode,
             order_total, is_cancelled, tracking_status,
             tracking_id, tracking_token, business_id, created_at, estimated_delivery
           ) VALUES ${placeholders}
           ON CONFLICT (order_id, business_id) WHERE business_id IS NOT NULL DO NOTHING`,
          insertParams
        );
        console.log(`[UPLOAD] INSERT batch rowCount=${result.rowCount} attempted=${batch.length}`);
        newCount += result.rowCount ?? 0;
        // Track for email queuing
        insertValues.forEach(v => {
          if (!v.is_cancelled && v.customer_email && v.customer_email.includes('@')) {
            insertedOrders.push({
              order_id: v.order_id,
              customer_email: v.customer_email,
              customer_name: v.customer_name,
              tracking_id: v.tracking_id,
              tracking_token: v.tracking_token,
              order_total: v.order_total,
              city: v.city,
              tracking_status: v.tracking_status,
              estimated_delivery: v.estimated_delivery,
              business_id: v.business_id,
              items: v.items,
            });
          }
        });
      } catch (err) {
        console.error('[UPLOAD] Batch insert ERROR:', err);
        // Return the error so it's visible in the UI
        return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
      }
    }

    // ═══ STEP 3: Parallel-UPDATE existing orders ═══
    // NOTE: business_id is NEVER overwritten — only set if currently NULL
    // This prevents orders from jumping between panels on re-upload
    let updatedCount = 0;
    for (let i = 0; i < existingOrders.length; i += 50) {
      const batch = existingOrders.slice(i, i + 50);
      const results = await Promise.all(
        batch.map(order => {
          const businessId = getBusinessId(order);
          const sets = [
            'payment_method = $1', 'financial_status = $2', 'customer_name = $3',
            'customer_email = $4', 'customer_mobile = $5', 'address_line1 = $6',
            'address_line2 = $7', 'address_line3 = $8', 'city = $9',
            'state = $10', 'pincode = $11', 'order_total = $12', 'is_cancelled = $13',
          ];
          const params: unknown[] = [
            order.payment_method, order.financial_status, order.customer_name,
            order.customer_email, order.customer_mobile, order.address_line1,
            order.address_line2, order.address_line3, order.city,
            order.state, order.pincode, order.order_total, order.is_cancelled,
          ];
          let pi = 14;
          if (businessId) {
            // COALESCE: only set business_id if currently NULL (never overwrite existing panel)
            sets.push(`business_id = COALESCE(business_id, $${pi})`);
            params.push(businessId);
            pi++;
          }
          params.push(order.order_id);
          return query(`UPDATE orders SET ${sets.join(', ')} WHERE order_id = $${pi}`, params);
        })
      );
      updatedCount += results.filter(r => (r.rowCount ?? 0) > 0).length;
    }

    // ═══ STEP 4: Delete old items for existing orders ═══
    const existingOrderIdsArr = Array.from(existingOrderIds);
    for (let i = 0; i < existingOrderIdsArr.length; i += BATCH_SIZE) {
      const batch = existingOrderIdsArr.slice(i, i + BATCH_SIZE);
      await query(`DELETE FROM order_items WHERE order_id = ANY($1::text[])`, [batch]);
    }

    // ═══ STEP 5: Batch-INSERT all items ═══
    const allItems = orders.flatMap((o) =>
      o.items.map((item) => ({
        order_id: o.order_id,
        brand: item.brand,
        product_name: item.product_name,
        quantity: item.quantity,
        price: item.price,
      }))
    );

    for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
      const batch = allItems.slice(i, i + BATCH_SIZE);
      const colCount = 5;
      const placeholders = batch.map(
        (_, j) => `(${Array.from({ length: colCount }, (_, k) => `$${j * colCount + k + 1}`).join(', ')})`
      ).join(', ');
      const params: unknown[] = [];
      batch.forEach(item => {
        params.push(item.order_id, item.brand, item.product_name, item.quantity, item.price);
      });
      await query(
        `INSERT INTO order_items (order_id, brand, product_name, quantity, price) VALUES ${placeholders}`
        , params
      );
    }

    // ═══ STEP 6: Tracking history for new orders ═══
    if (newOrders.length > 0) {
      for (let i = 0; i < newOrders.length; i += BATCH_SIZE) {
        const batch = newOrders.slice(i, i + BATCH_SIZE);
        const colCount = 4;
        const placeholders = batch.map(
          (_, j) => `(${Array.from({ length: colCount }, (_, k) => `$${j * colCount + k + 1}`).join(', ')})`
        ).join(', ');
        const params: unknown[] = [];
        batch.forEach(o => {
          params.push(o.order_id, o.is_cancelled ? 'Cancelled' : 'Order Placed', user.username, '');
        });
        await query(
          `INSERT INTO tracking_history (order_id, status, changed_by, notes) VALUES ${placeholders}`,
          params
        );
      }
    }

    // ═══ STEP 7: AUTO-QUEUE EMAILS for new orders (1/min cron sends them) ═══
    let emailsQueued = 0;
    if (insertedOrders.length > 0) {

      // ── Safety: skip orders already in email_queue (prevents duplicates on re-upload)
      const insertedIds = insertedOrders.map(o => o.order_id);
      const alreadyQueued = await query<{ order_id: string }>(
        `SELECT DISTINCT order_id FROM email_queue WHERE order_id = ANY($1::text[])`,
        [insertedIds]
      );
      const alreadyQueuedSet = new Set(alreadyQueued.rows.map(r => r.order_id));
      const toEmail = insertedOrders.filter(o => !alreadyQueuedSet.has(o.order_id));

      const emailRows: { orderId: string; status: string; to: string; subject: string; html: string; fromName: string }[] = [];

      for (const order of toEmail) {
        const biz = order.business_id ? bizBrandingMap.get(order.business_id) : null;
        let logoUrl = biz?.logo_url || '';
        if (logoUrl && logoUrl.includes('drive.google.com')) {
          logoUrl = logoUrl.replace(/\/file\/d\/([^/]+).*/, '/uc?export=view&id=$1');
        }
        const trackingBase = biz?.tracking_domain || BASE_URL;
        const bizName = biz?.name || 'ShipTrack';

        const emailResult = generateTrackingEmail(
          {
            customerName: order.customer_name,
            orderId: order.order_id,
            productNames: order.items.map(i => i.product_name).filter(Boolean),
            trackingId: order.tracking_id,
            courierPartner: '',
            trackingUrl: `${trackingBase}/track/${order.tracking_token}`,
            businessName: bizName,
            businessLogoUrl: logoUrl || undefined,
            primaryColor: biz?.primary_color || undefined,
            supportEmail: biz?.support_email || '',
            supportPhone: biz?.support_phone || '',
            estimatedDelivery: order.estimated_delivery || undefined,
            orderTotal: order.order_total,
            city: order.city,
          },
          order.tracking_status  // Use the calculated stage (e.g. "Shipped", "In Transit")
        );

        if (!emailResult) continue;
        emailRows.push({
          orderId: order.order_id,
          status: order.tracking_status,
          to: order.customer_email,
          subject: emailResult.subject,
          html: emailResult.html,
          fromName: bizName,
        });
      }

      // Batch insert into email_queue
      for (let i = 0; i < emailRows.length; i += BATCH_SIZE) {
        const batch = emailRows.slice(i, i + BATCH_SIZE);
        const colCount = 6;
        const placeholders = batch.map(
          (_, j) => `(${Array.from({ length: colCount }, (_, k) => `$${j * colCount + k + 1}`).join(', ')})`
        ).join(', ');
        const params: unknown[] = [];
        batch.forEach(r => {
          params.push(r.orderId, r.status, r.to, r.subject, r.html, r.fromName);
        });
        try {
          const result = await query(
            `INSERT INTO email_queue (order_id, status_stage, to_email, subject, html, from_name)
             VALUES ${placeholders}`,
            params
          );
          emailsQueued += result.rowCount ?? 0;
        } catch (err) {
          console.error('Email queue insert error:', err);
        }
      }
    }

    // ═══ STEP 8: Log (only on last chunk) ═══
    if (isLastChunk) {
      try {
        await query(
          `INSERT INTO upload_logs (filename, total_rows, new_orders, updated_orders, skipped_rows, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [file.name, stats.total, newCount, updatedCount, stats.total - stats.unique, user.username]
        );
      } catch { /* upload_logs table might not exist */ }
    }

    const hoursLeft = Math.ceil(emailsQueued / 60);

    return NextResponse.json({
      success: true,
      chunk: chunkIndex,
      totalChunks,
      newOrderIds: newOrders.map((o) => o.order_id),
      emailsQueued,
      estimatedHours: hoursLeft,
      stats: {
        ...stats,
        newOrders: newCount,
        updatedOrders: updatedCount,
        brandsDetected: brandArr.length,
        emailsAutoQueued: emailsQueued,
      },
    });
  } catch (err) {
    console.error('Upload error:', err);
    return NextResponse.json({ error: 'Upload failed', detail: String(err) }, { status: 500 });
  }
}
