import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, MONO, SANS} from './theme';

/** Black-hole app mark: dark disc, violet accretion glow, cyan tick ring. */
export const Logo: React.FC<{size?: number; glow?: number}> = ({size = 120, glow = 1}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pulse = 1 + 0.03 * Math.sin((frame / fps) * Math.PI * 2);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: 'radial-gradient(circle at 50% 50%, #000 52%, #14101f 74%, transparent 75%)',
        boxShadow: `0 0 ${size * 0.55 * glow}px rgba(124,92,255,${0.55 * glow}), 0 0 ${size * 0.2}px rgba(57,213,192,0.35)`,
        transform: `scale(${pulse})`,
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: size * 0.1,
          borderRadius: '50%',
          border: `${Math.max(2, size * 0.025)}px solid ${C.cyan}`,
          opacity: 0.85,
        }}
      />
    </div>
  );
};

/** Caption kicker used across scenes. */
export const Kicker: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div style={{fontFamily: MONO, fontSize: 26, letterSpacing: 8, color: C.cyan}}>{children}</div>
);

export const Headline: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div style={{fontFamily: SANS, fontWeight: 800, fontSize: 84, lineHeight: 1.04, letterSpacing: -2, color: C.text}}>
    {children}
  </div>
);

/** Fade-and-rise entrance wrapper shared by all scenes. */
export const Rise: React.FC<{children: React.ReactNode; delay?: number}> = ({children, delay = 0}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame: frame - delay, fps, config: {damping: 90, stiffness: 160}});
  const opacity = interpolate(frame - delay, [0, 12], [0, 1], {extrapolateRight: 'clamp'});
  return <div style={{opacity, transform: `translateY(${interpolate(p, [0, 1], [36, 0])}px)`}}>{children}</div>;
};

/** Single quota row: label, animated bar, used% + reset. Precomputed props. */
export const QuotaRow: React.FC<{
  name: string;
  pct: number;
  reset: string;
  progress: number; // 0..1 eased fill for this frame
  accent?: string;
}> = ({name, pct, reset, progress, accent}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: 22, width: 1180}}>
    <div style={{width: 330, fontFamily: MONO, fontSize: 30, color: C.text}}>{name}</div>
    <div style={{flex: 1, height: 22, borderRadius: 11, background: 'rgba(255,255,255,0.1)'}}>
      <div
        style={{
          width: `${Math.max(2, pct * progress)}%`,
          height: '100%',
          borderRadius: 11,
          background: accent ?? (pct >= 85 ? C.orange : C.green),
        }}
      />
    </div>
    <div style={{width: 130, fontFamily: MONO, fontSize: 34, fontWeight: 700, color: C.text, textAlign: 'right'}}>
      {Math.round(pct * progress)}%
    </div>
    <div style={{width: 300, fontFamily: MONO, fontSize: 24, color: C.muted}}>{reset}</div>
  </div>
);

/** Full-frame stage helper: centers content, sets base text color. */
export const Stage: React.FC<{children: React.ReactNode}> = ({children}) => (
  <AbsoluteFill
    style={{
      backgroundColor: C.bg,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      fontFamily: SANS,
      color: C.text,
      textAlign: 'center',
    }}
  >
    {children}
  </AbsoluteFill>
);

/**
 * Per-sequence frame. Each scene root fills the canvas and centers its own
 * content — immune to Sequence wrapper layout behavior in any Remotion
 * version (transparent children vs positioned fill divs).
 */
export const Scene: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      width: 1920,
      height: 1080,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      color: C.text,
      textAlign: 'center',
    }}
  >
    {children}
  </div>
);
