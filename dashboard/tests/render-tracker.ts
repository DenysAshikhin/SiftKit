// Counts which components rendered in each commit through React's DevTools hook.
// Must load before react-dom, which reads the hook once at startup.

type ElementType = object | string | null;
/** The fiber fields the tracker reads; child links are validated node by node as it walks them. */
type RawFiber = { elementType: ElementType; flags: number; child: object | null; sibling: object | null; alternate: object | null };

/** React's PerformedWork fiber flag: set on a fiber whose component function ran in this render. */
const PERFORMED_WORK = 1;

let renderCounts = new Map<ElementType, number>();

function isRawFiber(value: object | null): value is RawFiber {
  return value !== null
    && 'flags' in value && typeof value.flags === 'number'
    && 'elementType' in value && (value.elementType === null || typeof value.elementType === 'object'
      || typeof value.elementType === 'function' || typeof value.elementType === 'string')
    && 'child' in value && (value.child === null || typeof value.child === 'object')
    && 'sibling' in value && (value.sibling === null || typeof value.sibling === 'object')
    && 'alternate' in value && (value.alternate === null || typeof value.alternate === 'object');
}

function collectRenders(fiber: RawFiber): void {
  if ((fiber.flags & PERFORMED_WORK) !== 0) {
    renderCounts.set(fiber.elementType, (renderCounts.get(fiber.elementType) ?? 0) + 1);
  }
  // A child pointer shared with the previous tree means React reused that subtree without visiting it.
  if (isRawFiber(fiber.alternate) && fiber.alternate.child === fiber.child) return;
  for (let child = fiber.child; isRawFiber(child); child = child.sibling) collectRenders(child);
}

Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
  configurable: true,
  value: {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_rendererId: number, root: object) => {
      if ('current' in root && typeof root.current === 'object' && isRawFiber(root.current)) collectRenders(root.current);
    },
  },
});

/** How many times components of `elementType` rendered while `action` ran. */
export async function countRenders(elementType: object, action: () => Promise<void>): Promise<number> {
  renderCounts = new Map();
  await action();
  return renderCounts.get(elementType) ?? 0;
}
