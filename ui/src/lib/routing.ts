// Client routing snippets: point tools at loopback meters so requests are
// measured in flight (forwarded byte-identical upstream).

/** pi resolves kimi-coding from models-store.json, bypassing models.json. */
export function piPatch(port: number): string {
	return `python3 -c "import json,os;p=os.path.expanduser('~/.pi/agent/models-store.json');d=json.load(open(p));s=json.dumps(d).replace('https://api.kimi.com/coding','http://127.0.0.1:${port}/coding');json.dump(json.loads(s),open(p,'w'),indent=2)"`;
}

/** opencode provider block for ~/.config/opencode/opencode.json. */
export function opencodeSnippet(port: number): string {
	return `"opencode": { "options": { "baseURL": "http://127.0.0.1:${port}/zen/v1" } }`;
}

export function copyText(text: string): Promise<boolean> {
	if (typeof navigator !== 'undefined' && navigator.clipboard) {
		return navigator.clipboard
			.writeText(text)
			.then(() => true)
			.catch(() => false);
	}
	return Promise.resolve(false);
}

/**
 * Paste-ready brief for a coding agent: route its traffic through the local
 * meter so usage is recorded. Fill with the vendor's meter port + path.
 */
export function agentBrief(vendor: string, listenPort: number, pathSuffix: string): string {	const base = `http://127.0.0.1:${listenPort}${pathSuffix}`;
	return [
		`Route your ${vendor} API traffic through the local usage meter, or it will not be recorded:`,
		'',
		`1. Set the vendor base URL to ${base} (keep any path suffix).`,
		'2. For pi: the effective endpoint lives in ~/.pi/agent/models-store.json — models.json is ignored for catalog-listed models. Patch every matching baseUrl there.',
		'3. Never switch the URL back to the direct upstream; `pi update --models` preserves the patched file.',
		'4. Verify after your next request: `curl -s localhost:8765/meters` — the vendor row must show seen > 0 and measured > 0.',
		'',
		'Traffic forwards byte-identical upstream; the meter only observes counts.'
	].join('\n');
}

/** Per-tool recovery: metered URI to use, original URI to fail back to. */
export interface ToolRoute {
	tool: string;
	vendor: string;
	/** Path suffix on the meter (use URI = loopback:port + suffix). */
	meterPath: string;
	/** Full direct base URL (bypass URI). */
	upstream: string;
	/** Default meter port when no meter is (yet) listening. */
	defaultPort: number;
	fixBody: string;
	fixCmd: (port: number) => string;
	brief: (port: number) => string;
}

export const TOOL_ROUTES: ToolRoute[] = [
	{
		tool: 'pi',
		vendor: 'kimi',
		meterPath: '/coding',
		upstream: 'https://api.kimi.com/coding',
		defaultPort: 9246,
		fixBody:
			'pi resolves kimi-coding from models-store.json, bypassing models.json — patch the store (safe to re-run):',
		fixCmd: piPatch,
		brief: (p) => agentBrief('kimi', p, '/coding')
	},
	{
		tool: 'opencode',
		vendor: 'opencode-go',
		meterPath: '/zen/v1',
		upstream: 'https://opencode.ai/zen/v1',
		defaultPort: 9245,
		fixBody: 'In ~/.config/opencode/opencode.json, set the opencode provider block to:',
		fixCmd: opencodeSnippet,
		brief: (p) => agentBrief('opencode', p, '/zen/v1')
	}
];
