'use client';

// A phone showing how the customer will see us on WhatsApp (owner 2026-10-10: "preview screen bhi bana do ki
// kaisa dikhega humara message"): the chat header (picture, name customers see, "Business account") and one
// message bubble (bold header, the body with the values in, the grey footer, the time and the ticks); or the
// business profile sheet. Pure drawing; nothing is sent.
import { MessageSquareText } from 'lucide-react';

export interface PreviewMessage { header?: string | null; body: string; footer?: string | null }

function Avatar({ src, name, size }: { src: string | null; name: string; size: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', background: '#dfe5e7', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
      {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontWeight: 700, color: '#54656f', fontSize: size * 0.4 }}>{(name || 'S').slice(0, 1).toUpperCase()}</span>}
    </div>
  );
}

// WhatsApp's own rendering: *bold*, _italic_, ~strike~ and line breaks.
export function waText(text: string) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|\n)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p === '\n') return <br key={i} />;
    if (/^\*[^*]+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>;
    if (/^_[^_]+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
    if (/^~[^~]+~$/.test(p)) return <s key={i}>{p.slice(1, -1)}</s>;
    return <span key={i}>{p}</span>;
  });
}

export default function PhonePreview({ name, picture, message, profile, time = '10:42 am' }: {
  name: string; picture: string | null;
  message?: PreviewMessage | null;
  profile?: { about: string; description: string; address: string; email: string; websites: string[]; category: string } | null;
  time?: string;
}) {
  const shown = name || 'Shiptrack';
  return (
    <div className="wa-phone" aria-label="Preview of the customer's WhatsApp screen">
      <div className="wa-phone-top">
        <span className="wa-phone-time">{time.replace(/ ?[ap]m/i, '')}</span>
        <span className="wa-phone-signal">●●● ▲ ▮</span>
      </div>
      {profile ? (
        <div className="wa-profile">
          <div style={{ display: 'grid', placeItems: 'center', padding: '1rem 0 0.5rem' }}><Avatar src={picture} name={shown} size={96} /></div>
          <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '1.05rem' }}>{shown}</div>
          <div style={{ textAlign: 'center', fontSize: '0.75rem', color: '#667781', marginBottom: '0.75rem' }}>Business account · {profile.category}</div>
          {profile.about && <div className="wa-profile-row"><span>About</span>{profile.about}</div>}
          {profile.description && <div className="wa-profile-row"><span>Description</span>{profile.description}</div>}
          {profile.address && <div className="wa-profile-row"><span>Address</span>{profile.address}</div>}
          {profile.email && <div className="wa-profile-row"><span>Email</span>{profile.email}</div>}
          {profile.websites.map((w) => <div key={w} className="wa-profile-row"><span>Website</span><span style={{ color: '#027eb5' }}>{w}</span></div>)}
          {!profile.about && !profile.description && !profile.address && !profile.email && profile.websites.length === 0 && (
            <div style={{ fontSize: '0.8rem', color: '#667781', textAlign: 'center', padding: '1rem' }}>Nothing on the profile yet.</div>
          )}
        </div>
      ) : (
        <>
          <div className="wa-header">
            <span style={{ color: '#fff', fontSize: '1.1rem' }}>‹</span>
            <Avatar src={picture} name={shown} size={34} />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#fff', fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shown}</div>
              <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: '0.7rem' }}>Business account</div>
            </div>
          </div>
          <div className="wa-chat">
            <div className="wa-day">Today</div>
            {message && (message.body || message.header) ? (
              <div className="wa-bubble">
                {message.header && <div style={{ fontWeight: 700, marginBottom: 2 }}>{message.header}</div>}
                <div>{waText(message.body || ' ')}</div>
                {message.footer && <div style={{ color: '#8696a0', fontSize: '0.72rem', marginTop: 4 }}>{message.footer}</div>}
                <div className="wa-meta">{time} <span style={{ color: '#53bdeb' }}>✓✓</span></div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: '#667781', fontSize: '0.75rem', marginTop: '2rem', display: 'grid', placeItems: 'center', gap: 6 }}>
                <MessageSquareText size={20} />Your message shows here as you type
              </div>
            )}
          </div>
          <div className="wa-compose"><span>Message</span><span className="wa-mic">🎤</span></div>
        </>
      )}
    </div>
  );
}
