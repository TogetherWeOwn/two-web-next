export function compileKitFacade(adapterSource: string): Promise<{
  output: string;
  adapterSha256: string;
  facadeSha256: string;
}>;
