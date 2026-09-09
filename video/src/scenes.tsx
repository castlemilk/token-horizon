import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, MONO, fmtTokens} from './theme';
import {Headline, Kicker, Logo, QuotaRow, Rise, Scene} from './components';

// Module-level tables: zero per-frame allocation in the render loop.
const CHAOS = [
  {name: 'Codex', tokens: 731_172_293, x: -560, y: -260, drift: 26},
  {name: 'Claude', tokens: 672_044_289, x: 480, y: -300, drift: -34},
  {name: 'Kimi', tokens: 98_637_581, x: -620, y: 240, drift: -22},
  {name: 'Gemini', tokens: 73_618_152, x: 560, y: 260, drift: 30},
  {name: 'GLM', tokens: 12_108_801, x: 40, y: -360, drift: 18},
  {name: 'MiniMax', tokens: 8_412_004, x: -80, y: 340, drift: -16},
];

const SPLIT = [
  {name: 'Codex', share: 47, color: C.cyan},
  {name: 'Claude', share: 31, color: C.orange},
  {name: 'Kimi', share: 22, color: C.accent},
];

const LIMITS = [
  {name: 'Codex · 5 hour', pct: 68, reset: 'resets in 3h 12m'},
  {name: 'Claude · 7 day', pct: 41, reset: 'resets Fri 11:59 am'},
  {name: 'Fable · weekly', pct: 90, reset: 'resets in 2d 3h', accent: C.orange},
  {name: 'Kimi · weekly', pct: 83, reset: 'resets Sat 2:53 am'},
];

const CMD = 'curl -fsSL https://raw.githubusercontent.com/castlemilk/token-horizon/main/install.sh | bash';

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [70, 110], [1, 0], {extrapolateRight: 'clamp'});
  return (
    <div style={{opacity: fade, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 44}}>
      <Logo size={190} />
      <Rise>
        <Headline>
          Your AI usage.
          <br />
          <span style={{color: C.cyan}}>On the horizon.</span>
        </Headline>
      </Rise>
    </div>
  );
};

export const Chaos: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const gather = interpolate(frame, [fps * 3.4, fps * 5.4], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 30, width: '100%'}}>
      <Kicker>TOKENS EVERYWHERE. ANSWERS NOWHERE.</Kicker>
      <div style={{position: 'relative', width: 1500, height: 640}}>
        {CHAOS.map((c) => {
          const wobble = Math.sin((frame / fps) * 1.4 + c.x) * c.drift * (1 - gather);
          const x = c.x * (1 - gather) + wobble;
          const y = c.y * (1 - gather);
          const shown = Math.round(c.tokens * interpolate(frame, [0, fps * 2.6], [0, 1], {extrapolateRight: 'clamp'}));
          return (
            <div
              key={c.name}
              style={{
                position: 'absolute',
                left: 750 + x,
                top: 300 + y,
                transform: 'translate(-50%,-50%)',
                opacity: interpolate(frame, [fps * 4.6, fps * 5.6], [1, 0], {extrapolateRight: 'clamp'}),
                background: 'rgba(255,255,255,0.05)',
                border: `1px solid ${C.line}`,
                borderRadius: 18,
                padding: '22px 34px',
                textAlign: 'center',
              }}
            >
              <div style={{fontFamily: MONO, fontSize: 30, color: C.muted}}>{c.name}</div>
              <div style={{fontFamily: MONO, fontSize: 52, fontWeight: 700}}>{fmtTokens(shown)}</div>
            </div>
          );
        })}
        <div
          style={{
            position: 'absolute',
            left: 750,
            top: 300,
            transform: 'translate(-50%,-50%)',
            opacity: interpolate(frame, [fps * 4.8, fps * 5.8], [0, 1], {extrapolateRight: 'clamp'}),
            textAlign: 'center',
          }}
        >
          <div style={{fontFamily: MONO, fontSize: 30, letterSpacing: 6, color: C.cyan}}>ONE QUIET VIEW</div>
          <div style={{fontFamily: MONO, fontSize: 76, fontWeight: 800}}>1.84M today</div>
        </div>
      </div>
    </div>
  );
};

export const Notch: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const expand = interpolate(frame, [0, fps * 1.6], [0, 1], {extrapolateRight: 'clamp'});
  const tokens = Math.round(1_840_000 * interpolate(frame, [fps * 0.8, fps * 5.6], [0, 1], {extrapolateRight: 'clamp'}));
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34}}>
      <Kicker>LIVES IN THE NOTCH</Kicker>
      <div style={{width: 260, height: 34, background: '#000', borderRadius: '0 0 22 22'}} />
      <div
        style={{
          width: 760,
          background: 'rgba(10,10,15,0.97)',
          border: `1px solid ${C.line}`,
          borderRadius: 26,
          padding: '40px 48px',
          opacity: expand,
          transform: `translateY(${interpolate(expand, [0, 1], [-30, 0])}px) scale(${interpolate(expand, [0, 1], [0.94, 1])})`,
        }}
      >
        <div style={{fontFamily: MONO, fontSize: 22, letterSpacing: 5, color: C.muted}}>TOKENS TODAY</div>
        <div style={{fontFamily: MONO, fontSize: 104, fontWeight: 800, color: C.green}}>{fmtTokens(tokens)}</div>
        <div style={{display: 'flex', flexDirection: 'column', gap: 18, marginTop: 26}}>
          {SPLIT.map((s, i) => {
            const fill = interpolate(frame - i * 14, [fps * 1.4, fps * 3.4], [0, 1], {extrapolateRight: 'clamp'});
            return (
              <div key={s.name} style={{display: 'flex', alignItems: 'center', gap: 20}}>
                <div style={{width: 150, fontFamily: MONO, fontSize: 28}}>{s.name}</div>
                <div style={{flex: 1, height: 20, borderRadius: 10, background: 'rgba(255,255,255,0.09)'}}>
                  <div style={{width: `${s.share * fill}%`, height: '100%', borderRadius: 10, background: s.color}} />
                </div>
                <div style={{width: 110, fontFamily: MONO, fontSize: 32, fontWeight: 700, textAlign: 'right'}}>
                  {Math.round(s.share * fill)}%
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const Limits: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 44}}>
      <div style={{textAlign: 'center'}}>
        <Kicker>BEAT THE RESET</Kicker>
        <div style={{height: 18}} />
        <Headline>
          Every plan limit, <span style={{color: C.orange}}>legible.</span>
        </Headline>
      </div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 30}}>
        {LIMITS.map((l, i) => (
          <QuotaRow
            key={l.name}
            name={l.name}
            pct={l.pct}
            reset={l.reset}
            accent={'accent' in l ? (l as {accent: string}).accent : undefined}
            progress={interpolate(frame - i * 12, [fps * 0.6, fps * 2.2], [0, 1], {extrapolateRight: 'clamp'})}
          />
        ))}
      </div>
      <div style={{fontFamily: MONO, fontSize: 26, color: C.orange}}>Fable at 90% — burn tokens before Friday.</div>
    </div>
  );
};

export const Local: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const tok = 40 + 22 * Math.sin(frame / fps / 2.4) + 6 * Math.sin(frame / fps / 0.7);
  return (
    <div style={{display: 'flex', alignItems: 'center', gap: 110}}>
      <div>
        <Kicker>PRIVATE BY DESIGN</Kicker>
        <div style={{height: 20}} />
        <Headline>
          Stays on
          <br />
          your Mac.
        </Headline>
        <div style={{height: 26}} />
        <div style={{fontFamily: MONO, fontSize: 30, color: C.muted}}>127.0.0.1 · loopback only</div>
        <div style={{fontFamily: MONO, fontSize: 30, color: C.muted}}>24H bounded history · 0 cloud DB</div>
      </div>
      <div
        style={{
          width: 420,
          height: 420,
          borderRadius: 210,
          border: `10px solid ${C.accent}`,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          boxShadow: '0 0 90px rgba(124,92,255,0.4)',
        }}
      >
        <div style={{fontFamily: MONO, fontSize: 96, fontWeight: 800}}>{tok.toFixed(0)}</div>
        <div style={{fontFamily: MONO, fontSize: 28, letterSpacing: 4, color: C.muted}}>TOK/S · MLX</div>
      </div>
    </div>
  );
};

export const CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const chars = Math.floor(interpolate(frame, [fps * 0.5, fps * 3.4], [0, CMD.length], {extrapolateRight: 'clamp'}));
  const endFade = interpolate(frame, [durationInFrames - 24, durationInFrames - 1], [1, 0], {extrapolateRight: 'clamp'});
  return (
    <div style={{opacity: endFade, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 50}}>
      <Logo size={130} />
      <Headline>
        Put your tokens <span style={{color: C.cyan}}>on the horizon.</span>
      </Headline>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 27,
          color: C.cyan,
          background: '#0a0a10',
          border: `1px solid ${C.line}`,
          borderRadius: 14,
          padding: '26px 34px',
          minWidth: 1420,
        }}
      >
        $ {CMD.slice(0, chars)}
        <span style={{opacity: frame % 30 < 15 ? 1 : 0}}>▊</span>
      </div>
      <div style={{fontFamily: MONO, fontSize: 24, color: C.faint}}>Apple silicon · free preview · castlemilk.github.io/token-horizon</div>
    </div>
  );
};
