import { parse as parseYaml } from "yaml";

export async function parse(text: string): Promise<unknown> {
  return parseYaml(text);
}
