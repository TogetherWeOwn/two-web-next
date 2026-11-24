export const KIT_SECURITY_TXT_ROUTE = {
  method: "GET",
  path: "/.well-known/security.txt",
  enabled: true,
  reads: "public",
} as const;
