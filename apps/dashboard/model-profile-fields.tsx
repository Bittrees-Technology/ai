import React from "react";
import {
  readProfileFields,
  type ProfileFields,
} from "./model-profile-settings.js";
export function ModelProfileFields({
  value,
  change,
  disabled,
}: {
  value: ProfileFields;
  change: (next: ProfileFields) => void;
  disabled: boolean;
}) {
  const checked = readProfileFields(value);
  return (
    <fieldset disabled={disabled} className="model-profile-settings">
      <legend>Profile settings</legend>
      <p className="hint">
        A token is a small piece of text. Larger context and reply limits can
        use more memory and take longer; they do not guarantee more accurate
        answers or that a model will fit.
      </p>
      <div className="model-profile-fields">
        <label htmlFor="profile-context">
          Context budget (tokens)
          <input
            id="profile-context"
            type="number"
            min="256"
            max="131072"
            step="1"
            required
            value={value.context}
            onChange={(e) => change({ ...value, context: e.target.value })}
          />
        </label>
        <label htmlFor="profile-output">
          Reply limit (tokens)
          <input
            id="profile-output"
            type="number"
            min="1"
            max="8192"
            step="1"
            required
            value={value.output}
            onChange={(e) => change({ ...value, output: e.target.value })}
          />
        </label>
        <label htmlFor="profile-temperature">
          Variation (temperature)
          <input
            id="profile-temperature"
            type="number"
            min="0"
            max="2"
            step="any"
            required
            value={value.temperature}
            onChange={(e) => change({ ...value, temperature: e.target.value })}
          />
        </label>
      </div>
      <p className="hint">
        Context includes the request, reference material and reply. Lower
        variation asks for more consistent wording; it does not verify facts.
        The engine also applies conservative input-size checks.
      </p>
      {checked.message && <p role="status">{checked.message}</p>}
      <p className="hint">
        Saving creates a new profile. Existing tasks and their recorded settings
        stay unchanged; task-specific switching is a separate action.
      </p>
    </fieldset>
  );
}
