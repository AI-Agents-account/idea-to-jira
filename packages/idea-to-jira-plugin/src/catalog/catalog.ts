import { readFile } from "node:fs/promises";

export interface KnowledgeCatalog {
  path: string;
  markdown: string;
}

/** Loads operator-maintained context without interpreting it as trusted instructions. */
export async function loadKnowledgeCatalog(path: string): Promise<KnowledgeCatalog> {
  const markdown = await readFile(path, "utf8");
  return { path, markdown };
}
