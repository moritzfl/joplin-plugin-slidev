import joplin from 'api';
import { pluginPrefix } from '../constants';
import { esc as escHtml, render } from '../htmlUtils';
import pkgLogStyle from './slidevPackageLog.css';
import marketplaceStyle from './marketplaceDialog.css';
import marketplaceTemplate from './marketplaceDialog.html';
import installingTemplate from './installingDialog.html';
import installCompleteTemplate from './installCompleteDialog.html';
import installFailedTemplate from './installFailedDialog.html';
import { ensureSlidevWorkspace, installSlidevPackage, updateSlidevCore, readInstalledSlidevVersion, listInstalledSlidevPackages, InstalledSlidevPackage, uninstallSlidevPackage, updatePlaywrightChromium, readInstalledPlaywrightVersion, NpmInstallConflictMode } from '../slideServer';

// electron is available at runtime inside Joplin (Electron app) but has no bundled types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shell } = require('electron') as { shell: { openExternal: (url: string) => Promise<void> } };

const dialogs = joplin.views.dialogs;
const dialogId = `${pluginPrefix}slidevPackageDialog`;

type PackageKind = 'theme' | 'addon';
interface NpmSearchObject {
	package: {
		name: string;
		version: string;
		description?: string;
		date?: string;
		links?: { npm?: string; repository?: string; homepage?: string };
	};
	downloads?: { weekly?: number; monthly?: number };
}

interface NpmSearchResponse {
	objects: NpmSearchObject[];
}

interface GitHubRepoResponse {
	stargazers_count?: number;
}

interface ShieldsBadgeResponse {
	message?: string;
	value?: string;
}

interface NpmPackageMetadataResponse {
	repository?: string | { type?: string; url?: string };
	homepage?: string;
	time?: {
		created?: string;
		modified?: string;
	};
}

interface PackageMetadata {
	created?: string;
	updated?: string;
	repository?: string;
	homepage?: string;
}

interface MarketplaceState {
	themes: NpmSearchObject[];
	addons: NpmSearchObject[];
	themeQuery: string;
	addonQuery: string;
	installedPackages: Map<string, InstalledSlidevPackage>;
	githubStars: Map<string, number>;
	packageMetadata: Map<string, PackageMetadata>;
	message: string;
	isLoading: boolean;
}

let handle: string | undefined;

const getHandle = async () => {
	if (!handle) handle = await dialogs.create(dialogId);
	return handle;
};

const esc = escHtml;

const FETCH_TIMEOUT_MS = 8000;

const fetchWithTimeout = async (url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
	} finally {
		clearTimeout(timeout);
	}
};

const cleanDescription = (value: string | undefined): string => {
	const cleaned = (value ?? 'No description provided.')
		// Remove markdown images and shields/badges.
		.replace(/!\[[^\]]*]\([^)]*\)/g, '')
		// Convert markdown links to their readable labels.
		.replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
		// Remove simple blockquote/list markdown noise often copied into npm descriptions.
		.replace(/^\s*[>*-]\s*/gm, '')
		.replace(/[`*_#]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

	if (!cleaned) return 'No description provided.';
	return cleaned.length > 170 ? `${cleaned.slice(0, 167).trim()}...` : cleaned;
};

const packageNpmUrl = (pkg: NpmSearchObject['package']): string =>
	pkg.links?.npm || `https://www.npmjs.com/package/${encodeURIComponent(pkg.name)}`;

const githubRepoSlug = (url: string | undefined): string | null => {
	if (!url) return null;
	const normalized = url.trim().replace(/^git\+/, '');
	const match = normalized.match(/github\.com[:/]([^/\s]+)\/([^/#?\s]+)/i);
	if (!match) return null;
	return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
};

const starCache = new Map<string, number | null>();

const parseCompactNumber = (value: string): number | null => {
	const normalized = value.trim().replace(/,/g, '').toLowerCase();
	const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!match) return null;
	const base = Number(match[1]);
	if (Number.isNaN(base)) return null;
	if (match[2] === 'm') return Math.round(base * 1_000_000);
	if (match[2] === 'k') return Math.round(base * 1_000);
	return Math.round(base);
};

const getGithubStarsFromPage = async (repoSlug: string): Promise<number | null> => {
	try {
		const response = await fetchWithTimeout(`https://github.com/${repoSlug}`);
		if (!response.ok) return null;
		const html = await response.text();
		const match = html.match(/social-count[^>]*>\s*([0-9,.]+[kKmM]?)\s*</)
			?? html.match(/aria-label="([0-9,.]+[kKmM]?)\s+users starred this repository"/i);
		return match ? parseCompactNumber(match[1]) : null;
	} catch {
		return null;
	}
};

const getGithubStarsFromShields = async (repoSlug: string): Promise<number | null> => {
	try {
		const response = await fetchWithTimeout(`https://img.shields.io/github/stars/${repoSlug}.json`);
		if (!response.ok) return null;
		const data = await response.json() as ShieldsBadgeResponse;
		return parseCompactNumber(data.message ?? data.value ?? '');
	} catch {
		return null;
	}
};

const getGithubStarsFallback = async (repoSlug: string): Promise<number | null> =>
	await getGithubStarsFromShields(repoSlug) ?? await getGithubStarsFromPage(repoSlug);

const getGithubStars = async (repoSlug: string): Promise<number | null> => {
	if (starCache.has(repoSlug)) return starCache.get(repoSlug) ?? null;
	try {
		const response = await fetchWithTimeout(`https://api.github.com/repos/${repoSlug}`, {
			headers: { Accept: 'application/vnd.github+json' },
		});
		if (!response.ok) {
			const fallbackStars = await getGithubStarsFallback(repoSlug);
			if (fallbackStars !== null) starCache.set(repoSlug, fallbackStars);
			return fallbackStars;
		}
		const data = await response.json() as GitHubRepoResponse;
		const stars = typeof data.stargazers_count === 'number' ? data.stargazers_count : null;
		if (stars !== null) starCache.set(repoSlug, stars);
		return stars;
	} catch {
		const fallbackStars = await getGithubStarsFallback(repoSlug);
		if (fallbackStars !== null) starCache.set(repoSlug, fallbackStars);
		return fallbackStars;
	}
};

const starLabel = (stars: number): string =>
	stars >= 1000 ? `${Math.round(stars / 100) / 10}k` : String(stars);

const formatPackageDate = (date: string | undefined): string => {
	if (!date) return '';
	const parsed = new Date(date);
	if (Number.isNaN(parsed.getTime())) return '';
	return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const packageMetadataCache = new Map<string, PackageMetadata>();

const repositoryUrl = (repository: NpmPackageMetadataResponse['repository']): string | undefined => {
	if (typeof repository === 'string') return repository;
	return repository?.url;
};

const getPackageMetadata = async (pkg: NpmSearchObject['package']): Promise<PackageMetadata> => {
	if (packageMetadataCache.has(pkg.name)) return packageMetadataCache.get(pkg.name) ?? {};
	try {
		const response = await fetchWithTimeout(`https://registry.npmjs.org/${encodeURIComponent(pkg.name).replace(/%2F/g, '/')}`);
		if (!response.ok) return { updated: pkg.date, repository: pkg.links?.repository, homepage: pkg.links?.homepage };
		const data = await response.json() as NpmPackageMetadataResponse;
		const metadata = {
			created: data.time?.created,
			updated: data.time?.modified ?? pkg.date,
			repository: repositoryUrl(data.repository) ?? pkg.links?.repository,
			homepage: data.homepage ?? pkg.links?.homepage,
		};
		packageMetadataCache.set(pkg.name, metadata);
		return metadata;
	} catch {
		const metadata = { updated: pkg.date, repository: pkg.links?.repository, homepage: pkg.links?.homepage };
		packageMetadataCache.set(pkg.name, metadata);
		return metadata;
	}
};

const loadPackageMetadata = async (packages: NpmSearchObject[]): Promise<Map<string, PackageMetadata>> => {
	const entries = await Promise.all(packages.map(async (item) => [
		item.package.name,
		await getPackageMetadata(item.package),
	] as const));
	return new Map(entries);
};

const loadGithubStars = async (packages: NpmSearchObject[], packageMetadata: Map<string, PackageMetadata>): Promise<Map<string, number>> => {
	const entries = await Promise.all(packages.map(async (item) => {
		const metadata = packageMetadata.get(item.package.name);
		const repoSlug = githubRepoSlug(metadata?.repository)
			?? githubRepoSlug(item.package.links?.repository)
			?? githubRepoSlug(metadata?.homepage)
			?? githubRepoSlug(item.package.links?.homepage);
		if (!repoSlug) return null;
		const stars = await getGithubStars(repoSlug);
		return stars === null ? null : [item.package.name, stars] as const;
	}));
	return new Map(entries.filter((entry): entry is readonly [string, number] => entry !== null));
};

const fetchLatestPackageVersion = async (packageName: string): Promise<string | null> => {
	try {
		const response = await fetchWithTimeout(`https://registry.npmjs.org/${encodeURIComponent(packageName).replace(/%2F/g, '/')}/latest`);
		if (!response.ok) return null;
		const data = await response.json() as { version?: string };
		return typeof data.version === 'string' ? data.version : null;
	} catch {
		return null;
	}
};

const fetchLatestSlidevVersion = async (): Promise<string | null> => fetchLatestPackageVersion('@slidev/cli');

const fetchLatestPlaywrightVersion = async (): Promise<string | null> => fetchLatestPackageVersion('playwright-chromium');

const searchPackages = async (kind: PackageKind, query: string): Promise<NpmSearchObject[]> => {
	const keyword = kind === 'theme' ? 'slidev-theme' : 'slidev-addon';
	const text = query.trim()
		? `keywords:${keyword} ${query.trim()}`
		: `keywords:${keyword}`;
	const response = await fetchWithTimeout(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=20`);
	if (!response.ok) throw new Error(`npm search failed: ${response.status} ${response.statusText}`);
	const data = await response.json() as NpmSearchResponse;
	return data.objects ?? [];
};

const installedPackageKindLabel = (packageName: string): string => {
	if (packageName.includes('theme-')) return 'Theme';
	if (packageName.includes('addon-')) return 'Addon';
	return 'Package';
};

const packageSearchText = (...values: Array<string | undefined>): string => esc(values.filter(Boolean).join(' ').toLowerCase());

const runtimeCardsHtml = (
	installedSlidevVersion: string | null,
	installedPlaywrightVersion: string | null,
	latestSlidevVersion: string | null,
) => {
	const slidevStatus = installedSlidevVersion
		? `Installed v${esc(installedSlidevVersion)}`
		: 'Workspace not set up yet';
	const playwrightStatus = installedPlaywrightVersion
		? `Installed v${esc(installedPlaywrightVersion)}`
		: 'Not installed yet';
	return `<label class="card runtime-card" data-view="installed" data-search="slidev cli default theme runtime" title="Select Slidev runtime">
		<input type="radio" name="packageName" value="__runtime_slidev" />
		<div class="card-inner">
			<div class="icon">▶</div>
			<div class="content">
				<div class="title-row">
					<strong>Slidev runtime</strong>
					<div class="versions">
						<span class="version">@slidev/cli</span>
						<span class="installed-version">${slidevStatus}</span>
					</div>
				</div>
				<p>Updates the managed Slidev CLI and default theme used by presentations.</p>
				<div class="meta">
					${latestSlidevVersion ? `<span>Latest v${esc(latestSlidevVersion)}</span>` : ''}
				</div>
				<div class="card-actions"><span>Select, then use Install / Update Selected</span></div>
			</div>
		</div>
	</label>
	<label class="card runtime-card" data-view="installed" data-search="playwright chromium export browser runtime" title="Select Playwright Chromium">
		<input type="radio" name="packageName" value="__runtime_playwright" />
		<div class="card-inner">
			<div class="icon">▣</div>
			<div class="content">
				<div class="title-row">
					<strong>Playwright Chromium</strong>
					<div class="versions">
						<span class="version">playwright-chromium</span>
						<span class="installed-version">${playwrightStatus}</span>
					</div>
				</div>
				<p>Updates the browser package used by Slidev export workflows.</p>
			</div>
		</div>
	</label>`;
};

const installedCardsHtml = (installedPackages: Map<string, InstalledSlidevPackage>) => {
	const packages = [...installedPackages.values()];
	if (packages.length === 0) {
		return `<div class="empty" data-view="installed">
			<div class="empty-icon">⌕</div>
			<h2>No installed packages found</h2>
			<p>Install a theme or addon first.</p>
		</div>`;
	}

	return packages.map((pkg, index) => {
		const label = installedPackageKindLabel(pkg.packageName);
		const icon = label === 'Theme' ? '🎨' : label === 'Addon' ? '🧩' : '📦';
		return `<label class="card" data-view="installed" data-search="${packageSearchText(pkg.packageName, label)}" title="Select ${esc(pkg.packageName)}">
			<input type="radio" name="packageName" value="${esc(pkg.packageName)}"${index === 0 ? ' checked' : ''} />
			<div class="card-inner">
				<div class="icon">${icon}</div>
				<div class="content">
					<div class="title-row">
						<strong>${esc(pkg.packageName)}</strong>
						<div class="versions">
							<span class="version">${label}</span>
							<span class="installed-version">Installed${pkg.version ? ` v${esc(pkg.version)}` : ''}</span>
						</div>
					</div>
					<p>This package is installed in the managed Slidev workspace.</p>
				</div>
			</div>
		</label>`;
	}).join('');
};

const packageCardsHtml = (
	view: PackageKind,
	packages: NpmSearchObject[],
	installedPackages: Map<string, InstalledSlidevPackage>,
	githubStars: Map<string, number>,
	packageMetadata: Map<string, PackageMetadata>,
) => {
	if (packages.length === 0) {
		return `<div class="empty" data-view="${view}">
			<div class="empty-icon">⌕</div>
			<h2>No packages found</h2>
			<p>Try refreshing the marketplace later.</p>
		</div>`;
	}

	return packages.map((item, index) => {
		const pkg = item.package;
		const description = cleanDescription(pkg.description);
		const installed = installedPackages.get(pkg.name);
		const stars = githubStars.get(pkg.name);
		const metadata = packageMetadata.get(pkg.name);
		const published = formatPackageDate(metadata?.created);
		const updated = formatPackageDate(metadata?.updated ?? pkg.date);
		const weeklyDownloads = item.downloads?.weekly ?? 0;
		const downloadLabel = weeklyDownloads >= 1000
			? `${Math.round(weeklyDownloads / 100) / 10}k/week`
			: `${weeklyDownloads}/week`;
		const icon = view === 'theme' ? '🎨' : '🧩';
		return `<label class="card" data-view="${view}" data-search="${packageSearchText(pkg.name, description, downloadLabel, published, updated)}" title="Select ${esc(pkg.name)}">
			<input type="radio" name="packageName" value="${esc(pkg.name)}"${index === 0 ? ' checked' : ''} />
			<div class="card-inner">
				<div class="icon">${icon}</div>
				<div class="content">
					<div class="title-row">
						<strong>${esc(pkg.name)}</strong>
						<div class="versions">
							<span class="version">Available v${esc(pkg.version)}</span>
							${installed ? `<span class="installed-version">Installed${installed.version ? ` v${esc(installed.version)}` : ''}</span>` : ''}
						</div>
					</div>
					<p>${esc(description)}</p>
					<div class="meta">
						${stars !== undefined ? `<span class="stars" title="GitHub stars">★ ${esc(starLabel(stars))}</span>` : ''}
						<span>${downloadLabel}</span>
						${published ? `<span>Published ${esc(published)}</span>` : ''}
						${updated ? `<span>Updated ${esc(updated)}</span>` : ''}
					</div>
				</div>
			</div>
		</label>`;
	}).join('');
};

const loadingCardsHtml = (message: string) => `<div class="empty">
	<div class="loader" aria-hidden="true"></div>
	<h2>Loading packages</h2>
	<p>${esc(message)}</p>
</div>`;

const marketplaceHtml = (
	state: MarketplaceState,
	activeView: PackageKind | 'installed',
	installedSlidevVersion: string | null,
	installedPlaywrightVersion: string | null,
	latestSlidevVersion: string | null,
	latestPlaywrightVersion: string | null,
) => {
	const installedItemCount = state.installedPackages.size + 2;
	const tabs = [
		{ id: 'theme', title: 'Themes', detail: 'Visual styles', count: state.themes.length },
		{ id: 'addon', title: 'Addons', detail: 'Slidev extensions', count: state.addons.length },
		{ id: 'installed', title: 'Installed', detail: 'Manage workspace', count: installedItemCount },
	].map(tab => `<label class="tab" for="view-${tab.id}">
		<span>${tab.title}</span><small>${tab.detail} · ${tab.count}</small>
	</label>`).join('');
	const queryValue = activeView === 'theme' ? state.themeQuery : activeView === 'addon' ? state.addonQuery : '';

	const themeCards = state.isLoading
		? loadingCardsHtml('Searching themes and fetching package metadata. This can take a few seconds on slow networks.')
		: packageCardsHtml('theme', state.themes, state.installedPackages, state.githubStars, state.packageMetadata);
	const addonCards = state.isLoading
		? loadingCardsHtml('Searching addons and fetching package metadata. This can take a few seconds on slow networks.')
		: packageCardsHtml('addon', state.addons, state.installedPackages, state.githubStars, state.packageMetadata);
	const installedCards = state.isLoading
		? loadingCardsHtml('Refreshing installed packages and runtime versions.')
		: runtimeCardsHtml(installedSlidevVersion, installedPlaywrightVersion, latestSlidevVersion) + installedCardsHtml(state.installedPackages);

	return render(marketplaceTemplate, {
		STYLE: marketplaceStyle,
		THEME_CHECKED: activeView === 'theme' ? ' checked' : '',
		ADDON_CHECKED: activeView === 'addon' ? ' checked' : '',
		INSTALLED_CHECKED: activeView === 'installed' ? ' checked' : '',
		SLIDEV_STATUS: installedSlidevVersion ? `<span class="version-chip version-installed">v${esc(installedSlidevVersion)} installed</span>` : '<span class="version-none">workspace not set up yet</span>',
		SLIDEV_UPDATE_STATUS: latestSlidevVersion && latestSlidevVersion !== installedSlidevVersion ? `<span class="version-chip version-available">v${esc(latestSlidevVersion)} available</span>` : latestSlidevVersion && latestSlidevVersion === installedSlidevVersion ? '<span class="version-uptodate">✓ up to date</span>' : '',
		PLAYWRIGHT_STATUS: installedPlaywrightVersion ? `<span class="version-chip version-installed">v${esc(installedPlaywrightVersion)} installed</span>` : '<span class="version-none">not installed yet</span>',
		PLAYWRIGHT_UPDATE_STATUS: latestPlaywrightVersion && latestPlaywrightVersion !== installedPlaywrightVersion ? `<span class="version-chip version-available">v${esc(latestPlaywrightVersion)} available</span>` : latestPlaywrightVersion && latestPlaywrightVersion === installedPlaywrightVersion ? '<span class="version-uptodate">✓ up to date</span>' : '',
		THEME_COUNT: String(state.themes.length),
		ADDON_COUNT: String(state.addons.length),
		INSTALLED_COUNT: String(installedItemCount),
		QUERY: esc(queryValue),
		QUERY_PLACEHOLDER: activeView === 'installed' ? 'Installed packages are listed below...' : 'Search npm packages...',
		TABS: tabs,
		MESSAGE: state.message ? `<div class="message">${esc(state.message)}</div>` : '',
		THEME_CARDS: themeCards,
		ADDON_CARDS: addonCards,
		INSTALLED_CARDS: installedCards,
	});
};

type PackageOperation = 'install' | 'uninstall';

const packageOperationText = (operation: PackageOperation, packageName: string) => {
	if (operation === 'uninstall') {
		return {
			action: 'Uninstalling',
			failureAction: 'uninstall',
			doneVerb: 'uninstalled',
			startingLog: 'Starting npm uninstall...',
			note: `${packageName} has been removed from the Slidev workspace.`,
		};
	}

	return {
		action: 'Installing',
		failureAction: 'install',
		doneVerb: 'installed',
		startingLog: 'Starting npm install...',
		note: `${packageName} is installed in the Slidev workspace. You can use it immediately in note frontmatter; restart Joplin only if you need the settings dropdown to refresh.`,
	};
};

const installingHtml = (packageName: string, logs: string[], operation: PackageOperation = 'install') => {
	const text = packageOperationText(operation, packageName);
	return render(installingTemplate, {
		STYLE: pkgLogStyle,
		ACTION: escHtml(text.action),
		PACKAGE: escHtml(packageName),
		LOG: escHtml(logs.length ? logs.join('\n') : text.startingLog),
	});
};

const installCompleteHtml = (packageName: string, logs: string[], operation: PackageOperation = 'install') => {
	const text = packageOperationText(operation, packageName);
	return render(installCompleteTemplate, {
		STYLE: pkgLogStyle,
		PACKAGE: escHtml(packageName),
		DONE_VERB: escHtml(text.doneVerb),
		NOTE: escHtml(text.note),
		LOG: escHtml(logs.join('\n')),
	});
};

const installFailedHtml = (packageName: string, logs: string[], error: unknown, operation: PackageOperation = 'install') => {
	const text = packageOperationText(operation, packageName);
	return render(installFailedTemplate, {
		STYLE: pkgLogStyle,
		ACTION: escHtml(text.failureAction),
		PACKAGE: escHtml(packageName),
		ERROR: escHtml(error instanceof Error ? error.message : String(error)),
		LOG: escHtml(logs.join('\n')),
	});
};

const isPeerDependencyConflict = (logs: string[], error: unknown): boolean => {
	const text = `${logs.join('\n')}\n${error instanceof Error ? error.message : String(error)}`;
	return text.includes('ERESOLVE') || text.includes('--legacy-peer-deps') || text.includes('Conflicting peer dependency');
};

const retryLabel = (mode: NpmInstallConflictMode): string => {
	if (mode === 'legacy-peer-deps') return '--legacy-peer-deps';
	if (mode === 'force') return '--force';
	return '';
};

const installPackageWithConflictDialog = async (dlg: string, dataDir: string, packageName: string): Promise<boolean> => {
	let conflictMode: NpmInstallConflictMode = 'default';

	while (true) {
		const label = retryLabel(conflictMode);
		const displayName = label ? `${packageName} (${label})` : packageName;
		const logs: string[] = [];
		await dialogs.setHtml(dlg, installingHtml(displayName, logs));
		await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
		const openPromise = dialogs.open(dlg).catch(() => null);

		try {
			if (label) logs.push(`Retrying npm install with ${label}...`);
			await installSlidevPackage(dataDir, packageName, (line) => {
				logs.push(line);
				dialogs.setHtml(dlg, installingHtml(displayName, logs.slice(-40))).catch(() => {});
			}, conflictMode);
			await dialogs.setHtml(dlg, installCompleteHtml(displayName, logs.slice(-80)));
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			await openPromise;
			return true;
		} catch (e) {
			const canRetry = conflictMode === 'default' && isPeerDependencyConflict(logs, e);
			await dialogs.setHtml(dlg, installFailedHtml(displayName, logs.slice(-80), e));
			await dialogs.setButtons(dlg, canRetry ? [
				{ id: 'retry-legacy-peer-deps', title: 'Retry with legacy peer deps' },
				{ id: 'retry-force', title: 'Retry with force' },
				{ id: 'cancel', title: 'Close' },
			] : [{ id: 'cancel', title: 'Close' }]);
			const result = await openPromise;
			if (canRetry && result?.id === 'retry-legacy-peer-deps') {
				conflictMode = 'legacy-peer-deps';
				continue;
			}
			if (canRetry && result?.id === 'retry-force') {
				conflictMode = 'force';
				continue;
			}
			return false;
		}
	}
};

const formValue = (formData: any, key: string): string => {
	const value = formData?.packagePicker?.[key] ?? formData?.[key];
	return typeof value === 'string' ? value : '';
};

const trySearchPackages = async (kind: PackageKind, query: string): Promise<{ packages: NpmSearchObject[]; message: string }> => {
	try {
		const packages = await searchPackages(kind, query);
		return { packages, message: '' };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return { packages: [], message: `Could not search npm: ${message}` };
	}
};

const joinMessages = (...messages: string[]): string => messages.filter(Boolean).join(' ');

const allInstalledPackageMap = async (dataDir: string) => {
	const [themes, addons] = await Promise.all([
		listInstalledSlidevPackages(dataDir, 'theme'),
		listInstalledSlidevPackages(dataDir, 'addon'),
	]);
	return new Map([...themes, ...addons].map(pkg => [pkg.packageName, pkg]));
};

const loadMarketplaceState = async (dataDir: string): Promise<MarketplaceState> => {
	const [themesResult, addonsResult, installedPackages] = await Promise.all([
		trySearchPackages('theme', ''),
		trySearchPackages('addon', ''),
		allInstalledPackageMap(dataDir),
	]);
	const packages = [...themesResult.packages, ...addonsResult.packages];
	const packageMetadata = await loadPackageMetadata(packages);
	const githubStars = await loadGithubStars(packages, packageMetadata);
	return {
		themes: themesResult.packages,
		addons: addonsResult.packages,
		themeQuery: '',
		addonQuery: '',
		installedPackages,
		githubStars,
		packageMetadata,
		message: joinMessages(themesResult.message, addonsResult.message),
		isLoading: false,
	};
};

const loadingMarketplaceState = (message: string, query = ''): MarketplaceState => ({
	themes: [],
	addons: [],
	themeQuery: query,
	addonQuery: query,
	installedPackages: new Map(),
	githubStars: new Map(),
	packageMetadata: new Map(),
	message,
	isLoading: true,
});

const refreshMarketplaceSearch = async (state: MarketplaceState, dataDir: string, query: string): Promise<MarketplaceState> => {
	const [themesResult, addonsResult, installedPackages] = await Promise.all([
		trySearchPackages('theme', query),
		trySearchPackages('addon', query),
		allInstalledPackageMap(dataDir),
	]);
	const packages = [...themesResult.packages, ...addonsResult.packages];
	const packageMetadata = await loadPackageMetadata(packages);
	const githubStars = await loadGithubStars(packages, packageMetadata);
	return {
		...state,
		themes: themesResult.packages,
		addons: addonsResult.packages,
		themeQuery: query,
		addonQuery: query,
		installedPackages,
		packageMetadata: new Map([...state.packageMetadata, ...packageMetadata]),
		githubStars: new Map([...state.githubStars, ...githubStars]),
		message: joinMessages(themesResult.message, addonsResult.message),
		isLoading: false,
	};
};

export const showSlidevPackageDialog = async (dataDir: string) => {
	const dlg = await getHandle();
	await dialogs.setFitToContent(dlg, false);

	const setupLogs: string[] = [];
	let installedSlidevVersion = await readInstalledSlidevVersion(dataDir);
	let setupMessage = '';
	if (!installedSlidevVersion) {
		await dialogs.setHtml(dlg, installingHtml('Slidev workspace setup', setupLogs));
		await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
		const openPromise = dialogs.open(dlg).catch(() => null);
		try {
			await ensureSlidevWorkspace(dataDir, (line) => {
				setupLogs.push(line);
				dialogs.setHtml(dlg, installingHtml('Slidev workspace setup', setupLogs.slice(-40))).catch(() => {});
			});
			setupMessage = 'Slidev workspace initialized.';
		} catch (e) {
			await dialogs.setHtml(dlg, installFailedHtml('Slidev workspace setup', setupLogs.slice(-80), e));
			setupMessage = `Slidev workspace setup failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			await openPromise;
		}
	}

	installedSlidevVersion = await readInstalledSlidevVersion(dataDir);
	let installedPlaywrightVersion = await readInstalledPlaywrightVersion(dataDir);
	let latestSlidevVersion: string | null = null;
	let latestPlaywrightVersion: string | null = null;
	let state = loadingMarketplaceState(setupMessage ? `${setupMessage} Loading marketplace packages...` : 'Loading marketplace packages...');
	let activeView: PackageKind | 'installed' = 'theme';

	const renderCurrent = () => dialogs.setHtml(dlg, marketplaceHtml(state, activeView, installedSlidevVersion, installedPlaywrightVersion, latestSlidevVersion, latestPlaywrightVersion));

	const initialLoad = Promise.all([fetchLatestSlidevVersion(), fetchLatestPlaywrightVersion(), loadMarketplaceState(dataDir)]).then(([slidevVersion, playwrightVersion, nextState]) => {
		latestSlidevVersion = slidevVersion;
		latestPlaywrightVersion = playwrightVersion;
		state = setupMessage ? { ...nextState, message: joinMessages(setupMessage, nextState.message) } : nextState;
		renderCurrent().catch(() => {});
	}).catch((e) => {
		state = { ...state, message: `Could not load marketplace packages: ${e instanceof Error ? e.message : String(e)}`, isLoading: false };
		renderCurrent().catch(() => {});
	});

	while (true) {
		await renderCurrent();
		const buttons = [
			{ id: 'submit', title: 'Search' },
			{ id: 'open-website', title: 'Visit on npm' },
			{ id: 'confirm', title: 'Install / Update Selected' },
			{ id: 'update-all', title: 'Update All Installed' },
		];
		buttons.push({ id: 'uninstall', title: 'Uninstall Selected' });
		buttons.push({ id: 'cancel', title: 'Close' });
		await dialogs.setButtons(dlg, buttons);

		const result = await dialogs.open(dlg);
		if (!result || result.id === 'cancel') return;
		await initialLoad;

		const formView = formValue(result.formData, 'view');
		activeView = formView === 'installed' || formView === 'addon' || formView === 'theme' ? formView : activeView;
		const formAction = formValue(result.formData, 'action');
		if (result.id === 'submit' || formAction === 'submit') {
			const query = formValue(result.formData, 'query');
			state = loadingMarketplaceState(`Searching marketplace for "${query}"...`, query);
			await renderCurrent();
			const loadingDialog = dialogs.open(dlg).catch(() => null);
			if (activeView === 'installed') {
				state = { ...state, installedPackages: await allInstalledPackageMap(dataDir), message: 'Refreshed installed packages.', isLoading: false };
				await renderCurrent();
				await loadingDialog;
				continue;
			}
			state = await refreshMarketplaceSearch(state, dataDir, query);
			await renderCurrent();
			await loadingDialog;
			continue;
		}

		const packageName = formValue(result.formData, 'packageName');

		if (result.id === 'open-website') {
			if (!packageName) {
				state = { ...state, message: 'Select a package card before opening it on npm.' };
				continue;
			}
			if (packageName === '__runtime_slidev') {
				await shell.openExternal('https://www.npmjs.com/package/@slidev/cli');
				state = { ...state, message: 'Opened npm page for @slidev/cli.' };
				continue;
			}
			if (packageName === '__runtime_playwright') {
				await shell.openExternal('https://www.npmjs.com/package/playwright-chromium');
				state = { ...state, message: 'Opened npm page for playwright-chromium.' };
				continue;
			}
			const selectedPackage = [...state.themes, ...state.addons].find(item => item.package.name === packageName)?.package;
			const npmUrl = selectedPackage
				? packageNpmUrl(selectedPackage)
				: state.installedPackages.has(packageName) ? `https://www.npmjs.com/package/${encodeURIComponent(packageName)}` : '';
			if (!npmUrl) {
				state = { ...state, message: `Could not find selected package: ${packageName}` };
				continue;
			}
			try {
				await shell.openExternal(npmUrl);
				state = { ...state, message: `Opened npm page for ${packageName}.` };
			} catch (e) {
				state = { ...state, message: `Could not open npm page for ${packageName}: ${e instanceof Error ? e.message : String(e)}` };
			}
			continue;
		}

		if (result.id === 'confirm') {
			if (!packageName) {
				state = { ...state, message: 'Select a package card before installing.' };
				continue;
			}

			if (packageName === '__runtime_slidev') {
				if (!installedSlidevVersion) {
					state = { ...state, message: 'Slidev workspace is not set up yet. Try reopening the marketplace to run setup again.' };
					continue;
				}

				const displayName = '@slidev/cli + default theme';
				const logs: string[] = [];
				await dialogs.setHtml(dlg, installingHtml(displayName, logs));
				await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
				const openPromise = dialogs.open(dlg).catch(() => null);
				try {
					await updateSlidevCore(dataDir, (line) => {
						logs.push(line);
						dialogs.setHtml(dlg, installingHtml(displayName, logs.slice(-40))).catch(() => {});
					});
					await dialogs.setHtml(dlg, installCompleteHtml(displayName, logs.slice(-80)));
					state = { ...state, message: 'Slidev updated. Restart any running presentation to use the new version.' };
				} catch (e) {
					await dialogs.setHtml(dlg, installFailedHtml(displayName, logs.slice(-80), e));
					state = { ...state, message: 'Slidev update failed.' };
				}
				await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
				await openPromise;
				installedSlidevVersion = await readInstalledSlidevVersion(dataDir);
				continue;
			}

			if (packageName === '__runtime_playwright') {
				if (!installedSlidevVersion) {
					state = { ...state, message: 'Slidev workspace is not set up yet. Try reopening the marketplace to run setup again.' };
					continue;
				}

				const displayName = 'playwright-chromium';
				const logs: string[] = [];
				await dialogs.setHtml(dlg, installingHtml(displayName, logs));
				await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
				const openPromise = dialogs.open(dlg).catch(() => null);
				try {
					await updatePlaywrightChromium(dataDir, (line) => {
						logs.push(line);
						dialogs.setHtml(dlg, installingHtml(displayName, logs.slice(-40))).catch(() => {});
					});
					await dialogs.setHtml(dlg, installCompleteHtml(displayName, logs.slice(-80)));
					state = { ...state, message: 'Playwright updated. Restart any running export to use the new version.' };
				} catch (e) {
					await dialogs.setHtml(dlg, installFailedHtml(displayName, logs.slice(-80), e));
					state = { ...state, message: 'Playwright update failed.' };
				}
				await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
				await openPromise;
				installedPlaywrightVersion = await readInstalledPlaywrightVersion(dataDir);
				continue;
			}

			const installed = await installPackageWithConflictDialog(dlg, dataDir, packageName);
			if (installed) {
				state = { ...state, message: `${packageName} installed. You can use it immediately in note frontmatter; restart Joplin only to refresh the settings dropdown.` };
			} else {
				state = { ...state, message: `Install failed for ${packageName}.` };
			}
			state = { ...state, installedPackages: await allInstalledPackageMap(dataDir) };
		}

		if (result.id === 'update-all') {
			const installedPackageNames = [...state.installedPackages.keys()];
			const totalUpdateCount = installedPackageNames.length + 2;
			const displayName = `Slidev runtime, Playwright, and ${installedPackageNames.length} package${installedPackageNames.length === 1 ? '' : 's'}`;
			const logs: string[] = [];
			await dialogs.setHtml(dlg, installingHtml(displayName, logs));
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			const openPromise = dialogs.open(dlg).catch(() => null);
			try {
				logs.push(`Updating Slidev runtime (1/${totalUpdateCount})...`);
				await dialogs.setHtml(dlg, installingHtml(displayName, logs.slice(-40)));
				await updateSlidevCore(dataDir, (line) => {
					logs.push(line);
					dialogs.setHtml(dlg, installingHtml(displayName, logs.slice(-40))).catch(() => {});
				});

				logs.push(`Updating Playwright Chromium (2/${totalUpdateCount})...`);
				await dialogs.setHtml(dlg, installingHtml(displayName, logs.slice(-40)));
				await updatePlaywrightChromium(dataDir, (line) => {
					logs.push(line);
					dialogs.setHtml(dlg, installingHtml(displayName, logs.slice(-40))).catch(() => {});
				});

				for (const [index, installedPackageName] of installedPackageNames.entries()) {
					logs.push(`Updating ${installedPackageName} (${index + 3}/${totalUpdateCount})...`);
					await dialogs.setHtml(dlg, installingHtml(displayName, logs.slice(-40)));
					await installSlidevPackage(dataDir, installedPackageName, (line) => {
						logs.push(line);
						dialogs.setHtml(dlg, installingHtml(displayName, logs.slice(-40))).catch(() => {});
					});
				}
				await dialogs.setHtml(dlg, installCompleteHtml(displayName, logs.slice(-80)));
				state = { ...state, message: `Updated Slidev, Playwright, and ${installedPackageNames.length} installed package${installedPackageNames.length === 1 ? '' : 's'}.` };
			} catch (e) {
				await dialogs.setHtml(dlg, installFailedHtml(displayName, logs.slice(-80), e));
				state = { ...state, message: 'Update all failed.' };
			}
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			await openPromise;
			installedSlidevVersion = await readInstalledSlidevVersion(dataDir);
			installedPlaywrightVersion = await readInstalledPlaywrightVersion(dataDir);
			state = { ...state, installedPackages: await allInstalledPackageMap(dataDir) };
		}

		if (result.id === 'uninstall') {
			if (!packageName) {
				state = { ...state, message: 'Select an installed package card before uninstalling.' };
				continue;
			}
			if (packageName === '__runtime_slidev' || packageName === '__runtime_playwright') {
				state = { ...state, message: 'Runtime components cannot be uninstalled here. Use Install / Update Selected to update them.' };
				continue;
			}
			if (!state.installedPackages.has(packageName)) {
				state = { ...state, message: `${packageName} is not installed.` };
				continue;
			}

			const logs: string[] = [];
			await dialogs.setHtml(dlg, installingHtml(packageName, logs, 'uninstall'));
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			const openPromise = dialogs.open(dlg).catch(() => null);
			try {
				await uninstallSlidevPackage(dataDir, packageName, (line) => {
					logs.push(line);
					dialogs.setHtml(dlg, installingHtml(packageName, logs.slice(-40), 'uninstall')).catch(() => {});
				});
				await dialogs.setHtml(dlg, installCompleteHtml(packageName, logs.slice(-80), 'uninstall'));
				state = { ...state, message: `${packageName} uninstalled.` };
			} catch (e) {
				await dialogs.setHtml(dlg, installFailedHtml(packageName, logs.slice(-80), e, 'uninstall'));
				state = { ...state, message: `Uninstall failed for ${packageName}.` };
			}
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			await openPromise;
			state = { ...state, installedPackages: await allInstalledPackageMap(dataDir) };
		}

	}
};
