import joplin from 'api';
import { SettingItemType, SettingStorage } from 'api/types';
import { settingsSectionName } from './constants';
import { PluginSettings } from './types';
import { InstalledSlidevTheme } from './slideServer';

const defaultPortKey = 'slidev-default-port';
const defaultThemeKey = 'slidev-default-theme';
const remoteAccessKey = 'slidev-remote-access';
const remotePasswordKey = 'slidev-remote-password';
const remoteTunnelKey = 'slidev-remote-tunnel';
const remoteBindKey = 'slidev-remote-bind';
const presenterControlledNavigationKey = 'slidev-presenter-controlled-navigation';
const initialViewKey = 'slidev-initial-view';
const colorSchemaKey = 'slidev-color-schema';
const aspectRatioKey = 'slidev-aspect-ratio';
const lineNumbersKey = 'slidev-line-numbers';
const wakeLockKey = 'slidev-wake-lock';
const selectableKey = 'slidev-selectable';
const contextMenuKey = 'slidev-context-menu';
const overviewSnapshotsKey = 'slidev-overview-snapshots';
const hideToolbarButtonKey = 'slidev-hide-toolbar-button';
const disableMarkdownCompatFixesKey = 'slidev-disable-markdown-compat-fixes';
const embedAudioResourcesKey = 'slidev-embed-audio-resources';
const embedVideoResourcesKey = 'slidev-embed-video-resources';
const embedPdfResourcesKey = 'slidev-embed-pdf-resources';
const slideProgressKey = 'slidev-slide-progress';
const disableFrontmatterRendererKey = 'slidev-disable-frontmatter-renderer';
const npmPathKey = 'slidev-npm-path';
export const workspacePathKey = 'slidev-workspace-path';
export const openSlidevWorkspaceKey = 'slidev-open-workspace';

export const getSettings = async (): Promise<PluginSettings> => {
	return {
		defaultPort: await joplin.settings.value(defaultPortKey),
		defaultTheme: await joplin.settings.value(defaultThemeKey),
		remoteAccess: await joplin.settings.value(remoteAccessKey),
		remotePassword: await joplin.settings.value(remotePasswordKey),
		remoteTunnel: await joplin.settings.value(remoteTunnelKey),
		remoteBind: await joplin.settings.value(remoteBindKey),
		presenterControlledNavigation: await joplin.settings.value(presenterControlledNavigationKey),
		initialView: await joplin.settings.value(initialViewKey),
		colorSchema: await joplin.settings.value(colorSchemaKey),
		aspectRatio: await joplin.settings.value(aspectRatioKey),
		lineNumbers: await joplin.settings.value(lineNumbersKey),
		wakeLock: await joplin.settings.value(wakeLockKey),
		selectable: await joplin.settings.value(selectableKey),
		contextMenu: await joplin.settings.value(contextMenuKey),
		overviewSnapshots: await joplin.settings.value(overviewSnapshotsKey),
		hideToolbarButton: await joplin.settings.value(hideToolbarButtonKey),
		disableMarkdownCompatFixes: await joplin.settings.value(disableMarkdownCompatFixesKey),
		embedAudioResources: await joplin.settings.value(embedAudioResourcesKey),
		embedVideoResources: await joplin.settings.value(embedVideoResourcesKey),
		embedPdfResources: await joplin.settings.value(embedPdfResourcesKey),
		slideProgress: await joplin.settings.value(slideProgressKey),
		disableFrontmatterRenderer: await joplin.settings.value(disableFrontmatterRendererKey),
		npmPath: await joplin.settings.value(npmPathKey),
	};
};

export const registerSettings = async (workspaceDir: string, installedThemes: InstalledSlidevTheme[]) => {
	const themeOptions = installedThemes.reduce<Record<string, string>>((options, theme) => {
		options[theme.name] = `${theme.name} (${theme.packageName})`;
		return options;
	}, { '': 'Use note theme or Slidev default' });

	await joplin.settings.registerSection(settingsSectionName, {
		label: 'Slidev Presentation',
		iconName: 'fas fa-play-circle',
		description: 'Configure how Slidev presentations start, render, export, and share from Joplin.',
	});

	await joplin.settings.registerSettings({
		[defaultPortKey]: {
			public: true,
			section: settingsSectionName,
			label: 'Default port',
			description: 'Port the Slidev dev server listens on. If the port is already in use, the next free port is picked automatically.',
			type: SettingItemType.Int,
			storage: SettingStorage.File,
			value: 3030,
		},
		[workspacePathKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Slidev workspace path (read-only)',
			description: 'Informational only. This local folder is managed by the plugin and used for Slidev dependencies, generated slides, and copied attachments. If it is edited, the plugin resets it back to the managed workspace path.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: workspaceDir,
		},
		[defaultThemeKey]: {
			public: true,
			section: settingsSectionName,
			label: 'Default Slidev theme',
			description: 'Visual theme applied to all presentations. Only used when a note does not declare its own theme. Override for a single presentation by adding "theme: [name]" to the note\'s headmatter. The list shows themes installed in the Slidev workspace.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
			isEnum: true,
			options: themeOptions,
		},
		[remoteAccessKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Enable Slidev remote access',
			description: 'Pass --remote to Slidev so the server listens on the public host and remote control is enabled. A presenter remote password also enables this automatically.',
			type: SettingItemType.Bool,
			storage: SettingStorage.File,
			value: false,
		},
		[remotePasswordKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Presenter remote password',
			description: 'Optional password passed to Slidev as --remote=[password]. When set, Slidev requires this password before presenter mode can be opened.',
			type: SettingItemType.String,
			storage: SettingStorage.Database,
			secure: true,
			value: '',
		},
		[remoteTunnelKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Enable Slidev remote tunnel',
			description: 'Pass --tunnel together with --remote to Slidev to open a Cloudflare Quick Tunnel for sharing the local server over the internet.',
			type: SettingItemType.Bool,
			storage: SettingStorage.File,
			value: false,
		},
		[remoteBindKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Slidev remote bind address',
			description: 'Optional address passed to Slidev as --bind when remote access is enabled. Leave empty to use Slidev default 0.0.0.0.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
		},
		[presenterControlledNavigationKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Presenter-controlled navigation',
			description: 'Lock the public slide view so viewers cannot advance slides themselves. Presenter mode and tunnel entry controls remain usable and keep the public view in sync.',
			type: SettingItemType.Bool,
			storage: SettingStorage.File,
			value: false,
		},
		[initialViewKey]: {
			public: true,
			section: settingsSectionName,
			label: 'Initial Slidev view',
			description: 'Which Slidev view opens automatically when you start a presentation. "Presenter" shows the speaker view with notes; "Overview" shows a grid of all slides; "None" does not open any window automatically. The other views are always accessible from the startup dialog.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: 'slides',
			isEnum: true,
			options: {
				slides: 'Slides',
				presenter: 'Presenter',
				overview: 'Overview',
				none: 'None (use dialog buttons)',
			},
		},
		[colorSchemaKey]: {
			public: true,
			section: settingsSectionName,
			label: 'Color schema',
			description: 'Default light/dark mode for all presentations. "Auto" follows the OS setting. Only applied when a note does not declare its own colorSchema. Override for a single presentation by adding "colorSchema: dark" (or "light" / "auto") to the note\'s headmatter.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
			isEnum: true,
			options: {
				'': 'Use note or Slidev default',
				auto: 'Auto',
				dark: 'Dark',
				light: 'Light',
			},
		},
		[aspectRatioKey]: {
			public: true,
			section: settingsSectionName,
			label: 'Aspect ratio',
			description: 'Default slide canvas ratio. 16:9 suits most displays and projectors; 4:3 matches older projectors. Only applied when a note does not declare its own aspectRatio. Override for a single presentation by adding "aspectRatio: 16/9" to the note\'s headmatter.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
			isEnum: true,
			options: {
				'': 'Use note or Slidev default',
				'16/9': '16:9',
				'4/3': '4:3',
				'1/1': '1:1',
			},
		},
		[lineNumbersKey]: {
			public: true,
			section: settingsSectionName,
			label: 'Code line numbers',
			description: 'Show line numbers in fenced code blocks on slides. Only applied when a note does not declare its own lineNumbers. Override for a single presentation by adding "lineNumbers: true" (or "false") to the note\'s headmatter.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
			isEnum: true,
			options: {
				'': 'Use note or Slidev default',
				true: 'Show line numbers',
				false: 'Hide line numbers',
			},
		},
		[wakeLockKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Wake lock',
			description: 'Prevent the screen from turning off or dimming during a presentation. Enable this so your display stays on while presenting without touching the keyboard or mouse. Only applied when a note does not set wakeLock itself. Override for a single presentation by adding "wakeLock: true" (or "false") to the note\'s headmatter.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
			isEnum: true,
			options: {
				'': 'Use note or Slidev default',
				true: 'Enable (keep screen on)',
				false: 'Disable',
			},
		},
		[selectableKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Selectable slide text',
			description: 'Allow the audience to select and copy text on slides. Useful for presentations shared as a webpage; often undesirable in live presenting mode. Only applied when a note does not declare its own selectable. Override for a single presentation by adding "selectable: true" (or "false") to the note\'s headmatter.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
			isEnum: true,
			options: {
				'': 'Use note or Slidev default',
				true: 'Allow text selection',
				false: 'Prevent text selection',
			},
		},
		[contextMenuKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Slidev context menu',
			description: 'Show the Slidev right-click context menu on slides. The menu provides shortcuts for navigation and presenter controls. Only applied when a note does not declare its own contextMenu. Override for a single presentation by adding "contextMenu: true" (or "false") to the note\'s headmatter.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
			isEnum: true,
			options: {
				'': 'Use note or Slidev default',
				true: 'Enable context menu',
				false: 'Disable context menu',
			},
		},
		[overviewSnapshotsKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Overview snapshots',
			description: 'Render live thumbnail previews of each slide in the overview grid. Looks nicer but uses more memory. Only applied when a note does not declare its own overviewSnapshots. Override for a single presentation by adding "overviewSnapshots: true" (or "false") to the note\'s headmatter.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
			isEnum: true,
			options: {
				'': 'Use note or Slidev default',
				true: 'Enable overview snapshots',
				false: 'Disable overview snapshots',
			},
		},
		[slideProgressKey]: {
			public: true,
			section: settingsSectionName,
			label: 'Slide progress',
			description: 'Show a small current-slide indicator during presentations. Useful for pacing and audience orientation. Only applied when a note does not already include a custom progress overlay. Override for a single presentation by placing a custom progress component or marker in the note.',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
			isEnum: true,
			options: {
				'': 'Use note or Slidev default',
				'slide-number': 'Show slide number',
				'progress-bar': 'Show progress bar',
				'slide-number-and-bar': 'Show number and progress bar',
			},
		},
		[hideToolbarButtonKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Hide toolbar button',
			description: 'Remove the "Start Slidev Presentation" button from the note toolbar. The command remains accessible via the View menu.',
			type: SettingItemType.Bool,
			storage: SettingStorage.File,
			value: false,
		},
		[disableFrontmatterRendererKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Disable frontmatter renderer',
			description: 'By default the plugin hides Slidev YAML frontmatter blocks (--- … ---) from Joplin\'s note preview. Enable this if the frontmatter renderer conflicts with another plugin that also processes frontmatter.',
			type: SettingItemType.Bool,
			storage: SettingStorage.File,
			value: false,
		},
		[disableMarkdownCompatFixesKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Disable Markdown compatibility fixes',
			description: 'The plugin automatically rewrites certain Markdown patterns that confuse Slidev — for example "* item" bullets are converted to "- item" because an asterisk at the start of a YAML value is interpreted as a YAML alias and causes parse errors. Enable this only if your notes already use Slidev-compatible Markdown and you want them rendered exactly as written.',
			type: SettingItemType.Bool,
			storage: SettingStorage.File,
			value: false,
		},
		[embedAudioResourcesKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Embed audio attachments',
			description: 'When enabled, Joplin audio attachments are converted into HTML audio players that appear directly on the slide. When disabled, the link is rendered as plain text.',
			type: SettingItemType.Bool,
			storage: SettingStorage.File,
			value: true,
		},
		[embedVideoResourcesKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Embed video attachments',
			description: 'When enabled, Joplin video attachments are converted into HTML video players that appear directly on the slide. When disabled, the link is rendered as plain text.',
			type: SettingItemType.Bool,
			storage: SettingStorage.File,
			value: true,
		},
		[embedPdfResourcesKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'Embed PDF attachments',
			description: 'When enabled, Joplin PDF attachments are embedded as inline previews on the slide using the browser\'s built-in PDF viewer. When disabled, the link is rendered as plain text.',
			type: SettingItemType.Bool,
			storage: SettingStorage.File,
			value: true,
		},
		[npmPathKey]: {
			public: true,
			advanced: true,
			section: settingsSectionName,
			label: 'npm executable path',
			description: 'Path to the npm executable used to install Slidev dependencies. Leave empty for automatic detection (npm.cmd on Windows, npm on macOS/Linux). Set this if the plugin reports "spawn npm ENOENT" — for example on Windows you might enter "C:\\Program Files\\nodejs\\npm.cmd".',
			type: SettingItemType.String,
			storage: SettingStorage.File,
			value: '',
		},
	});
	await joplin.settings.setValue(workspacePathKey, workspaceDir);

	try {
		await joplin.settings.registerSetting(openSlidevWorkspaceKey, {
			public: true,
			section: settingsSectionName,
			label: 'Open Slidev workspace',
			description: 'Open the local Slidev workspace in your file manager.',
			type: SettingItemType.Button,
			value: '',
		});
	} catch (e) {
		console.warn('[Slidev] SettingItemType.Button is not available in this Joplin version:', e);
	}
};
