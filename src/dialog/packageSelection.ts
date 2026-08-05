export type PackageView = 'theme' | 'addon' | 'installed';

const runtimePackages = new Set(['__runtime_slidev', '__runtime_playwright']);

export const packageSelection = (formData: any, view: PackageView, allowedPackages: Set<string>): string => {
	const key = `packageName-${view}`;
	const value = formData?.packagePicker?.[key] ?? formData?.[key];
	if (typeof value !== 'string') return '';
	if (view === 'installed' && runtimePackages.has(value)) return value;
	return allowedPackages.has(value) ? value : '';
};
