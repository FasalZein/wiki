export type PluginEntry = {
  id: string;
  repo: string;
  required: boolean;
  defaultConfigPath: string;
};

export type PluginManifest = {
  plugins: PluginEntry[];
};

export async function loadPluginManifest(): Promise<PluginManifest> {
  const file = Bun.file(new URL("./plugin-manifest.json", import.meta.url));
  return (await file.json()) as PluginManifest;
}

export function requiredPlugins(manifest: PluginManifest): PluginEntry[] {
  return manifest.plugins.filter((p) => p.required);
}

export async function loadDefaultConfig(entry: PluginEntry): Promise<Record<string, unknown>> {
  const file = Bun.file(new URL(entry.defaultConfigPath, import.meta.url));
  return (await file.json()) as Record<string, unknown>;
}
