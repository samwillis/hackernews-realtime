"use client";
import { useState, type ComponentProps } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "./live-session";

// App Router's server page loads its SSR snapshot. This client loader opens the
// destination subscriptions before committing that RSC navigation.
export function LiveLink({
  href,
  children,
  onMouseEnter,
  onFocus,
  ...props
}: Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & {
  href: string;
}) {
  const session = useSession();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const warm = () => {
    router.prefetch(href);
    void session.prepare(href).catch(() => {});
  };
  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      aria-busy={pending || undefined}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        warm();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        warm();
      }}
      onNavigate={(event) => {
        event.preventDefault();
        const current = session.navigation.begin();
        setPending(true);
        router.prefetch(href);
        // A failed live preparation still lets the SSR page open and report its
        // actual query/connection error. Slow or offline Realtime cannot trap navigation.
        void session
          .prepare(href)
          .catch(() => {})
          .then(() => {
            if (current()) {
              const navigate = props.replace ? router.replace : router.push;
              navigate(href, { scroll: props.scroll ?? true });
            }
          })
          .finally(() => setPending(false));
      }}
    >
      {children}
    </Link>
  );
}
