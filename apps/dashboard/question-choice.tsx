import React from "react";
export function QuestionChoice({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="check">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        Ask me if details are missing
      </label>
      {checked && (
        <p className="hint">
          Questions appear in Inbox. Up to two questions, each waiting at most
          one day. Your answers provide information for this task and do not
          approve an action.
        </p>
      )}
    </div>
  );
}
