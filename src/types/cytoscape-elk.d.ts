/**
 * `cytoscape-elk` ships no types.
 *
 * Declared here rather than cast at the call site, so the one untyped thing in the renderer is named
 * in one place. The extension is a Cytoscape plugin: a function passed to `cytoscape.use`.
 */
declare module "cytoscape-elk" {
  const ext: cytoscape.Ext;
  export default ext;
}
