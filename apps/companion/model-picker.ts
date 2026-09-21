import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
const run = promisify(execFile);
const script = `const app = Application.currentApplication();
app.includeStandardAdditions = true;
const selected = app.chooseFile({withPrompt: "Choose GGUF files or a complete Safetensors model folder's files for Bittrees AI", multipleSelectionsAllowed: true});
JSON.stringify(selected.map(file => file.toString()));`;
/** Invoked only after the paired user chooses Select local files. Never accepts paths from HTTP. */
export async function pickModelFiles(signal: AbortSignal): Promise<string[]> {
  if (process.platform !== "darwin") throw new Error("PICKER_UNAVAILABLE");
  let stdout: string;
  try {
    ({ stdout } = await run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { signal, timeout: 5 * 60000, maxBuffer: 256 * 1024 },
    ));
  } catch (error) {
    if (
      typeof (error as { stderr?: unknown }).stderr === "string" &&
      /\(-128\)/.test((error as { stderr: string }).stderr)
    )
      throw new DOMException("Selection cancelled", "AbortError");
    throw error;
  }
  return z
    .array(z.string().startsWith("/").max(4096))
    .min(1)
    .max(128)
    .parse(JSON.parse(stdout));
}
