// Dispatch before loading user storage, credentials or the single-instance owner.
if (process.argv.includes("--reader-render-worker")) {
  void import("./render-worker-entry");
} else {
  void import("./application");
}
