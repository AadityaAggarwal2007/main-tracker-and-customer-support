'use client';

import { useId } from 'react';

// Chikki, the AI's face in Panel Settings (owner, 2026-10-01): a small robot that floats,
// sits, hops, tilts its head, blinks and waves while the AI is on, and dozes (eyes shut,
// "z z") while it is off. Pure SVG + CSS, no images; motion stops for people who ask their
// system for less motion. Staff screens only: customers never see the name Chikki.

const CSS = `
.ck-bot{overflow:visible;display:block}
.ck-bob{animation:ck-bob 3.2s ease-in-out infinite}
.ck-moves{transform-box:fill-box;transform-origin:50% 100%;animation:ck-moves 10s ease-in-out infinite}
.ck-shadow{transform-box:fill-box;transform-origin:50% 50%;animation:ck-shadow 3.2s ease-in-out infinite}
.ck-eyes{transform-box:fill-box;transform-origin:50% 50%;animation:ck-blink 4.7s infinite}
.ck-open{animation:ck-open 10s infinite}
.ck-happy{opacity:0;animation:ck-happy 10s infinite}
.ck-halo{transform-box:fill-box;transform-origin:50% 50%;animation:ck-halo 1.8s ease-in-out infinite}
.ck-heart{transform-box:fill-box;transform-origin:50% 50%;animation:ck-heart 1.4s ease-in-out infinite}
.ck-flame{transform-box:fill-box;transform-origin:50% 0;animation:ck-flame .26s ease-in-out infinite alternate}
.ck-arm-l{transform-box:fill-box;transform-origin:50% 8%;animation:ck-sway 3.2s ease-in-out infinite}
.ck-arm-r{transform-box:fill-box;transform-origin:50% 8%;animation:ck-wave 10s ease-in-out infinite}
.ck-bot:hover .ck-arm-r{animation:ck-wave-now .9s ease-in-out infinite}
.ck-glowy{filter:drop-shadow(0 0 2.5px rgba(94,234,212,.85))}
.ck-zz{display:none}
.ck-closed{display:none}
.ck-sleep .ck-moves,.ck-sleep .ck-arm-r,.ck-sleep .ck-arm-l,.ck-sleep .ck-halo,.ck-sleep .ck-heart{animation:none}
.ck-sleep .ck-bob,.ck-sleep .ck-shadow{animation-duration:5.5s}
.ck-sleep .ck-open,.ck-sleep .ck-happy,.ck-sleep .ck-flame{display:none}
.ck-sleep .ck-closed{display:inline}
.ck-sleep .ck-zz{display:inline}
.ck-sleep .ck-z{transform-box:fill-box;animation:ck-z 3s ease-in infinite;opacity:0}
.ck-sleep .ck-z2{animation-delay:1s}
.ck-sleep .ck-z3{animation-delay:2s}
.ck-sleep{filter:saturate(.35)}
@keyframes ck-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes ck-shadow{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(.78);opacity:.55}}
@keyframes ck-moves{
  0%,30%{transform:translateY(0) scale(1,1) rotate(0)}
  34%{transform:translateY(4px) scale(1.07,.9) rotate(0)}
  40%{transform:translateY(-11px) scale(.95,1.07) rotate(0)}
  46%{transform:translateY(1px) scale(1.04,.95) rotate(0)}
  50%{transform:translateY(0) scale(1,1) rotate(0)}
  60%{transform:rotate(-8deg)}
  68%{transform:rotate(7deg)}
  74%{transform:rotate(-3deg)}
  78%,100%{transform:rotate(0)}
}
@keyframes ck-blink{0%,91%,95%,100%{transform:scaleY(1)}93%{transform:scaleY(.12)}}
@keyframes ck-open{0%,37%,49%,100%{opacity:1}38%,48%{opacity:0}}
@keyframes ck-happy{0%,37%,49%,100%{opacity:0}38%,48%{opacity:1}}
@keyframes ck-halo{0%,100%{transform:scale(.8);opacity:.35}50%{transform:scale(1.25);opacity:.9}}
@keyframes ck-heart{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.3);opacity:1}}
@keyframes ck-flame{from{transform:scaleY(.72);opacity:.75}to{transform:scaleY(1.12);opacity:1}}
@keyframes ck-sway{0%,100%{transform:rotate(0)}50%{transform:rotate(9deg)}}
@keyframes ck-wave{0%,80%,98%,100%{transform:rotate(0)}83%{transform:rotate(-140deg)}86%{transform:rotate(-112deg)}89%{transform:rotate(-142deg)}92%{transform:rotate(-112deg)}95%{transform:rotate(-135deg)}}
@keyframes ck-wave-now{0%,100%{transform:rotate(-135deg)}50%{transform:rotate(-108deg)}}
@keyframes ck-z{0%{transform:translate(0,0) scale(.6);opacity:0}25%{opacity:.9}100%{transform:translate(9px,-16px) scale(1.15);opacity:0}}
@media (prefers-reduced-motion:reduce){.ck-bot,.ck-bot *{animation:none!important}}
`;

export default function ChikkiBot({ size = 72, active = true }: { size?: number; active?: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const id = (name: string) => `ck${uid}${name}`;
  const url = (name: string) => `url(#${id(name)})`;
  return (
    <svg
      className={`ck-bot${active ? '' : ' ck-sleep'}`}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label={active ? 'Chikki, the AI, is on' : 'Chikki, the AI, is off'}
    >
      <style>{CSS}</style>
      <defs>
        <linearGradient id={id('shell')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e4e9ff" />
        </linearGradient>
        <linearGradient id={id('accent')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b7cfa" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id={id('screen')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#111a3a" />
          <stop offset="1" stopColor="#2a1f5c" />
        </linearGradient>
        <radialGradient id={id('glow')}>
          <stop offset="0" stopColor="#67e8f9" stopOpacity="0.95" />
          <stop offset="1" stopColor="#67e8f9" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('jet')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a5f3fc" />
          <stop offset="1" stopColor="#818cf8" stopOpacity="0" />
        </linearGradient>
      </defs>

      <ellipse className="ck-shadow" cx="60" cy="113" rx="19" ry="3.6" fill="#3b4bb8" opacity="0.16" />

      <g className="ck-bob">
        <g className="ck-moves">
          {/* little jet under the body: it hovers */}
          <path className="ck-flame" d="M54.5 97 Q60 112 65.5 97 Z" fill={url('jet')} />

          {/* antenna */}
          <path d="M60 22 Q59 16 60 12.5" stroke="#6d7ff7" strokeWidth="2.6" fill="none" strokeLinecap="round" />
          <circle className="ck-halo" cx="60" cy="10" r="9" fill={url('glow')} />
          <circle cx="60" cy="10" r="4.4" fill="#22d3ee" stroke="#ffffff" strokeWidth="1.2" />

          {/* ears */}
          <circle cx="21" cy="47" r="7.5" fill={url('accent')} />
          <circle cx="21" cy="47" r="3" fill="#c7d2fe" />
          <circle cx="99" cy="47" r="7.5" fill={url('accent')} />
          <circle cx="99" cy="47" r="3" fill="#c7d2fe" />

          {/* head */}
          <rect x="22" y="19" width="76" height="57" rx="27" fill={url('shell')} stroke="#cfd7ff" strokeWidth="1.5" />
          <ellipse cx="39" cy="27" rx="8" ry="3.2" fill="#ffffff" opacity="0.9" transform="rotate(-18 39 27)" />

          {/* face screen */}
          <rect x="31" y="30" width="58" height="37" rx="17.5" fill={url('screen')} />
          <g className="ck-open">
            <g className="ck-eyes ck-glowy">
              <rect x="44" y="40" width="9" height="13" rx="4.5" fill="#5eead4" />
              <rect x="67" y="40" width="9" height="13" rx="4.5" fill="#5eead4" />
              <circle cx="50.5" cy="43.5" r="1.6" fill="#ffffff" opacity="0.9" />
              <circle cx="73.5" cy="43.5" r="1.6" fill="#ffffff" opacity="0.9" />
            </g>
          </g>
          {/* happy eyes while it hops */}
          <g className="ck-happy ck-glowy" stroke="#5eead4" strokeWidth="3" fill="none" strokeLinecap="round">
            <path d="M43.5 49 Q48.5 41 53.5 49" />
            <path d="M66.5 49 Q71.5 41 76.5 49" />
          </g>
          {/* shut eyes while it sleeps */}
          <g className="ck-closed" stroke="#5eead4" strokeWidth="2.6" fill="none" strokeLinecap="round">
            <path d="M43.5 47 Q48.5 51 53.5 47" />
            <path d="M66.5 47 Q71.5 51 76.5 47" />
          </g>
          <path d="M55.5 58 Q60 61.8 64.5 58" stroke="#5eead4" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <circle cx="39.5" cy="58" r="3.1" fill="#fb7185" opacity="0.5" />
          <circle cx="80.5" cy="58" r="3.1" fill="#fb7185" opacity="0.5" />

          {/* body, floating under the head */}
          <ellipse cx="60" cy="88" rx="15.5" ry="11" fill={url('shell')} stroke="#cfd7ff" strokeWidth="1.5" />
          <circle className="ck-heart" cx="60" cy="88" r="3.6" fill={url('accent')} />

          {/* floating arms */}
          <g transform="rotate(22 41 79)">
            <rect className="ck-arm-l" x="37.5" y="78" width="7" height="15" rx="3.5" fill={url('accent')} />
          </g>
          <g transform="rotate(-22 79 79)">
            <rect className="ck-arm-r" x="75.5" y="78" width="7" height="15" rx="3.5" fill={url('accent')} />
          </g>
        </g>
      </g>

      {/* z z while the AI is off */}
      <g className="ck-zz" fill="#7c8db5" fontFamily="Inter, sans-serif" fontWeight="700">
        <text className="ck-z" x="92" y="28" fontSize="15">z</text>
        <text className="ck-z ck-z2" x="100" y="19" fontSize="12">z</text>
        <text className="ck-z ck-z3" x="107" y="11" fontSize="10">z</text>
      </g>
    </svg>
  );
}
