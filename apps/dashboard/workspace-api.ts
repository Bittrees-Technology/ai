import type { createLocalApi } from "./local-api.js";
type Api = ReturnType<typeof createLocalApi>;
/** Invalidating a view hides late results; it cannot undo an accepted server action. */
export function workspaceApi(transport: Api) {
  let active = true;
  const check = () => {
    if (!active) throw Error("WORKSPACE_CHANGED");
  };
  const api: Api = async (...args) => {
    check();
    try {
      const result = await transport(...args);
      check();
      return result;
    } catch (error) {
      check();
      throw error;
    }
  };
  return {
    api,
    invalidate: () => {
      active = false;
    },
  };
}
