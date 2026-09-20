<script lang="ts">
	import SitePolicy from '$lib/components/site/SitePolicy.svelte';
</script>

<SitePolicy title="Privacy Policy" updated="2026-09-20">
	<h2>The short version</h2>
	<p>
		Token Horizon runs on your machine. Your usage data, credentials, and files stay there. If
		you never connect a cloud server, nothing leaves your device.
	</p>

	<h2>What stays on your machine</h2>
	<ul>
		<li>Token usage, costs, and session history, stored in a local SQLite database.</li>
		<li>Provider credentials, read from your own config files or OS keychain and never written anywhere by us.</li>
		<li>Metered traffic, which passes through memory and is counted, not logged.</li>
	</ul>

	<h2>If you connect a cloud server</h2>
	<p>
		Signing in and enabling sync sends aggregated usage statistics (tokens, costs, models,
		timestamps) to the server you configure. That is what powers the leaderboard. Self-hosting the
		server keeps even that inside your own infrastructure.
	</p>

	<h2>What we never collect</h2>
	<ul>
		<li>Prompt or response content.</li>
		<li>File paths, project names, or code.</li>
		<li>Analytics or crash telemetry, unless you explicitly opt in.</li>
	</ul>

	<h2>Contact</h2>
	<p>
		Questions about this policy: open an issue on the
		<a href="https://github.com/castlemilk/token-horizon/issues">GitHub repository</a>.
	</p>
</SitePolicy>
