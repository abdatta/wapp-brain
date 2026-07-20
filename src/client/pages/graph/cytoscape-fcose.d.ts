// cytoscape-fcose ships no type definitions; it registers an fcose layout
// extension consumed via cytoscape.use(fcose).
declare module "cytoscape-fcose" {
  import type { Ext } from "cytoscape";
  const fcose: Ext;
  export default fcose;
}
