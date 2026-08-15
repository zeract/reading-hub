import("../visual-audit.mjs").catch((error) => {
  console.error("Reading Hub visual audit failed to start:", error);
  process.exitCode = 1;
});
