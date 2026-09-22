/** Own the desktop parent's input pipe; never terminate the model runtime. */
export function bindProcessLifetime(
  stop: () => Promise<void>,
  desktop = process.env.BITTREES_DESKTOP === "1",
) {
  let requested = false;
  const shutdown = () => {
    if (requested) return;
    requested = true;
    void Promise.resolve()
      .then(stop)
      .catch(() => {
        process.exitCode = 1;
        console.error("The companion could not finish its local shutdown.");
      })
      .finally(() => {
        if (desktop) process.stdin.destroy();
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (desktop) {
    process.stdin.on("end", shutdown);
    process.stdin.on("error", shutdown);
    process.stdin.resume();
  }
  return shutdown;
}
