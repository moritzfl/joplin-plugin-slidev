import joplin from 'api';
import { pluginPrefix } from '../constants';
import { esc as escHtml, render } from '../htmlUtils';
import pkgLogStyle from './slidevPackageLog.css';
import installingTemplate from './installingDialog.html';
import installCompleteTemplate from './installCompleteDialog.html';
import installFailedTemplate from './installFailedDialog.html';
import { ensureSlidevWorkspace, installSlidevPackage, updateSlidevCore, readInstalledSlidevVersion, listInstalledSlidevPackages, InstalledSlidevPackage, uninstallSlidevPackage, updatePlaywrightChromium, readInstalledPlaywrightVersion } from '../slideServer';

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
				<div class="card-actions"><span>Select, then use Install / Update Selected</span></div>
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
		const npmUrl = `https://www.npmjs.com/package/${encodeURIComponent(pkg.packageName)}`;
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
					<div class="links"><span title="${esc(npmUrl)}">npm: ${esc(npmUrl)}</span></div>
					<div class="card-actions"><span>Select to update, open on npm, or uninstall</span></div>
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
		const npmUrl = packageNpmUrl(pkg);
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
					<div class="links"><span title="${esc(npmUrl)}">npm: ${esc(npmUrl)}</span></div>
					<div class="card-actions"><span>${installed ? 'Select, then update from the footer' : 'Select, then install from the footer'}</span></div>
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

	return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<style>
* { box-sizing:border-box; }
html, body { height:100%; overflow:hidden; }
body {
  margin:0;
  background:
    radial-gradient(circle at 10% 0%, rgba(66,184,131,.22), transparent 28%),
    radial-gradient(circle at 90% 10%, rgba(90,120,255,.2), transparent 30%),
    #11131a;
  color:#f5f7fb;
  font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
}
.shell { height:100vh; overflow-y:auto; padding:28px 34px 150px; scrollbar-color:#7ee0ae rgba(255,255,255,.08); }
.hero { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:22px; }
.eyebrow { color:#7ee0ae; font-size:12px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
h1 { margin:6px 0 8px; font-size:32px; line-height:1.05; letter-spacing:-.04em; }
.sub { margin:0; color:#b8bfcc; font-size:14px; max-width:760px; }
.count { min-width:120px; padding:14px 18px; border:1px solid rgba(255,255,255,.12); border-radius:18px; background:rgba(255,255,255,.07); text-align:center; box-shadow:0 20px 60px rgba(0,0,0,.2); }
.count strong { display:block; font-size:28px; line-height:1; }
.count span { color:#b8bfcc; font-size:12px; }
.view-radio { position:absolute; opacity:0; pointer-events:none; }
.controls { display:grid; grid-template-columns:minmax(280px, 1fr) auto; gap:14px; padding:14px; border:1px solid rgba(255,255,255,.1); border-radius:22px; background:rgba(8,10,16,.72); backdrop-filter:blur(18px); position:sticky; top:0; z-index:2; }
.search { position:relative; }
.search input { width:100%; height:56px; border:1px solid rgba(255,255,255,.12); border-radius:16px; background:#f5f7fb; color:#11131a; padding:0 18px 0 48px; font-size:16px; outline:none; }
.search input:focus { border-color:#7ee0ae; box-shadow:0 0 0 4px rgba(126,224,174,.22); }
.search:before { content:'⌕'; position:absolute; left:18px; top:13px; color:#6b7280; font-size:24px; z-index:1; }
.tabs { display:flex; gap:8px; align-items:stretch; flex-wrap:wrap; justify-content:flex-end; }
.tab { display:block; min-width:112px; border:1px solid rgba(255,255,255,.12); border-radius:16px; padding:9px 12px; background:rgba(255,255,255,.075); color:#f5f7fb; text-align:left; cursor:pointer; font:inherit; }
.tab span { display:block; font-size:13px; font-weight:900; }
.tab small { display:block; margin-top:2px; color:#aeb7c7; font-size:10px; font-weight:700; }
#view-theme:checked ~ .shell label[for="view-theme"], #view-addon:checked ~ .shell label[for="view-addon"], #view-installed:checked ~ .shell label[for="view-installed"] { background:#7ee0ae; border-color:#7ee0ae; color:#11131a; }
#view-theme:checked ~ .shell label[for="view-theme"] small, #view-addon:checked ~ .shell label[for="view-addon"] small, #view-installed:checked ~ .shell label[for="view-installed"] small { color:#26392f; }
.message { color:#c8f7df; font-size:12px; font-weight:800; letter-spacing:.02em; margin:12px 2px 8px; }
.action-panel { display:flex; align-items:center; justify-content:space-between; gap:14px; margin:12px 0 18px; padding:14px 16px; border:1px solid rgba(126,224,174,.22); border-radius:18px; background:rgba(126,224,174,.08); color:#d7f8e6; font-size:12px; font-weight:800; }
.action-panel strong { color:#fff; }
.action-panel span { color:#aeb7c7; font-weight:700; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:14px; padding-bottom:42px; }
.view { display:none; }
#view-theme:checked ~ .shell .view-theme, #view-addon:checked ~ .shell .view-addon, #view-installed:checked ~ .shell .view-installed { display:grid; }
.count-value, .count-label { display:none !important; }
#view-theme:checked ~ .shell .count-theme, #view-addon:checked ~ .shell .count-addon, #view-installed:checked ~ .shell .count-installed { display:block !important; }
#view-theme:checked ~ .shell .label-results, #view-addon:checked ~ .shell .label-results { display:block !important; }
#view-installed:checked ~ .shell .label-installed { display:block !important; }
.help-text { display:none; }
#view-theme:checked ~ .shell .help-install, #view-addon:checked ~ .shell .help-install, #view-installed:checked ~ .shell .help-installed { display:inline; }
  .card { display:block; cursor:pointer; }
  .card input { display:none; }
.search-submit { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
.card-inner { min-height:210px; display:grid; grid-template-columns:58px minmax(0, 1fr); gap:14px; position:relative; padding:18px; border:1px solid rgba(255,255,255,.1); border-radius:22px; background:linear-gradient(180deg, rgba(255,255,255,.095), rgba(255,255,255,.045)); box-shadow:0 16px 44px rgba(0,0,0,.2); transition:transform .15s ease, border-color .15s ease, background .15s ease; }
.card:hover .card-inner { transform:translateY(-2px); border-color:rgba(126,224,174,.45); background:rgba(255,255,255,.11); }
.card input:checked + .card-inner { border-color:#7ee0ae; box-shadow:0 0 0 3px rgba(126,224,174,.2), 0 18px 48px rgba(0,0,0,.28); }
.card input:checked + .card-inner:after { content:'Selected'; position:absolute; right:14px; bottom:14px; padding:9px 12px; border-radius:999px; background:#7ee0ae; color:#11131a; border:1px solid #7ee0ae; font-size:12px; font-weight:900; }
.icon { width:58px; height:58px; display:flex; align-items:center; justify-content:center; border-radius:18px; background:linear-gradient(135deg, #7ee0ae, #8ea7ff); font-size:28px; }
.content { min-width:0; padding-right:4px; }
.title-row { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; min-width:0; }
.title-row strong { font-size:16px; line-height:1.25; word-break:break-word; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.versions { display:grid; justify-items:end; gap:4px; flex:none; }
.version { color:#10131a; background:#e8edf6; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:800; white-space:nowrap; }
.installed-version { color:#7ee0ae; font-size:11px; font-weight:900; white-space:nowrap; }
p { margin:8px 0 14px; color:#c8cfdb; line-height:1.4; font-size:13px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.meta { display:flex; flex-wrap:wrap; gap:7px; min-width:0; }
.meta span { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#aeb7c7; border:1px solid rgba(255,255,255,.1); border-radius:999px; padding:5px 8px; font-size:11px; }
.meta .stars { color:#11131a; background:#ffd98a; border-color:#ffd98a; font-weight:900; }
.links { display:grid; gap:3px; margin-top:8px; padding-right:76px; }
.links span { color:#91d8ff; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card-actions { margin-top:10px; color:#7ee0ae; font-size:11px; font-weight:900; }
.empty { grid-column:1 / -1; text-align:center; padding:70px 20px; color:#b8bfcc; }
.empty-icon { font-size:56px; color:#7ee0ae; }
.loader { width:46px; height:46px; margin:0 auto 12px; border-radius:50%; border:4px solid rgba(126,224,174,.22); border-top-color:#7ee0ae; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.empty h2 { color:#fff; margin:8px 0; }
.version-row { display:flex; align-items:center; gap:8px; margin-top:12px; flex-wrap:wrap; }
.version-label { color:#b8bfcc; font-size:12px; font-weight:700; }
.version-chip { border-radius:999px; padding:3px 10px; font-size:11px; font-weight:800; white-space:nowrap; }
.version-installed { background:rgba(126,224,174,.15); color:#7ee0ae; border:1px solid rgba(126,224,174,.3); }
.version-available { background:rgba(255,217,138,.15); color:#ffd98a; border:1px solid rgba(255,217,138,.3); }
.version-uptodate { color:#7ee0ae; font-size:11px; }
.version-none { color:#b8bfcc; font-size:11px; }
@media (max-width:720px) {
  .shell { padding:20px; }
  .hero { display:block; }
  .count { display:none; }
  .controls { grid-template-columns:1fr; }
  .tabs { justify-content:stretch; }
  .tab { flex:1 1 120px; }
  .action-panel { display:block; }
  .grid { grid-template-columns:1fr; padding-bottom:140px; }
}
</style></head><body>
<form name="packagePicker">
<button class="search-submit" type="submit" name="action" value="submit" aria-hidden="true" tabindex="-1">Search</button>
<input class="view-radio" id="view-theme" type="radio" name="view" value="theme"${activeView === 'theme' ? ' checked' : ''} />
<input class="view-radio" id="view-addon" type="radio" name="view" value="addon"${activeView === 'addon' ? ' checked' : ''} />
<input class="view-radio" id="view-installed" type="radio" name="view" value="installed"${activeView === 'installed' ? ' checked' : ''} />
<div class="shell">
  <section class="hero">
    <div>
      <div class="eyebrow">Slidev Marketplace</div>
      <h1>Find themes and addons</h1>
      <p class="sub">Browse themes, addons, and installed packages. Use Search to query npm for the selected section.</p>
      <div class="version-row">
        <span class="version-label">Slidev</span>
        ${installedSlidevVersion ? `<span class="version-chip version-installed">v${esc(installedSlidevVersion)} installed</span>` : '<span class="version-none">workspace not set up yet</span>'}
        ${latestSlidevVersion && latestSlidevVersion !== installedSlidevVersion ? `<span class="version-chip version-available">v${esc(latestSlidevVersion)} available</span>` : latestSlidevVersion && latestSlidevVersion === installedSlidevVersion ? '<span class="version-uptodate">✓ up to date</span>' : ''}
        <span class="version-label">Playwright</span>
        ${installedPlaywrightVersion ? `<span class="version-chip version-installed">v${esc(installedPlaywrightVersion)} installed</span>` : '<span class="version-none">not installed yet</span>'}
        ${latestPlaywrightVersion && latestPlaywrightVersion !== installedPlaywrightVersion ? `<span class="version-chip version-available">v${esc(latestPlaywrightVersion)} available</span>` : latestPlaywrightVersion && latestPlaywrightVersion === installedPlaywrightVersion ? '<span class="version-uptodate">✓ up to date</span>' : ''}
      </div>
    </div>
    <div class="count">
      <strong class="count-value count-theme">${state.themes.length}</strong>
      <strong class="count-value count-addon">${state.addons.length}</strong>
      <strong class="count-value count-installed">${installedItemCount}</strong>
      <span class="count-label label-results">results</span>
      <span class="count-label label-installed">installed</span>
    </div>
  </section>
  <section class="controls">
    <div class="search"><input id="query" name="query" value="${esc(queryValue)}" placeholder="${activeView === 'installed' ? 'Installed packages are listed below...' : 'Search npm packages...'}" /></div>
    <div class="tabs" aria-label="Marketplace sections">${tabs}</div>
  </section>
  ${state.message ? `<div class="message">${esc(state.message)}</div>` : ''}
  <section class="action-panel" aria-label="Selected package actions">
    <strong>Selected package actions</strong>
    <span class="help-text help-install">Select a package to install/update it or open its npm page from the footer.</span>
    <span class="help-text help-installed">Select Slidev, Playwright, or an installed package to update it. Uninstall only removes packages.</span>
  </section>
  <section class="grid view view-theme">${themeCards}</section>
  <section class="grid view view-addon">${addonCards}</section>
  <section class="grid view view-installed">${installedCards}</section>
</div>
</form>
</body></html>`;
};

const installingHtml = (packageName: string, logs: string[]) =>
	render(installingTemplate, {
		STYLE: pkgLogStyle,
		PACKAGE: escHtml(packageName),
		LOG: escHtml(logs.length ? logs.join('\n') : 'Starting npm install...'),
	});

const installCompleteHtml = (packageName: string, logs: string[]) =>
	render(installCompleteTemplate, {
		STYLE: pkgLogStyle,
		PACKAGE: escHtml(packageName),
		LOG: escHtml(logs.join('\n')),
	});

const installFailedHtml = (packageName: string, logs: string[], error: unknown) =>
	render(installFailedTemplate, {
		STYLE: pkgLogStyle,
		PACKAGE: escHtml(packageName),
		ERROR: escHtml(error instanceof Error ? error.message : String(error)),
		LOG: escHtml(logs.join('\n')),
	});

const formValue = (formData: any, key: string): string => {
	const value = formData?.packagePicker?.[key] ?? formData?.[key];
	return typeof value === 'string' ? value : '';
};

const trySearchPackages = async (kind: PackageKind, query: string): Promise<{ packages: NpmSearchObject[]; message: string }> => {
	try {
		const packages = await searchPackages(kind, query);
		return { packages, message: `Found ${packages.length} package(s).` };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return { packages: [], message: `Could not search npm: ${message}` };
	}
};

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
	const messages = [themesResult.message, addonsResult.message, `Found ${installedPackages.size} installed package(s).`];
	return {
		themes: themesResult.packages,
		addons: addonsResult.packages,
		themeQuery: '',
		addonQuery: '',
		installedPackages,
		githubStars,
		packageMetadata,
		message: messages.join(' '),
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
		message: `${themesResult.message} ${addonsResult.message} Found ${installedPackages.size} installed package(s).`,
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
		state = setupMessage ? { ...nextState, message: `${setupMessage} ${nextState.message}` } : nextState;
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
			if (activeView === 'installed') {
				state = { ...state, installedPackages: await allInstalledPackageMap(dataDir), message: 'Refreshed installed packages.', isLoading: false };
				continue;
			}
			state = await refreshMarketplaceSearch(state, dataDir, query);
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

			const logs: string[] = [];
			await dialogs.setHtml(dlg, installingHtml(packageName, logs));
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			const openPromise = dialogs.open(dlg).catch(() => null);
			try {
				await installSlidevPackage(dataDir, packageName, (line) => {
					logs.push(line);
					dialogs.setHtml(dlg, installingHtml(packageName, logs.slice(-40))).catch(() => {});
				});
				await dialogs.setHtml(dlg, installCompleteHtml(packageName, logs.slice(-80)));
				state = { ...state, message: `${packageName} installed. You can use it immediately in note frontmatter; restart Joplin only to refresh the settings dropdown.` };
			} catch (e) {
				await dialogs.setHtml(dlg, installFailedHtml(packageName, logs.slice(-80), e));
				state = { ...state, message: `Install failed for ${packageName}.` };
			}
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			await openPromise;
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

			const displayName = `${packageName} uninstall`;
			const logs: string[] = [];
			await dialogs.setHtml(dlg, installingHtml(displayName, logs));
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			const openPromise = dialogs.open(dlg).catch(() => null);
			try {
				await uninstallSlidevPackage(dataDir, packageName, (line) => {
					logs.push(line);
					dialogs.setHtml(dlg, installingHtml(displayName, logs.slice(-40))).catch(() => {});
				});
				await dialogs.setHtml(dlg, installCompleteHtml(displayName, logs.slice(-80)));
				state = { ...state, message: `${packageName} uninstalled.` };
			} catch (e) {
				await dialogs.setHtml(dlg, installFailedHtml(displayName, logs.slice(-80), e));
				state = { ...state, message: `Uninstall failed for ${packageName}.` };
			}
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			await openPromise;
			state = { ...state, installedPackages: await allInstalledPackageMap(dataDir) };
		}

	}
};
