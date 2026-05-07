// Shadow-DOM helpers for tree climbing (§4.1 step 3).
//
// `closestAncestor(el, selector)` walks up DOM parents AND hops out of any
// open ShadowRoot to its host node, repeating. Closed shadow roots are not
// traversable from script — those just terminate the walk.

export function closestAncestor(start: Element | null, selector: string): Element | null {
  let node: Node | null = start;
  while (node) {
    if (node instanceof Element && node.matches(selector)) return node;
    const parent: Node | null = (node as Node).parentNode;
    if (parent) {
      node = parent;
      continue;
    }
    // Top of the (sub)tree — if we're inside a ShadowRoot, hop to its host.
    if ((node as ShadowRoot).host instanceof Element) {
      node = (node as ShadowRoot).host;
      continue;
    }
    break;
  }
  return null;
}

export function ancestorsUpTo(start: Element | null, max: number): Element[] {
  const out: Element[] = [];
  let node: Node | null = start;
  while (node && out.length < max) {
    const parent: Node | null = (node as Node).parentNode;
    if (parent) {
      node = parent;
      if (node instanceof Element) out.push(node);
      continue;
    }
    if ((node as ShadowRoot).host instanceof Element) {
      node = (node as ShadowRoot).host;
      continue;
    }
    break;
  }
  return out;
}

/**
 * Wait for a CSS selector to appear in the DOM, up to `timeoutMs`.
 * Resolves immediately if a matching element already exists.
 */
export function waitForElement(selector: string, timeoutMs: number, root: Document = document): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = root.querySelector(selector);
    if (existing) { resolve(existing); return; }
    const observer = new MutationObserver(() => {
      const el = root.querySelector(selector);
      if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
    });
    observer.observe(root.documentElement ?? root.body, { childList: true, subtree: true });
    const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
  });
}

/** Resolve a space-separated id list. Looks within the document and any
 *  shadow root the element belongs to (via getRootNode) — best-effort. */
export function resolveIdRefs(el: Element, ids: string): Element[] {
  const root = el.getRootNode() as Document | ShadowRoot;
  const out: Element[] = [];
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const found = (root as Document | ShadowRoot).getElementById?.(id);
    if (found) out.push(found);
  }
  return out;
}
