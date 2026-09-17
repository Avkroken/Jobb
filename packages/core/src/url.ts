export function isHostOrSubdomain(
  hostname: string,
  allowedDomain: string,
): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  const domain = allowedDomain.trim().toLowerCase().replace(/\.$/, "");

  return host === domain || host.endsWith(`.${domain}`);
}
