import("../network-smoke.mjs").catch((error) => {
  console.error("Reading Hub network fixture failed to start:", error);
  require("electron").app.exit(1);
});
