<script lang="ts">
	import { cloud, type CloudUser } from '$lib/cloud';

	// Avatar editor: drag-drop or browse → downscale client-side (256px,
	// webp 0.85) → upload. The server only ever sees the small webp.
	let {
		user,
		onSaved
	}: {
		user: CloudUser | null;
		onSaved: (u: CloudUser) => void;
	} = $props();

	let dragging = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let preview = $state<string | null>(null);
	let fileInput: HTMLInputElement | null = $state(null);

	const shown = $derived(preview ?? cloud.avatarURL(user));

	function downscale(file: File): Promise<Blob> {
		return new Promise((resolve, reject) => {
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = () => {
				URL.revokeObjectURL(url);
				const longest = Math.max(img.naturalWidth, img.naturalHeight);
				const scale = Math.min(1, 256 / longest);
				const w = Math.max(1, Math.round(img.naturalWidth * scale));
				const h = Math.max(1, Math.round(img.naturalHeight * scale));
				const canvas = document.createElement('canvas');
				canvas.width = w;
				canvas.height = h;
				const ctx = canvas.getContext('2d');
				if (!ctx) {
					reject(new Error('canvas unavailable'));
					return;
				}
				ctx.drawImage(img, 0, 0, w, h);
				canvas.toBlob(
					(b) => (b ? resolve(b) : reject(new Error('webp encode failed'))),
					'image/webp',
					0.85
				);
			};
			img.onerror = () => {
				URL.revokeObjectURL(url);
				reject(new Error('not a readable image'));
			};
			img.src = url;
		});
	}

	async function take(file: File | undefined | null) {
		error = null;
		if (!file) return;
		if (!/^image\/(png|jpe?g|webp|gif|avif|bmp)$/.test(file.type)) {
			error = 'Drop an image file (png, jpeg, webp…)';
			return;
		}
		if (file.size > 8 << 20) {
			error = 'Image must be under 8 MB';
			return;
		}
		busy = true;
		try {
			const small = await downscale(file);
			preview = URL.createObjectURL(small);
			const saved = await cloud.uploadAvatar(small);
			onSaved(saved);
			if (preview.startsWith('blob:')) URL.revokeObjectURL(preview);
			preview = null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Upload failed';
		} finally {
			busy = false;
		}
	}

	const initial = $derived(((user?.display_name || user?.handle || '?').trim()[0] ?? '?').toUpperCase());
</script>

<div
	class="drop"
	class:dragging
	class:busy
	role="button"
	tabindex="0"
	aria-label="Change profile photo"
	title="Drop an image or click to browse — downscaled to 256px webp"
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={(e) => {
		e.preventDefault();
		dragging = false;
		void take(e.dataTransfer?.files?.[0]);
	}}
	onclick={() => fileInput?.click()}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') fileInput?.click();
	}}
>
	{#if shown}
		<img src={shown} alt="" />
	{:else}
		<span class="fallback">{initial}</span>
	{/if}
	{#if busy}<span class="veil">…</span>{/if}
	<input
		bind:this={fileInput}
		type="file"
		accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
		hidden
		onchange={(e) => {
			void take(e.currentTarget.files?.[0]);
			e.currentTarget.value = '';
		}}
	/>
</div>
{#if error}<div class="aerr">{error}</div>{/if}

<style>
	.drop {
		position: relative;
		width: 64px;
		height: 64px;
		border-radius: 50%;
		flex: none;
		cursor: pointer;
		background: var(--accent-soft);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		outline: 2px dashed transparent;
		outline-offset: 3px;
		transition: outline-color 0.15s ease, transform 0.15s ease;
	}
	.drop:hover {
		transform: scale(1.03);
	}
	.drop.dragging {
		outline-color: var(--accent);
		transform: scale(1.06);
	}
	.drop img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.fallback {
		font-size: 22px;
		font-weight: 700;
		color: var(--text-2);
	}
	.veil {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(0 0 0 / 0.3);
		color: #fff;
		font-size: 18px;
	}
	.aerr {
		font-size: 11.5px;
		color: var(--bad);
		margin-top: 6px;
		max-width: 220px;
	}
</style>
