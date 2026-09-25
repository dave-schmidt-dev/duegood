/**
 * Plain-data description of one DOM element, returned by components and pages. Kept separate from
 * `render()`'s DOM conversion so desktop view contracts can be checked without a DOM; only the
 * Tauri app entry point (`src/ui/app.ts`) turns descriptors into WebView elements.
 */
export interface ElementDescriptor {
  readonly tag: string;
  /** String-only, including ARIA/role attributes — this is the shape the contract test inspects
   * for accessibility structure (`role`, `aria-live`, `aria-expanded`, etc). A boolean-ish HTML
   * attribute (`checked`, `disabled`) is present with value `""` to mean "set" and omitted
   * entirely to mean "unset", matching plain-HTML default-attribute semantics. */
  readonly attrs?: Record<string, string>;
  /** Applied via `textContent` only, never `innerHTML` — the content-safety rule imported Canvas
   * text (assignment titles) must never be exempted from, even indirectly through this shared
   * renderer. */
  readonly text?: string;
  readonly children?: readonly ElementDescriptor[];
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
}

/** Converts one descriptor tree into real DOM nodes. The only function in `src/ui/` that touches
 * `document` — every component stays a pure function of its props/state, testable without a DOM. */
export function render(descriptor: ElementDescriptor): HTMLElement {
  const node = document.createElement(descriptor.tag);
  for (const [name, value] of Object.entries(descriptor.attrs ?? {})) node.setAttribute(name, value);
  if (descriptor.text !== undefined) node.textContent = descriptor.text;
  for (const child of descriptor.children ?? []) node.appendChild(render(child));
  for (const [type, handler] of Object.entries(descriptor.on ?? {})) node.addEventListener(type, handler);
  return node;
}
