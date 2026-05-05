export interface PluginSettings {
	defaultPort: number;
	defaultTheme: string;
	remoteAccess: boolean;
	remotePassword: string;
	remoteTunnel: boolean;
	remoteBind: string;
	presenterControlledNavigation: boolean;
	initialView: string;
	colorSchema: string;
	aspectRatio: string;
	lineNumbers: string;
	wakeLock: string;
	selectable: string;
	contextMenu: string;
	overviewSnapshots: string;
	hideToolbarButton: boolean;
	disableMarkdownCompatFixes: boolean;
	embedAudioResources: boolean;
	embedVideoResources: boolean;
	embedPdfResources: boolean;
	slideNumber: string;
	slideProgressBar: string;
	disableFrontmatterRenderer: boolean;
	npmPath: string;
}
