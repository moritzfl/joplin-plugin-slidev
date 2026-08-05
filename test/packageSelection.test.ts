import { describe, expect, it } from 'vitest';
import { packageSelection } from '../src/dialog/packageSelection';

describe('packageSelection', () => {
	it('returns only the selected package from the active marketplace view', () => {
		const formData = {
			packagePicker: {
				'packageName-theme': 'theme-a',
				'packageName-addon': 'addon-a',
				'packageName-installed': 'installed-a',
			},
		};

		expect(packageSelection(formData, 'theme', new Set(['theme-a']))).toBe('theme-a');
		expect(packageSelection(formData, 'addon', new Set(['addon-a']))).toBe('addon-a');
		expect(packageSelection(formData, 'installed', new Set(['installed-a']))).toBe('installed-a');
	});

	it('rejects values that do not belong to the active view', () => {
		const formData = { packagePicker: { 'packageName-theme': 'hidden-addon' } };

		expect(packageSelection(formData, 'theme', new Set(['visible-theme']))).toBe('');
	});
});
