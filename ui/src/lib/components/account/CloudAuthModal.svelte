<script lang="ts">
	// Cloud connect/disconnect modal — the sign-in gate for sync.
	//
	// Sync only flows once the user signs in: this modal owns the whole
	// Google dance (open browser → wait → claim → hand the identity to the
	// daemon so background sync runs as that user) and the disconnect path
	// (cloud logout + daemon identity clear). Opened from the dock's cloud
	// toggle in +layout.
	import Modal from '$lib/components/common/Modal.svelte';
	import {
		cloud,
		signIn,
		cloudBase,
		type CloudUser
	} from '$lib/cloud';
	import { api } from '$lib/api';
	import { scope } from '$lib/scope.svelte';
	import { Cloud, LogOut, RefreshCw } from 'lucide-svelte';

	let {
		open,
		onClose,
		user = null
	}: {
		open: boolean;
		onClose: () => void;
		user?: CloudUser | null;
	} = $props();

	type Phase = 'idle' | 'opening' | 'waiting' | 'done' | 'error';
	let phase = $state<Phase>('idle');
	let error = $state<string | null>(null);
	let busy = $state(false);
	let signedUser = $state<CloudUser | null>(null);

	// Reset the flow every time the modal opens.
	$effect(() => {
		if (open) {
			phase = 'idle';
			error = null;
			busy = false;
		}
	});

	const shown = $derived(signedUser ?? user);

	/** Push the signed-in identity onto the daemon so sync runs as this
	 *  user with the UI closed (best-effort: sign-in itself already worked). */
	async function handoff(u: CloudUser): Promise<string | null> {
		try {
			await api.saveCloudIdentity({
				base_url: cloudBase(),
				handle: u.handle,
				user_id: u.id,
				team: u.team ?? '',
				display_name: u.display_name ?? '',
				avatar_url: u.avatar_url ?? ''
			});
			return null;
		} catch {
			return 'Listener unreachable — background sync identity not saved (sign-in itself is fine).';
		}
	}

	async function doGoogle() {
		busy = true;
		error = null;
		try {
			const r = await signIn('google', (s) => {
				phase = s === 'opening' ? 'opening' : 'waiting';
			});
			signedUser = r.user;
			const note = await handoff(r.user);
			phase = 'done';
			if (note) error = note;
			await scope.poke();
		} catch (e) {
			phase = 'error';
			error = e instanceof Error ? e.message : 'Sign-in failed';
		} finally {
			busy = false;
		}
	}

	async function doDisconnect() {
		busy = true;
		error = null;
		try {
			await cloud.logout().catch(() => {});
			await api.clearCloudIdentity().catch(() => {});
			signedUser = null;
			await scope.poke();
			onClose();
		} finally {
			busy = false;
		}
	}
</script>

<Modal {open} {onClose} title={shown ? 'Cloud connected' : 'Connect cloud'} dismissible={!busy}>
	<div class="cf">
		{#if shown}
			<div class="cf-user">
				<div class="cf-avatar">{(shown.display_name || shown.handle || '?').slice(0, 1).toUpperCase()}</div>
				<div class="cf-id">
					<div class="cf-name">{shown.display_name || shown.handle}</div>
					<div class="cf-sub mono">@{shown.handle} · {cloudBase()}</div>
				</div>
			</div>
			<p class="cf-note">
				Sync runs in the background as this account — usage from every machine you sign in on
				lands on the same leaderboard profile.
			</p>
			<button class="cf-btn cf-danger" onclick={doDisconnect} disabled={busy}>
				<LogOut size={15} strokeWidth={2} />
				{busy ? 'Disconnecting…' : 'Disconnect'}
			</button>
		{:else if !scope.cloudConnected}
			<p class="cf-note">
				No cloud is configured for this daemon. Set <code>TH_SYNC_URL</code> on the daemon (or
				point the dev stack at a cloud server) to enable off-machine sync and the leaderboard.
			</p>
		{:else if !scope.cloudReachable}
			<p class="cf-note">
				The cloud server is configured but <strong>not answering</strong> right now. Start it
				(e.g. <code>TH_CLOUD=1 ./scripts/dev/run-dev.sh</code>) and try again.
			</p>
		{:else}
			<p class="cf-note">
				The cloud is reachable, but sync is <strong>off until you sign in</strong>. Usage never
				leaves this machine anonymously.
			</p>

			{#if phase === 'idle' || phase === 'error'}
				<button class="cf-btn cf-google" onclick={doGoogle} disabled={busy}>
					<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
						<path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81z"/>
						<path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.07.72-2.44 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24z"/>
						<path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28v-3.1H1.29a12 12 0 0 0 0 10.76l3.98-3.1z"/>
						<path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.58 1.8l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.88 8.87 4.77 12 4.77z"/>
					</svg>
					Sign in with Google
				</button>
			{:else if phase === 'opening'}
				<div class="cf-state"><RefreshCw size={15} class="spin" /> Opening browser…</div>
			{:else if phase === 'waiting'}
				<div class="cf-state">
					<RefreshCw size={15} class="spin" />
					Waiting in the browser…
					<span class="cf-sub">Approve the Google prompt; this completes automatically.</span>
				</div>
			{:else if phase === 'done'}
				<div class="cf-state cf-ok"><Cloud size={15} /> Connected — sync enabled</div>
			{/if}

			{#if error}
				<p class="cf-error" role="alert">{error}</p>
				{#if phase === 'error'}
					<button class="cf-btn" onclick={doGoogle} disabled={busy}>Try again</button>
				{/if}
			{/if}
		{/if}
	</div>
</Modal>

<style>
	.cf {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 300px;
	}
	.cf-note {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.5;
		opacity: 0.8;
	}
	.cf-user {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.cf-avatar {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-weight: 700;
		background: color-mix(in oklab, currentColor 12%, transparent);
	}
	.cf-name {
		font-weight: 600;
		font-size: 0.95rem;
	}
	.cf-sub {
		font-size: 0.72rem;
		opacity: 0.6;
		display: block;
	}
	.cf-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 9px 14px;
		border-radius: 10px;
		border: 1px solid color-mix(in oklab, currentColor 18%, transparent);
		background: color-mix(in oklab, currentColor 7%, transparent);
		color: inherit;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.cf-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.cf-google {
		background: #fff;
		color: #1f1f1f;
		border-color: #dadce0;
	}
	.cf-danger {
		border-color: color-mix(in oklab, #f47067 45%, transparent);
		color: #f47067;
	}
	.cf-state {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.85rem;
		flex-wrap: wrap;
	}
	.cf-ok {
		color: #57ab5a;
		font-weight: 600;
	}
	.cf-error {
		margin: 0;
		font-size: 0.8rem;
		color: #f47067;
	}
	:global(.spin) {
		animation: cf-spin 1.2s linear infinite;
	}
	@keyframes cf-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
