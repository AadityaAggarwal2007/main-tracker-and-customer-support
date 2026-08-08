// Professional email templates for every tracking status

const BRAND_COLOR = '#4F46E5';
const LIGHT_BG = '#F8FAFC';
const CARD_BG = '#FFFFFF';
const TEXT_COLOR = '#1E293B';
const MUTED_COLOR = '#64748B';

interface TemplateData {
  customerName: string;
  orderId: string;
  productNames: string[];
  trackingId: string;
  courierPartner: string;
  trackingUrl: string;
  businessName: string;
  businessLogoUrl?: string;
  primaryColor?: string;  // per-panel brand color
  supportEmail: string;
  supportPhone: string;
  estimatedDelivery?: string;
  orderTotal: number;
  city: string;
}

// Status-specific content
const STATUS_CONFIG: Record<string, { emoji: string; subject: string; headline: string; message: string; buttonText: string; }> = {
  'Order Placed': {
    emoji: '✅',
    subject: 'Your order {orderId} is confirmed!',
    headline: 'Order Confirmed!',
    message: 'Thank you for your purchase! Your order has been confirmed and is being prepared.',
    buttonText: 'Track Your Order',
  },
  'Processing': {
    emoji: '⚙️',
    subject: 'Your order {orderId} is being prepared',
    headline: 'We\'re Preparing Your Order',
    message: 'Great news! Your order is now being processed and will be shipped soon.',
    buttonText: 'Track Your Order',
  },
  'Packed': {
    emoji: '🎁',
    subject: 'Your order {orderId} has been packed!',
    headline: 'Your Order is Packed!',
    message: 'Your order has been carefully packed and is ready for dispatch.',
    buttonText: 'Track Your Order',
  },
  'Shipped': {
    emoji: '🚚',
    subject: 'Your order {orderId} has shipped!',
    headline: 'Your Order is On Its Way!',
    message: 'Your order has been shipped and is heading to you. You can track its journey below.',
    buttonText: 'Track Shipment',
  },
  'In Transit': {
    emoji: '🛣️',
    subject: 'Your order {orderId} is on the way!',
    headline: 'In Transit',
    message: 'Your order is on its way to your city. It will arrive soon!',
    buttonText: 'Track Live',
  },
  'Out for Delivery': {
    emoji: '🏠',
    subject: 'Your order {orderId} is out for delivery today!',
    headline: 'Out for Delivery!',
    message: 'Exciting! Your order is out for delivery and will reach you today. Please keep your phone handy.',
    buttonText: 'Track Delivery',
  },
  'Delivered': {
    emoji: '🎉',
    subject: 'Your order {orderId} has been delivered!',
    headline: 'Delivered Successfully!',
    message: 'Your order has been delivered. We hope you love your purchase!',
    buttonText: 'View Order Details',
  },
};

function wrapInLayout(data: TemplateData, innerContent: string): string {
  const brandColor = data.primaryColor || BRAND_COLOR;
  const logoSection = data.businessLogoUrl
    ? `<img src="${data.businessLogoUrl}" alt="${data.businessName}" style="height:40px;max-width:160px;object-fit:contain;" />`
    : `<span style="font-size:20px;font-weight:700;color:${brandColor};">${data.businessName}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${data.businessName} — Order Update</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background-color:${LIGHT_BG};color:${TEXT_COLOR};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${LIGHT_BG};">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:${CARD_BG};border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">

<!-- Header -->
<tr><td style="padding:24px 32px;text-align:center;border-bottom:1px solid #E2E8F0;">
  ${logoSection}
</td></tr>

<!-- Body -->
<tr><td style="padding:32px;">
  ${innerContent}
</td></tr>

<!-- Footer -->
<tr><td style="padding:24px 32px;background-color:#F1F5F9;text-align:center;border-top:1px solid #E2E8F0;">
  <p style="margin:0 0 8px;font-size:13px;color:${MUTED_COLOR};">
    Need help? Contact us
  </p>
  <p style="margin:0;font-size:13px;color:${MUTED_COLOR};">
    ${data.supportEmail ? `📧 ${data.supportEmail}` : ''}
    ${data.supportPhone ? ` &nbsp;|&nbsp; 📞 ${data.supportPhone}` : ''}
  </p>
  <p style="margin:16px 0 0;font-size:11px;color:#94A3B8;">
    Powered by ShipTrack
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export function generateTrackingEmail(
  data: TemplateData,
  status: string
): { subject: string; html: string } | null {
  const config = STATUS_CONFIG[status];
  if (!config) return null;

  const subject = config.subject.replace('{orderId}', data.orderId);

  const productList = data.productNames.length > 0
    ? data.productNames.map((p) =>
        `<tr><td style="padding:8px 12px;font-size:13px;border-bottom:1px solid #F1F5F9;">${p}</td></tr>`
      ).join('')
    : '<tr><td style="padding:8px 12px;font-size:13px;color:#94A3B8;">—</td></tr>';

  const trackingRow = data.trackingId && data.trackingId !== '—'
    ? `<tr>
        <td style="padding:6px 0;font-size:13px;color:${MUTED_COLOR};">Tracking ID</td>
        <td style="padding:6px 0;font-size:13px;font-weight:600;text-align:right;">${data.trackingId}</td>
       </tr>`
    : '';

  const courierRow = data.courierPartner
    ? `<tr>
        <td style="padding:6px 0;font-size:13px;color:${MUTED_COLOR};">Courier</td>
        <td style="padding:6px 0;font-size:13px;font-weight:600;text-align:right;">${data.courierPartner}</td>
       </tr>`
    : '';

  const deliveryRow = data.estimatedDelivery
    ? `<tr>
        <td style="padding:6px 0;font-size:13px;color:${MUTED_COLOR};">Est. Delivery</td>
        <td style="padding:6px 0;font-size:13px;font-weight:600;text-align:right;">${new Date(data.estimatedDelivery).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</td>
       </tr>`
    : '';

  const innerContent = `
    <!-- Status Badge -->
    <div style="text-align:center;margin-bottom:24px;">
      <span style="font-size:48px;">${config.emoji}</span>
      <h1 style="margin:12px 0 4px;font-size:22px;font-weight:700;color:${TEXT_COLOR};">${config.headline}</h1>
      <p style="margin:0;font-size:14px;color:${MUTED_COLOR};">${config.message}</p>
    </div>

    <!-- Order Info -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;background:${LIGHT_BG};border-radius:8px;padding:16px;">
      <tr>
        <td style="padding:6px 16px;font-size:13px;color:${MUTED_COLOR};">Order ID</td>
        <td style="padding:6px 16px;font-size:13px;font-weight:600;text-align:right;">${data.orderId}</td>
      </tr>
      <tr>
        <td style="padding:6px 16px;font-size:13px;color:${MUTED_COLOR};">Delivery City</td>
        <td style="padding:6px 16px;font-size:13px;font-weight:600;text-align:right;">${data.city}</td>
      </tr>
      ${trackingRow ? trackingRow.replace(/padding:6px 0/g, 'padding:6px 16px') : ''}
      ${courierRow ? courierRow.replace(/padding:6px 0/g, 'padding:6px 16px') : ''}
      ${deliveryRow ? deliveryRow.replace(/padding:6px 0/g, 'padding:6px 16px') : ''}
    </table>

    <!-- Products -->
    ${data.productNames.length > 0 ? `
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;text-transform:uppercase;color:${MUTED_COLOR};letter-spacing:0.5px;">Products</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;background:${LIGHT_BG};border-radius:8px;">
      ${productList}
    </table>
    ` : ''}

    <!-- CTA Button -->
    <div style="text-align:center;margin:28px 0 8px;">
      <a href="${data.trackingUrl}" style="display:inline-block;padding:14px 32px;background-color:${data.primaryColor || BRAND_COLOR};color:white;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.3px;">
        ${config.buttonText} →
      </a>
    </div>
    <p style="text-align:center;margin:12px 0 0;font-size:12px;color:${MUTED_COLOR};">
      Or copy this link: <a href="${data.trackingUrl}" style="color:${BRAND_COLOR};word-break:break-all;">${data.trackingUrl}</a>
    </p>
  `;

  return {
    subject: `${config.emoji} ${subject} — ${data.businessName}`,
    html: wrapInLayout(data, innerContent),
  };
}

// Get customizable subject lines (for settings page)
export function getDefaultSubjects(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [status, cfg] of Object.entries(STATUS_CONFIG)) {
    out[status] = `${cfg.emoji} ${cfg.subject} — {businessName}`;
  }
  return out;
}
