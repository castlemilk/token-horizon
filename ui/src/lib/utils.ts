import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// ---- shadcn-svelte prop helper types ----

/** Remove the `child` snippet prop (we always render children ourselves). */
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;
/** Remove the `children` snippet prop. */
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, El extends HTMLElement = HTMLElement> = T & {
	ref?: El | null;
};
