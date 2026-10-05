import { useEffect, useState } from "react";
export function BackgroundSetting() {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState({ enabled: false, events: 0 });
  const [notifications, setNotifications] = useState(false);
  const [notificationsSupported, setNotificationsSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.blackboardSetup
      .journeyDiagnostics()
      .then((v) => {
        if (!cancelled) setDiagnostics(v);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    void window.blackboardSetup
      .appPreferences()
      .then((v) => {
        if (!cancelled) {
          setEnabled(v.background);
          setNotifications(v.notifications);
          setNotificationsSupported(v.notificationsSupported);
          setReady(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <section className="d-panel">
      <h2>When you close the window</h2>
      <label className="n-check-label">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!ready}
          onChange={async (e) => {
            const next = e.target.checked;
            setReady(false);
            setError("");
            try {
              setEnabled(
                (await window.blackboardSetup.setBackground(next)).background,
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setReady(true);
            }
          }}
        />
        Keep contributing in the background
      </label>
      <p>
        Harakiri stays in the menu bar while the window is hidden. Existing time
        limits and local approvals still apply. Use “Stop all my agents” there
        to end contributions, or “Stop agents and quit” to exit. Sleeping this
        Mac requests a stop; unconfirmed stops remain visible for recovery.
      </p>
      {enabled ? (
        <>
          <label className="n-check-label">
            <input
              type="checkbox"
              checked={notifications}
              disabled={!ready || !notificationsSupported}
              onChange={async (e) => {
                const next = e.target.checked;
                setReady(false);
                try {
                  setNotifications(
                    (await window.blackboardSetup.setNotifications(next))
                      .notifications,
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setReady(true);
                }
              }}
            />
            Notify me when a decision is needed
          </label>
          <p className="d-field-help">
            Optional macOS notifications while you are away from the window.
            Open one to return to that mission’s Inbox. Mission text and sign-in
            codes stay out of notifications. macOS may ask you to allow alerts;
            you can change this in System Settings → Notifications.
          </p>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <details>
        <summary>Onboarding diagnostics · stays on this Mac</summary>
        <label className="n-check-label">
          <input
            type="checkbox"
            checked={diagnostics.enabled}
            onChange={async (e) => {
              try {
                const value =
                  await window.blackboardSetup.setJourneyDiagnostics(
                    e.target.checked,
                  );
                setDiagnostics({ ...diagnostics, ...value });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
          Save local onboarding timings
        </label>
        <p className="d-field-help">
          Optional, sampled step transitions for finding setup delays. Up to
          1,000 records are kept locally. These contain state names and timings,
          with no messages, provider output, invitation links or sign-in codes.
          Nothing is sent to Harakiri.
        </p>
        <button
          className="d-button"
          onClick={async () => {
            try {
              await window.blackboardSetup.clearJourneyDiagnostics();
              setDiagnostics({ ...diagnostics, events: 0 });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Clear saved timings
        </button>
      </details>
    </section>
  );
}
