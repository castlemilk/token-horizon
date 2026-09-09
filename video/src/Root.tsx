import React from 'react';
import {Composition, Sequence} from 'remotion';
import {Scene, Stage} from './components';
import {CTA, Chaos, Hook, Limits, Local, Notch} from './scenes';

// 40s @30fps product film. Boundaries double as still-frame offsets for
// poster/OG renders (see package.json `still` + scene START constants).
export const HOOK_END = 120;
export const CHAOS_END = 300;
export const NOTCH_END = 540;
export const LIMITS_END = 780;
export const LOCAL_END = 990;
export const TOTAL = 1200;

const Shell: React.FC<{children: React.ReactNode}> = ({children}) => <Stage>{children}</Stage>;

export const TokenHorizonFilm: React.FC = () => (
  <Shell>
    <Sequence from={0} durationInFrames={HOOK_END}>
      <Scene><Hook /></Scene>
    </Sequence>
    <Sequence from={HOOK_END} durationInFrames={CHAOS_END - HOOK_END}>
      <Scene><Chaos /></Scene>
    </Sequence>
    <Sequence from={CHAOS_END} durationInFrames={NOTCH_END - CHAOS_END}>
      <Scene><Notch /></Scene>
    </Sequence>
    <Sequence from={NOTCH_END} durationInFrames={LIMITS_END - NOTCH_END}>
      <Scene><Limits /></Scene>
    </Sequence>
    <Sequence from={LIMITS_END} durationInFrames={LOCAL_END - LIMITS_END}>
      <Scene><Local /></Scene>
    </Sequence>
    <Sequence from={LOCAL_END} durationInFrames={TOTAL - LOCAL_END}>
      <Scene><CTA /></Scene>
    </Sequence>
  </Shell>
);

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="TokenHorizonFilm"
      component={TokenHorizonFilm}
      durationInFrames={TOTAL}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);
