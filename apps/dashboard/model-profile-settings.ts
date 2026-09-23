import { modelProfileSchema } from "../../modules/contracts/index.js";
export type ProfileFields = {
  context: string;
  output: string;
  temperature: string;
};
export const defaultProfileFields: ProfileFields = {
  context: "4096",
  output: "512",
  temperature: "0.2",
};
const schema = modelProfileSchema.pick({
  contextTokens: true,
  maxOutputTokens: true,
  temperature: true,
});
export function readProfileFields(fields: ProfileFields) {
  if (Object.values(fields).some((value) => !value.trim()))
    return { value: null, message: "Enter all three profile settings." };
  const parsed = schema.safeParse({
    contextTokens: Number(fields.context),
    maxOutputTokens: Number(fields.output),
    temperature: Number(fields.temperature),
  });
  if (!parsed.success)
    return {
      value: null,
      message:
        "Use a whole-number context from 256 to 131,072 tokens, a reply limit from 1 to 8,192 tokens, and variation from 0 to 2.",
    };
  if (parsed.data.maxOutputTokens + 256 >= parsed.data.contextTokens)
    return {
      value: null,
      message:
        "Context must exceed the reply limit by at least 257 tokens to leave room for input.",
    };
  return { value: parsed.data, message: null };
}
type DisplayProfile = {
  id?: string;
  model?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
};
export function profileSettingsText(profile: DisplayProfile) {
  if (
    [profile.contextTokens, profile.maxOutputTokens, profile.temperature].some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    )
  )
    return "";
  return `${profile.contextTokens!.toLocaleString("en-US")} context · ${profile.maxOutputTokens!.toLocaleString("en-US")} reply limit · ${profile.temperature} variation`;
}
export function profileLabel(profile: DisplayProfile) {
  const settings = profileSettingsText(profile);
  return [profile.model ?? "Local model", settings || profile.id]
    .filter(Boolean)
    .join(" · ");
}
