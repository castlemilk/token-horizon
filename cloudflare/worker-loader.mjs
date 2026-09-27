// Node test adapter only: application handlers are plain objects, not RPC classes.
// All OAuth/crypto/HTTP code still runs from the actual pinned provider package.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true };
  return nextResolve(specifier, context);
}
