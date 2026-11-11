/**
 * Gallery pose: the public showcase scenario for this task (R = 4.6 ohm,
 * L = 4.7 mH, C = 22 nF, output C): a 40 dB resonant spike and a ringing step.
 * It uses only the prompt's public contract. No check reads these values, and
 * they are not hidden inputs.
 */
export const pose = `(arg) => {
  __bench.set({ R: 4.6, L: 0.0047, C: 22e-9, output: 'C' });
  return true;
}`
