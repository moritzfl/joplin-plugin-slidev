declare module '*.css' {
	const content: string;
	export default content;
}

declare module '*.html' {
	const content: string;
	export default content;
}

declare module '*.vue' {
	const content: string;
	export default content;
}

declare module 'vue' {
	export function inject<T>(key: string, defaultValue?: T): T
	export function computed<T>(getter: () => T): { readonly value: T }
	export type ComputedRef<T> = { readonly value: T }
	export type Ref<T> = { value: T }
	export function onMounted(fn: () => void): void
	export function onUnmounted(fn: () => void): void
	export function watch<T>(source: any, callback: (val: T, oldVal: T) => void, options?: any): any
}
