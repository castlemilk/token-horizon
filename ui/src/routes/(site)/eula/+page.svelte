<script lang="ts">
	import SitePolicy from '$lib/components/site/SitePolicy.svelte';
</script>

<SitePolicy title="End User License Agreement" updated="2026-09-20">
	<h2>1. License</h2>
	<p>
		Token Horizon's source code is available under the license in the project repository. This
		EULA covers the prebuilt desktop application distributed through GitHub Releases and Homebrew.
	</p>

	<h2>2. What you may do</h2>
	<ul>
		<li>Install and use the app on any machine you own or control.</li>
		<li>Copy, modify, and redistribute it under the terms of the repository license.</li>
	</ul>

	<h2>3. What the app does</h2>
	<p>
		The app reads local AI tool session files, queries provider quota endpoints with your
		on-machine credentials, and can relay your own API traffic through loopback meters to measure
		token usage. All of this happens on your machine, with per-scope consent prompts. Optional
		cloud sync is off until you sign in.
	</p>

	<h2>4. Signatures</h2>
	<p>
		Official releases are Developer ID signed and Apple-notarized. Builds you produce from source
		are ad-hoc signed and are your own responsibility.
	</p>

	<h2>5. No warranty</h2>
	<p>
		The app is provided "as is", without warranty of any kind, express or implied. In no event
		are the authors liable for any claim or damages arising from its use.
	</p>
</SitePolicy>
