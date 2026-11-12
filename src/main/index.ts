// Dispatch before loading user storage, credentials or the single-instance owner.
if (process.argv.includes("--reader-render-worker")) {
  void import("./render-worker-entry");
} else if (process.argv.includes("--reader-article-viewer")) {
  void import("./article-viewer-entry");
} else {
  void import("./application");
}
