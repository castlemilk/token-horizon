<script lang="ts" module>
	/** OS brand marks from /icons/ (macos / linux / windows; linux has a dark variant). */
	export function osKey(platform: string): string | null {
		const p = platform.toLowerCase();
		if (p.includes('mac') || p.includes('darwin')) return 'macos';
		if (p.includes('win')) return 'windows';
		if (p.includes('linux') || p.includes('gnu')) return 'linux';
		return null;
	}
</script>

<script lang="ts">
	import { iconHasDark } from './ProviderIcon.svelte';

	let { platform, size = 14 }: { platform: string; size?: number } = $props();
	const key = $derived(osKey(platform));
</script>

{#if key}
	<span class="osicon" style="width:{size}px;height:{size}px" role="img" aria-label={platform}>
		{#if iconHasDark(key)}
			<img class="light-var" src="/icons/{key}.webp" alt="" width={size} height={size} draggable="false" />
			<img class="dark-var" src="/icons/{key}-dark.webp" alt="" width={size} height={size} draggable="false" />
		{:else}
			<img src="/icons/{key}.webp" alt="" width={size} height={size} draggable="false" />
		{/if}
	</span>
{/if}

<style>
	.osicon {
		display: inline-flex;
		flex: none;
	}
	.osicon img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}
	.osicon img.dark-var {
		display: none;
	}
	:global(html[data-theme='dark']) .osicon img.light-var {
		display: none;
	}
	:global(html[data-theme='dark']) .osicon img.dark-var {
		display: block;
	}
	@media (prefers-color-scheme: dark) {
		:global(html:not([data-theme='light'])) .osicon img.light-var {
			display: none;
		}
		:global(html:not([data-theme='light'])) .osicon img.dark-var {
			display: block;
		}
	}
</style>
