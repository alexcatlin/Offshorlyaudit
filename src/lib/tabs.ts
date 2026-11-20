// Keyboard handling for role="tablist" (WAI-ARIA tabs pattern, automatic activation).

/**
 * Index of the tab to move to for a key press, or null if the key is not handled.
 * ArrowRight/ArrowDown → next (wraps), ArrowLeft/ArrowUp → previous (wraps), Home → first, End → last.
 */
export const nextTabIndex = (key: string, current: number, count: number): number | null => {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
};
