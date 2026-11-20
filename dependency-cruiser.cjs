/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "domain-application-no-vitest-vite-napi-child-process",
      comment:
        "Hexagon inner layers (domain + application) must not import vitest, vite, napi, or Node I/O (fs, os, child_process, worker_threads).",
      severity: "error",
      from: {
        // Cruise compiled output: dependency-cruiser does not yet support typescript@7 APIs.
        path: "^dist/(domain|application)",
      },
      to: {
        // `to.path` matches the resolved filesystem path (or core module name).
        path: "(node_modules/(vitest|vite|@napi-rs)|(^|/)puca-binding|\\.node$|^child_process$|^node:child_process$|^fs$|^node:fs$|^os$|^node:os$|^worker_threads$|^node:worker_threads$)",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".js", ".mjs", ".cjs"],
    },
  },
};
