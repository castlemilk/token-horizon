// UI-level preferences, persisted to localStorage. These gate what the app
// DISPLAYS (and are the contract a future daemon-side settings endpoint will
// enforce at collection time). Handle is the local identity used by the
// profile page and, later, leaderboard publishing.

const KEY = 'token-horizon.settings';

interface Persisted {
	handle?: string;
	disabledProviders?: string[];
	disabledRuntimes?: string[];
}

function load(): Persisted {
	if (typeof localStorage === 'undefined') return {};
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Persisted;
	} catch {
		return {};
	}
}

class UiSettings {
	handle = $state(load().handle ?? 'me');
	disabledProviders = $state<string[]>(load().disabledProviders ?? []);
	disabledRuntimes = $state<string[]>(load().disabledRuntimes ?? []);

	save() {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(
			KEY,
			JSON.stringify({
				handle: this.handle,
				disabledProviders: this.disabledProviders,
				disabledRuntimes: this.disabledRuntimes
			} satisfies Persisted)
		);
	}

	providerEnabled(vendor: string): boolean {
		return !this.disabledProviders.includes(vendor);
	}
	runtimeEnabled(vendor: string): boolean {
		return !this.disabledRuntimes.includes(vendor);
	}
	toggleProvider(vendor: string) {
		this.disabledProviders = this.disabledProviders.includes(vendor)
			? this.disabledProviders.filter((v) => v !== vendor)
			: [...this.disabledProviders, vendor];
		this.save();
	}
	toggleRuntime(vendor: string) {
		this.disabledRuntimes = this.disabledRuntimes.includes(vendor)
			? this.disabledRuntimes.filter((v) => v !== vendor)
			: [...this.disabledRuntimes, vendor];
		this.save();
	}
}

export const settings = new UiSettings();
