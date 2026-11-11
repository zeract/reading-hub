if (process.argv.includes("--render-fixture-child")) {
  require("./render-worker.cjs");
} else {
import("../network-smoke.mjs").catch((error) => {
  console.error("Reading Hub network fixture failed to start:", error);
  require("electron").app.exit(1);
});

}
