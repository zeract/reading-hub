import("../renderer-smoke.mjs").catch((error) => {
  console.error("Reading Hub renderer smoke test failed to start:", error);
  process.exitCode = 1;
});
