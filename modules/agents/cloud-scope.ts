/** Stable disclosure text shared by the UI and execution boundary. */
export function cloudExportText(
  profile: {
    id: string;
    name: string;
    modelProfileId: string;
    role: string;
    methodology: string;
    knowledge: { name: string; text: string }[];
  },
  instruction: string,
) {
  return JSON.stringify(
    {
      agentId: profile.id,
      agentName: profile.name,
      model: profile.modelProfileId,
      role: profile.role,
      methodology: profile.methodology,
      knowledge: profile.knowledge,
      task: instruction,
    },
    null,
    2,
  );
}
