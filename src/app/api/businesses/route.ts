import { NextRequest, NextResponse } from 'next/server';
import { getAuthFromRequest } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

// GET all businesses
export async function GET(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await getSupabaseAdmin()
    .from('businesses')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ businesses: data || [] });
}

// POST create business
export async function POST(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { name, logoUrl, supportEmail, supportPhone, isDefault } = await request.json();

    if (!name) {
      return NextResponse.json({ error: 'Business name is required' }, { status: 400 });
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await getSupabaseAdmin()
        .from('businesses')
        .update({ is_default: false })
        .eq('is_default', true);
    }

    const { data, error } = await getSupabaseAdmin()
      .from('businesses')
      .insert({
        name,
        logo_url: logoUrl || null,
        support_email: supportEmail || null,
        support_phone: supportPhone || null,
        is_default: isDefault || false,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ business: data });
  } catch {
    return NextResponse.json({ error: 'Failed to create business' }, { status: 500 });
  }
}

// PATCH update business
export async function PATCH(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id, name, logoUrl, supportEmail, supportPhone, isDefault } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'Business ID required' }, { status: 400 });
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await getSupabaseAdmin()
        .from('businesses')
        .update({ is_default: false })
        .eq('is_default', true);
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    // Only update logo if a real value is provided — null/undefined means "keep existing logo"
    if (logoUrl !== undefined && logoUrl !== null && logoUrl !== '') updateData.logo_url = logoUrl;
    if (supportEmail !== undefined) updateData.support_email = supportEmail;
    if (supportPhone !== undefined) updateData.support_phone = supportPhone;
    if (isDefault !== undefined) updateData.is_default = isDefault;

    const { error } = await getSupabaseAdmin()
      .from('businesses')
      .update(updateData)
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
}

// DELETE business
export async function DELETE(request: NextRequest) {
  const user = getAuthFromRequest(request);
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Business ID required' }, { status: 400 });
  }

  // Nullify any orders pointing to this business
  await getSupabaseAdmin()
    .from('orders')
    .update({ business_id: null })
    .eq('business_id', id);

  const { error } = await getSupabaseAdmin()
    .from('businesses')
    .delete()
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
