import {Config} from '@remotion/cli/config';

// Render-speed optimizations: JPEG frames (fast encode, tiny quality loss at
// these flat colors), capped concurrency headroom, bundled Chromium.
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(85);
Config.setChromiumOpenGlRenderer('angle');
Config.setDelayRenderTimeoutInMilliseconds(30000);
