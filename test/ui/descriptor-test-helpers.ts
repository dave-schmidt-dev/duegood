import type { ElementDescriptor } from "../../src/ui/dom";
export function findAll(descriptor: ElementDescriptor, predicate: (item: ElementDescriptor) => boolean): ElementDescriptor[] {
  return [...(predicate(descriptor) ? [descriptor] : []), ...(descriptor.children ?? []).flatMap((child) => findAll(child, predicate))];
}
export function words(descriptor: ElementDescriptor): string { return [descriptor.text ?? "", ...(descriptor.children ?? []).map(words)].join(" "); }
export function buttons(descriptor: ElementDescriptor): ElementDescriptor[] { return findAll(descriptor, (item) => item.tag === "button"); }
export function button(descriptor: ElementDescriptor, label: string): ElementDescriptor | undefined { return buttons(descriptor).find((item) => item.text === label); }
