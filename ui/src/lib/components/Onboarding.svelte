<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { api, apiBase, discoverApiBase, setApiBase, type ConsentState, type CapabilityStatus } from '$lib/api';
	import { piPatch, opencodeSnippet, agentBrief, copyText } from '$lib/routing';
	import OSIcon from '$lib/components/OSIcon.svelte';
	import ProviderIcon from '$lib/components/ProviderIcon.svelte';

	const FLAG = 'token-horizon.onboarded';

	let open = $state(false);
	let step = $state(0);
	let connected = $state(false);
	let platform = $state('');
	let checking = $state(false);
	let consents = $state<ConsentState[]>([]);
	let capabilities = $state<CapabilityStatus[]>([]);
	let copied = $state<string | null>(null);
	let baseUrl = $state(apiBase());

	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	const SCOPES = [
		{
			id: 'metering',
			title: 'Measure requests',
			body: 'Loopback relays observe per-request token usage. Bytes forward to the real API unchanged; only counts are kept.'
		},
		{
			id: 'fileReading',
			title: 'Read tool session files',
			body: 'Joins tool labels and reported costs onto metered requests. Files never create usage rows.'
		},
		{
			id: 'telemetry',
			title: 'Watch local runtimes',
			body: 'Detects local models and scrapes their speed counters. Prompts and outputs are never read.'
		}
	];

	function granted(id: string): boolean | null {
		if (consents.length === 0) return null;
		return consents.find((c) => c.scope === id)?.granted ?? false;
	}

	async function refreshConsents() {
		try {
			consents = (await api.consents())?.scopes ?? [];
		} catch {
			/* daemon down — listener step gates this */
		}
		try {
			capabilities = (await api.permissions())?.permissions ?? [];
		} catch {
			/* optional display */
		}
	}

	async function setConsent(scope: string, value: boolean) {
		try {
			await api.setConsent(scope, value);
			await refreshConsents();
		} catch {
			/* listener step gates this */
		}
	}

	async function checkListener() {
		checking = true;
		try {
			const h = await api.health();
			connected = true;
			platform = h.platform;
			await refreshConsents();
		} catch {
			try {
				const found = await discoverApiBase();
				if (found) {
					setApiBase(found);
					const h = await api.health();
					connected = true;
					platform = h.platform;
					await refreshConsents();
				} else {
					connected = false;
				}
			} catch {
				connected = false;
			}
		}
		checking = false;
	}

	function copy(text: string, key: string) {
		void copyText(text).then((ok) => {
			if (ok) {
				copied = key;
				setTimeout(() => (copied = null), 1500);
			}
		});
	}

	function finish() {
		try {
			localStorage.setItem(FLAG, '1');
		} catch {
			/* private mode — shows again next launch */
		}
		open = false;
	}

	onMount(() => {
		let shown = false;
		try {
			shown = localStorage.getItem(FLAG) === '1';
		} catch {
			/* private mode — always show */
		}
		if (!shown) {
			open = true;
			void checkListener();
		}
	});

	/* freeze the page behind the modal — no wheel/background scroll */
	$effect(() => {
		if (typeof document === 'undefined') return;
		if (open) {
			const prev = document.body.style.overflow;
			document.body.style.overflow = 'hidden';
			return () => {
				document.body.style.overflow = prev;
			};
		}
	});
</script>

{#if open}
	<div class="ob-backdrop" transition:fade={{ duration: reduce ? 0 : 200 }}>
		<div class="ob-card" transition:fly={{ y: reduce ? 0 : 14, duration: reduce ? 0 : 280 }}>
			{#if step > 0}
				<div class="ob-dots" aria-hidden="true">
					{#each [1, 2, 3] as n}
						<span class="ob-dot" class:on={step >= n} class:now={step === n}></span>
					{/each}
				</div>
			{/if}
			{#key step}
				<div class="ob-step" in:fly={{ x: reduce ? 0 : 18, duration: reduce ? 0 : 240 }}>
			{#if step === 0}
				<div class="ob-kicker">Token Horizon</div>
				<h2>See every token you spend.</h2>
				<p class="dim">
					Token Horizon measures AI usage through tiny loopback relays on
					this machine: per request, per model, per tool. Nothing leaves
					the machine to do it.
				</p>
				<div class="ob-brands" aria-hidden="true">
					<ProviderIcon vendor="kimi" size={30} />
					<ProviderIcon vendor="claude" size={30} />
					<ProviderIcon vendor="opencode" size={30} />
					<ProviderIcon vendor="codex" size={30} />
					<ProviderIcon vendor="ollama" size={30} />
				</div>
				<div class="ob-actions">
					<button class="btn ob-primary" onclick={() => (step = 1)}>Set up</button>
				</div>
			{:else if step === 1}
				<div class="ob-kicker">Step 1 of 3 · Listener</div>
				<h2>Connect to the daemon.</h2>
				<p class="dim">
					The background daemon hosts the meters. It should already be
					running on this machine.
				</p>
				<div class="ob-status">
					<span class="dot" class:up={connected}></span>
					{#if connected}
						<OSIcon {platform} size={13} />
						<span>Listener reachable{platform ? ` · ${platform}` : ''}</span>
					{:else}
						<span>Listener unreachable</span>
					{/if}
					<button class="btn" disabled={checking} onclick={() => void checkListener()}>
						{checking ? 'Checking…' : 'Retry'}
					</button>
				</div>
				{#if !connected}
					<p class="dim ob-note">
						Start the daemon (<span class="mono">token-horizon-headless</span>,
						or <span class="mono">scripts/run-dev.sh</span> from the repo),
						then Retry.
					</p>
					<div class="ob-reconnect">
						<div>
							<div class="ob-scope-title">Reconnect to the original URL</div>
							<div class="dim ob-scope-body">The app keeps trying this address:</div>
							<code class="cmd">{baseUrl}</code>
						</div>
						<div class="ob-scope-actions">
							<button class="btn" onclick={() => copy(baseUrl, 'url')}>
								{copied === 'url' ? 'Copied' : 'Copy'}
							</button>
						</div>
					</div>
				{/if}
				<div class="ob-actions">
					<button class="btn" onclick={() => (step = 0)}>Back</button>
					<button class="btn ob-primary" disabled={!connected} onclick={() => (step = 2)}>
						Continue
					</button>
				</div>
			{:else if step === 2}
				<div class="ob-kicker">Step 2 of 3 · Permissions</div>
				<h2>What may it do?</h2>
				<p class="dim">
					Each scope can be revoked anytime. TLS interception stays off
					and is never requested here.
				</p>
				<div class="stack">
					{#each SCOPES as s}
						{@const g = granted(s.id)}
						<div class="ob-scope">
							<div>
								<div class="ob-scope-title">{s.title}</div>
								<div class="dim ob-scope-body">{s.body}</div>
							</div>
							<div class="ob-scope-actions">
								{#if g === true}
									<span class="ok ob-state">Allowed</span>
									<button class="btn" onclick={() => void setConsent(s.id, false)}>Deny</button>
								{:else if g === false}
									<button class="btn ob-primary" onclick={() => void setConsent(s.id, true)}>Allow</button>
								{:else}
									<span class="faint ob-state">…</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
				{#if capabilities.length > 0}
					<div class="ob-caps">
						{#each capabilities as c}
							<div class="ob-cap" title={c.detail}>
								<span
									class="dot"
									class:up={c.state === 'granted'}
									class:down={c.state === 'denied'}
								></span>
								<span>{c.capability}</span>
								{#if c.state !== 'granted' && c.remediation.length > 0}
									<span class="faint">· {c.remediation[0]}</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
				<div class="ob-actions">
					<button class="btn" onclick={() => (step = 1)}>Back</button>
					<button class="btn ob-primary" onclick={() => (step = 3)}>Continue</button>
				</div>
			{:else}
				<div class="ob-kicker">Step 3 of 3 · Clients</div>
				<h2>Route your tools through it.</h2>
				<p class="dim">
					Point each tool at its loopback meter. Traffic forwards
					byte-identical upstream and is measured in flight.
				</p>
				<div class="stack">
					<div class="ob-scope ob-route">
						<div class="ob-route-head">
							<div class="ob-scope-title">pi → kimi meter</div>
							<div class="ob-scope-actions">
								<button class="btn" onclick={() => copy(piPatch(9246), 'pi')}>
									{copied === 'pi' ? 'Copied' : 'Copy'}
								</button>
								<button
									class="btn"
									title="Copy paste-ready instructions for a coding agent"
									onclick={() => copy(agentBrief('kimi', 9246, '/coding'), 'pi-brief')}
								>
									{copied === 'pi-brief' ? 'Copied' : 'Agent brief'}
								</button>
							</div>
						</div>
						<div class="dim ob-scope-body">
							pi resolves kimi-coding from <span class="mono">models-store.json</span>,
							bypassing <span class="mono">models.json</span>. Run once:
						</div>
						<code class="cmd">{piPatch(9246)}</code>
					</div>
					<div class="ob-scope ob-route">
						<div class="ob-route-head">
							<div class="ob-scope-title">opencode → zen meter</div>
							<div class="ob-scope-actions">
								<button class="btn" onclick={() => copy(opencodeSnippet(9245), 'oc')}>
									{copied === 'oc' ? 'Copied' : 'Copy'}
								</button>
								<button
									class="btn"
									title="Copy paste-ready instructions for a coding agent"
									onclick={() => copy(agentBrief('opencode', 9245, '/zen/v1'), 'oc-brief')}
								>
									{copied === 'oc-brief' ? 'Copied' : 'Agent brief'}
								</button>
							</div>
						</div>
						<div class="dim ob-scope-body">
							In <span class="mono">~/.config/opencode/opencode.json</span>, provider block:
						</div>
						<code class="cmd">{opencodeSnippet(9245)}</code>
					</div>
				</div>
				<div class="ob-actions">
					<button class="btn" onclick={() => (step = 2)}>Back</button>
					<button class="btn ob-primary" onclick={finish}>Start exploring</button>
				</div>
			{/if}
				</div>
			{/key}
		</div>
	</div>
{/if}

<style>
	.ob-backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 20px;
		background: color-mix(in srgb, var(--bg) 72%, transparent);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
	}
	.ob-card {
		width: 100%;
		max-width: 520px;
		/* fixed frame: steps never resize the modal, actions pin to bottom */
		min-height: min(560px, calc(100vh - 120px));
		max-height: calc(100vh - 60px);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		background: color-mix(in srgb, var(--bg-raised) 88%, transparent);
		border-radius: 20px;
		box-shadow:
			inset 0 0 0 1px var(--line-strong),
			0 24px 64px rgb(0 0 0 / 0.22);
		padding: 28px 26px 22px;
	}
	.ob-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: auto;
		padding-top: 20px;
	}
	/* step wrapper: flex column so margin-top:auto above pins to the card bottom */
	.ob-step {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
	.ob-kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-3);
		margin-bottom: 8px;
	}
	.ob-dots {
		display: flex;
		gap: 6px;
		margin-bottom: 14px;
	}
	.ob-dot {
		width: 22px;
		height: 4px;
		border-radius: 2px;
		background: var(--track);
		transition: background 0.2s;
	}
	.ob-dot.on {
		background: var(--text-3);
	}
	.ob-dot.now {
		background: var(--accent);
	}
	.ob-card h2 {
		margin: 0 0 8px;
		font-size: 22px;
		font-weight: 680;
		letter-spacing: -0.02em;
	}
	.ob-brands {
		display: flex;
		gap: 10px;
		margin: 4px 0 2px;
	}
	.ob-scope-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: none;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.ob-card .btn {
		white-space: nowrap;
	}
	.ob-actions .btn {
		min-width: 84px;
		padding: 7px 16px;
	}
	.ob-card p {
		font-size: 13px;
		margin: 0 0 16px;
	}
	.ob-primary {
		background: var(--accent);
		border-color: var(--accent);
		color: light-dark(#fafafb, #17171b);
	}
	.ob-primary:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.ob-status {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 10px 12px;
	}
	.ob-status .btn {
		margin-left: auto;
	}
	.ob-note {
		margin-top: 10px;
		font-size: 12px;
	}
	.ob-scope {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		justify-content: space-between;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 12px;
	}
	.ob-scope > div:first-child {
		min-width: 0;
		flex: 1;
	}
	/* step 3: column layout so the command bar spans the full card width */
	.ob-route {
		flex-direction: column;
		align-items: stretch;
	}
	.ob-route > div:first-child {
		flex: none;
	}
	.ob-route-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.ob-reconnect {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		justify-content: space-between;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 12px;
		margin-top: 10px;
	}
	.ob-reconnect > div:first-child {
		min-width: 0;
		flex: 1;
	}
	.ob-scope-title {
		font-size: 13px;
		font-weight: 600;
	}
	.ob-scope-body {
		font-size: 12px;
		margin-top: 3px;
	}
	.ob-state {
		font-size: 12px;
	}
	.ob-caps {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		margin-top: 14px;
		font-size: 11.5px;
		color: var(--text-2);
	}
	.ob-cap {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.cmd {
		display: block;
		box-sizing: border-box;
		width: 100%;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.5;
		color: var(--text-2);
		background: var(--bg-raised);
		border: 1px solid var(--line);
		border-radius: 8px;
		box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.06);
		padding: 8px 10px;
		margin-top: 8px;
		overflow-x: auto;
		white-space: nowrap;
		user-select: all;
	}
</style>
