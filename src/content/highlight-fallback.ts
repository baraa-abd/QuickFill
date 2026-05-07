// Manual-highlight fallback (§4.1 manual highlight workflow).
//
// Active in the focused frame only. Shows a tooltip near the cursor; reads
// `window.getSelection()` on selectionchange / mouseup; Enter submits, Esc
// cancels. Times out after several minutes of inactivity.

const TOOLTIP_ID = '__quickfill_highlight_tip__';
const INACTIVITY_MS = 60_000;

type Listeners = {
  onSelection: (text: string) => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
};

let active: {
  cleanup: () => void;
  lastSelection: string;
} | null = null;

export function startManualHighlight(l: Listeners): void {
  if (active) active.cleanup();

  const tip = document.createElement('div');
  tip.id = TOOLTIP_ID;
  Object.assign(tip.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483647',
    background: 'rgba(31, 41, 55, 0.92)',
    color: 'white',
    padding: '6px 10px',
    borderRadius: '6px',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    fontSize: '12px',
    lineHeight: '1.3',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
    maxWidth: '300px'
  } as Partial<CSSStyleDeclaration>);
  tip.textContent = 'Highlight the question text. Enter to confirm, Esc to cancel.';
  document.documentElement.appendChild(tip);

  let lastSelection = '';
  let timeoutId: number | null = null;

  function pokeTimeout() {
    if (timeoutId != null) window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      cleanup();
      l.onCancel();
    }, INACTIVITY_MS);
  }

  function moveTip(x: number, y: number) {
    const margin = 12;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = x + margin;
    let top = y + margin;
    if (left + w > window.innerWidth - 4) left = Math.max(4, x - margin - w);
    if (top + h > window.innerHeight - 4) top = Math.max(4, y - margin - h);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function readSelection(): string {
    const sel = window.getSelection();
    if (!sel) return '';
    const txt = (sel.toString() || '').replace(/\s+/g, ' ').trim();
    return txt;
  }

  function onMouseMove(e: MouseEvent) {
    moveTip(e.clientX, e.clientY);
  }

  function onMouseUp() {
    const t = readSelection();
    if (t !== lastSelection) {
      lastSelection = t;
      l.onSelection(t);
    }
    pokeTimeout();
  }

  function onSelChange() {
    const t = readSelection();
    if (t !== lastSelection) {
      lastSelection = t;
      l.onSelection(t);
    }
    pokeTimeout();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      const t = lastSelection;
      if (!t) {
        // poke the user — we surface this in the panel, but flash the tip too.
        tip.textContent = 'Selection is empty — drag-select the question text first.';
        pokeTimeout();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      l.onSubmit(t);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      l.onCancel();
    }
  }

  // Capture-phase listeners so we win against page handlers.
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('selectionchange', onSelChange, true);
  document.addEventListener('keydown', onKeyDown, true);
  pokeTimeout();

  function cleanup() {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('selectionchange', onSelChange, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (timeoutId != null) window.clearTimeout(timeoutId);
    if (tip.parentNode) tip.parentNode.removeChild(tip);
    active = null;
  }

  active = {
    cleanup,
    get lastSelection() {
      return lastSelection;
    }
  };
}

export function stopManualHighlight(): void {
  if (active) active.cleanup();
}

export function isHighlightActive(): boolean {
  return active != null;
}
