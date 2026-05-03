export const esc = (s: string): string =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const render = (template: string, vars: Record<string, string>): string =>
	Object.entries(vars).reduce((t, [k, v]) => {
		const placeholder = `__${k}__`;
		return t.split(placeholder).join(v);
	}, template);
