// Bundled template models: esbuild inlines them as parsed JSON.
declare module "*.bbmodel" {
  const model: Record<string, unknown>;
  export default model;
}
