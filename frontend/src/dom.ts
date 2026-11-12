// Small typed DOM helpers.

/** querySelector for elements the markup guarantees exist (same behaviour as the old untyped `$`). */
export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  return root.querySelector(sel) as T;
}
/** querySelector for elements that may be absent. */
export function $opt<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector(sel) as T | null;
}
export function $$<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll(sel)) as T[];
}
/** The event target as an element (every listener here is attached to elements). */
export function tgt(e: Event): HTMLElement {
  return e.target as HTMLElement;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c] ?? c);
export const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** Read a string field from a form. */
export function field(form: HTMLFormElement | FormData, name: string): string {
  const fd = form instanceof FormData ? form : new FormData(form);
  const v = fd.get(name);
  return typeof v === 'string' ? v : '';
}
