import { spawn, spawnSync, ChildProcess } from 'child_process';
import { writeFile, mkdir, readFile, unlink, access, readdir, mkdtemp, rename, rm } from 'fs/promises';
import { existsSync, rmSync, unlinkSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import * as net from 'net';

export interface SlidevServer {
	process: ChildProcess;
	port: number;
	workDir: string;
	dataDir: string;
	closed: Promise<number | null>;
}

export interface SlidevRemoteOptions {
	remoteAccess: boolean;
	remotePassword: string;
	remoteTunnel: boolean;
	remoteBind: string;
}

export interface InstalledSlidevTheme {
	name: string;
	packageName: string;
}

export interface InstalledSlidevPackage {
	packageName: string;
	version: string;
}

export type NpmInstallConflictMode = 'default' | 'legacy-peer-deps' | 'force';

// ---------- port helpers ----------

const isPortAvailable = (port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => { server.close(); resolve(true); });
		server.listen(port, '127.0.0.1');
	});

export const findAvailablePort = async (startPort: number): Promise<number> => {
	if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) {
		throw new Error(`Invalid Slidev port: ${startPort}`);
	}
	const endPort = Math.min(startPort + 100, 65535);
	for (let port = startPort; port <= endPort; port++) {
		if (await isPortAvailable(port)) return port;
	}
	throw new Error(`No free port in range ${startPort}–${endPort}`);
};

export const waitForServerReady = (port: number, timeoutMs = 60000): Promise<boolean> =>
	new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const tryConnect = () => {
			const sock = new net.Socket();
			sock.setTimeout(500);
			const onFail = () => {
				sock.destroy();
				Date.now() >= deadline ? resolve(false) : setTimeout(tryConnect, 500);
			};
			sock.on('connect', () => { sock.destroy(); resolve(true); });
			sock.on('error', onFail);
			sock.on('timeout', onFail);
			sock.connect(port, '127.0.0.1');
		};
		tryConnect();
	});

// ---------- PID file (crash-recovery) ----------

const PID_FILE_PREFIX = 'slidev-server-';
const PID_FILE_SUFFIX = '.pid';
const SLIDEV_WORK_DIR = 'slidev-workspace';

const pidFileName = (pid: number) => `${PID_FILE_PREFIX}${pid}${PID_FILE_SUFFIX}`;

interface PidFileMeta {
	pid: number;
	workDir: string;
	cmd: string;
	marker?: string;
}

const writePidFile = async (dataDir: string, pid: number, workDir: string, cmd: string, marker: string) => {
	const meta: PidFileMeta = { pid, workDir, cmd, marker };
	await writeFile(join(dataDir, pidFileName(pid)), JSON.stringify(meta), 'utf-8');
};

const removePidFileSync = (dataDir: string, pid: number | undefined) => {
	if (!pid) return;
	try { unlinkSync(join(dataDir, pidFileName(pid))); } catch { /* already gone */ }
};

const removeManagedDeck = async (dataDir: string, workDir: string): Promise<void> => {
	const decksDir = resolve(dataDir, SLIDEV_WORK_DIR, 'decks');
	const resolvedWorkDir = resolve(workDir);
	if (dirname(resolvedWorkDir) !== decksDir) return;
	await rm(resolvedWorkDir, { recursive: true, force: true });
};

const removeManagedDeckSync = (dataDir: string, workDir: string): boolean => {
	const decksDir = resolve(dataDir, SLIDEV_WORK_DIR, 'decks');
	const resolvedWorkDir = resolve(workDir);
	if (dirname(resolvedWorkDir) !== decksDir) return true;
	try {
		rmSync(resolvedWorkDir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
};

const processExists = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
};

const killProcessGroupSync = (pid: number): boolean => {
	try {
		if (process.platform !== 'win32') {
			process.kill(-pid, 'SIGKILL');
			return true;
		}
		const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
		return result.status === 0 || !processExists(pid);
	} catch {
		return !processExists(pid);
	}
};

/**
 * Returns true when the running process identified by `pid` still looks like
 * the Slidev child we spawned: its working directory matches `expectedWorkDir`
 * and its command path contains `expectedCmd`.  On any error we return false
 * (conservative: don't kill an unknown process).
 */
const pidBelongsToPlugin = (pid: number, expectedWorkDir: string, expectedCmd: string, expectedMarker?: string): boolean => {
	try {
		if (process.platform === 'linux') {
			// /proc/<pid>/cwd is a symlink to the process's working directory.
			const { readlinkSync } = require('fs') as typeof import('fs');
			const cwd = readlinkSync(`/proc/${pid}/cwd`);
			if (cwd !== expectedWorkDir) return false;
			// /proc/<pid>/cmdline is NUL-separated and includes the Node script path.
			const { readFileSync } = require('fs') as typeof import('fs');
			const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean);
			return cmdline.some(arg => arg === expectedCmd || arg.includes(expectedCmd))
				&& (!expectedMarker || cmdline.some(arg => arg === expectedMarker || arg.includes(expectedMarker)));
		} else if (process.platform === 'darwin') {
			// Detached children should be process-group leaders, which lets us
			// safely kill the whole group with -pid after verifying the cwd.
			const pgidResult = spawnSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf-8' });
			if (pgidResult.status !== 0) return false;
			const pgid = Number(pgidResult.stdout.trim());
			if (pgid !== pid) return false;

			const cwdResult = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf-8' });
			if (cwdResult.status !== 0) return false;
			const cwd = cwdResult.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
			if (!cwd) return false;

			const { realpathSync } = require('fs') as typeof import('fs');
			if (realpathSync(cwd) !== realpathSync(expectedWorkDir)) return false;
			if (!expectedMarker) return true;
			const commandResult = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
			return commandResult.status === 0 && commandResult.stdout.includes(expectedMarker);
		} else {
			// Windows: query both executable and command line. WMIC is absent on
			// current Windows releases, while PowerShell's CIM API remains available.
			const result = spawnSync(
				'powershell.exe', [
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					`$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress }`,
				],
				{ encoding: 'utf-8' },
			);
			if (result.status !== 0) return false;
			const processInfo = JSON.parse(result.stdout) as { ExecutablePath?: string; CommandLine?: string };
			return processInfo.ExecutablePath?.toLowerCase() === expectedCmd.toLowerCase()
				&& (!expectedMarker || Boolean(processInfo.CommandLine?.toLowerCase().includes(expectedMarker.toLowerCase())));
		}
	} catch {
		return false;
	}
};

/** Call once at plugin startup to kill any server left over from a previous crash. */
export const cleanupOrphanedServer = async (dataDir: string): Promise<void> => {
	try {
		const entries = await readdir(dataDir);
		const pidFiles = entries.filter(name =>
			name.startsWith(PID_FILE_PREFIX) && name.endsWith(PID_FILE_SUFFIX),
		);
		for (const pidFile of pidFiles) {
			const raw = await readFile(join(dataDir, pidFile), 'utf-8');

			let meta: PidFileMeta;
			try {
				meta = JSON.parse(raw) as PidFileMeta;
			} catch {
				// Unreadable/corrupt file – remove and skip.
				await unlink(join(dataDir, pidFile)).catch(() => {/* ignore */});
				continue;
			}
			const { pid, workDir, cmd, marker } = meta;
			if (!pid || isNaN(pid)) continue;

			if (!processExists(pid)) {
				try {
					await removeManagedDeck(dataDir, workDir);
					await unlink(join(dataDir, pidFile)).catch(() => {/* ignore */});
				} catch {
					console.warn(`[Slidev] Retaining PID metadata ${pid} – deck cleanup failed`);
				}
				continue;
			}

			// Verify the live process still matches before killing it.  This
			// prevents accidentally killing an unrelated process that inherited
			// the same PID after a reboot or rapid process cycling.
			if (!pidBelongsToPlugin(pid, workDir, cmd, marker)) {
				console.log(`[Slidev] Retaining PID ${pid} – process ownership could not be verified`);
				continue;
			}

			if (!killProcessGroupSync(pid)) {
				console.warn(`[Slidev] Retaining PID ${pid} – process termination failed`);
				continue;
			}
			console.log(`[Slidev] Cleaned up orphaned server process group ${pid}`);

			try {
				await removeManagedDeck(dataDir, workDir);
				await unlink(join(dataDir, pidFile)).catch(() => {/* ignore */});
			} catch {
				console.warn(`[Slidev] Retaining PID metadata ${pid} – deck cleanup failed`);
			}
		}
	} catch {
		// Data dir or PID files do not exist → nothing to clean up.
	}
};

// ---------- process-exit cleanup (daemon behaviour) ----------

// All currently running servers tracked at module level so exit handlers can reach them.
const activeServers = new Set<SlidevServer>();
const activeAuxiliaryProcesses = new Set<ChildProcess>();
const closedProcesses = new WeakSet<ChildProcess>();
let cleanupRegistered = false;

const killProcessTreeSync = (processToKill: ChildProcess): boolean => {
	const pid = processToKill.pid;
	if (!pid || closedProcesses.has(processToKill)) return true;
	return killProcessGroupSync(pid);
};

const killServerSync = (server: SlidevServer) => killProcessTreeSync(server.process);

const trackAuxiliaryProcess = (child: ChildProcess): void => {
	activeAuxiliaryProcesses.add(child);
	child.once('close', () => {
		closedProcesses.add(child);
		activeAuxiliaryProcesses.delete(child);
	});
};

/** Synchronous cleanup: called from 'exit' and therefore must stay synchronous. */
const syncKillAll = (dataDir: string) => {
	for (const srv of [...activeServers]) {
		if (killServerSync(srv)) {
			if (removeManagedDeckSync(dataDir, srv.workDir)) removePidFileSync(dataDir, srv.process.pid);
			else console.warn(`[Slidev] Retaining PID metadata ${srv.process.pid} – deck cleanup failed`);
			activeServers.delete(srv);
		}
	}
	for (const child of [...activeAuxiliaryProcesses]) {
		if (killProcessTreeSync(child)) activeAuxiliaryProcesses.delete(child);
	}
};

/**
 * Register process cleanup without taking signal handling away from Joplin.
 */
const registerProcessCleanup = (dataDir: string) => {
	if (cleanupRegistered) return;
	cleanupRegistered = true;

	// 'exit' fires on clean process.exit() calls — must be synchronous.
	process.on('exit', () => syncKillAll(dataDir));

	for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
		const handler = () => {
			syncKillAll(dataDir);
			if (process.listenerCount(sig) === 1) {
				process.removeListener(sig, handler);
				process.kill(process.pid, sig);
			}
		};
		process.on(sig, handler);
	}
};

// ---------- npm path configuration ----------

let _configuredNpmPath = '';

export const setNpmPath = (path: string): void => {
	_configuredNpmPath = path.trim();
};

const resolveNpmCmd = (): string => {
	if (_configuredNpmPath) return _configuredNpmPath;
	return process.platform === 'win32' ? 'npm.cmd' : 'npm';
};

const resolveNpmInvocation = (args: string[]): { command: string; args: string[]; shell: boolean } => {
	const npmCommand = resolveNpmCmd();
	if (process.platform !== 'win32') return { command: npmCommand, args, shell: false };

	// Honor an explicit npm path as-is. Rewriting to npm-cli.js next to Node would
	// ignore the override (and break tests that inject a Node-based stub).
	if (_configuredNpmPath) {
		const needsShell = /\.(cmd|bat)$/i.test(npmCommand);
		return { command: npmCommand, args, shell: needsShell };
	}

	let npmCmdPath = npmCommand;
	if (!npmCmdPath.includes('\\') && !npmCmdPath.includes('/')) {
		const whereResult = spawnSync('where.exe', [npmCmdPath], { encoding: 'utf-8' });
		const resolvedPath = whereResult.status === 0 ? whereResult.stdout.split(/\r?\n/).find(Boolean) : undefined;
		if (resolvedPath) npmCmdPath = resolvedPath;
	}
	const npmCliPath = resolve(dirname(npmCmdPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
	if (existsSync(npmCliPath)) return { command: process.execPath, args: [npmCliPath, ...args], shell: false };
	return { command: npmCommand, args, shell: true };
};

const quoteForLog = (arg: string): string =>
	/[\s&,]/.test(arg) ? JSON.stringify(arg) : arg;

const redactSensitiveLogLine = (line: string): string =>
	line.replace(/([?&]password=)[^&\s/]+/g, '$1*****');

// ---------- child-process environment ----------

export const buildChildEnv = (): NodeJS.ProcessEnv => {
	const isWindows = process.platform === 'win32';

	// Strip Electron-specific NODE_OPTIONS flags (e.g. --localstorage-file) that
	// Joplin injects and that plain Node.js doesn't recognise, causing spurious warnings.
	const cleanNodeOptions = (process.env['NODE_OPTIONS'] ?? '')
		.split(/\s+/)
		.filter(f => f && !f.startsWith('--localstorage-'))
		.join(' ') || undefined;

	if (isWindows) {
		const extraPaths = [
			`${process.env['APPDATA'] ?? ''}\\npm`,
			'C:\\Program Files\\nodejs',
			'C:\\Program Files (x86)\\nodejs',
		].filter(Boolean).join(';');
		return {
			...process.env,
			PATH: `${extraPaths};${process.env['PATH'] ?? ''}`,
			NODE_OPTIONS: cleanNodeOptions,
		};
	}

	const home = process.env['HOME'] ?? '';
	const extraPaths = [
		'/usr/local/bin',
		'/opt/homebrew/bin',
		// NVM sets NVM_BIN to the active Node.js bin dir when a shell is sourced.
		// Fall back to a glob-free fixed path only as a last resort (not reliable).
		process.env['NVM_BIN'],
		// FNM sets FNM_NODE_PATH to the active Node.js bin dir.
		process.env['FNM_NODE_PATH'],
		// Volta
		process.env['VOLTA_HOME'] ? join(process.env['VOLTA_HOME'], 'bin') : undefined,
		`${home}/.volta/bin`,
	].filter(Boolean).join(':');

	return {
		...process.env,
		PATH: `${extraPaths}:${process.env['PATH'] ?? ''}`,
		NODE_OPTIONS: cleanNodeOptions,
	};
};

export const buildNodeChildEnv = (isElectron = Boolean(process.versions.electron)): NodeJS.ProcessEnv => ({
	...buildChildEnv(),
	...(isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
});

// ---------- version helpers ----------

export const slidevWorkspaceDir = (dataDir: string): string => join(dataDir, SLIDEV_WORK_DIR);

export const readInstalledSlidevVersion = async (dataDir: string): Promise<string | null> => {
	try {
		const raw = await readFile(
			join(dataDir, SLIDEV_WORK_DIR, 'node_modules', '@slidev', 'cli', 'package.json'),
			'utf-8',
		);
		const pkg = JSON.parse(raw);
		return typeof pkg.version === 'string' ? pkg.version : null;
	} catch {
		return null;
	}
};

export const readInstalledPlaywrightVersion = async (dataDir: string): Promise<string | null> => {
	try {
		const raw = await readFile(
			join(dataDir, SLIDEV_WORK_DIR, 'node_modules', 'playwright-chromium', 'package.json'),
			'utf-8',
		);
		const pkg = JSON.parse(raw);
		return typeof pkg.version === 'string' ? pkg.version : null;
	} catch {
		return null;
	}
};

const themeNameFromPackage = (packageName: string): string | null => {
	if (packageName.startsWith('@slidev/theme-')) return packageName.slice('@slidev/theme-'.length);
	if (packageName.startsWith('slidev-theme-')) return packageName.slice('slidev-theme-'.length);

	const scopedThemeMatch = packageName.match(/^(@[^/]+)\/slidev-theme-(.+)$/);
	if (scopedThemeMatch) return `${scopedThemeMatch[1]}/${scopedThemeMatch[2]}`;

	return null;
};

const readPackageName = async (packageDir: string): Promise<string | null> => {
	try {
		const raw = await readFile(join(packageDir, 'package.json'), 'utf-8');
		const pkg = JSON.parse(raw);
		return typeof pkg.name === 'string' ? pkg.name : null;
	} catch {
		return null;
	}
};

const readPackageInfo = async (packageDir: string): Promise<{ name: string; version: string } | null> => {
	try {
		const raw = await readFile(join(packageDir, 'package.json'), 'utf-8');
		const pkg = JSON.parse(raw);
		return typeof pkg.name === 'string'
			? { name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : '' }
			: null;
	} catch {
		return null;
	}
};

const isSlidevThemePackageName = (packageName: string) =>
	packageName.startsWith('@slidev/theme-')
	|| packageName.startsWith('slidev-theme-')
	|| /^@[^/]+\/slidev-theme-.+$/.test(packageName);

const isSlidevAddonPackageName = (packageName: string) =>
	packageName.startsWith('@slidev/addon-')
	|| packageName.startsWith('slidev-addon-')
	|| /^@[^/]+\/slidev-addon-.+$/.test(packageName);

export const listInstalledSlidevThemes = async (dataDir: string): Promise<InstalledSlidevTheme[]> => {
	const nodeModulesDir = join(slidevWorkspaceDir(dataDir), 'node_modules');
	const themes = new Map<string, InstalledSlidevTheme>();

	try {
		const entries = await readdir(nodeModulesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			if (entry.name.startsWith('@')) {
				const scopeDir = join(nodeModulesDir, entry.name);
				const scopedEntries = await readdir(scopeDir, { withFileTypes: true }).catch(() => []);
				for (const scopedEntry of scopedEntries) {
					if (!scopedEntry.isDirectory()) continue;
					const packageDir = join(scopeDir, scopedEntry.name);
					const packageName = await readPackageName(packageDir) ?? `${entry.name}/${scopedEntry.name}`;
					const name = themeNameFromPackage(packageName);
					if (name) themes.set(name, { name, packageName });
				}
				continue;
			}

			const packageDir = join(nodeModulesDir, entry.name);
			const packageName = await readPackageName(packageDir) ?? entry.name;
			const name = themeNameFromPackage(packageName);
			if (name) themes.set(name, { name, packageName });
		}
	} catch {
		return [];
	}

	return [...themes.values()].sort((a, b) => a.name.localeCompare(b.name));
};

export const listInstalledSlidevPackages = async (dataDir: string, kind: 'theme' | 'addon'): Promise<InstalledSlidevPackage[]> => {
	const nodeModulesDir = join(slidevWorkspaceDir(dataDir), 'node_modules');
	const packages = new Map<string, InstalledSlidevPackage>();
	const matchesKind = kind === 'theme' ? isSlidevThemePackageName : isSlidevAddonPackageName;

	try {
		const entries = await readdir(nodeModulesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			if (entry.name.startsWith('@')) {
				const scopeDir = join(nodeModulesDir, entry.name);
				const scopedEntries = await readdir(scopeDir, { withFileTypes: true }).catch(() => []);
				for (const scopedEntry of scopedEntries) {
					if (!scopedEntry.isDirectory()) continue;
					const info = await readPackageInfo(join(scopeDir, scopedEntry.name));
					if (info && matchesKind(info.name)) packages.set(info.name, { packageName: info.name, version: info.version });
				}
				continue;
			}

			const info = await readPackageInfo(join(nodeModulesDir, entry.name));
			if (info && matchesKind(info.name)) packages.set(info.name, { packageName: info.name, version: info.version });
		}
	} catch {
		return [];
	}

	return [...packages.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
};

// ---------- project setup ----------

// Minimal package.json written into the work dir so Slidev can resolve themes
// from a local node_modules rather than prompting to download them at runtime.
export const SUPPORTED_SLIDEV_VERSION = '52.19.0';
export const SUPPORTED_PLAYWRIGHT_VERSION = '1.62.1';

const REQUIRED_WORKSPACE_DEPENDENCIES = {
	'@slidev/cli': SUPPORTED_SLIDEV_VERSION,
	'@slidev/theme-default': '0.25.0',
	'@slidev/theme-seriph': '0.25.0',
};
const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

const assertNpmPackageName = (packageName: string): void => {
	if (!NPM_PACKAGE_NAME_RE.test(packageName)) throw new Error(`Invalid npm package name: ${packageName}`);
};

export const isRequiredSlidevPackage = (packageName: string): boolean =>
	Object.prototype.hasOwnProperty.call(REQUIRED_WORKSPACE_DEPENDENCIES, packageName);

const resolvePackageBin = async (workspaceDir: string, packageName: string, binName: string): Promise<string> => {
	const packageDir = join(workspaceDir, 'node_modules', ...packageName.split('/'));
	const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf-8')) as {
		bin?: string | Record<string, string>;
	};
	const relativeBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName];
	if (!relativeBin) throw new Error(`${packageName} does not define the ${binName} executable`);
	const entryPath = resolve(packageDir, relativeBin);
	if (dirname(entryPath) !== packageDir && !entryPath.startsWith(`${packageDir}${sep}`)) {
		throw new Error(`${packageName} executable escapes its package directory`);
	}
	await access(entryPath);
	return entryPath;
};

const writeWorkspacePackageJson = async (workDir: string): Promise<void> => {
	const packagePath = join(workDir, 'package.json');
	let existing: Record<string, any> = {};
	try {
		const parsed = JSON.parse(await readFile(packagePath, 'utf-8'));
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
	} catch {
		// Missing or invalid package metadata is rebuilt below.
	}
	const packageJson = {
		...existing,
		name: typeof existing.name === 'string' ? existing.name : 'joplin-slidev-presentation',
		private: true,
		dependencies: {
			...(existing.dependencies && typeof existing.dependencies === 'object' ? existing.dependencies : {}),
			...REQUIRED_WORKSPACE_DEPENDENCIES,
		},
	};
	const temporaryPath = `${packagePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	await writeFile(temporaryPath, JSON.stringify(packageJson, null, 2), 'utf-8');
	await rename(temporaryPath, packagePath);
};

const workspaceStateTails = new Map<string, Promise<void>>();
const activeWorkspaceUsers = new Map<string, number>();

const withWorkspaceState = <T>(workDir: string, operation: () => Promise<T> | T): Promise<T> => {
	const previous = workspaceStateTails.get(workDir) ?? Promise.resolve();
	const result = previous.then(operation);
	const tail = result.then(() => undefined, () => undefined);
	workspaceStateTails.set(workDir, tail);
	tail.finally(() => {
		if (workspaceStateTails.get(workDir) === tail) workspaceStateTails.delete(workDir);
	}).catch(() => {});
	return result;
};

const withWorkspaceMutation = <T>(workDir: string, operation: () => Promise<T>): Promise<T> =>
	withWorkspaceState(workDir, async () => {
		if ((activeWorkspaceUsers.get(workDir) ?? 0) > 0) {
			throw new Error('Close running Slidev presentations and exports before changing workspace packages.');
		}
		return operation();
	});

const acquireWorkspaceUse = (workDir: string): Promise<() => Promise<void>> =>
	withWorkspaceState(workDir, () => {
		activeWorkspaceUsers.set(workDir, (activeWorkspaceUsers.get(workDir) ?? 0) + 1);
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			await withWorkspaceState(workDir, () => {
				const remaining = (activeWorkspaceUsers.get(workDir) ?? 1) - 1;
				if (remaining > 0) activeWorkspaceUsers.set(workDir, remaining);
				else activeWorkspaceUsers.delete(workDir);
			});
		};
	});

const runStreamingProcess = (
	command: string,
	args: string[],
	workDir: string,
	shell: boolean,
	operation: string,
	emit: (line: string) => void,
): Promise<void> => new Promise((resolveRun, reject) => {
	const proc = spawn(command, args, {
		cwd: workDir,
		env: buildNodeChildEnv(),
		shell,
		detached: process.platform !== 'win32',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	trackAuxiliaryProcess(proc);
	const onData = (d: Buffer) =>
		d.toString().split('\n').map(line => line.trimEnd()).filter(Boolean).forEach(emit);
	proc.stdout?.on('data', onData);
	proc.stderr?.on('data', onData);
	proc.on('error', reject);
	proc.on('close', code => code === 0 ? resolveRun() : reject(new Error(`${operation} exited with code ${code}`)));
});

const runNpmCommand = (
	workDir: string,
	args: string[],
	operation: string,
	emit: (line: string) => void,
): Promise<void> => {
	const invocation = resolveNpmInvocation(args);
	return withWorkspaceMutation(workDir, () =>
		runStreamingProcess(invocation.command, invocation.args, workDir, invocation.shell, operation, emit));
};

const runNpmInstallPackage = (
	workDir: string,
	packages: string | string[],
	emit: (line: string) => void,
	conflictMode: NpmInstallConflictMode = 'default',
): Promise<void> => {
	const pkgs = Array.isArray(packages) ? packages : [packages];
	const conflictArgs = conflictMode === 'legacy-peer-deps'
		? ['--legacy-peer-deps']
		: conflictMode === 'force' ? ['--force'] : [];
	return runNpmCommand(workDir, ['install', ...pkgs, '--no-audit', '--no-fund', ...conflictArgs], 'npm install', emit);
};

const runNpmUninstallPackage = (
	workDir: string,
	packageName: string,
	emit: (line: string) => void,
): Promise<void> => {
	return runNpmCommand(workDir, ['uninstall', packageName, '--no-audit', '--no-fund'], 'npm uninstall', emit);
};

const hasPlaywrightChromium = async (workDir: string): Promise<boolean> => {
	try {
		const packageDir = join(workDir, 'node_modules', 'playwright-chromium');
		const playwright = require(packageDir) as { chromium?: { executablePath: () => string } };
		const executablePath = playwright.chromium?.executablePath();
		return Boolean(executablePath && await access(executablePath).then(() => true).catch(() => false));
	} catch {
		return false;
	}
};

const runNodePackageBin = (
	workDir: string,
	entryPath: string,
	args: string[],
	emit: (line: string) => void,
): Promise<void> => withWorkspaceMutation(workDir, () =>
	runStreamingProcess(process.execPath, [entryPath, ...args], workDir, false, 'Process', emit));

const ensurePlaywrightChromium = async (workDir: string, emit: (line: string) => void) => {
	const packagePath = join(workDir, 'node_modules', 'playwright-chromium', 'package.json');
	const installedVersion = await readFile(packagePath, 'utf-8')
		.then(content => JSON.parse(content).version as string | undefined)
		.catch(() => undefined);
	const needsInstall = installedVersion !== SUPPORTED_PLAYWRIGHT_VERSION;
	if (needsInstall) {
		emit('Installing playwright-chromium for Slidev CLI export...');
		emit('(This is required by Slidev export and may take a while once.)');
		await runNpmInstallPackage(workDir, `playwright-chromium@${SUPPORTED_PLAYWRIGHT_VERSION}`, emit);
	}
	if (!await hasPlaywrightChromium(workDir)) {
		emit('Installing the Chromium browser required by Slidev export...');
		const playwrightEntry = await resolvePackageBin(workDir, 'playwright-chromium', 'playwright');
		await runNodePackageBin(workDir, playwrightEntry, ['install', 'chromium'], emit);
	}
	emit('Playwright Chromium is ready.');
};

export const installSlidevPackage = (
	dataDir: string,
	packageName: string,
	emit: (line: string) => void,
	conflictMode?: NpmInstallConflictMode,
): Promise<void> => {
	registerProcessCleanup(dataDir);
	assertNpmPackageName(packageName);
	return runNpmInstallPackage(slidevWorkspaceDir(dataDir), `${packageName}@latest`, emit, conflictMode);
};

export const uninstallSlidevPackage = (
	dataDir: string,
	packageName: string,
	emit: (line: string) => void,
): Promise<void> => {
	registerProcessCleanup(dataDir);
	assertNpmPackageName(packageName);
	return runNpmUninstallPackage(slidevWorkspaceDir(dataDir), packageName, emit);
};

export const updateSlidevCore = (dataDir: string, emit: (line: string) => void): Promise<void> => {
	registerProcessCleanup(dataDir);
	return runNpmInstallPackage(
		slidevWorkspaceDir(dataDir),
		Object.entries(REQUIRED_WORKSPACE_DEPENDENCIES).map(([name, version]) => `${name}@${version}`),
		emit,
	);
};

export const updatePlaywrightChromium = (dataDir: string, emit: (line: string) => void): Promise<void> => {
	registerProcessCleanup(dataDir);
	return runNpmInstallPackage(slidevWorkspaceDir(dataDir), `playwright-chromium@${SUPPORTED_PLAYWRIGHT_VERSION}`, emit);
};

const workspaceSetupTasks = new Map<string, Promise<void>>();

const ensureSlidevWorkspaceOnce = async (dataDir: string, emit: (line: string) => void): Promise<void> => {
	const workDir = slidevWorkspaceDir(dataDir);
	await mkdir(workDir, { recursive: true });
	await withWorkspaceState(workDir, () => writeWorkspacePackageJson(workDir));
	const installedVersions = await Promise.all(Object.keys(REQUIRED_WORKSPACE_DEPENDENCIES).map(async packageName => {
		try {
			const packagePath = join(workDir, 'node_modules', ...packageName.split('/'), 'package.json');
			return JSON.parse(await readFile(packagePath, 'utf-8')).version as string | undefined;
		} catch {
			return undefined;
		}
	}));
	const requiredVersions = Object.values(REQUIRED_WORKSPACE_DEPENDENCIES);
	if (installedVersions.every((version, index) => version === requiredVersions[index])) {
		try {
			await resolvePackageBin(workDir, '@slidev/cli', 'slidev');
			return;
		} catch {
			await rm(join(workDir, 'node_modules', '@slidev', 'cli'), { recursive: true, force: true });
		}
	}
	emit('Preparing compatible @slidev/cli and theme versions via npm…');
	emit('(First-time setup may take ~30 s; subsequent starts are instant.)');
	await runNpmInstallPackage(workDir, [], emit);
	emit('npm install complete.');
};

export const ensureSlidevWorkspace = (dataDir: string, emit: (line: string) => void): Promise<void> => {
	registerProcessCleanup(dataDir);
	const workDir = slidevWorkspaceDir(dataDir);
	const existingTask = workspaceSetupTasks.get(workDir);
	if (existingTask) return existingTask;
	const task = ensureSlidevWorkspaceOnce(dataDir, emit).finally(() => {
		if (workspaceSetupTasks.get(workDir) === task) workspaceSetupTasks.delete(workDir);
	});
	workspaceSetupTasks.set(workDir, task);
	return task;
};

const prepareSlideshowDir = async (
	markdown: string,
	dataDir: string,
	workspaceDir: string,
	emit: (line: string) => void,
	preprocessMarkdown?: (md: string, workDir: string) => Promise<string>,
	extraFiles?: Record<string, string>,
): Promise<{ workDir: string; slidevEntry: string }> => {
	const decksDir = join(workspaceDir, 'decks');
	await mkdir(decksDir, { recursive: true });
	const workDir = await mkdtemp(join(decksDir, 'deck-'));

	try {
		const processedMarkdown = preprocessMarkdown
			? await preprocessMarkdown(markdown, workDir)
			: markdown;
		await writeFile(join(workDir, 'slides.md'), processedMarkdown, 'utf-8');

		if (extraFiles) {
			for (const [relativePath, content] of Object.entries(extraFiles)) {
				const fullPath = join(workDir, relativePath);
				await mkdir(join(fullPath, '..'), { recursive: true });
				await writeFile(fullPath, content, 'utf-8');
			}
		}

		return {
			workDir,
			slidevEntry: await resolvePackageBin(workspaceDir, '@slidev/cli', 'slidev'),
		};
	} catch (error) {
		await removeManagedDeck(dataDir, workDir);
		throw error;
	}
};

// ---------- public API ----------

export const startSlidevServer = async (
	markdown: string,
	dataDir: string,
	port: number,
	onLog?: (line: string) => void,
	preprocessMarkdown?: (md: string, workDir: string) => Promise<string>,
	extraFiles?: Record<string, string>,
	remoteOptions?: SlidevRemoteOptions,
): Promise<SlidevServer> => {
	registerProcessCleanup(dataDir);

	const env = buildNodeChildEnv();

	const emit = (line: string) => {
		const redacted = redactSensitiveLogLine(line);
		console.log('[Slidev]', redacted);
		onLog?.(redacted);
	};

	const workspaceDir = slidevWorkspaceDir(dataDir);
	await ensureSlidevWorkspace(dataDir, emit);
	const releaseWorkspaceUse = await acquireWorkspaceUse(workspaceDir);
	let workDir: string;
	let slidevEntry: string;
	try {
		({ workDir, slidevEntry } = await prepareSlideshowDir(markdown, dataDir, workspaceDir, emit, preprocessMarkdown, extraFiles));
	} catch (error) {
		await releaseWorkspaceUse();
		throw error;
	}

	const cmd = process.execPath;
	const args = [slidevEntry, 'slides.md', '--port', String(port), '--no-open'];
	const remotePassword = remoteOptions?.remotePassword.trim() ?? '';
	const remoteBind = remoteOptions?.remoteBind.trim() ?? '';
	const remoteEnabled = Boolean(remoteOptions?.remoteAccess || remotePassword || remoteOptions?.remoteTunnel);
	if (remotePassword) args.push(`--remote=${remotePassword}`);
	else if (remoteEnabled) args.push('--remote');
	if (remoteEnabled && remoteBind) args.push('--bind', remoteBind);
	if (remoteOptions?.remoteTunnel) args.push('--tunnel');
	const displayArgs = args.map(arg => arg.startsWith('--remote=') ? '--remote=*****' : quoteForLog(arg));

	emit(`Starting: ${quoteForLog(cmd)} ${displayArgs.join(' ')}`);

	let proc: ChildProcess;
	try {
		proc = spawn(cmd, args, {
			cwd: workDir,
			shell: false,
			env,
			// New process group so we can kill the entire tree with -pid.
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error) {
		await releaseWorkspaceUse();
		await removeManagedDeck(dataDir, workDir);
		throw error;
	}

	// Attach log handlers BEFORE the spawnError check so no output is missed.
	const handleData = (d: Buffer) => {
		for (const line of d.toString().split('\n')) {
			const trimmed = line.trimEnd();
			if (trimmed) emit(trimmed);
		}
	};
	proc.stdout?.on('data', handleData);
	proc.stderr?.on('data', handleData);

	const server: SlidevServer = {
		process: proc,
		port,
		workDir,
		dataDir,
		closed: new Promise<number | null>((resolveClosed) => {
			proc.once('close', (code) => {
				closedProcesses.add(proc);
				activeServers.delete(server);
				Promise.allSettled([
					removeManagedDeck(dataDir, workDir),
					releaseWorkspaceUse(),
				]).then(([deckCleanup]) => {
					if (deckCleanup.status === 'fulfilled') removePidFileSync(dataDir, proc.pid);
					else console.warn(`[Slidev] Retaining PID metadata ${proc.pid} – deck cleanup failed`);
				}).finally(() => resolveClosed(code));
			});
		}),
	};
	activeServers.add(server);

	// Detect immediate spawn failures and exits before returning the handle.
	const startupFailure = new Promise<Error | null>((resolveStartup) => {
		let done = false;
		proc.once('error', (error) => {
			if (!done) {
				done = true;
				resolveStartup(error);
			}
		});
		proc.once('close', (code) => {
			if (!done) {
				done = true;
				resolveStartup(new Error(`Slidev exited with code ${code} before startup`));
			}
		});
		setTimeout(() => {
			if (!done) {
				done = true;
				resolveStartup(null);
			}
		}, 400);
	});

	try {
		if (proc.pid) {
			await writePidFile(dataDir, proc.pid, workDir, cmd, slidevEntry);
			if (proc.exitCode !== null || proc.signalCode !== null) removePidFileSync(dataDir, proc.pid);
		}
	} catch (error) {
		if (killServerSync(server)) {
			activeServers.delete(server);
			await removeManagedDeck(dataDir, workDir).catch(() => {});
		}
		throw error;
	}

	const spawnError = await startupFailure;
	if (spawnError) {
		if (killServerSync(server)) {
			activeServers.delete(server);
			removePidFileSync(dataDir, proc.pid);
			await removeManagedDeck(dataDir, workDir).catch(() => {});
		}
		const isNotFound = (spawnError as NodeJS.ErrnoException).code === 'ENOENT';
		const hint = isNotFound
			? `\n\nThe local Slidev binary was not found. Try restarting Joplin or reinstalling the plugin dependencies.`
			: '';
		throw new Error(spawnError.message + hint);
	}

	// Unref so Joplin's event loop is not held open waiting for this child.
	// The exit/signal handlers above will still kill it when Joplin goes down.
	if (process.platform !== 'win32') proc.unref();

	return server;
};

export const stopSlidevServer = (server: SlidevServer): void => {
	if (killServerSync(server)) {
		activeServers.delete(server);
	} else console.error(`[Slidev] Could not stop server process ${server.process.pid}; it remains tracked for shutdown cleanup`);
};

export const exportSlidevDeck = async (
	markdown: string,
	dataDir: string,
	format: 'pdf' | 'pptx' | 'png' | 'md',
	outputPath: string,
	onLog?: (line: string) => void,
	preprocessMarkdown?: (md: string, workDir: string) => Promise<string>,
	extraFiles?: Record<string, string>,
): Promise<string> => {
	registerProcessCleanup(dataDir);
	const env = buildNodeChildEnv();
	const emit = (line: string) => {
		const redacted = redactSensitiveLogLine(line);
		console.log('[Slidev]', redacted);
		onLog?.(redacted);
	};
	const workspaceDir = slidevWorkspaceDir(dataDir);
	await ensureSlidevWorkspace(dataDir, emit);
	await ensurePlaywrightChromium(workspaceDir, emit);
	const releaseWorkspaceUse = await acquireWorkspaceUse(workspaceDir);
	let workDir: string | undefined;
	try {
		const prepared = await prepareSlideshowDir(markdown, dataDir, workspaceDir, emit, preprocessMarkdown, extraFiles);
		workDir = prepared.workDir;
		const args = [prepared.slidevEntry, 'export', 'slides.md', '--format', format, '--output', outputPath];
		emit(`Exporting: ${quoteForLog(process.execPath)} ${args.map(quoteForLog).join(' ')}`);

		await new Promise<void>((resolveExport, reject) => {
			const proc = spawn(process.execPath, args, {
				cwd: workDir,
				shell: false,
				env,
				detached: process.platform !== 'win32',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			trackAuxiliaryProcess(proc);

			const handleData = (d: Buffer) => {
				for (const line of d.toString().split('\n')) {
					const trimmed = line.trimEnd();
					if (trimmed) onLog?.(redactSensitiveLogLine(trimmed));
				}
			};
			proc.stdout?.on('data', handleData);
			proc.stderr?.on('data', handleData);
			proc.on('error', reject);
			proc.on('close', (code) => {
				code === 0 ? resolveExport() : reject(new Error(`Slidev export exited with code ${code}`));
			});
		});
	} finally {
		await Promise.all([
			workDir ? removeManagedDeck(dataDir, workDir) : undefined,
			releaseWorkspaceUse(),
		]);
	}

	emit(`Export complete: ${outputPath}`);
	return outputPath;
};
