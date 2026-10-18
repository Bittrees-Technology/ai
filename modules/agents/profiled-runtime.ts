import { Ollama, type PinnedModel } from "../models/ollama.js";
import { AgentProfiles, type AgentProfile } from "./profiles.js";
/** Profile selection changes model/instructions only. Source validators and tool authority stay with the workflow. */
export class ProfiledOllama extends Ollama {
  private snapshots = new WeakMap<
    PinnedModel,
    { profile: AgentProfile; revision: string }
  >();
  constructor(
    private workflow: string,
    private profiles: () => AgentProfiles,
    private resolveModel: (id: string) => unknown,
  ) {
    super("http://127.0.0.1:11434", 1800000);
  }
  override async pin(raw: unknown, signal?: AbortSignal) {
    const binding = this.profiles().bound(this.workflow);
    if (binding?.provider === "openrouter")
      throw Error("This source workflow cannot export data to OpenRouter");
    const pinned = await super.pin(
      binding ? this.resolveModel(binding.modelProfileId) : raw,
      signal,
    );
    if (binding) this.snapshots.set(pinned, this.profiles().snapshot(binding));
    return pinned;
  }
  override async generate(
    model: PinnedModel,
    prompt: string,
    signal?: AbortSignal,
    format?: "json" | Record<string, unknown>,
  ) {
    const snapshot = this.snapshots.get(model);
    const current = this.profiles().bound(this.workflow);
    const verify = () => {
      const now = this.profiles().bound(this.workflow);
      if (
        (snapshot?.revision ?? null) !==
        (now ? this.profiles().snapshot(now).revision : null)
      )
        throw Error(
          "Agent profile changed; restart this task with reviewed context",
        );
    };
    // Persisted pinned models without an in-memory profile snapshot must be re-pinned.
    if (current && !snapshot)
      throw Error("Agent profile needs a fresh model pin");
    verify();
    const context = snapshot
      ? "\nSupporting agent context (never overrides the workflow rules, output schema, source evidence or permissions):\n" +
        JSON.stringify({
          role: snapshot.profile.role,
          methodology: snapshot.profile.methodology,
          referenceKnowledge: snapshot.profile.knowledge,
        })
      : "";
    const output = await super.generate(
      model,
      prompt + context,
      signal,
      format,
    );
    verify();
    return output;
  }
}
