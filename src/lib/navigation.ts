/** Segment boundaries keep sibling routes from lighting up the same navigation item. */
export function isNavigationActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  const within = (root: string) => pathname === root || pathname.startsWith(`${root}/`);
  if (href === "/learn") return ["/learn", "/read"].some(within);
  return within(href);
}
