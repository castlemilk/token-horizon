// UI-level preferences, persisted to localStorage. Handle is the local
// identity used by the profile page and, later, leaderboard publishing.
// (Collection control lives daemon-side: Request routing switches on the
// Machine tab — display-time vendor filters were removed as redundant.)

const KEY = 'token-horizon.settings';

interface Persisted {
	handle?: string;
	showImports?: boolean;
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
	/** Include file-imported (selfReported, non-metered) rows in dashboards —
	 *  debugging view; off by default for prod. */
	showImports = $state(load().showImports ?? false);

	save() {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(
			KEY,
			JSON.stringify({ handle: this.handle, showImports: this.showImports } satisfies Persisted)
		);
	}
}

export const settings = new UiSettings();
