import joplin from 'api';
import { pluginPrefix } from '../constants';
import { esc as escHtml, render } from '../htmlUtils';
import pkgLogStyle from './slidevPackageLog.css';
import installingTemplate from './installingDialog.html';
import installCompleteTemplate from './installCompleteDialog.html';
import installFailedTemplate from './installFailedDialog.html';
import { installSlidevPackage, updateSlidevCore, readInstalledSlidevVersion, listInstalledSlidevPackages, InstalledSlidevPackage } from '../slideServer';

// electron is available at runtime inside Joplin (Electron app) but has no bundled types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shell } = require('electron') as { shell: { openExternal: (url: string) => void } };

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

interface SearchState {
	packages: NpmSearchObject[];
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
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		// Convert markdown links to their readable labels.
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
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
	const match = normalized.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
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
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
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

const fetchLatestSlidevVersion = async (): Promise<string | null> => {
	try {
		const response = await fetchWithTimeout('https://registry.npmjs.org/@slidev/cli/latest');
		if (!response.ok) return null;
		const data = await response.json() as { version?: string };
		return typeof data.version === 'string' ? data.version : null;
	} catch {
		return null;
	}
};

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

const searchHtml = (
	kind: PackageKind,
	query: string,
	packages: NpmSearchObject[],
	installedPackages: Map<string, InstalledSlidevPackage>,
	githubStars: Map<string, number>,
	packageMetadata: Map<string, PackageMetadata>,
	installedSlidevVersion: string | null,
	latestSlidevVersion: string | null,
	message = '',
	isLoading = false,
) => {
	const cards = isLoading
		? `<div class="empty">
			<div class="loader" aria-hidden="true"></div>
			<h2>Loading packages</h2>
			<p>Fetching npm results and package metadata. This can take a few seconds on slow networks.</p>
		</div>`
		: packages.length === 0
		? `<div class="empty">
			<div class="empty-icon">⌕</div>
			<h2>No packages found</h2>
			<p>Try a broader search or switch between themes and addons.</p>
		</div>`
		: packages.map((item, index) => {
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
		const icon = kind === 'theme' ? '🎨' : '🧩';
		return `<label class="card" title="Select ${esc(pkg.name)}">
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
					<div class="links"><span title="${esc(npmUrl)}">View on npm: ${esc(npmUrl)}</span></div>
				</div>
			</div>
		</label>`;
	}).join('');

	const subtitle = kind === 'theme'
		? 'Browse visual styles from npm packages tagged slidev-theme.'
		: 'Browse extensions from npm packages tagged slidev-addon.';
	return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
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
.shell { height:100vh; overflow-y:auto; padding:28px 34px 190px; scrollbar-color:#7ee0ae rgba(255,255,255,.08); }
.hero {
  display:flex; align-items:flex-start; justify-content:space-between; gap:24px;
  margin-bottom:22px;
}
.eyebrow { color:#7ee0ae; font-size:12px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
h1 { margin:6px 0 8px; font-size:32px; line-height:1.05; letter-spacing:-.04em; }
.sub { margin:0; color:#b8bfcc; font-size:14px; max-width:760px; }
.count {
  min-width:120px; padding:14px 18px; border:1px solid rgba(255,255,255,.12); border-radius:18px;
  background:rgba(255,255,255,.07); text-align:center; box-shadow:0 20px 60px rgba(0,0,0,.2);
}
.count strong { display:block; font-size:28px; line-height:1; }
.count span { color:#b8bfcc; font-size:12px; }
.controls {
  display:grid; grid-template-columns:1fr; gap:14px; padding:14px;
  border:1px solid rgba(255,255,255,.1); border-radius:22px; background:rgba(8,10,16,.72);
  backdrop-filter:blur(18px); position:sticky; top:0; z-index:2;
}
.search { position:relative; }
.search input {
  width:100%; height:56px; border:1px solid rgba(255,255,255,.12); border-radius:16px;
  background:#f5f7fb; color:#11131a; padding:0 18px 0 48px; font-size:16px; outline:none;
}
.search input:focus { border-color:#7ee0ae; box-shadow:0 0 0 4px rgba(126,224,174,.22); }
.search:before { content:'⌕'; position:absolute; left:18px; top:13px; color:#6b7280; font-size:24px; z-index:1; }
.message {
  color:#c8f7df; font-size:12px; font-weight:800; letter-spacing:.02em;
  margin:12px 2px 8px;
}
.steps { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin:12px 0 18px; }
.step {
  display:flex; align-items:center; gap:10px; min-width:0; padding:12px;
  border:1px solid rgba(255,255,255,.1); border-radius:16px; background:rgba(255,255,255,.055);
  color:#cfd6e4; font-size:12px; font-weight:700;
}
.step-num {
  display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px;
  border-radius:50%; background:#7ee0ae; color:#11131a; font-weight:900; flex:none;
}
.step strong { color:#fff; white-space:nowrap; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:14px; padding-bottom:42px; }
.card { display:block; cursor:pointer; }
.card input { display:none; }
.card-inner {
  min-height:210px; display:grid; grid-template-columns:58px minmax(0, 1fr); gap:14px; position:relative;
  padding:18px; border:1px solid rgba(255,255,255,.1); border-radius:22px;
  background:linear-gradient(180deg, rgba(255,255,255,.095), rgba(255,255,255,.045));
  box-shadow:0 16px 44px rgba(0,0,0,.2); transition:transform .15s ease, border-color .15s ease, background .15s ease;
}
.card:hover .card-inner { transform:translateY(-2px); border-color:rgba(126,224,174,.45); background:rgba(255,255,255,.11); }
.card input:checked + .card-inner { border-color:#7ee0ae; box-shadow:0 0 0 3px rgba(126,224,174,.2), 0 18px 48px rgba(0,0,0,.28); }
.icon {
  width:58px; height:58px; display:flex; align-items:center; justify-content:center; border-radius:18px;
  background:linear-gradient(135deg, #7ee0ae, #8ea7ff); font-size:28px;
}
.content { min-width:0; padding-right:4px; }
.title-row { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; min-width:0; }
.title-row strong {
  font-size:16px; line-height:1.25; word-break:break-word;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
}
.versions { display:grid; justify-items:end; gap:4px; flex:none; }
.version { color:#10131a; background:#e8edf6; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:800; white-space:nowrap; }
.installed-version { color:#7ee0ae; font-size:11px; font-weight:900; white-space:nowrap; }
p {
  margin:8px 0 14px; color:#c8cfdb; line-height:1.4; font-size:13px;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden;
}
.meta { display:flex; flex-wrap:wrap; gap:7px; min-width:0; }
.meta span {
  max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:#aeb7c7; border:1px solid rgba(255,255,255,.1); border-radius:999px; padding:5px 8px; font-size:11px;
}
.meta .stars { color:#11131a; background:#ffd98a; border-color:#ffd98a; font-weight:900; }
.links { display:grid; gap:3px; margin-top:8px; padding-right:76px; }
.links span { color:#91d8ff; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card input:checked + .card-inner:after {
  content:'Selected'; position:absolute; right:14px; bottom:14px; padding:9px 12px; border-radius:999px;
  background:#7ee0ae; color:#11131a; border:1px solid #7ee0ae;
  font-size:12px; font-weight:900;
}
.empty { grid-column:1 / -1; text-align:center; padding:70px 20px; color:#b8bfcc; }
.empty-icon { font-size:56px; color:#7ee0ae; }
.loader {
  width:46px; height:46px; margin:0 auto 12px; border-radius:50%;
  border:4px solid rgba(126,224,174,.22); border-top-color:#7ee0ae;
  animation:spin .8s linear infinite;
}
@keyframes spin { to { transform:rotate(360deg); } }
.empty h2 { color:#fff; margin:8px 0; }
@media (max-width:720px) {
  .shell { padding:20px; }
  .hero { display:block; }
  .count { display:none; }
  .steps { grid-template-columns:1fr; }
  .grid { grid-template-columns:1fr; padding-bottom:140px; }
}
.version-row { display:flex; align-items:center; gap:8px; margin-top:12px; flex-wrap:wrap; }
.version-label { color:#b8bfcc; font-size:12px; font-weight:700; }
.version-chip { border-radius:999px; padding:3px 10px; font-size:11px; font-weight:800; white-space:nowrap; }
.version-installed { background:rgba(126,224,174,.15); color:#7ee0ae; border:1px solid rgba(126,224,174,.3); }
.version-available { background:rgba(255,217,138,.15); color:#ffd98a; border:1px solid rgba(255,217,138,.3); }
.version-uptodate { color:#7ee0ae; font-size:11px; }
.version-none { color:#b8bfcc; font-size:11px; }
</style></head><body>
<form name="packagePicker">
<div class="shell">
  <section class="hero">
    <div>
      <div class="eyebrow">Slidev Marketplace</div>
      <h1>Find themes and addons</h1>
      <p class="sub">${subtitle} Select a card, then use the modal action bar to install or update it.</p>
      <div class="version-row">
        <span class="version-label">Slidev</span>
        ${installedSlidevVersion
		? `<span class="version-chip version-installed">v${esc(installedSlidevVersion)} installed</span>`
		: '<span class="version-none">workspace not set up yet</span>'}
        ${latestSlidevVersion && latestSlidevVersion !== installedSlidevVersion
		? `<span class="version-chip version-available">v${esc(latestSlidevVersion)} available</span>`
		: latestSlidevVersion && latestSlidevVersion === installedSlidevVersion
			? '<span class="version-uptodate">✓ up to date</span>'
			: ''}
      </div>
    </div>
    <div class="count"><strong>${packages.length}</strong><span>results</span></div>
  </section>
  <input type="hidden" name="kind" value="${kind}" />
  <section class="controls">
    <div class="search"><input name="query" value="${esc(query)}" placeholder="Search package names, styles, features..." /></div>
  </section>
  ${message ? `<div class="message">${esc(message)}</div>` : ''}
  <section class="steps" aria-label="Install workflow">
	    <div class="step"><span class="step-num">1</span><span>Choose <strong>Themes/Addons</strong> from the bottom bar</span></div>
    <div class="step"><span class="step-num">2</span><span>Search and select a package card</span></div>
    <div class="step"><span class="step-num">3</span><span>Click <strong>Install / Update Selected</strong></span></div>
  </section>
  <section class="grid">${cards}</section>
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

const installedPackageMap = async (dataDir: string, kind: PackageKind) =>
	new Map((await listInstalledSlidevPackages(dataDir, kind)).map(pkg => [pkg.packageName, pkg]));

const updateSearchState = async (dataDir: string, kind: PackageKind, query: string): Promise<SearchState> => {
	const searchResult = await trySearchPackages(kind, query);
	const installedPackages = await installedPackageMap(dataDir, kind);
	const packageMetadata = await loadPackageMetadata(searchResult.packages);
	const githubStars = await loadGithubStars(searchResult.packages, packageMetadata);
	return {
		packages: searchResult.packages,
		installedPackages,
		githubStars,
		packageMetadata,
		message: searchResult.message,
		isLoading: false,
	};
};

const loadingSearchState = (kind: PackageKind, query: string): SearchState => ({
	packages: [],
	installedPackages: new Map(),
	githubStars: new Map(),
	packageMetadata: new Map(),
	message: query.trim()
		? `Searching ${kind === 'theme' ? 'themes' : 'addons'} for "${query.trim()}"...`
		: `Loading ${kind === 'theme' ? 'themes' : 'addons'} from npm...`,
	isLoading: true,
});

export const showSlidevPackageDialog = async (dataDir: string) => {
	const dlg = await getHandle();
	await dialogs.setFitToContent(dlg, false);

	let kind: PackageKind = 'theme';
	let query = '';
	let state = loadingSearchState(kind, query);
	let packages = state.packages;
	let installedPackages = state.installedPackages;
	let githubStars = state.githubStars;
	let packageMetadata = state.packageMetadata;
	let message = state.message;
	let isLoading = state.isLoading;
	let installedSlidevVersion = await readInstalledSlidevVersion(dataDir);
	let latestSlidevVersion: string | null = null;
	let loadToken = 0;

	const renderCurrent = () => dialogs.setHtml(
		dlg,
		searchHtml(kind, query, packages, installedPackages, githubStars, packageMetadata, installedSlidevVersion, latestSlidevVersion, message, isLoading),
	);

	const applyState = (nextState: SearchState) => {
		packages = nextState.packages;
		installedPackages = nextState.installedPackages;
		githubStars = nextState.githubStars;
		packageMetadata = nextState.packageMetadata;
		message = nextState.message;
		isLoading = nextState.isLoading;
	};

	const startLoadingSearchState = (nextKind: PackageKind, nextQuery: string, messagePrefix = '') => {
		const token = ++loadToken;
		state = loadingSearchState(nextKind, nextQuery);
		if (messagePrefix) state.message = `${messagePrefix} ${state.message}`;
		applyState(state);
		updateSearchState(dataDir, nextKind, nextQuery).then((nextState) => {
			if (token !== loadToken || kind !== nextKind || query !== nextQuery) return;
			applyState(messagePrefix ? { ...nextState, message: nextState.message.replace('Found', messagePrefix.trim() + ' Found') } : nextState);
			renderCurrent().catch(() => {});
		}).catch((e) => {
			if (token !== loadToken || kind !== nextKind || query !== nextQuery) return;
			message = `Could not load packages: ${e instanceof Error ? e.message : String(e)}`;
			isLoading = false;
			renderCurrent().catch(() => {});
		});
	};

	startLoadingSearchState(kind, query);
	fetchLatestSlidevVersion().then((version) => {
		latestSlidevVersion = version;
		renderCurrent().catch(() => {});
	}).catch(() => {});

	while (true) {
		await renderCurrent();
		await dialogs.setButtons(dlg, [
			{ id: 'theme', title: kind === 'theme' ? 'Themes ✓' : 'Themes' },
			{ id: 'addon', title: kind === 'addon' ? 'Addons ✓' : 'Addons' },
			{ id: 'submit', title: 'Search' },
			{ id: 'open-website', title: 'Visit on npm' },
			{ id: 'confirm', title: 'Install / Update Selected' },
			{ id: 'update-slidev', title: 'Update Slidev' },
			{ id: 'cancel', title: 'Close' },
		]);

		const result = await dialogs.open(dlg);
		if (!result || result.id === 'cancel') return;

		const nextKind = result.id === 'addon'
			? 'addon'
			: result.id === 'theme'
				? 'theme'
				: formValue(result.formData, 'kind') === 'addon' ? 'addon' : 'theme';
		kind = nextKind;
		query = formValue(result.formData, 'query') || query;
		const packageName = formValue(result.formData, 'packageName');

		if (result.id === 'theme' || result.id === 'addon') {
			query = '';
			startLoadingSearchState(kind, query, `Browsing ${kind === 'theme' ? 'themes' : 'addons'}.`);
			continue;
		}

		if (result.id === 'submit') {
			startLoadingSearchState(kind, query);
			continue;
		}

		if (result.id === 'open-website') {
			if (!packageName) {
				message = 'Select a package card before opening it on npm.';
				continue;
			}
			const selectedPackage = packages.find(item => item.package.name === packageName)?.package;
			if (!selectedPackage) {
				message = `Could not find selected package: ${packageName}`;
				continue;
			}
			try {
				shell.openExternal(packageNpmUrl(selectedPackage));
				message = `Opened npm page for ${packageName}.`;
			} catch (e) {
				message = `Could not open npm page for ${packageName}: ${e instanceof Error ? e.message : String(e)}`;
			}
			continue;
		}

		if (result.id === 'confirm') {
			if (!packageName) {
				message = 'Select a package card before installing.';
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
				message = `${packageName} installed. You can use it immediately in note frontmatter; restart Joplin only to refresh the settings dropdown.`;
			} catch (e) {
				await dialogs.setHtml(dlg, installFailedHtml(packageName, logs.slice(-80), e));
				message = `Install failed for ${packageName}.`;
			}
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			await openPromise;
			startLoadingSearchState(kind, query);
		}

		if (result.id === 'update-slidev') {
			if (!installedSlidevVersion) {
				message = 'Workspace is not set up yet — start a presentation first to initialize it.';
				continue;
			}

			const displayName = '@slidev/cli + bundled themes';
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
				message = 'Slidev updated. Restart any running presentation to use the new version.';
			} catch (e) {
				await dialogs.setHtml(dlg, installFailedHtml(displayName, logs.slice(-80), e));
				message = 'Slidev update failed.';
			}
			await dialogs.setButtons(dlg, [{ id: 'cancel', title: 'Close' }]);
			await openPromise;
			installedSlidevVersion = await readInstalledSlidevVersion(dataDir);
		}
	}
};
