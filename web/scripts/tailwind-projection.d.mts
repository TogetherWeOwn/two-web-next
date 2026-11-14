export function projectSvelte(source: string): string;
export function regenerateProjection(options: {
  sourceDir: string;
  outputDir: string;
  cssPath?: string;
}): { changed: string[]; files: string[] };
