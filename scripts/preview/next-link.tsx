/**
 * `next/link`, for the standalone preview render only.
 *
 * The preview is a file on disk with no router, and a Link there is an anchor —
 * which is what Next's own Link renders to. Aliased in at bundle time by
 * `pnpm render:web`; the app itself imports the real one.
 */
import type { AnchorHTMLAttributes, ReactNode } from 'react';

export default function Link({
  href,
  children,
  ...rest
}: { href: string; children?: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
