import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { cleanCSVData, CleanedOrder } from '@/lib/csv-cleaner';
import { query, queryOne, withTransaction } from '@/lib/db';
import Papa from 'papaparse';

const BATCH_SIZE = 500;

// Generate tracking ID: ST + 10 uppercase alphanumeric chars
function generateTrackingId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'ST';
  for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

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

    const { orders, stats } = cleanCSVData(parsed.data as Record<string, string>[]);

    // ═══ AUTO-DETECT BRANDS → CREATE BUSINESSES ═══
    const allBrands = new Set<string>();
    orders.forEach((o) => o.items.forEach((item) => { if (item.brand) allBrands.add(item.brand); }));
    const brandArr = Array.from(allBrands).filter((b) => b.length > 0);

    const bizMap = new Map<string, string>();

    if (brandArr.length > 0) {
      const existingBiz = await query<{ id: string; name: string }>(
        `SELECT id, name FROM businesses`
      );
      existingBiz.rows.forEach(b => bizMap.set(b.name.toLowerCase(), b.id));

      for (const brand of brandArr) {
        if (!bizMap.has(brand.toLowerCase())) {
          const newBiz = await queryOne<{ id: string }>(
            `INSERT INTO businesses (name) VALUES ($1) RETURNING id`,
            [brand]
          );
          if (newBiz) bizMap.set(brand.toLowerCase(), newBiz.id);
        }
      }
    }

    const getBusinessId = (order: CleanedOrder): string | null => {
      const brand = order.items[0]?.brand;
      if (brand && bizMap.has(brand.toLowerCase())) return bizMap.get(brand.toLowerCase())!;
      return null;
    };

    // ═══ FETCH PROGRESSION SETTINGS for smart status calculation ═══
    const progResult = await query<{
      step_from: string; step_to: string; delay_minutes: number; step_order: number; is_enabled: boolean;
    }>(`SELECT step_from, step_to, delay_minutes, step_order, is_enabled FROM progression_settings ORDER BY step_order ASC`);
    const progSteps = progResult.rows;

    // Calculate what status an order should be at based on its original creation date
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
        if (minutesElapsed >= accumulated) {
          currentStatus = step.step_to;
        } else {
          break;
        }
      }
      return currentStatus;
    }

    // ═══ STEP 1: Batch-check existing orders ═══
    const allOrderIds = orders.map((o) => o.order_id);
    const existingOrderIds = new Set<string>();

    for (let i = 0; i < allOrderIds.length; i += BATCH_SIZE) {
      const batch = allOrderIds.slice(i, i + BATCH_SIZE);
      const result = await query<{ order_id: string }>(
        `SELECT order_id FROM orders WHERE order_id = ANY($1::text[])`,
        [batch]
      );
      result.rows.forEach(d => existingOrderIds.add(d.order_id));
    }

    const newOrders = orders.filter((o) => !existingOrderIds.has(o.order_id));
    const existingOrders = orders.filter((o) => existingOrderIds.has(o.order_id));

    // ═══ STEP 2: Batch-INSERT new orders ═══
    let newCount = 0;
    for (let i = 0; i < newOrders.length; i += BATCH_SIZE) {
      const batch = newOrders.slice(i, i + BATCH_SIZE);

      const insertValues = batch.map(order => {
        const businessId = getBusinessId(order);
        const trackingStatus = calcStatusFromDate(order.created_at, order.is_cancelled);
        // Parse original order date — use it for created_at in DB so progression is accurate
        const originalDate = order.created_at ? new Date(order.created_at) : null;
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
          tracking_id: generateTrackingId(),
          business_id: businessId,
          original_created_at: originalDate && !isNaN(originalDate.getTime()) ? originalDate.toISOString() : null,
        };
      });

      // Build multi-row INSERT
      const colCount = 19;
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
          v.tracking_id, v.business_id, v.original_created_at
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
             tracking_id, business_id, created_at
           ) VALUES ${placeholders}
           ON CONFLICT (order_id) DO NOTHING`,
          insertParams
        );
        newCount += result.rowCount ?? 0;
      } catch (err) {
        console.error('Batch insert error:', err);
      }
    }


    // ═══ STEP 3: Parallel-UPDATE existing orders ═══
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
            sets.push(`business_id = $${pi}`);
            params.push(businessId);
            pi++;
          }
          params.push(order.order_id);
          return query(
            `UPDATE orders SET ${sets.join(', ')} WHERE order_id = $${pi}`,
            params
          );
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
        `INSERT INTO order_items (order_id, brand, product_name, quantity, price) VALUES ${placeholders}`,
        params
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

    // ═══ STEP 7: Log (only on last chunk) ═══
    if (isLastChunk) {
      await query(
        `INSERT INTO upload_logs (filename, total_rows, new_orders, updated_orders, skipped_rows, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [file.name, stats.total, newCount, updatedCount, stats.total - stats.unique, user.username]
      );
    }

    return NextResponse.json({
      success: true,
      chunk: chunkIndex,
      totalChunks,
      newOrderIds: newOrders.map((o) => o.order_id),
      stats: {
        ...stats,
        newOrders: newCount,
        updatedOrders: updatedCount,
        brandsDetected: brandArr.length,
      },
    });
  } catch (err) {
    console.error('Upload error:', err);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
