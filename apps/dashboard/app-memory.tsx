import React, { useEffect, useRef, useState } from "react";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
type App = "local" | "crm" | "autonote" | "mail";
const names: Record<App, string> = {
  local: "Personal local tasks",
  crm: "CRM",
  autonote: "AutoNote",
  mail: "Mail",
};
type Item = {
  id: string;
  revision: number;
  text: string;
  state: string;
  useApps?: string[];
};
const focused = () => !document.hidden && document.hasFocus();

export function useAppMemory(
  api: Api,
  destination: Exclude<App, "local">,
  context: string,
  disabled: boolean,
) {
  const [items, setItems] = useState<Item[]>([]),
    [ids, setIds] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [loading, setLoading] = useState(false),
    [message, setMessage] = useState(""),
    [expires, setExpires] = useState(0);
  const epoch = useRef(0);
  const clear = () => {
    epoch.current++;
    setItems([]);
    setIds([]);
    setConfirmed(false);
    setLoading(false);
    setExpires(0);
  };
  useEffect(() => {
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      epoch.current++;
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);
  useEffect(() => {
    setConfirmed(false);
  }, [context]);
  useEffect(() => {
    if (!expires) return;
    const timer = setTimeout(
      () => {
        clear();
        setMessage("Memory review expired. Load it again to continue.");
      },
      Math.max(0, expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expires]);
  const request = () => {
    if (!ids.length) return undefined;
    if (!focused() || loading || !confirmed || Date.now() >= expires)
      throw Error(
        "Review the selected memories again before creating the draft.",
      );
    return {
      destination,
      confirmed: true as const,
      memories: ids.map((id) => {
        const item = items.find((item) => item.id === id);
        if (!item) throw Error("Memory selection changed.");
        return { id, revision: item.revision };
      }),
    };
  };
  const load = async () => {
    if (disabled || loading || !focused()) return;
    clear();
    const generation = ++epoch.current;
    setLoading(true);
    setMessage("Checking memory access…");
    try {
      const data = await api("/v1/memories");
      if (generation !== epoch.current || !focused()) return;
      const available = (data.items as Item[]).filter(
        (item) =>
          item.state === "approved" && item.useApps?.includes(destination),
      );
      setItems(available);
      setExpires(Date.now() + 120000);
      setMessage(
        available.length
          ? "Choose up to eight. Source access and versions are checked again before use."
          : "No approved memories permit this app. Review app permissions in Memory first.",
      );
    } catch {
      if (generation === epoch.current)
        setMessage(
          "Memory access could not be confirmed. Try again after checking the connection.",
        );
    } finally {
      if (generation === epoch.current) setLoading(false);
    }
  };
  return {
    request,
    clear,
    blocked: loading || (ids.length > 0 && !confirmed),
    panel: (
      <fieldset className="app-memory" disabled={disabled || loading}>
        <legend>Memory for this {names[destination]} draft</legend>
        <p>
          Only memories you allow for this app can be selected. They remain
          unverified references.
        </p>
        <button type="button" onClick={() => void load()}>
          Load permitted memories
        </button>
        <p role="status">{message}</p>
        {items.map((item) => (
          <label
            className="app-memory-choice"
            key={item.id + ":" + item.revision}
          >
            <input
              type="checkbox"
              checked={ids.includes(item.id)}
              disabled={!ids.includes(item.id) && ids.length >= 8}
              onChange={(e) => {
                setIds(
                  e.target.checked
                    ? [...ids, item.id]
                    : ids.filter((id) => id !== item.id),
                );
                setConfirmed(false);
              }}
            />
            <span>
              {item.text} <small>Version {item.revision}</small>
            </span>
          </label>
        ))}
        {!!ids.length && (
          <label className="app-memory-choice">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              Include these {ids.length} selected memories in this{" "}
              {names[destination]} draft.
            </span>
          </label>
        )}
        {!!items.length && (
          <button type="button" onClick={clear}>
            Clear memory selection
          </button>
        )}
      </fieldset>
    ),
  };
}

export function MemoryAppScope({
  item,
  api,
  onSaved,
  disabled,
}: {
  item: Item;
  api: Api;
  onSaved: () => Promise<void>;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [apps, setApps] = useState<string[]>(item.useApps ?? ["local"]),
    [confirmed, setConfirmed] = useState(false),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState("");
  const epoch = useRef(0);
  useEffect(() => {
    const hide = () => {
      epoch.current++;
      setEditing(false);
      setConfirmed(false);
      setSaving(false);
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      epoch.current++;
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  const save = async () => {
    if (!confirmed || saving || disabled || !focused()) return;
    const generation = ++epoch.current;
    setSaving(true);
    try {
      await api("/v1/memories/" + item.id, "PATCH", {
        revision: item.revision,
        useApps: apps,
        scopeConfirmed: true,
      });
      if (generation !== epoch.current || !focused()) return;
      setEditing(false);
      setConfirmed(false);
      await onSaved();
    } catch {
      if (generation === epoch.current)
        setMessage(
          "Permission update was not confirmed. Refresh Memory before trying again.",
        );
    } finally {
      if (generation === epoch.current) setSaving(false);
    }
  };
  return (
    <section className="app-memory" aria-label="Memory app permissions">
      <p>
        Allowed use:{" "}
        {(item.useApps ?? ["local"])
          .map((app) => names[app as App] ?? app)
          .join(", ") || "No tasks"}
        .
      </p>
      {!editing ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setApps(item.useApps ?? ["local"]);
            setConfirmed(false);
            setEditing(true);
          }}
        >
          Review app permissions
        </button>
      ) : (
        <fieldset disabled={disabled || saving}>
          <legend>Where this memory may be used</legend>
          <p>
            Each task still needs explicit selection and current source access.
            Removing permission can hide dependent drafts. Restoring a backup
            requires fresh cross-app permission.
          </p>
          {(Object.keys(names) as App[]).map((app) => (
            <label className="app-memory-choice" key={app}>
              <input
                type="checkbox"
                checked={apps.includes(app)}
                onChange={(e) => {
                  setApps(
                    e.target.checked
                      ? [...apps, app]
                      : apps.filter((v) => v !== app),
                  );
                  setConfirmed(false);
                }}
              />
              <span>{names[app]}</span>
            </label>
          ))}
          <label className="app-memory-choice">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>Apply these app permissions to this memory.</span>
          </label>
          <button
            type="button"
            disabled={!confirmed}
            onClick={() => void save()}
          >
            Save app permissions
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setConfirmed(false);
            }}
          >
            Cancel permission review
          </button>
        </fieldset>
      )}
      <p role="status">{message}</p>
    </section>
  );
}
