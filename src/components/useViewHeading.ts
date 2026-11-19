import { useEffect, useRef } from 'react';

/** Whether a view has been shown yet; the first one keeps the page's own focus. */
let firstView = true;

/**
 * Moves focus to a view's heading when the view changes (A11Y-4, A11Y-5), so
 * screen-reader and keyboard users start at the new content, as 1.x focused
 * `#main-content`. The first view of a page load does not take focus. `key`
 * names the view; a new key moves focus again.
 */
export function useViewHeading(key: string) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (firstView) { firstView = false; return; }
    heading.current?.focus({ preventScroll: false });
  }, [key]);
  return heading;
}
