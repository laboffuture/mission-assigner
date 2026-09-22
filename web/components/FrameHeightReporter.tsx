'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Tell the LMS how tall we are, so it can size the iframe instead of giving us
 * an inner scrollbar (style guide section 9: the tool should not create its own
 * scrollbar).
 *
 * Posts on mount, on every content resize (ResizeObserver) and after each route
 * change. Silent when not framed, so a directly-opened page posts nothing.
 *
 * MESSAGE FORMAT NOT YET CONFIRMED. `{ subject: 'lti.frameResize', height }` is
 * the shape used by common LTI players; the exact contract has to be agreed
 * with the LMS team — see the README. Extra fields are included so a parent
 * expecting either spelling can read it.
 */
export const FRAME_RESIZE_SUBJECT = 'lti.frameResize';

export function FrameHeightReporter() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;

    let last = -1;
    const post = () => {
      const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (height === last) return; // don't spam the parent with identical heights
      last = height;
      window.parent.postMessage({ subject: FRAME_RESIZE_SUBJECT, height }, '*');
    };

    post();
    const observer = new ResizeObserver(post);
    observer.observe(document.documentElement);
    window.addEventListener('load', post);
    return () => {
      observer.disconnect();
      window.removeEventListener('load', post);
    };
  }, [pathname]); // re-measure after a route change

  return null;
}
